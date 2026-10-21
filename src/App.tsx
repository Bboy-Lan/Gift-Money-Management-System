import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Archive,
  ArrowLeft,
  ArrowUpDown,
  BarChart3,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CirclePlus,
  Copy,
  ExternalLink,
  FileSpreadsheet,
  Filter,
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
import { forgetRecentVault, readRecentVaults, recentVaultIdentity, rememberRecentVault, replaceRecentVaultPath, type RecentVault } from "./lib/recentVaults";
import { orderGiftBooks, readComparisonVaults, readGiftBookOrder, rememberGiftBookOrder } from "./lib/comparisonVaults";
import { readOpenedVaultSessions, rememberOpenedVaultSessions, replaceOpenedVaultSessionPath, type OpenedVaultSessionState } from "./lib/openedVaultSessions";
import { readOpenedVaultOrder, rememberOpenedVaultOrder } from "./lib/openedVaultOrder";
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
import wechatDonateImage from "./assets/wechat-donate.png";
import alipayDonateImage from "./assets/alipay-donate.png";

const today = () => new Date().toISOString().slice(0, 10);
const nowLocalDateTime = () => {
  const value = new Date();
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
};

const WELCOME_WINDOW = { width: 390, height: 420, minWidth: 390, minHeight: 420 };
const WORKSPACE_WINDOW = { width: 1120, height: 700, minWidth: 1120, minHeight: 700, maxWidth: 1440, maxHeight: 900 };
const WORKSPACE_SIZE_KEY = "lijin-book.workspace-window-size";

function suggestedVaultFileName(name: string) {
  const clean = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\.+$/, "");
  return `${clean || "我的家庭礼金库"}.giftvault`;
}

function readWorkspaceWindowSize() {
  try {
    const value = JSON.parse(window.localStorage.getItem(WORKSPACE_SIZE_KEY) || "null") as { width?: number; height?: number } | null;
    const width = value?.width;
    const height = value?.height;
    if (typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height) && width >= WORKSPACE_WINDOW.minWidth && height >= WORKSPACE_WINDOW.minHeight) {
      return { width: Math.min(Math.round(width), WORKSPACE_WINDOW.maxWidth), height: Math.min(Math.round(height), WORKSPACE_WINDOW.maxHeight) };
    }
  } catch {
    // Browser previews may not provide usable local storage.
  }
  return { width: WORKSPACE_WINDOW.width, height: WORKSPACE_WINDOW.height };
}
const TAG_COLORS = ["#0f766e", "#2563eb", "#b45309", "#9f1239", "#7c3aed", "#047857", "#be123c", "#0369a1"];
const SPREADSHEET_EXTENSIONS = new Set(["xlsx", "xls", "xlsm", "xlsb", "ods", "csv", "tsv"]);
const SPREADSHEET_MAPPING_FIELDS: Array<[keyof SpreadsheetColumnMapping, string]> = [["name", "姓名"], ["amount", "金额"], ["paymentMethod", "支付方式"], ["address", "地址"], ["note", "备注"], ["tags", "人物标签"], ["returnGiftAmount", "回礼金额"], ["returnGift", "回礼备注"], ["returnGiftedAt", "回礼时间"], ["date", "登记日期"]];
const DEFAULT_IMPORT_PREVIEW_FIELDS: Array<[keyof SpreadsheetColumnMapping, string]> = [["name", "姓名"], ["amount", "金额"], ["paymentMethod", "支付方式"], ["address", "地址"], ["note", "备注"], ["tags", "标签"], ["returnGiftAmount", "回礼金额"], ["returnGift", "回礼备注"], ["returnGiftedAt", "回礼时间"], ["date", "登记日期"]];
type LocalUpdatePhase = "idle" | "checking" | "installing";
type SettingsSection = "general" | "about" | "donate";
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

type EntryFilter = {
  person: string;
  address: string;
  note: string;
  tagIds: string[];
  paymentMethod: string;
  startDate: string;
  endDate: string;
  returnStatus: "all" | "returned" | "not-returned";
};

type EntrySortField = "amount" | "returnAmount" | "receivedAt" | "personName";
type EntrySortDirection = "asc" | "desc";
type EntrySort = { field: EntrySortField; direction: EntrySortDirection } | null;

