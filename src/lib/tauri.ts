import { invoke } from "@tauri-apps/api/core";
import type { AuditLog, BookStat, BookSummary, ComparisonBook, ComparisonBookEntry, ComparisonBookRef, ComparisonPerson, ComparisonPersonHistory, ComparisonPersonRef, GiftBook, GiftEntry, LocalUpdateStatus, Person, PersonHistory, ReturnGiftRecord, SearchResponse, SessionStatus, SettingsStorageInfo, Tag, TrashItem, VaultInfo, VaultOpenResult } from "../types";

export const api = {
  chooseVaultPath: (mode: "open" | "save") => invoke<string | null>("choose_vault_path", { mode }),
  chooseComparisonVaultPaths: () => invoke<string[]>("choose_comparison_vault_paths"),
  createVault: (path: string, name: string, notes: string) => invoke<VaultOpenResult>("create_vault", { path, name, notes }),
  editVault: (name: string, notes: string) => invoke<VaultInfo>("edit_vault", { name, notes }),
  currentVaultInfo: () => invoke<VaultInfo>("current_vault_info"),
  openVault: (path: string) => invoke<VaultOpenResult>("open_vault", { path }),
  closeVault: () => invoke<void>("close_vault"),
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
  openLocalUpdateDirectory: () => invoke<void>("open_local_update_directory"),
  startLocalUpdate: () => invoke<void>("start_local_update"),
  settingsStorageInfo: () => invoke<SettingsStorageInfo>("settings_storage_info"),
  chooseSettingsDirectory: () => invoke<SettingsStorageInfo | null>("choose_settings_directory"),
  licenseText: () => invoke<string>("license_text"),
  listBooks: () => invoke<GiftBook[]>("list_books"),
  createBook: (input: { title: string; occasion: string; eventDate: string; location: string; notes: string }) =>
    invoke<GiftBook>("create_book", input),
  editBook: (bookId: string, input: { title: string; occasion: string; eventDate: string; location: string; notes: string }) =>
    invoke<GiftBook>("edit_book", { bookId, input }),
  deleteBook: (bookId: string, pin: string) => invoke<void>("delete_book", { bookId, pin }),
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
  clearAuditLogs: (ids: string[] = []) => invoke<void>("clear_audit_logs", { ids }),
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
  exportBookXlsx: (bookId: string) => invoke<string>("export_book_xlsx", { bookId }),
  exportVault: () => invoke<string>("export_vault"),
};

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
}

export interface SpreadsheetImportBookResult {
  book: GiftBook;
  imported: number;
  createdTags: SpreadsheetTagValuePreview[];
  existingTags: string[];
}

export interface SpreadsheetBatchImportResult {
  books: SpreadsheetImportBookResult[];
  imported: number;
}
