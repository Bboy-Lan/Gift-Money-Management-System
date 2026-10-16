export type Tab = "entries" | "people" | "compare" | "returnGifts" | "history" | "trash" | "settings";

export interface VaultInfo {
  path: string;
  name: string;
  notes: string | null;
  bookCount: number;
}

export interface AuditChange {
  field: string;
  before: string;
  after: string;
  machine?: { version: number; fieldId: string; before: unknown; after: unknown };
}

export interface AuditLog {
  id: string;
  entityId: string;
  action: string;
  entityType: string;
  target: string;
  bookTitle: string | null;
  description: string;
  changes: AuditChange[];
  createdAt: string;
  reversible: boolean;
  reversibleReason: string | null;
}

export type SessionRole = "viewer" | "admin";

export interface VaultOpenResult {
  vault: VaultInfo;
  role: SessionRole;
}

export interface SessionStatus {
  role: SessionRole;
  securityConfigured: boolean;
  editLocked: boolean;
}

export interface LocalUpdateCandidate {
  version: string;
  fileName: string;
  releaseNotes: string | null;
  publishedAt: string | null;
  releaseUrl: string | null;
}

export interface LocalUpdateStatus {
  currentVersion: string;
  updateDirectory: string;
  candidate: LocalUpdateCandidate | null;
  source: "local" | "github" | "none";
  error: string | null;
}

export interface SettingsStorageInfo {
  directory: string;
  configured: boolean;
}

export interface DownloadChannel {
  id: "github" | "lanzou" | "baidu";
  label: string;
  url: string | null;
  extractionCode?: string | null;
}

export interface SoftwareCandidate {
  id: string;
  version: string;
  source: "github" | "local";
  releaseNotes: string | null;
}

export interface SoftwareUpdateStatus {
  currentVersion: string;
  configured: boolean;
  installed: boolean;
  checkedAt: string | null;
  candidate: SoftwareCandidate | null;
  channels: DownloadChannel[];
  error: string | null;
}

export interface UpdateProgress {
  phase: "downloading" | "verifying";
  received: number;
  total: number | null;
}

export interface GiftBook {
  id: string;
  title: string;
  occasion: string;
  eventDate: string | null;
  location: string | null;
  notes: string | null;
  createdAt: string;
  sourceFileName: string | null;
  sourceFilePath: string | null;
  sourceImportedAt: string | null;
}

export interface GiftEntry {
  id: string;
  bookId: string;
  personId: string;
  personName: string;
  address: string | null;
  amountFen: number;
  paymentMethod: string;
  receivedAt: string;
  note: string | null;
  returnGift: string | null;
  returnGiftAmountFen: number | null;
  returnGiftedAt: string | null;
  tags: string[];
  tagNames: string[];
}

export interface ReturnGiftRecord {
  entryId: string;
  bookId: string;
  bookTitle: string;
  personId: string;
  personName: string;
  address: string | null;
  returnGiftAmountFen: number;
  returnGiftedAt: string;
  returnGift: string | null;
  tags: Tag[];
}

export interface Person {
  id: string;
  displayName: string;
  address: string | null;
  notes: string | null;
  tags: Tag[];
  totalFen: number;
  giftCount: number;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface BookStat {
  bookId: string;
  title: string;
  eventDate: string | null;
  peopleCount: number;
  giftCount: number;
  totalFen: number;
}

export interface ComparisonBook {
  vaultPath: string;
  vaultName: string;
  bookId: string;
  title: string;
  eventDate: string | null;
  peopleCount: number;
  giftCount: number;
  totalFen: number;
}

export interface ComparisonBookRef {
  vaultPath: string;
  bookId: string;
}

export interface ComparisonBookEntry {
  vaultPath: string;
  vaultName: string;
  bookId: string;
  bookTitle: string;
  entryId: string;
  personId: string;
  personName: string;
  address: string | null;
  amountFen: number;
  paymentMethod: string;
  receivedAt: string;
  note: string | null;
  returnGift: string | null;
  returnGiftAmountFen: number | null;
  tags: Tag[];
}

export interface ComparisonPersonSource {
  vaultPath: string;
  vaultName: string;
  bookId: string;
  bookTitle: string;
  eventDate: string | null;
  giftCount: number;
  totalFen: number;
}

export interface ComparisonPerson {
  vaultPath: string;
  vaultName: string;
  bookId: string;
  personId: string;
  displayName: string;
  address: string | null;
  notes: string | null;
  tags: Tag[];
  sourceBooks: ComparisonPersonSource[];
}

export interface ComparisonPersonRef {
  vaultPath: string;
  bookId: string;
  personId: string;
}

export interface ComparisonPersonHistory {
  vaultPath: string;
  vaultName: string;
  personId: string;
  personName: string;
  personAddress: string | null;
  personNotes: string | null;
  tags: Tag[];
  entryId: string;
  bookId: string;
  bookTitle: string;
  eventDate: string | null;
  giftCount: number;
  totalFen: number;
  paymentMethod: string;
  note: string | null;
  returnGift: string | null;
  returnGiftAmountFen: number | null;
  latestReceivedAt: string;
}

export interface BookSummary {
  bookId: string;
  giftCount: number;
  highestAmountFen: number;
  totalFen: number;
}

export interface SearchHit {
  entry: GiftEntry;
  vaultPath: string;
  vaultName: string;
  bookTitle: string;
  matchedFields: string[];
}

export interface SearchVaultSummary {
  vaultPath: string;
  vaultName: string;
  matchCount: number;
}

export interface SearchResponse {
  results: SearchHit[];
  truncated: boolean;
  totalMatches: number;
  searchedVaults: SearchVaultSummary[];
}

export interface PersonHistory {
  bookId: string;
  bookTitle: string;
  eventDate: string | null;
  giftCount: number;
  totalFen: number;
  latestReceivedAt: string;
}

export interface TrashItem {
  id: string;
  kind: "book" | "entry" | "tag" | "person" | "vault";
  vaultPath: string | null;
  title: string;
  bookTitle: string;
  deletedAt: string;
}
