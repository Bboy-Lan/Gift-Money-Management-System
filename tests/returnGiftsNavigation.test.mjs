import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("return-gift navigation is above history and history is not duplicated in the top tabs", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const sidebarReturn = source.indexOf('activeTab === "returnGifts"');
  const sidebarHistory = source.indexOf('activeTab === "history"');
  const topTabs = source.match(/<nav className="tab-bar">([\s\S]*?)<\/nav>/)?.[1] ?? "";

  assert.ok(sidebarReturn >= 0);
  assert.ok(sidebarHistory > sidebarReturn);
  assert.match(source, /<ReturnGiftsView vaultPath=\{vault\.path\} isAdmin=\{canEdit\}/);
  assert.match(source, /!activeBook && activeTab === "returnGifts"[\s\S]*?<ReturnGiftsView/);
  assert.match(source, /!activeBook && activeTab === "history"[\s\S]*?<HistoryView/);
  assert.doesNotMatch(topTabs, /历史改动/);
});

test("return-gift edits use the dedicated information API and tag popovers close outside their region", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const apiSource = await readFile(new URL("../src/lib/tauri.ts", import.meta.url), "utf8");

  assert.match(source, /api\.updateReturnGiftInformation\(entryId, amountFen, returnGift\)/);
  assert.match(source, /编辑回礼信息/);
  assert.match(source, /回礼备注/);
  assert.match(source, /formatReturnGiftTime\(record\.returnGiftedAt\)/);
  assert.match(source, /回礼时间/);
  assert.doesNotMatch(source, /onPointerLeave=\{\(\) => pickerOpen && onTogglePicker\(\)\}/);
  assert.match(source, /document\.addEventListener\("pointerdown", closeOnOutsidePointer\)/);
  assert.match(apiSource, /update_return_gift_information/);
});

test("history removes the book trash action and exposes a dedicated history delete operation", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const apiSource = await readFile(new URL("../src/lib/tauri.ts", import.meta.url), "utf8");

  assert.match(source, /activeTab !== "history"/);
  assert.match(source, /删除改动信息/);
  assert.match(source, /恢复改动/);
  assert.match(source, /api\.clearAuditLogs/);
  assert.match(apiSource, /clear_audit_logs/);
});

test("ledger tables show return amount and history deletion supports selected records", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const apiSource = await readFile(new URL("../src/lib/tauri.ts", import.meta.url), "utf8");

  assert.match(source, /<th>回礼金额<\/th>/);
  assert.match(source, /entry\.returnGiftAmountFen \? formatMoney\(entry\.returnGiftAmountFen\)/);
  assert.match(source, /selectedHistoryIds/);
  assert.match(source, /const \[selectionMode, setSelectionMode\]/);
  assert.match(source, /selectionMode && <th className="audit-select-column">/);
  assert.match(source, /clearHistory\.mutate\(selectionMode \? selectedRecords : \(history\.data \?\? \[\]\)\)/);
  assert.match(source, /删除改动信息/);
  assert.match(source, /<td className="muted audit-book">\{record\.bookTitle \|\| "礼金库"\}<\/td>/);
  assert.match(apiSource, /clearAuditLogs: \(ids: string\[\] = \[\]\) => invoke<void>\("clear_audit_logs", \{ ids \}\)/);
  assert.match(apiSource, /restoreAuditLogs: \(ids: string\[\]\) => invoke<void>\("restore_audit_logs", \{ ids \}\)/);
});

test("gift summary uses record count, highest amount, and total amount", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const types = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");

  assert.match(source, /<Metric label="礼金笔数" value=\{`\$\{summary\.data\?\.giftCount \?\? 0\}`\} accent="blue" \/>/);
  assert.match(source, /<Metric label="最高金额" value=\{formatMoney\(summary\.data\?\.highestAmountFen \?\? 0\)\} accent="green" \/>/);
  assert.match(source, /<Metric label="礼金总额" value=\{summaryMoney\.primary\} detail=\{summaryMoney\.exact\} accent="amber" \/>/);
  assert.match(types, /highestAmountFen: number;/);
});

test("return-gift edits are visible in the reversible history scope", async () => {
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  assert.match(rust, /description: "编辑回礼信息"/);
  assert.match(rust, /"gift_entry",\s*&entry_id/);
  assert.match(rust, /entity_type IN \('gift_entry', 'return_gift'\)/);
  assert.match(rust, /entity_type == "gift_entry"[\s\S]*?entity_type == "return_gift"/);
  assert.match(rust, /person_id: snapshot\.person_id\.clone\(\)/);
  assert.match(rust, /book_ids: vec!\[snapshot\.book_id\.clone\(\)\]/);
});
