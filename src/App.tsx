import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  BarChart3,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CirclePlus,
  Copy,
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
import { api, createVaultApi } from "./lib/tauri";
import { useVaultApi, VaultScopeContext } from "./lib/vaultScope";
import { QueryFeedback } from "./components/QueryFeedback";
import { AboutSettings } from "./components/AboutSettings";
import { SoftwareUpdateContext, useSoftwareUpdates } from "./hooks/useSoftwareUpdates";
import { updateStatusMessage, type UpdatePhase } from "./lib/softwareUpdates";
import { invalidateVaultQueries } from "./lib/vaultQueries";
import { allowFormClose, canRestoreAudit, firstCharacter, validateChangedDate, validateChangedText } from "./lib/viewSafety";
import { forgetRecentVault, readRecentVaults, recentVaultIdentity, rememberRecentVault, type RecentVault } from "./lib/recentVaults";
import { orderGiftBooks, readComparisonVaults, readGiftBookOrder, rememberGiftBookOrder } from "./lib/comparisonVaults";
import { closeVaultSession, navigateVaultResult, readOpenedVaultSessions, rememberOpenedVaultSessions, type OpenedVaultSessionState } from "./lib/openedVaultSessions";
import { readOpenedVaultOrder, rememberOpenedVaultOrder } from "./lib/openedVaultOrder";
import { canonicalizeTags, resolveCatalogTags } from "./lib/tagCatalog";
import { getEntryTagSections, mergeEntryTag } from "./lib/entryTags";
import { normalizePersonName, personNamesMatch } from "./lib/personName";
import { CompareView as CompareViewPanel } from "./CompareView";
import type { SpreadsheetColumnMapping, SpreadsheetImportItem, SpreadsheetPreview } from "./lib/tauri";
import type { AuditLog, GiftBook, GiftEntry, SoftwareUpdateStatus as LocalUpdateStatus, Person, ReturnGiftRecord, SearchHit, SearchResponse, SessionStatus, Tab, Tag, TrashItem, VaultInfo } from "./types";
import { resolveTraceSource } from "./lib/traceSource";
import { formatMoney, formatSummaryMoney, parseAmountFen } from "./lib/money";
import { openRecentVault, openRecentVaults, resolveInitialBookId, resolveWorkspaceLaunchTarget } from "./lib/workspaceLaunch";
import { PAYMENT_METHOD_OPTIONS, resolvePaymentMethodValue } from "./lib/paymentMethods";
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
type LocalUpdatePhase = UpdatePhase;
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
  const [scope, setScope] = useState({ active: true });
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const [switching, setSwitching] = useState(false);
  const navigationBusy = useRef(false);
  const [navigationEntryId, setNavigationEntryId] = useState<string | null>(null);
  const beginNavigation = (completedForm: HTMLElement | null = null) => {
    if (navigationBusy.current || !canLeaveWorkspace(completedForm)) return false;
    navigationBusy.current = true; scopeRef.current.active = false; setSwitching(true); return true;
  };
  const endNavigation = () => { navigationBusy.current = false; setScope({ active: true }); setSwitching(false); };
  const [openedVaults, setOpenedVaults] = useState<OpenedVaultSession[]>([]);
  const [openedVaultOrder, setOpenedVaultOrder] = useState<string[]>(() => readOpenedVaultOrder());
  const [bookSelections, setBookSelections] = useState<Record<string, string | null>>({});
  const [workspaceTab, setWorkspaceTab] = useState<Tab>("entries");
  const [session, setSession] = useState<SessionStatus>({ role: "viewer", securityConfigured: false, editLocked: true });
  const [error, setError] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [createVaultOpen, setCreateVaultOpen] = useState(false);
  const [createVaultSaving, setCreateVaultSaving] = useState(false);
  const [createVaultError, setCreateVaultError] = useState<unknown>(null);
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
  const [continuousRegistration, setContinuousRegistration] = useState(true);
  const [pendingSpreadsheetPaths, setPendingSpreadsheetPaths] = useState<string[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const updates = useSoftwareUpdates({
    beforeInstall: () => rememberOpenedVaultSessions(
      openedVaults.map((item) => ({ path: item.vault.path, activeBookId: item.activeBookId, activeTab: workspaceTab })),
      vault?.path,
    ),
    onNotice: (message) => showNotice(message),
  });
  const localUpdatePhase = updates.phase;
  const localUpdate = { data: updates.status };
  const lastUpdateCheckAt = updates.status?.checkedAt ?? null;

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
        if (!beginNavigation()) return;
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
        }).catch((errorValue) => setError(String(errorValue))).finally(endNavigation);
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
    const selectedTab = tab ?? workspaceTab;
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
    if (!beginNavigation()) return;
    setError(null);
    try {
      const path = await api.chooseVaultPath("open");
      if (path) {
        const result = await api.openVault(path);
        setNavigationEntryId(null);
        applyOpenResult(result);
      }
    } catch (err) {
      setError(String(err));
    } finally { endNavigation(); }
  };

  const switchVault = async (path: string) => {
    if (vault && vaultPathKey(vault.path) === vaultPathKey(path)) return;
    if (!beginNavigation()) return;
    setError(null);
    try {
      const saved = openedVaults.find((item) => vaultPathKey(item.vault.path) === vaultPathKey(path));
      const result = await api.openVault(path);
      setNavigationEntryId(null);
      applyOpenResult(result, saved?.activeBookId ?? bookSelections[vaultPathKey(path)] ?? null);
    } catch (err) { setError(String(err)); } finally { endNavigation(); }
  };

  const closeOpenedVault = async (path: string) => {
    if (!beginNavigation()) return;
    try {
      const closed = await closeVaultSession(openedVaults.map((item) => ({ ...item, path: item.vault.path })), vault?.path ?? null, path, api.closeOpenedVault);
      const remaining = closed.sessions;
      setOpenedVaults(remaining);
      rememberOpenedVaultSessions(remaining.map((item) => ({ path: item.vault.path, activeBookId: item.activeBookId, activeTab: workspaceTab })), closed.activePath);
      if (!closed.activePath) {
        setVault(null); setPendingWorkspaceBookId(null); setNavigationEntryId(null); setWorkspaceOpen(true); client.clear();
      } else if (vault && vaultPathKey(vault.path) === vaultPathKey(path)) {
        const next = remaining.find((item) => vaultPathKey(item.vault.path) === vaultPathKey(closed.activePath!))!;
        setVault(next.vault); setPendingWorkspaceBookId(next.activeBookId); setNavigationEntryId(null);
      }
      showNotice("已关闭礼金库；原始文件和数据未删除");
    } catch (err) { setError(String(err)); } finally { endNavigation(); }
  };

  const openSearchVault = async (path: string, bookId: string, entryId: string | null = null, completedForm: HTMLElement | null = null) => {
    if (!beginNavigation(completedForm)) throw new Error("请先完成当前操作");
    try {
      await navigateVaultResult({ path, bookId, entryId }, api.openVault, (navigation) => {
        setNavigationEntryId(navigation.entryId);
        applyOpenResult(navigation.result, navigation.bookId, navigation.tab);
      });
    } finally { endNavigation(); }
  };

  const createVault = async () => {
    if (!beginNavigation(document.querySelector<HTMLElement>('[data-modal-owner="create-vault"]'))) return;
    setCreateVaultSaving(true); setCreateVaultError(null);
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
      setError(String(err)); setCreateVaultError(err);
    } finally { setCreateVaultSaving(false); endNavigation(); }
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
    if (!beginNavigation()) return;
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
    } finally { endNavigation(); }
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

  const checkLocalUpdate = () => updates.check(true);
  const installLocalUpdate = () => updates.install();

  const overlays = <>
    {updates.bannerVisible && updates.status?.candidate && <div className="software-update-banner" role="status"><span>发现新版本 v{updates.status.candidate.version}</span><button className="primary-button compact" disabled={!["idle", "ready"].includes(localUpdatePhase)} onClick={() => void updates.install()}>{localUpdatePhase === "ready" ? "重启并安装" : ["downloading", "verifying"].includes(localUpdatePhase) ? "下载校验中…" : "立即更新"}</button><button className="text-button" onClick={updates.dismiss}>稍后</button></div>}
    {updates.error && <ErrorToast message={updates.error} onClose={updates.clearError} />}
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
    return <SoftwareUpdateContext.Provider value={updates}><>
      <WelcomeScreen recentVaults={recentVaults} session={session} noticeVisible={Boolean(notice)} onUserMode={(recent) => void enterUserMode(recent)} onAdminMode={enterAdminMode} onRemoveRecent={(recent) => { setRecentVaults(forgetRecentVault(recent)); showNotice(`已从启动页移除「${recent.name}」的记录；礼金库和礼金数据未删除`); }} onCheckLocalUpdate={checkLocalUpdate} localUpdatePhase={localUpdatePhase} />
      {overlays}
    </></SoftwareUpdateContext.Provider>;
  }

  if (!vault) {
    return <SoftwareUpdateContext.Provider value={updates}><>
      <WorkspaceStart session={session} pendingSpreadsheetPaths={pendingSpreadsheetPaths} onClose={returnToStartPage} onOpenVault={openVault} onBeginCreate={() => setCreateVaultOpen(true)} onChooseImport={() => void chooseSpreadsheetPathsForWorkspace()} onUnlock={() => { setEnterWorkspaceAfterAdmin(false); setPendingWorkspaceVault(null); setAdminPrompt(session.securityConfigured ? "unlock" : "setup"); }} onChangePin={() => setPinChangeOpen(true)} />
      {createVaultOpen && <CreateVaultModal error={createVaultError} isSaving={createVaultSaving} vaultName={vaultName} vaultNotes={vaultNotes} onNameChange={setVaultName} onNotesChange={setVaultNotes} onClose={() => setCreateVaultOpen(false)} onCreate={createVault} />}
      {overlays}
    </></SoftwareUpdateContext.Provider>;
  }

  const orderedOpenedVaults = [...openedVaults].sort((left, right) => {
    const leftIndex = openedVaultOrder.findIndex((path) => vaultPathKey(path) === vaultPathKey(left.vault.path));
    const rightIndex = openedVaultOrder.findIndex((path) => vaultPathKey(path) === vaultPathKey(right.vault.path));
    return (leftIndex < 0 ? openedVaults.length : leftIndex) - (rightIndex < 0 ? openedVaults.length : rightIndex);
  });
  return <SoftwareUpdateContext.Provider value={updates}><>
    <VaultScopeContext.Provider value={scope}><div inert={switching || localUpdatePhase === "installing"} aria-busy={switching || localUpdatePhase === "installing"}><VaultWorkspace key={vault.path} initialEntryId={navigationEntryId} vault={vault} openedVaults={orderedOpenedVaults} initialBookId={pendingWorkspaceBookId} initialTab={workspaceTab} session={session} continuousRegistration={continuousRegistration} onContinuousRegistrationChange={setContinuousRegistration} onClose={returnToStartPage} onCloseVault={closeOpenedVault} onReorderVaults={reorderOpenedVaults} onError={setError} onNotice={showNotice} onUnlock={() => { setEnterWorkspaceAfterAdmin(false); setPendingWorkspaceVault(null); setAdminPrompt(session.securityConfigured ? "unlock" : "setup"); }} onLock={lockAdmin} onUnlockEditing={unlockEditing} onLockEditing={lockEditing} onChangePin={() => setPinChangeOpen(true)} onCheckLocalUpdate={checkLocalUpdate} onInstallLocalUpdate={installLocalUpdate} localUpdatePhase={localUpdatePhase} updateStatus={localUpdate.data ?? null} lastUpdateCheckAt={lastUpdateCheckAt} pendingSpreadsheetPaths={pendingSpreadsheetPaths} onConsumeSpreadsheetPaths={() => setPendingSpreadsheetPaths([])} onBeginCreateVault={() => setCreateVaultOpen(true)} onOpenVault={openVault} onSwitchVault={switchVault} onOpenSearchVault={openSearchVault} onBookSelectionChange={handleBookSelectionChange} onTabChange={handleTabChange} onVaultActivity={handleVaultActivity} onVaultUpdated={handleVaultUpdated} /></div></VaultScopeContext.Provider>
    {createVaultOpen && <CreateVaultModal error={createVaultError} isSaving={createVaultSaving} vaultName={vaultName} vaultNotes={vaultNotes} onNameChange={setVaultName} onNotesChange={setVaultNotes} onClose={() => setCreateVaultOpen(false)} onCreate={createVault} />}
    {overlays}
  </></SoftwareUpdateContext.Provider>;
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
  if (!canRestoreAudit(record)) return false;
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
  const hasRecentVaults = props.recentVaults.length > 0;
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
          {hasRecentVaults ? <><button className="primary-button" onClick={() => props.onUserMode()}><BookOpen size={17} />用户模式</button><button className="secondary-button" onClick={() => props.onAdminMode()}><ShieldCheck size={17} />管理员模式</button></> : <><button className="primary-button" onClick={() => props.onAdminMode()}><CirclePlus size={17} />首次使用：新建礼金库</button><p className="welcome-first-use-hint">设置管理员 PIN 后即可创建礼金库并开始登记。</p></>}
        </div>
        <section className="recent-vaults welcome-recent"><div className="recent-heading"><span>最近使用</span></div><div className="recent-vault-list" ref={recentListRef}>{props.recentVaults.length > 0 ? props.recentVaults.map((recent) => <article className="recent-vault-item" key={recentVaultIdentity(recent)}><button className="recent-vault-button" type="button" title={`以用户模式打开「${recent.name}」`} onClick={() => props.onUserMode(recent)}><FolderOpen size={17} /><span><strong>{recent.name}</strong><small title={recent.path}>{recent.path}</small></span></button><button className={`icon-button subtle recent-vault-action recent-vault-admin ${props.session.role === "admin" ? "active" : ""}`} type="button" title={`以管理员模式打开「${recent.name}」`} aria-label={`以管理员模式打开「${recent.name}」`} onClick={() => props.onAdminMode(recent)}><ShieldCheck size={16} /></button><button className="icon-button subtle recent-vault-action recent-vault-remove" type="button" title={`从启动页移除「${recent.name}」；不会删除礼金库或礼金数据`} aria-label={`从启动页移除「${recent.name}」；不会删除礼金库或礼金数据`} onClick={() => props.onRemoveRecent(recent)}><X size={16} /></button></article>) : <div className="recent-empty">暂无使用记录</div>}</div></section>
        <button className="text-button welcome-update" disabled={props.localUpdatePhase !== "idle"} onClick={() => props.onCheckLocalUpdate()}><RefreshCw className={props.localUpdatePhase !== "idle" ? "is-spinning" : undefined} size={15} />{props.localUpdatePhase === "checking" ? "正在检测有无可用更新…" : props.localUpdatePhase === "installing" ? "正在安装新版本…" : "检查更新"}</button>
        <VersionBadge />
      </section>
    </main>
  );
}

