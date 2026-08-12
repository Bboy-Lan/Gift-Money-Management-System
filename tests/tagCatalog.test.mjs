import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadTagCatalog() {
  const source = await readFile(new URL("../src/lib/tagCatalog.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("tag catalog colors override stale person tag colors", async () => {
  const { resolveCatalogTags } = await loadTagCatalog();
  const resolved = resolveCatalogTags(
    [{ id: "relative", name: "亲戚", color: "#2563EB" }],
    [{ id: "relative", name: "亲戚", color: "#0f766e" }],
  );

  assert.deepEqual(resolved, [{ id: "relative", name: "亲戚", color: "#0f766e" }]);
});

test("deleted catalog tags do not survive through stale person data", async () => {
  const { resolveCatalogTags } = await loadTagCatalog();
  const resolved = resolveCatalogTags(
    [{ id: "deleted", name: "旧标签", color: "#2563eb" }],
    [],
  );

  assert.deepEqual(resolved, []);
});

test("imported assignments with a recreated tag id resolve by normalized name", async () => {
  const { resolveCatalogTags } = await loadTagCatalog();
  const resolved = resolveCatalogTags(
    [{ id: "imported-old-id", name: "亲友", color: "#2563eb" }],
    [{ id: "catalog-id", name: "亲友", color: "#0f766e" }],
  );

  assert.deepEqual(resolved, [{ id: "catalog-id", name: "亲友", color: "#0f766e" }]);
});