const EMPTY_ENTRY_FILTER: EntryFilter = { person: "", address: "", note: "", tagIds: [], paymentMethod: "", startDate: "", endDate: "", returnStatus: "all" };

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
  const [openedVaultOrder, setOpenedVaultOrder] = useState<string[]>(() => readOpenedVaultOrder());
  const [bookSelections, setBookSelections] = useState<Record<string, string | null>>({});
  const [workspaceTab, setWorkspaceTab] = useState<Tab>("entries");
  const [session, setSession] = useState<SessionStatus>({ role: "viewer", securityConfigured: false, editLocked: true });
  const [error, setError] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [createVaultOpen, setCreateVaultOpen] = useState(false);
  const [defaultStorageSetupOpen, setDefaultStorageSetupOpen] = useState(false);
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
  const restoringWindowRef = useRef(0);
  const [localUpdatePhase, setLocalUpdatePhase] = useState<LocalUpdatePhase>("idle");
  const [lastUpdateCheckAt, setLastUpdateCheckAt] = useState<string | null>(null);
  const [continuousRegistration, setContinuousRegistration] = useState(true);
  const [pendingSpreadsheetPaths, setPendingSpreadsheetPaths] = useState<string[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const localUpdate = useQuery({ queryKey: ["local-update"], queryFn: api.localUpdateStatus, enabled: false, retry: false });

  useEffect(() => {
    void localUpdate.refetch().then((result) => {
      setLastUpdateCheckAt(new Date().toISOString());
      if (result.data?.candidate) showNotice(`发现 v${result.data.candidate.version} 可用更新，可在“关于”页面查看`);
    }).catch(() => {
      // 启动时检查失败不阻断进入软件，用户仍可在“关于”页面手动重试。
    });
  }, []);

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
    const target = isWorkspace ? { ...WORKSPACE_WINDOW, ...readWorkspaceWindowSize() } : WELCOME_WINDOW;
    const resizeWindow = async () => {
      try {
        const windowHandle = getCurrentWindow();
        restoringWindowRef.current = Date.now() + 800;
        await windowHandle.setDecorations(isWorkspace);
        await windowHandle.setResizable(isWorkspace);
        await windowHandle.setSizeConstraints(isWorkspace ? { minWidth: target.minWidth, minHeight: target.minHeight, maxWidth: WORKSPACE_WINDOW.maxWidth, maxHeight: WORKSPACE_WINDOW.maxHeight } : { minWidth: target.minWidth, minHeight: target.minHeight });
        await windowHandle.setSize(new LogicalSize(target.width, target.height));
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

  useEffect(() => {
    if (!(workspaceOpen || vault)) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onResized(({ payload }) => {
      if (!active) return;
      if (Date.now() < restoringWindowRef.current) return;
      const { width, height } = payload;
      void Promise.all([getCurrentWindow().isMaximized(), getCurrentWindow().scaleFactor()]).then(([maximized, scaleFactor]) => {
        if (!active || maximized) return;
        const logicalWidth = Math.round(width / scaleFactor);
        const logicalHeight = Math.round(height / scaleFactor);
        if (logicalWidth < WORKSPACE_WINDOW.minWidth || logicalHeight < WORKSPACE_WINDOW.minHeight || logicalWidth > WORKSPACE_WINDOW.maxWidth || logicalHeight > WORKSPACE_WINDOW.maxHeight) return;
        window.localStorage.setItem(WORKSPACE_SIZE_KEY, JSON.stringify({ width: logicalWidth, height: logicalHeight }));
      }).catch(() => {});
    }).then((cleanup) => { unlisten = cleanup; }).catch(() => {});
    return () => { active = false; unlisten?.(); };
  }, [workspaceOpen || Boolean(vault)]);

  const rememberOpenedVault = useCallback((info: VaultInfo, book?: Pick<GiftBook, "id" | "title">) => {
    setRecentVaults(rememberRecentVault(info, book));
  }, []);
  const handleVaultUpdated = useCallback((updated: VaultInfo, previousPath = updated.path) => {
    const previousKey = vaultPathKey(previousPath);
    const nextKey = vaultPathKey(updated.path);
    setVault(updated);
    setOpenedVaults((current) => {
      const next = current.map((item) => vaultPathKey(item.vault.path) === previousKey ? { ...item, vault: updated } : item);
      rememberOpenedVaultSessions(next.map((item) => ({ path: item.vault.path, activeBookId: item.activeBookId, activeTab: item.activeTab })), updated.path);
      return next;
    });
    if (previousKey !== nextKey) {
      setBookSelections((current) => {
        const next = { ...current, [nextKey]: current[previousKey] ?? null };
        delete next[previousKey];
        return next;
      });
      setOpenedVaultOrder((current) => rememberOpenedVaultOrder(current.map((path) => vaultPathKey(path) === previousKey ? updated.path : path)));
      setRecentVaults(replaceRecentVaultPath(previousPath, updated.path));
      replaceOpenedVaultSessionPath(previousPath, updated.path);
    }
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
  const reorderOpenedVaults = useCallback((draggedPath: string, targetPath: string) => {
    setOpenedVaults((current) => {
      const next = [...current];
      const from = next.findIndex((item) => vaultPathKey(item.vault.path) === vaultPathKey(draggedPath));
      const to = next.findIndex((item) => vaultPathKey(item.vault.path) === vaultPathKey(targetPath));
      if (from < 0 || to < 0 || from === to) return current;
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      setOpenedVaultOrder(rememberOpenedVaultOrder(next.map((entry) => entry.vault.path)));
      return next;
    });
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
    const preferredKey = preferredPath ? vaultPathKey(preferredPath) : null;
    if (!savedSessions.length) return false;
    const restored: Array<{ session: OpenedVaultSessionState; result: Awaited<ReturnType<typeof api.openVault>> }> = [];
    const invalidPaths: string[] = [];
    for (const saved of savedSessions) {
      try {
        restored.push({ session: saved, result: await api.openVault(saved.path) });
      } catch {
        invalidPaths.push(saved.path);
      }
    }
    if (!restored.length) {
      const saved = savedSessions[0];
      setError(`上次打开的礼金库路径已失效或内容已变化：${saved.path}。请使用“打开礼金库”重新选择文件`);
      return false;
    }
    const active = (preferredKey ? restored.find((item) => vaultPathKey(item.session.path) === preferredKey) : undefined) ?? restored[0];
    if (invalidPaths.length) setError(`有 ${invalidPaths.length} 个上次打开的礼金库路径已失效，请重新选择文件打开：${invalidPaths[0]}`);
    const activeResult = await api.openVault(active.session.path);
    client.clear();
    setOpenedVaults(restored.map(({ session, result }) => ({ vault: result.vault, activeBookId: session.activeBookId, activeTab: session.activeTab })));
    setOpenedVaultOrder(readOpenedVaultOrder());
    setBookSelections(Object.fromEntries(restored.map(({ session, result }) => [vaultPathKey(result.vault.path), session.activeBookId])));
    setPendingWorkspaceBookId(active.session.activeBookId);
    setVault(activeResult.vault);
    setWorkspaceOpen(true);
    setWorkspaceTab("entries");
    setSession((current) => ({ ...current, role: activeResult.role, editLocked: activeResult.role === "admin" ? current.editLocked : true }));
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

  const closeOpenedVault = async (path: string) => {
    const key = vaultPathKey(path);
    const remaining = openedVaults.filter((item) => vaultPathKey(item.vault.path) !== key);
    rememberOpenedVaultSessions(
      remaining.map((item) => ({ path: item.vault.path, activeBookId: item.activeBookId, activeTab: item.activeTab })),
      remaining[0]?.vault.path,
    );
    if (!remaining.length) {
      await returnToStartPage();
      showNotice("已关闭礼金库；原始礼金库文件和数据未删除");
      return;
    }
    if (!vault || vaultPathKey(vault.path) !== key) {
      setOpenedVaults(remaining);
      return;
    }
    const next = remaining[0];
    try {
      const result = await api.openVault(next.vault.path);
      client.clear();
      setOpenedVaults(remaining.map((item) => item.vault.path === next.vault.path ? { ...item, vault: result.vault } : item));
      setBookSelections((current) => ({ ...current, [vaultPathKey(next.vault.path)]: next.activeBookId }));
      setPendingWorkspaceBookId(next.activeBookId);
      setVault(result.vault);
      setWorkspaceTab(next.activeTab);
      setSession((current) => ({ ...current, role: result.role, editLocked: result.role === "admin" ? current.editLocked : true }));
      showNotice(`已关闭「${vault.name}」，当前显示「${result.vault.name}」`);
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
      const path = await api.chooseVaultPath("save", suggestedVaultFileName(vaultName));
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

  const beginCreateVault = async () => {
    setError(null);
    try {
      const storage = await api.settingsStorageInfo();
      if (!storage.configured) {
        setDefaultStorageSetupOpen(true);
        return;
      }
      setCreateVaultOpen(true);
    } catch (err) {
      setError(String(err));
    }
  };

  const configureDefaultStorageAndCreate = async () => {
    try {
      const storage = await api.chooseSettingsDirectory();
      if (!storage) return;
      setDefaultStorageSetupOpen(false);
      setCreateVaultOpen(true);
      showNotice(`默认礼金库文件夹已设为：${storage.directory}`);
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
      const wasSetup = adminPrompt === "setup";
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
        if (wasSetup && !vault && !pendingWorkspaceVault) showNotice("管理员模式已进入工作台，请先新建礼金库或打开已有礼金库");
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
    {defaultStorageSetupOpen && <DefaultStorageSetupModal onClose={() => setDefaultStorageSetupOpen(false)} onChoose={() => void configureDefaultStorageAndCreate()} />}
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
    <WorkspaceStart session={session} pendingSpreadsheetPaths={pendingSpreadsheetPaths} onClose={returnToStartPage} onOpenVault={openVault} onBeginCreate={() => void beginCreateVault()} onChooseImport={() => void chooseSpreadsheetPathsForWorkspace()} onChangePin={() => setPinChangeOpen(true)} />
      {createVaultOpen && <CreateVaultModal vaultName={vaultName} vaultNotes={vaultNotes} onNameChange={setVaultName} onNotesChange={setVaultNotes} onClose={() => setCreateVaultOpen(false)} onCreate={createVault} />}
      {overlays}
    </>;
  }

  const orderedOpenedVaults = [...openedVaults].sort((left, right) => {
    const leftIndex = openedVaultOrder.findIndex((path) => vaultPathKey(path) === vaultPathKey(left.vault.path));
    const rightIndex = openedVaultOrder.findIndex((path) => vaultPathKey(path) === vaultPathKey(right.vault.path));
    return (leftIndex < 0 ? openedVaults.length : leftIndex) - (rightIndex < 0 ? openedVaults.length : rightIndex);
  });
  return <>
    <VaultWorkspace key={vault.path} vault={vault} openedVaults={orderedOpenedVaults} initialBookId={pendingWorkspaceBookId} initialTab={workspaceTab} session={session} continuousRegistration={continuousRegistration} onContinuousRegistrationChange={setContinuousRegistration} onClose={returnToStartPage} onCloseVault={closeOpenedVault} onReorderVaults={reorderOpenedVaults} onError={setError} onNotice={showNotice} onUnlock={() => { setEnterWorkspaceAfterAdmin(false); setPendingWorkspaceVault(null); setAdminPrompt(session.securityConfigured ? "unlock" : "setup"); }} onLock={lockAdmin} onUnlockEditing={unlockEditing} onLockEditing={lockEditing} onChangePin={() => setPinChangeOpen(true)} onCheckLocalUpdate={checkLocalUpdate} onInstallLocalUpdate={installLocalUpdate} localUpdatePhase={localUpdatePhase} updateStatus={localUpdate.data ?? null} lastUpdateCheckAt={lastUpdateCheckAt} pendingSpreadsheetPaths={pendingSpreadsheetPaths} onConsumeSpreadsheetPaths={() => setPendingSpreadsheetPaths([])} onBeginCreateVault={() => void beginCreateVault()} onOpenVault={openVault} onSwitchVault={switchVault} onOpenSearchVault={openSearchVault} onBookSelectionChange={handleBookSelectionChange} onTabChange={handleTabChange} onVaultActivity={handleVaultActivity} onVaultUpdated={handleVaultUpdated} />
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

function BookMetadata({ book }: { book: GiftBook }) {
  const timeAndLocation = [`活动时间：${book.eventDate ?? "未填写"}`, `地点：${book.location ?? "未填写"}`].join(" · ");
  return <div className="book-metadata"><p>活动类型：{book.occasion || "未填写"}</p><p>{timeAndLocation}</p><p>备注：{book.notes ?? "未填写"}</p></div>;
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
        <section className="recent-vaults welcome-recent"><div className="recent-heading"><span>最近使用</span></div><div className="recent-vault-list" ref={recentListRef}>{props.recentVaults.length > 0 ? props.recentVaults.map((recent) => <article className="recent-vault-item" key={recentVaultIdentity(recent)}><button className="recent-vault-button" type="button" title={`以用户模式打开「${recent.name}」`} onClick={() => props.onUserMode(recent)}><FolderOpen size={17} /><span><strong>{recent.name}</strong><small title={recent.path}>{recent.path}</small></span></button><button className={`icon-button subtle recent-vault-action recent-vault-admin ${props.session.role === "admin" ? "active" : ""}`} type="button" title={`以管理员模式打开「${recent.name}」`} aria-label={`以管理员模式打开「${recent.name}」`} onClick={() => props.onAdminMode(recent)}><ShieldCheck size={16} /></button><button className="icon-button subtle recent-vault-action recent-vault-remove" type="button" title={`从启动页移除「${recent.name}」；不会删除礼金库或礼金数据`} aria-label={`从启动页移除「${recent.name}」；不会删除礼金库或礼金数据`} onClick={() => props.onRemoveRecent(recent)}><X size={16} /></button></article>) : <div className="recent-empty">暂无使用记录</div>}</div></section>
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

function DefaultStorageSetupModal({ onClose, onChoose }: { onClose: () => void; onChoose: () => void }) {
  return <Modal title="设置默认礼金库文件夹" onClose={onClose}><p className="field-hint">首次新建前，请选择默认保存文件夹。已默认定位到桌面；以后可在“设置”中更改，且不会移动已有礼金库。</p><div className="modal-actions"><button className="secondary-button" onClick={onClose}>暂不新建</button><button className="primary-button" onClick={onChoose}><FolderOpen size={16} />选择默认文件夹</button></div></Modal>;
}

function OpenedVaultTab({ item, active, canEdit, dragged, dropTarget, onSwitch, onClose, onEdit, onDragState, onDrop }: { item: OpenedVaultSession; active: boolean; canEdit: boolean; dragged: boolean; dropTarget: boolean; onSwitch: (path: string) => void; onClose: (path: string) => void; onEdit: () => void; onDragState: (path: string | null, target: string | null) => void; onDrop: (path: string, target: string | null) => void }) {
  const [showClose, setShowClose] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);
  const dragTimerRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const suppressClickRef = useRef(false);
  const dragTargetPathRef = useRef<string | null>(null);
  const beginHover = () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => setShowClose(true), 700);
  };
  const endHover = () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    setShowClose(false);
  };
  useEffect(() => () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    if (dragTimerRef.current !== null) window.clearTimeout(dragTimerRef.current);
  }, []);
  const startDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const pointerId = event.pointerId;
    if (dragTimerRef.current !== null) window.clearTimeout(dragTimerRef.current);
    dragTimerRef.current = window.setTimeout(() => {
      draggingRef.current = true;
      suppressClickRef.current = true;
      dragTargetPathRef.current = item.vault.path;
      onDragState(item.vault.path, item.vault.path);
      event.currentTarget.setPointerCapture?.(pointerId);
    }, 350);
  };
  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (!draggingRef.current) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-vault-path]");
    dragTargetPathRef.current = target?.dataset.vaultPath ?? dragTargetPathRef.current ?? item.vault.path;
    onDragState(item.vault.path, dragTargetPathRef.current);
  };
  const finishDrag = () => {
    if (dragTimerRef.current !== null) window.clearTimeout(dragTimerRef.current);
    dragTimerRef.current = null;
    if (draggingRef.current) onDrop(item.vault.path, dragTargetPathRef.current);
    draggingRef.current = false;
    dragTargetPathRef.current = null;
    onDragState(null, null);
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  };
  useEffect(() => {
    if (!draggingRef.current) return;
    const trackWindowPointer = (event: PointerEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-vault-path]");
      if (!target) return;
      dragTargetPathRef.current = target.dataset.vaultPath ?? dragTargetPathRef.current;
      onDragState(item.vault.path, dragTargetPathRef.current);
    };
    window.addEventListener("pointermove", trackWindowPointer, true);
    return () => window.removeEventListener("pointermove", trackWindowPointer, true);
  }, [item.vault.path, onDragState]);
  return <div className={`opened-vault-tab ${active ? "active" : ""} ${dragged ? "dragging" : ""} ${dropTarget ? "drag-target" : ""}`} data-vault-path={item.vault.path} title={item.vault.path} onMouseEnter={beginHover} onMouseLeave={endHover} onFocusCapture={() => setShowClose(true)} onBlurCapture={endHover}><button type="button" className="opened-vault-tab-select" aria-pressed={active} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag} onClick={() => { if (!suppressClickRef.current) onSwitch(item.vault.path); }}><Archive size={14} /><span>{item.vault.name}</span></button>{active && canEdit && <button type="button" className="opened-vault-tab-edit" aria-label={`编辑礼金库「${item.vault.name}」`} title="编辑礼金库" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onEdit(); }}><Pencil size={13} /></button>}{showClose && <button type="button" className="opened-vault-tab-close" aria-label={`关闭礼金库「${item.vault.name}」`} title={`关闭「${item.vault.name}」；不会删除原始文件`} onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onClose(item.vault.path); }}><X size={13} /></button>}</div>;
}