function WorkspaceStart({ session, pendingSpreadsheetPaths, onClose, onOpenVault, onBeginCreate, onChooseImport, onUnlock, onChangePin }: { session: SessionStatus; pendingSpreadsheetPaths: string[]; onClose: () => void; onOpenVault: () => void; onBeginCreate: () => void; onChooseImport: () => void; onUnlock: () => void; onChangePin: () => void }) {
  const isAdmin = session.role === "admin";
  return <div className="app-shell workspace-start"><header className="topbar"><div className="topbar-brand"><div className="brand-mark small"><BookOpen size={17} /></div><strong>礼金簿管理</strong><span className="slash">/</span><span className="vault-label">未打开礼金库</span></div><div className="topbar-actions"><span className={`role-badge ${isAdmin ? "admin" : "viewer"}`}>{isAdmin ? "管理员模式" : "用户模式"}</span>{isAdmin && <button className="secondary-button compact" title="修改管理员 PIN" onClick={onChangePin}><KeyRound size={14} />修改 PIN</button>}<button className="secondary-button compact return-start-button" title="返回启动页" onClick={onClose}><ArrowLeft size={15} />返回启动页</button></div></header><div className="workspace"><aside className="sidebar"><div className="sidebar-heading"><span>礼金簿管理</span></div>{isAdmin ? <button className="sidebar-create" onClick={onBeginCreate}><CirclePlus size={16} />新建礼金库</button> : <button className="sidebar-create" onClick={onUnlock}><Unlock size={16} />解锁管理并新建礼金库</button>}<button className="sidebar-create sidebar-open" onClick={onOpenVault}><FolderOpen size={16} />打开礼金库</button>{isAdmin && <button className="sidebar-create sidebar-import" onClick={onChooseImport}><FileSpreadsheet size={15} />导入表格</button>}<div className="sidebar-bottom"><VersionBadge /></div></aside><main className="content-area"><section className="workspace-empty"><BookOpen size={30} /><h2>尚未打开礼金库</h2><div className="workspace-empty-actions"><button className="primary-button" onClick={onOpenVault}><FolderOpen size={16} />打开礼金库</button>{isAdmin ? <button className="secondary-button" onClick={onBeginCreate}><CirclePlus size={16} />新建礼金库</button> : <button className="secondary-button" onClick={onUnlock}><Unlock size={16} />解锁管理并新建礼金库</button>}</div>{isAdmin && pendingSpreadsheetPaths.length > 0 && <span className="field-hint">已暂存 {pendingSpreadsheetPaths.length} 个表格文件。</span>}</section></main></div></div>;
}

function CreateVaultModal({ error, isSaving, vaultName, vaultNotes, onNameChange, onNotesChange, onClose, onCreate }: { error: unknown; isSaving: boolean; vaultName: string; vaultNotes: string; onNameChange: (value: string) => void; onNotesChange: (value: string) => void; onClose: () => void; onCreate: () => void }) {
  const validationError = validateChangedText("礼金库名称", vaultName, 256) || validateChangedText("礼金库备注", vaultNotes, 65536);
  return <Modal title="新建家庭礼金库" owner="create-vault" onClose={onClose} isSaving={isSaving} error={error || validationError}><label>礼金库名称<input value={vaultName} onChange={(event) => onNameChange(event.target.value)} autoFocus /></label><label>礼金库备注<textarea value={vaultNotes} onChange={(event) => onNotesChange(event.target.value)} placeholder="可选，例如家庭成员或使用范围" /></label><p className="field-hint">礼金库创建后会直接进入工作页。</p><div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!vaultName.trim() || Boolean(validationError) || isSaving} onClick={onCreate}>选择保存位置</button></div></Modal>;
}

function OpenedVaultTab({ item, active, dragged, dropTarget, onSwitch, onClose, onDragState, onDrop }: { item: OpenedVaultSession; active: boolean; dragged: boolean; dropTarget: boolean; onSwitch: (path: string) => void; onClose: (path: string) => void; onDragState: (path: string | null, target: string | null) => void; onDrop: (path: string, target: string | null) => void }) {
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
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
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
  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
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
  return <div className={`opened-vault-tab ${active ? "active" : ""} ${dragged ? "dragging" : ""} ${dropTarget ? "drag-target" : ""}`} data-vault-path={item.vault.path} title={item.vault.path} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag} onMouseEnter={beginHover} onMouseLeave={endHover} onFocusCapture={() => setShowClose(true)} onBlurCapture={endHover}><button type="button" className="opened-vault-tab-select" aria-pressed={active} onClick={() => { if (!suppressClickRef.current) onSwitch(item.vault.path); }}><Archive size={14} /><span>{item.vault.name}</span></button>{showClose && <button type="button" className="opened-vault-tab-close" aria-label={`关闭礼金库「${item.vault.name}」`} title={`关闭「${item.vault.name}」；不会删除原始文件`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onClose(item.vault.path); }}><X size={13} /></button>}</div>;
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
  return <div className={`book-item-row ${dragged ? "dragging" : ""} ${dropTarget ? "drag-target" : ""}`} data-book-id={book.id} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onMouseEnter={beginHover} onMouseLeave={endHover} onFocusCapture={() => setShowClose(true)} onBlurCapture={endHover}><button type="button" className={`book-item ${active ? "active" : ""}`} onClick={onSelect}><span className="book-icon"><FileSpreadsheet size={15} /></span><span className="book-item-text"><strong>{book.title}</strong></span><ChevronRight size={15} /></button>{showClose && <button type="button" className="book-item-close" title={`关闭礼金簿“${book.title}”`} aria-label={`关闭礼金簿“${book.title}”；不会删除数据`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onClose(); }}><X size={13} /></button>}</div>;
}

function VaultMetadataModal({ error, vault, isSaving, onClose, onSubmit }: { error: unknown; vault: VaultInfo; isSaving: boolean; onClose: () => void; onSubmit: (name: string, notes: string) => void }) {
  const [name, setName] = useState(vault.name);
  const [notes, setNotes] = useState(vault.notes ?? "");
  const validationError = validateChangedText("礼金库名称", name, 256, vault.name) || validateChangedText("礼金库备注", notes, 65536, vault.notes);
  return <Modal title="编辑礼金库" onClose={onClose} isSaving={isSaving} error={error || validationError}><label>礼金库名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label><label>礼金库备注<textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="可选" /></label><p className="field-hint">只修改礼金库自身信息，不会改变内部礼金簿、人物或礼金记录的归属。</p><div className="modal-actions"><button className="secondary-button" disabled={isSaving} onClick={onClose}>取消</button><button className="primary-button" disabled={!name.trim() || Boolean(validationError) || isSaving} onClick={() => onSubmit(name === vault.name ? name : name.trim(), notes)}>{isSaving ? "保存中…" : "保存修改"}</button></div></Modal>;
}

