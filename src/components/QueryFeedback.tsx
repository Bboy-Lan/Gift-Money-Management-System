import type React from "react";
import { readState } from "../lib/viewSafety";

export function QueryFeedback({ query, label }: { query: { isPending: boolean; isError: boolean; data?: unknown; error?: unknown; refetch: () => unknown }; label: string }): React.ReactNode {
  const state = readState(query);
  if (state === "loading") return <div className="table-empty" role="status">正在读取{label}…</div>;
  if (state !== "error" && state !== "stale") return null;
  return <div className="query-error" role="alert"><strong>{label}读取失败</strong><span>{String(query.error ?? "未知错误").replace(/^Error:\s*/, "")}</span>{state === "stale" && <small>下方保留上次读取的数据，可能已过期。</small>}<button className="secondary-button compact" type="button" onClick={() => void query.refetch()}>重试</button></div>;
}