function BookListItem({ book, active, dragged, dropTarget, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onSelect, onClose }: { "data-book-id"?: string; book: GiftBook; active: boolean; dragged: boolean; dropTarget: boolean; onPointerDown: (event: React.PointerEvent<HTMLElement>) => void; onPointerMove: (event: React.PointerEvent<HTMLElement>) => void; onPointerUp: () => void; onPointerCancel: () => void; onSelect: () => void; onClose: () => void }) {
  const [showClose, setShowClose] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);
  const beginHover = () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => setShowClose(true), 700);
  };
  const endHover = () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    setShowClose(false);
  };
  useEffect(() => () => { if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current); }, []);
  return <div className={`book-item-row ${dragged ? "dragging" : ""} ${dropTarget ? "drag-target" : ""}`} data-book-id={book.id} onMouseEnter={beginHover} onMouseLeave={endHover} onFocusCapture={() => setShowClose(true)} onBlurCapture={endHover}><button type="button" className={`book-item ${active ? "active" : ""}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onClick={onSelect}><span className="book-icon"><FileSpreadsheet size={15} /></span><span className="book-item-text"><strong>{book.title}</strong></span><ChevronRight size={15} /></button>{showClose && <button type="button" className="book-item-close" title={`关闭礼金簿“${book.title}”`} aria-label={`关闭礼金簿“${book.title}”；不会删除数据`} onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onClose(); }}><X size={13} /></button>}</div>;
}

function VaultMetadataModal({ vault, isSaving, onClose, onSubmit, onChoosePath }: { vault: VaultInfo; isSaving: boolean; onClose: () => void; onSubmit: (name: string, notes: string, path: string) => void; onChoosePath: () => Promise<string | null> }) {
  const [name, setName] = useState(vault.name);
  const [notes, setNotes] = useState(vault.notes ?? "");
  const [path, setPath] = useState(vault.path);
  const [choosingPath, setChoosingPath] = useState(false);
  const choosePath = async () => {
    setChoosingPath(true);
    try {
      const selected = await onChoosePath();
      if (selected) setPath(selected);
    } finally {
      setChoosingPath(false);
    }
  };
  return <Modal title="编辑礼金库" onClose={onClose}><label>礼金库名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label><label>礼金库路径<div className="vault-path-picker"><input value={path} readOnly title={path} /><button type="button" className="secondary-button compact" disabled={isSaving || choosingPath} onClick={() => void choosePath()}>{choosingPath ? "选择中…" : "编辑礼金库路径"}</button></div></label><label>礼金库备注<textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="可选" /></label><p className="field-hint">修改路径会先创建可打开的库快照，再移动 `.giftvault` 文件；原路径不保留副本。名称和备注不改变内部礼金簿、人物或礼金记录的归属。</p><div className="modal-actions"><button className="secondary-button" disabled={isSaving || choosingPath} onClick={onClose}>取消</button><button className="primary-button" disabled={!name.trim() || !path.trim() || isSaving || choosingPath} onClick={() => onSubmit(name.trim(), notes.trim(), path.trim())}>{isSaving ? "保存中…" : "保存修改"}</button></div></Modal>;
}

function VaultWorkspace({ vault, openedVaults, initialBookId, initialTab, session, continuousRegistration, onContinuousRegistrationChange, onClose, onCloseVault, onReorderVaults, onError, onNotice, onUnlock, onLock, onUnlockEditing, onLockEditing, onChangePin, onCheckLocalUpdate, onInstallLocalUpdate, localUpdatePhase, updateStatus, lastUpdateCheckAt, pendingSpreadsheetPaths, onConsumeSpreadsheetPaths, onBeginCreateVault, onOpenVault, onSwitchVault, onOpenSearchVault, onBookSelectionChange, onTabChange, onVaultActivity, onVaultUpdated }: { vault: VaultInfo; openedVaults: OpenedVaultSession[]; initialBookId: string | null; initialTab: Tab; session: SessionStatus; continuousRegistration: boolean; onContinuousRegistrationChange: (enabled: boolean) => void; onClose: () => void; onCloseVault: (path: string) => void | Promise<void>; onReorderVaults: (draggedPath: string, targetPath: string) => void; onError: (message: string) => void; onNotice: (message: string) => void; onUnlock: () => void; onLock: () => void; onUnlockEditing: () => void; onLockEditing: () => void; onChangePin: () => void; onCheckLocalUpdate: () => void; onInstallLocalUpdate: () => void; localUpdatePhase: LocalUpdatePhase; updateStatus: import("./types").LocalUpdateStatus | null; lastUpdateCheckAt: string | null; pendingSpreadsheetPaths: string[]; onConsumeSpreadsheetPaths: () => void; onBeginCreateVault: () => void; onOpenVault: () => void; onSwitchVault: (path: string) => void; onOpenSearchVault: (path: string, bookId: string) => Promise<void>; onBookSelectionChange: (bookId: string | null) => void; onTabChange: (tab: Tab) => void; onVaultActivity: (book?: Pick<GiftBook, "id" | "title">) => void; onVaultUpdated: (vault: VaultInfo, previousPath?: string) => void }) {
  const client = useQueryClient();
  const [activeBookId, setActiveBookId] = useState<string | null>(initialBookId);
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [bookModal, setBookModal] = useState(false);
  const [bookToClose, setBookToClose] = useState<GiftBook | null>(null);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const fileInfoWrapRef = useRef<HTMLDivElement>(null);
  const [fileInfoOpen, setFileInfoOpen] = useState(false);
  const [focusedEntryId, setFocusedEntryId] = useState<string | null>(null);
  const [spreadsheetPaths, setSpreadsheetPaths] = useState<string[]>([]);
  const [spreadsheetImportOpen, setSpreadsheetImportOpen] = useState(false);
  const [spreadsheetImporting, setSpreadsheetImporting] = useState(false);
  const [spreadsheetImportPhase, setSpreadsheetImportPhase] = useState("正在准备导入");
  const [vaultEditOpen, setVaultEditOpen] = useState(false);
  const [vaultEditSaving, setVaultEditSaving] = useState(false);
  const [vaultToClose, setVaultToClose] = useState<{ path: string; name: string } | null>(null);
  const [bookEditOpen, setBookEditOpen] = useState(false);
  const [bookEditSaving, setBookEditSaving] = useState(false);
  const [trashDropActive, setTrashDropActive] = useState(false);
  const [bookOrder, setBookOrder] = useState<string[]>(() => readGiftBookOrder(vault.path));
  const [closedBookIds, setClosedBookIds] = useState<Set<string>>(() => new Set());
  const [draggedBookId, setDraggedBookId] = useState<string | null>(null);
  const draggedBookIdRef = useRef<string | null>(null);
  const bookDragTimerRef = useRef<number | null>(null);
  const bookDragPointerRef = useRef<number | null>(null);
  const bookDropTargetRef = useRef<string | null>(null);
  const [bookDropTargetId, setBookDropTargetId] = useState<string | null>(null);
  const [draggedVaultPath, setDraggedVaultPath] = useState<string | null>(null);
  const [vaultDropTargetPath, setVaultDropTargetPath] = useState<string | null>(null);
  const draggedVaultPathRef = useRef<string | null>(null);
  const suppressBookClickRef = useRef(false);
  const debouncedSearch = useDebouncedValue(search, 200);
  const isAdmin = session.role === "admin";
  const canEdit = isAdmin && !session.editLocked;
  const activeScrollContainerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const isScrollable = (element: HTMLElement, horizontal: boolean) => {
      const style = window.getComputedStyle(element);
      const overflow = horizontal ? style.overflowX : style.overflowY;
      return (overflow === "auto" || overflow === "scroll" || overflow === "overlay") && (horizontal ? element.scrollWidth > element.clientWidth : element.scrollHeight > element.clientHeight);
    };
    const findScrollable = (start: HTMLElement | null, horizontal: boolean) => {
      let current = start;
      while (current) {
        if (isScrollable(current, horizontal) && current.closest(`.content-view.${activeTab}`)) return current;
        current = current.parentElement;
      }
      const page = document.querySelector<HTMLElement>(`.content-view.${activeTab}`);
      if (!page) return null;
      return [page, ...Array.from(page.querySelectorAll<HTMLElement>("[data-scroll-container], .table-wrap, .table-panel, .history-panel"))].find((element) => isScrollable(element, horizontal)) ?? page;
    };
    const rememberScrollContext = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || target.closest("input, textarea, select, button, [contenteditable='true'], [role='dialog']")) return;
      const page = target.closest<HTMLElement>(`.content-view.${activeTab}`);
      if (!page) return;
      const horizontal = page.scrollWidth > page.clientWidth;
      activeScrollContainerRef.current = findScrollable(target, horizontal) || page;
    };
    const scrollPageWithArrow = (event: KeyboardEvent) => {
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, button, [contenteditable='true'], [role='dialog']")) return;
      const page = document.querySelector<HTMLElement>(`.content-view.${activeTab}`);
      if (!page) return;
      const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
      let scrollable = activeScrollContainerRef.current?.closest(`.content-view.${activeTab}`) ? activeScrollContainerRef.current : null;
      if (!scrollable || !isScrollable(scrollable, horizontal)) scrollable = findScrollable(target, horizontal) || page;
      const canScroll = isScrollable(scrollable, horizontal) || (horizontal ? scrollable.scrollWidth > scrollable.clientWidth : scrollable.scrollHeight > scrollable.clientHeight);
      if (!canScroll) return;
      event.preventDefault();
      const distance = 72;
      scrollable.scrollBy({ left: horizontal ? (event.key === "ArrowRight" ? distance : -distance) : 0, top: horizontal ? 0 : (event.key === "ArrowDown" ? distance : -distance), behavior: "auto" });
    };
    window.addEventListener("pointerdown", rememberScrollContext, true);
    window.addEventListener("keydown", scrollPageWithArrow, true);
    return () => { window.removeEventListener("pointerdown", rememberScrollContext, true); window.removeEventListener("keydown", scrollPageWithArrow, true); };
  }, [activeTab]);
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
  const openedVaultBooks = useQuery({ queryKey: ["opened-vault-books", openedVaults.map((item) => item.vault.path)], queryFn: async () => (await Promise.all(openedVaults.map(async (item) => ({ vaultPath: item.vault.path, vaultName: item.vault.name, books: await api.listBooksForVault(item.vault.path) })))).flatMap((item) => item.books.map((book) => ({ ...book, vaultPath: item.vaultPath, vaultName: item.vaultName }))), enabled: openedVaults.length > 0 });
  const orderedBooks = useMemo(() => orderGiftBooks(books.data ?? [], bookOrder).filter((book) => !closedBookIds.has(book.id)), [books.data, bookOrder, closedBookIds]);
  const searchResults = useQuery({ queryKey: ["vault-search", openedSearchKey, debouncedSearch], queryFn: () => api.searchVault(debouncedSearch, openedSearchPaths), enabled: searchOpen && Boolean(debouncedSearch.trim()) });
  useEffect(() => {
    if (!books.data) return;
    const nextBookId = resolveInitialBookId(activeBookId, books.data);
    if (nextBookId !== activeBookId) setActiveBookId(nextBookId);
  }, [activeBookId, books.data]);
  useEffect(() => {
    setBookOrder(readGiftBookOrder(vault.path));
    setClosedBookIds(new Set());
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
  const editVault = async (name: string, notes: string, path: string) => {
    setVaultEditSaving(true);
    try {
      const updated = await api.editVault(name, notes, path);
      const moved = vaultPathKey(updated.path) !== vaultPathKey(vault.path);
      if (moved) client.clear();
      onVaultUpdated(updated, vault.path);
      setVaultEditOpen(false);
      onNotice(moved ? "礼金库信息已更新，文件已移动到新路径" : "礼金库信息已更新");
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
  const startBookDrag = (event: React.PointerEvent<HTMLElement>, bookId: string) => {
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
  const moveBookDrag = (event: React.PointerEvent<HTMLElement>) => {
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

  const handleVaultDragState = useCallback((path: string | null, target: string | null) => {
    if (!path) {
      draggedVaultPathRef.current = null;
      setDraggedVaultPath(null);
      setVaultDropTargetPath(null);
      return;
    }
    draggedVaultPathRef.current = path;
    setDraggedVaultPath(path);
    setVaultDropTargetPath(target);
    if (target && vaultPathKey(path) !== vaultPathKey(target)) {
      const currentTarget = vaultDropTargetPath;
      if (!currentTarget || vaultPathKey(currentTarget) !== vaultPathKey(target)) {
        onReorderVaults(path, target);
      }
    }
  }, [onReorderVaults, vaultDropTargetPath]);

  const closeBook = (book: GiftBook) => {
    setBookToClose(book);
  };

  const confirmCloseBook = () => {
    const book = bookToClose;
    if (!book) return;
    setBookToClose(null);
    setClosedBookIds((current) => new Set(current).add(book.id));
    if (activeBookId === book.id) {
      const nextBook = orderedBooks.find((candidate) => candidate.id !== book.id);
      setActiveBookId(nextBook?.id ?? null);
    }
    onNotice(`已关闭礼金簿“${book.title}”；原始数据未删除`);
  };

  const reopenClosedBooks = () => {
    setClosedBookIds(new Set());
    onNotice("已重新显示当前礼金库中的礼金簿");
  };

  const showBookNavigation = activeTab === "entries" || activeTab === "people" || activeTab === "compare";
  return (
    <div className="app-shell" onPointerDown={() => activityRef.current()} onKeyDown={() => activityRef.current()}>
      <header className="topbar">
        <div className="topbar-brand"><div className="brand-mark small"><BookOpen size={17} /></div><strong>礼金簿管理</strong><span className="slash">/</span><span className="vault-label">{activeBook?.title ?? vault.name}</span></div>
          <div className="topbar-actions">{updateStatus?.candidate && <button className="primary-button compact workspace-update-button" disabled={localUpdatePhase !== "idle"} onClick={onInstallLocalUpdate}><RefreshCw className={localUpdatePhase !== "idle" ? "is-spinning" : undefined} size={14} />{localUpdatePhase === "installing" ? "正在更新…" : `软件更新 v${updateStatus.candidate.version}`}</button>}<div className="global-search-wrap" ref={searchWrapRef}><label className="tag-search-field" aria-label="全库搜索"><Search size={16} /><input id="vault-global-search" value={search} onFocus={() => setSearchOpen(true)} onChange={(event) => { const value = event.target.value; setSearch(value); setSearchOpen(Boolean(value.trim())); }} placeholder="搜索姓名、金额、地址、标签等" /></label>{searchOpen && search.trim() && <SearchResults result={searchResults.data} isLoading={searchResults.isLoading} isError={searchResults.isError} onSelect={openSearchHit} />}</div><div className="file-info-wrap" ref={fileInfoWrapRef}><button className="offline-pill button-reset" onClick={() => setFileInfoOpen((open) => !open)}><span className="status-dot" />{isAdmin ? "管理员模式" : "用户模式"}</button>{fileInfoOpen && <div className="file-info-popover"><strong>{vault.name}</strong>{vault.notes && <span className="file-info-notes">{vault.notes}</span>}<span className="file-path">{vault.path}</span><span className={`role-badge ${isAdmin ? "admin" : "viewer"}`}>{isAdmin ? "管理员模式" : "用户模式"}</span><div className="popover-actions">{isAdmin && <button aria-pressed={continuousRegistration} className={`secondary-button compact continuous-registration-button ${continuousRegistration ? "active" : ""}`} disabled={!canEdit} data-operation-hint={!canEdit ? "提示：请先解锁编辑，再开始持续登记。" : continuousRegistration ? "提示：持续登记已开启，保存后会自动进入下一条；点击可关闭。" : "提示：点击开启持续登记，保存后会自动进入下一条。"} onClick={() => onContinuousRegistrationChange(!continuousRegistration)}>{continuousRegistration ? <Unlock size={14} /> : <LockKeyhole size={14} />}{continuousRegistration ? "持续登记：已开启" : "持续登记：已关闭"}</button>}{isAdmin && <button className="secondary-button compact" data-operation-hint={session.editLocked ? "提示：解锁后可执行删除和重要资料修改。" : "提示：锁定后将暂停高风险修改与删除。"} onClick={session.editLocked ? onUnlockEditing : onLockEditing}><LockKeyhole size={14} />{session.editLocked ? "解锁编辑" : "锁定编辑"}</button>}{isAdmin ? <button className="secondary-button compact" title="切换到用户模式" onClick={onLock}><LockKeyhole size={14} />切换模式</button> : <button className="primary-button compact" onClick={onUnlock}><Unlock size={14} />解锁管理</button>}<button className="secondary-button compact" title="返回启动页" onClick={onClose}><ArrowLeft size={15} />返回启动页</button></div></div>}</div>{activeTab !== "entries" && <button className="secondary-button compact return-detail-button topbar-return-detail" title="返回明细" onClick={() => setActiveTab("entries")}><ArrowLeft size={15} />返回明细</button>}</div>
      </header>
      <nav className="opened-vault-tabs" aria-label="已打开礼金库">
        <div className="opened-vault-tabs-list">
          {openedVaults.map((item) => <OpenedVaultTab item={item} active={vaultPathKey(item.vault.path) === vaultPathKey(vault.path)} canEdit={canEdit} dragged={vaultPathKey(item.vault.path) === vaultPathKey(draggedVaultPath ?? "")} dropTarget={vaultPathKey(item.vault.path) === vaultPathKey(vaultDropTargetPath ?? "") && vaultPathKey(item.vault.path) !== vaultPathKey(draggedVaultPath ?? "")} key={vaultPathKey(item.vault.path)} onSwitch={onSwitchVault} onClose={(path) => setVaultToClose({ path, name: openedVaults.find((candidate) => vaultPathKey(candidate.vault.path) === vaultPathKey(path))?.vault.name ?? "该礼金库" })} onEdit={() => setVaultEditOpen(true)} onDragState={handleVaultDragState} onDrop={() => handleVaultDragState(null, null)} />)}
        </div>
      </nav>
      <div className="workspace">
        <aside className="sidebar">
          {isAdmin && <button className="sidebar-create" onClick={onBeginCreateVault}><Archive size={16} />新建礼金库</button>}
          <button className="sidebar-create sidebar-open" onClick={onOpenVault}><FolderOpen size={16} />打开礼金库</button>
          <button className="sidebar-create sidebar-book-create" disabled={!canEdit} title={isAdmin && !canEdit ? "请先解锁编辑" : undefined} onClick={() => setBookModal(true)}><CirclePlus size={16} />新建礼金簿</button>
          <button className="sidebar-create sidebar-import" disabled={!isAdmin || !canEdit} title={isAdmin && !canEdit ? "请先解锁编辑" : undefined} onClick={async () => { if (!isAdmin) { onUnlock(); return; } if (!canEdit) return; try { const paths = await api.chooseSpreadsheetPaths(); if (paths.length) openSpreadsheetImport(paths); } catch (err) { onError(String(err)); } }}><FileSpreadsheet size={15} />导入表格</button>
          <div className="book-list">
            {books.isLoading && <div className="empty-mini">正在读取…</div>}
          {orderedBooks.map((book) => <BookListItem key={book.id} data-book-id={book.id} book={book} active={book.id === activeBookId} dragged={draggedBookId === book.id} dropTarget={bookDropTargetId === book.id && draggedBookId !== book.id} onPointerDown={(event) => startBookDrag(event, book.id)} onPointerMove={moveBookDrag} onPointerUp={finishBookDrag} onPointerCancel={clearBookDrag} onSelect={() => { if (suppressBookClickRef.current) return; setActiveBookId(book.id); onVaultActivity(); }} onClose={() => closeBook(book)} />)}
          {closedBookIds.size > 0 && <button type="button" className="closed-books-link" onClick={reopenClosedBooks}><Archive size={13} />已关闭礼金簿（{closedBookIds.size}）</button>}
            {!books.isLoading && books.data?.length === 0 && <div className="empty-mini">还没有礼金簿</div>}
          </div>
          <div className="sidebar-bottom"><button className={`sidebar-link ${activeTab === "settings" ? "active" : ""}`} onClick={() => setActiveTab("settings")}><Settings size={15} />设置</button><button className={`sidebar-link ${activeTab === "returnGifts" ? "active" : ""}`} onClick={() => setActiveTab("returnGifts")}><Gift size={15} />回礼明细</button><button className={`sidebar-link ${activeTab === "history" ? "active" : ""}`} onClick={() => setActiveTab("history")}><History size={15} />历史改动</button><button className={`sidebar-link trash-drop-target ${activeTab === "trash" ? "active" : ""} ${trashDropActive ? "drag-over" : ""}`} onDragOver={(event) => { event.preventDefault(); setTrashDropActive(true); }} onDragLeave={() => setTrashDropActive(false)} onDrop={(event) => void dropToTrash(event)} onClick={() => setActiveTab("trash")}><Trash2 size={15} />回收站</button><VersionBadge /></div>
        </aside>
        <main className="content-area">
          {activeTab === "settings" ? <div className="content-view settings"><SettingsView session={session} onUnlock={onUnlock} onUnlockEditing={onUnlockEditing} onLockEditing={onLockEditing} onChangePin={onChangePin} onCheckUpdate={onCheckLocalUpdate} onInstallUpdate={onInstallLocalUpdate} updatePhase={localUpdatePhase} updateStatus={updateStatus} lastUpdateCheckAt={lastUpdateCheckAt} onNotice={onNotice} onError={onError} /></div> : activeTab === "trash" && !activeBook ? <div className="content-view trash"><TrashView vaultPath={vault.path} onNotice={onNotice} isAdmin={canEdit} onVaultActivity={onVaultActivity} /></div> : !activeBook && activeTab === "compare" ? <div className="content-view compare"><CompareViewPanel vaultPath={vault.path} onNotice={onNotice} canEdit={canEdit} bookOrder={bookOrder} /></div> : !activeBook && activeTab === "returnGifts" ? <div className="content-view returnGifts"><ReturnGiftsView vaultPath={vault.path} isAdmin={canEdit} onError={onError} onVaultActivity={onVaultActivity} /></div> : !activeBook && activeTab === "history" ? <div className="content-view history"><HistoryView vaultPath={vault.path} vaultName={vault.name} isAdmin={canEdit} onNotice={onNotice} onVaultUpdated={onVaultUpdated} /></div> : activeBook ? (
             <>
               {showBookNavigation && <><div className="content-heading"><div><h2>{activeBook.title}{canEdit && <button className="icon-button subtle book-title-edit" data-operation-hint="提示：仅修改礼金簿名称、活动信息和备注。" type="button" title="编辑礼金簿" aria-label="编辑礼金簿" onClick={() => setBookEditOpen(true)}><Pencil size={16} /></button>}</h2><BookMetadata book={activeBook} /></div><div className="heading-actions" /></div>
               <nav className="tab-bar"><button className={activeTab === "entries" ? "active" : ""} onClick={() => setActiveTab("entries")}><LayoutDashboard size={16} />礼金明细</button><button className={activeTab === "people" ? "active" : ""} onClick={() => setActiveTab("people")}><UsersRound size={16} />人物与标签</button><button className={activeTab === "compare" ? "active" : ""} onClick={() => setActiveTab("compare")}><BarChart3 size={16} />跨簿比较</button></nav></>}
              <div className={`content-view ${activeTab}`}>
                {activeTab === "trash" && <TrashView vaultPath={vault.path} onNotice={onNotice} isAdmin={canEdit} onVaultActivity={onVaultActivity} />}
                {activeTab === "entries" && <EntriesView book={activeBook} vaultPath={vault.path} onError={onError} onNotice={onNotice} isAdmin={isAdmin} editLocked={session.editLocked} continuousRegistration={continuousRegistration} onStopContinuousRegistration={() => onContinuousRegistrationChange(false)} focusedEntryId={focusedEntryId} onExportVault={exportVault} onEditVault={() => setVaultEditOpen(true)} onVaultActivity={onVaultActivity} />}
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
      {vaultEditOpen && <VaultMetadataModal vault={vault} isSaving={vaultEditSaving} onClose={() => setVaultEditOpen(false)} onSubmit={editVault} onChoosePath={() => api.chooseVaultPath("save", vault.path.split(/[\\/]/).pop() || suggestedVaultFileName(vault.name))} />}
      {bookEditOpen && activeBook && <BookMetadataModal book={activeBook} isSaving={bookEditSaving} onClose={() => setBookEditOpen(false)} onSubmit={editBook} />}
      {bookToClose && <ConfirmBookClose book={bookToClose} onClose={() => setBookToClose(null)} onConfirm={confirmCloseBook} />}
      {vaultToClose && <ConfirmVaultClose vault={vaultToClose} onClose={() => setVaultToClose(null)} onConfirm={() => { const target = vaultToClose.path; setVaultToClose(null); void onCloseVault(target); }} />}
      {spreadsheetImportOpen && <SpreadsheetBatchModal paths={spreadsheetPaths} books={openedVaultBooks.data ?? []} vaults={openedVaults.map((item) => item.vault)} activeVaultPath={vault.path} activeBookId={activeBookId} isImporting={spreadsheetImporting} importPhase={spreadsheetImportPhase} onClose={() => { setSpreadsheetImportOpen(false); setSpreadsheetPaths([]); }} onChooseMore={async () => { try { const paths = await api.chooseSpreadsheetPaths(); const vaultCount = paths.filter((path) => path.toLocaleLowerCase().endsWith(".giftvault")).length; if (vaultCount) onNotice(`已跳过 ${vaultCount} 个礼金库文件，请使用“打开礼金库”切换礼金库`); return paths.filter((path) => !path.toLocaleLowerCase().endsWith(".giftvault")); } catch (err) { onError(String(err)); return []; } }} onImport={async (items) => { setSpreadsheetImporting(true); setSpreadsheetImportPhase("正在写入礼金簿"); try { const result = await api.importSpreadsheets(items); setSpreadsheetImportPhase("正在刷新页面数据"); await client.invalidateQueries(); setSpreadsheetImportOpen(false); setSpreadsheetPaths([]); if (result.books[0]) { if (items[0]?.targetVaultPath && vaultPathKey(items[0].targetVaultPath) !== vaultPathKey(vault.path)) onSwitchVault(items[0].targetVaultPath); setActiveBookId(result.books[0].book.id); } setActiveTab("entries"); onVaultActivity(); onNotice(result.skippedRows.length ? `已导入 ${result.imported} 条记录；跳过 ${result.skippedRows.length} 行。${result.skippedRows.slice(0, 3).join("；")}${result.skippedRows.length > 3 ? "；其余异常请在导入预览中查看" : ""}` : `已从 ${result.books.length} 个文件导入 ${result.imported} 条记录`); } catch (err) { onError(String(err)); } finally { setSpreadsheetImporting(false); setSpreadsheetImportPhase("正在准备导入"); } }} />}
    </div>
  );
}

function SettingsView({ session, onUnlock, onUnlockEditing, onLockEditing, onChangePin, onCheckUpdate, onInstallUpdate, updatePhase, updateStatus, lastUpdateCheckAt, onNotice = () => undefined, onError = (message) => console.error(message) }: { session: SessionStatus; onUnlock: () => void; onUnlockEditing: () => void; onLockEditing: () => void; onChangePin: () => void; onCheckUpdate: () => void; onInstallUpdate: () => void; updatePhase: LocalUpdatePhase; updateStatus: LocalUpdateStatus | null; lastUpdateCheckAt: string | null; onNotice?: (message: string) => void; onError?: (message: string) => void }) {
  const isAdmin = session.role === "admin";
  const [section, setSection] = useState<SettingsSection>("general");
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [licenseText, setLicenseText] = useState<string | null>(null);
  const [tableStyleOpen, setTableStyleOpen] = useState(false);
  const storage = useQuery({ queryKey: ["settings-storage"], queryFn: api.settingsStorageInfo });
  const chooseDirectory = useMutation({ mutationFn: api.chooseSettingsDirectory, onSuccess: (result) => { if (result) { storage.refetch(); onNotice("默认文件夹已更新；现有礼金库文件不会被移动。"); } }, onError: (error) => onError(String(error)) });
  const checkLicense = async () => {
    if (licenseText) { setLicenseOpen((open) => !open); return; }
    try { setLicenseText(await api.licenseText()); setLicenseOpen(true); } catch (error) { onError(String(error)); }
  };
  const checkedAt = lastUpdateCheckAt ? new Date(lastUpdateCheckAt).toLocaleString("zh-CN", { hour12: false }) : "尚未检查";
  const updateMessage = updateStatus?.error ? updateStatus.error : updateStatus?.candidate ? `发现 v${updateStatus.candidate.version}，可下载正式安装包更新。` : lastUpdateCheckAt ? "当前已是最新版本。" : "尚未检查更新。";
  return <section className="settings-view"><div className="settings-heading"><div><span className="eyebrow">软件设置</span><h2>设置</h2><p>管理本机偏好、编辑权限和软件版本信息。</p></div></div><div className="settings-layout"><nav className="settings-nav" aria-label="设置分类"><button type="button" className={section === "general" ? "active" : ""} onClick={() => setSection("general")}><Settings size={15} />通用</button><button type="button" className={section === "about" ? "active" : ""} onClick={() => setSection("about")}><Info size={15} />关于</button><button type="button" className={section === "donate" ? "active" : ""} onClick={() => setSection("donate")}><Gift size={15} />打赏支持</button></nav><div className="settings-content">{section === "general" ? <><section className="settings-panel"><div><strong>默认文件夹</strong><p className="settings-path" title={storage.data?.directory}>{storage.isLoading ? "正在读取…" : storage.data?.directory}</p><p>用于新建或打开礼金库、选择导入表格时的默认位置；不会移动已有文件。</p><button className="secondary-button compact" disabled={chooseDirectory.isPending} onClick={() => chooseDirectory.mutate()}><FolderOpen size={14} />{chooseDirectory.isPending ? "选择中…" : "选择默认文件夹"}</button></div></section><section className="settings-panel"><div className="toolbar-actions">{isAdmin ? <><button className="secondary-button compact edit-lock-button" data-operation-hint={session.editLocked ? "提示：解锁后可执行删除和重要资料修改。" : "提示：锁定后将暂停高风险修改与删除。"} type="button" onClick={session.editLocked ? onUnlockEditing : onLockEditing}><LockKeyhole size={14} />{session.editLocked ? "解锁编辑" : "锁定编辑"}</button><button className="secondary-button compact" data-operation-hint="提示：修改 PIN 后会生成新的恢复码。" type="button" onClick={onChangePin}><KeyRound size={14} />修改 PIN</button><button className="secondary-button compact" type="button" onClick={() => setTableStyleOpen((open) => !open)}><ArrowUpDown size={14} />编辑表格样式</button></> : <button className="secondary-button compact" data-operation-hint="提示：管理员解锁后可管理编辑保护和 PIN。" type="button" onClick={onUnlock}><Unlock size={14} />管理员解锁</button>}</div></section>{tableStyleOpen && <TableStyleSettings canEdit={isAdmin && !session.editLocked} onNotice={onNotice} />}</> : section === "about" ? <AboutSettings updatePhase={updatePhase} updateStatus={updateStatus} checkedAt={checkedAt} updateMessage={updateMessage} onCheckUpdate={onCheckUpdate} onInstallUpdate={onInstallUpdate} onShowLicense={checkLicense} licenseOpen={licenseOpen} licenseText={licenseText} /> : <DonationSettings />}</div></div></section>;
}

const DEFAULT_TABLE_COLUMNS = ["姓名", "金额", "支付方式", "地址", "备注", "标签", "回礼金额", "回礼备注", "回礼时间", "登记日期"];
const DISPLAY_TABLE_COLUMNS = new Set(["姓名", "金额", "支付方式", "地址", "备注", "标签", "回礼金额", "登记日期"]);
const TABLE_COLUMNS_KEY = "lijin-book.table-columns";

function TableStyleSettings({ canEdit, onNotice }: { canEdit: boolean; onNotice: (message: string) => void }) {
  const [unlocked, setUnlocked] = useState(false);
  const [columns, setColumns] = useState<string[]>(() => { try { const saved = JSON.parse(localStorage.getItem(TABLE_COLUMNS_KEY) || "null"); return Array.isArray(saved) && saved.length === DEFAULT_TABLE_COLUMNS.length && new Set(saved).size === saved.length ? saved : DEFAULT_TABLE_COLUMNS; } catch { return DEFAULT_TABLE_COLUMNS; } });
  const save = () => { if (!canEdit || !unlocked || new Set(columns).size !== DEFAULT_TABLE_COLUMNS.length) return; localStorage.setItem(TABLE_COLUMNS_KEY, JSON.stringify(columns)); onNotice("表格列顺序已保存；导出和明细展示将使用新顺序。"); setUnlocked(false); };
  return <section className="settings-panel table-style-settings"><div className="table-style-heading"><div><strong>默认表格列顺序</strong><p>仅调整显示和导出顺序，不改变字段含义或原始数据。</p></div><button className="secondary-button compact" disabled={!canEdit} onClick={() => setUnlocked((value) => !value)}><LockKeyhole size={14} />{unlocked ? "锁定顺序" : "解锁编辑"}</button></div><ReorderableColumnList columns={columns} disabled={!unlocked} onChange={setColumns} /><div className="modal-actions"><button className="secondary-button compact" disabled={!unlocked} onClick={() => setColumns(DEFAULT_TABLE_COLUMNS)}>恢复默认</button><button className="primary-button compact" disabled={!canEdit || !unlocked} onClick={save}>保存顺序</button></div></section>;
}

function readTableColumns() {
  try { const saved = JSON.parse(localStorage.getItem(TABLE_COLUMNS_KEY) || "null"); return Array.isArray(saved) && saved.length === DEFAULT_TABLE_COLUMNS.length && saved.every((column) => DEFAULT_TABLE_COLUMNS.includes(column)) ? saved as string[] : DEFAULT_TABLE_COLUMNS; } catch { return DEFAULT_TABLE_COLUMNS; }
}

function ReorderableColumnList({ columns, disabled = false, onChange }: { columns: string[]; disabled?: boolean; onChange: (columns: string[]) => void }) {
  const timerRef = useRef<number | null>(null);
  const pointerRef = useRef<number | null>(null);
  const draggedRef = useRef<string | null>(null);
  const targetRef = useRef<string | null>(null);
  const [draggedColumn, setDraggedColumn] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const clearDrag = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    pointerRef.current = null;
    draggedRef.current = null;
    targetRef.current = null;
    setDraggedColumn(null);
    setDropTarget(null);
  };
  const onPointerDown = (event: React.PointerEvent<HTMLLIElement>, column: string) => {
    if (disabled || event.button !== 0) return;
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    pointerRef.current = pointerId;
    timerRef.current = window.setTimeout(() => {
      if (pointerRef.current !== pointerId) return;
      draggedRef.current = column;
      targetRef.current = column;
      setDraggedColumn(column);
      setDropTarget(column);
      target.setPointerCapture?.(pointerId);
    }, 260);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLLIElement>) => {
    if (!draggedRef.current) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-table-column]");
    const column = target?.dataset.tableColumn ?? null;
    if (!column) return;
    targetRef.current = column;
    setDropTarget(column);
  };
  const finishDrag = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    const dragged = draggedRef.current;
    const target = targetRef.current;
    if (dragged && target && dragged !== target) {
      const from = columns.indexOf(dragged);
      const to = columns.indexOf(target);
      if (from >= 0 && to >= 0) {
        const next = [...columns];
        next.splice(from, 1);
        next.splice(to, 0, dragged);
        onChange(next);
      }
    }
    clearDrag();
  };
  return <><p className="column-order-hint">{disabled ? "解锁后可调整顺序。" : "长按字段名称后拖动调整顺序。"}</p><ol className={`column-order-list ${disabled ? "disabled" : ""}`} aria-label="表格列顺序">{columns.map((column, index) => <li key={column} data-table-column={column} className={`${draggedColumn === column ? "dragging" : ""} ${dropTarget === column && draggedColumn !== column ? "drop-target" : ""}`} onPointerDown={(event) => onPointerDown(event, column)} onPointerMove={onPointerMove} onPointerUp={finishDrag} onPointerCancel={clearDrag}><span className="column-order-grip" aria-hidden="true">⠿</span><span>{index + 1}. {column}</span></li>)}</ol></>;
}

function renderEntryColumn(column: string, entry: GiftEntry, entryTags: Tag[]) {
  if (column === "姓名") return <td className="entry-accent-cell"><div className="person-cell"><span className="avatar">{entry.personName.slice(0, 1)}</span><strong>{entry.personName}</strong></div></td>;
  if (column === "金额") return <td className="amount-cell">{formatMoney(entry.amountFen)}</td>;
  if (column === "支付方式") return <td><span className="method-pill">{entry.paymentMethod}</span></td>;
  if (column === "地址") return <td className="muted">{entry.address || "-"}</td>;
  if (column === "备注") return <td className="muted note-cell" title={entry.note || undefined}>{entry.note || "-"}</td>;
  if (column === "标签") return <td className="tag-column">{entryTags.length ? <div className="tag-select">{entryTags.slice(0, 2).map((tag) => <span className="tag-chip" style={{ "--tag-color": tag.color } as React.CSSProperties} key={tag.id}>{tag.name}<span className="tag-swatch" /></span>)}</div> : <span className="muted">-</span>}</td>;
  if (column === "回礼金额") return <td className="amount-cell">{entry.returnGiftAmountFen ? formatMoney(entry.returnGiftAmountFen) : "-"}</td>;
  return <td className="muted">{entry.receivedAt}</td>;
}

function EntryMoreInfo({ entry, colSpan }: { entry: GiftEntry; colSpan: number }) {
  return <tr className="entry-details-row"><td colSpan={colSpan}><div className="entry-details-panel"><div><span>回礼备注</span><strong>{entry.returnGift || "未填写"}</strong></div><div><span>回礼登记日期</span><strong>{entry.returnGiftedAt ? formatReturnGiftTime(entry.returnGiftedAt) : "未登记"}</strong></div></div></td></tr>;
}

function DonationSettings() {
  return <section className="donation-page"><section className="about-card donation-intro"><div><span className="about-label">感谢支持</span><h3>如果礼金簿管理对你有帮助</h3><p>欢迎通过微信或支付宝给作者一份鼓励。二维码仅用于打赏，不会读取或保存支付信息。</p></div><Gift size={28} /></section><section className="donation-grid"><article className="donation-card"><div className="donation-image-frame wechat"><img src={wechatDonateImage} alt="微信打赏二维码" /></div><strong>微信</strong><span>扫码打赏</span></article><article className="donation-card"><div className="donation-image-frame alipay"><img src={alipayDonateImage} alt="支付宝打赏二维码" /></div><strong>支付宝</strong><span>扫码打赏</span></article></section></section>;
}

function AboutSettings({ updatePhase, updateStatus, checkedAt, updateMessage, onCheckUpdate, onInstallUpdate, onShowLicense, licenseOpen, licenseText }: { updatePhase: LocalUpdatePhase; updateStatus: LocalUpdateStatus | null; checkedAt: string; updateMessage: string; onCheckUpdate: () => void; onInstallUpdate: () => void; onShowLicense: () => void; licenseOpen: boolean; licenseText: string | null }) {
  const candidate = updateStatus?.candidate;
  return <section className="about-page"><section className="about-card about-update-card"><div className="about-card-heading"><div><span className="about-label">当前版本</span><strong>v{__APP_VERSION__}</strong></div><button className="primary-button compact" disabled={updatePhase !== "idle"} onClick={onCheckUpdate}><RefreshCw className={updatePhase === "checking" ? "is-spinning" : undefined} size={14} />{updatePhase === "checking" ? "检查中…" : "检查更新"}</button></div><div className="about-status"><span className={`status-dot ${candidate ? "status-dot-update" : ""}`} />{updateMessage}</div><p className="about-meta">最近检查：{checkedAt}</p>{candidate && <div className="update-candidate"><strong>v{candidate.version} 可用</strong><span>{candidate.publishedAt ? `发布时间：${new Date(candidate.publishedAt).toLocaleString("zh-CN", { hour12: false })}` : "正式发布版本"}</span>{candidate.releaseUrl && <a className="release-link" href={candidate.releaseUrl} target="_blank" rel="noreferrer">查看 GitHub Release <ExternalLink size={12} /></a>}{candidate.releaseNotes && <details className="release-notes-details"><summary>查看更新明细</summary><pre>{candidate.releaseNotes}</pre></details>}<button className="primary-button compact" disabled={updatePhase !== "idle"} onClick={onInstallUpdate}>确认下载并安装</button></div>}</section><section className="about-card"><dl className="about-facts"><div><dt>代码仓库</dt><dd><a href="https://github.com/Bboy-Lan/Gift-Money-Management-System" target="_blank" rel="noreferrer">Bboy-Lan/Gift-Money-Management-System <ExternalLink size={13} /></a></dd></div><div><dt>开源协议</dt><dd><button className="text-link" type="button" onClick={onShowLicense}>MIT License · 查看本地 LICENSE</button></dd></div><div><dt>作者</dt><dd>Bboy-Lan</dd></div></dl>{licenseOpen && licenseText && <pre className="license-preview">{licenseText}</pre>}</section><section className="about-card"><details className="release-notes-details"><summary className="about-card-heading"><div><span className="about-label">更新明细</span><strong>v{__APP_VERSION__}</strong></div><ChevronDown size={16} /></summary><pre>{CURRENT_RELEASE_NOTES}</pre></details></section></section>;
}

function EntriesView({ book, vaultPath, onError, onNotice, isAdmin, editLocked, continuousRegistration, onStopContinuousRegistration, focusedEntryId, onExportVault, onEditVault, onVaultActivity }: { book: GiftBook; vaultPath: string; onError: (message: string) => void; onNotice: (message: string) => void; isAdmin: boolean; editLocked: boolean; continuousRegistration: boolean; onStopContinuousRegistration: () => void; focusedEntryId: string | null; onExportVault: () => void; onEditVault: () => void; onVaultActivity: () => void }) {
  const client = useQueryClient();
  const [entryModal, setEntryModal] = useState(false);
  const [exportModal, setExportModal] = useState(false);
  const [entryFormKey, setEntryFormKey] = useState(0);
  const [editingEntry, setEditingEntry] = useState<GiftEntry | null>(null);
	  const [deletingEntry, setDeletingEntry] = useState<GiftEntry | null>(null);
	  const [expandedEntryIds, setExpandedEntryIds] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<EntryFilter>(EMPTY_ENTRY_FILTER);
  const [sortOpen, setSortOpen] = useState(false);
  const [tableColumns, setTableColumns] = useState<string[]>(readTableColumns);
  const visibleTableColumns = tableColumns.filter((column) => DISPLAY_TABLE_COLUMNS.has(column));
  useEffect(() => { const syncColumns = () => setTableColumns(readTableColumns()); window.addEventListener("storage", syncColumns); return () => window.removeEventListener("storage", syncColumns); }, []);
  const sortControlRef = useRef<HTMLSpanElement>(null);
  const [sort, setSort] = useState<EntrySort>(null);
  const queryEntries = useQuery({ queryKey: ["entries", vaultPath, book.id], queryFn: () => api.listEntries(book.id, "") });
  const tags = useQuery({ queryKey: ["tags", vaultPath], queryFn: api.listTags });
  const createTag = useMutation({ mutationFn: ({ name, color }: { name: string; color: string }) => api.createTag(name, color), onSuccess: () => { client.invalidateQueries(); onVaultActivity(); }, onError: (err) => onError(String(err)) });
  const deleteEntry = useMutation({ mutationFn: api.deleteEntry, onSuccess: () => { client.invalidateQueries(); onVaultActivity(); }, onError: (err) => onError(String(err)) });
  const entries = queryEntries;
  const displayTags = canonicalizeTags(tags.data ?? []);
  const tagById = new Map(displayTags.map((tag) => [tag.id, tag]));
  const usedTags = useMemo(() => {
    const usedIds = new Set((entries.data ?? []).flatMap((entry) => entry.tags));
    return displayTags.filter((tag) => usedIds.has(tag.id));
  }, [displayTags, entries.data]);
  const dateBounds = useMemo(() => {
    const dates = (entries.data ?? []).map((entry) => entry.receivedAt.slice(0, 10)).filter(Boolean).sort();
    return { start: dates[0] ?? "", end: dates[dates.length - 1] ?? "" };
  }, [entries.data]);
  const [dateTouched, setDateTouched] = useState(false);
  const effectiveStartDate = dateTouched ? filter.startDate : dateBounds.start;
  const effectiveEndDate = dateTouched ? filter.endDate : dateBounds.end;
  const activeFilterCount = [filter.person, filter.address, filter.note, filter.paymentMethod, filter.returnStatus !== "all" ? filter.returnStatus : "", filter.tagIds.length > 0 ? "tags" : "", dateTouched && filter.startDate ? filter.startDate : "", dateTouched && filter.endDate ? filter.endDate : ""].filter(Boolean).length;
  const filteredEntries = useMemo(() => {
    const matches = (value: string | null | undefined, query: string) => !query || (value ?? "").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    return (entries.data ?? []).filter((entry) => {
      const entryDate = entry.receivedAt.slice(0, 10);
      const returnAmount = entry.returnGiftAmountFen ?? 0;
      const returned = returnAmount > 0;
      return matches(entry.personName, filter.person) && matches(entry.address, filter.address) && matches(entry.note, filter.note) &&
        (!filter.tagIds.length || filter.tagIds.some((tagId) => entry.tags.includes(tagId))) &&
        (!filter.paymentMethod || resolvePaymentMethodValue(entry.paymentMethod) === filter.paymentMethod) &&
        (!effectiveStartDate || entryDate >= effectiveStartDate) && (!effectiveEndDate || entryDate <= effectiveEndDate) &&
        (filter.returnStatus === "all" || (filter.returnStatus === "returned" ? returned : !returned));
    });
  }, [entries.data, filter, effectiveStartDate, effectiveEndDate]);
  const filteredSummary = useMemo(() => ({ giftCount: filteredEntries.length, highestAmountFen: filteredEntries.reduce((max, entry) => Math.max(max, entry.amountFen), 0), totalFen: filteredEntries.reduce((total, entry) => total + entry.amountFen, 0) }), [filteredEntries]);
  const sortedEntries = useMemo(() => {
    if (!sort) return filteredEntries;
    return filteredEntries.map((entry, index) => ({ entry, index })).sort((left, right) => {
      const leftValue = sort.field === "amount" ? left.entry.amountFen : sort.field === "returnAmount" ? (left.entry.returnGiftAmountFen ?? 0) : sort.field === "receivedAt" ? left.entry.receivedAt : left.entry.personName;
      const rightValue = sort.field === "amount" ? right.entry.amountFen : sort.field === "returnAmount" ? (right.entry.returnGiftAmountFen ?? 0) : sort.field === "receivedAt" ? right.entry.receivedAt : right.entry.personName;
      const comparison = typeof leftValue === "number" && typeof rightValue === "number" ? leftValue - rightValue : String(leftValue).localeCompare(String(rightValue), "zh-CN");
      const ordered = sort.direction === "asc" ? comparison : -comparison;
      return ordered || left.index - right.index;
    }).map(({ entry }) => entry);
  }, [filteredEntries, sort]);
  const summaryMoney = formatSummaryMoney(filteredSummary.totalFen);
  const canEdit = isAdmin && !editLocked;
  useEffect(() => {
    const closeSortOnOutsidePointer = (event: PointerEvent) => {
      if (sortControlRef.current && !sortControlRef.current.contains(event.target as Node)) setSortOpen(false);
    };
    document.addEventListener("pointerdown", closeSortOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeSortOnOutsidePointer);
  }, []);
  const createEntry = useMutation({ mutationFn: (input: EntryDraft) => api.createEntry({ bookId: book.id, ...input }), onSuccess: () => { client.invalidateQueries(); onVaultActivity(); if (continuousRegistration) { setEntryFormKey((key) => key + 1); setEntryModal(true); onNotice("登记成功，请继续登记下一条礼金"); } else { setEntryModal(false); } }, onError: (err) => onError(String(err)) });
  const updateEntry = useMutation({ mutationFn: (input: EntryDraft & { entryId: string }) => api.updateEntry(input), onSuccess: () => { client.invalidateQueries(); setEditingEntry(null); onVaultActivity(); }, onError: (err) => onError(String(err)) });
  useEffect(() => {
    if (!focusedEntryId || !queryEntries.data?.some((entry) => entry.id === focusedEntryId)) return;
    document.getElementById(`entry-${focusedEntryId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusedEntryId, queryEntries.data]);
  const exportSpreadsheet = async (columns: string[]) => {
    try { const path = await api.exportBookXlsx(book.id, columns); onNotice(`已导出礼金簿：${path}`); setExportModal(false); } catch (err) { onError(String(err)); }
  };
  return <section className={`entries-view ${editLocked ? "edit-locked" : ""}`}>
    <div className="metric-grid summary-strip"><Metric label="礼金笔数" value={`${filteredSummary.giftCount}`} accent="blue" /><Metric label="最高金额" value={formatMoney(filteredSummary.highestAmountFen)} accent="green" /><Metric label="礼金总额" value={summaryMoney.primary} detail={summaryMoney.exact} accent="amber" /></div>
    <div className="toolbar entries-toolbar"><div className="entries-filter-summary"><button className={`secondary-button compact filter-toggle ${activeFilterCount ? "active" : ""}`} type="button" aria-expanded={filterOpen} onClick={() => setFilterOpen((open) => !open)}><Filter size={14} />筛选{activeFilterCount ? `（${activeFilterCount}）` : ""}</button><span className="sort-control" ref={sortControlRef}><button className={`secondary-button compact sort-toggle ${sort ? "active" : ""}`} type="button" aria-expanded={sortOpen} aria-controls="entry-sort-popover" onClick={() => setSortOpen((open) => !open)}><ArrowUpDown size={14} />{sort ? `排序：${sortFieldLabel(sort.field)}${sort.direction === "asc" ? "↑" : "↓"}` : "排序"}</button>{sortOpen && <EntrySortPanel sort={sort} onChange={setSort} onClear={() => { setSort(null); setSortOpen(false); }} />}</span><span className="toolbar-note">当前显示 {filteredEntries.length} / {entries.data?.length ?? 0} 条记录</span></div><div className="toolbar-actions">{canEdit && <button className="secondary-button compact" data-operation-hint="提示：仅修改礼金库名称和备注，不会改变内部数据归属。" onClick={onEditVault}><Pencil size={15} />编辑礼金库</button>}<button className="secondary-button compact" onClick={onExportVault}><Archive size={15} />导出库</button><button className="secondary-button compact" onClick={() => setExportModal(true)}><FileSpreadsheet size={15} />导出礼金簿</button>{canEdit && <button className="primary-button compact" onClick={() => setEntryModal(true)}><CirclePlus size={15} />登记礼金</button>}</div></div>
    {filterOpen && <EntryFilterPanel filter={filter} availableTags={usedTags} dateBounds={dateBounds} onChange={setFilter} onDateChange={(startDate, endDate) => { setDateTouched(true); setFilter((current) => ({ ...current, startDate, endDate })); }} onReset={() => { setDateTouched(false); setFilter(EMPTY_ENTRY_FILTER); setSort(null); }} />}
	    <section className="table-panel"><div className="table-panel-heading"><div><strong>礼金明细</strong><span>{filteredEntries.length} 条记录</span></div></div>{entries.isLoading ? <div className="table-empty">正在加载礼金记录…</div> : filteredEntries.length ? <div className="table-wrap"><table><thead><tr>{visibleTableColumns.map((column) => <th className={column === "标签" ? "tag-column" : ""} key={column}>{column}</th>)}<th className="entry-details-column" aria-label="更多信息" />{isAdmin && <th />}</tr></thead><tbody>{sortedEntries.map((entry) => {
	      const entryTags = entry.tags.map((id) => tagById.get(id)).filter((tag): tag is Tag => Boolean(tag));
	      const rowClassName = ["entry-row", entry.id === focusedEntryId ? "search-focused" : ""].filter(Boolean).join(" ");
	      const expanded = expandedEntryIds.has(entry.id);
	      const toggleDetails = () => setExpandedEntryIds((current) => { const next = new Set(current); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next; });
	      return <Fragment key={entry.id}><tr id={`entry-${entry.id}`} draggable={canEdit} onDragStart={(event) => { event.dataTransfer.setData("application/x-lijin-trash-kind", "entry"); event.dataTransfer.setData("application/x-lijin-trash-id", entry.id); }} className={rowClassName} style={{ "--entry-tag-color": entryTags[0]?.color ?? "#a9b5b9" } as React.CSSProperties}>{visibleTableColumns.map((column) => <Fragment key={column}>{renderEntryColumn(column, entry, entryTags)}</Fragment>)}<td className="entry-details-action"><button className="icon-button subtle" type="button" aria-expanded={expanded} aria-label={expanded ? "收起更多信息" : "展开更多信息"} title={expanded ? "收起更多信息" : "展开更多信息"} onClick={toggleDetails}>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button></td>{canEdit && <td><div className="row-actions"><button className="icon-button subtle" data-operation-hint="提示：可修改此人的礼金、标签及回礼信息。" title="编辑信息" onClick={() => setEditingEntry(entry)}><Pencil size={15} /></button><button className="icon-button danger subtle" data-operation-hint="提示：删除后将进入回收站，可在回收站恢复。" title="删除记录" onClick={() => setDeletingEntry(entry)}><Trash2 size={15} /></button></div></td>}</tr>{expanded && <EntryMoreInfo entry={entry} colSpan={visibleTableColumns.length + 1 + (canEdit ? 1 : 0)} />}</Fragment>;
    })}</tbody></table></div> : <div className="table-empty"><Filter size={27} /><strong>{entries.data?.length ? "没有符合条件的礼金记录" : "还没有礼金记录"}</strong><span>{entries.data?.length ? "请调整筛选条件后重试。" : "从第一笔登记开始建立这本礼金簿。"}</span>{!entries.data?.length && isAdmin && <button className="primary-button compact" onClick={() => setEntryModal(true)}><CirclePlus size={15} />登记第一笔</button>}</div>}</section>
     {entryModal && <EntryModal key={entryFormKey} tags={displayTags} vaultPath={vaultPath} onCreateTag={(name, color) => createTag.mutateAsync({ name, color })} onClose={() => { setEntryModal(false); onStopContinuousRegistration(); }} onSubmit={(input) => createEntry.mutate(input)} isSaving={createEntry.isPending} />}
    {exportModal && <ExportBookModal entries={filteredEntries} initialColumns={tableColumns} onClose={() => setExportModal(false)} onExport={exportSpreadsheet} />}
    {editingEntry && <EntryModal tags={displayTags} vaultPath={vaultPath} onCreateTag={(name, color) => createTag.mutateAsync({ name, color })} initial={editingEntry} title="编辑信息" onClose={() => setEditingEntry(null)} onSubmit={(input) => updateEntry.mutate({ entryId: editingEntry.id, ...input })} isSaving={updateEntry.isPending} />}
    {deletingEntry && <ConfirmEntryDelete entry={deletingEntry} onClose={() => setDeletingEntry(null)} onConfirm={() => { deleteEntry.mutate(deletingEntry.id); setDeletingEntry(null); }} />}
  </section>;
}