function VaultWorkspace({ initialEntryId, vault, openedVaults, initialBookId, initialTab, session, continuousRegistration, onContinuousRegistrationChange, onClose, onCloseVault, onReorderVaults, onError, onNotice, onUnlock, onLock, onUnlockEditing, onLockEditing, onChangePin, onCheckLocalUpdate, onInstallLocalUpdate, localUpdatePhase, updateStatus, lastUpdateCheckAt, pendingSpreadsheetPaths, onConsumeSpreadsheetPaths, onBeginCreateVault, onOpenVault, onSwitchVault, onOpenSearchVault, onBookSelectionChange, onTabChange, onVaultActivity, onVaultUpdated }: { initialEntryId: string | null; vault: VaultInfo; openedVaults: OpenedVaultSession[]; initialBookId: string | null; initialTab: Tab; session: SessionStatus; continuousRegistration: boolean; onContinuousRegistrationChange: (enabled: boolean) => void; onClose: () => void; onCloseVault: (path: string) => void | Promise<void>; onReorderVaults: (draggedPath: string, targetPath: string) => void; onError: (message: string) => void; onNotice: (message: string) => void; onUnlock: () => void; onLock: () => void; onUnlockEditing: () => void; onLockEditing: () => void; onChangePin: () => void; onCheckLocalUpdate: () => void; onInstallLocalUpdate: () => void; localUpdatePhase: LocalUpdatePhase; updateStatus: import("./types").SoftwareUpdateStatus | null; lastUpdateCheckAt: string | null; pendingSpreadsheetPaths: string[]; onConsumeSpreadsheetPaths: () => void; onBeginCreateVault: () => void; onOpenVault: () => void; onSwitchVault: (path: string) => Promise<void>; onOpenSearchVault: (path: string, bookId: string, entryId?: string | null, completedForm?: HTMLElement | null) => Promise<void>; onBookSelectionChange: (bookId: string | null) => void; onTabChange: (tab: Tab) => void; onVaultActivity: (book?: Pick<GiftBook, "id" | "title">) => void; onVaultUpdated: (vault: VaultInfo) => void }) {
  const api = useVaultApi(vault.path);
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
  const [focusedEntryId, setFocusedEntryId] = useState<string | null>(initialEntryId);
  useEffect(() => { if (initialBookId) setActiveBookId(initialBookId); setFocusedEntryId(initialEntryId); }, [initialBookId, initialEntryId]);
  useEffect(() => { setActiveTab(initialTab); }, [initialTab]);
  const [spreadsheetPaths, setSpreadsheetPaths] = useState<string[]>([]);
  const [spreadsheetImportOpen, setSpreadsheetImportOpen] = useState(false);
  const [spreadsheetImporting, setSpreadsheetImporting] = useState(false);
  const [spreadsheetImportPhase, setSpreadsheetImportPhase] = useState("正在准备导入");
  const [vaultEditOpen, setVaultEditOpen] = useState(false);
  const [vaultEditSaving, setVaultEditSaving] = useState(false);
  const [vaultEditError, setVaultEditError] = useState<unknown>(null);
  const [bookEditTarget, setBookEditTarget] = useState<GiftBook | null>(null);
  const bookEditTargetRef = useRef(bookEditTarget); bookEditTargetRef.current = bookEditTarget;
  useEffect(() => { if (bookEditTarget && bookEditTarget.id !== activeBookId) setBookEditTarget(null); }, [activeBookId, bookEditTarget]);
  const leaveLocalView = () => {
    if (!canLeaveWorkspace()) return false;
    setBookModal(false); bookEditTargetRef.current = null; setBookEditTarget(null); setVaultEditOpen(false); setSpreadsheetImportOpen(false); return true;
  };
  const selectBook = (bookId: string) => { if (bookId === activeBookId && activeTab === "entries") return; if (!leaveLocalView()) return; setActiveBookId(bookId); setActiveTab("entries"); setFocusedEntryId(null); onVaultActivity(); };
  const selectTab = (tab: Tab) => { if (tab === activeTab || !leaveLocalView()) return; setActiveTab(tab); };
  const [bookEditSaving, setBookEditSaving] = useState(false);
  const [bookEditError, setBookEditError] = useState<unknown>(null);
  const [importError, setImportError] = useState<unknown>(null);
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
  const searchResults = useQuery({ queryKey: ["vault-search", vault.path, openedSearchKey, debouncedSearch], queryFn: () => api.searchVault(debouncedSearch, openedSearchPaths), enabled: searchOpen && Boolean(debouncedSearch.trim()) });
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
    onSuccess: (book) => { invalidateVaultQueries(client, vault.path); if (!api.isCurrent()) return; const completedForm = document.querySelector<HTMLElement>('[data-modal-owner="create-book"]'); setBookModal(false); if (!canLeaveWorkspace(completedForm)) { onNotice("礼金簿已创建，当前草稿仍保留。"); return; } setActiveBookId(book.id); markVaultActivity(); },
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
    setVaultEditSaving(true); setVaultEditError(null);
    try {
      const updated = await api.editVault(name, notes);
      await invalidateVaultQueries(client, vault.path);
      if (!api.isCurrent()) return;
      onVaultUpdated(updated);
      setVaultEditOpen(false);
      onNotice("礼金库信息已更新");
    } catch (err) {
      setVaultEditError(err); onError(String(err));
    } finally {
      setVaultEditSaving(false);
    }
  };
  const editBook = async (input: { title: string; occasion: string; eventDate: string; location: string; notes: string }) => {
    const target = bookEditTarget;
    if (!target || bookEditTargetRef.current !== target) return;
    setBookEditSaving(true); setBookEditError(null);
    try {
      await api.editBook(target.id, input);
      await invalidateVaultQueries(client, vault.path);
      if (!api.isCurrent()) return;
      setBookEditTarget(null);
      markVaultActivity();
      onNotice("礼金簿信息已更新");
    } catch (err) {
      setBookEditError(err); onError(String(err));
    } finally {
      setBookEditSaving(false);
    }
  };
  const openSearchHit = async (hit: SearchHit) => {
    if (!canLeaveWorkspace()) return;
    if (vaultPathKey(hit.vaultPath) !== vaultPathKey(vault.path)) {
      try {
        await onOpenSearchVault(hit.vaultPath, hit.entry.bookId, hit.entry.id);
        setSearch(""); setSearchOpen(false);
      } catch (err) {
        onError(String(err));
      }
      return;
    }
    if (!leaveLocalView()) return;
    setSearch(""); setSearchOpen(false);
    setActiveBookId(hit.entry.bookId);
    setActiveTab("entries");
    setFocusedEntryId(hit.entry.id);
    markVaultActivity();
  };

  const traceSource = async (entityType: string, entityId: string, bookId?: string) => {
    if (!canLeaveWorkspace()) return;
    try {
      const liveBooks = await api.listBooks();
      const candidates = bookId ? liveBooks.filter((book) => book.id === bookId) : liveBooks;
      const entries = (await Promise.all(candidates.map((book) => api.listEntries(book.id, "")))).flat();
      if (!api.isCurrent()) return;
      const entry = resolveTraceSource(entityType, entityId, entries);
      if (!entry) { onNotice(entityType === "person" ? "无法唯一定位来源礼金记录：记录不存在或对应多条记录" : "找不到来源礼金记录，可能已被删除"); return; }
      if (!leaveLocalView()) return;
      setClosedBookIds((current) => { const next = new Set(current); next.delete(entry.bookId); return next; });
      setActiveBookId(entry.bookId); setActiveTab("entries"); setFocusedEntryId(entry.id); markVaultActivity();
    } catch (error) { onNotice(`查找来源失败：${String(error).replace(/^Error:\s*/, "")}`); }
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
      await invalidateVaultQueries(client, vault.path);
      if (!api.isCurrent()) return;
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
    if (!leaveLocalView()) return;
    setBookToClose(book);
  };

  const confirmCloseBook = () => {
    const book = bookToClose;
    if (!book || !leaveLocalView()) return;
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
          <div className="topbar-actions"><div className="global-search-wrap" ref={searchWrapRef}><label className="tag-search-field" aria-label="全库搜索"><Search size={16} /><input id="vault-global-search" value={search} onFocus={() => setSearchOpen(true)} onChange={(event) => { const value = event.target.value; setSearch(value); setSearchOpen(Boolean(value.trim())); }} placeholder="搜索姓名、金额、地址、标签等" /></label>{searchOpen && search.trim() && <SearchResults result={searchResults.data} isLoading={searchResults.isPending || search.trim() !== debouncedSearch.trim()} isError={searchResults.isError} onRetry={() => void searchResults.refetch()} onSelect={openSearchHit} />}</div><div className="file-info-wrap" ref={fileInfoWrapRef}><button className="offline-pill button-reset" onClick={() => setFileInfoOpen((open) => !open)}><span className="status-dot" />{isAdmin ? "管理员模式" : "用户模式"}</button>{fileInfoOpen && <div className="file-info-popover"><strong>{vault.name}</strong>{vault.notes && <span className="file-info-notes">{vault.notes}</span>}<span className="file-path">{vault.path}</span><span className={`role-badge ${isAdmin ? "admin" : "viewer"}`}>{isAdmin ? "管理员模式" : "用户模式"}</span><div className="popover-actions">{isAdmin && <button aria-pressed={continuousRegistration} className={`secondary-button compact continuous-registration-button ${continuousRegistration ? "active" : ""}`} disabled={!canEdit} data-operation-hint={!canEdit ? "提示：请先解锁编辑，再开始持续登记。" : continuousRegistration ? "提示：持续登记已开启，保存后会自动进入下一条；点击可关闭。" : "提示：点击开启持续登记，保存后会自动进入下一条。"} onClick={() => onContinuousRegistrationChange(!continuousRegistration)}>{continuousRegistration ? <Unlock size={14} /> : <LockKeyhole size={14} />}{continuousRegistration ? "持续登记：已开启" : "持续登记：已关闭"}</button>}{isAdmin ? <button className="secondary-button compact" title="切换到用户模式" onClick={onLock}><LockKeyhole size={14} />切换模式</button> : <button className="primary-button compact" onClick={onUnlock}><Unlock size={14} />解锁管理</button>}<button className="secondary-button compact" title="返回启动页" onClick={onClose}><ArrowLeft size={15} />返回启动页</button></div></div>}</div>{activeTab !== "entries" && <button className="secondary-button compact return-detail-button topbar-return-detail" title="返回明细" onClick={() => selectTab("entries")}><ArrowLeft size={15} />返回明细</button>}</div>
      </header>
      <nav className="opened-vault-tabs" aria-label="已打开礼金库">
        <div className="opened-vault-tabs-list">
          {openedVaults.map((item) => <OpenedVaultTab item={item} active={vaultPathKey(item.vault.path) === vaultPathKey(vault.path)} dragged={vaultPathKey(item.vault.path) === vaultPathKey(draggedVaultPath ?? "")} dropTarget={vaultPathKey(item.vault.path) === vaultPathKey(vaultDropTargetPath ?? "") && vaultPathKey(item.vault.path) !== vaultPathKey(draggedVaultPath ?? "")} key={vaultPathKey(item.vault.path)} onSwitch={onSwitchVault} onClose={onCloseVault} onDragState={handleVaultDragState} onDrop={() => handleVaultDragState(null, null)} />)}
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
            <QueryFeedback query={books} label="礼金簿" />
          {orderedBooks.map((book) => <BookListItem key={book.id} data-book-id={book.id} book={book} active={book.id === activeBookId} dragged={draggedBookId === book.id} dropTarget={bookDropTargetId === book.id && draggedBookId !== book.id} onPointerDown={(event) => startBookDrag(event, book.id)} onPointerMove={moveBookDrag} onPointerUp={finishBookDrag} onPointerCancel={clearBookDrag} onSelect={() => { if (suppressBookClickRef.current) return; selectBook(book.id); }} onClose={() => closeBook(book)} />)}
          {closedBookIds.size > 0 && <button type="button" className="closed-books-link" onClick={reopenClosedBooks}><Archive size={13} />已关闭礼金簿（{closedBookIds.size}）</button>}
            {books.isSuccess && books.data?.length === 0 && <div className="empty-mini">还没有礼金簿</div>}
          </div>
          <div className="sidebar-bottom"><button className={`sidebar-link ${activeTab === "settings" ? "active" : ""}`} onClick={() => selectTab("settings")}><Settings size={15} />设置</button><button className={`sidebar-link ${activeTab === "returnGifts" ? "active" : ""}`} onClick={() => selectTab("returnGifts")}><Gift size={15} />回礼明细</button><button className={`sidebar-link ${activeTab === "history" ? "active" : ""}`} onClick={() => selectTab("history")}><History size={15} />历史改动</button><button className={`sidebar-link trash-drop-target ${activeTab === "trash" ? "active" : ""} ${trashDropActive ? "drag-over" : ""}`} onDragOver={(event) => { event.preventDefault(); setTrashDropActive(true); }} onDragLeave={() => setTrashDropActive(false)} onDrop={(event) => void dropToTrash(event)} onClick={() => selectTab("trash")}><Trash2 size={15} />回收站</button><VersionBadge /></div>
        </aside>
        <main className="content-area">
          {activeTab === "settings" ? <div className="content-view settings"><SettingsView session={session} onUnlock={onUnlock} onUnlockEditing={onUnlockEditing} onLockEditing={onLockEditing} onChangePin={onChangePin} onCheckUpdate={() => onCheckLocalUpdate()} onInstallUpdate={onInstallLocalUpdate} updatePhase={localUpdatePhase} updateStatus={updateStatus} lastUpdateCheckAt={lastUpdateCheckAt} onNotice={onNotice} onError={onError} /></div> : activeTab === "trash" && !activeBook ? <div className="content-view trash"><TrashView scopeDescription={openedVaults.map((item) => `${item.vault.name}（${item.vault.path}）`).join("、")} openedVaultPaths={openedVaults.map((item) => item.vault.path)} vaultPath={vault.path} onNotice={onNotice} isAdmin={canEdit} onVaultActivity={onVaultActivity} /></div> : !activeBook && activeTab === "compare" ? <div className="content-view compare"><CompareViewPanel vaultPath={vault.path} onNotice={onNotice} canEdit={canEdit} bookOrder={bookOrder} /></div> : !activeBook && activeTab === "returnGifts" ? <div className="content-view returnGifts"><ReturnGiftsView vaultPath={vault.path} isAdmin={canEdit} onError={onError} onVaultActivity={onVaultActivity} onTrace={traceSource} /></div> : !activeBook && activeTab === "history" ? <div className="content-view history"><HistoryView vaultPath={vault.path} vaultName={vault.name} isAdmin={canEdit} onNotice={onNotice} onVaultUpdated={onVaultUpdated} onTrace={traceSource} /></div> : activeBook ? (
             <>
               {showBookNavigation && <><div className="content-heading"><div><h2>{activeBook.title}{canEdit && <button className="icon-button subtle book-title-edit" data-operation-hint="提示：仅修改礼金簿名称、活动信息和备注。" type="button" title="编辑礼金簿" aria-label="编辑礼金簿" onClick={() => { if (canLeaveWorkspace()) setBookEditTarget({ ...activeBook }); }}><Pencil size={16} /></button>}</h2><BookMetadata book={activeBook} vaultPath={vault.path} /></div><div className="heading-actions" /></div>
               <nav className="tab-bar"><button className={activeTab === "entries" ? "active" : ""} onClick={() => selectTab("entries")}><LayoutDashboard size={16} />礼金明细</button><button className={activeTab === "people" ? "active" : ""} onClick={() => selectTab("people")}><UsersRound size={16} />人物与标签</button><button className={activeTab === "compare" ? "active" : ""} onClick={() => selectTab("compare")}><BarChart3 size={16} />跨簿比较</button></nav></>}
              <div className={`content-view ${activeTab}`}>
                {activeTab === "trash" && <TrashView scopeDescription={openedVaults.map((item) => `${item.vault.name}（${item.vault.path}）`).join("、")} openedVaultPaths={openedVaults.map((item) => item.vault.path)} vaultPath={vault.path} onNotice={onNotice} isAdmin={canEdit} onVaultActivity={onVaultActivity} />}
                {activeTab === "entries" && <EntriesView key={activeBook.id} book={activeBook} vaultPath={vault.path} onError={onError} onNotice={onNotice} isAdmin={isAdmin} editLocked={session.editLocked} continuousRegistration={continuousRegistration} onStopContinuousRegistration={() => onContinuousRegistrationChange(false)} onUnlockEditing={onUnlockEditing} onLockEditing={onLockEditing} focusedEntryId={focusedEntryId} onExportVault={exportVault} onEditVault={() => setVaultEditOpen(true)} onVaultActivity={onVaultActivity} />}
                {activeTab === "people" && <PeopleView key={activeBook.id} vaultPath={vault.path} bookId={activeBook.id} onError={onError} isAdmin={isAdmin} editLocked={session.editLocked} onVaultActivity={onVaultActivity} />}
                {activeTab === "compare" && <CompareViewPanel vaultPath={vault.path} onNotice={onNotice} canEdit={canEdit} bookOrder={bookOrder} />}
                {activeTab === "returnGifts" && <ReturnGiftsView vaultPath={vault.path} isAdmin={canEdit} onError={onError} onVaultActivity={onVaultActivity} onTrace={traceSource} />}
                {activeTab === "history" && <HistoryView vaultPath={vault.path} vaultName={vault.name} isAdmin={canEdit} onNotice={onNotice} onVaultUpdated={onVaultUpdated} onTrace={traceSource} />}
              </div>
            </>
          ) : books.isPending || books.isError ? <QueryFeedback query={books} label="礼金簿" /> : <EmptyBookState onCreate={() => canEdit && setBookModal(true)} />}
        </main>
      </div>
      {bookModal && <BookModal error={createBook.error} onClose={() => setBookModal(false)} onSubmit={(input) => createBook.mutate(input)} isSaving={createBook.isPending} />}
      {vaultEditOpen && <VaultMetadataModal error={vaultEditError} vault={vault} isSaving={vaultEditSaving} onClose={() => setVaultEditOpen(false)} onSubmit={editVault} />}
      {bookEditTarget && <BookMetadataModal key={bookEditTarget.id} error={bookEditError} book={bookEditTarget} isSaving={bookEditSaving} onClose={() => setBookEditTarget(null)} onSubmit={editBook} />}
      {bookToClose && <ConfirmBookClose book={bookToClose} onClose={() => setBookToClose(null)} onConfirm={confirmCloseBook} />}
      {spreadsheetImportOpen && <SpreadsheetBatchModal error={importError} targetQuery={openedVaultBooks} paths={spreadsheetPaths} books={openedVaultBooks.data ?? []} vaults={openedVaults.map((item) => item.vault)} activeVaultPath={vault.path} activeBookId={activeBookId} isImporting={spreadsheetImporting} importPhase={spreadsheetImportPhase} onClose={() => { setSpreadsheetImportOpen(false); setSpreadsheetPaths([]); }} onChooseMore={async () => { try { const paths = await api.chooseSpreadsheetPaths(); const vaultCount = paths.filter((path) => path.toLocaleLowerCase().endsWith(".giftvault")).length; if (vaultCount) onNotice(`已跳过 ${vaultCount} 个礼金库文件，请使用“打开礼金库”切换礼金库`); return paths.filter((path) => !path.toLocaleLowerCase().endsWith(".giftvault")); } catch (err) { onError(String(err)); return []; } }} onImport={async (items) => { setImportError(null); setSpreadsheetImporting(true); setSpreadsheetImportPhase("正在写入礼金簿"); try { const result = await api.importSpreadsheets(items); setSpreadsheetImportPhase("正在刷新页面数据"); await Promise.all(uniquePaths(items.map((item) => item.targetVaultPath || vault.path)).map((path) => invalidateVaultQueries(client, path))); if (!api.isCurrent()) return; const completedForm = document.querySelector<HTMLElement>('[data-modal-owner="spreadsheet-import"]'); setSpreadsheetImportOpen(false); setSpreadsheetPaths([]); if (!canLeaveWorkspace(completedForm)) { onNotice(`已导入 ${result.imported} 条记录，当前草稿仍保留；请完成当前操作后打开导入目标。`); return; } if (result.books[0]) { if (items[0]?.targetVaultPath && vaultPathKey(items[0].targetVaultPath) !== vaultPathKey(vault.path)) await onOpenSearchVault(items[0].targetVaultPath, result.books[0].book.id, null, completedForm); else { setActiveBookId(result.books[0].book.id); setActiveTab("entries"); onVaultActivity(); } } onNotice(result.skippedRows.length ? `已导入 ${result.imported} 条记录；跳过 ${result.skippedRows.length} 行。${result.skippedRows.slice(0, 3).join("；")}${result.skippedRows.length > 3 ? "；其余异常请在导入预览中查看" : ""}` : `已从 ${result.books.length} 个文件导入 ${result.imported} 条记录`); } catch (err) { setImportError(err); onError(String(err)); } finally { setSpreadsheetImporting(false); setSpreadsheetImportPhase("正在准备导入"); } }} />}
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
  const updateMessage = updateStatusMessage(updateStatus);
  return <section className="settings-view"><div className="settings-heading"><div><span className="eyebrow">软件设置</span><h2>设置</h2><p>管理本机偏好、编辑权限和软件版本信息。</p></div></div><div className="settings-layout"><nav className="settings-nav" aria-label="设置分类"><button type="button" className={section === "general" ? "active" : ""} onClick={() => setSection("general")}><Settings size={15} />通用</button><button type="button" className={section === "about" ? "active" : ""} onClick={() => setSection("about")}><Info size={15} />关于</button><button type="button" className={section === "donate" ? "active" : ""} onClick={() => setSection("donate")}><Gift size={15} />打赏支持</button></nav><div className="settings-content">{section === "general" ? <><section className="settings-panel"><div><strong>默认文件夹</strong><p className="settings-path" title={storage.data?.directory}>{storage.isLoading ? "正在读取…" : storage.data?.directory}</p><p>用于新建或打开礼金库、选择导入表格时的默认位置；不会移动已有文件。</p><button className="secondary-button compact" disabled={chooseDirectory.isPending} onClick={() => chooseDirectory.mutate()}><FolderOpen size={14} />{chooseDirectory.isPending ? "选择中…" : "选择默认文件夹"}</button></div></section><section className="settings-panel"><div className="toolbar-actions">{isAdmin ? <><button className="secondary-button compact edit-lock-button" data-operation-hint={session.editLocked ? "提示：解锁后可执行删除和重要资料修改。" : "提示：锁定后将暂停高风险修改与删除。"} type="button" onClick={session.editLocked ? onUnlockEditing : onLockEditing}><LockKeyhole size={14} />{session.editLocked ? "解锁编辑" : "锁定编辑"}</button><button className="secondary-button compact" data-operation-hint="提示：修改 PIN 后会生成新的恢复码。" type="button" onClick={onChangePin}><KeyRound size={14} />修改 PIN</button><button className="secondary-button compact" type="button" onClick={() => setTableStyleOpen((open) => !open)}><ArrowUpDown size={14} />编辑表格样式</button></> : <button className="secondary-button compact" data-operation-hint="提示：管理员解锁后可管理编辑保护和 PIN。" type="button" onClick={onUnlock}><Unlock size={14} />管理员解锁</button>}</div></section>{tableStyleOpen && <TableStyleSettings canEdit={isAdmin && !session.editLocked} onNotice={onNotice} />}</> : section === "about" ? <AboutSettings updatePhase={updatePhase} updateStatus={updateStatus} checkedAt={checkedAt} updateMessage={updateMessage} onCheckUpdate={onCheckUpdate} onInstallUpdate={onInstallUpdate} onShowLicense={checkLicense} licenseOpen={licenseOpen} licenseText={licenseText} /> : <DonationSettings />}</div></div></section>;
}

