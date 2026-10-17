import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import React, { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://local.test/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true, __APP_VERSION__: 'test-version' });
const { createRoot } = await import('react-dom/client');
window.requestAnimationFrame = (fn) => window.setTimeout(fn, 0);
window.HTMLElement.prototype.scrollIntoView = () => {};
window.confirm = () => false;
globalThis.__reviewInvoke = async () => [];

const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const compiled = await build({ stdin: { contents: source.replace('export default App;', 'export { VaultWorkspace, Modal, ConfirmHistoryClear, PeopleView, EntriesView, canLeaveWorkspace }; export { createVaultApi } from "./lib/tauri"; export { VaultScopeContext } from "./lib/vaultScope";'), resolveDir: fileURLToPath(new URL('../src', import.meta.url)), loader: 'tsx' }, bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', loader: { '.png': 'dataurl' }, plugins: [{ name: 'runtime-boundaries', setup(builder) {
  builder.onResolve({ filter: /^[^./]/ }, (args) => ({ path: import.meta.resolve(args.path), external: true }));
  builder.onLoad({ filter: /[\\/]src[\\/]lib[\\/]tauri\.ts$/ }, async (args) => ({ contents: (await readFile(args.path, 'utf8')).replace('import { invoke } from "@tauri-apps/api/core";', 'const invoke = (command, args) => globalThis.__reviewInvoke(command, args);'), loader: 'ts' }));
} }] });
const bundle = new URL(`./.review-fix-components-${process.pid}.mjs`, import.meta.url);
await writeFile(bundle, compiled.outputFiles[0].text);
const production = await import(bundle.href); await unlink(bundle);
const noop = () => {};
const vault = { path: 'A', name: '甲库', notes: null, bookCount: 2 };
const bookA = { id: 'same-book', title: '甲簿', occasion: '婚礼', eventDate: '2026-10-14', location: null, notes: null, createdAt: '2026-10-14', sourceFileName: null, sourceFilePath: null, sourceImportedAt: null };
const bookB = { ...bookA, id: 'other-book', title: '乙簿' };
const workspaceProps = { vault, openedVaults: [{ vault, activeBookId: bookA.id, activeTab: 'entries' }], initialBookId: bookA.id, initialEntryId: 'focus-entry', initialTab: 'entries', session: { role: 'admin', securityConfigured: true, editLocked: false }, continuousRegistration: false, pendingSpreadsheetPaths: [], localUpdatePhase: 'idle', updateStatus: null, lastUpdateCheckAt: null };
for (const name of ['onContinuousRegistrationChange', 'onClose', 'onCloseVault', 'onReorderVaults', 'onError', 'onNotice', 'onUnlock', 'onLock', 'onUnlockEditing', 'onLockEditing', 'onChangePin', 'onCheckLocalUpdate', 'onInstallLocalUpdate', 'onConsumeSpreadsheetPaths', 'onBeginCreateVault', 'onOpenVault', 'onSwitchVault', 'onOpenSearchVault', 'onBookSelectionChange', 'onTabChange', 'onVaultActivity', 'onVaultUpdated']) workspaceProps[name] = noop;

function clientForWorkspace() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(['books', 'A'], [bookA, bookB]); client.setQueryData(['opened-vault-books', ['A']], [bookA, bookB].map((book) => ({ ...book, vaultPath: 'A', vaultName: '甲库' })));
  for (const path of ['A', 'B']) { client.setQueryData(['entries', path, 'same-book'], []); client.setQueryData(['entries', path, 'other-book'], []); client.setQueryData(['tags', path], []); }
  return client;
}
async function mount(Component, props = {}, client = clientForWorkspace(), scope = { active: true }) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const render = (nextProps) => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(production.VaultScopeContext.Provider, { value: scope }, React.createElement(Component, { ...nextProps, key: nextProps.vaultPath ?? nextProps.vault?.path }))));
  await act(async () => render(props));
  return { container, client, scope, async rerender(nextProps) { await act(async () => render(nextProps)); }, async close() { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}
function button(container, label) { const item = [...container.querySelectorAll('button')].find((element) => element.textContent.trim() === label || element.getAttribute('title') === label || element.getAttribute('aria-label') === label); assert.ok(item, label); return item; }
async function click(element) { await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); }
async function input(element, value) { await act(async () => { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(element, value); element.dispatchEvent(new window.Event('input', { bubbles: true })); element.dispatchEvent(new window.Event('change', { bubbles: true })); }); }
function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }

