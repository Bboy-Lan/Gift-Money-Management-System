type TraceEntry = { id: string; personId: string; bookId: string };

export function resolveTraceSource<T extends TraceEntry>(entityType: string, entityId: string, entries: T[]): T | null {
  const matches = entries.filter((entry) => entityType === 'person' ? entry.personId === entityId : (entityType === 'gift_entry' || entityType === 'return_gift') && entry.id === entityId);
  return matches.length === 1 ? matches[0] : null;
}
