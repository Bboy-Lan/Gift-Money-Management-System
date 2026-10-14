import type { AuditLog } from "../types";

export function readState(query: { isPending: boolean; isError: boolean; data?: unknown }) {
  if (query.isError) return query.data === undefined ? "error" : "stale";
  if (query.isPending) return "loading";
  return Array.isArray(query.data) && query.data.length === 0 ? "empty" : "ready";
}

export function allowFormClose(dirty: boolean, saving: boolean, confirmDiscard: () => boolean) {
  return !saving && (!dirty || confirmDiscard());
}

export function validateChangedText(label: string, value: string, limit: number, original?: string | null) {
  if (value === original) return null;
  if (value.includes("\0")) return `${label}含有无效字符`;
  return Array.from(value).length > limit ? `${label}最多 ${limit} 字` : null;
}

export function validateChangedDate(value: string, original?: string | null) {
  if (value === original || !value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.exec(value);
  if (!match) return "请输入有效日期";
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10) ? null : "请输入有效日期";
}

export function canRestoreAudit(record: Pick<AuditLog, "reversible">) { return record.reversible === true; }

export function firstCharacter(value: string) {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale: string, options: { granularity: string }) => { segment: (text: string) => Iterable<{ segment: string }> } }).Segmenter;
  return Segmenter ? [...new Segmenter("zh", { granularity: "grapheme" }).segment(value)][0]?.segment ?? "" : Array.from(value)[0] ?? "";
}

export function sourceRowSpans(rows: readonly { vaultPath: string; bookId: string }[], includeBook: boolean) {
  const result = new Map<number, number>();
  for (let index = 0; index < rows.length;) {
    let end = index + 1;
    while (end < rows.length && rows[end].vaultPath === rows[index].vaultPath && (!includeBook || rows[end].bookId === rows[index].bookId)) end++;
    result.set(index, end - index); index = end;
  }
  return result;
}
