import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

async function load(path, invoke = async () => undefined) {
  let source = await readFile(new URL(path, import.meta.url), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  source = source.replace('import { invoke } from "@tauri-apps/api/core";', 'const invoke = globalThis.__remediationInvoke;');
  globalThis.__remediationInvoke = invoke;
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}#${Math.random()}`);
}

test('same book and person IDs in A and B keep query calls and writes bound to their captured vault', async () => {
  const calls = [];
  const mod = await load('../src/lib/tauri.ts', async (command, args) => { calls.push([command, args]); return []; });
  assert.equal(typeof mod.createVaultApi, 'function');
  const a = mod.createVaultApi('A.giftvault');
  const b = mod.createVaultApi('B.giftvault');
  await Promise.all([a.listEntries('same-book', ''), b.listEntries('same-book', '')]);
  await a.setPersonTags('same-person', ['a']);
  assert.deepEqual(calls, [['list_entries', { bookId: 'same-book', search: '', vaultPath: 'A.giftvault' }], ['list_entries', { bookId: 'same-book', search: '', vaultPath: 'B.giftvault' }], ['set_person_tags', { personId: 'same-person', tagIds: ['a'], vaultPath: 'A.giftvault' }]]);
});

test('revoked scope rejects new stale form writes and discards an interleaved read response', async () => {
  let resolve; let active = true; let writes = 0;
  const mod = await load('../src/lib/tauri.ts', (command) => { if (command === 'list_entries') return new Promise((r) => { resolve = r; }); writes++; return Promise.resolve(); });
  assert.equal(typeof mod.createVaultApi, 'function');
  const a = mod.createVaultApi('A.giftvault', () => active);
  const pending = a.listEntries('same', '');
  active = false; resolve([{ id: 'A-result' }]);
  await assert.rejects(pending, /已切换|已关闭/);
  await assert.rejects(a.deleteEntry('same'), /已切换|已关闭/);
  assert.equal(writes, 0);
});

test('ordinary root calls reject missing scope instead of silently using the active vault', async () => {
  let calls = 0;
  const { api } = await load('../src/lib/tauri.ts', async () => { calls++; return []; });
  await assert.rejects(api.listTags(), /礼金库/);
  assert.equal(calls, 0);
});

test('closing active or nonactive vault awaits backend and leaves state untouched on failure', async () => {
  const mod = await load('../src/lib/openedVaultSessions.ts');
  assert.equal(typeof mod.closeVaultSession, 'function');
  const sessions = [{ path: 'A', activeBookId: 'same', activeTab: 'people' }, { path: 'B', activeBookId: 'same', activeTab: 'history' }];
  await assert.rejects(mod.closeVaultSession(sessions, 'A', 'B', async () => { throw Error('close failed'); }), /close failed/);
  assert.equal(sessions.length, 2);
  assert.deepEqual(await mod.closeVaultSession(sessions, 'A', 'B', async () => {}), { sessions: [sessions[0]], activePath: 'A' });
  assert.deepEqual(await mod.closeVaultSession(sessions, 'A', 'A', async () => {}), { sessions: [sessions[1]], activePath: 'B' });
  assert.deepEqual(await mod.closeVaultSession([sessions[0]], 'A', 'A', async () => {}), { sessions: [], activePath: null });
});

test('explicit result navigation waits for open and uses returned book and entry on entries tab', async () => {
  const mod = await load('../src/lib/openedVaultSessions.ts');
  assert.equal(typeof mod.navigateVaultResult, 'function');
  let release; let applied;
  const pending = mod.navigateVaultResult({ path: 'B', bookId: 'new-book', entryId: 'hit' }, () => new Promise((r) => { release = r; }), (result) => { applied = result; });
  assert.equal(applied, undefined);
  release({ vault: { path: 'B' } }); await pending;
  assert.deepEqual(applied, { result: { vault: { path: 'B' } }, bookId: 'new-book', entryId: 'hit', tab: 'entries' });
});

test('integer money accepts exact upper limit but rejects one fen over limit and unsafe integers', async () => {
  const { parseAmountFen } = await load('../src/lib/money.ts');
  assert.equal(parseAmountFen('9999999999.99'), 999999999999);
  assert.equal(parseAmountFen('10000000000.00'), null);
  assert.equal(parseAmountFen('90071992547409.92'), null);
  assert.equal(parseAmountFen('0.01'), 1);
});

