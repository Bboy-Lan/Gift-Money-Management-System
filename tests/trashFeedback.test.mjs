import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("recycle-bin restore and clearing use the shared lower-right completion notice", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const trashView = source.slice(source.indexOf("function TrashView"), source.indexOf("function EmptyBookState"));

  assert.match(trashView, /onNotice: \(message: string\) => void/);
  assert.match(trashView, /onNotice\(`恢复成功：\$\{trashTargets\(items\)\}`\)/);
  assert.match(trashView, /onNotice\(`恢复失败：\$\{trashTargets\(items\)}，\$\{String\(err\)\.replace/);
  assert.match(trashView, /onNotice\("清空回收站成功"\)/);
  assert.match(trashView, /onNotice\(`清空回收站失败：\$\{String\(err\)\.replace/);
});

test("recycle-bin permanent clear confirms directly with Enter after a valid PIN", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const helperAndDialog = source.slice(source.indexOf("function submitTrashEmptyPin"), source.indexOf("function Modal"));
  const trashDialog = helperAndDialog.slice(helperAndDialog.indexOf("function ConfirmTrashEmpty"));

  assert.match(helperAndDialog, /function submitTrashEmptyPin/);
  assert.match(trashDialog, /onKeyDown=\{\(event\) => submitTrashEmptyPin\(event, valid, isClearing, pin, onConfirm\)\}/);
  assert.match(trashDialog, /onConfirm\(pin\)/);
  assert.doesNotMatch(trashDialog, /focusPinConfirmation/);
});
