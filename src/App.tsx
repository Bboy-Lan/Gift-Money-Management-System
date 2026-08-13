import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Archive,
  ArrowLeft,
  BarChart3,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CirclePlus,
  Copy,
  ExternalLink,
  FileSpreadsheet,
  FolderOpen,
  Gift,
  History,
  Info,
  KeyRound,
  LockKeyhole,
  LayoutDashboard,
  ListChecks,
  Pencil,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Unlock,
  UsersRound,
  X,
} from "lucide-react";
import { api } from "./lib/tauri";
import { forgetRecentVault, readRecentVaults, recentVaultIdentity, rememberRecentVault, type RecentVault } from "./lib/recentVaults";
import { orderGiftBooks, readComparisonVaults, readGiftBookOrder, rememberGiftBookOrder } from "./lib/comparisonVaults";
import { readOpenedVaultSessions, rememberOpenedVaultSessions, type OpenedVaultSessionState } from "./lib/openedVaultSessions";
import { canonicalizeTags, resolveCatalogTags } from "./lib/tagCatalog";
import { getEntryTagSections, mergeEntryTag } from "./lib/entryTags";
import { normalizePersonName, personNamesMatch } from "./lib/personName";
import { CompareView as CompareViewPanel } from "./CompareView";
import type { SpreadsheetColumnMapping, SpreadsheetImportItem, SpreadsheetPreview } from "./lib/tauri";
import type { AuditLog, GiftBook, GiftEntry, LocalUpdateStatus, Person, ReturnGiftRecord, SearchHit, SearchResponse, SessionStatus, Tab, Tag, TrashItem, VaultInfo } from "./types";
import { formatMoney, formatSummaryMoney, parseAmountFen } from "./lib/money";
import { openRecentVault, openRecentVaults, resolveInitialBookId, resolveWorkspaceLaunchTarget } from "./lib/workspaceLaunch";
import { PAYMENT_METHOD_OPTIONS, resolvePaymentMethodValue } from "./lib/paymentMethods";
import { CURRENT_RELEASE_NOTES } from "./releaseNotes";

const today = () => new Date().toISOString().slice(0, 10);
const nowLocalDateTime = () => {
  const value = new Date();
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
};

const WELCOME_WINDOW = { width: 390, height: 420, minWidth: 390, minHeight: 420 };
const WORKSPACE_WINDOW = { width: 1100, height: 720, minWidth: 1080, minHeight: 660 };
const TAG_COLORS = ["#0f766e", "#2563eb", "#b45309", "#9f1239", "#7c3aed", "#047857", "#be123c", "#0369a1"];
const SPREADSHEET_EXTENSIONS = new Set(["xlsx", "xls", "xlsm", "xlsb", "ods", "csv", "tsv"]);
const SPREADSHEET_MAPPING_FIELDS: Array<[keyof SpreadsheetColumnMapping, string]> = [["name", "姓名"], ["amount", "金额"], ["address", "地址"], ["paymentMethod", "支付方式"], ["date", "登记日期"], ["note", "备注"], ["tags", "人物标签"], ["returnGiftAmount", "回礼金额"], ["returnGift", "回礼备注"], ["returnGiftedAt", "回礼时间"]];
type LocalUpdatePhase = "idle" | "checking" | "installing";
type SettingsSection = "general" | "about";
type OpenedVaultSession = { vault: VaultInfo; activeBookId: string | null; activeTab: Tab };

function vaultPathKey(path: string) {
  return path.trim().toLocaleLowerCase();
}

function nextTagColor(tags: Tag[]) {
  const used = new Set(tags.map((tag) => tag.color.toLocaleLowerCase()));
  const available = TAG_COLORS.find((color) => !used.has(color));
  if (available) return available;
  let seed = used.size + 1;
  while (true) {
    seed = Math.imul(seed, 1664525) + 1013904223;
    const color = `#${(seed >>> 0 & 0xffffff).toString(16).padStart(6, "0")}`;
    if (!used.has(color)) return color;
  }
}

function colorizeTags(tags: Tag[]) {
  return canonicalizeTags(tags);
}

function isSupportedSpreadsheetPath(path: string) {
  const fileName = path.split(/[\\/]/).pop() ?? "";
  const extension = fileName.includes(".") ? fileName.split(".").pop()?.toLocaleLowerCase() : "";
  return Boolean(extension && SPREADSHEET_EXTENSIONS.has(extension));
}

function uniquePaths(paths: string[]) {
  const result = new Map<string, string>();
  for (const path of paths) {
    const normalized = path.trim();
    if (normalized && !result.has(normalized.toLocaleLowerCase())) result.set(normalized.toLocaleLowerCase(), normalized);
  }
  return [...result.values()];
}

type EntryDraft = {
  personName: string;
  address: string;
  amountFen: number;
  paymentMethod: string;
  receivedAt: string;
  note: string;
  returnGift: string;
  returnGiftAmountFen: number | null;
  tagIds: string[];
};

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debouncedValue;
}

function startWelcomeDrag(event: React.MouseEvent<HTMLElement>) {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement;
  if (target.closest("button, input, textarea, select, a, label")) return;
  void getCurrentWindow().startDragging().catch(() => {
    // Browser previews do not expose the native Tauri window API.
  });
}

function App() {
  const client = useQueryClient();
  const [vault, setVault] = useState<VaultInfo | null>(null);
  const [openedVaults, setOpenedVaults] = useState<OpenedVaultSession[]>([]);
  const [bookSelections, setBookSelections] = useState<Record<string, string | null>>({});
  const [workspaceTab, setWorkspaceTab] = useState<Tab>("entries");
  const [session, setSession] = useState<SessionStatus>({ role: "viewer", securityConfigured: false, editLocked: true });
  const [error, setError] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [createVaultOpen, setCreateVaultOpen] = useState(false);
  const [vaultName, setVaultName] = useState("我的家庭礼金库");
  const [vaultNotes, setVaultNotes] = useState("");
  const [recentVaults, setRecentVaults] = useState<RecentVault[]>(() => readRecentVaults());
  const [adminPrompt, setAdminPrompt] = useState<"unlock" | "setup" | "recover" | null>(null);
  const [enterWorkspaceAfterAdmin, setEnterWorkspaceAfterAdmin] = useState(false);
  const [pendingWorkspaceVault, setPendingWorkspaceVault] = useState<RecentVault | null>(null);
  const [pendingWorkspaceBookId, setPendingWorkspaceBookId] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [pinChangeOpen, setPinChangeOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [operationHint, setOperationHint] = useState<string | null>(null);
  const noticeTimeoutRef = useRef<number | null>(null);
  const operationHintTimeoutRef = useRef<number | null>(null);
  const [localUpdatePhase, setLocalUpdatePhase] = useState<LocalUpdatePhase>("idle");
  const [lastUpdateCheckAt, setLastUpdateCheckAt] = useState<string | null>(null);
  const [continuousRegistration, setContinuousRegistration] = useState(true);
  const [pendingSpreadsheetPaths, setPendingSpreadsheetPaths] = useState<string[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const localUpdate = useQuery({ queryKey: ["local-update"], queryFn: api.localUpdateStatus, enabled: false, retry: false });

  useEffect(() => () => {
    if (noticeTimeoutRef.current !== null) window.clearTimeout(noticeTimeoutRef.current);
    if (operationHintTimeoutRef.current !== null) window.clearTimeout(operationHintTimeoutRef.current);
  }, []);

  useEffect(() => {
    const clearOperationHint = () => {
      if (operationHintTimeoutRef.current !== null) window.clearTimeout(operationHintTimeoutRef.current);
      operationHintTimeoutRef.current = null;
      setOperationHint(null);
    };
    const hintOwner = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-operation-hint]") : null;
    const scheduleOperationHint = (target: EventTarget | null) => {
      const owner = hintOwner(target);
      const message = owner?.dataset.operationHint;
      if (!message || notice) return;
      if (operationHintTimeoutRef.current !== null) window.clearTimeout(operationHintTimeoutRef.current);
      operationHintTimeoutRef.current = window.setTimeout(() => {
        setOperationHint(message);
        operationHintTimeoutRef.current = null;
      }, 350);
    };
    const pointerOut = (event: PointerEvent) => {
      const owner = hintOwner(event.target);
      if (owner?.contains(event.relatedTarget as Node | null)) return;
      clearOperationHint();
    };
    const pointerOver = (event: PointerEvent) => scheduleOperationHint(event.target);
    const focusIn = (event: FocusEvent) => scheduleOperationHint(event.target);
    const focusOut = (event: FocusEvent) => {
      const owner = hintOwner(event.target);
      if (owner?.contains(event.relatedTarget as Node | null)) return;
      clearOperationHint();
    };
    document.addEventListener("pointerover", pointerOver);
    document.addEventListener("pointerout", pointerOut);
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", focusOut);
    return () => {
      document.removeEventListener("pointerover", pointerOver);
      document.removeEventListener("pointerout", pointerOut);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", focusOut);
      clearOperationHint();
    };
  }, [notice]);

  useEffect(() => {
    if (!openedVaults.length) return;
    rememberOpenedVaultSessions(
      openedVaults.map((item) => ({ path: item.vault.path, activeBookId: item.activeBookId, activeTab: workspaceTab })),
      vault?.path,
    );
  }, [openedVaults, vault, workspaceTab]);

  useEffect(() => {
    void api.getAppSecurityStatus().then((status) => {
      setSession(status);
      if (!status.securityConfigured) setAdminPrompt("setup");
    }).catch((errorValue) => setError(String(errorValue)));
  }, []);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        setDragActive(true);
        return;
      }
      if (payload.type === "leave") {
        setDragActive(false);
        return;
      }
      setDragActive(false);
      const seenPaths = new Set<string>();
      let duplicateCount = 0;
      const uniquePaths = payload.paths
        .map((path) => path.trim())
        .filter((path) => {
          if (!path) return false;
          const key = path.toLocaleLowerCase();
          if (seenPaths.has(key)) {
            duplicateCount += 1;
            return false;
          }
          seenPaths.add(key);
          return true;
        });
      if (!uniquePaths.length) return;
      const vaultPaths = uniquePaths.filter((path) => path.toLocaleLowerCase().endsWith(".giftvault"));
      const spreadsheetPaths = uniquePaths.filter((path) => !path.toLocaleLowerCase().endsWith(".giftvault"));
      const dropMessages: string[] = [];
      if (duplicateCount > 0) dropMessages.push(`已忽略 ${duplicateCount} 个重复路径`);
      const unsupportedCount = spreadsheetPaths.filter((path) => !isSupportedSpreadsheetPath(path)).length;
      if (unsupportedCount > 0) dropMessages.push(`${unsupportedCount} 个非标准表格路径会在预览中标记为不支持`);
      if (vaultPaths.length > 0) {
        void api.openVault(vaultPaths[0]).then((result) => {
          if (!mounted) return;
          if (vault && vault.path !== result.vault.path) client.clear();
          rememberOpenedVault(result.vault);
          setOpenedVaults((current) => {
            const key = vaultPathKey(result.vault.path);
            const existing = current.find((item) => vaultPathKey(item.vault.path) === key);
            return existing
              ? current.map((item) => vaultPathKey(item.vault.path) === key ? { ...item, vault: result.vault } : item)
              : [...current, { vault: result.vault, activeBookId: null, activeTab: "entries" }];
          });
          setVault(result.vault);
          setWorkspaceOpen(true);
           setSession((current) => ({ ...current, role: result.role, editLocked: result.role === "admin" ? current.editLocked : true }));
        }).catch((errorValue) => setError(String(errorValue)));
      }
      if (spreadsheetPaths.length > 0) {
        setPendingSpreadsheetPaths((current) => [...new Set([...current, ...spreadsheetPaths])]);
        dropMessages.push(vault ? `已加入 ${spreadsheetPaths.length} 个表格文件，请在导入面板中确认` : `已暂存 ${spreadsheetPaths.length} 个表格文件，打开礼金库后继续`);
      }
      if (dropMessages.length > 0) {
        setNotice(dropMessages.join("；"));
        window.setTimeout(() => setNotice(null), 3600);
      }
    }).then((cleanup) => {
      if (mounted) unlisten = cleanup;
      else cleanup();
    }).catch(() => {
      // Browser previews and older Tauri runtimes may not expose drag events.
    });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [client, vault]);

  useEffect(() => {
    const isWorkspace = workspaceOpen || Boolean(vault);
    const target = isWorkspace ? WORKSPACE_WINDOW : WELCOME_WINDOW;
    const resizeWindow = async () => {
      try {
        const windowHandle = getCurrentWindow();
        await windowHandle.setDecorations(isWorkspace);
        await windowHandle.setResizable(isWorkspace);
        await windowHandle.setSize(new LogicalSize(target.width, target.height));
        await windowHandle.setSizeConstraints({ minWidth: target.minWidth, minHeight: target.minHeight });
        await windowHandle.center();
        await windowHandle.show();
        await windowHandle.setFocus();
      } catch (resizeError) {
        // The Vite browser preview has no Tauri window; keep the desktop failure observable.
        console.error("Unable to resize the desktop window", resizeError);
      }
    };
    void resizeWindow();
  }, [workspaceOpen || Boolean(vault)]);

  const rememberOpenedVault = useCallback((info: VaultInfo, book?: Pick<GiftBook, "id" | "title">) => {
    setRecentVaults(rememberRecentVault(info, book));
  }, []);
  const handleVaultUpdated = useCallback((updated: VaultInfo) => {
    setVault(updated);
    setOpenedVaults((current) => current.map((item) => vaultPathKey(item.vault.path) === vaultPathKey(updated.path) ? { ...item, vault: updated } : item));
    rememberOpenedVault(updated);
  }, [rememberOpenedVault]);
  const handleVaultActivity = useCallback((book?: Pick<GiftBook, "id" | "title">) => {
    if (vault) rememberOpenedVault(vault, book);
  }, [vault, rememberOpenedVault]);
  const handleBookSelectionChange = useCallback((bookId: string | null) => {
    if (!vault) return;
    setBookSelections((current) => ({ ...current, [vaultPathKey(vault.path)]: bookId }));
    setOpenedVaults((current) => current.map((item) => vaultPathKey(item.vault.path) === vaultPathKey(vault.path) ? { ...item, activeBookId: bookId } : item));
  }, [vault]);
  const handleTabChange = useCallback((tab: Tab) => {
    setWorkspaceTab(tab);
    setOpenedVaults((current) => current.map((item) => ({ ...item, activeTab: tab })));
  }, []);

  const showNotice = (message: string) => {
    if (noticeTimeoutRef.current !== null) window.clearTimeout(noticeTimeoutRef.current);
    setNotice(message);
    setOperationHint(null);
    noticeTimeoutRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimeoutRef.current = null;
    }, 5200);
  };

  const applyOpenResult = (result: Awaited<ReturnType<typeof api.openVault>>, bookId: string | null = null, tab: Tab | null = null) => {
    if (vault && vault.path !== result.vault.path) client.clear();
    const key = vaultPathKey(result.vault.path);
    const existingSession = openedVaults.find((item) => vaultPathKey(item.vault.path) === key);
    const selectedBookId = bookId ?? bookSelections[key] ?? existingSession?.activeBookId ?? null;
    const selectedTab = tab ?? existingSession?.activeTab ?? workspaceTab;
    setError(null);
    setPendingWorkspaceBookId(selectedBookId);
    setBookSelections((current) => ({ ...current, [key]: selectedBookId }));
    setOpenedVaults((current) => {
      const existing = current.find((item) => vaultPathKey(item.vault.path) === key);
      return existing
        ? current.map((item) => vaultPathKey(item.vault.path) === key ? { ...item, vault: result.vault, activeBookId: selectedBookId, activeTab: selectedTab } : item)
        : [...current, { vault: result.vault, activeBookId: selectedBookId, activeTab: selectedTab }];
    });
    rememberOpenedVault(result.vault);
    setVault(result.vault);
    setWorkspaceOpen(true);
    setWorkspaceTab(selectedTab);
    setSession((current) => ({ ...current, role: result.role, editLocked: result.role === "admin" ? current.editLocked : true }));
  };

  const restoreOpenedVaultSessions = async (savedSessions: readonly OpenedVaultSessionState[], preferredPath?: string) => {
    const opened: Array<{ saved: OpenedVaultSessionState; result: Awaited<ReturnType<typeof api.openVault>> }> = [];
    let firstError: string | null = null;
    for (const saved of savedSessions) {
      try {
        opened.push({ saved, result: await api.openVault(saved.path) });
      } catch (errorValue) {
        firstError ??= String(errorValue).replace(/^Error:\s*/, "");
      }
    }
    if (!opened.length) {
      if (firstError) setError(`无法恢复上次打开的礼金库：${firstError}`);
      return false;
    }
    const preferredKey = preferredPath ? vaultPathKey(preferredPath) : null;
    const active = opened.find(({ result }) => preferredKey && vaultPathKey(result.vault.path) === preferredKey) ?? opened[0];
    await api.openVault(active.result.vault.path);
    client.clear();
    setOpenedVaults(opened.map(({ saved, result }) => ({ vault: result.vault, activeBookId: saved.activeBookId, activeTab: "entries" })));
    setBookSelections(Object.fromEntries(opened.map(({ saved, result }) => [vaultPathKey(result.vault.path), saved.activeBookId])));
    setPendingWorkspaceBookId(active.saved.activeBookId);
    setVault(active.result.vault);
    setWorkspaceOpen(true);
    setWorkspaceTab("entries");
    setSession((current) => ({ ...current, role: active.result.role, editLocked: active.result.role === "admin" ? current.editLocked : true }));
    return true;
  };

  const openWorkspace = async (preferredVault?: RecentVault) => {
    const savedSessions = readOpenedVaultSessions();
    if (savedSessions.length && await restoreOpenedVaultSessions(savedSessions, preferredVault?.path)) return;
    const opened = preferredVault
      ? await openRecentVault(preferredVault, api.openVault)
      : await openRecentVaults(recentVaults, api.openVault);
    const launchTarget = resolveWorkspaceLaunchTarget(opened.status);
    if (launchTarget === "workspace-start") {
      setPendingWorkspaceBookId(null);
      setWorkspaceOpen(true);
      return;
    }
    if (launchTarget === "start-page" && opened.status === "failed") {
      setPendingWorkspaceBookId(null);
      setWorkspaceOpen(false);
      setError(`无法打开最近使用的礼金库「${opened.recent.name}」：${opened.error}`);
      return;
    }
    if (launchTarget !== "vault" || opened.status !== "opened") return;
    applyOpenResult(opened.result, opened.bookId);
  };

  const openVault = async () => {
    setError(null);
    try {
      const path = await api.chooseVaultPath("open");
      if (path) {
        applyOpenResult(await api.openVault(path));
      }
    } catch (err) {
      setError(String(err));
    }
  };

  const switchVault = async (path: string) => {
    if (vault && vaultPathKey(vault.path) === vaultPathKey(path)) return;
    setError(null);
    try {
      const sessionForPath = openedVaults.find((item) => vaultPathKey(item.vault.path) === vaultPathKey(path));
      applyOpenResult(await api.openVault(path), sessionForPath?.activeBookId ?? bookSelections[vaultPathKey(path)] ?? null, sessionForPath?.activeTab ?? null);
    } catch (err) {
      setError(String(err));
    }
  };

  const openSearchVault = async (path: string, bookId: string) => {
    const sessionForPath = openedVaults.find((item) => vaultPathKey(item.vault.path) === vaultPathKey(path));
    applyOpenResult(await api.openVault(path), bookId, sessionForPath?.activeTab ?? "entries");
  };

  const createVault = async () => {
    setError(null);
    try {
      const path = await api.chooseVaultPath("save");
      if (path) {
        const result = await api.createVault(path, vaultName.trim() || "我的家庭礼金库", vaultNotes.trim());
        applyOpenResult(result);
        setCreateVaultOpen(false);
        setVaultNotes("");
      }
    } catch (err) {
      setError(String(err));
    }
  };

  const chooseSpreadsheetPathsForWorkspace = async () => {
    try {
      const paths = uniquePaths(await api.chooseSpreadsheetPaths());
      if (!paths.length) return;
      setPendingSpreadsheetPaths((current) => uniquePaths([...current, ...paths]));
      showNotice(`已暂存 ${paths.length} 个表格文件，打开或新建礼金库后继续导入`);
    } catch (err) {
      setError(String(err));
    }
  };

  const returnToStartPage = async () => {
    try {
      await api.returnToStartPage();
      await api.lockAdmin();
      setSession(await api.sessionStatus());
      setVault(null);
      setOpenedVaults([]);
      setBookSelections({});
      setWorkspaceOpen(false);
      setCreateVaultOpen(false);
      setPendingWorkspaceVault(null);
      setPendingWorkspaceBookId(null);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const unlockAdmin = async (pin: string) => {
    try {
      if (adminPrompt === "setup") {
        setRecoveryCode(await api.setupAppAdminPin(pin));
      } else {
        await api.unlockAdmin(pin);
      }
      setSession(await api.sessionStatus());
      setAdminPrompt(null);
      if (enterWorkspaceAfterAdmin || adminPrompt === "setup") {
        const selectedVault = pendingWorkspaceVault ?? undefined;
        setEnterWorkspaceAfterAdmin(false);
        setPendingWorkspaceVault(null);
        await openWorkspace(selectedVault);
      }
    } catch (err) {
      setError(String(err));
    }
  };

  const lockAdmin = async () => {
    try {
      await api.lockAdmin();
      setSession(await api.sessionStatus());
    } catch (err) {
      setError(String(err));
    }
  };

  const unlockEditing = async () => {
    try {
      await api.unlockEditing();
      setSession(await api.sessionStatus());
    } catch (err) {
      setError(String(err));
    }
  };

  const lockEditing = async () => {
    try {
      await api.lockEditing();
      setSession(await api.sessionStatus());
    } catch (err) {
      setError(String(err));
    }
  };

  const resetAdminPin = async (recovery: string, newPin: string) => {
    try {
      const selectedVault = pendingWorkspaceVault ?? undefined;
      setRecoveryCode(await api.resetAppPinWithRecovery(recovery, newPin));
      setSession(await api.sessionStatus());
      setAdminPrompt(null);
      setEnterWorkspaceAfterAdmin(false);
      setPendingWorkspaceVault(null);
      if (!workspaceOpen) await openWorkspace(selectedVault);
      showNotice("管理员 PIN 已重新设置");
    } catch (err) {
      setError(String(err));
    }
  };

  const changeAdminPin = async (oldPin: string, newPin: string) => {
    try {
      setRecoveryCode(await api.changeAppAdminPin(oldPin, newPin));
      setPinChangeOpen(false);
      setSession(await api.sessionStatus());
      showNotice("管理员 PIN 已修改");
    } catch (err) {
      setError(String(err));
    }
  };

  const enterUserMode = async (preferredVault?: RecentVault) => {
    try {
      if (!session.securityConfigured) {
        setPendingWorkspaceVault(preferredVault ?? null);
        setEnterWorkspaceAfterAdmin(true);
        setAdminPrompt("setup");
        return;
      }
      await api.lockAdmin();
      setSession(await api.sessionStatus());
      setError(null);
      await openWorkspace(preferredVault);
    } catch (err) {
      setError(String(err));
    }
  };

  const enterAdminMode = (preferredVault?: RecentVault) => {
    setError(null);
    if (session.role === "admin") {
      void openWorkspace(preferredVault);
      return;
    }
    setPendingWorkspaceVault(preferredVault ?? null);
    setEnterWorkspaceAfterAdmin(true);
    setAdminPrompt(session.securityConfigured ? "unlock" : "setup");
  };

  const checkLocalUpdate = async () => {
    if (localUpdatePhase !== "idle") return;
    setError(null);
    setLocalUpdatePhase("checking");
    showNotice("正在检测有无可用更新");
    let updateStarted = false;
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 360));
      const result = await localUpdate.refetch({ throwOnError: true });
      setLastUpdateCheckAt(new Date().toISOString());
      if (!result.data?.candidate) {
        if (result.data?.error) throw new Error(result.data.error);
        showNotice(result.data?.source === "github" ? "未发现更高版本：已检查本地发布目录和 GitHub Releases" : "未发现更高版本");
        return;
      }
      showNotice(`发现 v${result.data.candidate.version} 可用更新，请在“关于”页面确认安装`);
    } catch (err) {
      setError(String(err));
    } finally {
      if (!updateStarted) setLocalUpdatePhase("idle");
    }
  };

  const installLocalUpdate = async () => {
    const candidate = localUpdate.data?.candidate;
    if (!candidate || localUpdatePhase !== "idle") return;
    const confirmed = window.confirm(`确认下载并安装礼金簿管理 v${candidate.version}？\n\n程序将关闭当前窗口，使用正式安装包覆盖更新并自动重启。`);
    if (!confirmed) return;
    setError(null);
    setLocalUpdatePhase("installing");
    try {
      await api.startLocalUpdate();
    } catch (err) {
      setError(String(err));
      setLocalUpdatePhase("idle");
    }
  };

  const overlays = <>
    {dragActive && <DropOverlay />}
    {adminPrompt === "recover" && <RecoveryResetModal onClose={() => setAdminPrompt(null)} onSubmit={resetAdminPin} />}
    {(adminPrompt === "unlock" || adminPrompt === "setup") && <PinModal mode={adminPrompt} onClose={() => { if (adminPrompt !== "setup") { setAdminPrompt(null); setEnterWorkspaceAfterAdmin(false); setPendingWorkspaceVault(null); } }} onSubmit={unlockAdmin} onRecover={() => setAdminPrompt("recover")} />}
    {pinChangeOpen && <PinChangeModal onClose={() => setPinChangeOpen(false)} onSubmit={changeAdminPin} />}
    {recoveryCode && <RecoveryCodeModal code={recoveryCode} onClose={() => setRecoveryCode(null)} />}
    {error && <ErrorToast message={error} onClose={() => setError(null)} />}
    {notice && <SuccessToast message={notice} className={!workspaceOpen && !vault ? "welcome-update-notice" : undefined} />}
    {!notice && operationHint && <OperationHintToast message={operationHint} />}
  </>;

  if (!workspaceOpen && !vault) {
    return <>
      <WelcomeScreen recentVaults={recentVaults} session={session} noticeVisible={Boolean(notice)} onUserMode={(recent) => void enterUserMode(recent)} onAdminMode={enterAdminMode} onRemoveRecent={(recent) => { setRecentVaults(forgetRecentVault(recent)); showNotice(`已从启动页移除「${recent.name}」的记录；礼金库和礼金数据未删除`); }} onCheckLocalUpdate={checkLocalUpdate} localUpdatePhase={localUpdatePhase} />
      {overlays}
    </>;
  }

  if (!vault) {
    return <>
      <WorkspaceStart session={session} pendingSpreadsheetPaths={pendingSpreadsheetPaths} onClose={returnToStartPage} onOpenVault={openVault} onBeginCreate={() => setCreateVaultOpen(true)} onChooseImport={() => void chooseSpreadsheetPathsForWorkspace()} onChangePin={() => setPinChangeOpen(true)} />
      {createVaultOpen && <CreateVaultModal vaultName={vaultName} vaultNotes={vaultNotes} onNameChange={setVaultName} onNotesChange={setVaultNotes} onClose={() => setCreateVaultOpen(false)} onCreate={createVault} />}
      {overlays}
    </>;
  }

  return <>
    <VaultWorkspace key={vault.path} vault={vault} openedVaults={openedVaults} initialBookId={pendingWorkspaceBookId} initialTab={workspaceTab} session={session} continuousRegistration={continuousRegistration} onContinuousRegistrationChange={setContinuousRegistration} onClose={returnToStartPage} onError={setError} onNotice={showNotice} onUnlock={() => { setEnterWorkspaceAfterAdmin(false); setPendingWorkspaceVault(null); setAdminPrompt(session.securityConfigured ? "unlock" : "setup"); }} onLock={lockAdmin} onUnlockEditing={unlockEditing} onLockEditing={lockEditing} onChangePin={() => setPinChangeOpen(true)} onCheckLocalUpdate={checkLocalUpdate} onInstallLocalUpdate={installLocalUpdate} localUpdatePhase={localUpdatePhase} updateStatus={localUpdate.data ?? null} lastUpdateCheckAt={lastUpdateCheckAt} pendingSpreadsheetPaths={pendingSpreadsheetPaths} onConsumeSpreadsheetPaths={() => setPendingSpreadsheetPaths([])} onBeginCreateVault={() => setCreateVaultOpen(true)} onOpenVault={openVault} onSwitchVault={switchVault} onOpenSearchVault={openSearchVault} onBookSelectionChange={handleBookSelectionChange} onTabChange={handleTabChange} onVaultActivity={handleVaultActivity} onVaultUpdated={handleVaultUpdated} />
    {createVaultOpen && <CreateVaultModal vaultName={vaultName} vaultNotes={vaultNotes} onNameChange={setVaultName} onNotesChange={setVaultNotes} onClose={() => setCreateVaultOpen(false)} onCreate={createVault} />}
    {overlays}
  </>;
}