function sortFieldLabel(field: EntrySortField) {
  return field === "amount" ? "礼金金额" : field === "returnAmount" ? "回礼金额" : field === "receivedAt" ? "登记日期" : "姓名";
}

function exportSampleValue(column: string, entry: GiftEntry) {
  if (column === "姓名") return entry.personName;
  if (column === "金额") return formatMoney(entry.amountFen);
  if (column === "支付方式") return entry.paymentMethod;
  if (column === "地址") return entry.address || "-";
  if (column === "备注") return entry.note || "-";
  if (column === "标签") return entry.tags.length ? `${entry.tags.length} 个标签` : "-";
  if (column === "回礼金额") return entry.returnGiftAmountFen === null ? "-" : formatMoney(entry.returnGiftAmountFen);
  if (column === "回礼备注") return entry.returnGift || "-";
  if (column === "回礼时间") return entry.returnGiftedAt || "-";
  return entry.receivedAt || "-";
}

function ExportBookModal({ entries, initialColumns, onClose, onExport }: { entries: GiftEntry[]; initialColumns: string[]; onClose: () => void; onExport: (columns: string[]) => Promise<void> }) {
  const [columns, setColumns] = useState<string[]>(initialColumns);
  const [exporting, setExporting] = useState(false);
  const submit = async () => {
    setExporting(true);
    try { await onExport(columns); } finally { setExporting(false); }
  };
  return <Modal title="导出礼金簿" onClose={onClose} className="export-book-modal"><p className="field-hint">默认使用设置中的表格顺序；本次拖动只影响这次导出的 Excel，不会修改礼金数据。</p><ReorderableColumnList columns={columns} onChange={setColumns} /><section className="spreadsheet-sample export-sample"><div className="spreadsheet-sample-heading"><strong>导出样例</strong><span>前 {Math.min(3, entries.length)} 行</span></div><div className="spreadsheet-sample-wrap"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{entries.slice(0, 3).map((entry) => <tr key={entry.id}>{columns.map((column) => <td key={column}>{exportSampleValue(column, entry)}</td>)}</tr>)}</tbody></table>{entries.length === 0 && <p className="field-hint">当前礼金簿暂无记录，导出文件会保留所选列顺序。</p>}</div></section><div className="modal-actions"><button className="secondary-button" disabled={exporting} onClick={onClose}>取消</button><button className="primary-button" disabled={exporting} onClick={() => void submit()}><FileSpreadsheet size={15} />{exporting ? "正在导出…" : "确认导出礼金簿"}</button></div></Modal>;
}

