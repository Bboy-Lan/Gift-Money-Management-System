import type { GiftBook, VaultInfo } from "../types";

export interface RecentVault {
  path: string;
  name: string;
  bookId?: string;
  bookTitle?: string;
}

const STORAGE_KEY = "lijin-book.recent-vaults";

function getStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function recentVaultIdentity(recent: Pick<RecentVault, "path" | "bookId">) {
  return `${recent.path}\u001f${recent.bookId ?? ""}`;
}

export function readRecentVaults(storage?: Storage): RecentVault[] {
  const target = getStorage(storage);
  if (!target) return [];
  try {
    const parsed: unknown = JSON.parse(target.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is RecentVault => Boolean(item && typeof item === "object" && "path" in item && "name" in item))
      .map((item) => ({
        path: String(item.path),
        name: String(item.name),
        bookId: typeof item.bookId === "string" ? item.bookId : undefined,
        bookTitle: typeof item.bookTitle === "string" ? item.bookTitle : undefined,
      }))
      .filter((item) => item.path.length > 0 && item.name.length > 0)
      .slice(0, 8);
  } catch {
    return [];
  }
}

export function rememberRecentVault(vault: Pick<VaultInfo, "path" | "name">, book?: Pick<GiftBook, "id" | "title">, storage?: Storage): RecentVault[] {
  const target = getStorage(storage);
  const existing = readRecentVaults(target ?? undefined);
  if (!book) {
    const recentBook = existing.find((item) => item.path === vault.path && item.bookId);
    if (recentBook) {
      const next = [recentBook, ...existing.filter((item) => item !== recentBook)].slice(0, 8);
      try {
        target?.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Local history is optional.
      }
      return next;
    }
  }
  const current: RecentVault = book
    ? { path: vault.path, name: book.title, bookId: book.id, bookTitle: book.title }
    : { path: vault.path, name: vault.name };
  const next = [current, ...existing.filter((item) => {
    if (item.path !== vault.path) return true;
    if (!book) return Boolean(item.bookId);
    return item.bookId !== book.id && Boolean(item.bookId);
  })].slice(0, 8);
  try {
    target?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Local history is optional; opening the vault must still work if storage is unavailable.
  }
  return next;
}

export function forgetRecentVault(recent: Pick<RecentVault, "path" | "bookId">, storage?: Storage): RecentVault[] {
  const target = getStorage(storage);
  const identity = recentVaultIdentity(recent);
  const next = readRecentVaults(target ?? undefined).filter((item) => recentVaultIdentity(item) !== identity);
  try {
    target?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Local history is optional.
  }
  return next;
}
