/** Produces bounded, PostgREST-safe terms shared by durable text searches. */
export function extractSearchTerms(query: string, maximum = 5): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9'-]{2,}/g) ?? [])].slice(0, maximum);
}

/** Keeps the first occurrence of each result so repeated chat turns do not crowd out useful context. */
export function takeDistinctSearchResults<T>(
  values: T[],
  keyFor: (value: T) => string,
  limit: number,
): T[] {
  const seen = new Set<string>();
  const distinct: T[] = [];
  for (const value of values) {
    const key = keyFor(value).trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(value);
    if (distinct.length >= limit) break;
  }
  return distinct;
}