test('production local book and page handlers keep a dirty draft and selected book when discard is declined', async () => {
  const view = await mount(production.VaultWorkspace, workspaceProps);
  try {
    await click(button(view.container, '登记礼金'));
    await input(view.container.querySelector('.entry-modal input'), '草稿');
    assert.equal(document.querySelector('[data-modal-dirty="true"]') !== null, true);
    await click(button(view.container, '乙簿'));
    assert.equal(view.container.querySelector('.content-heading h2').textContent, '甲簿');
    for (const label of ['人物与标签', '跨簿比较', '回礼明细', '历史改动', '回收站', '设置']) { await click(button(view.container, label)); assert.ok(view.container.querySelector('.entry-modal'), label); }
  } finally { await view.close(); }
});

test('production metadata editor captures its opened book instead of a later same-vault selection', async () => {
  const writes = []; globalThis.__reviewInvoke = async (command, args) => { if (command === 'edit_book') { writes.push(args); return bookA; } return []; };
  const view = await mount(production.VaultWorkspace, workspaceProps);
  try {
    await click(button(view.container, '编辑礼金簿'));
    await input(view.container.querySelector('[role="dialog"] input'), '修改甲簿');
    // Parent-driven navigation changes are also a defense boundary for an already captured submit.
    await view.rerender({ ...workspaceProps, initialBookId: bookB.id });
    const save = [...view.container.querySelectorAll('button')].find((item) => item.textContent === '保存修改');
    if (save) await click(save);
    assert.equal(writes.some((write) => write.bookId === bookB.id), false);
    if (writes.length) assert.equal(writes[0].bookId, bookA.id);
  } finally { await view.close(); }
});

test('started production write resolves its actual success after scope revocation and still rejects new stale writes', async () => {
  const pending = deferred(); let active = true; const calls = [];
  globalThis.__reviewInvoke = (command, args) => { calls.push([command, args]); return pending.promise; };
  const api = production.createVaultApi('A', () => active); const write = api.setPersonTags('same-person', ['tag-a']); active = false;
  pending.resolve(undefined); await write;
  await assert.rejects(api.setPersonTags('same-person', ['tag-b']), /已切换|已关闭/);
  assert.deepEqual(calls, [['set_person_tags', { personId: 'same-person', tagIds: ['tag-a'], vaultPath: 'A' }]]);
});

test('started production write preserves the actual backend failure after scope revocation', async () => {
  const pending = deferred(); let active = true;
  globalThis.__reviewInvoke = () => pending.promise;
  const write = production.createVaultApi('A', () => active).updateTagColor('same-tag', '#123456'); active = false; pending.reject(Error('磁盘写入失败'));
  await assert.rejects(write, /磁盘写入失败/);
});

