import type { QueryClient } from "@tanstack/react-query";

const DATA_QUERIES = new Set(["books", "entries", "people", "tags", "audit-logs", "return-gifts", "outbound-gifts", "outbound-gift-summary", "trash", "book-stats", "book-summary", "person-history", "vault-search", "opened-vault-books", "duplicate-person-name", "comparison-books", "comparison-book-people", "comparison-book-duplicate-people", "comparison-person-history"]);

export function invalidateVaultQueries(client: QueryClient, vaultPath: string) {
  const containsPath = (value: unknown): boolean => Array.isArray(value) ? value.some(containsPath) : typeof value === "string" && value.split(/[\u001f|]/).includes(vaultPath);
  return client.invalidateQueries({ predicate: (query) => DATA_QUERIES.has(String(query.queryKey[0])) && (query.queryKey[0] === "trash" || query.queryKey.some(containsPath)) });
}