test('read errors distinguish unavailable data from cached stale data and successful empty collections', async () => {
  const mod = await load('../src/lib/viewSafety.ts');
  assert.equal(typeof mod.readState, 'function');
  assert.equal(mod.readState({ isPending: true, isError: false }), 'loading');
  assert.equal(mod.readState({ isPending: false, isError: true }), 'error');
  assert.equal(mod.readState({ isPending: false, isError: true, data: [] }), 'stale');
  assert.equal(mod.readState({ isPending: false, isError: false, data: [] }), 'empty');
  assert.equal(mod.readState({ isPending: false, isError: false, data: [{ id: 1 }] }), 'ready');
});

test('closing a dirty form never opens a browser confirmation while saving still forbids closing', async () => {
  const mod = await load('../src/lib/viewSafety.ts');
  assert.equal(typeof mod.allowFormClose, 'function');
  assert.equal(mod.allowFormClose(true, true), false);
  assert.equal(mod.allowFormClose(true, false), true);
  assert.equal(mod.allowFormClose(false, false), true);
});

test('unchanged legacy dates and long notes survive another field edit while changed invalid values fail', async () => {
  const mod = await load('../src/lib/viewSafety.ts');
  assert.equal(typeof mod.validateChangedText, 'function');
  const legacy = 'x'.repeat(65537);
  assert.equal(mod.validateChangedText('备注', legacy, 65536, legacy), null);
  assert.match(mod.validateChangedText('备注', legacy + 'y', 65536, legacy), /65536/);
  assert.match(mod.validateChangedText('姓名', '张\0三', 256), /无效/);
  assert.equal(mod.validateChangedDate('未知旧日期', '未知旧日期'), null);
  assert.match(mod.validateChangedDate('2026-02-30'), /日期/);
  assert.equal(mod.validateChangedDate('2026-02-28'), null);
});

test('irreversible audit retains readable reason and cannot enter restoration selection', async () => {
  const mod = await load('../src/lib/viewSafety.ts');
  assert.equal(typeof mod.canRestoreAudit, 'function');
  assert.equal(mod.canRestoreAudit({ action: 'edit', reversible: false, reversibleReason: '人物关联已变化' }), false);
  assert.equal(mod.canRestoreAudit({ action: 'edit', reversible: true, reversibleReason: null }), true);
});

test('emoji initials preserve grapheme and same titled vault/books remain separate row spans', async () => {
  const mod = await load('../src/lib/viewSafety.ts');
  assert.equal(typeof mod.firstCharacter, 'function');
  assert.equal(mod.firstCharacter('👨‍👩‍👧‍👦王'), '👨‍👩‍👧‍👦');
  const rows = [{ vaultPath: 'A', bookId: '1' }, { vaultPath: 'B', bookId: '1' }, { vaultPath: 'B', bookId: '2' }, { vaultPath: 'B', bookId: '2' }];
  assert.deepEqual([...mod.sourceRowSpans(rows, false)], [[0, 1], [1, 3]]);
  assert.deepEqual([...mod.sourceRowSpans(rows, true)], [[0, 1], [1, 1], [2, 2]]);
});

test('actual query feedback renders accessible persistent error, retry and stale warning', async () => {
  const safety = await load('../src/lib/viewSafety.ts');
  let source = await readFile(new URL('../src/components/QueryFeedback.tsx', import.meta.url), 'utf8').catch(() => '');
  globalThis.__remediationReact = React; globalThis.__remediationSafety = safety;
  source = source.replace('import type React from "react";', 'const React = globalThis.__remediationReact;').replace('import { readState } from "../lib/viewSafety";', 'const { readState } = globalThis.__remediationSafety;');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}#feedback`);
  assert.equal(typeof mod.QueryFeedback, 'function');
  const error = renderToStaticMarkup(React.createElement(mod.QueryFeedback, { label: '礼金记录', query: { isPending: false, isError: true, error: Error('磁盘读取失败'), refetch() {} } }));
  assert.match(error, /role="alert"/); assert.match(error, /磁盘读取失败/); assert.match(error, /重试/); assert.doesNotMatch(error, /第一笔|还没有/);
  const stale = renderToStaticMarkup(React.createElement(mod.QueryFeedback, { label: '礼金记录', query: { isPending: false, isError: true, data: [], error: Error('失败'), refetch() {} } }));
  assert.match(stale, /上次读取/);
});

