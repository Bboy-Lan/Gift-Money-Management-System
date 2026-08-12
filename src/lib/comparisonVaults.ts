import type { ComparisonBookRef } from "../types";

const STORAGE_KEY = "lijin-book.comparison-vaults";
const SELECTION_STORAGE_KEY = "lijin-book.comparison-book-selection";
const HIDDEN_BOOK_STORAGE_KEY = "lijin-book.hidden-comparison-books";
const GIFT_BOOK_ORDER_STORAGE_KEY = "lijin-book.gift-book-order";

function storage(provided?: Storage): Storage | null {
  if (provided) return provided;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function pathKey(path: string) {
  return path.trim().replaceAll("/", "\\").toLocaleLowerCase();
}

export function readGiftBookOrder(vaultPath: string, provided?: Storage): string[] {
  const target = storage(provided);
  if (!target) return [];
  try {
    const parsed: unknown = JSON.parse(target.getItem(GIFT_BOOK_ORDER_STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const saved = (parsed as Record<string, unknown>)[pathKey(vaultPath)];
    if (!Array.isArray(saved)) return [];
    return [...new Set(saved.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim()))];
  } catch {
    return [];
  }
}

export function rememberGiftBookOrder(vaultPath: string, bookIds: readonly string[], provided?: Storage): string[] {
  const target = storage(provided);
  const next = [...new Set(bookIds.filter((id) => Boolean(id.trim())).map((id) => id.trim()))];
  if (!target) return next;
  try {
    const parsed: unknown = JSON.parse(target.getItem(GIFT_BOOK_ORDER_STORAGE_KEY) || "{}");
    const orders = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
    orders[pathKey(vaultPath)] = next;
    target.setItem(GIFT_BOOK_ORDER_STORAGE_KEY, JSON.stringify(orders));
  } catch {
    // The sidebar sequence is a local display preference and must not block use of a vault.
  }
  return next;
}

export function orderGiftBooks<T extends { id?: string; bookId?: string }>(books: readonly T[], savedOrder: readonly string[]): T[] {
  const rank = new Map(savedOrder.map((id, index) => [id, index]));
  return books
    .map((book, index) => ({ book, index }))
    .sort((left, right) => (rank.get(left.book.id ?? left.book.bookId ?? "") ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.book.id ?? right.book.bookId ?? "") ?? Number.MAX_SAFE_INTEGER) || left.index - right.index)
    .map(({ book }) => book);
}

export function readComparisonVaults(): string[] {
  try {
    const value: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(String).filter(Boolean))];
  } catch {
    return [];
  }
}

export function rememberComparisonVaults(paths: string[]): string[] {
  const next = [...new Set(paths.map(String).filter(Boolean))];
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The comparison list is optional and must never block read-only comparison.
  }
  return next;
}

export function forgetComparisonVault(path: string): string[] {
  const key = pathKey(path);
  return rememberComparisonVaults(readComparisonVaults().filter((item) => pathKey(item) !== key));
}

export function readComparisonBookSelection(vaultPath: string, provided?: Storage): ComparisonBookRef[] | null {
  const target = storage(provided);
  if (!target) return null;
  try {
    const parsed: unknown = JSON.parse(target.getItem(SELECTION_STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>)[pathKey(vaultPath)];
    if (!Array.isArray(value)) return null;
    const unique = new Map<string, ComparisonBookRef>();
    for (const item of value) {
      if (!item || typeof item !== "object" || typeof item.vaultPath !== "string" || typeof item.bookId !== "string" || !item.vaultPath.trim() || !item.bookId.trim()) continue;
      const reference = { vaultPath: item.vaultPath.trim(), bookId: item.bookId.trim() };
      unique.set(`${pathKey(reference.vaultPath)}\u001f${reference.bookId}`, reference);
    }
    return [...unique.values()];
  } catch {
    return null;
  }
}

export function rememberComparisonBookSelection(vaultPath: string, references: readonly ComparisonBookRef[], provided?: Storage) {
  const target = storage(provided);
  if (!target) return;
  try {
    const parsed: unknown = JSON.parse(target.getItem(SELECTION_STORAGE_KEY) || "{}");
    const selections = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
    const unique = new Map<string, ComparisonBookRef>();
    for (const reference of references) {
      if (!reference.vaultPath.trim() || !reference.bookId.trim()) continue;
      const normalized = { vaultPath: reference.vaultPath.trim(), bookId: reference.bookId.trim() };
      unique.set(`${pathKey(normalized.vaultPath)}\u001f${normalized.bookId}`, normalized);
    }
    selections[pathKey(vaultPath)] = [...unique.values()];
    target.setItem(SELECTION_STORAGE_KEY, JSON.stringify(selections));
  } catch {
    // Selection memory is optional and must never block comparison.
  }
}

export function readHiddenComparisonBooks(vaultPath: string, provided?: Storage): ComparisonBookRef[] {
  const target = storage(provided);
  if (!target) return [];
  try {
    const parsed: unknown = JSON.parse(target.getItem(HIDDEN_BOOK_STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const value = (parsed as Record<string, unknown>)[pathKey(vaultPath)];
    if (!Array.isArray(value)) return [];
    const unique = new Map<string, ComparisonBookRef>();
    for (const item of value) {
      if (!item || typeof item !== "object" || typeof item.vaultPath !== "string" || typeof item.bookId !== "string" || !item.vaultPath.trim() || !item.bookId.trim()) continue;
      const reference = { vaultPath: item.vaultPath.trim(), bookId: item.bookId.trim() };
      unique.set(`${pathKey(reference.vaultPath)}\u001f${reference.bookId}`, reference);
    }
    return [...unique.values()];
  } catch {
    return [];
  }
}

export function rememberHiddenComparisonBooks(vaultPath: string, references: readonly ComparisonBookRef[], provided?: Storage) {
  const target = storage(provided);
  if (!target) return [];
  const unique = new Map<string, ComparisonBookRef>();
  for (const reference of references) {
    if (!reference.vaultPath.trim() || !reference.bookId.trim()) continue;
    const normalized = { vaultPath: reference.vaultPath.trim(), bookId: reference.bookId.trim() };
    unique.set(`${pathKey(normalized.vaultPath)}\u001f${normalized.bookId}`, normalized);
  }
  const next = [...unique.values()];
  try {
    const parsed: unknown = JSON.parse(target.getItem(HIDDEN_BOOK_STORAGE_KEY) || "{}");
    const hidden = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
    hidden[pathKey(vaultPath)] = next;
    target.setItem(HIDDEN_BOOK_STORAGE_KEY, JSON.stringify(hidden));
  } catch {
    // Hiding a comparison source is optional and must not block viewing data.
  }
  return next;
}
