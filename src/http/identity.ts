import type { Request } from 'express';
import { HttpError } from './errors.ts';
import { requiredId } from './validate.ts';

/**
 * Who is making this request.
 *
 * NOT AUTHENTICATION. The caller states an id in a header and the server believes it, so anyone
 * can claim to be anyone. It exists so that the access checks around it are real and in the
 * right places: a session or token layer would replace this function and nothing else.
 *
 * What it does buy, even unauthenticated: every read and write now has an identity attached and
 * is checked against conversation membership, instead of there being no notion of a caller at
 * all.
 */
export const USER_HEADER = 'x-user-id';

export function callerId(req: Request): number {
  const raw = req.header(USER_HEADER);
  if (raw === undefined) {
    throw HttpError.badRequest(`${USER_HEADER} header is required`, { header: USER_HEADER });
  }
  return requiredId(raw, USER_HEADER);
}

/** WebSockets cannot set headers from the browser, so identity rides on the query string. */
export function callerIdFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const value = new URL(url, 'http://placeholder').searchParams.get('userId');
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
