import { invoke } from "@tauri-apps/api/core";
import type { Channel } from "@tauri-apps/api/core";
import type { SoftwareUpdateStatus, UpdateProgress } from "../types";
import type { AuditLog, BookStat, BookSummary, ComparisonBook, ComparisonBookEntry, ComparisonBookRef, ComparisonPerson, ComparisonPersonHistory, ComparisonPersonRef, GiftBook, GiftEntry, LocalUpdateStatus, Person, PersonHistory, ReturnGiftRecord, SearchResponse, SessionStatus, SettingsStorageInfo, Tag, TrashItem, VaultInfo, VaultOpenResult } from "../types";

const SCOPED_COMMANDS = new Set([
  "edit_vault", "current_vault_info", "list_books", "create_book", "edit_book", "restore_book",
  "preview_spreadsheet", "preview_spreadsheet_mapping", "import_spreadsheet", "export_book_xlsx", "export_vault",
  "list_entries", "list_return_gifts", "update_return_gift_information", "search_vault", "create_entry", "update_entry",
  "delete_entry", "restore_entry", "delete_person", "restore_person", "list_audit_logs", "restore_audit_logs", "clear_audit_logs",
  "list_tags", "create_tag", "delete_tag", "update_tag_color", "list_people", "set_person_tags", "list_book_stats", "book_summary", "person_history",
]);

const READ_COMMANDS = new Set([
  "current_vault_info", "list_books", "preview_spreadsheet", "preview_spreadsheet_mapping", "list_entries", "list_return_gifts", "search_vault",
  "list_audit_logs", "list_tags", "list_people", "list_book_stats", "book_summary", "person_history", "list_books_for_vault", "list_trash",
  "list_comparison_books", "comparison_book_entries", "search_comparison_people", "search_comparison_book_people", "search_comparison_duplicate_book_people", "comparison_person_history",
  "choose_spreadsheet_path", "choose_spreadsheet_paths", "choose_comparison_vault_paths",
]);

