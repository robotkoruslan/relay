import { config } from '../config.ts';
import { HttpError } from './errors.ts';

/**
 * Query and body values arrive as `unknown`: strings, arrays (`?id=1&id=2`), objects, or absent.
 * These helpers collapse that into a narrow type or a 400, so handlers never see `any`.
 */

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

export function requiredId(value: unknown, field: string): number {
  const parsed = toNumber(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw HttpError.badRequest(`${field} must be a positive integer`, { field });
  }
  return parsed;
}

export function optionalId(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredId(value, field);
}

/** Clamps rather than rejects, so a client asking for too much gets a page instead of an error. */
export function limit(value: unknown, field: string, fallback: number, max: number): number {
  const parsed = optionalId(value, field);
  if (parsed === undefined) return fallback;
  return Math.min(parsed, max);
}

export function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw HttpError.badRequest(`${field} must be a string`, { field });
  }
  const text = value.trim();
  if (text === '') {
    throw HttpError.badRequest(`${field} must not be empty`, { field });
  }
  if (text.length > maxLength) {
    throw HttpError.badRequest(`${field} must be at most ${maxLength} characters`, {
      field,
      maxLength,
      actual: text.length,
    });
  }
  return text;
}

export function optionalClientId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, 'clientId', config.maxClientIdLength);
}

export function requiredIdArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw HttpError.badRequest(`${field} must be a non-empty array`, { field });
  }
  const ids = value.map((entry) => requiredId(entry, `${field}[]`));
  return [...new Set(ids)];
}