const DEFAULT_TABLE_COLUMNS = ["姓名", "金额", "支付方式", "地址", "备注", "标签", "回礼金额", "回礼备注", "回礼时间", "登记日期"];
const DISPLAY_TABLE_COLUMNS = new Set(["姓名", "金额", "支付方式", "地址", "备注", "标签", "回礼金额", "登记日期"]);
const TABLE_COLUMNS_KEY = "lijin-book.table-columns";

function TableStyleSettings({ canEdit, onNotice }: { canEdit: boolean; onNotice: (message: string) => void }) {
  const [unlocked, setUnlocked] = useState(false);
  const [columns, setColumns] = useState<string[]>(() => { try { const saved = JSON.parse(localStorage.getItem(TABLE_COLUMNS_KEY) || "null"); return Array.isArray(saved) && saved.length === DEFAULT_TABLE_COLUMNS.length && new Set(saved).size === saved.length ? saved : DEFAULT_TABLE_COLUMNS; } catch { return DEFAULT_TABLE_COLUMNS; } });
  const move = (index: number, direction: -1 | 1) => setColumns((current) => { const target = index + direction; if (!unlocked || target < 0 || target >= current.length) return current; const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next; });
  const save = () => { if (!canEdit || !unlocked || new Set(columns).size !== DEFAULT_TABLE_COLUMNS.length) return; localStorage.setItem(TABLE_COLUMNS_KEY, JSON.stringify(columns)); onNotice("表格列顺序已保存；导出和明细展示将使用新顺序。"); setUnlocked(false); };
  return <section className="settings-panel table-style-settings"><div className="table-style-heading"><div><strong>默认表格列顺序</strong><p>仅调整显示和导出顺序，不改变字段含义或原始数据。</p></div><button className="secondary-button compact" disabled={!canEdit} onClick={() => setUnlocked((value) => !value)}><LockKeyhole size={14} />{unlocked ? "锁定顺序" : "解锁编辑"}</button></div><ol>{columns.map((column, index) => <li key={column}><span>{index + 1}. {column}</span><div>{unlocked && <><button className="icon-button subtle" title="上移" disabled={index === 0} onClick={() => move(index, -1)}><ArrowLeft size={14} /></button><button className="icon-button subtle" title="下移" disabled={index === columns.length - 1} onClick={() => move(index, 1)}><ArrowRight size={14} /></button></>}</div></li>)}</ol><div className="modal-actions"><button className="secondary-button compact" disabled={!unlocked} onClick={() => setColumns(DEFAULT_TABLE_COLUMNS)}>恢复默认</button><button className="primary-button compact" disabled={!canEdit || !unlocked} onClick={save}>保存顺序</button></div></section>;
}

function readTableColumns() {
  try { const saved = JSON.parse(localStorage.getItem(TABLE_COLUMNS_KEY) || "null"); return Array.isArray(saved) && saved.length === DEFAULT_TABLE_COLUMNS.length && saved.every((column) => DEFAULT_TABLE_COLUMNS.includes(column)) ? saved as string[] : DEFAULT_TABLE_COLUMNS; } catch { return DEFAULT_TABLE_COLUMNS; }
}