function DropOverlay() {
  return <div className="drop-overlay"><div className="drop-overlay-content"><FileSpreadsheet size={28} /><strong>松开以导入文件</strong><span>支持 Excel、CSV、TSV 和礼金库文件</span></div></div>;
}

function VersionBadge() {
  return <span className="version-badge">v{__APP_VERSION__}</span>;
}

function BookMetadata({ book, vaultPath }: { book: GiftBook; vaultPath: string }) {
  const activity = [book.occasion, book.eventDate, book.location].filter(Boolean).join(" · ");
  const imported = Boolean(book.sourceFilePath || book.sourceImportedAt);
  return <>
    {activity && <p>{activity}</p>}
    <div className="book-source-box">
      <span className="book-source-time">{imported ? "导入时间" : "创建时间"}：{new Date(imported ? book.sourceImportedAt! : book.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
      <span className="book-source-path" title={imported ? book.sourceFilePath ?? "" : vaultPath}>{imported ? "原表格路径" : "礼金库路径"}：{imported ? book.sourceFilePath ?? "未记录" : vaultPath}</span>
    </div>
  </>;
}

function isRestorableAuditRecord(record: AuditLog) {
  if (record.action === "delete" || record.action === "restore") return ["person", "gift_entry", "gift_book"].includes(record.entityType);
  return record.action === "update"
    && ["person", "gift_entry", "return_gift", "vault", "gift_book"].includes(record.entityType)
    && record.changes.length > 0;
}

function historyTargets(records: AuditLog[]) {
  const targets = [...new Set(records.map((record) => record.target))].filter(Boolean);
  if (!targets.length) return "所选改动";
  const visible = targets.slice(0, 3).join("、");
  return targets.length > 3 ? `${visible} 等 ${targets.length} 项` : visible;
}

function closeWelcomeWindow() {
  void api.exitApp().catch(() => {
    void getCurrentWindow().destroy().catch(() => window.close());
  });
}

function WelcomeScreen(props: { recentVaults: RecentVault[]; session: SessionStatus; noticeVisible: boolean; onUserMode: (recent?: RecentVault) => void; onAdminMode: (recent?: RecentVault) => void; onRemoveRecent: (recent: RecentVault) => void; onCheckLocalUpdate: () => void; localUpdatePhase: LocalUpdatePhase }) {
  const recentListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    recentListRef.current?.scrollTo(0, 0);
  }, [props.recentVaults.length]);
  return (
    <main className="welcome-shell">
      <section className={`welcome-panel ${props.noticeVisible ? "notice-visible" : ""}`} onMouseDown={startWelcomeDrag}>
        <div className="welcome-drag-handle" data-tauri-drag-region aria-hidden="true" />
        <button className="icon-button subtle welcome-close" type="button" title="退出程序" aria-label="退出程序" onClick={closeWelcomeWindow}><X size={16} /></button>
        <div className="brand-lockup" data-tauri-drag-region>
          <div className="brand-mark"><BookOpen size={22} /></div>
          <div><h1>礼金簿管理</h1></div>
        </div>
        <p className="welcome-copy">记录、查询和比较每一笔礼金往来。</p>
        <div className="welcome-actions">
          <button className="primary-button" onClick={() => props.onUserMode()}><BookOpen size={17} />用户模式</button>
          <button className="secondary-button" onClick={() => props.onAdminMode()}><ShieldCheck size={17} />管理员模式</button>
        </div>
        {props.recentVaults.length > 0 && <section className="recent-vaults welcome-recent"><div className="recent-heading"><span>最近使用</span></div><div className="recent-vault-list" ref={recentListRef}>{props.recentVaults.map((recent) => <article className="recent-vault-item" key={recentVaultIdentity(recent)}><button className="recent-vault-button" type="button" title={`以用户模式打开「${recent.name}」`} onClick={() => props.onUserMode(recent)}><FolderOpen size={17} /><span><strong>{recent.name}</strong><small title={recent.path}>{recent.path}</small></span></button><button className={`icon-button subtle recent-vault-action recent-vault-admin ${props.session.role === "admin" ? "active" : ""}`} type="button" title={`以管理员模式打开「${recent.name}」`} aria-label={`以管理员模式打开「${recent.name}」`} onClick={() => props.onAdminMode(recent)}><ShieldCheck size={16} /></button><button className="icon-button subtle recent-vault-action recent-vault-remove" type="button" title={`从启动页移除「${recent.name}」；不会删除礼金库或礼金数据`} aria-label={`从启动页移除「${recent.name}」；不会删除礼金库或礼金数据`} onClick={() => props.onRemoveRecent(recent)}><X size={16} /></button></article>)}</div></section>}
        <button className="text-button welcome-update" disabled={props.localUpdatePhase !== "idle"} onClick={props.onCheckLocalUpdate}><RefreshCw className={props.localUpdatePhase !== "idle" ? "is-spinning" : undefined} size={15} />{props.localUpdatePhase === "checking" ? "正在检测有无可用更新…" : props.localUpdatePhase === "installing" ? "正在安装新版本…" : "检查更新"}</button>
        <VersionBadge />
      </section>
    </main>
  );
}

