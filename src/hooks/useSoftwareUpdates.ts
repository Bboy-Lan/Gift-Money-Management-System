import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { api } from "../lib/tauri";
import { canApplyUpdate, lockUpdateInterface, manualDownloadMessage, type UpdatePhase } from "../lib/softwareUpdates";
import type { SoftwareUpdateStatus, UpdateProgress } from "../types";

export function useSoftwareUpdates(options: { beforeInstall: () => void; onNotice: (message: string) => void }) {
  const [status, setStatus] = useState<SoftwareUpdateStatus | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const current = useRef(options); current.current = options;
  const selected = useRef<SoftwareUpdateStatus | null>(null);
  const ready = useRef<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);

  const check = useCallback(async (force = true) => {
    if (busy.current) return;
    busy.current = true; setPhase("checking"); setError(null);
    try {
      const result = await api.softwareUpdateStatus(force);
      if (!mounted.current) return;
      selected.current = result; setStatus(result); ready.current = null;
      if (result.error) setError(manualDownloadMessage(result.error));
    } catch (value) {
      if (mounted.current) {
        const message = manualDownloadMessage(String(value));
        setError(message);
        setStatus(previous => previous ? { ...previous, error: message } : null);
      }
    } finally {
      busy.current = false;
      if (mounted.current) setPhase("idle");
    }
  }, []);

  const install = useCallback(async () => {
    const candidate = selected.current?.candidate;
    if (!candidate || busy.current) return;
    if (!selected.current?.installed) {
      setError("当前为便携运行，请通过下方下载方式安装礼金簿，安装版支持一键更新。"); return;
    }
    busy.current = true; setError(null);
    let unlock: (() => void) | undefined;
    try {
      if (ready.current !== candidate.id) {
        setPhase("downloading"); setProgress(null);
        const channel = new Channel<UpdateProgress>();
        channel.onmessage = (message) => {
          if (mounted.current) { setProgress(message); setPhase(message.phase); }
        };
        await api.prepareSoftwareUpdate(candidate.id, channel);
        ready.current = candidate.id;
      }
      if (!canApplyUpdate(document)) {
        setError("更新已准备好，请先保存或关闭正在编辑的表单，再点击“重启并安装”。");
        setPhase("ready"); return;
      }
      unlock = lockUpdateInterface(document);
      current.current.beforeInstall();
      setPhase("installing");
      await api.applySoftwareUpdate(candidate.id);
    } catch (value) {
      if (mounted.current) { setError(ready.current === candidate.id ? String(value) : manualDownloadMessage(String(value))); setPhase(ready.current === candidate.id ? "ready" : "idle"); }
    } finally { unlock?.(); busy.current = false; }
  }, []);

  const openChannel = useCallback(async (id: string) => {
    try { await api.openDownloadChannel(id); } catch (value) { setError(String(value)); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void api.softwareUpdateOptions().then(result => {
      if (mounted.current && !selected.current) { selected.current = result; setStatus(result); }
    }).catch(value => { if (mounted.current) setError(String(value)); });
    void api.acknowledgeSoftwareUpdate().then(message => { if (mounted.current && message) current.current.onNotice(message); }).catch(() => {});
    const startup = window.setTimeout(() => void check(false), 5000);
    const hourly = window.setInterval(() => void check(false), 60 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === "visible") void check(false); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false; window.clearTimeout(startup); window.clearInterval(hourly);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  return { status, phase, progress, error, check, install, openChannel,
    clearError: () => setError(null),
    bannerVisible: Boolean(status?.candidate && dismissed !== status.candidate.id),
    dismiss: () => setDismissed(status?.candidate?.id ?? null) };
}

export type SoftwareUpdateController = ReturnType<typeof useSoftwareUpdates>;
export const SoftwareUpdateContext = createContext<SoftwareUpdateController | null>(null);
