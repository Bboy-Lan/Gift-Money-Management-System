import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("person archive tags use catalog colors and are removed through the picker", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const personStart = source.lastIndexOf("function PersonRow");
  const personEnd = source.indexOf("function HistoryView", personStart);
  const personRow = source.slice(personStart, personEnd);
  assert.match(personRow, /className="tag-chip" style=\{\{ "--tag-color": tag\.color \}/);
  assert.match(personRow, /className=\{`tag-toggle person-tag-option \$\{selected \? "selected" : ""\}`\}/);
  assert.match(personRow, /aria-pressed=\{selected\}/);
  assert.doesNotMatch(personRow, /person-tag-remove|type="checkbox"/);
  assert.match(styles, /\.tag-chip-remove/);
  assert.doesNotMatch(styles, /\.person-tag-remove/);
});