function WorkspaceStart({ session, pendingSpreadsheetPaths, onClose, onOpenVault, onBeginCreate, onChooseImport, onChangePin }: { session: SessionStatus; pendingSpreadsheetPaths: string[]; onClose: () => void; onOpenVault: () => void; onBeginCreate: () => void; onChooseImport: () => void; onChangePin: () => void }) {
  const isAdmin = session.role === "admin";
  return <div className="app-shell workspace-start"><header className="topbar"><div className="topbar-brand"><div className="brand-mark small"><BookOpen size={17} /></div><strong>礼金簿管理</strong><span className="slash">/</span><span className="vault-label">未打开礼金库</span></div><div className="topbar-actions"><span className={`role-badge ${isAdmin ? "admin" : "viewer"}`}>{isAdmin ? "管理员模式" : "用户模式"}</span>{isAdmin && <button className="secondary-button compact" title="修改管理员 PIN" onClick={onChangePin}><KeyRound size={14} />修改 PIN</button>}<button className="secondary-button compact return-start-button" title="返回启动页" onClick={onClose}><ArrowLeft size={15} />返回启动页</button></div></header><div className="workspace"><aside className="sidebar"><div className="sidebar-heading"><span>礼金簿管理</span></div>{isAdmin && <button className="sidebar-create" onClick={onBeginCreate}><CirclePlus size={16} />新建礼金库</button>}<button className="sidebar-create sidebar-open" onClick={onOpenVault}><FolderOpen size={16} />打开礼金库</button>{isAdmin && <button className="sidebar-create sidebar-import" onClick={onChooseImport}><FileSpreadsheet size={15} />导入表格</button>}<div className="sidebar-bottom"><VersionBadge /></div></aside><main className="content-area"><section className="workspace-empty"><BookOpen size={30} /><h2>尚未打开礼金库</h2><div className="workspace-empty-actions"><button className="primary-button" onClick={onOpenVault}><FolderOpen size={16} />打开礼金库</button>{isAdmin && <button className="secondary-button" onClick={onBeginCreate}><CirclePlus size={16} />新建礼金库</button>}</div>{isAdmin && pendingSpreadsheetPaths.length > 0 && <span className="field-hint">已暂存 {pendingSpreadsheetPaths.length} 个表格文件。</span>}</section></main></div></div>;
}

function CreateVaultModal({ vaultName, vaultNotes, onNameChange, onNotesChange, onClose, onCreate }: { vaultName: string; vaultNotes: string; onNameChange: (value: string) => void; onNotesChange: (value: string) => void; onClose: () => void; onCreate: () => void }) {
  return <Modal title="新建家庭礼金库" onClose={onClose}><label>礼金库名称<input value={vaultName} onChange={(event) => onNameChange(event.target.value)} autoFocus /></label><label>礼金库备注<textarea value={vaultNotes} onChange={(event) => onNotesChange(event.target.value)} placeholder="可选，例如家庭成员或使用范围" /></label><p className="field-hint">礼金库创建后会直接进入工作页。</p><div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!vaultName.trim()} onClick={onCreate}>选择保存位置</button></div></Modal>;
}

function VaultMetadataModal({ vault, isSaving, onClose, onSubmit }: { vault: VaultInfo; isSaving: boolean; onClose: () => void; onSubmit: (name: string, notes: string) => void }) {
  const [name, setName] = useState(vault.name);
  const [notes, setNotes] = useState(vault.notes ?? "");
  return <Modal title="编辑礼金库" onClose={onClose}><label>礼金库名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label><label>礼金库备注<textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="可选" /></label><p className="field-hint">只修改礼金库自身信息，不会改变内部礼金簿、人物或礼金记录的归属。</p><div className="modal-actions"><button className="secondary-button" disabled={isSaving} onClick={onClose}>取消</button><button className="primary-button" disabled={!name.trim() || isSaving} onClick={() => onSubmit(name.trim(), notes.trim())}>{isSaving ? "保存中…" : "保存修改"}</button></div></Modal>;
}

function VaultWorkspace({ vault, openedVaults, initialBookId, initialTab, session, continuousRegistration, onContinuousRegistrationChange, onClose, onError, onNotice, onUnlock, onLock, onUnlockEditing, onLockEditing, onChangePin, onCheckLocalUpdate, onInstallLocalUpdate, localUpdatePhase, updateStatus, lastUpdateCheckAt, pendingSpreadsheetPaths, onConsumeSpreadsheetPaths, onBeginCreateVault, onOpenVault, onSwitchVault, onOpenSearchVault, onBookSelectionChange, onTabChange, onVaultActivity, onVaultUpdated }: { vault: VaultInfo; openedVaults: OpenedVaultSession[]; initialBookId: string | null; initialTab: Tab; session: SessionStatus; continuousRegistration: boolean; onContinuousRegistrationChange: (enabled: boolean) => void; onClose: () => void; onError: (message: string) => void; onNotice: (message: string) => void; onUnlock: () => void; onLock: () => void; onUnlockEditing: () => void; onLockEditing: () => void; onChangePin: () => void; onCheckLocalUpdate: () => void; onInstallLocalUpdate: () => void; localUpdatePhase: LocalUpdatePhase; updateStatus: import("./types").LocalUpdateStatus | null; lastUpdateCheckAt: string | null; pendingSpreadsheetPaths: string[]; onConsumeSpreadsheetPaths: () => void; onBeginCreateVault: () => void; onOpenVault: () => void; onSwitchVault: (path: string) => void; onOpenSearchVault: (path: string, bookId: string) => Promise<void>; onBookSelectionChange: (bookId: string | null) => void; onTabChange: (tab: Tab) => void; onVaultActivity: (book?: Pick<GiftBook, "id" | "title">) => void; onVaultUpdated: (vault: VaultInfo) => void }) {
  const client = useQueryClient();
  const [activeBookId, setActiveBookId] = useState<string | null>(initialBookId);
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [bookModal, setBookModal] = useState(false);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const fileInfoWrapRef = useRef<HTMLDivElement>(null);
  const [fileInfoOpen, setFileInfoOpen] = useState(false);
  const [deleteBookOpen, setDeleteBookOpen] = useState(false);
  const [focusedEntryId, setFocusedEntryId] = useState<string | null>(null);
  const [spreadsheetPaths, setSpreadsheetPaths] = useState<string[]>([]);
  const [spreadsheetImportOpen, setSpreadsheetImportOpen] = useState(false);
  const [spreadsheetImporting, setSpreadsheetImporting] = useState(false);
  const [vaultEditOpen, setVaultEditOpen] = useState(false);
  const [vaultEditSaving, setVaultEditSaving] = useState(false);
  const [bookEditOpen, setBookEditOpen] = useState(false);
  const [bookEditSaving, setBookEditSaving] = useState(false);
  const [trashDropActive, setTrashDropActive] = useState(false);
  const [bookOrder, setBookOrder] = useState<string[]>(() => readGiftBookOrder(vault.path));
  const [draggedBookId, setDraggedBookId] = useState<string | null>(null);
  const draggedBookIdRef = useRef<string | null>(null);
  const bookDragTimerRef = useRef<number | null>(null);
  const bookDragPointerRef = useRef<number | null>(null);
  const bookDropTargetRef = useRef<string | null>(null);
  const [bookDropTargetId, setBookDropTargetId] = useState<string | null>(null);
  const suppressBookClickRef = useRef(false);
  const debouncedSearch = useDebouncedValue(search, 200);
  const isAdmin = session.role === "admin";
  const canEdit = isAdmin && !session.editLocked;
  const activityRef = useRef<() => void>(() => {});

  const openSpreadsheetImport = (paths: string[]) => {
    const normalizedPaths = uniquePaths(paths);
    const vaultPaths = normalizedPaths.filter((path) => path.toLocaleLowerCase().endsWith(".giftvault"));
    const accepted = normalizedPaths.filter((path) => !path.toLocaleLowerCase().endsWith(".giftvault"));
    if (vaultPaths.length) onNotice(`已跳过 ${vaultPaths.length} 个礼金库文件，请使用“打开礼金库”切换礼金库`);
    if (!accepted.length) return;
    setSpreadsheetPaths(accepted);
    setSpreadsheetImportOpen(true);
  };

  useEffect(() => {
    if (pendingSpreadsheetPaths.length > 0 && isAdmin && !spreadsheetImportOpen) {
      openSpreadsheetImport(pendingSpreadsheetPaths);
      onConsumeSpreadsheetPaths();
    }
  }, [pendingSpreadsheetPaths, isAdmin, spreadsheetImportOpen, onConsumeSpreadsheetPaths]);

  const openedSearchPaths = useMemo(() => openedVaults.map((item) => item.vault.path), [openedVaults]);
  const openedSearchKey = openedSearchPaths.map(vaultPathKey).sort().join("|");
  const books = useQuery({ queryKey: ["books", vault.path], queryFn: api.listBooks });
  const orderedBooks = useMemo(() => orderGiftBooks(books.data ?? [], bookOrder), [books.data, bookOrder]);
  const searchResults = useQuery({ queryKey: ["vault-search", openedSearchKey, debouncedSearch], queryFn: () => api.searchVault(debouncedSearch, openedSearchPaths), enabled: searchOpen && Boolean(debouncedSearch.trim()) });
  useEffect(() => {
    if (!books.data) return;
    const nextBookId = resolveInitialBookId(activeBookId, books.data);
    if (nextBookId !== activeBookId) setActiveBookId(nextBookId);
  }, [activeBookId, books.data]);
  useEffect(() => {
    setBookOrder(readGiftBookOrder(vault.path));
  }, [vault.path]);
  useEffect(() => {
    onBookSelectionChange(activeBookId);
  }, [activeBookId, onBookSelectionChange]);
  useEffect(() => {
    onTabChange(activeTab);
  }, [activeTab, onTabChange]);
  useEffect(() => {
    document.getElementById("vault-global-search")?.setAttribute("autocomplete", "off");
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.getElementById("vault-global-search")?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  useEffect(() => {
    const closeSearchOnOutsidePointer = (event: PointerEvent) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(event.target as Node)) setSearchOpen(false);
      if (fileInfoWrapRef.current && !fileInfoWrapRef.current.contains(event.target as Node)) setFileInfoOpen(false);
    };
    const closeSearchOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setSearchOpen(false); setFileInfoOpen(false); }
    };
    document.addEventListener("pointerdown", closeSearchOnOutsidePointer);
    window.addEventListener("keydown", closeSearchOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeSearchOnOutsidePointer);
      window.removeEventListener("keydown", closeSearchOnEscape);
    };
  }, []);

  const createBook = useMutation({
    mutationFn: api.createBook,
    onSuccess: (book) => { client.invalidateQueries({ queryKey: ["books"] }); setActiveBookId(book.id); setBookModal(false); markVaultActivity(); },
    onError: (err) => onError(String(err)),
  });
  const deleteBook = useMutation({
    mutationFn: ({ bookId, pin }: { bookId: string; pin: string }) => api.deleteBook(bookId, pin),
    onSuccess: (_, input) => { client.invalidateQueries({ queryKey: ["books"] }); client.invalidateQueries({ queryKey: ["trash"] }); if (input.bookId === activeBookId) setActiveBookId(null); markVaultActivity(); },
    onError: (err) => onError(String(err)),
  });
  const activeBook = books.data?.find((book) => book.id === activeBookId) ?? null;
  const markVaultActivity = useCallback(() => {
    onVaultActivity(activeBook ?? undefined);
  }, [activeBook, onVaultActivity]);
  activityRef.current = markVaultActivity;
  useEffect(() => {
    markVaultActivity();
  }, [markVaultActivity]);
  const exportVault = async () => {
    try { const path = await api.exportVault(); onNotice(`已导出完整礼金库：${path}`); } catch (err) { onError(String(err)); }
  };
  const editVault = async (name: string, notes: string) => {
    setVaultEditSaving(true);
    try {
      const updated = await api.editVault(name, notes);
      onVaultUpdated(updated);
      setVaultEditOpen(false);
      onNotice("礼金库信息已更新");
    } catch (err) {
      onError(String(err));
    } finally {
      setVaultEditSaving(false);
    }
  };
  const editBook = async (input: { title: string; occasion: string; eventDate: string; location: string; notes: string }) => {
    if (!activeBook) return;
    setBookEditSaving(true);
    try {
      await api.editBook(activeBook.id, input);
      await client.invalidateQueries({ queryKey: ["books", vault.path] });
      setBookEditOpen(false);
      markVaultActivity();
      onNotice("礼金簿信息已更新");
    } catch (err) {
      onError(String(err));
    } finally {
      setBookEditSaving(false);
    }
  };
  const openSearchHit = async (hit: SearchHit) => {
    setSearch("");
    setSearchOpen(false);
    if (vaultPathKey(hit.vaultPath) !== vaultPathKey(vault.path)) {
      try {
        await onOpenSearchVault(hit.vaultPath, hit.entry.bookId);
      } catch (err) {
        onError(String(err));
      }
      return;
    }
    setActiveBookId(hit.entry.bookId);
    setActiveTab("entries");
    setFocusedEntryId(hit.entry.id);
    markVaultActivity();
  };

  const dropToTrash = async (event: React.DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setTrashDropActive(false);
    if (!canEdit) {
      onError("编辑已锁定，请先解锁编辑后再删除");
      return;
    }
    const kind = event.dataTransfer.getData("application/x-lijin-trash-kind") as "entry" | "person" | "tag";
    const id = event.dataTransfer.getData("application/x-lijin-trash-id");
    if (!id || !["entry", "person", "tag"].includes(kind)) return;
    try {
      if (kind === "entry") await api.deleteEntry(id);
      if (kind === "person") await api.deletePerson(id);
      if (kind === "tag") await api.deleteTag(id);
      await client.invalidateQueries();
      onVaultActivity();
      onNotice("已移入回收站，可在回收站中恢复");
    } catch (err) {
      onError(String(err));
    }
  };
  const clearBookDrag = () => {
    if (bookDragTimerRef.current !== null) window.clearTimeout(bookDragTimerRef.current);
    bookDragTimerRef.current = null;
    bookDragPointerRef.current = null;
    bookDropTargetRef.current = null;
    draggedBookIdRef.current = null;
    setDraggedBookId(null);
    setBookDropTargetId(null);
  };
  const startBookDrag = (event: React.PointerEvent<HTMLButtonElement>, bookId: string) => {
    if (event.button !== 0) return;
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    bookDragPointerRef.current = pointerId;
    if (bookDragTimerRef.current !== null) window.clearTimeout(bookDragTimerRef.current);
    bookDragTimerRef.current = window.setTimeout(() => {
      if (bookDragPointerRef.current !== pointerId) return;
      draggedBookIdRef.current = bookId;
      bookDropTargetRef.current = bookId;
      setDraggedBookId(bookId);
      setBookDropTargetId(bookId);
      target.setPointerCapture?.(pointerId);
    }, 350);
  };
  const moveBookDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!draggedBookIdRef.current) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-book-id]");
    const targetId = target?.dataset.bookId ?? null;
    if (!targetId) return;
    bookDropTargetRef.current = targetId;
    setBookDropTargetId(targetId);
  };
  const finishBookDrag = () => {
    if (bookDragTimerRef.current !== null) window.clearTimeout(bookDragTimerRef.current);
    bookDragTimerRef.current = null;
    const draggedId = draggedBookIdRef.current;
    const targetId = bookDropTargetRef.current;
    if (draggedId && targetId && draggedId !== targetId) {
      const nextOrder = orderedBooks.map((book) => book.id);
      const from = nextOrder.indexOf(draggedId);
      const to = nextOrder.indexOf(targetId);
      if (from >= 0 && to >= 0) {
        nextOrder.splice(from, 1);
        nextOrder.splice(to, 0, draggedId);
        setBookOrder(rememberGiftBookOrder(vault.path, nextOrder));
        suppressBookClickRef.current = true;
        window.setTimeout(() => { suppressBookClickRef.current = false; }, 0);
      }
    }
    clearBookDrag();
  };

  return (
    <div className="app-shell" onPointerDown={() => activityRef.current()} onKeyDown={() => activityRef.current()}>
      <header className="topbar">
        <div className="topbar-brand"><div className="brand-mark small"><BookOpen size={17} /></div><strong>礼金簿管理</strong><span className="slash">/</span><span className="vault-label">{activeBook?.title ?? vault.name}</span></div>
          <div className="topbar-actions"><div className="global-search-wrap" ref={searchWrapRef}><label className="tag-search-field" aria-label="全库搜索"><Search size={16} /><input id="vault-global-search" value={search} onFocus={() => setSearchOpen(true)} onChange={(event) => { const value = event.target.value; setSearch(value); setSearchOpen(Boolean(value.trim())); }} placeholder="搜索姓名、金额、地址、标签等" /></label>{searchOpen && search.trim() && <SearchResults result={searchResults.data} isLoading={searchResults.isLoading} isError={searchResults.isError} onSelect={openSearchHit} />}</div><div className="file-info-wrap" ref={fileInfoWrapRef}><button className="offline-pill button-reset" onClick={() => setFileInfoOpen((open) => !open)}><span className="status-dot" />{isAdmin ? "管理员模式" : "用户模式"}</button>{fileInfoOpen && <div className="file-info-popover"><strong>{vault.name}</strong>{vault.notes && <span className="file-info-notes">{vault.notes}</span>}<span className="file-path">{vault.path}</span><span className={`role-badge ${isAdmin ? "admin" : "viewer"}`}>{isAdmin ? "管理员模式" : "用户模式"}</span><div className="popover-actions">{isAdmin && <button aria-pressed={continuousRegistration} className={`secondary-button compact continuous-registration-button ${continuousRegistration ? "active" : ""}`} disabled={!canEdit} data-operation-hint={!canEdit ? "提示：请先解锁编辑，再开始持续登记。" : continuousRegistration ? "提示：持续登记已开启，保存后会自动进入下一条；点击可关闭。" : "提示：点击开启持续登记，保存后会自动进入下一条。"} onClick={() => onContinuousRegistrationChange(!continuousRegistration)}>{continuousRegistration ? <Unlock size={14} /> : <LockKeyhole size={14} />}{continuousRegistration ? "持续登记：已开启" : "持续登记：已关闭"}</button>}{isAdmin ? <button className="secondary-button compact" title="切换到用户模式" onClick={onLock}><LockKeyhole size={14} />切换模式</button> : <button className="primary-button compact" onClick={onUnlock}><Unlock size={14} />解锁管理</button>}</div></div>}</div><button className="secondary-button compact return-start-button" title="返回启动页" onClick={onClose}><ArrowLeft size={15} />返回启动页</button></div>
      </header>
      <nav className="opened-vault-tabs" aria-label="已打开礼金库">
        <div className="opened-vault-tabs-list">
          {openedVaults.map((item) => <button type="button" className={`opened-vault-tab ${vaultPathKey(item.vault.path) === vaultPathKey(vault.path) ? "active" : ""}`} key={vaultPathKey(item.vault.path)} title={item.vault.path} aria-pressed={vaultPathKey(item.vault.path) === vaultPathKey(vault.path)} onClick={() => onSwitchVault(item.vault.path)}><Archive size={14} /><span>{item.vault.name}</span></button>)}
        </div>
      </nav>
      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading"><span>礼金簿管理</span></div>
          {isAdmin && <button className="sidebar-create" onClick={onBeginCreateVault}><Archive size={16} />新建礼金库</button>}
          <button className="sidebar-create sidebar-open" onClick={onOpenVault}><FolderOpen size={16} />打开礼金库</button>
          <button className="sidebar-create sidebar-book-create" disabled={!canEdit} title={isAdmin && !canEdit ? "请先解锁编辑" : undefined} onClick={() => setBookModal(true)}><CirclePlus size={16} />新建礼金簿</button>
          <button className="sidebar-create sidebar-import" disabled={!isAdmin || !canEdit} title={isAdmin && !canEdit ? "请先解锁编辑" : undefined} onClick={async () => { if (!isAdmin) { onUnlock(); return; } if (!canEdit) return; try { const paths = await api.chooseSpreadsheetPaths(); if (paths.length) openSpreadsheetImport(paths); } catch (err) { onError(String(err)); } }}><FileSpreadsheet size={15} />导入表格</button>
          <div className="book-list">
            {books.isLoading && <div className="empty-mini">正在读取…</div>}
          {orderedBooks.map((book) => <button className={`book-item ${book.id === activeBookId ? "active" : ""} ${draggedBookId === book.id ? "dragging" : ""} ${bookDropTargetId === book.id && draggedBookId !== book.id ? "drag-target" : ""}`} key={book.id} data-book-id={book.id} onPointerDown={(event) => startBookDrag(event, book.id)} onPointerMove={moveBookDrag} onPointerUp={finishBookDrag} onPointerCancel={clearBookDrag} onClick={() => { if (suppressBookClickRef.current) return; setActiveBookId(book.id); onVaultActivity(); }}><span className="book-icon"><FileSpreadsheet size={15} /></span><span className="book-item-text"><strong>{book.title}</strong></span><ChevronRight size={15} /></button>)}
            {!books.isLoading && books.data?.length === 0 && <div className="empty-mini">还没有礼金簿</div>}
          </div>
          <div className="sidebar-bottom"><button className={`sidebar-link ${activeTab === "settings" ? "active" : ""}`} onClick={() => setActiveTab("settings")}><Settings size={15} />设置</button><button className={`sidebar-link ${activeTab === "returnGifts" ? "active" : ""}`} onClick={() => setActiveTab("returnGifts")}><Gift size={15} />回礼明细</button><button className={`sidebar-link ${activeTab === "history" ? "active" : ""}`} onClick={() => setActiveTab("history")}><History size={15} />历史改动</button><button className={`sidebar-link trash-drop-target ${activeTab === "trash" ? "active" : ""} ${trashDropActive ? "drag-over" : ""}`} onDragOver={(event) => { event.preventDefault(); setTrashDropActive(true); }} onDragLeave={() => setTrashDropActive(false)} onDrop={(event) => void dropToTrash(event)} onClick={() => setActiveTab("trash")}><Trash2 size={15} />回收站</button><VersionBadge /></div>
        </aside>
        <main className="content-area">
          {activeTab === "settings" ? <div className="content-view settings"><SettingsView session={session} onUnlock={onUnlock} onUnlockEditing={onUnlockEditing} onLockEditing={onLockEditing} onChangePin={onChangePin} onCheckUpdate={onCheckLocalUpdate} onInstallUpdate={onInstallLocalUpdate} updatePhase={localUpdatePhase} updateStatus={updateStatus} lastUpdateCheckAt={lastUpdateCheckAt} onNotice={onNotice} onError={onError} /></div> : activeTab === "trash" && !activeBook ? <div className="content-view trash"><TrashView vaultPath={vault.path} onNotice={onNotice} isAdmin={canEdit} onVaultActivity={onVaultActivity} /></div> : !activeBook && activeTab === "compare" ? <div className="content-view compare"><CompareViewPanel vaultPath={vault.path} onNotice={onNotice} canEdit={canEdit} bookOrder={bookOrder} /></div> : !activeBook && activeTab === "returnGifts" ? <div className="content-view returnGifts"><ReturnGiftsView vaultPath={vault.path} isAdmin={canEdit} onError={onError} onVaultActivity={onVaultActivity} /></div> : !activeBook && activeTab === "history" ? <div className="content-view history"><HistoryView vaultPath={vault.path} vaultName={vault.name} isAdmin={canEdit} onNotice={onNotice} onVaultUpdated={onVaultUpdated} /></div> : activeBook ? (
            <>
              <div className="content-heading"><div><h2>{activeBook.title}{canEdit && <button className="icon-button subtle book-title-edit" data-operation-hint="提示：仅修改礼金簿名称、活动信息和备注。" type="button" title="编辑礼金簿" aria-label="编辑礼金簿" onClick={() => setBookEditOpen(true)}><Pencil size={16} /></button>}</h2><BookMetadata book={activeBook} vaultPath={vault.path} /></div><div className="heading-actions">{canEdit && activeTab !== "history" && <button className="icon-button danger" data-operation-hint="提示：删除后将进入回收站，可在回收站恢复。" title="删除当前礼金簿" onClick={() => setDeleteBookOpen(true)}><Trash2 size={17} /></button>}</div></div>
              <nav className="tab-bar"><button className={activeTab === "entries" ? "active" : ""} onClick={() => setActiveTab("entries")}><LayoutDashboard size={16} />礼金明细</button><button className={activeTab === "people" ? "active" : ""} onClick={() => setActiveTab("people")}><UsersRound size={16} />人物与标签</button><button className={activeTab === "compare" ? "active" : ""} onClick={() => setActiveTab("compare")}><BarChart3 size={16} />跨簿比较</button></nav>
              <div className={`content-view ${activeTab}`}>
                {activeTab === "trash" && <TrashView vaultPath={vault.path} onNotice={onNotice} isAdmin={canEdit} onVaultActivity={onVaultActivity} />}
                {activeTab === "entries" && <EntriesView book={activeBook} vaultPath={vault.path} onError={onError} onNotice={onNotice} isAdmin={isAdmin} editLocked={session.editLocked} continuousRegistration={continuousRegistration} onStopContinuousRegistration={() => onContinuousRegistrationChange(false)} onUnlockEditing={onUnlockEditing} onLockEditing={onLockEditing} focusedEntryId={focusedEntryId} onExportVault={exportVault} onEditVault={() => setVaultEditOpen(true)} onVaultActivity={onVaultActivity} />}
                {activeTab === "people" && <PeopleView vaultPath={vault.path} bookId={activeBook.id} onError={onError} isAdmin={isAdmin} editLocked={session.editLocked} onVaultActivity={onVaultActivity} />}
                {activeTab === "compare" && <CompareViewPanel vaultPath={vault.path} onNotice={onNotice} canEdit={canEdit} bookOrder={bookOrder} />}
                {activeTab === "returnGifts" && <ReturnGiftsView vaultPath={vault.path} isAdmin={canEdit} onError={onError} onVaultActivity={onVaultActivity} />}
                {activeTab === "history" && <HistoryView vaultPath={vault.path} vaultName={vault.name} isAdmin={canEdit} onNotice={onNotice} onVaultUpdated={onVaultUpdated} />}
              </div>
            </>
          ) : <EmptyBookState onCreate={() => canEdit && setBookModal(true)} />}
        </main>
      </div>
      {bookModal && <BookModal onClose={() => setBookModal(false)} onSubmit={(input) => createBook.mutate(input)} isSaving={createBook.isPending} />}
      {vaultEditOpen && <VaultMetadataModal vault={vault} isSaving={vaultEditSaving} onClose={() => setVaultEditOpen(false)} onSubmit={editVault} />}
      {bookEditOpen && activeBook && <BookMetadataModal book={activeBook} isSaving={bookEditSaving} onClose={() => setBookEditOpen(false)} onSubmit={editBook} />}
      {spreadsheetImportOpen && <SpreadsheetBatchModal paths={spreadsheetPaths} books={books.data ?? []} vaultName={vault.name} isImporting={spreadsheetImporting} onClose={() => { setSpreadsheetImportOpen(false); setSpreadsheetPaths([]); }} onChooseMore={async () => { try { const paths = await api.chooseSpreadsheetPaths(); const vaultCount = paths.filter((path) => path.toLocaleLowerCase().endsWith(".giftvault")).length; if (vaultCount) onNotice(`已跳过 ${vaultCount} 个礼金库文件，请使用“打开礼金库”切换礼金库`); return paths.filter((path) => !path.toLocaleLowerCase().endsWith(".giftvault")); } catch (err) { onError(String(err)); return []; } }} onImport={async (items) => { setSpreadsheetImporting(true); try { const result = await api.importSpreadsheets(items); await client.invalidateQueries(); setSpreadsheetImportOpen(false); setSpreadsheetPaths([]); if (result.books[0]) setActiveBookId(result.books[0].book.id); setActiveTab("entries"); onVaultActivity(); onNotice(`已从 ${result.books.length} 个文件导入 ${result.imported} 条记录`); } catch (err) { onError(String(err)); } finally { setSpreadsheetImporting(false); } }} />}
      {deleteBookOpen && activeBook && <ConfirmBookDelete title={activeBook.title} onClose={() => setDeleteBookOpen(false)} onConfirm={(pin) => { deleteBook.mutate({ bookId: activeBook.id, pin }); setDeleteBookOpen(false); }} />}
    </div>
  );
}