function createApi(invoke: typeof import("@tauri-apps/api/core").invoke) { return {
  chooseVaultPath: (mode: "open" | "save", fileName?: string) => fileName ? invoke<string | null>("choose_vault_path_named", { mode, fileName }) : invoke<string | null>("choose_vault_path", { mode }),
  chooseComparisonVaultPaths: () => invoke<string[]>("choose_comparison_vault_paths"),
  createVault: (path: string, name: string, notes: string) => invoke<VaultOpenResult>("create_vault", { path, name, notes }),
  editVault: (name: string, notes: string) => invoke<VaultInfo>("edit_vault", { name, notes }),
  currentVaultInfo: () => invoke<VaultInfo>("current_vault_info"),
  openVault: (path: string) => invoke<VaultOpenResult>("open_vault", { path }),
  closeVault: () => invoke<void>("close_vault"),
  closeOpenedVault: (vaultPath: string) => invoke<void>("close_opened_vault", { vaultPath }),
  returnToStartPage: () => invoke<void>("return_to_start_page"),
  exitApp: () => invoke<void>("exit_app"),
  sessionStatus: () => invoke<SessionStatus>("session_status"),
  getAppSecurityStatus: () => invoke<SessionStatus>("get_app_security_status"),
  setupAppAdminPin: (pin: string) => invoke<string>("setup_app_admin_pin", { pin }),
  unlockAdmin: (pin: string) => invoke<void>("unlock_admin", { pin }),
  lockAdmin: () => invoke<void>("lock_admin"),
  unlockEditing: () => invoke<void>("unlock_editing"),
  lockEditing: () => invoke<void>("lock_editing"),
  resetAppPinWithRecovery: (recovery: string, newPin: string) => invoke<string>("reset_app_pin_with_recovery", { recovery, newPin }),
  changeAppAdminPin: (oldPin: string, newPin: string) => invoke<string>("change_app_admin_pin", { oldPin, newPin }),
  localUpdateStatus: () => invoke<LocalUpdateStatus>("local_update_status"),
  officialReleaseStatus: () => invoke<LocalUpdateStatus>("official_release_status"),
  openLocalUpdateDirectory: () => invoke<void>("open_local_update_directory"),
  startLocalUpdate: () => invoke<void>("start_local_update"),
  softwareUpdateOptions: () => invoke<SoftwareUpdateStatus>("software_update_options"),
  softwareUpdateStatus: (force: boolean) => invoke<SoftwareUpdateStatus>("software_update_status", { force }),
  prepareSoftwareUpdate: (candidateId: string, progress: Channel<UpdateProgress>) => invoke<void>("prepare_software_update", { candidateId, progress }),
  applySoftwareUpdate: (candidateId: string) => invoke<void>("apply_software_update", { candidateId }),
  acknowledgeSoftwareUpdate: () => invoke<string | null>("acknowledge_software_update"),
  openDownloadChannel: (channelId: string) => invoke<void>("open_download_channel", { channelId }),
  settingsStorageInfo: () => invoke<SettingsStorageInfo>("settings_storage_info"),
  chooseSettingsDirectory: () => invoke<SettingsStorageInfo | null>("choose_settings_directory"),
  licenseText: () => invoke<string>("license_text"),
  listBooks: () => invoke<GiftBook[]>("list_books"),
  listBooksForVault: (vaultPath: string) => invoke<GiftBook[]>("list_books_for_vault", { vaultPath }),
  createBook: (input: { title: string; occasion: string; eventDate: string; location: string; notes: string }) =>
    invoke<GiftBook>("create_book", input),
  editBook: (bookId: string, input: { title: string; occasion: string; eventDate: string; location: string; notes: string }) =>
    invoke<GiftBook>("edit_book", { bookId, input }),
  restoreBook: (bookId: string) => invoke<void>("restore_book", { bookId }),
  listEntries: (bookId: string, search: string) => invoke<GiftEntry[]>("list_entries", { bookId, search }),
  listReturnGifts: () => invoke<ReturnGiftRecord[]>("list_return_gifts"),
  searchVault: (query: string, vaultPaths: string[]) => invoke<SearchResponse>("search_vault", { query, vaultPaths }),
  createEntry: (input: {
    bookId: string;
    personName: string;
    address: string;
    amountFen: number;
    paymentMethod: string;
    receivedAt: string;
    note: string;
    returnGift: string;
    returnGiftAmountFen: number | null;
    tagIds: string[];
  }) => invoke<GiftEntry>("create_entry", { input }),
  updateEntry: (input: {
    entryId: string;
    personName: string;
    address: string;
    amountFen: number;
    paymentMethod: string;
    receivedAt: string;
    note: string;
    returnGift: string;
    returnGiftAmountFen: number | null;
    tagIds: string[];
  }) => invoke<GiftEntry>("update_entry", { input }),
  updateReturnGiftInformation: (entryId: string, amountFen: number, returnGift: string) => invoke<ReturnGiftRecord>("update_return_gift_information", { entryId, amountFen, returnGift }),
  deleteEntry: (entryId: string) => invoke<void>("delete_entry", { entryId }),
  restoreEntry: (entryId: string) => invoke<void>("restore_entry", { entryId }),
  deletePerson: (personId: string) => invoke<void>("delete_person", { personId }),
  restorePerson: (personId: string) => invoke<void>("restore_person", { personId }),
  trashVault: (path: string) => invoke<void>("trash_vault", { path }),
  listTrash: () => invoke<TrashItem[]>("list_trash"),
  restoreTrashItem: (kind: TrashItem["kind"], id: string, vaultPath: string | null) => invoke<void>("restore_trash_item", { kind, id, vaultPath }),
  emptyTrash: (pin: string) => invoke<void>("empty_trash", { pin }),
  listAuditLogs: () => invoke<AuditLog[]>("list_audit_logs"),
  clearAuditLogs: (ids: string[], pin: string) => invoke<void>("clear_audit_logs", { ids, pin }),
  restoreAuditLogs: (ids: string[]) => invoke<void>("restore_audit_logs", { ids }),
  listPeople: (search: string, tagSearch = "", bookId: string | null = null) => invoke<Person[]>("list_people", { search, tagSearch, bookId }),
  listTags: () => invoke<Tag[]>("list_tags"),
  createTag: (name: string, color: string) => invoke<Tag>("create_tag", { name, color }),
  updateTagColor: (tagId: string, color: string) => invoke<void>("update_tag_color", { tagId, color }),
  deleteTag: (tagId: string) => invoke<void>("delete_tag", { tagId }),
  setPersonTags: (personId: string, tagIds: string[]) => invoke<void>("set_person_tags", { personId, tagIds }),
  listBookStats: () => invoke<BookStat[]>("list_book_stats"),
  listComparisonBooks: (vaultPaths: string[]) => invoke<ComparisonBook[]>("list_comparison_books", { vaultPaths }),
  comparisonBookEntries: (vaultPath: string, bookId: string) => invoke<ComparisonBookEntry[]>("comparison_book_entries", { vaultPath, bookId }),
  searchComparisonPeople: (vaultPaths: string[], query: string) => invoke<ComparisonPerson[]>("search_comparison_people", { vaultPaths, query }),
  searchComparisonBookPeople: (bookRefs: ComparisonBookRef[], query: string) => invoke<ComparisonPerson[]>("search_comparison_book_people", { bookRefs, query }),
  searchComparisonDuplicateBookPeople: (bookRefs: ComparisonBookRef[]) => invoke<ComparisonPerson[]>("search_comparison_duplicate_book_people", { bookRefs }),
  comparisonPersonHistory: (people: ComparisonPersonRef[], bookRefs: ComparisonBookRef[]) => invoke<ComparisonPersonHistory[]>("comparison_person_history", { people, bookRefs }),
  bookSummary: (bookId: string) => invoke<BookSummary>("book_summary", { bookId }),
  personHistory: (personId: string) => invoke<PersonHistory[]>("person_history", { personId }),
  chooseSpreadsheetPath: (mode: "open" | "save") => invoke<string | null>("choose_spreadsheet_path", { mode }),
  chooseSpreadsheetPaths: () => invoke<string[]>("choose_spreadsheet_paths"),
  previewSpreadsheet: (path: string) => invoke<SpreadsheetPreview>("preview_spreadsheet", { path }),
  previewSpreadsheetMapping: (path: string, sheetName: string | null, headerRow: number | null, mapping: SpreadsheetColumnMapping) => invoke<SpreadsheetPreview>("preview_spreadsheet_mapping", { path, sheetName, headerRow, mapping }),
  importSpreadsheet: (path: string, bookId: string) => invoke<SpreadsheetImportResult>("import_spreadsheet", { path, bookId }),
  importSpreadsheets: (items: SpreadsheetImportItem[]) => invoke<SpreadsheetBatchImportResult>("import_spreadsheets", { items }),
  exportBookXlsx: (bookId: string, columns?: string[]) => invoke<string>("export_book_xlsx", { bookId, columns }),
  exportVault: () => invoke<string>("export_vault"),
}; }