test('real ConfirmHistoryClear forwards pending through X backdrop Escape and workspace leave', async () => {
  let closes = 0; const view = await mount(production.ConfirmHistoryClear, { selectedCount: 1, isClearing: true, onClose: () => { closes++; }, onConfirm: noop });
  try {
    assert.equal(document.querySelector('[data-modal-saving="true"]') !== null, true);
    await click(button(view.container, '关闭'));
    await act(async () => view.container.querySelector('.modal-backdrop').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
    await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(closes, 0); assert.equal(production.canLeaveWorkspace(), false);
  } finally { await view.close(); }
});

test('history deletion requires and forwards a valid PIN', async () => {
  const pins = [];
  const view = await mount(production.ConfirmHistoryClear, { selectedCount: 1, isClearing: false, onClose: noop, onConfirm: (pin) => pins.push(pin) });
  try {
    const submit = button(view.container, '删除选中记录');
    assert.equal(submit.disabled, true);
    await input(view.container.querySelector('input[type=password]'), '123456');
    assert.equal(submit.disabled, false);
    await click(submit);
    assert.deepEqual(pins, ['123456']);
  } finally { await view.close(); }
});

test('sidebar selection returns to the chosen ledger even when already selected', async () => {
  const view = await mount(production.VaultWorkspace, workspaceProps);
  try {
    await click(button(view.container, '回礼明细'));
    await click(button(view.container, '甲簿'));
    assert.ok(view.container.querySelector('.content-view.entries'));
    await click(button(view.container, '历史改动'));
    await click(button(view.container, '乙簿'));
    assert.ok(view.container.querySelector('.content-view.entries'));
    assert.match(view.container.querySelector('.content-heading h2').textContent, /乙簿/);
  } finally { await view.close(); }
});

test('double-click return gift traces exact live record and missing history shows notice', async () => {
  const entry = { id: 'entry-1', bookId: bookB.id, personId: 'person-1', personName: '张三', address: null, amountFen: 100, paymentMethod: '现金', receivedAt: '2026-01-01', note: null, returnGift: null, returnGiftAmountFen: 100, returnGiftedAt: '2026-01-01', tags: [], tagNames: [] };
  const gift = { entryId: entry.id, bookId: bookB.id, bookTitle: bookB.title, personId: entry.personId, personName: entry.personName, address: null, returnGiftAmountFen: 100, returnGiftedAt: '2026-01-01', returnGift: null, tags: [] };
  const audit = { id: 'audit-1', entityId: 'deleted', entityType: 'gift_entry', action: 'delete', target: '已删除', bookTitle: '乙簿', description: '删除', changes: [], createdAt: '2026-01-01', reversible: false, reversibleReason: null };
  globalThis.__reviewInvoke = async (command, args) => command === 'list_books' ? [bookA, bookB] : command === 'list_entries' ? (args.bookId === bookB.id ? [entry] : []) : [];
  const client = clientForWorkspace();
  client.setQueryData(['return-gifts', 'A'], [gift]);
  client.setQueryData(['entries', 'A', bookB.id], [entry]);
  client.setQueryData(['audit-logs', 'A'], [audit]);
  const notices = [];
  const view = await mount(production.VaultWorkspace, { ...workspaceProps, initialEntryId: null, onNotice: (message) => notices.push(message) }, client);
  try {
    await click(button(view.container, '回礼明细'));
    await act(async () => { view.container.querySelector('.returnGifts tbody tr').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.ok(view.container.querySelector('#entry-entry-1.search-focused'));
    assert.match(view.container.querySelector('.content-heading h2').textContent, /乙簿/);
    await click(button(view.container, '历史改动'));
    await act(async () => { view.container.querySelector('.history tbody tr').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.ok(notices.some((notice) => notice.includes('找不到来源礼金记录')));
    assert.ok(view.container.querySelector('.content-view.history'));
  } finally { await view.close(); }
});

test('started PeopleView mutation refreshes captured A with same IDs while avoiding old-view callbacks after mounting B', async () => {
  const pending = deferred(); const tags = [{ id: 'same-tag', name: '亲友', color: '#123456' }]; const calls = []; let oldActivity = 0; const errors = [];
  const person = { id: 'same-person', displayName: '张三', address: null, notes: null, tags: [], totalFen: 100, giftCount: 1 };
  globalThis.__reviewInvoke = (command, args) => { calls.push([command, args]); if (command === 'set_person_tags') return pending.promise; if (command === 'list_tags') return Promise.resolve(tags); return Promise.resolve([person]); };
  const client = clientForWorkspace();
  for (const path of ['A', 'B']) { client.setQueryData(['people', path, 'same-book', ''], [person]); client.setQueryData(['tags', path], tags); }
  const props = { vaultPath: 'A', bookId: 'same-book', isAdmin: true, editLocked: false, onError: (error) => errors.push(error), onVaultActivity: () => { oldActivity++; } };
  const view = await mount(production.PeopleView, props, client);
  try {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await click(button(view.container, '调整人物标签')); await click(view.container.querySelector('.person-tag-popover button'));
    await view.rerender({ ...props, vaultPath: 'B', onVaultActivity: noop });
    await act(async () => { pending.resolve(undefined); await pending.promise; await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.deepEqual(calls.find(([command]) => command === 'set_person_tags'), ['set_person_tags', { personId: 'same-person', tagIds: ['same-tag'], vaultPath: 'A' }]);
    assert.equal(client.getQueryState(['people', 'A', 'same-book', '']).isInvalidated, true);
    assert.equal(client.getQueryState(['people', 'B', 'same-book', '']).isInvalidated, false);
    assert.equal(oldActivity, 0); assert.deepEqual(errors, []);
  } finally { await view.close(); }
});

test('completed import exclusion allows only its own form and still blocks another dirty or saving modal', () => {
  const own = document.createElement('div'); own.dataset.modalSaving = 'true'; own.dataset.modalDirty = 'true'; document.body.append(own);
  const other = document.createElement('div'); other.dataset.modalDirty = 'true'; document.body.append(other);
  try {
    assert.equal(production.canLeaveWorkspace(own), false);
    other.dataset.modalSaving = 'true'; window.confirm = () => true;
    assert.equal(production.canLeaveWorkspace(own), false);
    other.remove(); assert.equal(production.canLeaveWorkspace(own), true);
  } finally { own.remove(); other.remove(); window.confirm = () => false; }
});

test('production close-book book-selection and page handlers reject local navigation during saving', async () => {
  const pending = deferred(); const errors = []; globalThis.__reviewInvoke = (command) => command === 'edit_book' ? pending.promise : Promise.resolve([]);
  const view = await mount(production.VaultWorkspace, { ...workspaceProps, onError: (error) => errors.push(error) });
  try {
    await click(button(view.container, '编辑礼金簿')); await click(button(view.container, '保存修改'));
    assert.ok(view.container.querySelector('[data-modal-saving="true"]'));
    await act(async () => button(view.container, '甲簿').focus());
    await click(button(view.container, '关闭礼金簿“甲簿”'));
    assert.equal(view.container.querySelectorAll('[role="dialog"]').length, 1);
    await click(button(view.container, '乙簿')); await click(button(view.container, '人物与标签'));
    assert.equal(view.container.querySelector('.content-heading h2').textContent, '甲簿'); assert.ok(view.container.querySelector('[data-modal-saving="true"]'));
    await act(async () => { pending.reject(Error('测试写入失败')); await pending.promise.catch(noop); });
  } finally { await view.close(); }
});

const focusedEntry = { id: 'focus-entry', bookId: 'same-book', personId: 'same-person', personName: '张三', address: null, amountFen: 100, paymentMethod: '现金', receivedAt: '2026-10-14', note: null, returnGift: null, returnGiftAmountFen: null, returnGiftedAt: null, tags: [], tagNames: [] };
async function searchedWorkspace(hitPath, onOpenSearchVault = noop) {
  const hit = { entry: { ...focusedEntry, bookId: hitPath === 'A' ? 'other-book' : 'same-book' }, vaultPath: hitPath, vaultName: hitPath, bookTitle: '乙簿', matchedFields: ['姓名'] };
  globalThis.__reviewInvoke = async (command) => command === 'search_vault' ? { results: [hit], truncated: false, totalMatches: 1, searchedVaults: [] } : [];
  const client = clientForWorkspace(); client.setQueryData(['entries', 'A', 'same-book'], [focusedEntry]);
  const view = await mount(production.VaultWorkspace, { ...workspaceProps, onOpenSearchVault }, client);
  try {
    await input(view.container.querySelector('#vault-global-search'), '张三');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    assert.ok(view.container.querySelector('.search-result'));
  } catch (error) { await view.close(); throw error; }
  return view;
}

test('production same-vault search selection keeps the draft search and focused entry when discard is declined', async () => {
  const view = await searchedWorkspace('A');
  try {
    await click(button(view.container, '登记礼金')); await input(view.container.querySelector('.entry-modal input'), '草稿');
    await click(view.container.querySelector('.search-result'));
    assert.equal(view.container.querySelector('.content-heading h2').textContent, '甲簿');
    assert.equal(view.container.querySelector('#vault-global-search').value, '张三'); assert.ok(view.container.querySelector('.search-focused')); assert.ok(view.container.querySelector('.entry-modal'));
  } finally { await view.close(); }
});

test('production failed cross-vault search open with same book IDs preserves existing search and focus', async () => {
  const view = await searchedWorkspace('B', async () => { throw Error('目标打开失败'); });
  try {
    await click(view.container.querySelector('.search-result'));
    assert.equal(view.container.querySelector('#vault-global-search').value, '张三'); assert.ok(view.container.querySelector('.search-result')); assert.ok(view.container.querySelector('.search-focused'));
    assert.equal(view.container.querySelector('.content-heading h2').textContent, '甲簿');
  } finally { await view.close(); }
});

test('completed same-vault production import does not navigate past another dirty modal', async () => {
  const mapping = { name: 0, amount: 1, address: null, paymentMethod: null, date: null, note: null, returnGift: null, returnGiftAmount: null, returnGiftedAt: null, tags: null };
  const preview = { fileName: 'fixture.xlsx', sheetName: 'Sheet1', sheetNames: ['Sheet1'], headerRow: 1, suggestedMapping: mapping, currentMapping: mapping, headers: ['姓名', '金额'], rows: [['张三', '1']], validRows: 1, errors: [], rowErrors: [], tagPreview: null };
  globalThis.__reviewInvoke = async (command) => {
    if (command === 'preview_spreadsheet') return preview;
    if (command === 'import_spreadsheets') return { books: [{ book: bookB, imported: 1, createdTags: [], existingTags: [], skippedRows: [] }], imported: 1, skippedRows: [] };
    if (command === 'list_books' || command === 'list_books_for_vault') return [bookA, bookB]; return [];
  };
  const view = await mount(production.VaultWorkspace, { ...workspaceProps, pendingSpreadsheetPaths: ['fixture.xlsx'] });
  const other = await mount(production.Modal, { title: '其他草稿', onClose: noop, children: React.createElement('input', { defaultValue: '' }) });
  try {
    await input(other.container.querySelector('input'), '其他未保存内容');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await act(async () => { const select = view.container.querySelector('.batch-target-book select'); select.value = 'other-book'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await click(button(view.container, '确认导入 1 个文件'));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(view.container.querySelector('.content-heading h2').textContent, '甲簿');
    assert.equal(other.container.querySelector('input').value, '其他未保存内容');
  } finally { await other.close(); await view.close(); }
});