function SettingsView({ session, onUnlock, onUnlockEditing, onLockEditing, onChangePin, onCheckUpdate, onInstallUpdate, updatePhase, updateStatus, lastUpdateCheckAt, onNotice = () => undefined, onError = (message) => console.error(message) }: { session: SessionStatus; onUnlock: () => void; onUnlockEditing: () => void; onLockEditing: () => void; onChangePin: () => void; onCheckUpdate: () => void; onInstallUpdate: () => void; updatePhase: LocalUpdatePhase; updateStatus: LocalUpdateStatus | null; lastUpdateCheckAt: string | null; onNotice?: (message: string) => void; onError?: (message: string) => void }) {
  const isAdmin = session.role === "admin";
  const [section, setSection] = useState<SettingsSection>("general");
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [licenseText, setLicenseText] = useState<string | null>(null);
  const storage = useQuery({ queryKey: ["settings-storage"], queryFn: api.settingsStorageInfo });
  const chooseDirectory = useMutation({ mutationFn: api.chooseSettingsDirectory, onSuccess: (result) => { if (result) { storage.refetch(); onNotice("默认文件夹已更新；现有礼金库文件不会被移动。"); } }, onError: (error) => onError(String(error)) });
  const checkLicense = async () => {
    if (licenseText) { setLicenseOpen((open) => !open); return; }
    try { setLicenseText(await api.licenseText()); setLicenseOpen(true); } catch (error) { onError(String(error)); }
  };
  const checkedAt = lastUpdateCheckAt ? new Date(lastUpdateCheckAt).toLocaleString("zh-CN", { hour12: false }) : "尚未检查";
  const updateMessage = updateStatus?.error ? updateStatus.error : updateStatus?.candidate ? `发现 v${updateStatus.candidate.version}，可下载正式安装包更新。` : lastUpdateCheckAt ? "当前已是最新版本。" : "尚未检查更新。";
  return <section className="settings-view"><div className="settings-heading"><span className="eyebrow">软件设置</span><h2>设置</h2><p>管理本机偏好、编辑权限和软件版本信息。</p></div><div className="settings-layout"><nav className="settings-nav" aria-label="设置分类"><button type="button" className={section === "general" ? "active" : ""} onClick={() => setSection("general")}><Settings size={15} />通用</button><button type="button" className={section === "about" ? "active" : ""} onClick={() => setSection("about")}><Info size={15} />关于</button></nav><div className="settings-content">{section === "general" ? <><section className="settings-panel"><div><strong>默认文件夹</strong><p className="settings-path" title={storage.data?.directory}>{storage.isLoading ? "正在读取…" : storage.data?.directory}</p><p>用于新建或打开礼金库、选择导入表格时的默认位置；不会移动已有文件。</p><button className="secondary-button compact" disabled={chooseDirectory.isPending} onClick={() => chooseDirectory.mutate()}><FolderOpen size={14} />{chooseDirectory.isPending ? "选择中…" : "选择默认文件夹"}</button></div></section><section className="settings-panel"><div className="toolbar-actions">{isAdmin ? <><button className="secondary-button compact edit-lock-button" data-operation-hint={session.editLocked ? "提示：解锁后可执行删除和重要资料修改。" : "提示：锁定后将暂停高风险修改与删除。"} type="button" onClick={session.editLocked ? onUnlockEditing : onLockEditing}><LockKeyhole size={14} />{session.editLocked ? "解锁编辑" : "锁定编辑"}</button><button className="secondary-button compact" data-operation-hint="提示：修改 PIN 后会生成新的恢复码。" type="button" onClick={onChangePin}><KeyRound size={14} />修改 PIN</button></> : <button className="secondary-button compact" data-operation-hint="提示：管理员解锁后可管理编辑保护和 PIN。" type="button" onClick={onUnlock}><Unlock size={14} />管理员解锁</button>}</div></section></> : <AboutSettings updatePhase={updatePhase} updateStatus={updateStatus} checkedAt={checkedAt} updateMessage={updateMessage} onCheckUpdate={onCheckUpdate} onInstallUpdate={onInstallUpdate} onShowLicense={checkLicense} licenseOpen={licenseOpen} licenseText={licenseText} />}</div></div></section>;
}

function AboutSettings({ updatePhase, updateStatus, checkedAt, updateMessage, onCheckUpdate, onInstallUpdate, onShowLicense, licenseOpen, licenseText }: { updatePhase: LocalUpdatePhase; updateStatus: LocalUpdateStatus | null; checkedAt: string; updateMessage: string; onCheckUpdate: () => void; onInstallUpdate: () => void; onShowLicense: () => void; licenseOpen: boolean; licenseText: string | null }) {
  const candidate = updateStatus?.candidate;
  return <section className="about-page"><section className="about-card about-update-card"><div className="about-card-heading"><div><span className="about-label">当前版本</span><strong>v{__APP_VERSION__}</strong></div><button className="primary-button compact" disabled={updatePhase !== "idle"} onClick={onCheckUpdate}><RefreshCw className={updatePhase === "checking" ? "is-spinning" : undefined} size={14} />{updatePhase === "checking" ? "检查中…" : "检查更新"}</button></div><div className="about-status"><span className={`status-dot ${candidate ? "status-dot-update" : ""}`} />{updateMessage}</div><p className="about-meta">最近检查：{checkedAt}</p>{candidate && <div className="update-candidate"><strong>v{candidate.version} 可用</strong><span>{candidate.publishedAt ? `发布时间：${new Date(candidate.publishedAt).toLocaleString("zh-CN", { hour12: false })}` : "正式发布版本"}</span>{candidate.releaseUrl && <a className="release-link" href={candidate.releaseUrl} target="_blank" rel="noreferrer">查看 GitHub Release <ExternalLink size={12} /></a>}{candidate.releaseNotes && <details className="release-notes-details"><summary>查看更新明细</summary><pre>{candidate.releaseNotes}</pre></details>}<button className="primary-button compact" disabled={updatePhase !== "idle"} onClick={onInstallUpdate}>确认下载并安装</button></div>}</section><section className="about-card"><dl className="about-facts"><div><dt>代码仓库</dt><dd><a href="https://github.com/Bboy-Lan/Gift-Money-Management-System" target="_blank" rel="noreferrer">Bboy-Lan/Gift-Money-Management-System <ExternalLink size={13} /></a></dd></div><div><dt>开源协议</dt><dd><button className="text-link" type="button" onClick={onShowLicense}>MIT License · 查看本地 LICENSE</button></dd></div><div><dt>作者</dt><dd>Bboy-Lan</dd></div></dl>{licenseOpen && licenseText && <pre className="license-preview">{licenseText}</pre>}</section><section className="about-card"><details className="release-notes-details"><summary className="about-card-heading"><div><span className="about-label">更新明细</span><strong>v{__APP_VERSION__}</strong></div><ChevronDown size={16} /></summary><pre>{CURRENT_RELEASE_NOTES}</pre></details></section></section>;
}

