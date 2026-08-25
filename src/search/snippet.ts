/**
 * A window of the body around the first matching term, so a result list shows why something
 * matched instead of dumping whole messages.
 *
 * Mongo's $text is stemmed, so a query term may match a word it does not literally equal
 * ("running" matching "runs"). When no literal position can be found, fall back to the start of
 * the body rather than returning nothing useful.
 */
export function snippet(body: string, query: string, radius = 60): string {
  const window = radius * 2;
  if (body.length <= window) return body;

  const haystack = body.toLowerCase();
  let at = -1;
  for (const term of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const found = haystack.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }

  if (at === -1) return `${body.slice(0, window).trimEnd()}…`;

  const start = Math.max(0, at - radius);
  const end = Math.min(body.length, at + radius);
  return `${start > 0 ? '…' : ''}${body.slice(start, end).trim()}${end < body.length ? '…' : ''}`;
}
