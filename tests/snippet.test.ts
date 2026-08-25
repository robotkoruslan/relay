import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { snippet } from '../src/search/snippet.ts';

describe('snippet', () => {
  it('returns short bodies untouched', () => {
    assert.equal(snippet('short message', 'message', 60), 'short message');
  });

  it('centres the window on the match and marks both elisions', () => {
    const body = `${'a'.repeat(200)} needle ${'b'.repeat(200)}`;
    const result = snippet(body, 'needle', 20);
    assert.ok(result.includes('needle'), result);
    assert.ok(result.startsWith('…'), result);
    assert.ok(result.endsWith('…'), result);
  });

  it('does not mark a leading elision when the match is at the start', () => {
    const result = snippet(`needle ${'b'.repeat(300)}`, 'needle', 20);
    assert.ok(result.startsWith('needle'), result);
    assert.ok(result.endsWith('…'), result);
  });

  it('matches case-insensitively', () => {
    const body = `${'a'.repeat(200)} NEEDLE ${'b'.repeat(200)}`;
    assert.ok(snippet(body, 'needle', 20).toLowerCase().includes('needle'));
  });

  it('uses the earliest of several query terms', () => {
    const body = `${'x'.repeat(100)} alpha ${'y'.repeat(300)} omega ${'z'.repeat(100)}`;
    assert.ok(snippet(body, 'omega alpha', 20).includes('alpha'));
  });

  it('falls back to the start when no term literally appears', () => {
    // $text is stemmed, so a hit does not guarantee the query term is present verbatim.
    const body = 'c'.repeat(400);
    const result = snippet(body, 'running', 20);
    assert.equal(result.length, 41); // 2 * radius plus the trailing ellipsis
    assert.ok(result.endsWith('…'));
  });

  it('ignores empty query terms from padded input', () => {
    const body = `${'a'.repeat(200)} needle ${'b'.repeat(200)}`;
    assert.ok(snippet(body, '   needle   ', 20).includes('needle'));
  });
});