test('a vault write refreshes its stats tags audit and comparison without invalidating unrelated B data', async () => {
  const mod = await load('../src/lib/vaultQueries.ts');
  assert.equal(typeof mod.invalidateVaultQueries, 'function');
  const client = new QueryClient();
  for (const key of [['books', 'A'], ['entries', 'A', 'same'], ['tags', 'A'], ['audit-logs', 'A'], ['book-stats', 'A'], ['person-history', 'A'], ['entries', 'B', 'same'], ['comparison-books', ['A', 'B']], ['comparison-book-people', 'A\u001fsame'], ['opened-vault-books', ['A', 'B']]]) client.setQueryData(key, []);
  await mod.invalidateVaultQueries(client, 'A');
  for (const key of [['books', 'A'], ['entries', 'A', 'same'], ['tags', 'A'], ['audit-logs', 'A'], ['book-stats', 'A'], ['person-history', 'A'], ['comparison-books', ['A', 'B']], ['comparison-book-people', 'A\u001fsame'], ['opened-vault-books', ['A', 'B']]]) assert.equal(client.getQueryState(key).isInvalidated, true);
  assert.equal(client.getQueryState(['entries', 'B', 'same']).isInvalidated, false);
  client.clear();
});

let componentModule;
async function actualComponents() {
  if (!componentModule) componentModule = (async () => {
    const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const result = await build({ stdin: { contents: source.replace('export default App;', 'export { Modal, EntriesView, EntryModal, HistoryView, BookMetadataModal, canLeaveWorkspace };'), resolveDir: fileURLToPath(new URL('../src', import.meta.url)), loader: 'tsx' }, bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', loader: { '.png': 'dataurl' }, plugins: [{ name: 'external-dependencies', setup(builder) { builder.onResolve({ filter: /^[^./]/ }, (args) => ({ path: import.meta.resolve(args.path), external: true })); } }] });
    const bundle = new URL(`./.frontend-components-${process.pid}.mjs`, import.meta.url);
    await writeFile(bundle, result.outputFiles[0].text);
    try { return await import(bundle.href); } finally { await unlink(bundle); }
  })();
  return componentModule;
}

const noop = () => {};
const book = { id: 'same-book', title: '甲簿', occasion: '婚礼', eventDate: null, location: null, notes: null, createdAt: '2026-10-14', sourceFileName: null, sourceFilePath: null, sourceImportedAt: null };
const entry = { id: 'same-entry', bookId: 'same-book', personId: 'same-person', personName: '张三', address: null, amountFen: 100, paymentMethod: '现金', receivedAt: '旧未知日期', note: ' 原备注 ', returnGift: null, returnGiftAmountFen: null, returnGiftedAt: null, tags: ['keep-tag'], tagNames: ['保留'] };
function renderWithClient(component, props, client) { return renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(component, props))); }

test('real EntriesView failed read renders error and retry without zero stats or first entry CTA', async () => {
  const { EntriesView } = await actualComponents();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  await client.fetchQuery({ queryKey: ['entries', 'A', 'same-book'], queryFn: async () => { throw Error('读取失败'); } }).catch(noop);
  const html = renderWithClient(EntriesView, { book, vaultPath: 'A', isAdmin: true, editLocked: false, onError: noop, onNotice: noop, onVaultActivity: noop }, client);
  assert.match(html, /读取失败/); assert.match(html, /重试/); assert.doesNotMatch(html, /登记第一笔|还没有礼金记录|礼金总额/);
  client.clear();
});

test('real EntryModal refuses programmatic submission after failed tag load and preserves saved tag IDs', async () => {
  const { EntryModal } = await actualComponents();
  const client = new QueryClient(); let rendered; let submitted;
  const Capture = () => { rendered = EntryModal({ initial: entry, vaultPath: 'A', tags: [], tagsReady: false, isSaving: false, onClose: noop, onCreateTag: noop, onSubmit: (draft) => { submitted = draft; } }); return rendered; };
  const html = renderWithClient(Capture, {}, client);
  assert.match(html, /人物标签尚未成功读取/); assert.match(html, /disabled/);
  rendered.props.children.props.onSubmit({ preventDefault: noop });
  assert.equal(submitted, undefined);
  client.clear();
});