export const api = createApi(async (command, args) => {
  if (SCOPED_COMMANDS.has(command)) throw new Error("此操作需要明确的礼金库，请重新打开页面");
  return invoke(command, args);
});

/** Both query functions and form mutations keep the path of their owning view. */
export function createVaultApi(vaultPath: string, isCurrent: () => boolean = () => true) {
  const scoped = createApi(async <T>(command: string, args?: Parameters<typeof invoke>[1]): Promise<T> => {
    if (!vaultPath.trim()) throw new Error("未选择礼金库");
    if (!isCurrent()) throw new Error("礼金库页面已切换或已关闭，请在当前页面重试");
    const result = await invoke<T>(command, SCOPED_COMMANDS.has(command) ? { ...args, vaultPath } : args);
    if (READ_COMMANDS.has(command) && !isCurrent()) throw new Error("礼金库页面已切换或已关闭，已忽略过期结果");
    return result;
  });
  return { ...scoped, isCurrent };
}

export interface SpreadsheetPreview {
  fileName: string;
  sheetName: string;
  sheetNames: string[];
  headerRow: number;
  suggestedMapping: SpreadsheetColumnMapping;
  currentMapping: SpreadsheetColumnMapping;
  headers: string[];
  rows: string[][];
  validRows: number;
  errors: string[];
  rowErrors: string[];
  tagPreview: SpreadsheetTagPreview | null;
}

export interface SpreadsheetColumnMapping {
  name: number | null;
  amount: number | null;
  address: number | null;
  paymentMethod: number | null;
  date: number | null;
  note: number | null;
  returnGift: number | null;
  returnGiftAmount: number | null;
  returnGiftedAt: number | null;
  tags: number | null;
}

export interface SpreadsheetImportItem {
  path: string;
  sheetName?: string;
  headerRow?: number;
  mapping?: SpreadsheetColumnMapping;
  bookName: string;
  targetBookId?: string | null;
  targetVaultPath?: string | null;
  createNewBook?: boolean;
}

export interface SpreadsheetTagValuePreview {
  name: string;
  color: string;
  existing: boolean;
  count: number;
}

export interface SpreadsheetTagPreview {
  columnName: string | null;
  values: SpreadsheetTagValuePreview[];
}

export interface SpreadsheetImportResult {
  imported: number;
  createdTags: SpreadsheetTagValuePreview[];
  existingTags: string[];
  skippedRows: string[];
}

export interface SpreadsheetImportBookResult {
  book: GiftBook;
  imported: number;
  createdTags: SpreadsheetTagValuePreview[];
  existingTags: string[];
  skippedRows: string[];
}

export interface SpreadsheetBatchImportResult {
  books: SpreadsheetImportBookResult[];
  imported: number;
  skippedRows: string[];
}