function renderEntryColumn(column: string, entry: GiftEntry, entryTags: Tag[]) {
  if (column === "姓名") return <td className="entry-accent-cell"><div className="person-cell"><span className="avatar">{firstCharacter(entry.personName)}</span><strong>{entry.personName}</strong></div></td>;
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


function EntriesView({ book, vaultPath, onError, onNotice, isAdmin, editLocked, continuousRegistration, onStopContinuousRegistration, onUnlockEditing, onLockEditing, focusedEntryId, onExportVault, onEditVault, onVaultActivity }: { book: GiftBook; vaultPath: string; onError: (message: string) => void; onNotice: (message: string) => void; isAdmin: boolean; editLocked: boolean; continuousRegistration: boolean; onStopContinuousRegistration: () => void; onUnlockEditing: () => void; onLockEditing: () => void; focusedEntryId: string | null; onExportVault: () => void; onEditVault: () => void; onVaultActivity: () => void }) {
  const api = useVaultApi(vaultPath);
  const client = useQueryClient();
  const [entryModal, setEntryModal] = useState(false);
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
  const createTag = useMutation({ mutationFn: ({ name, color }: { name: string; color: string }) => api.createTag(name, color), onSuccess: () => { invalidateVaultQueries(client, vaultPath); if (!api.isCurrent()) return; onVaultActivity(); }, onError: (err) => onError(String(err)) });
  const deleteEntry = useMutation({ mutationFn: api.deleteEntry, onSuccess: () => { invalidateVaultQueries(client, vaultPath); if (!api.isCurrent()) return; onVaultActivity(); }, onError: (err) => onError(String(err)) });
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
  const createEntry = useMutation({ mutationFn: (input: EntryDraft) => api.createEntry({ bookId: book.id, ...input }), onSuccess: () => { invalidateVaultQueries(client, vaultPath); if (!api.isCurrent()) return; onVaultActivity(); if (continuousRegistration) { setEntryFormKey((key) => key + 1); setEntryModal(true); onNotice("登记成功，请继续登记下一条礼金"); } else { setEntryModal(false); } }, onError: (err) => onError(String(err)) });
  const updateEntry = useMutation({ mutationFn: (input: EntryDraft & { entryId: string }) => api.updateEntry(input), onSuccess: () => { invalidateVaultQueries(client, vaultPath); if (!api.isCurrent()) return; setEditingEntry(null); onVaultActivity(); }, onError: (err) => onError(String(err)) });
  useEffect(() => {
    if (!focusedEntryId || !queryEntries.data?.some((entry) => entry.id === focusedEntryId)) return;
    document.getElementById(`entry-${focusedEntryId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusedEntryId, queryEntries.data]);
  const exportSpreadsheet = async () => {
    try { const path = await api.exportBookXlsx(book.id, tableColumns); onNotice(`已导出 Excel：${path}`); } catch (err) { onError(String(err)); }
  };
  if (queryEntries.data === undefined && (queryEntries.isPending || queryEntries.isError)) return <QueryFeedback query={queryEntries} label="礼金记录" />;
  return <section className={`entries-view ${editLocked ? "edit-locked" : ""}`}><QueryFeedback query={tags} label="人物标签" /><QueryFeedback query={queryEntries} label="礼金记录" />
    <div className="metric-grid summary-strip"><Metric label="礼金笔数" value={`${filteredSummary.giftCount}`} accent="blue" /><Metric label="最高金额" value={formatMoney(filteredSummary.highestAmountFen)} accent="green" /><Metric label="礼金总额" value={summaryMoney.primary} detail={summaryMoney.exact} accent="amber" /></div>
    <div className="toolbar entries-toolbar"><div className="entries-filter-summary"><button className={`secondary-button compact filter-toggle ${activeFilterCount ? "active" : ""}`} type="button" aria-expanded={filterOpen} onClick={() => setFilterOpen((open) => !open)}><Filter size={14} />筛选{activeFilterCount ? `（${activeFilterCount}）` : ""}</button><span className="sort-control" ref={sortControlRef}><button className={`secondary-button compact sort-toggle ${sort ? "active" : ""}`} type="button" aria-expanded={sortOpen} aria-controls="entry-sort-popover" onClick={() => setSortOpen((open) => !open)}><ArrowUpDown size={14} />{sort ? `排序：${sortFieldLabel(sort.field)}${sort.direction === "asc" ? "↑" : "↓"}` : "排序"}</button>{sortOpen && <EntrySortPanel sort={sort} onChange={setSort} onClear={() => { setSort(null); setSortOpen(false); }} />}</span><span className="toolbar-note">当前显示 {filteredEntries.length} / {entries.data?.length ?? 0} 条记录</span></div><div className="toolbar-actions">{isAdmin && <button className={`secondary-button compact edit-lock-button ${editLocked ? "locked" : "unlocked"}`} data-operation-hint={editLocked ? "提示：解锁后可执行删除和重要资料修改。" : "提示：锁定后将暂停高风险修改与删除。"} type="button" onClick={editLocked ? onUnlockEditing : onLockEditing}><LockKeyhole size={14} />{editLocked ? "锁定编辑" : "已解锁编辑"}</button>}{canEdit && <button className="secondary-button compact" data-operation-hint="提示：仅修改礼金库名称和备注，不会改变内部数据归属。" onClick={onEditVault}><Pencil size={15} />编辑礼金库</button>}<button className="secondary-button compact" onClick={exportSpreadsheet}><FileSpreadsheet size={15} />导出 Excel</button><button className="secondary-button compact" onClick={onExportVault}><Archive size={15} />导出库</button>{canEdit && <button className="primary-button compact" onClick={() => setEntryModal(true)}><CirclePlus size={15} />登记礼金</button>}</div></div>
    {filterOpen && <EntryFilterPanel filter={filter} availableTags={usedTags} dateBounds={dateBounds} onChange={setFilter} onDateChange={(startDate, endDate) => { setDateTouched(true); setFilter((current) => ({ ...current, startDate, endDate })); }} onReset={() => { setDateTouched(false); setFilter(EMPTY_ENTRY_FILTER); setSort(null); }} />}
	    <section className="table-panel"><div className="table-panel-heading"><div><strong>礼金明细</strong><span>{filteredEntries.length} 条记录</span></div></div>{entries.isLoading ? <div className="table-empty">正在加载礼金记录…</div> : filteredEntries.length ? <div className="table-wrap"><table><thead><tr>{visibleTableColumns.map((column) => <th className={column === "标签" ? "tag-column" : ""} key={column}>{column}</th>)}<th className="entry-details-column" aria-label="更多信息" />{isAdmin && <th />}</tr></thead><tbody>{sortedEntries.map((entry) => {
	      const entryTags = entry.tags.map((id) => tagById.get(id)).filter((tag): tag is Tag => Boolean(tag));
	      const rowClassName = ["entry-row", entry.id === focusedEntryId ? "search-focused" : ""].filter(Boolean).join(" ");
	      const expanded = expandedEntryIds.has(entry.id);
	      const toggleDetails = () => setExpandedEntryIds((current) => { const next = new Set(current); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next; });
	      return <Fragment key={entry.id}><tr id={`entry-${entry.id}`} draggable={canEdit} onDragStart={(event) => { event.dataTransfer.setData("application/x-lijin-trash-kind", "entry"); event.dataTransfer.setData("application/x-lijin-trash-id", entry.id); }} className={rowClassName} style={{ "--entry-tag-color": entryTags[0]?.color ?? "#a9b5b9" } as React.CSSProperties}>{visibleTableColumns.map((column) => <Fragment key={column}>{renderEntryColumn(column, entry, entryTags)}</Fragment>)}<td className="entry-details-action"><button className="icon-button subtle" type="button" aria-expanded={expanded} aria-label={expanded ? "收起更多信息" : "展开更多信息"} title={expanded ? "收起更多信息" : "展开更多信息"} onClick={toggleDetails}>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button></td>{canEdit && <td><div className="row-actions"><button className="icon-button subtle" data-operation-hint="提示：可修改此人的礼金、标签及回礼信息。" title="编辑信息" onClick={() => setEditingEntry(entry)}><Pencil size={15} /></button><button className="icon-button danger subtle" data-operation-hint="提示：删除后将进入回收站，可在回收站恢复。" title="删除记录" onClick={() => setDeletingEntry(entry)}><Trash2 size={15} /></button></div></td>}</tr>{expanded && <EntryMoreInfo entry={entry} colSpan={visibleTableColumns.length + 1 + (canEdit ? 1 : 0)} />}</Fragment>;
    })}</tbody></table></div> : entries.isError ? null : <div className="table-empty"><Filter size={27} /><strong>{entries.data?.length ? "没有符合条件的礼金记录" : "还没有礼金记录"}</strong><span>{entries.data?.length ? "请调整筛选条件后重试。" : "从第一笔登记开始建立这本礼金簿。"}</span>{!entries.data?.length && !entries.isError && isAdmin && <button className="primary-button compact" onClick={() => setEntryModal(true)}><CirclePlus size={15} />登记第一笔</button>}</div>}</section>
     {entryModal && <EntryModal key={entryFormKey} tagsReady={tags.isSuccess && !tags.isFetching} tagsError={tags.error} onRetryTags={() => void tags.refetch()} error={createEntry.error} tags={displayTags} vaultPath={vaultPath} onCreateTag={(name, color) => createTag.mutateAsync({ name, color })} onClose={() => { setEntryModal(false); onStopContinuousRegistration(); }} onSubmit={(input) => createEntry.mutate(input)} isSaving={createEntry.isPending} />}
    {editingEntry && <EntryModal tagsReady={tags.isSuccess && !tags.isFetching} tagsError={tags.error} onRetryTags={() => void tags.refetch()} error={updateEntry.error} tags={displayTags} vaultPath={vaultPath} onCreateTag={(name, color) => createTag.mutateAsync({ name, color })} initial={editingEntry} title="编辑信息" onClose={() => setEditingEntry(null)} onSubmit={(input) => updateEntry.mutate({ entryId: editingEntry.id, ...input })} isSaving={updateEntry.isPending} />}
    {deletingEntry && <ConfirmEntryDelete entry={deletingEntry} onClose={() => setDeletingEntry(null)} onConfirm={() => { deleteEntry.mutate(deletingEntry.id); setDeletingEntry(null); }} />}
  </section>;
}

function sortFieldLabel(field: EntrySortField) {
  return field === "amount" ? "礼金金额" : field === "returnAmount" ? "回礼金额" : field === "receivedAt" ? "登记日期" : "姓名";
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

async function createBatchPreviewItem(path: string, vaultPath: string): Promise<BatchPreviewState> {
  try {
    const preview = await createVaultApi(vaultPath).previewSpreadsheet(path);
    const fileName = preview.fileName.replace(/\.[^.]+$/, "");
    return { path, preview, error: null, selected: true, bookName: fileName || "导入礼金簿", mapping: preview.currentMapping, sheetName: preview.sheetName, headerRow: preview.headerRow, targetBookId: "" };
  } catch (errorValue) {
    const fileName = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "导入礼金簿";
    const emptyMapping = completeMapping({});
    return { path, preview: { fileName, sheetName: "", sheetNames: [], headerRow: 1, suggestedMapping: emptyMapping, currentMapping: emptyMapping, headers: [], rows: [], validRows: 0, errors: [], rowErrors: [], tagPreview: null }, error: String(errorValue), selected: true, bookName: fileName, mapping: null, sheetName: null, headerRow: null, targetBookId: "" };
  }
}

function previewColumns(mapping: SpreadsheetColumnMapping | null) {
  return DEFAULT_IMPORT_PREVIEW_FIELDS.map(([field, label]) => ({ field, label, index: mapping?.[field] ?? null }));
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

function SpreadsheetBatchModal({ error, paths, targetQuery, books, vaults, activeVaultPath, activeBookId, isImporting, importPhase, onClose, onChooseMore, onImport }: { error: unknown; paths: string[]; targetQuery: { isPending: boolean; isError: boolean; isFetching: boolean; error: unknown; data?: unknown; refetch: () => unknown }; books: Array<GiftBook & { vaultPath: string; vaultName: string }>; vaults: VaultInfo[]; activeVaultPath: string; activeBookId: string | null; isImporting: boolean; importPhase: string; onClose: () => void; onChooseMore: () => Promise<string[]>; onImport: (items: SpreadsheetImportItem[]) => void }) {
  const [items, setItems] = useState<BatchPreviewState[]>([]);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [targetVaultPath, setTargetVaultPath] = useState(activeVaultPath);
  const api = useVaultApi(targetVaultPath);
  const [targetBookId, setTargetBookId] = useState(activeBookId || "__new__");
  const targetBooks = books.filter((book) => book.vaultPath.toLocaleLowerCase() === targetVaultPath.toLocaleLowerCase());
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const next = await Promise.all(uniquePaths(paths).map((path) => createBatchPreviewItem(path, targetVaultPath)));
      if (!cancelled) setItems((current) => next.map((item) => { const existing = current.find((previous) => previous.path === item.path); return existing ? { ...item, selected: existing.selected, bookName: existing.bookName, mapping: existing.mapping, sheetName: existing.sheetName, headerRow: existing.headerRow } : item; }));
    };
    void load();
    return () => { cancelled = true; };
  }, [paths, targetVaultPath]);
  const addFiles = async () => {
    const additionalPaths = uniquePaths(await onChooseMore());
    const existing = new Set(items.map((item) => item.path.toLocaleLowerCase()));
    const unseenPaths = additionalPaths.filter((path) => !existing.has(path.toLocaleLowerCase()));
    if (!unseenPaths.length) return;
    const next = await Promise.all(unseenPaths.map((path) => createBatchPreviewItem(path, targetVaultPath)));
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
    if (targetQuery.isPending || targetQuery.isError || targetQuery.isFetching || isImporting || hasBlockingItem || !validItems.length) return;
    onImport(validItems.map((item) => ({ path: item.path, sheetName: item.sheetName ?? undefined, headerRow: item.headerRow ?? undefined, mapping: item.mapping ?? undefined, bookName: item.bookName.trim() || item.preview?.fileName.replace(/\.[^.]+$/, "") || "导入礼金簿", targetBookId: targetBookId === "__new__" ? null : targetBookId, targetVaultPath, createNewBook: targetBookId === "__new__" })));
  };
  return <Modal title={`批量导入表格 · ${items.length} 个文件`} onClose={onClose} isSaving={isImporting} error={error} className="spreadsheet-batch-modal" owner="spreadsheet-import">
    <QueryFeedback query={targetQuery} label="导入目标礼金簿" />
    <div className="batch-import-intro"><FileSpreadsheet size={16} /><div><strong>导入提醒</strong><span>系统会先检查字段映射和异常记录，确认无误后才写入目标礼金库。</span><small>姓名、金额为必填字段；例如“第 1 列：姓名”应对应姓名，“第 2 列：金额”应对应礼金金额。地址、支付方式和备注识别错误时，请在下方重新选择；红色异常会显示具体行号和处理建议。</small></div></div>
    <div className="batch-import-toolbar"><div className="batch-target-fields"><label className="batch-target-vault">导入礼金库<select value={targetVaultPath} aria-label="导入礼金库" onChange={(event) => { setTargetVaultPath(event.target.value); setTargetBookId("__new__"); }}>{vaults.map((item) => <option value={item.path} key={item.path}>{item.name}</option>)}</select><small>默认使用当前礼金库；切换后，文件会写入所选礼金库。</small></label><label className="batch-target-book">导入方式<select value={targetBookId} aria-label="导入方式" data-target-mode="明确新建礼金簿" onChange={(event) => setTargetBookId(event.target.value)}><option value="__new__">新建礼金簿</option>{targetBooks.map((book) => <option value={book.id} key={book.id}>{book.title}</option>)}</select><small>已有礼金簿只追加导入记录，不覆盖原有数据。</small></label></div><button className="secondary-button compact" onClick={() => void addFiles()} disabled={isImporting}><FolderOpen size={14} />添加文件</button></div>
    <div className="batch-import-list">{items.length === 0 ? <div className="table-empty">正在读取表格预览…</div> : items.map((item) => <article className={`batch-import-item ${item.error || item.preview?.errors.length ? "invalid" : ""}`} key={item.path}>
      <div className="batch-import-item-heading"><label className="batch-file-check"><input type="checkbox" checked={item.selected} disabled={!item.preview || Boolean(item.error) || isImporting} onChange={(event) => updateItem(item.path, { selected: event.target.checked })} /><strong>{item.preview?.fileName || item.path.split(/[\\/]/).pop()}</strong></label><button className="icon-button subtle" title="移除文件" onClick={() => setItems((current) => current.filter((candidate) => candidate.path !== item.path))}><X size={15} /></button></div>
      {item.error ? <div className="import-errors"><span>{item.error.replace(/^Error:\s*/, "")}</span><small>请移除该文件后再继续。</small></div> : item.preview && <><label className="batch-book-name">生成的礼金簿名称<input value={item.bookName} onChange={(event) => updateItem(item.path, { bookName: event.target.value })} /></label><button type="button" className="batch-style-toggle" aria-expanded={mappingOpen} onClick={() => setMappingOpen((open) => !open)}><span>编辑表格样式</span><span>{mappingOpen ? "收起" : "展开字段对应"}</span></button>{mappingOpen && <><div className="batch-mapping-row"><label>工作表<select value={item.sheetName ?? item.preview.sheetName} onChange={(event) => { const sheetName = event.target.value; updateItem(item.path, { sheetName }); void refreshPreview(item, { sheetName }); }}>{item.preview.sheetNames.map((name) => <option key={name}>{name}</option>)}</select></label></div><div className="batch-mapping-grid">{SPREADSHEET_MAPPING_FIELDS.map(([field, label]) => <label className={mappingErrors(item).some((error) => error.includes(`「${label}」`)) ? "mapping-field-error" : ""} key={field}><span>{label}</span><select value={item.mapping?.[field] ?? ""} onChange={(event) => { const mapping = completeMapping({ ...(item.mapping ?? item.preview?.currentMapping ?? {}), [field]: event.target.value === "" ? null : Number(event.target.value) }); updateItem(item.path, { mapping }); void refreshPreview(item, { mapping }); }}><option value="">不导入</option>{item.preview.headers.map((header, index) => <option value={index} key={`${index}-${header}`}>{sourceColumnLabel(header, index)}</option>)}</select></label>)}</div></>}{item.preview.tagPreview?.values.length ? <section className="spreadsheet-tags"><div className="spreadsheet-tags-heading"><strong>{item.preview.tagPreview.columnName || "人物标签"}</strong><span>{item.preview.tagPreview.values.length} 个标签</span></div><div className="spreadsheet-tag-list">{item.preview.tagPreview.values.map((tag) => <span className={`spreadsheet-tag ${tag.existing ? "existing" : "new"}`} key={tag.name}><i style={{ backgroundColor: tag.color }} /><span>{tag.name}</span><small>{tag.existing ? "已有" : "新建"} · {tag.count} 次</small></span>)}</div></section> : item.mapping?.tags !== null && item.mapping?.tags !== undefined ? <p className="field-hint spreadsheet-no-tags">人物标签列中未识别到可导入标签。</p> : null}{item.preview.rows.length > 0 && <section className="spreadsheet-sample"><div className="spreadsheet-sample-heading"><strong>表格样例</strong><span>前 {Math.min(3, item.preview.rows.length)} 行</span></div><div className="spreadsheet-sample-wrap"><table><thead><tr>{previewColumns(item.mapping).map(({ field, index, label }) => <th key={field} title={label}>{index === null ? label : item.preview.headers[index] || label}</th>)}</tr></thead><tbody>{item.preview.rows.slice(0, 3).map((row, rowIndex) => <tr key={`${item.path}-${rowIndex}`}>{previewColumns(item.mapping).map(({ field, index }) => <td key={field} title={index === null ? undefined : row[index] || undefined}>{index === null ? "-" : row[index] || "-"}</td>)}</tr>)}</tbody></table></div></section>}{(item.preview.errors.length > 0 || mappingErrors(item).length > 0) && <div className="import-errors"><strong>当前预览校验失败</strong>{mappingErrors(item).map((error) => <span key={error}>{error}</span>)}{item.preview.errors.filter((error) => !item.preview!.rowErrors.includes(error)).slice(0, 5).map((error) => <span key={error}>{error}</span>)}{item.preview.rowErrors.length > 0 && <div className="import-row-errors"><strong>逐行错误</strong>{item.preview.rowErrors.slice(0, 5).map((error) => <span key={error}>{error}</span>)}</div>}</div>}<div className="batch-item-foot"><span>识别到 {item.preview.validRows} 行有效记录</span>{item.preview.tagPreview && <span>{item.preview.tagPreview.values.length} 个标签</span>}</div></>}
    </article>)}</div>
    {isImporting && <div className="import-progress" aria-live="polite"><strong>{importPhase}</strong><span>已完成表格检查，正在处理 {validItems.reduce((total, item) => total + (item.preview?.validRows ?? 0), 0)} 条有效记录。写入采用单一事务，失败时不会保留半成品。</span><div className="import-progress-bar"><i /></div></div>}
    <p className={`batch-import-guidance ${hasBlockingItem ? "warning" : "ready"}`}>{hasBlockingItem ? "请先完成目标选择、字段映射和异常记录处理；逐行异常会被保留并在导入结果中提示。" : "确认无误后点击右下角“确认导入”，系统才会正式写入当前礼金库。"}</p><div className="modal-actions"><button className="secondary-button" onClick={onClose} disabled={isImporting}>取消</button><button className="primary-button" onClick={submit} disabled={targetQuery.isPending || targetQuery.isError || targetQuery.isFetching || isImporting || validItems.length === 0 || hasBlockingItem}>{isImporting ? importPhase : hasBlockingItem ? "请先完成导入检查" : `确认导入 ${validItems.length} 个文件`}</button></div>
  </Modal>;
}

function PeopleView({ vaultPath, bookId, onError, isAdmin, editLocked, onVaultActivity }: { vaultPath: string; bookId: string; onError: (message: string) => void; isAdmin: boolean; editLocked: boolean; onVaultActivity: () => void }) {
  const api = useVaultApi(vaultPath);
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
  const refreshTagConsumers = () => { void invalidateVaultQueries(client, vaultPath); };

  const createTag = useMutation({
    mutationFn: () => api.createTag(newTag.trim(), newTagColor),
    onSuccess: (tag) => {
      const [createdTag] = canonicalizeTags([tag]);
      client.setQueryData<Tag[]>(["tags", vaultPath], (current) => [...(current ?? []), createdTag]);
      refreshTagConsumers();
      if (!api.isCurrent()) return;
      setNewTag(""); onVaultActivity();
    },
    onError: (err) => onError(String(err)),
  });
  const updateTagColor = useMutation({
    mutationFn: ({ tagId, color }: { tagId: string; color: string }) => api.updateTagColor(tagId, color),
    onSuccess: () => { refreshTagConsumers(); if (api.isCurrent()) onVaultActivity(); },
    onError: (err) => onError(String(err)),
  });
  const deleteTag = useMutation({
    mutationFn: api.deleteTag,
    onSuccess: () => { refreshTagConsumers(); if (api.isCurrent()) onVaultActivity(); },
    onError: (err) => onError(String(err)),
  });
  const setPersonTags = useMutation({
    mutationFn: ({ personId, tagIds }: { personId: string; tagIds: string[] }) => api.setPersonTags(personId, tagIds),
    onSuccess: () => { refreshTagConsumers(); if (api.isCurrent()) onVaultActivity(); },
    onError: (err) => onError(String(err)),
  });
  const searchLabel = tagSearch.trim() ? `标签“${tagSearch.trim()}”` : "当前礼金簿";
  if (queryPeople.data === undefined && (queryPeople.isPending || queryPeople.isError)) return <QueryFeedback query={queryPeople} label="人物" />;
  return <section className="people-view"><QueryFeedback query={tags} label="人物标签" /><QueryFeedback query={queryPeople} label="人物" />
    <div className="people-toolbar">
      <div className="people-toolbar-left">
        <label className="tag-search-field person-tag-search" aria-label="搜索人物标签"><Search size={15} /><input value={tagSearch} onChange={(event) => setTagSearch(event.target.value)} placeholder="搜索人物标签" />{tagSearch && <button className="icon-button subtle" type="button" title="清除标签搜索" aria-label="清除标签搜索" onClick={() => setTagSearch("")}><X size={13} /></button>}</label>
        <button className={`people-tag-toggle ${tagPanelOpen ? "active" : ""}`} type="button" aria-expanded={tagPanelOpen} onClick={() => setTagPanelOpen((open) => !open)}><UsersRound size={15} />人物标签<ChevronRight className={tagPanelOpen ? "rotate-90" : undefined} size={14} /></button>
      </div>
      <span className="toolbar-note">{searchLabel}共 {people.data?.length ?? 0} 位人物</span>
    </div>
    <div className={`people-layout ${tagPanelOpen ? "" : "tag-panel-hidden"}`}>
      <div className="people-main"><div className="table-panel"><div className="table-panel-heading"><div><strong>人物档案</strong><span>{people.data?.length ?? 0} 位</span></div></div><div className="table-wrap"><table><thead><tr><th>姓名</th><th>地址</th><th>标签</th><th>累计礼金</th><th>次数</th></tr></thead><tbody>{people.data?.map((person) => <PersonRow key={person.id} person={{ ...person, tags: colorizeTags(person.tags) }} tags={displayTags} isAdmin={isAdmin && tags.isSuccess && !tags.isFetching} canDelete={isAdmin && !editLocked} pickerOpen={editingPersonId === person.id} onTogglePicker={() => setEditingPersonId((current) => current === person.id ? null : person.id)} onChange={(tagIds) => setPersonTags.mutate({ personId: person.id, tagIds })} />)}</tbody></table>{queryPeople.isSuccess && !people.data?.length && <div className="table-empty"><UsersRound size={24} /><strong>{tagSearch.trim() ? "没有找到带有该标签的人物" : "当前礼金簿还没有人物"}</strong><span>{tagSearch.trim() ? "清空标签搜索后查看全部人物。" : "人物记录会在登记或导入礼金后显示。"}</span></div>}</div></div></div>
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
      <td><div className="person-cell"><span className="avatar">{firstCharacter(person.displayName)}</span><strong>{person.displayName}</strong></div></td>
      <td className="muted">{person.address || "-"}</td>
      <td>
        <div className="person-tags-cell">
          {person.tags.length ? person.tags.map((tag) => (
            <span key={tag.id} className="person-tag-chip">
              <span className="tag-chip" style={{ "--tag-color": tag.color } as React.CSSProperties}>{tag.name}<span className="tag-swatch" /></span>
            </span>
          )) : <span className="muted">无标签</span>}
          {isAdmin && <div className="person-tag-picker" ref={pickerRef}><button className="person-tag-more" type="button" title="调整人物标签" aria-label="调整人物标签" aria-expanded={pickerOpen} onClick={onTogglePicker}><CirclePlus size={17} /></button>{pickerOpen && <div className="person-tag-popover"><strong>调整人物标签</strong><p className="field-hint">此人物在所有礼金簿中的记录共享这些标签。</p><div>{tags.map((tag) => { const selected = current.has(tag.id); return <button type="button" className={`tag-toggle person-tag-option ${selected ? "selected" : ""}`} style={{ "--tag-color": tag.color } as React.CSSProperties} aria-pressed={selected} key={tag.id} onClick={() => toggleTag(tag.id)}>{tag.name}<span className="tag-swatch" /></button>; })}</div></div>}</div>}
        </div>
      </td>
      <td className="amount-cell">{formatMoney(person.totalFen)}</td>
      <td className="muted">{person.giftCount}</td>
    </tr>
  );
}

function HistoryView({ vaultPath, vaultName, isAdmin, onNotice, onVaultUpdated, onTrace }: { vaultPath: string; vaultName: string; isAdmin: boolean; onNotice: (message: string) => void; onVaultUpdated: (vault: VaultInfo) => void; onTrace: (entityType: string, entityId: string) => void }) {
  const api = useVaultApi(vaultPath);
  const client = useQueryClient();
  const [clearOpen, setClearOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set());
  const history = useQuery({ queryKey: ["audit-logs", vaultPath], queryFn: api.listAuditLogs });
  const refreshWorkspace = async (completed = false) => {
    await invalidateVaultQueries(client, vaultPath);
    if (!api.isCurrent()) return;
    try {
      const updated = await api.currentVaultInfo();
      if (!api.isCurrent()) return;
      onVaultUpdated(updated);
      await history.refetch();
    } catch (error) { if (completed && api.isCurrent()) onNotice(`数据操作已完成，刷新失败：${String(error)}`); }
  };
  const clearHistory = useMutation({
    mutationFn: async ({ records, pin }: { records: AuditLog[]; pin: string }) => { await api.clearAuditLogs(records.map((record) => record.id), pin); return records; },
    onSuccess: async (records) => { await refreshWorkspace(true); if (!api.isCurrent()) return; setSelectedHistoryIds(new Set()); setSelectionMode(false); setClearOpen(false); onNotice(`删除成功：${historyTargets(records)}`); },
    onError: (error) => { void refreshWorkspace().catch(() => undefined); onNotice(`删除失败：${String(error).replace(/^Error:\s*/, "")}`); },
  });
  const restoreHistory = useMutation({
    mutationFn: async (records: AuditLog[]) => { await api.restoreAuditLogs(records.map((record) => record.id)); return records; },
    onSuccess: async (records) => { await refreshWorkspace(true); if (!api.isCurrent()) return; setSelectedHistoryIds(new Set()); setSelectionMode(false); onNotice(`恢复成功：${historyTargets(records)}`); },
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
  if (history.data === undefined && (history.isPending || history.isError)) return <QueryFeedback query={history} label="历史改动" />;
  return <section className="history-view"><QueryFeedback query={history} label="历史改动" />{(clearHistory.error || restoreHistory.error) && <p className="form-error" role="alert">{String(clearHistory.error || restoreHistory.error)}</p>}<div className="table-panel"><div className="table-panel-heading"><div><strong>历史改动</strong><span>{history.data?.length ?? 0} 条</span></div>{isAdmin && <div className="toolbar-actions"><button className={`secondary-button compact ${selectionMode ? "active" : ""}`} type="button" disabled={!history.data?.length || clearHistory.isPending} aria-pressed={selectionMode} onClick={() => selectionMode ? exitSelectionMode() : setSelectionMode(true)}><ListChecks size={14} />{selectionMode ? "退出多选" : "多选"}</button><button className="restore-button compact" data-operation-hint="提示：将撤销选中改动并恢复对应业务数据。" type="button" disabled={!restorableRecords.length || restoreHistory.isPending || (selectedCount > 0 && !restoreAllowed)} title={!selectedCount ? "点击后进入多选，再选择可恢复的改动" : !restoreAllowed ? "所选记录不能全部恢复" : "恢复所选改动"} onClick={restoreHistorySelection}><Archive size={14} />恢复改动</button><button className="danger-button compact" data-operation-hint="提示：删除历史记录后无法恢复。" disabled={clearHistory.isPending || restoreHistory.isPending || (selectionMode ? selectedCount === 0 : !history.data?.length)} onClick={() => setClearOpen(true)}><Trash2 size={14} />{selectionMode ? `删除选中改动信息（已选 ${selectedCount} 条）` : "删除改动信息"}</button></div>}</div>{history.isLoading ? <div className="table-empty">正在读取历史改动…</div> : history.data?.length ? <div className="table-wrap"><table className="audit-table"><thead><tr>{selectionMode && <th className="audit-select-column"><input type="checkbox" checked={selectedCount > 0 && selectedCount === restorableRecords.length} onChange={(event) => setSelectedHistoryIds(event.target.checked ? new Set(restorableRecords.map((record) => record.id)) : new Set())} aria-label="全选可恢复历史改动" /></th>}<th className="audit-time">时间</th><th className="audit-object">对象</th><th className="audit-vault">礼金库</th><th className="audit-book">礼金簿</th><th className="audit-action">操作</th><th className="audit-detail">变更明细</th></tr></thead><tbody>{history.data.map((record: AuditLog) => { const selected = selectedHistoryIds.has(record.id); const restorable = isRestorableAuditRecord(record); return <tr key={record.id} className={`${selectionMode && selected ? "audit-row-selected" : ""}`.trim()} onClick={selectionMode && restorable ? () => toggleHistoryId(record.id) : undefined} onDoubleClick={!selectionMode ? () => onTrace(record.entityType, record.entityId) : undefined} title={!selectionMode ? "双击查找来源礼金记录" : undefined}>{selectionMode && <td className="audit-select-column"><input type="checkbox" checked={selected} onChange={() => toggleHistoryId(record.id)} onClick={(event) => event.stopPropagation()} disabled={!restorable} title={record.reversibleReason ?? undefined} aria-label={"选择历史改动 " + record.target} /></td>}<td className="muted audit-time">{displayTime(record.createdAt)}</td><td className="audit-object">{record.target}</td><td className="muted audit-vault">{vaultName}</td><td className="muted audit-book">{record.bookTitle || "礼金库"}</td><td className="audit-action"><strong>{record.description}</strong></td><td className="audit-changes audit-detail">{!restorable && <p className="field-hint">{record.reversibleReason || "该改动目前无法恢复"}</p>}{record.changes.length ? record.changes.map((change) => <div key={record.id + "-" + change.field}><strong>{change.field}</strong><span>{change.before}</span><b>→</b><span>{change.after}</span></div>) : <span className="muted">—</span>}</td></tr>; })}</tbody></table></div> : history.isError ? null : <div className="table-empty"><History size={27} /><strong>还没有历史改动</strong><span>具体人物、礼金记录、礼金簿和礼金库的编辑会显示在这里。</span></div>}</div>{selectionMode && <p className="field-hint history-restore-hint">恢复完成的改动会从列表移除；无法恢复的历史会保留，并显示原因。</p>}{clearOpen && <ConfirmHistoryClear selectedCount={selectionMode ? selectedCount : 0} isClearing={clearHistory.isPending} error={clearHistory.error} onClose={() => setClearOpen(false)} onConfirm={(pin) => clearHistory.mutate({ records: selectionMode ? selectedRecords : (history.data ?? []), pin })} />}</section>;
}

function formatReturnGiftTime(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ReturnGiftsView({ vaultPath, isAdmin, onError, onVaultActivity, onTrace }: { vaultPath: string; isAdmin: boolean; onError: (message: string) => void; onVaultActivity: () => void; onTrace: (entityType: string, entityId: string, bookId: string) => void }) {
  const api = useVaultApi(vaultPath);
  const client = useQueryClient();
  const [editingRecord, setEditingRecord] = useState<ReturnGiftRecord | null>(null);
  const returnGifts = useQuery({ queryKey: ["return-gifts", vaultPath], queryFn: api.listReturnGifts });
  const updateInformation = useMutation({
    mutationFn: ({ entryId, amountFen, returnGift }: { entryId: string; amountFen: number; returnGift: string }) => api.updateReturnGiftInformation(entryId, amountFen, returnGift),
    onSuccess: () => {
      void invalidateVaultQueries(client, vaultPath);
      if (!api.isCurrent()) return;
      setEditingRecord(null);
      onVaultActivity();
    },
    onError: (error) => onError(String(error)),
  });
  if (returnGifts.data === undefined && (returnGifts.isPending || returnGifts.isError)) return <QueryFeedback query={returnGifts} label="回礼记录" />;
  return <section className="return-gifts-view"><QueryFeedback query={returnGifts} label="回礼记录" />
    <div className="toolbar"><div className="toolbar-note">已记录 {returnGifts.data?.length ?? 0} 笔回礼</div><div className="toolbar-actions"><button className="secondary-button compact" onClick={() => void returnGifts.refetch()}><RefreshCw size={15} />刷新</button></div></div>
    <section className="table-panel"><div className="table-panel-heading"><div><strong>回礼明细</strong><span>{returnGifts.data?.length ?? 0} 条记录</span></div></div>{returnGifts.isLoading ? <div className="table-empty">正在读取回礼记录…</div> : returnGifts.data?.length ? <div className="table-wrap"><table><thead><tr><th>人物</th><th>回礼金额</th><th>回礼时间</th><th>所属礼金簿</th><th>地址</th><th>回礼备注</th><th>标签</th>{isAdmin && <th />}</tr></thead><tbody>{returnGifts.data.map((record) => <tr className="entry-row" style={{ "--entry-tag-color": record.tags[0]?.color ?? "#a9b5b9" } as React.CSSProperties} key={record.entryId} onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest("button")) onTrace("gift_entry", record.entryId, record.bookId); }} title="双击查找来源礼金记录"><td className="entry-accent-cell"><div className="person-cell"><span className="avatar">{firstCharacter(record.personName)}</span><strong>{record.personName}</strong></div></td><td className="amount-cell">{formatMoney(record.returnGiftAmountFen)}</td><td className="muted">{formatReturnGiftTime(record.returnGiftedAt)}</td><td className="muted">{record.bookTitle}</td><td className="muted">{record.address || "-"}</td><td className="muted note-cell">{record.returnGift || "-"}</td><td>{record.tags.length ? <div className="tag-select">{record.tags.map((tag) => <span className="tag-chip" style={{ "--tag-color": tag.color } as React.CSSProperties} key={tag.id}>{tag.name}<span className="tag-swatch" /></span>)}</div> : <span className="muted">-</span>}</td>{isAdmin && <td><button className="icon-button subtle" title="编辑回礼信息" aria-label="编辑回礼信息" onClick={() => setEditingRecord(record)}><Pencil size={15} /></button></td>}</tr>)}</tbody></table></div> : returnGifts.isError ? null : <div className="table-empty"><Gift size={27} /><strong>还没有回礼记录</strong><span>在“编辑信息”中填写回礼金额后，记录会显示在这里。</span></div>}</section>
    {editingRecord && <ReturnGiftInformationModal error={updateInformation.error} record={editingRecord} isSaving={updateInformation.isPending} onClose={() => setEditingRecord(null)} onSubmit={(amountFen, returnGift) => updateInformation.mutate({ entryId: editingRecord.entryId, amountFen, returnGift })} />}
  </section>;
}

function ReturnGiftInformationModal({ error, record, isSaving, onClose, onSubmit }: { error: unknown; record: ReturnGiftRecord; isSaving: boolean; onClose: () => void; onSubmit: (amountFen: number, returnGift: string) => void }) {
  const [amount, setAmount] = useState(`${Math.trunc(record.returnGiftAmountFen / 100)}.${String(record.returnGiftAmountFen % 100).padStart(2, "0")}`);
  const [returnGift, setReturnGift] = useState(record.returnGift ?? "");
  const amountFen = parseAmountFen(amount);
  const validationError = validateChangedText("回礼备注", returnGift, 65536, record.returnGift) || (amountFen === null ? "回礼金额须为 0.01–9,999,999,999.99 元，最多两位小数。" : null);
  const valid = !validationError && amountFen !== null && amountFen > 0;
  return <Modal title="编辑回礼信息" onClose={onClose} isSaving={isSaving} error={error || validationError}><div className="return-gift-readonly"><span>人物</span><strong>{record.personName}</strong><span>回礼时间</span><strong>{formatReturnGiftTime(record.returnGiftedAt)}</strong><span>所属礼金簿</span><strong>{record.bookTitle}</strong></div><label>回礼金额（元）<input autoFocus inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="例如 500" /></label><label>回礼备注<textarea value={returnGift} onChange={(event) => setReturnGift(event.target.value)} placeholder="可选" /></label><div className="modal-actions"><button className="secondary-button" onClick={onClose} disabled={isSaving}>取消</button><button className="primary-button" disabled={!valid || isSaving} onClick={() => valid && amountFen !== null && onSubmit(amountFen, returnGift)}>{isSaving ? "保存中…" : "保存信息"}</button></div></Modal>;
}

function trashTargets(items: TrashItem[]) {
  const titles = [...new Set(items.map((item) => item.title).filter(Boolean))];
  if (!titles.length) return "选中项目";
  return titles.length > 3 ? `${titles.slice(0, 3).join("、")}等 ${titles.length} 项` : titles.join("、");
}

function TrashView({ scopeDescription, openedVaultPaths, vaultPath, onNotice, isAdmin, onVaultActivity }: { scopeDescription: string; openedVaultPaths: string[]; vaultPath: string; onNotice: (message: string) => void; isAdmin: boolean; onVaultActivity: () => void }) {
  const api = useVaultApi(vaultPath);
  const client = useQueryClient();
  const [clearOpen, setClearOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedTrashKeys, setSelectedTrashKeys] = useState<Set<string>>(new Set());
  const trash = useQuery({ queryKey: ["trash", openedVaultPaths], queryFn: api.listTrash });
  const trashItemKey = (item: Pick<TrashItem, "kind" | "id" | "vaultPath">) => `${item.vaultPath ?? "global"}\u001f${item.kind}\u001f${item.id}`;
  const refreshRelatedViews = () => { for (const path of openedVaultPaths) void invalidateVaultQueries(client, path); };

  const restoreSelection = useMutation({
    mutationFn: async (items: TrashItem[]) => {
      for (const item of items) await api.restoreTrashItem(item.kind, item.id, item.vaultPath);
      return items;
    },
    onSuccess: (items) => {
      refreshRelatedViews();
      if (!api.isCurrent()) return;
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
  const empty = useMutation({ mutationFn: api.emptyTrash, onSuccess: () => { refreshRelatedViews(); if (!api.isCurrent()) return; setClearOpen(false); onVaultActivity(); onNotice("清空回收站成功"); }, onError: (err) => { refreshRelatedViews(); onNotice(`清空回收站失败：${String(err).replace(/^Error:\s*/, "")}`); } });
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
  if (trash.data === undefined && (trash.isPending || trash.isError)) return <QueryFeedback query={trash} label="回收站" />;
  return <section className="trash-view"><QueryFeedback query={trash} label="回收站" />
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
      </table></div> : trash.isError ? null : <div className="table-empty"><Trash2 size={27} /><strong>回收站为空</strong><span>删除的项目会在这里显示，并可恢复。</span></div>}
    </section>
    {clearOpen && <ConfirmTrashEmpty error={empty.error} scopeDescription={scopeDescription} isClearing={empty.isPending} onClose={() => setClearOpen(false)} onConfirm={(pin) => empty.mutate(pin)} />}
  </section>;
}

function EmptyBookState({ onCreate }: { onCreate: () => void }) { return <div className="empty-book"><div className="empty-book-icon"><BookOpen size={25} /></div><h2>从一本礼金簿开始</h2><p>为婚礼、寿宴、乔迁等活动建立独立记录，人物档案和标签会在礼金库中长期保留。</p><button className="primary-button" onClick={onCreate}><CirclePlus size={17} />新建礼金簿</button></div>; }

function Metric({ label, value, detail, accent }: { label: string; value: string; detail?: string | null; accent: string }) { return <div className={`metric-card ${accent}`}><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>; }

function BookModal({ error, onClose, onSubmit, isSaving }: { error: unknown; onClose: () => void; onSubmit: (input: { title: string; occasion: string; eventDate: string; location: string; notes: string }) => void; isSaving: boolean }) { const [title, setTitle] = useState(""); const [occasion, setOccasion] = useState("婚礼"); const [eventDate, setEventDate] = useState(today()); const [location, setLocation] = useState(""); const [notes, setNotes] = useState(""); const validationError = validateChangedText("礼金簿名称", title, 256) || validateChangedText("活动类型", occasion, 256) || validateChangedText("地点", location, 4096) || validateChangedText("备注", notes, 65536) || validateChangedDate(eventDate); return <Modal title="新建礼金簿" owner="create-book" onClose={onClose} isSaving={isSaving} error={error || validationError}><label>礼金簿名称<input autoFocus placeholder="例如：2026 年春节走亲" value={title} onChange={(event) => setTitle(event.target.value)} /></label><div className="form-grid"><label>活动类型<input value={occasion} onChange={(event) => setOccasion(event.target.value)} /></label><label>活动日期<input type="date" value={eventDate} onChange={(event) => setEventDate(event.target.value)} /></label></div><label>地点<input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="可选" /></label><label>备注<textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="可选" /></label><div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim() || Boolean(validationError) || isSaving} onClick={() => onSubmit({ title: title.trim(), occasion, eventDate, location, notes })}>{isSaving ? "创建中…" : "创建礼金簿"}</button></div></Modal>; }

function BookMetadataModal({ error, book, onClose, onSubmit, isSaving }: { error: unknown; book: GiftBook; onClose: () => void; onSubmit: (input: { title: string; occasion: string; eventDate: string; location: string; notes: string }) => void; isSaving: boolean }) {
  const [title, setTitle] = useState(book.title);
  const [occasion, setOccasion] = useState(book.occasion);
  const [eventDate, setEventDate] = useState(book.eventDate ?? "");
  const [location, setLocation] = useState(book.location ?? "");
  const [notes, setNotes] = useState(book.notes ?? "");
  const validationError = validateChangedText("礼金簿名称", title, 256, book.title) || validateChangedText("活动类型", occasion, 256, book.occasion) || validateChangedText("地点", location, 4096, book.location) || validateChangedText("备注", notes, 65536, book.notes) || validateChangedDate(eventDate, book.eventDate);
  return <Modal title="编辑礼金簿" onClose={onClose} isSaving={isSaving} error={error}>
    {validationError && <p className="form-error" role="alert">{validationError}</p>}
    {book.eventDate && validateChangedDate(book.eventDate) && eventDate === book.eventDate && <p className="field-hint">原有活动日期：{book.eventDate}；修改其他字段时保持原值。</p>}
    <label>礼金簿名称<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <div className="form-grid"><label>活动类型<input value={occasion} onChange={(event) => setOccasion(event.target.value)} /></label><label>活动日期<input type={book.eventDate && validateChangedDate(book.eventDate) ? "text" : "date"} value={eventDate} onChange={(event) => setEventDate(event.target.value)} /></label></div>
    <label>地点<input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="可选" /></label>
    <label>备注<textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="可选" /></label>
    <p className="field-hint">创建时间、导入时间和原始表格路径保持不变；活动日期可独立修改。</p>
    <div className="modal-actions"><button className="secondary-button" disabled={isSaving} onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim() || Boolean(validationError) || isSaving} onClick={() => onSubmit({ title: title === book.title ? title : title.trim(), occasion: occasion === book.occasion ? occasion : occasion.trim(), eventDate, location: location === book.location ? location : location.trim(), notes })}>{isSaving ? "保存中…" : "保存修改"}</button></div>
  </Modal>;
}

function EntryModal({ onClose, onSubmit, isSaving, tagsReady, error, tagsError, onRetryTags, initial, title = "登记礼金", tags, vaultPath, onCreateTag }: { onClose: () => void; onSubmit: (input: EntryDraft) => void; isSaving: boolean; initial?: GiftEntry; title?: string; tagsReady: boolean; error?: unknown; tagsError?: unknown; onRetryTags?: () => void; tags: Tag[]; vaultPath: string; onCreateTag: (name: string, color: string) => Promise<Tag> }) {
  const api = useVaultApi(vaultPath);
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
  const validationError = validateChangedText("姓名", personName, 256, initial?.personName) || validateChangedText("地址", address, 4096, initial?.address ?? undefined) || validateChangedText("支付方式", paymentMethod, 256, initial?.paymentMethod) || validateChangedText("备注", note, 65536, initial?.note ?? undefined) || validateChangedText("回礼备注", returnGift, 65536, initial?.returnGift ?? undefined);
  const [tagError, setTagError] = useState<string | null>(null);
  const [tagSaving, setTagSaving] = useState(false);
  const valid = tagsReady && !tagSaving && !validationError && Boolean(personName.trim()) && amountFen !== null && (!returnGiftAmount.trim() || (returnGiftAmountFen !== null && returnGiftAmountFen > 0));
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
  const tagSavingRef = useRef(false);
  const submit = async () => {
    if (!valid || amountFen === null || isSaving || (returnGiftAmount.trim() && (returnGiftAmountFen === null || returnGiftAmountFen <= 0))) return;
    let tagIds = selectedTagIds;
    const typedTag = newTag.trim();
    if (typedTag) {
      const existingTag = availableTags.find((tag) => tag.name.trim() === typedTag);
      if (existingTag) tagIds = tagIds.includes(existingTag.id) ? tagIds : [...tagIds, existingTag.id];
      else {
        const tag = await addTag();
        if (!tag) return;
        tagIds = tagIds.includes(tag.id) ? tagIds : [...tagIds, tag.id];
      }
    }
    onSubmit({ personName: personName === initial?.personName ? personName : personName.trim(), address: address === initial?.address ? address : address.trim(), amountFen, paymentMethod, receivedAt: initial?.receivedAt ?? nowLocalDateTime(), note, returnGift: initial ? returnGift : "", returnGiftAmountFen, tagIds });
  };
  const addTag = async (): Promise<Tag | null> => {
    const name = newTag.trim();
    if (!name || tagSaving || tagSavingRef.current) return null;
    tagSavingRef.current = true;
    setTagSaving(true); setTagError(null);
    try {
      const tag = await onCreateTag(name, newTagColor);
      if (!api.isCurrent()) return null;
      setNewTag("");
      const nextTags = mergeEntryTag(availableTags, tag);
      setCreatedTags((current) => mergeEntryTag(current, tag));
      setNewTagColor(nextTagColor(nextTags));
      setPromotedTagId(tag.id);
      setSelectedTagIds((current) => current.includes(tag.id) ? current : [...current, tag.id]);
      return tag;
    } catch (error) {
      setTagError(String(error)); return null;
    } finally { tagSavingRef.current = false; setTagSaving(false); }
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
  return <Modal title={title} className="entry-modal" onClose={onClose} isSaving={isSaving || tagSaving}><form className="entry-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    {(validationError || error || tagError || !tagsReady) && <p className="form-error" role="alert">{validationError || String(error || tagError || "人物标签尚未成功读取，请关闭后重试")}</p>}
    {!tagsReady && <p className="form-error" role="alert">{tagsError ? String(tagsError) : "人物标签正在读取…"}{onRetryTags && <button className="secondary-button compact" type="button" onClick={onRetryTags}>重新读取人物标签</button>}</p>}
    {amount.trim() && amountFen === null && <p className="form-error" role="alert">礼金金额须为 0.01–9,999,999,999.99 元，最多两位小数。</p>}
    {returnGiftAmount.trim() && returnGiftAmountFen === null && <p className="form-error" role="alert">回礼金额须为 0.01–9,999,999,999.99 元，最多两位小数。</p>}
    <div className="form-grid"><label><span className="field-label-row"><span>姓名</span>{duplicateName && <small className="duplicate-name-warning">姓名重复</small>}</span><div className="entry-name-field"><input ref={nameRef} autoFocus value={personName} onChange={(event) => setPersonName(event.target.value)} onKeyDown={(event) => moveTo(event, amountRef)} placeholder="必填" /></div></label><label>金额（元）<input ref={amountRef} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} onKeyDown={(event) => moveTo(event, addressRef)} placeholder="例如 500" /></label></div>
    <div className="form-grid"><label>地址<input ref={addressRef} value={address} onChange={(event) => setAddress(event.target.value)} onKeyDown={(event) => moveTo(event, paymentRef)} placeholder="可选" /></label><label>支付方式<select ref={paymentRef} value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} onKeyDown={(event) => moveTo(event, initial ? returnGiftAmountRef : saveRef)}>{legacyPaymentMethod && <option value={legacyPaymentMethod} hidden>{legacyPaymentMethod}（历史记录）</option>}{PAYMENT_METHOD_OPTIONS.map((method) => <option value={method} key={method}>{method}</option>)}</select></label></div>
    <p className="field-hint">人物标签在该人物所属的各本礼金簿中共享。</p>
    <div className="entry-tags"><div className="entry-tags-heading"><span className="field-label">人物标签</span>{availableTags.length > 0 && <div className="entry-tag-picker"><div className="tag-cloud entry-tag-cloud">{tagSections.visible.map(tagButton)}{tagSections.overflow.length > 0 && <button type="button" className="tag-more-button" aria-expanded={tagsExpanded} onClick={() => setTagsExpanded((expanded) => !expanded)}>{tagsExpanded ? "收起标签" : "更多标签"}</button>}</div>{tagsExpanded && tagSections.overflow.length > 0 && <div className="tag-overflow-popover"><div className="tag-cloud">{tagSections.overflow.map(tagButton)}</div></div>}</div>}</div><div className="entry-tag-create"><input tabIndex={-1} className="tag-color-picker" type="color" value={newTagColor} title="选择新建标签的颜色" aria-label="选择新建标签的颜色" onChange={(event) => setNewTagColor(event.target.value)} /><input ref={tagInputRef} value={newTag} placeholder="例如：同学" onChange={(event) => setNewTag(event.target.value)} onKeyDown={handleTagEnter} /><button type="button" className="secondary-button compact" title="新建标签" aria-label="新建标签" disabled={!newTag.trim() || tagSaving} onClick={() => void addTag()}><CirclePlus size={14} /></button></div></div>
    {initial && <div className="form-grid"><label>回礼金额（元）<input ref={returnGiftAmountRef} inputMode="decimal" value={returnGiftAmount} onChange={(event) => setReturnGiftAmount(event.target.value)} onKeyDown={(event) => moveTo(event, saveRef)} placeholder="可选" /></label><label>回礼备注<input value={returnGift} onChange={(event) => setReturnGift(event.target.value)} placeholder="可选" /></label></div>}
    <label className="wide-field">备注<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="包括不限于随礼、礼品或其他注意事项等" /></label>
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button ref={saveRef} type="submit" className="primary-button" disabled={!valid || isSaving}>{isSaving ? "保存中…" : title === "编辑信息" ? "保存修改" : "保存记录"}</button></div>
  </form></Modal>;
}

function SearchResults({ result, isLoading, isError, onRetry, onSelect }: { result: SearchResponse | undefined; isLoading: boolean; isError: boolean; onRetry: () => void; onSelect: (hit: SearchHit) => void }) {
  if (isLoading) return <div className="search-results">正在搜索…</div>;
  if (isError) return <div className="search-results search-empty" role="alert">搜索失败，请重试。<button className="secondary-button compact" onClick={onRetry}>重试</button></div>;
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

function ConfirmHistoryClear({ selectedCount, isClearing, error, onClose, onConfirm }: { selectedCount: number; isClearing: boolean; error?: unknown; onClose: () => void; onConfirm: (pin: string) => void }) {
  const [pin, setPin] = useState("");
  const valid = /^\d{6,12}$/.test(pin);
  return <Modal title="删除历史改动" onClose={onClose} isSaving={isClearing} error={error}><p className="field-hint">{selectedCount > 0 ? `将删除已选中的 ${selectedCount} 条历史改动记录，删除后无法恢复。` : "未选择具体记录，将删除全部历史改动记录。删除后无法恢复。"}请输入管理员 PIN 继续。</p><label>管理员 PIN<input autoFocus type="password" inputMode="numeric" value={pin} onChange={(event) => setPin(event.target.value)} onKeyDown={(event) => submitTrashEmptyPin(event, valid, isClearing, pin, onConfirm)} placeholder="6 至 12 位数字" /></label><div className="modal-actions"><button className="secondary-button" disabled={isClearing} onClick={onClose}>取消</button><button className="danger-button" disabled={!valid || isClearing} onClick={() => onConfirm(pin)}>{isClearing ? "正在删除…" : selectedCount > 0 ? "删除选中记录" : "删除全部记录"}</button></div></Modal>;
}

function submitTrashEmptyPin(event: React.KeyboardEvent<HTMLInputElement>, valid: boolean, isClearing: boolean, pin: string, onConfirm: (pin: string) => void) {
  if (event.key !== "Enter" || event.shiftKey || !valid || isClearing) return;
  event.preventDefault();
  onConfirm(pin);
}

function ConfirmTrashEmpty({ error, scopeDescription, isClearing, onClose, onConfirm }: { error?: unknown; scopeDescription: string; isClearing: boolean; onClose: () => void; onConfirm: (pin: string) => void }) {
  const [pin, setPin] = useState("");
  const valid = /^\d{6,12}$/.test(pin);
  return <Modal title="清空回收站" onClose={onClose} isSaving={isClearing} error={error}><p className="field-hint">本次清空范围：{scopeDescription}。包含这些已打开礼金库的回收站项目，以及全局已删除礼金库文件，永久删除后无法恢复。请输入管理员 PIN 继续。</p><label>管理员 PIN<input autoFocus type="password" inputMode="numeric" value={pin} onChange={(event) => setPin(event.target.value)} onKeyDown={(event) => submitTrashEmptyPin(event, valid, isClearing, pin, onConfirm)} placeholder="6 至 12 位数字" /></label><div className="modal-actions"><button className="secondary-button" disabled={isClearing} onClick={onClose}>取消</button><button type="button" className="danger-button" disabled={!valid || isClearing} onClick={() => onConfirm(pin)}>{isClearing ? "正在清空…" : "永久清空"}</button></div></Modal>;
}

function canLeaveWorkspace(completedForm: HTMLElement | null = null) {
  const modals = Array.from(document.querySelectorAll<HTMLElement>('[data-modal-saving="true"], [data-modal-dirty="true"]')).filter((modal) => modal !== completedForm);
  if (modals.some((modal) => modal.dataset.modalSaving === "true")) return false;
  return !modals.some((modal) => modal.dataset.modalDirty === "true");
}

function Modal({ title, onClose, children, className = "", isSaving = false, error, owner }: { title: string; onClose: () => void; children: React.ReactNode; className?: string; isSaving?: boolean; error?: unknown; owner?: string }) {
  const [dirty, setDirty] = useState(false);
  const requestClose = () => { if (allowFormClose(dirty, isSaving)) onClose(); };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); requestClose(); } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [dirty, isSaving, onClose]);
  return <div className="modal-backdrop" data-modal-dirty={dirty} data-modal-saving={isSaving} data-modal-owner={owner} onChangeCapture={() => setDirty(true)} onClickCapture={(event) => {
    const button = (event.target as HTMLElement).closest("button");
    if (button?.hasAttribute("aria-pressed")) setDirty(true);
    if (button?.textContent?.trim() === "取消" && isSaving) { event.preventDefault(); event.stopPropagation(); }
  }} onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}><div className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-heading"><h3>{title}</h3><button className="icon-button" title="关闭" disabled={isSaving} onClick={requestClose}><X size={17} /></button></div>{isSaving && <p className="field-hint" role="status">操作进行中，请稍候…</p>}{Boolean(error) && <p className="form-error" role="alert">{String(error).replace(/^Error:\s*/, "")}</p>}{children}</div></div>;
}

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
