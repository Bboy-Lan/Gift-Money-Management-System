import type { RecentVault } from "./recentVaults";

type OpenedBook = { id: string };

export type RecentOpenStatus = "none" | "failed" | "opened";
export type WorkspaceLaunchTarget = "workspace-start" | "start-page" | "vault";

export function resolveWorkspaceLaunchTarget(status: RecentOpenStatus): WorkspaceLaunchTarget {
  if (status === "none") return "workspace-start";
  if (status === "failed") return "start-page";
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
  let firstFailure: Awaited<ReturnType<typeof openRecentVault<T>>> | undefined;
  for (const recent of recentVaults) {
    const opened = await openRecentVault(recent, opener);
    if (opened.status !== "failed") return opened;
    firstFailure ??= opened;
  }
  return firstFailure ?? { status: "none" as const };
}

export function resolveInitialBookId(preferredBookId: string | null | undefined, books: readonly OpenedBook[]) {
  if (!books.length) return null;
  return preferredBookId && books.some((book) => book.id === preferredBookId)
    ? preferredBookId
    : books[0].id;
}