function EntriesView({ book, vaultPath, onError, onNotice, isAdmin, editLocked, continuousRegistration, onStopContinuousRegistration, onUnlockEditing, onLockEditing, focusedEntryId, onExportVault, onEditVault, onVaultActivity }: { book: GiftBook; vaultPath: string; onError: (message: string) => void; onNotice: (message: string) => void; isAdmin: boolean; editLocked: boolean; continuousRegistration: boolean; onStopContinuousRegistration: () => void; onUnlockEditing: () => void; onLockEditing: () => void; focusedEntryId: string | null; onExportVault: () => void; onEditVault: () => void; onVaultActivity: () => void }) {
  const client = useQueryClient();
  const [entryModal, setEntryModal] = useState(false);
  const [entryFormKey, setEntryFormKey] = useState(0);
  const [editingEntry, setEditingEntry] = useState<GiftEntry | null>(null);
  const [deletingEntry, setDeletingEntry] = useState<GiftEntry | null>(null);
  const queryEntries = useQuery({ queryKey: ["entries", vaultPath, book.id], queryFn: () => api.listEntries(book.id, "") });
  const summary = useQuery({ queryKey: ["book-summary", vaultPath, book.id], queryFn: () => api.bookSummary(book.id) });
  const tags = useQuery({ queryKey: ["tags", vaultPath], queryFn: api.listTags });
  const createTag = useMutation({ mutationFn: ({ name, color }: { name: string; color: string }) => api.createTag(name, color), onSuccess: () => { client.invalidateQueries(); onVaultActivity(); }, onError: (err) => onError(String(err)) });
  const deleteEntry = useMutation({ mutationFn: api.deleteEntry, onSuccess: () => { client.invalidateQueries(); onVaultActivity(); }, onError: (err) => onError(String(err)) });
  const entries = queryEntries;
  const displayTags = canonicalizeTags(tags.data ?? []);
  const tagById = new Map(displayTags.map((tag) => [tag.id, tag]));
  const summaryMoney = formatSummaryMoney(summary.data?.totalFen ?? 0);
  const canEdit = isAdmin && !editLocked;
  const createEntry = useMutation({ mutationFn: (input: EntryDraft) => api.createEntry({ bookId: book.id, ...input }), onSuccess: () => { client.invalidateQueries(); onVaultActivity(); if (continuousRegistration) { setEntryFormKey((key) => key + 1); setEntryModal(true); onNotice("登记成功，请继续登记下一条礼金"); } else { setEntryModal(false); } }, onError: (err) => onError(String(err)) });
  const updateEntry = useMutation({ mutationFn: (input: EntryDraft & { entryId: string }) => api.updateEntry(input), onSuccess: () => { client.invalidateQueries(); setEditingEntry(null); onVaultActivity(); }, onError: (err) => onError(String(err)) });
  useEffect(() => {
    if (!focusedEntryId || !queryEntries.data?.some((entry) => entry.id === focusedEntryId)) return;
    document.getElementById(`entry-${focusedEntryId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusedEntryId, queryEntries.data]);
  const exportSpreadsheet = async () => {
    try { const path = await api.exportBookXlsx(book.id); onNotice(`已导出 Excel：${path}`); } catch (err) { onError(String(err)); }
  };
  return <section className={`entries-view ${editLocked ? "edit-locked" : ""}`}>
    <div className="metric-grid summary-strip"><Metric label="礼金笔数" value={`${summary.data?.giftCount ?? 0}`} accent="blue" /><Metric label="最高金额" value={formatMoney(summary.data?.highestAmountFen ?? 0)} accent="green" /><Metric label="礼金总额" value={summaryMoney.primary} detail={summaryMoney.exact} accent="amber" /></div>
    <div className="toolbar"><div className="toolbar-note">当前礼金簿共 {entries.data?.length ?? 0} 条记录</div><div className="toolbar-actions">{isAdmin && <button className={`secondary-button compact edit-lock-button ${editLocked ? "locked" : "unlocked"}`} data-operation-hint={editLocked ? "提示：解锁后可执行删除和重要资料修改。" : "提示：锁定后将暂停高风险修改与删除。"} type="button" onClick={editLocked ? onUnlockEditing : onLockEditing}><LockKeyhole size={14} />{editLocked ? "锁定编辑" : "已解锁编辑"}</button>}{canEdit && <button className="secondary-button compact" data-operation-hint="提示：仅修改礼金库名称和备注，不会改变内部数据归属。" onClick={onEditVault}><Pencil size={15} />编辑礼金库</button>}<button className="secondary-button compact" onClick={exportSpreadsheet}><FileSpreadsheet size={15} />导出 Excel</button><button className="secondary-button compact" onClick={onExportVault}><Archive size={15} />导出库</button>{canEdit && <button className="primary-button compact" onClick={() => setEntryModal(true)}><CirclePlus size={15} />登记礼金</button>}</div></div>
    <section className="table-panel"><div className="table-panel-heading"><div><strong>礼金明细</strong><span>{entries.data?.length ?? 0} 条记录</span></div></div>{entries.isLoading ? <div className="table-empty">正在加载礼金记录…</div> : entries.data?.length ? <div className="table-wrap"><table><thead><tr><th>姓名</th><th>金额</th><th>支付方式</th><th>地址</th><th>备注</th><th className="tag-column">标签</th><th>回礼金额</th><th>登记日期</th>{isAdmin && <th />}</tr></thead><tbody>{entries.data.map((entry) => {
      const entryTags = entry.tags.map((id) => tagById.get(id)).filter((tag): tag is Tag => Boolean(tag));
      const rowClassName = ["entry-row", entry.id === focusedEntryId ? "search-focused" : ""].filter(Boolean).join(" ");
      return <tr id={`entry-${entry.id}`} draggable={canEdit} onDragStart={(event) => { event.dataTransfer.setData("application/x-lijin-trash-kind", "entry"); event.dataTransfer.setData("application/x-lijin-trash-id", entry.id); }} className={rowClassName} style={{ "--entry-tag-color": entryTags[0]?.color ?? "#a9b5b9" } as React.CSSProperties} key={entry.id}><td className="entry-accent-cell"><div className="person-cell"><span className="avatar">{entry.personName.slice(0, 1)}</span><strong>{entry.personName}</strong></div></td><td className="amount-cell">{formatMoney(entry.amountFen)}</td><td><span className="method-pill">{entry.paymentMethod}</span></td><td className="muted">{entry.address || "-"}</td><td className="muted note-cell" title={entry.note || undefined}>{entry.note || "-"}</td><td className="tag-column">{entryTags.length ? <div className="tag-select">{entryTags.slice(0, 2).map((tag) => <span className="tag-chip" style={{ "--tag-color": tag.color } as React.CSSProperties} key={tag.id}>{tag.name}<span className="tag-swatch" /></span>)}</div> : <span className="muted">-</span>}</td><td className="amount-cell">{entry.returnGiftAmountFen ? formatMoney(entry.returnGiftAmountFen) : "-"}</td><td className="muted">{entry.receivedAt}</td>{canEdit && <td><div className="row-actions"><button className="icon-button subtle" data-operation-hint="提示：可修改此人的礼金、标签及回礼信息。" title="编辑信息" onClick={() => setEditingEntry(entry)}><Pencil size={15} /></button><button className="icon-button danger subtle" data-operation-hint="提示：删除后将进入回收站，可在回收站恢复。" title="删除记录" onClick={() => setDeletingEntry(entry)}><Trash2 size={15} /></button></div></td>}</tr>;
    })}</tbody></table></div> : <div className="table-empty"><FileSpreadsheet size={27} /><strong>还没有礼金记录</strong><span>从第一笔登记开始建立这本礼金簿。</span>{isAdmin && <button className="primary-button compact" onClick={() => setEntryModal(true)}><CirclePlus size={15} />登记第一笔</button>}</div>}</section>
     {entryModal && <EntryModal key={entryFormKey} tags={displayTags} vaultPath={vaultPath} onCreateTag={(name, color) => createTag.mutateAsync({ name, color })} onClose={() => { setEntryModal(false); onStopContinuousRegistration(); }} onSubmit={(input) => createEntry.mutate(input)} isSaving={createEntry.isPending} />}
    {editingEntry && <EntryModal tags={displayTags} vaultPath={vaultPath} onCreateTag={(name, color) => createTag.mutateAsync({ name, color })} initial={editingEntry} title="编辑信息" onClose={() => setEditingEntry(null)} onSubmit={(input) => updateEntry.mutate({ entryId: editingEntry.id, ...input })} isSaving={updateEntry.isPending} />}
    {deletingEntry && <ConfirmEntryDelete entry={deletingEntry} onClose={() => setDeletingEntry(null)} onConfirm={() => { deleteEntry.mutate(deletingEntry.id); setDeletingEntry(null); }} />}
  </section>;
}

type BatchPreviewState = {
  path: string;
  preview: SpreadsheetPreview;
  error: string | null;
  selected: boolean;
  bookName: string;
  mapping: SpreadsheetColumnMapping | null;
  sheetName: string | null;
  headerRow: number | null;
  targetBookId: string;
};

function completeMapping(mapping: Partial<SpreadsheetColumnMapping>): SpreadsheetColumnMapping {
  return {
    name: mapping.name ?? null,
    amount: mapping.amount ?? null,
    address: mapping.address ?? null,
    paymentMethod: mapping.paymentMethod ?? null,
    date: mapping.date ?? null,
    note: mapping.note ?? null,
    returnGift: mapping.returnGift ?? null,
    returnGiftAmount: mapping.returnGiftAmount ?? null,
    returnGiftedAt: mapping.returnGiftedAt ?? null,
    tags: mapping.tags ?? null,
  };
}

async function createBatchPreviewItem(path: string): Promise<BatchPreviewState> {
  try {
    const preview = await api.previewSpreadsheet(path);
    const fileName = preview.fileName.replace(/\.[^.]+$/, "");
    return { path, preview, error: null, selected: true, bookName: fileName || "导入礼金簿", mapping: preview.currentMapping, sheetName: preview.sheetName, headerRow: preview.headerRow, targetBookId: "" };
  } catch (errorValue) {
    const fileName = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "导入礼金簿";
    const emptyMapping = completeMapping({});
    return { path, preview: { fileName, sheetName: "", sheetNames: [], headerRow: 1, suggestedMapping: emptyMapping, currentMapping: emptyMapping, headers: [], rows: [], validRows: 0, errors: [], rowErrors: [], tagPreview: null }, error: String(errorValue), selected: true, bookName: fileName, mapping: null, sheetName: null, headerRow: null, targetBookId: "" };
  }
}

function previewColumns(preview: SpreadsheetPreview, mapping: SpreadsheetColumnMapping | null) {
  const mapped = SPREADSHEET_MAPPING_FIELDS.flatMap(([field, label]) => {
    const index = mapping?.[field];
    return index === null || index === undefined ? [] : [{ index, label }];
  });
  const source = mapped.length ? mapped : preview.headers.slice(0, 4).map((_, index) => ({ index, label: `第 ${index + 1} 列` }));
  const seen = new Set<number>();
  return source.filter(({ index }) => !seen.has(index) && Boolean(seen.add(index))).slice(0, 5);
}

function SpreadsheetBatchModal({ paths, books, vaultName, isImporting, onClose, onChooseMore, onImport }: { paths: string[]; books: GiftBook[]; vaultName: string; isImporting: boolean; onClose: () => void; onChooseMore: () => Promise<string[]>; onImport: (items: SpreadsheetImportItem[]) => void }) {
  const [items, setItems] = useState<BatchPreviewState[]>([]);
  const [targetBookId, setTargetBookId] = useState("");
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const next = await Promise.all(uniquePaths(paths).map(createBatchPreviewItem));
      if (!cancelled) setItems(next);
    };
    void load();
    return () => { cancelled = true; };
  }, [paths]);
  const addFiles = async () => {
    const additionalPaths = uniquePaths(await onChooseMore());
    const existing = new Set(items.map((item) => item.path.toLocaleLowerCase()));
    const unseenPaths = additionalPaths.filter((path) => !existing.has(path.toLocaleLowerCase()));
    if (!unseenPaths.length) return;
    const next = await Promise.all(unseenPaths.map(createBatchPreviewItem));
    setItems((current) => {
      const currentPaths = new Set(current.map((item) => item.path.toLocaleLowerCase()));
      return [...current, ...next.filter((item) => !currentPaths.has(item.path.toLocaleLowerCase()))];
    });
  };
  const updateItem = (path: string, patch: Partial<BatchPreviewState>) => setItems((current) => current.map((item) => item.path === path ? { ...item, ...patch } : item));
  const refreshPreview = async (item: BatchPreviewState, next: { sheetName?: string | null; headerRow?: number | null; mapping?: SpreadsheetColumnMapping }) => {
    if (!item.preview) return;
    const sheetName = next.sheetName === undefined ? item.sheetName : next.sheetName;
    const headerRow = next.headerRow === undefined ? item.headerRow : next.headerRow;
    const mapping = next.mapping ?? item.mapping ?? item.preview.currentMapping;
    try {
      const preview = await api.previewSpreadsheetMapping(item.path, sheetName, headerRow, mapping);
      updateItem(item.path, { preview, sheetName: preview.sheetName, headerRow: preview.headerRow, mapping: preview.currentMapping, error: null });
    } catch (errorValue) {
      updateItem(item.path, { error: String(errorValue) });
    }
  };
  const validItems = items.filter((item) => item.selected && item.preview && !item.error && targetBookId && item.preview.errors.length === 0 && item.preview.rowErrors.length === 0 && item.preview.rows.length > 0 && item.mapping?.name !== null && item.mapping?.name !== undefined && item.mapping?.amount !== null && item.mapping?.amount !== undefined);
  const hasBlockingItem = items.some((item) => item.selected && (!item.preview || Boolean(item.error) || !targetBookId || item.preview.errors.length > 0 || item.preview.rowErrors.length > 0 || item.preview.rows.length === 0 || item.mapping?.name === null || item.mapping?.name === undefined || item.mapping?.amount === null || item.mapping?.amount === undefined));
  const submit = () => {
    onImport(validItems.map((item) => ({ path: item.path, sheetName: item.sheetName ?? undefined, headerRow: item.headerRow ?? undefined, mapping: item.mapping ?? undefined, bookName: item.bookName.trim() || item.preview?.fileName.replace(/\.[^.]+$/, "") || "导入礼金簿", targetBookId: targetBookId === "__new__" ? null : targetBookId, createNewBook: targetBookId === "__new__" })));
  };
  return <Modal title={`批量导入表格 · ${items.length} 个文件`} onClose={onClose} className="spreadsheet-batch-modal">
    <div className="batch-import-toolbar"><span className="field-hint">当前礼金库：{vaultName}。请明确选择导入目标礼金簿。</span><label className="batch-target-book">目标礼金簿<select value={targetBookId} onChange={(event) => setTargetBookId(event.target.value)}><option value="">请选择目标礼金簿</option><option value="__new__">明确新建礼金簿</option>{books.map((book) => <option value={book.id} key={book.id}>{book.title}</option>)}</select></label><button className="secondary-button compact" onClick={() => void addFiles()} disabled={isImporting}><FolderOpen size={14} />添加文件</button></div>
    <div className="batch-import-list">{items.length === 0 ? <div className="table-empty">正在读取表格预览…</div> : items.map((item) => <article className={`batch-import-item ${item.error || item.preview?.errors.length ? "invalid" : ""}`} key={item.path}>
      <div className="batch-import-item-heading"><label className="batch-file-check"><input type="checkbox" checked={item.selected} disabled={!item.preview || Boolean(item.error) || isImporting} onChange={(event) => updateItem(item.path, { selected: event.target.checked })} /><strong>{item.preview?.fileName || item.path.split(/[\\/]/).pop()}</strong></label><button className="icon-button subtle" title="移除文件" onClick={() => setItems((current) => current.filter((candidate) => candidate.path !== item.path))}><X size={15} /></button></div>
      {item.error ? <div className="import-errors"><span>{item.error.replace(/^Error:\s*/, "")}</span><small>请移除该文件后再继续。</small></div> : item.preview && <><label className="batch-book-name">生成的礼金簿名称<input value={item.bookName} onChange={(event) => updateItem(item.path, { bookName: event.target.value })} /></label><div className="batch-mapping-row"><label>工作表<select value={item.sheetName ?? item.preview.sheetName} onChange={(event) => { const sheetName = event.target.value; updateItem(item.path, { sheetName }); void refreshPreview(item, { sheetName }); }}>{item.preview.sheetNames.map((name) => <option key={name}>{name}</option>)}</select></label><label>标题行<input type="number" min={1} value={item.headerRow ?? item.preview.headerRow} onChange={(event) => { const headerRow = Math.max(1, Number.parseInt(event.target.value, 10) || 1); updateItem(item.path, { headerRow }); void refreshPreview(item, { headerRow }); }} /></label></div><div className="batch-mapping-grid">{SPREADSHEET_MAPPING_FIELDS.map(([field, label]) => <label key={field}>{label}<select value={item.mapping?.[field] ?? ""} onChange={(event) => { const mapping = completeMapping({ ...(item.mapping ?? item.preview?.currentMapping ?? {}), [field]: event.target.value === "" ? null : Number(event.target.value) }); updateItem(item.path, { mapping }); void refreshPreview(item, { mapping }); }}><option value="">不导入</option>{item.preview.headers.map((header, index) => <option value={index} key={`${index}-${header}`}>{header || `第 ${index + 1} 列`}</option>)}</select></label>)}</div>{item.preview.tagPreview?.values.length ? <section className="spreadsheet-tags"><div className="spreadsheet-tags-heading"><strong>{item.preview.tagPreview.columnName || "人物标签"}</strong><span>{item.preview.tagPreview.values.length} 个标签</span></div><div className="spreadsheet-tag-list">{item.preview.tagPreview.values.map((tag) => <span className={`spreadsheet-tag ${tag.existing ? "existing" : "new"}`} key={tag.name}><i style={{ backgroundColor: tag.color }} /><span>{tag.name}</span><small>{tag.existing ? "已有" : "新建"} · {tag.count} 次</small></span>)}</div></section> : item.mapping?.tags !== null && item.mapping?.tags !== undefined ? <p className="field-hint spreadsheet-no-tags">人物标签列中未识别到可导入标签。</p> : null}{item.preview.rows.length > 0 && <section className="spreadsheet-sample"><div className="spreadsheet-sample-heading"><strong>表格样例</strong><span>前 {Math.min(3, item.preview.rows.length)} 行</span></div><div className="spreadsheet-sample-wrap"><table><thead><tr>{previewColumns(item.preview, item.mapping).map(({ index, label }) => <th key={index} title={label}>{item.preview.headers[index] || label}</th>)}</tr></thead><tbody>{item.preview.rows.slice(0, 3).map((row, rowIndex) => <tr key={`${item.path}-${rowIndex}`}>{previewColumns(item.preview, item.mapping).map(({ index }) => <td key={index} title={row[index] || undefined}>{row[index] || "—"}</td>)}</tr>)}</tbody></table></div></section>}{item.preview.errors.length > 0 && <div className="import-errors"><strong>当前预览校验失败</strong>{item.preview.errors.filter((error) => !item.preview!.rowErrors.includes(error)).slice(0, 5).map((error) => <span key={error}>{error}</span>)}{item.preview.rowErrors.length > 0 && <div className="import-row-errors"><strong>逐行错误</strong>{item.preview.rowErrors.slice(0, 5).map((error) => <span key={error}>{error}</span>)}</div>}</div>}<div className="batch-item-foot"><span>识别到 {item.preview.validRows} 行有效记录</span>{item.preview.tagPreview && <span>{item.preview.tagPreview.values.length} 个标签</span>}</div></>}
    </article>)}</div>
    <div className="modal-actions"><button className="secondary-button" onClick={onClose} disabled={isImporting}>取消</button><button className="primary-button" onClick={submit} disabled={isImporting || validItems.length === 0 || hasBlockingItem}>{isImporting ? "正在导入…" : hasBlockingItem ? "请先修正或移除问题文件" : `导入选中的 ${validItems.length} 个文件`}</button></div>
  </Modal>;
}

function PeopleView({ vaultPath, bookId, onError, isAdmin, editLocked, onVaultActivity }: { vaultPath: string; bookId: string; onError: (message: string) => void; isAdmin: boolean; editLocked: boolean; onVaultActivity: () => void }) {
  const client = useQueryClient();
  const [newTag, setNewTag] = useState("");
  const [newTagColor, setNewTagColor] = useState(nextTagColor([]));
  const [tagSearch, setTagSearch] = useState("");
  const [editingPersonId, setEditingPersonId] = useState<string | null>(null);
  const [tagPanelOpen, setTagPanelOpen] = useState(false);
  const peopleKey = ["people", vaultPath, bookId, tagSearch.trim()];
  const queryPeople = useQuery({ queryKey: peopleKey, queryFn: () => api.listPeople("", tagSearch, bookId) });
  const tags = useQuery({ queryKey: ["tags", vaultPath], queryFn: api.listTags, refetchOnMount: "always" });
  const displayTags = canonicalizeTags(tags.data ?? []);
  const people = {
    ...queryPeople,
    data: (queryPeople.data ?? []).map((person) => ({
      ...person,
      tags: tags.isSuccess ? resolveCatalogTags(person.tags, displayTags) : canonicalizeTags(person.tags),
    })),
  };
  useEffect(() => {
    if (!newTag.trim()) setNewTagColor(nextTagColor(tags.data ?? []));
  }, [newTag, tags.data]);
  const refreshTagConsumers = () => {
    client.invalidateQueries({ queryKey: ["tags"] });
    client.invalidateQueries({ queryKey: ["people"] });
    client.invalidateQueries({ queryKey: ["entries"] });
    client.invalidateQueries({ queryKey: ["person-history"] });
    client.invalidateQueries({ queryKey: ["vault-search"] });
    client.invalidateQueries({ queryKey: ["comparison-people"] });
    client.invalidateQueries({ queryKey: ["comparison-person-history"] });
  };
  const createTag = useMutation({
    mutationFn: () => api.createTag(newTag.trim(), newTagColor),
    onSuccess: (tag) => {
      const [createdTag] = canonicalizeTags([tag]);
      client.setQueryData<Tag[]>(["tags", vaultPath], (current) => [...(current ?? []), createdTag]);
      setNewTag("");
      refreshTagConsumers();
      onVaultActivity();
    },
    onError: (err) => onError(String(err)),
  });
  const updateTagColor = useMutation({
    mutationFn: ({ tagId, color }: { tagId: string; color: string }) => api.updateTagColor(tagId, color),
    onSuccess: () => { refreshTagConsumers(); onVaultActivity(); },
    onError: (err) => onError(String(err)),
  });
  const deleteTag = useMutation({
    mutationFn: api.deleteTag,
    onSuccess: () => { refreshTagConsumers(); onVaultActivity(); },
    onError: (err) => onError(String(err)),
  });
  const setPersonTags = useMutation({
    mutationFn: ({ personId, tagIds }: { personId: string; tagIds: string[] }) => api.setPersonTags(personId, tagIds),
    onSuccess: () => { refreshTagConsumers(); onVaultActivity(); },
    onError: (err) => onError(String(err)),
  });
  const searchLabel = tagSearch.trim() ? `标签“${tagSearch.trim()}”` : "当前礼金簿";
  return <section className="people-view">
    <div className="people-toolbar">
      <div className="people-toolbar-left">
        <label className="tag-search-field person-tag-search" aria-label="搜索人物标签"><Search size={15} /><input value={tagSearch} onChange={(event) => setTagSearch(event.target.value)} placeholder="搜索人物标签" />{tagSearch && <button className="icon-button subtle" type="button" title="清除标签搜索" aria-label="清除标签搜索" onClick={() => setTagSearch("")}><X size={13} /></button>}</label>
        <button className={`people-tag-toggle ${tagPanelOpen ? "active" : ""}`} type="button" aria-expanded={tagPanelOpen} onClick={() => setTagPanelOpen((open) => !open)}><UsersRound size={15} />人物标签<ChevronRight className={tagPanelOpen ? "rotate-90" : undefined} size={14} /></button>
      </div>
      <span className="toolbar-note">{searchLabel}共 {people.data?.length ?? 0} 位人物</span>
    </div>
    <div className={`people-layout ${tagPanelOpen ? "" : "tag-panel-hidden"}`}>
      <div className="people-main"><div className="table-panel"><div className="table-panel-heading"><div><strong>人物档案</strong><span>{people.data?.length ?? 0} 位</span></div></div><div className="table-wrap"><table><thead><tr><th>姓名</th><th>地址</th><th>标签</th><th>累计礼金</th><th>次数</th></tr></thead><tbody>{people.data?.map((person) => <PersonRow key={person.id} person={{ ...person, tags: colorizeTags(person.tags) }} tags={displayTags} isAdmin={isAdmin} canDelete={isAdmin && !editLocked} pickerOpen={editingPersonId === person.id} onTogglePicker={() => setEditingPersonId((current) => current === person.id ? null : person.id)} onChange={(tagIds) => setPersonTags.mutate({ personId: person.id, tagIds })} />)}</tbody></table>{!queryPeople.isLoading && !people.data?.length && <div className="table-empty"><UsersRound size={24} /><strong>{tagSearch.trim() ? "没有找到带有该标签的人物" : "当前礼金簿还没有人物"}</strong><span>{tagSearch.trim() ? "清空标签搜索后查看全部人物。" : "人物记录会在登记或导入礼金后显示。"}</span></div>}</div></div></div>
      {tagPanelOpen && <aside className="tag-panel"><div className="tag-panel-heading"><h3>人物标签</h3><span className="tag-panel-count">{displayTags.length} 个标签</span></div><p>标签颜色与人物档案同步，可用于筛选人物。</p>{isAdmin && <div className="tag-create"><input className="tag-color-picker" type="color" value={newTagColor} title="选择新建标签的颜色" aria-label="选择新建标签的颜色" onChange={(event) => setNewTagColor(event.target.value)} /><input placeholder="例如：同学" value={newTag} onChange={(event) => setNewTag(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && newTag.trim()) createTag.mutate(); }} /><button className="icon-button subtle tag-create-submit" type="button" title="添加人物标签" aria-label="添加人物标签" disabled={!newTag.trim() || createTag.isPending} onClick={() => createTag.mutate()}><CirclePlus size={17} /></button></div>}<div className="tag-cloud tag-management-list">{displayTags.map((tag) => <span className="tag-chip-control tag-management-item" draggable={isAdmin && !editLocked} onDragStart={(event) => { event.dataTransfer.setData("application/x-lijin-trash-kind", "tag"); event.dataTransfer.setData("application/x-lijin-trash-id", tag.id); }} key={tag.id}><span className={`tag-chip tag-manager-chip ${isAdmin ? "has-remove" : ""}`} style={{ "--tag-color": tag.color } as React.CSSProperties}>{tag.name}<span className="tag-swatch" />{isAdmin && <button className="tag-delete-button tag-chip-remove" type="button" title={editLocked ? "请先解锁编辑" : `删除「${tag.name}」`} aria-label={`删除「${tag.name}」`} disabled={deleteTag.isPending || editLocked} onClick={(event) => { event.stopPropagation(); deleteTag.mutate(tag.id); }}><X size={8} /></button>}</span>{isAdmin && <input className="tag-color-picker inline" type="color" value={tag.color} title={`修改「${tag.name}」的颜色`} aria-label={`修改「${tag.name}」的颜色`} onChange={(event) => updateTagColor.mutate({ tagId: tag.id, color: event.target.value })} />}</span>)}</div></aside>}
    </div>
  </section>;
}

function PersonRow({ person, tags, isAdmin, canDelete, pickerOpen, onTogglePicker, onChange }: { person: Person; tags: Tag[]; isAdmin: boolean; canDelete: boolean; pickerOpen: boolean; onTogglePicker: () => void; onChange: (tagIds: string[]) => void }) {
  const current = new Set(person.tags.map((tag) => tag.id));
  const primaryTagColor = person.tags[0]?.color ?? "#a9b5b9";
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) onTogglePicker();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onTogglePicker();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onTogglePicker, pickerOpen]);
  const toggleTag = (tagId: string) => {
    const next = new Set(current);
    if (next.has(tagId)) next.delete(tagId);
    else next.add(tagId);
    onChange([...next]);
  };
  return (
    <tr draggable={canDelete} onDragStart={(event) => { event.dataTransfer.setData("application/x-lijin-trash-kind", "person"); event.dataTransfer.setData("application/x-lijin-trash-id", person.id); }} className="person-row" style={{ "--person-tag-color": primaryTagColor } as React.CSSProperties}>
      <td><div className="person-cell"><span className="avatar">{person.displayName.slice(0, 1)}</span><strong>{person.displayName}</strong></div></td>
      <td className="muted">{person.address || "-"}</td>
      <td>
        <div className="person-tags-cell">
          {person.tags.length ? person.tags.map((tag) => (
            <span key={tag.id} className="person-tag-chip">
              <span className="tag-chip" style={{ "--tag-color": tag.color } as React.CSSProperties}>{tag.name}<span className="tag-swatch" /></span>
            </span>
          )) : <span className="muted">无标签</span>}
          {isAdmin && <div className="person-tag-picker" ref={pickerRef}><button className="person-tag-more" type="button" title="调整人物标签" aria-label="调整人物标签" aria-expanded={pickerOpen} onClick={onTogglePicker}><CirclePlus size={17} /></button>{pickerOpen && <div className="person-tag-popover"><strong>调整人物标签</strong><div>{tags.map((tag) => { const selected = current.has(tag.id); return <button type="button" className={`tag-toggle person-tag-option ${selected ? "selected" : ""}`} style={{ "--tag-color": tag.color } as React.CSSProperties} aria-pressed={selected} key={tag.id} onClick={() => toggleTag(tag.id)}>{tag.name}<span className="tag-swatch" /></button>; })}</div></div>}</div>}
        </div>
      </td>
      <td className="amount-cell">{formatMoney(person.totalFen)}</td>
      <td className="muted">{person.giftCount}</td>
    </tr>
  );
}

function HistoryView({ vaultPath, vaultName, isAdmin, onNotice, onVaultUpdated }: { vaultPath: string; vaultName: string; isAdmin: boolean; onNotice: (message: string) => void; onVaultUpdated: (vault: VaultInfo) => void }) {
  const client = useQueryClient();
  const [clearOpen, setClearOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set());
  const history = useQuery({ queryKey: ["audit-logs", vaultPath], queryFn: api.listAuditLogs });
  const refreshWorkspace = async () => {
    await client.invalidateQueries();
    onVaultUpdated(await api.currentVaultInfo());
    await history.refetch();
  };
  const clearHistory = useMutation({
    mutationFn: async (records: AuditLog[]) => { await api.clearAuditLogs(records.map((record) => record.id)); return records; },
    onSuccess: async (records) => { await refreshWorkspace(); setSelectedHistoryIds(new Set()); setSelectionMode(false); setClearOpen(false); onNotice(`删除成功：${historyTargets(records)}`); },
    onError: (error) => { void refreshWorkspace().catch(() => undefined); onNotice(`删除失败：${String(error).replace(/^Error:\s*/, "")}`); },
  });
  const restoreHistory = useMutation({
    mutationFn: async (records: AuditLog[]) => { await api.restoreAuditLogs(records.map((record) => record.id)); return records; },
    onSuccess: async (records) => { await refreshWorkspace(); setSelectedHistoryIds(new Set()); setSelectionMode(false); onNotice(`恢复成功：${historyTargets(records)}`); },
    onError: (error) => { void refreshWorkspace().catch(() => undefined); onNotice(`恢复失败：${String(error).replace(/^Error:\s*/, "")}`); },
  });
  const displayTime = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
  const toggleHistoryId = (id: string) => setSelectedHistoryIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const exitSelectionMode = () => { setSelectionMode(false); setSelectedHistoryIds(new Set()); };
  const selectedCount = selectedHistoryIds.size;
  const selectedRecords = (history.data ?? []).filter((record) => selectedHistoryIds.has(record.id));
  const restoreAllowed = selectedCount > 0 && selectedRecords.every(isRestorableAuditRecord);
  const restoreHistorySelection = () => {
    if (!selectedCount) {
      setSelectionMode(true);
      return;
    }
    if (restoreAllowed) restoreHistory.mutate(selectedRecords);
  };
  const restorableRecords = (history.data ?? []).filter(isRestorableAuditRecord);
  return <section className="history-view"><div className="table-panel"><div className="table-panel-heading"><div><strong>历史改动</strong><span>{history.data?.length ?? 0} 条</span></div>{isAdmin && <div className="toolbar-actions"><button className={`secondary-button compact ${selectionMode ? "active" : ""}`} type="button" disabled={!history.data?.length || clearHistory.isPending} aria-pressed={selectionMode} onClick={() => selectionMode ? exitSelectionMode() : setSelectionMode(true)}><ListChecks size={14} />{selectionMode ? "退出多选" : "多选"}</button><button className="restore-button compact" data-operation-hint="提示：将撤销选中改动并恢复对应业务数据。" type="button" disabled={!restorableRecords.length || restoreHistory.isPending || (selectedCount > 0 && !restoreAllowed)} title={!selectedCount ? "点击后进入多选，再选择可恢复的改动" : !restoreAllowed ? "所选记录不能全部恢复" : "恢复所选改动"} onClick={restoreHistorySelection}><Archive size={14} />恢复改动</button><button className="danger-button compact" data-operation-hint="提示：删除历史记录后无法恢复。" disabled={clearHistory.isPending || restoreHistory.isPending || (selectionMode ? selectedCount === 0 : !history.data?.length)} onClick={() => setClearOpen(true)}><Trash2 size={14} />{selectionMode ? `删除选中改动信息（已选 ${selectedCount} 条）` : "删除改动信息"}</button></div>}</div>{history.isLoading ? <div className="table-empty">正在读取历史改动…</div> : history.data?.length ? <div className="table-wrap"><table className="audit-table"><thead><tr>{selectionMode && <th className="audit-select-column"><input type="checkbox" checked={selectedCount > 0 && selectedCount === restorableRecords.length} onChange={(event) => setSelectedHistoryIds(event.target.checked ? new Set(restorableRecords.map((record) => record.id)) : new Set())} aria-label="全选可恢复历史改动" /></th>}<th className="audit-time">时间</th><th className="audit-object">对象</th><th className="audit-vault">礼金库</th><th className="audit-book">礼金簿</th><th className="audit-action">操作</th><th className="audit-detail">变更明细</th></tr></thead><tbody>{history.data.map((record: AuditLog) => { const selected = selectedHistoryIds.has(record.id); const restorable = isRestorableAuditRecord(record); return <tr key={record.id} className={`${selectionMode && selected ? "audit-row-selected" : ""}`.trim()} onClick={selectionMode && restorable ? () => toggleHistoryId(record.id) : undefined}>{selectionMode && <td className="audit-select-column"><input type="checkbox" checked={selected} onChange={() => toggleHistoryId(record.id)} onClick={(event) => event.stopPropagation()} aria-label={"选择历史改动 " + record.target} /></td>}<td className="muted audit-time">{displayTime(record.createdAt)}</td><td className="audit-object">{record.target}</td><td className="muted audit-vault">{vaultName}</td><td className="muted audit-book">{record.bookTitle || "礼金库"}</td><td className="audit-action"><strong>{record.description}</strong></td><td className="audit-changes audit-detail">{record.changes.length ? record.changes.map((change) => <div key={record.id + "-" + change.field}><strong>{change.field}</strong><span>{change.before}</span><b>→</b><span>{change.after}</span></div>) : <span className="muted">—</span>}</td></tr>; })}</tbody></table></div> : <div className="table-empty"><History size={27} /><strong>还没有历史改动</strong><span>具体人物、礼金记录、礼金簿和礼金库的编辑会显示在这里。</span></div>}</div>{selectionMode && <p className="field-hint history-restore-hint">可恢复的改动会在完成后自动从列表移除；失效历史会自动清理。</p>}{clearOpen && <ConfirmHistoryClear selectedCount={selectionMode ? selectedCount : 0} isClearing={clearHistory.isPending} onClose={() => setClearOpen(false)} onConfirm={() => clearHistory.mutate(selectionMode ? selectedRecords : (history.data ?? []))} />}</section>;
}

function formatReturnGiftTime(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ReturnGiftsView({ vaultPath, isAdmin, onError, onVaultActivity }: { vaultPath: string; isAdmin: boolean; onError: (message: string) => void; onVaultActivity: () => void }) {
  const client = useQueryClient();
  const [editingRecord, setEditingRecord] = useState<ReturnGiftRecord | null>(null);
  const returnGifts = useQuery({ queryKey: ["return-gifts", vaultPath], queryFn: api.listReturnGifts });
  const updateInformation = useMutation({
    mutationFn: ({ entryId, amountFen, returnGift }: { entryId: string; amountFen: number; returnGift: string }) => api.updateReturnGiftInformation(entryId, amountFen, returnGift),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["return-gifts", vaultPath] });
      client.invalidateQueries({ queryKey: ["entries"] });
      client.invalidateQueries({ queryKey: ["audit-logs"] });
      setEditingRecord(null);
      onVaultActivity();
    },
    onError: (error) => onError(String(error)),
  });
  return <section className="return-gifts-view">
    <div className="toolbar"><div className="toolbar-note">已记录 {returnGifts.data?.length ?? 0} 笔回礼</div><div className="toolbar-actions"><button className="secondary-button compact" onClick={() => void returnGifts.refetch()}><RefreshCw size={15} />刷新</button></div></div>
    <section className="table-panel"><div className="table-panel-heading"><div><strong>回礼明细</strong><span>{returnGifts.data?.length ?? 0} 条记录</span></div></div>{returnGifts.isLoading ? <div className="table-empty">正在读取回礼记录…</div> : returnGifts.data?.length ? <div className="table-wrap"><table><thead><tr><th>人物</th><th>回礼金额</th><th>回礼时间</th><th>所属礼金簿</th><th>地址</th><th>回礼备注</th><th>标签</th>{isAdmin && <th />}</tr></thead><tbody>{returnGifts.data.map((record) => <tr className="entry-row" style={{ "--entry-tag-color": record.tags[0]?.color ?? "#a9b5b9" } as React.CSSProperties} key={record.entryId}><td className="entry-accent-cell"><div className="person-cell"><span className="avatar">{record.personName.slice(0, 1)}</span><strong>{record.personName}</strong></div></td><td className="amount-cell">{formatMoney(record.returnGiftAmountFen)}</td><td className="muted">{formatReturnGiftTime(record.returnGiftedAt)}</td><td className="muted">{record.bookTitle}</td><td className="muted">{record.address || "-"}</td><td className="muted note-cell">{record.returnGift || "-"}</td><td>{record.tags.length ? <div className="tag-select">{record.tags.map((tag) => <span className="tag-chip" style={{ "--tag-color": tag.color } as React.CSSProperties} key={tag.id}>{tag.name}<span className="tag-swatch" /></span>)}</div> : <span className="muted">-</span>}</td>{isAdmin && <td><button className="icon-button subtle" title="编辑回礼信息" aria-label="编辑回礼信息" onClick={() => setEditingRecord(record)}><Pencil size={15} /></button></td>}</tr>)}</tbody></table></div> : <div className="table-empty"><Gift size={27} /><strong>还没有回礼记录</strong><span>在“编辑信息”中填写回礼金额后，记录会显示在这里。</span></div>}</section>
    {editingRecord && <ReturnGiftInformationModal record={editingRecord} isSaving={updateInformation.isPending} onClose={() => setEditingRecord(null)} onSubmit={(amountFen, returnGift) => updateInformation.mutate({ entryId: editingRecord.entryId, amountFen, returnGift })} />}
  </section>;
}

function ReturnGiftInformationModal({ record, isSaving, onClose, onSubmit }: { record: ReturnGiftRecord; isSaving: boolean; onClose: () => void; onSubmit: (amountFen: number, returnGift: string) => void }) {
  const [amount, setAmount] = useState(`${Math.trunc(record.returnGiftAmountFen / 100)}.${String(record.returnGiftAmountFen % 100).padStart(2, "0")}`);
  const [returnGift, setReturnGift] = useState(record.returnGift ?? "");
  const amountFen = parseAmountFen(amount);
  const valid = amountFen !== null && amountFen > 0;
  return <Modal title="编辑回礼信息" onClose={onClose}><div className="return-gift-readonly"><span>人物</span><strong>{record.personName}</strong><span>回礼时间</span><strong>{formatReturnGiftTime(record.returnGiftedAt)}</strong><span>所属礼金簿</span><strong>{record.bookTitle}</strong></div><label>回礼金额（元）<input autoFocus inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="例如 500" /></label><label>回礼备注<textarea value={returnGift} onChange={(event) => setReturnGift(event.target.value)} placeholder="可选" /></label><div className="modal-actions"><button className="secondary-button" onClick={onClose} disabled={isSaving}>取消</button><button className="primary-button" disabled={!valid || isSaving} onClick={() => valid && onSubmit(amountFen, returnGift)}>{isSaving ? "保存中…" : "保存信息"}</button></div></Modal>;
}

function trashTargets(items: TrashItem[]) {
  const titles = [...new Set(items.map((item) => item.title).filter(Boolean))];
  if (!titles.length) return "选中项目";
  return titles.length > 3 ? `${titles.slice(0, 3).join("、")}等 ${titles.length} 项` : titles.join("、");
}

function TrashView({ vaultPath, onNotice, isAdmin, onVaultActivity }: { vaultPath: string; onNotice: (message: string) => void; isAdmin: boolean; onVaultActivity: () => void }) {
  const client = useQueryClient();
  const [clearOpen, setClearOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedTrashKeys, setSelectedTrashKeys] = useState<Set<string>>(new Set());
  const trash = useQuery({ queryKey: ["trash", vaultPath], queryFn: api.listTrash });
  const trashItemKey = (item: Pick<TrashItem, "kind" | "id" | "vaultPath">) => `${item.vaultPath ?? "global"}\u001f${item.kind}\u001f${item.id}`;
  const refreshRelatedViews = () => {
    client.invalidateQueries({ queryKey: ["trash"] });
    client.invalidateQueries({ queryKey: ["books"] });
    client.invalidateQueries({ queryKey: ["entries"] });
    client.invalidateQueries({ queryKey: ["people"] });
    client.invalidateQueries({ queryKey: ["tags"] });
    client.invalidateQueries({ queryKey: ["book-stats"] });
    client.invalidateQueries({ queryKey: ["person-history"] });
    client.invalidateQueries({ queryKey: ["vault-search"] });
    client.invalidateQueries({ queryKey: ["comparison-people"] });
    client.invalidateQueries({ queryKey: ["comparison-person-history"] });
  };
  const restoreSelection = useMutation({
    mutationFn: async (items: TrashItem[]) => {
      for (const item of items) await api.restoreTrashItem(item.kind, item.id, item.vaultPath);
      return items;
    },
    onSuccess: (items) => {
      refreshRelatedViews();
      setSelectedTrashKeys(new Set());
      setSelectionMode(false);
      onVaultActivity();
      onNotice(`恢复成功：${trashTargets(items)}`);
    },
    onError: (err, items) => {
      refreshRelatedViews();
      onNotice(`恢复失败：${trashTargets(items)}，${String(err).replace(/^Error:\s*/, "")}`);
    },
  });
  const empty = useMutation({ mutationFn: api.emptyTrash, onSuccess: () => { refreshRelatedViews(); setClearOpen(false); onVaultActivity(); onNotice("清空回收站成功"); }, onError: (err) => { refreshRelatedViews(); onNotice(`清空回收站失败：${String(err).replace(/^Error:\s*/, "")}`); } });
  const toggleTrashItem = (item: TrashItem) => setSelectedTrashKeys((current) => {
    const next = new Set(current);
    const key = trashItemKey(item);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedTrashKeys(new Set());
  };
  const selectedItems = (trash.data ?? []).filter((item) => selectedTrashKeys.has(trashItemKey(item)));
  const selectedCount = selectedItems.length;
  const restoreSelectedItems = () => {
    if (!selectionMode) {
      setSelectionMode(true);
      return;
    }
    if (selectedItems.length) restoreSelection.mutate(selectedItems);
  };
  return <section className="trash-view">
    <div className="compare-heading">
      <div><span className="eyebrow">回收站</span><h3>回收站</h3><p>删除的礼金库、礼金簿、人物、礼金记录和人物标签会暂时保留。</p></div>
      <div className="toolbar-actions">
        {isAdmin && <button className={`secondary-button compact ${selectionMode ? "active" : ""}`} type="button" disabled={!trash.data?.length || restoreSelection.isPending || empty.isPending} aria-pressed={selectionMode} onClick={() => selectionMode ? exitSelectionMode() : setSelectionMode(true)}><ListChecks size={14} />{selectionMode ? "退出多选" : "多选"}</button>}
        {isAdmin && <button className="restore-button compact" data-operation-hint="提示：将恢复选中的项目及其可恢复关联数据。" type="button" disabled={!trash.data?.length || restoreSelection.isPending || (selectionMode && selectedCount === 0)} title={!selectionMode ? "点击后进入多选，再选择要恢复的项目" : !selectedCount ? "请选择要恢复的项目" : "恢复选中的项目"} onClick={restoreSelectedItems}><Archive size={14} />恢复</button>}
        {isAdmin && <button className="danger-button compact" data-operation-hint="提示：将永久清除回收站内容，需要管理员确认。" disabled={!trash.data?.length || empty.isPending || restoreSelection.isPending} onClick={() => setClearOpen(true)}><Trash2 size={14} />清空回收站</button>}
      </div>
    </div>
    <section className="table-panel">
      <div className="table-panel-heading"><div><strong>已删除项目</strong><span>{trash.data?.length ?? 0} 项</span></div></div>
      {trash.isLoading ? <div className="table-empty">正在读取回收站…</div> : trash.data?.length ? <div className="table-wrap"><table>
        <thead><tr>{selectionMode && <th className="audit-select-column"><input type="checkbox" checked={selectedCount > 0 && selectedCount === trash.data.length} onChange={(event) => setSelectedTrashKeys(event.target.checked ? new Set(trash.data.map(trashItemKey)) : new Set())} aria-label="全选回收站项目" /></th>}<th>类型</th><th>项目</th><th>来源礼金库</th><th>所属礼金簿</th><th>删除时间</th></tr></thead>
        <tbody>{trash.data.map((item) => {
          const selected = selectedTrashKeys.has(trashItemKey(item));
          return <tr key={trashItemKey(item)} className={selectionMode && selected ? "audit-row-selected" : ""} onClick={selectionMode ? () => toggleTrashItem(item) : undefined}>
            {selectionMode && <td className="audit-select-column"><input type="checkbox" checked={selected} onChange={() => toggleTrashItem(item)} onClick={(event) => event.stopPropagation()} aria-label={`选择回收站项目 ${item.title}`} /></td>}
            <td><span className="method-pill">{item.kind === "vault" ? "礼金库" : item.kind === "book" ? "礼金簿" : item.kind === "person" ? "人物" : item.kind === "tag" ? "人物标签" : "礼金记录"}</span></td><td><strong>{item.title}</strong></td><td className="muted">{item.vaultPath ? item.vaultPath.split(/[\\/]/).pop() : "礼金库文件"}</td><td className="muted">{item.bookTitle}</td><td className="muted">{new Date(item.deletedAt).toLocaleString("zh-CN")}</td>
          </tr>;
        })}</tbody>
      </table></div> : <div className="table-empty"><Trash2 size={27} /><strong>回收站为空</strong><span>删除的项目会在这里显示，并可恢复。</span></div>}
    </section>
    {clearOpen && <ConfirmTrashEmpty isClearing={empty.isPending} onClose={() => setClearOpen(false)} onConfirm={(pin) => empty.mutate(pin)} />}
  </section>;
}

function EmptyBookState({ onCreate }: { onCreate: () => void }) { return <div className="empty-book"><div className="empty-book-icon"><BookOpen size={25} /></div><h2>从一本礼金簿开始</h2><p>为婚礼、寿宴、乔迁等活动建立独立记录，人物档案和标签会在礼金库中长期保留。</p><button className="primary-button" onClick={onCreate}><CirclePlus size={17} />新建礼金簿</button></div>; }

function Metric({ label, value, detail, accent }: { label: string; value: string; detail?: string | null; accent: string }) { return <div className={`metric-card ${accent}`}><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>; }

function BookModal({ onClose, onSubmit, isSaving }: { onClose: () => void; onSubmit: (input: { title: string; occasion: string; eventDate: string; location: string; notes: string }) => void; isSaving: boolean }) { const [title, setTitle] = useState(""); const [occasion, setOccasion] = useState("婚礼"); const [eventDate, setEventDate] = useState(today()); const [location, setLocation] = useState(""); const [notes, setNotes] = useState(""); return <Modal title="新建礼金簿" onClose={onClose}><label>礼金簿名称<input autoFocus placeholder="例如：2026 年春节走亲" value={title} onChange={(event) => setTitle(event.target.value)} /></label><div className="form-grid"><label>活动类型<input value={occasion} onChange={(event) => setOccasion(event.target.value)} /></label><label>活动日期<input type="date" value={eventDate} onChange={(event) => setEventDate(event.target.value)} /></label></div><label>地点<input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="可选" /></label><label>备注<textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="可选" /></label><div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim() || isSaving} onClick={() => onSubmit({ title: title.trim(), occasion, eventDate, location, notes })}>{isSaving ? "创建中…" : "创建礼金簿"}</button></div></Modal>; }

function BookMetadataModal({ book, onClose, onSubmit, isSaving }: { book: GiftBook; onClose: () => void; onSubmit: (input: { title: string; occasion: string; eventDate: string; location: string; notes: string }) => void; isSaving: boolean }) {
  const [title, setTitle] = useState(book.title);
  const [occasion, setOccasion] = useState(book.occasion);
  const [eventDate, setEventDate] = useState(book.eventDate ?? "");
  const [location, setLocation] = useState(book.location ?? "");
  const [notes, setNotes] = useState(book.notes ?? "");
  return <Modal title="编辑礼金簿" onClose={onClose}>
    <label>礼金簿名称<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <div className="form-grid"><label>活动类型<input value={occasion} onChange={(event) => setOccasion(event.target.value)} /></label><label>活动日期<input type="date" value={eventDate} onChange={(event) => setEventDate(event.target.value)} /></label></div>
    <label>地点<input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="可选" /></label>
    <label>备注<textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="可选" /></label>
    <p className="field-hint">创建时间、导入时间和原始表格路径保持不变；活动日期可独立修改。</p>
    <div className="modal-actions"><button className="secondary-button" disabled={isSaving} onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim() || isSaving} onClick={() => onSubmit({ title: title.trim(), occasion: occasion.trim(), eventDate, location: location.trim(), notes: notes.trim() })}>{isSaving ? "保存中…" : "保存修改"}</button></div>
  </Modal>;
}

function EntryModal({ onClose, onSubmit, isSaving, initial, title = "登记礼金", tags, vaultPath, onCreateTag }: { onClose: () => void; onSubmit: (input: EntryDraft) => void; isSaving: boolean; initial?: GiftEntry; title?: string; tags: Tag[]; vaultPath: string; onCreateTag: (name: string, color: string) => Promise<Tag> }) {
  const [personName, setPersonName] = useState(initial?.personName ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [amount, setAmount] = useState(initial ? `${Math.trunc(initial.amountFen / 100)}.${String(initial.amountFen % 100).padStart(2, "0")}` : "");
  const [paymentMethod, setPaymentMethod] = useState(resolvePaymentMethodValue(initial?.paymentMethod));
  const [note, setNote] = useState(initial?.note ?? "");
  const [returnGift, setReturnGift] = useState(initial?.returnGift ?? "");
  const [returnGiftAmount, setReturnGiftAmount] = useState(initial?.returnGiftAmountFen ? `${Math.trunc(initial.returnGiftAmountFen / 100)}.${String(initial.returnGiftAmountFen % 100).padStart(2, "0")}` : "");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(initial?.tags ?? []);
  const [newTag, setNewTag] = useState("");
  const [newTagColor, setNewTagColor] = useState(nextTagColor(tags));
  const [createdTags, setCreatedTags] = useState<Tag[]>([]);
  const [promotedTagId, setPromotedTagId] = useState<string | null>(null);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const paymentRef = useRef<HTMLSelectElement>(null);
  const returnGiftAmountRef = useRef<HTMLInputElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const amountFen = parseAmountFen(amount);
  const returnGiftAmountFen = returnGiftAmount.trim() ? parseAmountFen(returnGiftAmount) : null;
  const valid = Boolean(personName.trim()) && amountFen !== null && (!returnGiftAmount.trim() || (returnGiftAmountFen !== null && returnGiftAmountFen > 0));
  const availableTags = [...tags, ...createdTags.filter((createdTag) => !tags.some((tag) => tag.id === createdTag.id))];
  const tagSections = getEntryTagSections(availableTags, promotedTagId);
  const comparisonVaultPaths = uniquePaths([vaultPath, ...readComparisonVaults()]);
  const normalizedPersonName = normalizePersonName(personName);
  const debouncedPersonName = useDebouncedValue(normalizedPersonName, 180);
  const duplicatePeople = useQuery({
    queryKey: ["duplicate-person-name", vaultPath, comparisonVaultPaths, debouncedPersonName],
    queryFn: () => api.searchComparisonPeople(comparisonVaultPaths, debouncedPersonName),
    enabled: !initial && Boolean(debouncedPersonName),
    retry: false,
  });
  const duplicateName = !initial && Boolean(duplicatePeople.data?.some((person) => personNamesMatch(person.displayName, normalizedPersonName)));
  const legacyPaymentMethod = PAYMENT_METHOD_OPTIONS.includes(paymentMethod as typeof PAYMENT_METHOD_OPTIONS[number]) ? null : paymentMethod;

  const focus = (ref: React.RefObject<HTMLElement | null>) => {
    window.requestAnimationFrame(() => ref.current?.focus());
  };
  const moveTo = (event: React.KeyboardEvent, ref: React.RefObject<HTMLElement | null>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    focus(ref);
  };
  const submit = () => { if (amountFen !== null && !isSaving && (!returnGiftAmount.trim() || (returnGiftAmountFen !== null && returnGiftAmountFen > 0))) onSubmit({ personName: personName.trim(), address: address.trim(), amountFen, paymentMethod, receivedAt: initial?.receivedAt ?? nowLocalDateTime(), note: note.trim(), returnGift: initial ? returnGift.trim() : "", returnGiftAmountFen, tagIds: selectedTagIds }); };
  const addTag = async () => {
    const name = newTag.trim();
    if (!name) return false;
    try {
      const tag = await onCreateTag(name, newTagColor);
      setNewTag("");
      const nextTags = mergeEntryTag(availableTags, tag);
      setCreatedTags((current) => mergeEntryTag(current, tag));
      setNewTagColor(nextTagColor(nextTags));
      setPromotedTagId(tag.id);
      setSelectedTagIds((current) => current.includes(tag.id) ? current : [...current, tag.id]);
      return true;
    } catch {
      return false;
    }
  };
  const handleTagEnter = async (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (newTag.trim()) await addTag();
    focus(saveRef);
  };
  const toggleTag = (tagId: string) => setSelectedTagIds((current) => current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId]);
  const tagButton = (tag: Tag) => <button type="button" className={`tag-toggle entry-tag-option ${selectedTagIds.includes(tag.id) ? "selected" : ""}`} style={{ "--tag-color": tag.color } as React.CSSProperties} aria-pressed={selectedTagIds.includes(tag.id)} onClick={() => toggleTag(tag.id)} key={tag.id}>{tag.name}<span className="tag-swatch" /></button>;
  useEffect(() => {
    if (!tagsExpanded) return;
    const closeOverflow = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".entry-tag-picker")) setTagsExpanded(false);
    };
    const closeOverflowOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTagsExpanded(false);
    };
    document.addEventListener("pointerdown", closeOverflow);
    window.addEventListener("keydown", closeOverflowOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOverflow);
      window.removeEventListener("keydown", closeOverflowOnEscape);
    };
  }, [tagsExpanded]);
  return <Modal title={title} className="entry-modal" onClose={onClose}><form className="entry-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <div className="form-grid"><label><span className="field-label-row"><span>姓名</span>{duplicateName && <small className="duplicate-name-warning">姓名重复</small>}</span><div className="entry-name-field"><input ref={nameRef} autoFocus value={personName} onChange={(event) => setPersonName(event.target.value)} onKeyDown={(event) => moveTo(event, amountRef)} placeholder="必填" /></div></label><label>金额（元）<input ref={amountRef} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} onKeyDown={(event) => moveTo(event, addressRef)} placeholder="例如 500" /></label></div>
    <div className="form-grid"><label>地址<input ref={addressRef} value={address} onChange={(event) => setAddress(event.target.value)} onKeyDown={(event) => moveTo(event, paymentRef)} placeholder="可选" /></label><label>支付方式<select ref={paymentRef} value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} onKeyDown={(event) => moveTo(event, initial ? returnGiftAmountRef : saveRef)}>{legacyPaymentMethod && <option value={legacyPaymentMethod} hidden>{legacyPaymentMethod}（历史记录）</option>}{PAYMENT_METHOD_OPTIONS.map((method) => <option value={method} key={method}>{method}</option>)}</select></label></div>
    <div className="entry-tags"><div className="entry-tags-heading"><span className="field-label">人物标签</span>{availableTags.length > 0 && <div className="entry-tag-picker"><div className="tag-cloud entry-tag-cloud">{tagSections.visible.map(tagButton)}{tagSections.overflow.length > 0 && <button type="button" className="tag-more-button" aria-expanded={tagsExpanded} onClick={() => setTagsExpanded((expanded) => !expanded)}>{tagsExpanded ? "收起标签" : "更多标签"}</button>}</div>{tagsExpanded && tagSections.overflow.length > 0 && <div className="tag-overflow-popover"><div className="tag-cloud">{tagSections.overflow.map(tagButton)}</div></div>}</div>}</div><div className="entry-tag-create"><input tabIndex={-1} className="tag-color-picker" type="color" value={newTagColor} title="选择新建标签的颜色" aria-label="选择新建标签的颜色" onChange={(event) => setNewTagColor(event.target.value)} /><input ref={tagInputRef} value={newTag} placeholder="例如：同学" onChange={(event) => setNewTag(event.target.value)} onKeyDown={handleTagEnter} /></div></div>
    {initial && <div className="form-grid"><label>回礼金额（元）<input ref={returnGiftAmountRef} inputMode="decimal" value={returnGiftAmount} onChange={(event) => setReturnGiftAmount(event.target.value)} onKeyDown={(event) => moveTo(event, saveRef)} placeholder="可选" /></label><label>回礼备注<input value={returnGift} onChange={(event) => setReturnGift(event.target.value)} placeholder="可选" /></label></div>}
    <label className="wide-field">备注<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="包括不限于随礼、礼品或其他注意事项等" /></label>
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button ref={saveRef} type="submit" className="primary-button" disabled={!valid || isSaving}>{isSaving ? "保存中…" : title === "编辑信息" ? "保存修改" : "保存记录"}</button></div>
  </form></Modal>;
}

function SearchResults({ result, isLoading, isError, onSelect }: { result: SearchResponse | undefined; isLoading: boolean; isError: boolean; onSelect: (hit: SearchHit) => void }) {
  if (isLoading) return <div className="search-results">正在搜索…</div>;
  if (isError) return <div className="search-results search-empty">搜索失败，请重新输入关键词。</div>;
  if (!result?.results.length) return <div className="search-results search-empty"><strong>没有找到匹配人物</strong>{result?.searchedVaults.length ? <SearchScopeSummary summaries={result.searchedVaults} /> : null}</div>;
  return <div className="search-results"><div className="search-result-summary"><strong>找到 {result.totalMatches} 位人物记录</strong><SearchScopeSummary summaries={result.searchedVaults} /></div>{result.results.map((hit) => <button key={`${hit.vaultPath}\u001f${hit.entry.id}`} className="search-result" onClick={() => void onSelect(hit)}><span><strong>{hit.entry.personName}</strong><small>{hit.vaultName} / {hit.bookTitle} · {hit.matchedFields.join("、")}</small></span><b>{formatMoney(hit.entry.amountFen)}</b></button>)}{result.truncated && <span className="search-more">仅显示前 100 条结果</span>}</div>;
}

function SearchScopeSummary({ summaries }: { summaries: SearchResponse["searchedVaults"] }) {
  return <span className="search-scope-summary">搜索范围：{summaries.map((summary) => `${summary.vaultName}（${summary.matchCount}）`).join("、")}</span>;
}

function PinModal({ mode, onClose, onSubmit, onRecover }: { mode: "unlock" | "setup"; onClose: () => void; onSubmit: (pin: string) => void; onRecover: () => void }) {
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const pinIsValid = /^\d{6,12}$/.test(pin);
  const valid = pinIsValid && (mode === "unlock" || pin === confirmation);
  return <Modal title={mode === "setup" ? "首次使用：设置软件管理员 PIN" : "管理员解锁"} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); if (valid) onSubmit(pin); }}><label>软件管理员 PIN<input autoFocus type="password" inputMode="numeric" value={pin} onChange={(event) => setPin(event.target.value)} placeholder="6 至 12 位数字" /></label>{mode === "setup" && <label>确认软件管理员 PIN<input type="password" inputMode="numeric" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="再次输入相同 PIN" /></label>}<p className="field-hint">{mode === "setup" ? "首次使用必须先设置本机管理员 PIN。设置后即可进入工作台并新建礼金库；恢复码只显示一次，请妥善保存。" : "解锁后可新增、修改、删除和导入数据。"}</p><div className="modal-actions">{mode === "unlock" && <button type="button" className="text-button compact" onClick={onRecover}>使用恢复码</button>}{mode === "unlock" && <button type="button" className="secondary-button" onClick={onClose}>取消</button>}<button type="submit" className="primary-button" disabled={!valid}>{mode === "setup" ? "设置并进入工作台" : "解锁"}</button></div></form></Modal>;
}

function PinChangeModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (oldPin: string, newPin: string) => void }) {
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const valid = /^\d{6,12}$/.test(oldPin) && /^\d{6,12}$/.test(newPin) && newPin === confirmation && oldPin !== newPin;
  return <Modal title="修改软件管理员 PIN" onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); if (valid) onSubmit(oldPin, newPin); }}><label>旧管理员 PIN<input autoFocus type="password" inputMode="numeric" value={oldPin} onChange={(event) => setOldPin(event.target.value)} placeholder="输入当前 PIN" /></label><label>新的管理员 PIN<input type="password" inputMode="numeric" value={newPin} onChange={(event) => setNewPin(event.target.value)} placeholder="6 至 12 位数字" /></label><label>确认新的管理员 PIN<input type="password" inputMode="numeric" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="再次输入相同 PIN" /></label><p className="field-hint">修改成功后会生成新的恢复码，旧恢复码将立即失效。</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={!valid}>修改并生成恢复码</button></div></form></Modal>;
}

function RecoveryResetModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (recovery: string, newPin: string) => void }) {
  const [recovery, setRecovery] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const valid = recovery.trim().length > 0 && /^\d{6,12}$/.test(newPin) && newPin === confirmation;
  return <Modal title="使用恢复码重设软件管理员 PIN" onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); if (valid) onSubmit(recovery, newPin); }}><label>软件恢复码<input autoFocus value={recovery} onChange={(event) => setRecovery(event.target.value.toUpperCase())} placeholder="XXXXXX-XXXXXX-XXXXXX-XXXXXX" /></label><label>新的软件管理员 PIN<input type="password" inputMode="numeric" value={newPin} onChange={(event) => setNewPin(event.target.value)} placeholder="6 至 12 位数字" /></label><label>确认新的管理员 PIN<input type="password" inputMode="numeric" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="再次输入相同 PIN" /></label><p className="field-hint">重设成功后会生成新的恢复码，旧恢复码将立即失效。</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={!valid}>重设并解锁</button></div></form></Modal>;
}

function RecoveryCodeModal({ code, onClose }: { code: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); } catch { setCopied(false); }
  };
  return <Modal title="请保存软件恢复码" onClose={onClose}><p className="field-hint">恢复码只显示这一次。忘记软件管理员 PIN 时，需要用它重新设置。</p><div className="recovery-code">{code}</div><div className="modal-actions"><button className="secondary-button" onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "已复制" : "复制恢复码"}</button><button className="primary-button" onClick={onClose}>我已保存</button></div></Modal>;
}

function ConfirmEntryDelete({ entry, onClose, onConfirm }: { entry: GiftEntry; onClose: () => void; onConfirm: () => void }) {
  return <Modal title="删除礼金记录" onClose={onClose}><p className="field-hint">将“{entry.personName}”的 {formatMoney(entry.amountFen)} 移入回收站，之后仍可恢复。</p><div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="danger-button" onClick={onConfirm}>移入回收站</button></div></Modal>;
}

function ConfirmHistoryClear({ selectedCount, isClearing, onClose, onConfirm }: { selectedCount: number; isClearing: boolean; onClose: () => void; onConfirm: () => void }) {
  return <Modal title="删除历史改动" onClose={onClose}><p className="field-hint">{selectedCount > 0 ? `将删除已选中的 ${selectedCount} 条历史改动记录，删除后无法恢复。` : "未选择具体记录，将删除全部历史改动记录。删除后无法恢复。"}</p><div className="modal-actions"><button className="secondary-button" disabled={isClearing} onClick={onClose}>取消</button><button className="danger-button" disabled={isClearing} onClick={onConfirm}>{isClearing ? "正在删除…" : selectedCount > 0 ? "删除选中记录" : "删除全部记录"}</button></div></Modal>;
}

function focusPinConfirmation(event: React.KeyboardEvent<HTMLInputElement>, valid: boolean, confirmRef: React.RefObject<HTMLButtonElement | null>) {
  if (event.key !== "Enter" || event.shiftKey || !valid) return;
  event.preventDefault();
  window.requestAnimationFrame(() => confirmRef.current?.focus());
}

function submitTrashEmptyPin(event: React.KeyboardEvent<HTMLInputElement>, valid: boolean, isClearing: boolean, pin: string, onConfirm: (pin: string) => void) {
  if (event.key !== "Enter" || event.shiftKey || !valid || isClearing) return;
  event.preventDefault();
  onConfirm(pin);
}

function ConfirmBookDelete({ title, onClose, onConfirm }: { title: string; onClose: () => void; onConfirm: (pin: string) => void }) {
  const [pin, setPin] = useState("");
  const confirmRef = useRef<HTMLButtonElement>(null);
  const valid = /^\d{6,12}$/.test(pin);
  return <Modal title="删除礼金簿" onClose={onClose}><p className="field-hint">“{title}”将移入回收站。请输入软件管理员 PIN 确认。</p><label>管理员 PIN<input autoFocus type="password" inputMode="numeric" value={pin} onChange={(event) => setPin(event.target.value)} onKeyDown={(event) => focusPinConfirmation(event, valid, confirmRef)} placeholder="6 至 12 位数字" /></label><div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button ref={confirmRef} type="button" className="danger-button" disabled={!valid} onClick={() => onConfirm(pin)}>移入回收站</button></div></Modal>;
}

function ConfirmTrashEmpty({ isClearing, onClose, onConfirm }: { isClearing: boolean; onClose: () => void; onConfirm: (pin: string) => void }) {
  const [pin, setPin] = useState("");
  const valid = /^\d{6,12}$/.test(pin);
  return <Modal title="清空回收站" onClose={onClose}><p className="field-hint">此操作会永久删除回收站内的礼金簿、礼金记录和人物标签，无法恢复。请输入管理员 PIN 继续。</p><label>管理员 PIN<input autoFocus type="password" inputMode="numeric" value={pin} onChange={(event) => setPin(event.target.value)} onKeyDown={(event) => submitTrashEmptyPin(event, valid, isClearing, pin, onConfirm)} placeholder="6 至 12 位数字" /></label><div className="modal-actions"><button className="secondary-button" disabled={isClearing} onClick={onClose}>取消</button><button type="button" className="danger-button" disabled={!valid || isClearing} onClick={() => onConfirm(pin)}>{isClearing ? "正在清空…" : "永久清空"}</button></div></Modal>;
}

function Modal({ title, onClose, children, className = "" }: { title: string; onClose: () => void; children: React.ReactNode; className?: string }) { return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className={`modal ${className}`}><div className="modal-heading"><h3>{title}</h3><button className="icon-button" title="关闭" onClick={onClose}><X size={17} /></button></div>{children}</div></div>; }

function ErrorToast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 4200);
    return () => window.clearTimeout(timer);
  }, [message, onClose]);
  return <div className="error-toast"><span>{message.replace(/^Error:\s*/, "")}</span><button className="icon-button subtle toast-close" title="关闭提示" onClick={onClose}><X size={14} /></button></div>;
}
function SuccessToast({ message, className = "" }: { message: string; className?: string }) { return <div className={`success-toast ${className}`.trim()}><Check size={16} /><span>{message}</span></div>; }
function OperationHintToast({ message }: { message: string }) { return <div className="operation-hint-toast"><ShieldCheck size={16} /><span>{message}</span></div>; }

export default App;
