import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadWorkspaceLaunch() {
  const source = await readFile(new URL("../src/lib/workspaceLaunch.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("failed recent-vault opening keeps the record and prevents success callbacks", async () => {
  const { openRecentVault } = await loadWorkspaceLaunch();
  const recent = { path: "D:/family.giftvault", name: "家庭礼金库", bookId: "book-1" };
  const opened = await openRecentVault(recent, async () => {
    throw new Error("找不到礼金库文件");
  });

  assert.deepEqual(opened, {
    status: "failed",
    recent,
    error: "找不到礼金库文件",
  });
  assert.equal(recent.bookId, "book-1");
});

test("stale recent book ids fall back to the first book in the opened vault", async () => {
  const { resolveInitialBookId } = await loadWorkspaceLaunch();

  assert.equal(resolveInitialBookId("missing-book", [{ id: "book-1" }, { id: "book-2" }]), "book-1");
  assert.equal(resolveInitialBookId("book-2", [{ id: "book-1" }, { id: "book-2" }]), "book-2");
  assert.equal(resolveInitialBookId("missing-book", []), null);
});

test("startup recovery skips a failed older record and opens the next valid record", async () => {
  const { openRecentVaults } = await loadWorkspaceLaunch();
  const first = { path: "D:/old/family.giftvault", name: "旧路径", bookId: "old-book" };
  const second = { path: "D:/current/family.giftvault", name: "当前礼金库", bookId: "current-book" };
  const attempted = [];
  const opened = await openRecentVaults([first, second], async (path) => {
    attempted.push(path);
    if (path === first.path) throw new Error("找不到礼金库文件");
    return { vault: { path, name: second.name, bookCount: 1 }, role: "viewer" };
  });

  assert.equal(opened.status, "opened");
  assert.equal(opened.recent, second);
  assert.deepEqual(attempted, [first.path, second.path]);
});

test("admin entry with no recent records opens the workspace start page", async () => {
  const { openRecentVaults, resolveWorkspaceLaunchTarget } = await loadWorkspaceLaunch();
  const opened = await openRecentVaults([], async () => {
    throw new Error("不应尝试打开不存在的记录");
  });

  assert.equal(opened.status, "none");
  assert.equal(resolveWorkspaceLaunchTarget(opened.status), "workspace-start");
  assert.equal(resolveWorkspaceLaunchTarget("failed"), "start-page");
  assert.equal(resolveWorkspaceLaunchTarget("opened"), "vault");
});