function EntrySortPanel({ sort, onChange, onClear }: { sort: EntrySort; onChange: (sort: EntrySort) => void; onClear: () => void }) {
  const fields: EntrySortField[] = ["amount", "returnAmount", "receivedAt", "personName"];
  return <section id="entry-sort-popover" className="entry-sort-popover" aria-label="排序设置"><div className="entry-sort-heading"><strong>排序方式</strong></div><div className="entry-sort-fields">{fields.map((field) => <button type="button" key={field} className={sort?.field === field ? "selected" : ""} aria-pressed={sort?.field === field} onClick={() => onChange({ field, direction: sort?.field === field ? sort.direction : "asc" })}>{sortFieldLabel(field)}</button>)}</div><div className="entry-sort-heading entry-sort-direction-heading"><strong>排列顺序</strong></div><div className="entry-sort-fields direction">{(["asc", "desc"] as const).map((direction) => <button type="button" key={direction} className={sort?.direction === direction ? "selected" : ""} disabled={!sort} onClick={() => sort && onChange({ ...sort, direction })}>{direction === "asc" ? "正序 ↑" : "逆序 ↓"}</button>)}</div><div className="entry-sort-footer"><span>{sort ? `当前：${sortFieldLabel(sort.field)} · ${sort.direction === "asc" ? "正序" : "逆序"}` : "当前无排序，保持原表格顺序"}</span><button type="button" className="secondary-button compact" onClick={onClear}>清除排序</button></div></section>;
}

