import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadSelectionStore() {
  const source = await readFile(new URL("../src/lib/comparisonVaults.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
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

test("comparison book selection persists an intentional empty selection per opened vault", async () => {
  const { readComparisonBookSelection, rememberComparisonBookSelection } = await loadSelectionStore();
  const storage = memoryStorage();
  const references = [
    { vaultPath: "D:/礼金/甲.giftvault", bookId: "book-a" },
    { vaultPath: "d:\\礼金\\甲.giftvault", bookId: "book-a" },
    { vaultPath: "D:/礼金/乙.giftvault", bookId: "book-b" },
  ];

  rememberComparisonBookSelection("D:/礼金/当前.giftvault", references, storage);
  assert.deepEqual(readComparisonBookSelection("d:\\礼金\\当前.giftvault", storage), [
    references[1],
    references[2],
  ]);

  rememberComparisonBookSelection("D:/礼金/当前.giftvault", [], storage);
  assert.deepEqual(readComparisonBookSelection("D:/礼金/当前.giftvault", storage), []);
  assert.equal(readComparisonBookSelection("D:/礼金/不存在.giftvault", storage), null);
});

test("hidden comparison books persist by current vault and exact book reference", async () => {
  const { readHiddenComparisonBooks, rememberHiddenComparisonBooks } = await loadSelectionStore();
  const storage = memoryStorage();
  const hidden = [
    { vaultPath: "D:/礼金/甲.giftvault", bookId: "book-a" },
    { vaultPath: "d:\\礼金\\甲.giftvault", bookId: "book-a" },
    { vaultPath: "D:/礼金/乙.giftvault", bookId: "book-b" },
  ];

  assert.deepEqual(rememberHiddenComparisonBooks("D:/礼金/当前.giftvault", hidden, storage), [hidden[1], hidden[2]]);
  assert.deepEqual(readHiddenComparisonBooks("d:\\礼金\\当前.giftvault", storage), [hidden[1], hidden[2]]);
  assert.deepEqual(readHiddenComparisonBooks("D:/礼金/其他.giftvault", storage), []);
});
