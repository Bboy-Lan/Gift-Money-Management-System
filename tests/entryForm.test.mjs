import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadTypeScriptModule(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("person name matching trims and normalizes whitespace", async () => {
  const { normalizePersonName, personNamesMatch } = await loadTypeScriptModule("../src/lib/personName.ts");

  assert.equal(normalizePersonName("  刘洋\t"), "刘洋");
  assert.equal(personNamesMatch("刘洋", " 刘洋 "), true);
  assert.equal(personNamesMatch("刘洋", "刘阳"), false);
  assert.equal(personNamesMatch("   ", ""), false);
});

test("new entry tag is visible first without changing the global order", async () => {
  const { getEntryTagSections, mergeEntryTag, ENTRY_VISIBLE_TAG_COUNT } = await loadTypeScriptModule("../src/lib/entryTags.ts");
  const tags = ["a", "b", "c", "d", "e"].map((id) => ({ id, name: id, color: "#000000" }));
  const created = { id: "new", name: "新建", color: "#123456" };
  const merged = mergeEntryTag(tags, created);
  const sections = getEntryTagSections(merged, created.id);

  assert.equal(ENTRY_VISIBLE_TAG_COUNT, 4);
  assert.deepEqual(sections.visible.map((tag) => tag.id), ["new", "a", "b", "c"]);
  assert.deepEqual(sections.overflow.map((tag) => tag.id), ["d", "e"]);
  assert.deepEqual(tags.map((tag) => tag.id), ["a", "b", "c", "d", "e"]);
});

test("editing an entry moves from payment to return amount and then submits from save", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(source, /onKeyDown=\{\(event\) => moveTo\(event, amountRef\)\}/);
  assert.match(source, /onKeyDown=\{\(event\) => moveTo\(event, addressRef\)\}/);
  assert.match(source, /onKeyDown=\{\(event\) => moveTo\(event, paymentRef\)\}/);
  assert.match(source, /onKeyDown=\{\(event\) => moveTo\(event, initial \? returnGiftAmountRef : saveRef\)\}/);
  assert.match(source, /ref=\{returnGiftAmountRef\}/);
  assert.match(source, /onKeyDown=\{\(event\) => moveTo\(event, saveRef\)\}/);
  assert.match(source, /<button ref=\{saveRef\} type="submit"/);
});