function EntryFilterPanel({ filter, availableTags, dateBounds, onChange, onDateChange, onReset }: { filter: EntryFilter; availableTags: Tag[]; dateBounds: { start: string; end: string }; onChange: React.Dispatch<React.SetStateAction<EntryFilter>>; onDateChange: (startDate: string, endDate: string) => void; onReset: () => void }) {
  const set = <K extends keyof EntryFilter>(key: K, value: EntryFilter[K]) => onChange((current) => ({ ...current, [key]: value }));
  const [moreOpen, setMoreOpen] = useState(false);
  const moreTagsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const closeMoreTagsOnOutsidePointer = (event: PointerEvent) => {
      if (moreTagsRef.current && !moreTagsRef.current.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("pointerdown", closeMoreTagsOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeMoreTagsOnOutsidePointer);
  }, []);
  const visibleTags = availableTags.slice(0, 5);
  const overflowTags = availableTags.slice(5);
  const toggleTag = (tagId: string) => set("tagIds", filter.tagIds.includes(tagId) ? filter.tagIds.filter((id) => id !== tagId) : [...filter.tagIds, tagId]);
  return <section className="entry-filter-panel" aria-label="礼金明细筛选"><div className="entry-filter-group"><strong>人物条件</strong><label>姓名<input value={filter.person} onChange={(event) => set("person", event.target.value)} placeholder="输入姓名" /></label><label>地址<input value={filter.address} onChange={(event) => set("address", event.target.value)} placeholder="输入地址" /></label><label>备注<input value={filter.note} onChange={(event) => set("note", event.target.value)} placeholder="输入备注" /></label></div><div className="entry-filter-group"><strong>礼金条件</strong><label>支付方式<select value={filter.paymentMethod} onChange={(event) => set("paymentMethod", event.target.value)}><option value="">全部</option>{PAYMENT_METHOD_OPTIONS.map((method) => <option key={method} value={method}>{method}</option>)}</select></label><div className="entry-filter-range"><label>开始日期<input type="date" value={filter.startDate || dateBounds.start} onChange={(event) => onDateChange(event.target.value, filter.endDate || dateBounds.end)} /></label><label>结束日期<input type="date" value={filter.endDate || dateBounds.end} onChange={(event) => onDateChange(filter.startDate || dateBounds.start, event.target.value)} /></label></div></div><div className="entry-filter-group"><strong>回礼条件</strong><label>回礼状态<select value={filter.returnStatus} onChange={(event) => set("returnStatus", event.target.value as EntryFilter["returnStatus"])}><option value="all">全部</option><option value="returned">已回礼</option><option value="not-returned">未回礼</option></select></label><button className="secondary-button compact" type="button" onClick={onReset}>重置筛选</button></div><div className="entry-filter-tags" ref={moreTagsRef}><strong>标签</strong><div className="entry-filter-tag-list">{visibleTags.map((tag) => <button type="button" key={tag.id} className={`entry-filter-tag ${filter.tagIds.includes(tag.id) ? "selected" : ""}`} style={{ "--tag-color": tag.color } as React.CSSProperties} aria-pressed={filter.tagIds.includes(tag.id)} onClick={() => toggleTag(tag.id)}>{tag.name}<span /></button>)}{overflowTags.length > 0 && <button type="button" className="entry-filter-more" onClick={() => setMoreOpen((open) => !open)}>更多标签（{overflowTags.length}）</button>}</div>{moreOpen && <div className="entry-filter-more-popover" role="dialog" aria-label="更多标签"><div className="entry-filter-more-heading"><strong>当前礼金簿标签</strong></div><div className="entry-filter-tag-list">{overflowTags.map((tag) => <button type="button" key={tag.id} className={`entry-filter-tag ${filter.tagIds.includes(tag.id) ? "selected" : ""}`} style={{ "--tag-color": tag.color } as React.CSSProperties} aria-pressed={filter.tagIds.includes(tag.id)} onClick={() => toggleTag(tag.id)}>{tag.name}<span /></button>)}</div></div>}</div></section>;
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

function previewColumns(mapping: SpreadsheetColumnMapping | null, columns = DEFAULT_TABLE_COLUMNS) {
  return columns.map((column) => {
    const index = DEFAULT_TABLE_COLUMNS.indexOf(column);
    const [field, label] = DEFAULT_IMPORT_PREVIEW_FIELDS[index] ?? DEFAULT_IMPORT_PREVIEW_FIELDS[0];
    return { field, label, index: mapping?.[field] ?? null };
  });
}

function mappingFieldsForColumnOrder(columns: string[]) {
  return columns.map((column) => SPREADSHEET_MAPPING_FIELDS[DEFAULT_TABLE_COLUMNS.indexOf(column)]).filter((field): field is [keyof SpreadsheetColumnMapping, string] => Boolean(field));
}

function mappingDuplicateErrors(mapping: SpreadsheetColumnMapping | null) {
  if (!mapping) return [];
  const columns = new Map<number, string[]>();
  for (const [field, label] of SPREADSHEET_MAPPING_FIELDS) {
    const index = mapping[field];
    if (index === null || index === undefined) continue;
    columns.set(index, [...(columns.get(index) ?? []), label]);
  }
  return [...columns.entries()]
    .filter(([, labels]) => labels.length > 1)
    .map(([index, labels]) => `第 ${index + 1} 列被重复映射为「${labels.join("、")}」，请为每个字段选择不同的源数据列。`);
}

function sourceColumnLabel(header: string, index: number) {
  const cleanHeader = header.trim();
  return cleanHeader ? `第 ${index + 1} 列：${cleanHeader}` : `第 ${index + 1} 列（未命名）`;
}

function SpreadsheetBatchModal({ paths, books, vaults, activeVaultPath, activeBookId, isImporting, importPhase, onClose, onChooseMore, onImport }: { paths: string[]; books: Array<GiftBook & { vaultPath: string; vaultName: string }>; vaults: VaultInfo[]; activeVaultPath: string; activeBookId: string | null; isImporting: boolean; importPhase: string; onClose: () => void; onChooseMore: () => Promise<string[]>; onImport: (items: SpreadsheetImportItem[]) => void }) {
  const [items, setItems] = useState<BatchPreviewState[]>([]);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [columnOrder, setColumnOrder] = useState<string[]>(readTableColumns);
  const [targetVaultPath, setTargetVaultPath] = useState(activeVaultPath);
  const [targetBookId, setTargetBookId] = useState(activeBookId || "__new__");
  const targetBooks = books.filter((book) => book.vaultPath.toLocaleLowerCase() === targetVaultPath.toLocaleLowerCase());
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
  const hasStructuralError = (item: BatchPreviewState) => item.preview.errors.some((error) => !item.preview.rowErrors.includes(error));
  const mappingErrors = (item: BatchPreviewState) => mappingDuplicateErrors(item.mapping);
  const validItems = items.filter((item) => item.selected && item.preview && !item.error && targetBookId && !hasStructuralError(item) && mappingErrors(item).length === 0 && item.preview.validRows > 0 && item.mapping?.name !== null && item.mapping?.name !== undefined && item.mapping?.amount !== null && item.mapping?.amount !== undefined);
  const hasBlockingItem = items.some((item) => item.selected && (!item.preview || Boolean(item.error) || !targetBookId || hasStructuralError(item) || mappingErrors(item).length > 0 || item.preview.validRows === 0 || item.mapping?.name === null || item.mapping?.name === undefined || item.mapping?.amount === null || item.mapping?.amount === undefined));
  useEffect(() => {
    if (hasBlockingItem) setMappingOpen(true);
  }, [hasBlockingItem]);
  const submit = () => {
    onImport(validItems.map((item) => ({ path: item.path, sheetName: item.sheetName ?? undefined, headerRow: item.headerRow ?? undefined, mapping: item.mapping ?? undefined, bookName: item.bookName.trim() || item.preview?.fileName.replace(/\.[^.]+$/, "") || "导入礼金簿", targetBookId: targetBookId === "__new__" ? null : targetBookId, targetVaultPath, createNewBook: targetBookId === "__new__" })));
  };
  return <Modal title={`批量导入表格 · ${items.length} 个文件`} onClose={onClose} className="spreadsheet-batch-modal">
    <div className="batch-import-intro"><FileSpreadsheet size={16} /><div><strong>导入提醒</strong><span>系统会先检查字段映射和异常记录，确认无误后才写入目标礼金库。</span><small>姓名、金额为必填字段；例如“第 1 列：姓名”应对应姓名，“第 2 列：金额”应对应礼金金额。地址、支付方式和备注识别错误时，请在下方重新选择；红色异常会显示具体行号和处理建议。</small></div></div>
    <div className="batch-import-toolbar"><div className="batch-target-fields"><label className="batch-target-vault">导入礼金库<select value={targetVaultPath} aria-label="导入礼金库" onChange={(event) => { setTargetVaultPath(event.target.value); setTargetBookId("__new__"); }}>{vaults.map((item) => <option value={item.path} key={item.path}>{item.name}</option>)}</select><small>默认使用当前礼金库；切换后，文件会写入所选礼金库。</small></label><label className="batch-target-book">导入方式<select value={targetBookId} aria-label="导入方式" data-target-mode="明确新建礼金簿" onChange={(event) => setTargetBookId(event.target.value)}><option value="__new__">新建礼金簿</option>{targetBooks.map((book) => <option value={book.id} key={book.id}>{book.title}</option>)}</select><small>已有礼金簿只追加导入记录，不覆盖原有数据。</small></label></div><button className="secondary-button compact" onClick={() => void addFiles()} disabled={isImporting}><FolderOpen size={14} />添加文件</button></div>
    <div className="batch-import-list">{items.length === 0 ? <div className="table-empty">正在读取表格预览…</div> : items.map((item) => <article className={`batch-import-item ${item.error || item.preview?.errors.length ? "invalid" : ""}`} key={item.path}>
      <div className="batch-import-item-heading"><label className="batch-file-check"><input type="checkbox" checked={item.selected} disabled={!item.preview || Boolean(item.error) || isImporting} onChange={(event) => updateItem(item.path, { selected: event.target.checked })} /><strong>{item.preview?.fileName || item.path.split(/[\\/]/).pop()}</strong></label><button className="icon-button subtle" title="移除文件" onClick={() => setItems((current) => current.filter((candidate) => candidate.path !== item.path))}><X size={15} /></button></div>
      {item.error ? <div className="import-errors"><span>{item.error.replace(/^Error:\s*/, "")}</span><small>请移除该文件后再继续。</small></div> : item.preview && <><label className="batch-book-name">生成的礼金簿名称<input value={item.bookName} onChange={(event) => updateItem(item.path, { bookName: event.target.value })} /></label><button type="button" className="batch-style-toggle" aria-expanded={mappingOpen} onClick={() => setMappingOpen((open) => !open)}><span>编辑表格样式</span><span>{mappingOpen ? "收起" : "展开字段对应"}</span></button>{mappingOpen && <><div className="batch-mapping-row"><label>工作表<select value={item.sheetName ?? item.preview.sheetName} onChange={(event) => { const sheetName = event.target.value; updateItem(item.path, { sheetName }); void refreshPreview(item, { sheetName }); }}>{item.preview.sheetNames.map((name) => <option key={name}>{name}</option>)}</select></label></div><ReorderableColumnList columns={columnOrder} onChange={setColumnOrder} /><div className="batch-mapping-grid">{mappingFieldsForColumnOrder(columnOrder).map(([field, label]) => <label className={mappingErrors(item).some((error) => error.includes(`「${label}」`)) ? "mapping-field-error" : ""} key={field}><span>{label}</span><select value={item.mapping?.[field] ?? ""} onChange={(event) => { const mapping = completeMapping({ ...(item.mapping ?? item.preview?.currentMapping ?? {}), [field]: event.target.value === "" ? null : Number(event.target.value) }); updateItem(item.path, { mapping }); void refreshPreview(item, { mapping }); }}><option value="">不导入</option>{item.preview.headers.map((header, index) => <option value={index} key={`${index}-${header}`}>{sourceColumnLabel(header, index)}</option>)}</select></label>)}</div></>}{item.preview.tagPreview?.values.length ? <section className="spreadsheet-tags"><div className="spreadsheet-tags-heading"><strong>{item.preview.tagPreview.columnName || "人物标签"}</strong><span>{item.preview.tagPreview.values.length} 个标签</span></div><div className="spreadsheet-tag-list">{item.preview.tagPreview.values.map((tag) => <span className={`spreadsheet-tag ${tag.existing ? "existing" : "new"}`} key={tag.name}><i style={{ backgroundColor: tag.color }} /><span>{tag.name}</span><small>{tag.existing ? "已有" : "新建"} · {tag.count} 次</small></span>)}</div></section> : item.mapping?.tags !== null && item.mapping?.tags !== undefined ? <p className="field-hint spreadsheet-no-tags">人物标签列中未识别到可导入标签。</p> : null}{item.preview.rows.length > 0 && <section className="spreadsheet-sample"><div className="spreadsheet-sample-heading"><strong>表格样例</strong><span>前 {Math.min(3, item.preview.rows.length)} 行</span></div><div className="spreadsheet-sample-wrap"><table><thead><tr>{previewColumns(item.mapping, columnOrder).map(({ field, index, label }) => <th key={field} title={label}>{index === null ? label : item.preview.headers[index] || label}</th>)}</tr></thead><tbody>{item.preview.rows.slice(0, 3).map((row, rowIndex) => <tr key={`${item.path}-${rowIndex}`}>{previewColumns(item.mapping, columnOrder).map(({ field, index }) => <td key={field} title={index === null ? undefined : row[index] || undefined}>{index === null ? "-" : row[index] || "-"}</td>)}</tr>)}</tbody></table></div></section>}{(item.preview.errors.length > 0 || mappingErrors(item).length > 0) && <div className="import-errors"><strong>当前预览校验失败</strong>{mappingErrors(item).map((error) => <span key={error}>{error}</span>)}{item.preview.errors.filter((error) => !item.preview!.rowErrors.includes(error)).slice(0, 5).map((error) => <span key={error}>{error}</span>)}{item.preview.rowErrors.length > 0 && <div className="import-row-errors"><strong>逐行错误</strong>{item.preview.rowErrors.slice(0, 5).map((error) => <span key={error}>{error}</span>)}</div>}</div>}<div className="batch-item-foot"><span>识别到 {item.preview.validRows} 行有效记录</span>{item.preview.tagPreview && <span>{item.preview.tagPreview.values.length} 个标签</span>}</div></>}
    </article>)}</div>
    {isImporting && <div className="import-progress" aria-live="polite"><strong>{importPhase}</strong><span>已完成表格检查，正在处理 {validItems.reduce((total, item) => total + (item.preview?.validRows ?? 0), 0)} 条有效记录。写入采用单一事务，失败时不会保留半成品。</span><div className="import-progress-bar"><i /></div></div>}
    <p className={`batch-import-guidance ${hasBlockingItem ? "warning" : "ready"}`}>{hasBlockingItem ? "请先完成目标选择、字段映射和异常记录处理；逐行异常会被保留并在导入结果中提示。" : "确认无误后点击右下角“确认导入”，系统才会正式写入当前礼金库。"}</p><div className="modal-actions"><button className="secondary-button" onClick={onClose} disabled={isImporting}>取消</button><button className="primary-button" onClick={submit} disabled={isImporting || validItems.length === 0 || hasBlockingItem}>{isImporting ? importPhase : hasBlockingItem ? "请先完成导入检查" : `确认导入 ${validItems.length} 个文件`}</button></div>
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

function ConfirmBookClose({ book, onClose, onConfirm }: { book: GiftBook; onClose: () => void; onConfirm: () => void }) {
  return <Modal title="关闭礼金簿" className="confirm-action-modal" onClose={onClose}><p className="confirm-action-copy">确定关闭“{book.title}”？</p><p className="field-hint">礼金簿只会从当前工作区隐藏，不会删除礼金簿文件或其中的数据。之后可点击“已关闭礼金簿”重新显示。</p><div className="modal-actions"><button className="secondary-button confirm-cancel-button" onClick={onClose}>取消</button><button className="primary-button confirm-accept-button" onClick={onConfirm}>确定关闭</button></div></Modal>;
}

function ConfirmVaultClose({ vault, onClose, onConfirm }: { vault: { path: string; name: string }; onClose: () => void; onConfirm: () => void }) {
  return <Modal title="关闭礼金库" className="confirm-action-modal" onClose={onClose}><p className="confirm-action-copy">确定关闭“{vault.name}”？</p><p className="field-hint">礼金库只会从当前工作区隐藏，不会删除 `.giftvault` 文件或其中的数据。之后可通过“打开礼金库”重新显示。</p><div className="modal-actions"><button className="secondary-button confirm-cancel-button" onClick={onClose}>取消</button><button className="primary-button confirm-accept-button" onClick={onConfirm}>确定关闭</button></div></Modal>;
}

function ConfirmHistoryClear({ selectedCount, isClearing, onClose, onConfirm }: { selectedCount: number; isClearing: boolean; onClose: () => void; onConfirm: () => void }) {
  return <Modal title="删除历史改动" onClose={onClose}><p className="field-hint">{selectedCount > 0 ? `将删除已选中的 ${selectedCount} 条历史改动记录，删除后无法恢复。` : "未选择具体记录，将删除全部历史改动记录。删除后无法恢复。"}</p><div className="modal-actions"><button className="secondary-button" disabled={isClearing} onClick={onClose}>取消</button><button className="danger-button" disabled={isClearing} onClick={onConfirm}>{isClearing ? "正在删除…" : selectedCount > 0 ? "删除选中记录" : "删除全部记录"}</button></div></Modal>;
}

function submitTrashEmptyPin(event: React.KeyboardEvent<HTMLInputElement>, valid: boolean, isClearing: boolean, pin: string, onConfirm: (pin: string) => void) {
  if (event.key !== "Enter" || event.shiftKey || !valid || isClearing) return;
  event.preventDefault();
  onConfirm(pin);
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
