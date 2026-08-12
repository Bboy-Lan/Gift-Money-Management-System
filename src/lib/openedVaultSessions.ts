import type { Tab } from "../types";

export interface OpenedVaultSessionState {
  path: string;
  activeBookId: string | null;
  /** The workspace page is shared by every vault in one desktop session. */
  activeTab: Tab;
}

const STORAGE_KEY = "lijin-book.opened-vault-sessions";
const TABS: readonly Tab[] = ["entries", "people", "compare", "returnGifts", "history", "trash", "settings"];

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

function isTab(value: unknown): value is Tab {
  return typeof value === "string" && TABS.includes(value as Tab);
}

export function readOpenedVaultSessions(storage?: Storage): OpenedVaultSessionState[] {
  const target = getStorage(storage);
  if (!target) return [];
  try {
    const parsed: unknown = JSON.parse(target.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    const sessions = new Map<string, OpenedVaultSessionState>();
    for (const item of parsed) {
      if (!item || typeof item !== "object" || typeof item.path !== "string" || !item.path.trim()) continue;
      const path = item.path.trim();
      sessions.set(pathKey(path), {
        path,
        activeBookId: typeof item.activeBookId === "string" && item.activeBookId ? item.activeBookId : null,
        activeTab: isTab(item.activeTab) ? item.activeTab : "entries",
      });
    }
    return [...sessions.values()].slice(0, 16);
  } catch {
    return [];
  }
}

export function rememberOpenedVaultSessions(sessions: readonly OpenedVaultSessionState[], activePath?: string | null, storage?: Storage) {
  const activeKey = activePath ? pathKey(activePath) : null;
  const unique = new Map<string, OpenedVaultSessionState>();
  for (const session of sessions) {
    if (!session.path.trim()) continue;
    const path = session.path.trim();
    unique.set(pathKey(path), {
      path,
      activeBookId: session.activeBookId || null,
      activeTab: isTab(session.activeTab) ? session.activeTab : "entries",
    });
  }
  const next = [...unique.values()].sort((left, right) => {
    if (activeKey && pathKey(left.path) === activeKey) return -1;
    if (activeKey && pathKey(right.path) === activeKey) return 1;
    return 0;
  }).slice(0, 16);
  try {
    getStorage(storage)?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Session restoration is optional and must not block opening a vault.
  }
  return next;
}
