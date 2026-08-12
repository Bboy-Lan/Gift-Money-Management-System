import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

class MemoryStorage {
  #items = new Map();

  getItem(key) {
    return this.#items.get(key) ?? null;
  }

  setItem(key, value) {
    this.#items.set(key, value);
  }
}

async function loadRecentVaults() {
  const source = await readFile(new URL("../src/lib/recentVaults.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("removing one recent book keeps other books in the same vault", async () => {
  const { forgetRecentVault, readRecentVaults } = await loadRecentVaults();
  const storage = new MemoryStorage();
  storage.setItem("lijin-book.recent-vaults", JSON.stringify([
    { path: "D:/family.giftvault", name: "礼金簿测试数据_B", bookId: "book-b" },
    { path: "D:/family.giftvault", name: "礼金簿测试数据_A", bookId: "book-a" },
    { path: "D:/family.giftvault", name: "礼金测试B", bookId: "book-c" },
    { path: "D:/other.giftvault", name: "其他礼金簿", bookId: "other" },
  ]));

  const next = forgetRecentVault({ path: "D:/family.giftvault", bookId: "book-a" }, storage);

  assert.deepEqual(next.map((item) => item.bookId), ["book-b", "book-c", "other"]);
  assert.deepEqual(readRecentVaults(storage).map((item) => item.bookId), ["book-b", "book-c", "other"]);
});

test("recent book identity distinguishes books sharing a vault path", async () => {
  const { recentVaultIdentity } = await loadRecentVaults();

  assert.notEqual(
    recentVaultIdentity({ path: "D:/family.giftvault", name: "A", bookId: "book-a" }),
    recentVaultIdentity({ path: "D:/family.giftvault", name: "B", bookId: "book-b" }),
  );
});
