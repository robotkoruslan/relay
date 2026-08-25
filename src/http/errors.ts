import crypto from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';

/**
 * An error that carries the response the client should see. Anything else reaching the error
 * middleware is treated as a bug and reported as a 500 without leaking its message.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  /** Response headers the status is meaningless without, e.g. Retry-After on a 429. */
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }

  static tooManyRequests(
    message: string,
    details: unknown,
    headers: Record<string, string>,
  ): HttpError {
    return new HttpError(429, 'rate_limited', message, details, headers);
  }

  static badRequest(message: string, details?: unknown): HttpError {
    return new HttpError(400, 'bad_request', message, details);
  }

  static forbidden(message: string, details?: unknown): HttpError {
    return new HttpError(403, 'forbidden', message, details);
  }

  static notFound(message: string, details?: unknown): HttpError {
    return new HttpError(404, 'not_found', message, details);
  }

  static conflict(message: string, details?: unknown): HttpError {
    return new HttpError(409, 'conflict', message, details);
  }

  static unavailable(message: string, details?: unknown): HttpError {
    return new HttpError(503, 'service_unavailable', message, details);
  }
}

/** Turns a rejected handler promise into `next(err)`, which Express 4 will not do itself. */
export function asyncHandler(
  handler: (...args: Parameters<RequestHandler>) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(HttpError.notFound(`no route for ${req.method} ${req.originalUrl}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Headers already flushed: the response is committed, so hand back to Express to drop it.
  if (res.headersSent) {
    console.error('[error] after headers sent', err);
    next(err);
    return;
  }

  if (err instanceof HttpError) {
    for (const [name, value] of Object.entries(err.headers)) res.setHeader(name, value);
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // Unexpected: log everything, return a correlation id and nothing else.
  const incidentId = crypto.randomUUID();
  console.error(`[error] ${incidentId} ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({
    error: { code: 'internal', message: 'internal server error', incidentId },
  });
};
