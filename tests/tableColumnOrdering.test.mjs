import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("table column ordering uses the shared long-press drag editor in settings, import, and export", () => {
  assert.match(source, /function ReorderableColumnList/);
  assert.match(source, /长按字段名称后拖动调整顺序/);
  assert.match(source, /const \[columnOrder, setColumnOrder\] = useState<string\[\]>\(readTableColumns\)/);
  assert.match(source, /导出礼金簿/);
  assert.match(source, /导出样例/);
});

test("workspace keeps the update entry and edit lock in the top controls", () => {
  assert.match(source, /className="primary-button compact workspace-update-button"/);
  assert.match(source, /锁定编辑/);
  assert.match(source, /导出库<\/button><button className="secondary-button compact" onClick=\{\(\) => setExportModal\(true\)\}/);
});