test('real EntryModal resubmits unchanged legacy note and unknown date verbatim', async () => {
  const { EntryModal } = await actualComponents();
  const client = new QueryClient(); let rendered; let submitted;
  const legacy = { ...entry, note: ' '.repeat(2) + '长'.repeat(65537) + ' ' };
  const Capture = () => { rendered = EntryModal({ initial: legacy, vaultPath: 'A', tags: [{ id: 'keep-tag', name: '保留', color: '#123456' }], tagsReady: true, isSaving: false, onClose: noop, onCreateTag: noop, onSubmit: (draft) => { submitted = draft; } }); return rendered; };
  renderWithClient(Capture, {}, client);
  rendered.props.children.props.onSubmit({ preventDefault: noop });
  assert.equal(submitted.note, legacy.note); assert.equal(submitted.receivedAt, '旧未知日期'); assert.deepEqual(submitted.tagIds, ['keep-tag']);
  client.clear();
});

test('real Modal blocks header backdrop and cancel while a submit is pending', async () => {
  const { Modal } = await actualComponents(); let rendered; let closes = 0;
  const Capture = () => { rendered = Modal({ title: '保存', isSaving: true, onClose: () => { closes++; }, children: '内容' }); return rendered; };
  const html = renderToStaticMarkup(React.createElement(Capture));
  assert.match(html, /role="dialog"/); assert.match(html, /aria-modal="true"/); assert.match(html, /disabled/);
  const heading = rendered.props.children.props.children[0]; heading.props.children[1].props.onClick();
  const backdrop = {}; rendered.props.onMouseDown({ target: backdrop, currentTarget: backdrop });
  let stopped = false; rendered.props.onClickCapture({ target: { closest: () => ({ textContent: '取消', hasAttribute: () => false }) }, preventDefault: noop, stopPropagation: () => { stopped = true; } });
  assert.equal(closes, 0); assert.equal(stopped, true);
});

test('real book metadata save preserves unchanged legacy title occasion location and note exactly', async () => {
  const { BookMetadataModal } = await actualComponents(); let rendered; let submitted;
  const original = { ...book, title: ' 甲簿 ', occasion: ' 婚礼 ', location: ' 旧村 ', notes: ' 原备注 ', eventDate: '未知旧日期' };
  const Capture = () => { rendered = BookMetadataModal({ book: original, isSaving: false, onClose: noop, onSubmit: (value) => { submitted = value; } }); return rendered; };
  renderToStaticMarkup(React.createElement(Capture));
  rendered.props.children.at(-1).props.children[1].props.onClick();
  assert.deepEqual(submitted, { title: ' 甲簿 ', occasion: ' 婚礼 ', eventDate: '未知旧日期', location: ' 旧村 ', notes: ' 原备注 ' });
});

test('real entry save preserves unchanged legacy person name and address instead of normalization', async () => {
  const { EntryModal } = await actualComponents(); const client = new QueryClient(); let rendered; let submitted;
  const legacy = { ...entry, personName: ' 张三 ', address: ' 旧村 ' };
  const Capture = () => { rendered = EntryModal({ initial: legacy, vaultPath: 'A', tags: [], tagsReady: true, isSaving: false, onClose: noop, onCreateTag: noop, onSubmit: (value) => { submitted = value; } }); return rendered; };
  renderWithClient(Capture, {}, client); rendered.props.children.props.onSubmit({ preventDefault: noop });
  assert.equal(submitted.personName, ' 张三 '); assert.equal(submitted.address, ' 旧村 '); client.clear();
});

test('any saving modal vetoes workspace navigation even when an earlier dirty modal allows discard', async () => {
  const { canLeaveWorkspace } = await actualComponents();
  const oldDocument = globalThis.document; const oldWindow = globalThis.window;
  globalThis.document = { querySelectorAll: () => [{ dataset: { modalDirty: 'true', modalSaving: 'false' } }, { dataset: { modalSaving: 'true' } }] };
  globalThis.window = { confirm: () => true };
  try { assert.equal(canLeaveWorkspace(), false); } finally { globalThis.document = oldDocument; globalThis.window = oldWindow; }
});

