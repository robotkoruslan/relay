import { closeMongo, connectMongo } from '../../src/db/mongo.ts';
import { messageBodies, signBody } from '../../src/services/messages.ts';

/**
 * Demo bodies for the rows created by docker/db/mysql.sql.
 *
 * This used to start with deleteMany({}), which made it destructive on every boot: MySQL's
 * init.sql only runs against a fresh data directory, so a plain rebuild wiped every body while
 * keeping every row, and the whole history came back as empty messages. Upserting with
 * $setOnInsert leaves existing data alone, so the two stores cannot drift apart.
 */
const demoBodies = [
  { _id: 1, conversationId: 1, senderId: 2, body: 'Hi, any update on order #1042?' },
  { _id: 2, conversationId: 1, senderId: 1, body: 'Checking now — give me a minute.' },
  { _id: 3, conversationId: 2, senderId: 3, body: 'Notes from the design sync are in the doc.' },
];

await connectMongo();

let inserted = 0;
for (const doc of demoBodies) {
  const result = await messageBodies().updateOne(
    { _id: doc._id },
    { $setOnInsert: { ...doc, signature: signBody(doc.body), createdAt: new Date() } },
    { upsert: true },
  );
  if (result.upsertedCount > 0) inserted += 1;
}

console.log(`seeded message bodies: ${inserted} inserted, ${demoBodies.length - inserted} already present`);
await closeMongo();
