use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct VaultInfo {
    pub path: String,
    pub name: String,
    pub notes: Option<String>,
    pub book_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultOpenResult {
    pub vault: VaultInfo,
    pub role: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub role: String,
    pub security_configured: bool,
    pub edit_locked: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GiftBook {
    pub id: String,
    pub title: String,
    pub occasion: String,
    pub event_date: Option<String>,
    pub location: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub source_file_name: Option<String>,
    pub source_file_path: Option<String>,
    pub source_imported_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditBookInput {
    pub title: String,
    pub occasion: String,
    pub event_date: String,
    pub location: String,
    pub notes: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftEntry {
    pub id: String,
    pub book_id: String,
    pub person_id: String,
    pub person_name: String,
    pub address: Option<String>,
    pub amount_fen: i64,
    pub payment_method: String,
    pub received_at: String,
    pub note: Option<String>,
    pub return_gift: Option<String>,
    pub return_gift_amount_fen: Option<i64>,
    pub return_gifted_at: Option<String>,
    pub tags: Vec<String>,
    pub tag_names: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnGiftRecord {
    pub entry_id: String,
    pub book_id: String,
    pub book_title: String,
    pub person_id: String,
    pub person_name: String,
    pub address: Option<String>,
    pub return_gift_amount_fen: i64,
    pub return_gifted_at: String,
    pub return_gift: Option<String>,
    pub tags: Vec<Tag>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub display_name: String,
    pub address: Option<String>,
    pub notes: Option<String>,
    pub tags: Vec<Tag>,
    pub total_fen: i64,
    pub gift_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookStat {
    pub book_id: String,
    pub title: String,
    pub event_date: Option<String>,
    pub people_count: i64,
    pub gift_count: i64,
    pub total_fen: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonBook {
    pub vault_path: String,
    pub vault_name: String,
    pub book_id: String,
    pub title: String,
    pub event_date: Option<String>,
    pub people_count: i64,
    pub gift_count: i64,
    pub total_fen: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonBookRef {
    pub vault_path: String,
    pub book_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonBookEntry {
    pub vault_path: String,
    pub vault_name: String,
    pub book_id: String,
    pub book_title: String,
    pub entry_id: String,
    pub person_id: String,
    pub person_name: String,
    pub address: Option<String>,
    pub amount_fen: i64,
    pub payment_method: String,
    pub received_at: String,
    pub note: Option<String>,
    pub return_gift: Option<String>,
    pub return_gift_amount_fen: Option<i64>,
    pub tags: Vec<Tag>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonPersonSource {
    pub vault_path: String,
    pub vault_name: String,
    pub book_id: String,
    pub book_title: String,
    pub event_date: Option<String>,
    pub gift_count: i64,
    pub total_fen: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonPerson {
    pub vault_path: String,
    pub vault_name: String,
    pub person_id: String,
    pub display_name: String,
    pub address: Option<String>,
    pub notes: Option<String>,
    pub tags: Vec<Tag>,
    pub source_books: Vec<ComparisonPersonSource>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonPersonRef {
    pub vault_path: String,
    pub person_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonPersonHistory {
    pub vault_path: String,
    pub vault_name: String,
    pub person_id: String,
    pub person_name: String,
    pub person_address: Option<String>,
    pub person_notes: Option<String>,
    pub tags: Vec<Tag>,
    pub entry_id: String,
    pub book_id: String,
    pub book_title: String,
    pub event_date: Option<String>,
    pub gift_count: i64,
    pub total_fen: i64,
    pub payment_method: String,
    pub note: Option<String>,
    pub return_gift: Option<String>,
    pub return_gift_amount_fen: Option<i64>,
    pub latest_received_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookSummary {
    pub book_id: String,
    pub gift_count: i64,
    pub highest_amount_fen: i64,
    pub total_fen: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub entry: GiftEntry,
    pub vault_path: String,
    pub vault_name: String,
    pub book_title: String,
    pub matched_fields: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchVaultSummary {
    pub vault_path: String,
    pub vault_name: String,
    pub match_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub results: Vec<SearchHit>,
    pub truncated: bool,
    pub total_matches: usize,
    pub searched_vaults: Vec<SearchVaultSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonHistory {
    pub book_id: String,
    pub book_title: String,
    pub event_date: Option<String>,
    pub gift_count: i64,
    pub total_fen: i64,
    pub latest_received_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    pub kind: String,
    pub vault_path: Option<String>,
    pub title: String,
    pub book_title: String,
    pub deleted_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditChange {
    pub field: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLog {
    pub id: String,
    pub entity_id: String,
    pub action: String,
    pub entity_type: String,
    pub target: String,
    pub book_title: Option<String>,
    pub description: String,
    pub changes: Vec<AuditChange>,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetPreview {
    pub file_name: String,
    pub sheet_name: String,
    pub sheet_names: Vec<String>,
    pub header_row: usize,
    pub suggested_mapping: SpreadsheetColumnMapping,
    pub current_mapping: SpreadsheetColumnMapping,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub valid_rows: usize,
    pub errors: Vec<String>,
    pub row_errors: Vec<String>,
    pub tag_preview: Option<SpreadsheetTagPreview>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetColumnMapping {
    pub name: Option<usize>,
    pub amount: Option<usize>,
    pub address: Option<usize>,
    pub payment_method: Option<usize>,
    pub date: Option<usize>,
    pub note: Option<usize>,
    pub return_gift: Option<usize>,
    pub return_gift_amount: Option<usize>,
    pub return_gifted_at: Option<usize>,
    pub tags: Option<usize>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetImportItem {
    pub path: String,
    pub sheet_name: Option<String>,
    pub header_row: Option<usize>,
    pub mapping: Option<SpreadsheetColumnMapping>,
    pub book_name: String,
    pub target_book_id: Option<String>,
    #[serde(default)]
    pub create_new_book: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetImportBookResult {
    pub book: GiftBook,
    pub imported: usize,
    pub created_tags: Vec<SpreadsheetTagValuePreview>,
    pub existing_tags: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetBatchImportResult {
    pub books: Vec<SpreadsheetImportBookResult>,
    pub imported: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetTagValuePreview {
    pub name: String,
    pub color: String,
    pub existing: bool,
    pub count: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetTagPreview {
    pub column_name: Option<String>,
    pub values: Vec<SpreadsheetTagValuePreview>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetImportResult {
    pub imported: usize,
    pub created_tags: Vec<SpreadsheetTagValuePreview>,
    pub existing_tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEntryInput {
    pub book_id: String,
    pub person_name: String,
    pub address: String,
    pub amount_fen: i64,
    pub payment_method: String,
    pub received_at: String,
    pub note: String,
    pub return_gift: String,
    pub return_gift_amount_fen: Option<i64>,
    pub tag_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEntryInput {
    pub entry_id: String,
    pub person_name: String,
    pub address: String,
    pub amount_fen: i64,
    pub payment_method: String,
    pub received_at: String,
    pub note: String,
    pub return_gift: String,
    pub return_gift_amount_fen: Option<i64>,
    pub tag_ids: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalUpdateCandidate {
    pub version: String,
    pub file_name: String,
    pub release_notes: Option<String>,
    pub published_at: Option<String>,
    pub release_url: Option<String>,
    pub download_url: Option<String>,
    pub checksum_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUpdateStatus {
    pub current_version: String,
    pub update_directory: String,
    pub candidate: Option<LocalUpdateCandidate>,
    pub source: String,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsStorageInfo {
    pub directory: String,
    pub configured: bool,
}
