import type { RecentVault } from "./recentVaults";

type OpenedBook = { id: string };

export type RecentOpenStatus = "none" | "failed" | "opened";
export type WorkspaceLaunchTarget = "workspace-start" | "start-page" | "vault";

export function resolveWorkspaceLaunchTarget(status: RecentOpenStatus): WorkspaceLaunchTarget {
  if (status === "none" || status === "failed") return "workspace-start";
  return "vault";
}

export async function openRecentVault<T>(
  recent: RecentVault | undefined,
  opener: (path: string) => Promise<T>,
) {
  if (!recent) return { status: "none" as const };
  try {
    return {
      status: "opened" as const,
      recent,
      result: await opener(recent.path),
      bookId: recent.bookId ?? null,
    };
  } catch (error) {
    return {
      status: "failed" as const,
      recent,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function openRecentVaults<T>(recentVaults: readonly RecentVault[], opener: (path: string) => Promise<T>) {
  // Only the newest record is an automatic launch target. Falling back to an
  // older record can silently reopen a valid but unrelated vault after the
  // newest vault was moved or renamed.
  return openRecentVaultsLatest(recentVaults[0], opener);
}

export async function openRecentVaultsLatest<T>(recent: RecentVault | undefined, opener: (path: string) => Promise<T>) {
  return recent ? openRecentVault(recent, opener) : { status: "none" as const };
}

export function resolveInitialBookId(preferredBookId: string | null | undefined, books: readonly OpenedBook[]) {
  if (!books.length) return null;
  return preferredBookId && books.some((book) => book.id === preferredBookId)
    ? preferredBookId
    : books[0].id;
}
