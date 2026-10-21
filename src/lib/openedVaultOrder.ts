const STORAGE_KEY = "lijin-book.opened-vault-order";

function getStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
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

export function readOpenedVaultOrder(storage?: Storage): string[] {
  const target = getStorage(storage);
  if (!target) return [];
  try {
    const parsed: unknown = JSON.parse(target.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.filter((value): value is string => {
      if (typeof value !== "string" || !value.trim()) return false;
      const key = pathKey(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((value) => value.trim()).slice(0, 16);
  } catch {
    return [];
  }
}

export function rememberOpenedVaultOrder(paths: readonly string[], storage?: Storage): string[] {
  const unique = new Map<string, string>();
  for (const path of paths) {
    if (typeof path !== "string" || !path.trim()) continue;
    unique.set(pathKey(path), path.trim());
  }
  const next = [...unique.values()].slice(0, 16);
  try {
    getStorage(storage)?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ordering is a convenience and must never block vault operations.
  }
  return next;
}

