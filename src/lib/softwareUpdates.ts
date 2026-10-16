import type { SoftwareUpdateStatus, UpdateProgress } from "../types";

export type UpdatePhase = "idle" | "checking" | "downloading" | "verifying" | "ready" | "installing";

export function manualDownloadMessage(error: string) {
  return `${error}；GitHub 无法访问时，可在“关于礼金簿”的下载方式中使用蓝奏云或百度网盘手动下载。`;
}

export function updateStatusMessage(status: SoftwareUpdateStatus | null) {
  if (!status) return "尚未检查更新";
  if (status.candidate) return `发现新版本 v${status.candidate.version}`;
  if (status.error) return status.error;
  if (!status.configured) return "自动更新尚未配置，可使用下方下载方式";
  return status.checkedAt ? "当前已是最新版本" : "尚未检查更新";
}

export function canApplyUpdate(root: Pick<Document, "querySelector">) {
  return !root.querySelector('[data-modal-dirty="true"], [data-modal-saving="true"]');
}

// Set inert synchronously: React rendering must not leave an editable gap before the RPC.
export function lockUpdateInterface(root: Document) {
  if (!canApplyUpdate(root)) throw new Error("请先保存或关闭正在编辑的表单");
  const previouslyInert = root.documentElement.hasAttribute("inert");
  root.documentElement.setAttribute("inert", "");
  return () => { if (!previouslyInert) root.documentElement.removeAttribute("inert"); };
}

export function downloadPercent(progress: Pick<UpdateProgress, "received" | "total"> | null) {
  return progress?.total ? Math.min(100, Math.round(progress.received / progress.total * 100)) : null;
}

export function formatDownloadSize(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
