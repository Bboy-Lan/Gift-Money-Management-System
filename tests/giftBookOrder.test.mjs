import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadComparisonPreferences() {
  const source = await readFile(new URL("../src/lib/comparisonVaults.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

test("gift-book order stays isolated per vault and appends books created after the saved order", async () => {
  const { rememberGiftBookOrder, readGiftBookOrder, orderGiftBooks } = await loadComparisonPreferences();
  const storage = memoryStorage();

  assert.deepEqual(rememberGiftBookOrder("D:/礼金/婚礼.giftvault", ["book-b", "book-a", "book-b", ""], storage), ["book-b", "book-a"]);
  assert.deepEqual(readGiftBookOrder("d:\\礼金\\婚礼.giftvault", storage), ["book-b", "book-a"]);
  assert.deepEqual(readGiftBookOrder("D:/礼金/寿宴.giftvault", storage), []);
  assert.deepEqual(
    orderGiftBooks([
      { id: "book-a", title: "甲" },
      { id: "book-b", title: "乙" },
      { id: "book-c", title: "丙" },
    ], ["book-b", "book-a"]),
    [
      { id: "book-b", title: "乙" },
      { id: "book-a", title: "甲" },
      { id: "book-c", title: "丙" },
    ],
  );
});

test("sidebar exposes pointer long-press ordering without changing the selected gift book", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const workspace = source.slice(source.indexOf("function VaultWorkspace"), source.indexOf("function EntriesView"));
  const bookRow = workspace.slice(workspace.indexOf("{orderedBooks.map"), workspace.indexOf("{!books.isLoading"));

  assert.match(workspace, /const \[bookOrder, setBookOrder\]/);
  assert.match(bookRow, /onPointerDown/);
  assert.match(bookRow, /onPointerMove/);
  assert.match(bookRow, /onPointerUp/);
  assert.match(bookRow, /data-book-id=/);
  assert.doesNotMatch(bookRow, /onDragStart/);
  assert.doesNotMatch(bookRow, /onDrop/);
  assert.match(workspace, /rememberGiftBookOrder\(vault\.path/);
});
