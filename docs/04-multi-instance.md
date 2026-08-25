# Running on more than one instance

Task: [`../tasks/multi-instance.md`](../tasks/multi-instance.md). Defect ids refer to
[`../spec/01-triage.md`](../spec/01-triage.md).

## The problem

`broadcast()` walked a `Set` of sockets held by the current process. A WebSocket is a long-lived
connection, so each client is pinned to whichever instance accepted it — but a POST goes wherever
the proxy sends it. With three instances, a message posted to instance C reached only the clients
that happened to be connected to C.

Rather than describe it, `scripts/check-fanout.ts` measures it. It opens N clients and posts M
messages, both through Envoy so both get spread around, then asserts every client saw every
message.

The "before" needs no code change: with Redis stopped, `emit` degrades to local-only delivery,
which is exactly the old behaviour.

```
8 messages posted, spread over 3 instance(s): fd185dfefef2=3 acbededa5dfe=3 e96f1b32d5c5=2
  client 0: 3/8  MISSED 5      client 3: 2/8  MISSED 6
  client 1: 3/8  MISSED 5      client 4: 2/8  MISSED 6
  client 2: 2/8  MISSED 6      client 5: 3/8  MISSED 5

FAIL: 33 message deliveries missing across 6 clients
```

33 of 48 deliveries lost — each client received only the messages that happened to be posted to
its own instance, which at three instances is the ⅔ loss the arithmetic predicts.

With the bus:

```
8 messages posted, spread over 3 instance(s): b74580090b80=4 d1670620f123=2 3b7139d08361=2
  client 0: all   client 1: all   client 2: all
  client 3: all   client 4: all   client 5: all

PASS: all 6 clients received all 8 messages
```

## How it works

Redis pub/sub on a single `relay:events` channel. Two connections, because a subscribed Redis
connection cannot issue any other command.

The detail worth calling out: **the publisher does not deliver to its own clients directly.** It
publishes, and its own subscriber delivers along with every other instance's. One code path on
every instance, so there is no "did I already deliver this locally?" case to get wrong.

No sticky sessions are needed. That is sometimes assumed for WebSockets behind a load balancer,
but the connection is already pinned by virtue of being one long-lived connection; once fan-out is
global, which instance holds it stops mattering.

### When Redis is down

The send is not failed. The message is already durable in MySQL and Mongo at that point, so
refusing it would turn a delivery degradation into data the user has to retype. Instead the
publish failure is logged and the event is delivered to this instance's own clients, and clients
elsewhere close the gap when they reconnect and refetch.

`enableOfflineQueue: false` matters here: ioredis would otherwise queue the publish and make the
request hang on a dependency that is not required for correctness.

Recovery needs no intervention — ioredis reconnects and replays the subscription:

```
Redis stopped -> FAIL: 33 message deliveries missing
Redis started -> PASS: all 6 clients received all 8 messages
```

## A mistake this testing caught

The first version of `/healthz` treated Redis like MySQL and Mongo. Stopping Redis therefore made
all three instances report 503, Envoy's health checks emptied the rotation, and the whole service
went down — because an *optional* dependency was degraded.

Health checks now separate the two. MySQL and Mongo decide the status code, since without them
requests genuinely fail. Redis is reported but does not affect it:

```
200 {"status":"degraded","instance":"e96f1b32d5c5",
     "checks":{"mysql":"ok","mongo":"ok",
               "redis":"Stream isn't writeable and enableOfflineQueue options is false"}}
```

Still `200`, still routable, and the operator can see exactly what is degraded.

## D9 — the live feed no longer dies on the first blip

**Client.** There was no `onclose` and no `onerror`, so one dropped socket ended real-time
updates permanently while the UI still looked healthy. Now: reconnect with exponential backoff
capped at 30s, plus jitter so a fleet of clients does not return in lockstep after an outage.

On reconnect it **refetches** rather than just resubscribing. A pub/sub bus does not replay, so
anything sent while the client was away is simply gone; resubscribing alone would leave a
permanent hole in the transcript that looks like nothing happened. There is also a small
connection indicator in the sidebar, because "looks healthy while silently dead" was half the
defect.

**Server.** Sockets left the set only on `'close'`, which never fires for a peer that vanishes
silently, so dead entries accumulated for the life of the process and were written to forever.
A ping sweep now clears a liveness flag and pings; anything that has not ponged by the next
sweep is terminated.

```
connected, waiting for a server ping (heartbeat is 30s)
server ping #1 at 10.0s
heartbeat OK
```

(10s rather than 30s because the sweep is a single shared interval — this client connected
part-way through a cycle.)

## Proxy

Two changes to `docker/envoy/envoy.yaml`.

**Active health checks against `/healthz`.** Without them a booting or already-dead instance
stays in rotation and takes its share of traffic. Combined with `/healthz` returning 503 the
moment SIGTERM arrives, an instance is pulled out of rotation *before* it stops listening, which
is what makes a rolling restart invisible.

**Split routes so HTTP keeps its timeout.** The original had one catch-all route with
`timeout: 0s` to accommodate WebSockets — which also disabled request timeouts for ordinary HTTP.
The upgrade now matches on the `upgrade: websocket` header and keeps `timeout: 0s`; everything
else falls through to a route with a 30s timeout. Matching on the header rather than a path,
because the socket connects to `/` like everything else.

## Build reproducibility, found the hard way

Scaling to three instances failed at first:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ioredis' imported from /app/src/bus.ts
```

`ioredis` had been installed into the running container's anonymous `/app/node_modules` volume;
new containers get a fresh one from the image, which had been built before the dependency
existed. The compose file bind-mounts `./:/app` over the image's copy and layers an anonymous
volume on `node_modules`, so image and container drift apart as soon as dependencies change.

There was also no lockfile, so `npm install` was free to resolve a different tree on every build.
Added `package-lock.json` and switched the Dockerfile to `npm ci`, which installs exactly what is
pinned.

## Migration lock, under real contention

Three instances booting at once is precisely the race the advisory lock exists for, and this was
the first chance to see it work:

```
api-2 | [migrate] 001-index-hot-paths
api-2 |   messages.idx_messages_conversation_id created
api-1 | [migrate] up to date
api-3 | [migrate] up to date
api-2 | [migrate] applied 3 migration(s)
```

One instance applied everything; the other two waited on the lock and then found nothing to do.

## How to reproduce all of this

```
docker compose up -d --build --scale api=3
docker compose exec api npx tsx scripts/check-fanout.ts     # PASS

docker compose stop redis
docker compose exec api npx tsx scripts/check-fanout.ts     # FAIL, and shows why
docker compose start redis
```
