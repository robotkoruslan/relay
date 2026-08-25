import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../src/http/errors.ts';
import {
  limit,
  optionalClientId,
  optionalId,
  requiredId,
  requiredIdArray,
  requiredText,
} from '../src/http/validate.ts';

function rejects(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
    assert.equal(err.status, 400);
    return err;
  }
  throw new assert.AssertionError({ message: 'expected a 400 to be thrown' });
}

describe('requiredId', () => {
  it('accepts positive integers as string or number', () => {
    assert.equal(requiredId('42', 'id'), 42);
    assert.equal(requiredId(42, 'id'), 42);
  });

  it('rejects values that Number() would silently coerce to 0', () => {
    // Number('') === 0 and Number(' ') === 0, so a bare truthiness check would let these
    // through as a falsy id and a bare Number() would turn them into a valid-looking 0.
    for (const value of ['', '   ', null, false, []]) {
      rejects(() => requiredId(value, 'id'));
    }
  });

  it('rejects non-integers, zero and negatives', () => {
    for (const value of ['1.5', '0', '-3', 'abc', '1e400', Number.NaN]) {
      rejects(() => requiredId(value, 'id'));
    }
  });

  it('rejects repeated query params, which arrive as an array', () => {
    // ?userId=1&userId=2 parses to ['1','2']; Number(['1']) is 1, so an unguarded
    // conversion would quietly accept the first element of a malformed request.
    rejects(() => requiredId(['1', '2'], 'id'));
    rejects(() => requiredId(['1'], 'id'));
  });

  it('names the offending field in the error', () => {
    const err = rejects(() => requiredId('nope', 'conversationId'));
    assert.match(err.message, /conversationId/);
    assert.deepEqual(err.details, { field: 'conversationId' });
  });
});

describe('optionalId', () => {
  it('treats absent and empty as undefined', () => {
    for (const value of [undefined, null, '']) {
      assert.equal(optionalId(value, 'before'), undefined);
    }
  });

  it('still validates a value that is present', () => {
    assert.equal(optionalId('7', 'before'), 7);
    rejects(() => optionalId('0', 'before'));
  });
});

describe('limit', () => {
  it('falls back when absent and clamps instead of rejecting', () => {
    assert.equal(limit(undefined, 'limit', 50, 200), 50);
    assert.equal(limit('10', 'limit', 50, 200), 10);
    assert.equal(limit('100000', 'limit', 50, 200), 200);
  });

  it('rejects a limit that is not a positive integer', () => {
    rejects(() => limit('-1', 'limit', 50, 200));
  });
});

describe('requiredText', () => {
  it('trims and returns', () => {
    assert.equal(requiredText('  hello  ', 'body', 10), 'hello');
  });

  it('rejects whitespace-only input', () => {
    rejects(() => requiredText('   ', 'body', 10));
  });

  it('measures length after trimming', () => {
    assert.equal(requiredText('  abc  ', 'body', 3), 'abc');
    rejects(() => requiredText('abcd', 'body', 3));
  });

  it('rejects non-strings rather than stringifying them', () => {
    for (const value of [42, null, undefined, {}, ['a']]) {
      rejects(() => requiredText(value, 'body', 10));
    }
  });

  it('reports the actual length so the client can react', () => {
    const err = rejects(() => requiredText('abcd', 'body', 3));
    assert.deepEqual(err.details, { field: 'body', maxLength: 3, actual: 4 });
  });
});

describe('optionalClientId', () => {
  it('maps absent and blank to null, since the column is nullable', () => {
    for (const value of [undefined, null, '']) {
      assert.equal(optionalClientId(value), null);
    }
  });

  it('passes a normal id through', () => {
    assert.equal(optionalClientId('018f2c1e-9b3a-7c4d-a1b2-c3d4e5f60718'), '018f2c1e-9b3a-7c4d-a1b2-c3d4e5f60718');
  });

  it('rejects a value longer than the column, rather than letting MySQL truncate it', () => {
    rejects(() => optionalClientId('x'.repeat(65)));
  });
});

describe('requiredIdArray', () => {
  it('validates every entry and drops duplicates', () => {
    assert.deepEqual(requiredIdArray(['1', 2, '2', 3], 'participantIds'), [1, 2, 3]);
  });

  it('rejects empty, non-array and bad entries', () => {
    rejects(() => requiredIdArray([], 'participantIds'));
    rejects(() => requiredIdArray('1,2', 'participantIds'));
    rejects(() => requiredIdArray([1, 'abc'], 'participantIds'));
  });
});
