import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("tag color input remains visible and keyboard reachable", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const peopleStart = source.indexOf("function PeopleView");
  const peopleEnd = source.indexOf("function PersonRow", peopleStart);
  const peopleView = source.slice(peopleStart, peopleEnd);

  assert.match(peopleView, /className="tag-color-picker inline" type="color"/);
  assert.match(peopleView, /aria-label=\{`修改「\$\{tag\.name\}」的颜色`\}/);
  assert.doesNotMatch(peopleView, /openTagColorPicker|peopleTableRef/);
  assert.match(styles, /\.tag-management-item \.tag-color-picker\.inline:focus-visible/);
  assert.doesNotMatch(styles, /\.tag-management-item \.tag-color-picker\.inline \{[\s\S]*pointer-events: none/);
});
