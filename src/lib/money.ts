export function parseAmountFen(value: string): number | null {
  const normalized = value.trim().replace(/[¥￥,元\s]/g, "");
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
  const [whole, decimal = ""] = normalized.split(".");
  const yuan = Number.parseInt(whole, 10);
  if (!Number.isSafeInteger(yuan)) return null;
  const cents = decimal.length === 0 ? 0 : Number.parseInt(decimal.padEnd(2, "0"), 10);
  const result = yuan * 100 + cents;
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

export function formatMoney(fen: number): string {
  const sign = fen < 0 ? "-" : "";
  const absolute = Math.abs(fen);
  const yuan = Math.trunc(absolute / 100).toLocaleString("zh-CN");
  return `${sign}¥${yuan}.${String(absolute % 100).padStart(2, "0")}`;
}

export function formatSummaryMoney(fen: number): { primary: string; exact: string | null } {
  if (fen < 10_000_000) return { primary: formatMoney(fen), exact: null };
  const unit = fen >= 10_000_000_000 ? "亿" : "万";
  const divisor = unit === "亿" ? 10_000_000_000 : 1_000_000;
  const value = (fen / divisor).toFixed(2).replace(/\.00$/, "");
  return { primary: `¥${value} ${unit}`, exact: `精确金额 ${formatMoney(fen)}` };
}
