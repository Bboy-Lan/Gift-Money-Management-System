import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadSessions() {
  const source = await readFile(new URL("../src/lib/openedVaultSessions.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

test("opened vault sessions deduplicate paths, preserve per-vault state, and restore the active vault first", async () => {
  const { rememberOpenedVaultSessions, readOpenedVaultSessions } = await loadSessions();
  const storage = memoryStorage();

  const saved = rememberOpenedVaultSessions([
    { path: "D:/礼金/甲.giftvault", activeBookId: "book-a", activeTab: "people" },
    { path: "d:\\礼金\\甲.giftvault", activeBookId: "book-a-new", activeTab: "history" },
    { path: "D:/礼金/乙.giftvault", activeBookId: "book-b", activeTab: "trash" },
  ], "D:/礼金/乙.giftvault", storage);

  assert.equal(saved.length, 2);
  assert.equal(saved[0].path, "D:/礼金/乙.giftvault");
  assert.deepEqual(readOpenedVaultSessions(storage), saved);
  assert.equal(saved[1].activeBookId, "book-a-new");
  assert.equal(saved[1].activeTab, "history");
});

test("invalid saved session data is ignored without preventing startup", async () => {
  const { readOpenedVaultSessions } = await loadSessions();
  const storage = memoryStorage({
    "lijin-book.opened-vault-sessions": JSON.stringify([
      null,
      { path: "", activeTab: "entries" },
      { path: "D:/有效.giftvault", activeBookId: 12, activeTab: "not-a-tab" },
    ]),
  });

  assert.deepEqual(readOpenedVaultSessions(storage), [
    { path: "D:/有效.giftvault", activeBookId: null, activeTab: "entries" },
  ]);
});