test('all 33 ordinary commands send top-level captured vaultPath while preserving special IPC shapes', async () => {
  const calls = [];
  const { api, createVaultApi } = await load('../src/lib/tauri.ts', async (command, args) => { calls.push([command, args]); return []; });
  const scoped = createVaultApi('A');
  const cases = [
    ['edit_vault', 'editVault', ['库', '备注']], ['current_vault_info', 'currentVaultInfo', []], ['list_books', 'listBooks', []],
    ['create_book', 'createBook', [{ title: '簿', occasion: '婚礼', eventDate: '', location: '', notes: '' }]], ['edit_book', 'editBook', ['same', {}]], ['restore_book', 'restoreBook', ['same']],
    ['preview_spreadsheet', 'previewSpreadsheet', ['sheet']], ['preview_spreadsheet_mapping', 'previewSpreadsheetMapping', ['sheet', null, null, {}]], ['import_spreadsheet', 'importSpreadsheet', ['sheet', 'same']], ['export_book_xlsx', 'exportBookXlsx', ['same']], ['export_vault', 'exportVault', []],
    ['list_entries', 'listEntries', ['same', '']], ['list_return_gifts', 'listReturnGifts', []], ['update_return_gift_information', 'updateReturnGiftInformation', ['same', 1, '']], ['search_vault', 'searchVault', ['张三', ['A', 'B']]],
    ['create_entry', 'createEntry', [{ bookId: 'same', amountFen: 1 }]], ['update_entry', 'updateEntry', [{ entryId: 'same', amountFen: 1 }]], ['delete_entry', 'deleteEntry', ['same']], ['restore_entry', 'restoreEntry', ['same']], ['delete_person', 'deletePerson', ['same']], ['restore_person', 'restorePerson', ['same']],
    ['list_audit_logs', 'listAuditLogs', []], ['restore_audit_logs', 'restoreAuditLogs', [['same']]], ['clear_audit_logs', 'clearAuditLogs', [['same']]], ['list_tags', 'listTags', []], ['create_tag', 'createTag', ['标签', '#123456']], ['delete_tag', 'deleteTag', ['same']], ['update_tag_color', 'updateTagColor', ['same', '#123456']], ['list_people', 'listPeople', ['', '', 'same']], ['set_person_tags', 'setPersonTags', ['same', []]], ['list_book_stats', 'listBookStats', []], ['book_summary', 'bookSummary', ['same']], ['person_history', 'personHistory', ['same']],
  ];
  for (const [command, method, args] of cases) { await scoped[method](...args); const last = calls.at(-1); assert.equal(last[0], command); assert.equal(last[1].vaultPath, 'A'); assert.equal(last[1].input?.vaultPath, undefined); }
  assert.equal(calls.length, 33);
  await api.closeOpenedVault('B'); await scoped.listBooksForVault('B'); await scoped.importSpreadsheets([{ path: 'sheet', bookName: '簿', targetVaultPath: 'B' }]); await scoped.restoreTrashItem('entry', 'same', 'B');
  assert.deepEqual(calls.slice(-4), [['close_opened_vault', { vaultPath: 'B' }], ['list_books_for_vault', { vaultPath: 'B' }], ['import_spreadsheets', { items: [{ path: 'sheet', bookName: '簿', targetVaultPath: 'B' }] }], ['restore_trash_item', { kind: 'entry', id: 'same', vaultPath: 'B' }]]);
});

test('real history retains irreversible records and exposes the backend restoration reason', async () => {
  const { HistoryView } = await actualComponents(); const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(['audit-logs', 'A'], [{ id: 'history', entityId: 'same', action: 'update', entityType: 'gift_entry', target: '张三', bookTitle: '甲簿', description: '标签修改', changes: [{ field: '标签', before: '甲', after: '乙' }], createdAt: '2026-10-14T00:00:00Z', reversible: false, reversibleReason: '人物关联已变化' }]);
  const html = renderWithClient(HistoryView, { vaultPath: 'A', vaultName: '甲库', isAdmin: true, onNotice: noop, onVaultUpdated: noop }, client);
  assert.match(html, /人物关联已变化/); assert.match(html, /张三/); assert.match(html, /disabled[^>]*>.*?恢复改动/s); client.clear();
});
