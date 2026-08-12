import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("spreadsheet mapping and export include return amount, note, return time, and registration date", async () => {
  const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const rustSource = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const modelSource = await readFile(new URL("../src-tauri/src/models.rs", import.meta.url), "utf8");

  assert.match(appSource, /\["returnGiftAmount", "回礼金额"\]/);
  assert.match(appSource, /\["returnGift", "回礼备注"\]/);
  assert.match(appSource, /\["returnGiftedAt", "回礼时间"\]/);
  assert.match(appSource, /returnGiftAmount: mapping\.returnGiftAmount/);
  assert.match(appSource, /returnGiftedAt: mapping\.returnGiftedAt/);
  assert.match(modelSource, /pub return_gift_amount: Option<usize>/);
  assert.match(modelSource, /pub return_gifted_at: Option<usize>/);
  assert.match(rustSource, /return_gift_amount_fen, return_gifted_at/);
  assert.match(rustSource, /"回礼金额"/);
  assert.match(rustSource, /"回礼时间"/);
});
