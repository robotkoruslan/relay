import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signBody, verifyBody } from '../src/services/messages.ts';

describe('signBody', () => {
  it('is deterministic for the same body', () => {
    assert.equal(signBody('hello'), signBody('hello'));
  });

  it('differs for different bodies', () => {
    assert.notEqual(signBody('hello'), signBody('hello '));
  });

  it('carries a version prefix so the algorithm can be replaced', () => {
    assert.match(signBody('hello'), /^v2:[0-9a-f]{64}$/);
  });

  it('handles multibyte bodies', () => {
    // Signed as utf8 explicitly; a latin1 default would hash different bytes than were stored.
    assert.equal(signBody('привіт 🙂'), signBody('привіт 🙂'));
    assert.notEqual(signBody('привіт 🙂'), signBody('привіт'));
  });
});

describe('verifyBody', () => {
  it('accepts a body that matches its signature', () => {
    const body = 'the original text';
    assert.equal(verifyBody(body, signBody(body)), true);
  });

  it('rejects a body that has been altered', () => {
    assert.equal(verifyBody('rewritten text', signBody('the original text')), false);
  });

  it('rejects a signature from a different body of the same length', () => {
    assert.equal(verifyBody('aaaa', signBody('bbbb')), false);
  });

  it('reports legacy signatures as unverifiable rather than tampered', () => {
    // Rows written before versioning carried a bare hex digest with no prefix. Returning false
    // for those would flag every pre-existing message as tampered with.
    assert.equal(verifyBody('anything', 'a'.repeat(64)), null);
    assert.equal(verifyBody('anything', 'v1:' + 'a'.repeat(64)), null);
    assert.equal(verifyBody('anything', undefined), null);
    assert.equal(verifyBody('anything', ''), null);
  });

  it('does not throw when the signature length differs', () => {
    // crypto.timingSafeEqual throws on unequal lengths, so the guard has to come first.
    assert.equal(verifyBody('anything', 'v2:tooshort'), false);
    assert.equal(verifyBody('anything', 'v2:' + 'a'.repeat(200)), false);
  });
});
