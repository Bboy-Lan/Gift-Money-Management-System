import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

test("entry return note and date are rendered in the per-row more-info section", () => {
  assert.match(app, /function EntryMoreInfo\([\s\S]*?回礼备注[\s\S]*?回礼登记日期/);
  assert.match(app, /aria-label=\{expanded \? "收起更多信息" : "展开更多信息"\}/);
  assert.doesNotMatch(app, /entry\.returnGift && <small className="entry-extra-meta"/);
  assert.doesNotMatch(app, /entry\.returnGiftedAt && <small className="entry-extra-meta"/);
});

test("giftvault connections do not enable SQLite WAL sidecar files", () => {
  assert.match(rust, /PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 5000;/);
  assert.doesNotMatch(rust, /PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;/);
  assert.match(rust, /else if role == SessionRole::Admin \{[\s\S]*?configure_connection\(&connection\)\?/);
  assert.match(rust, /fn cleanup_sqlite_sidecars\(path: &Path\)[\s\S]*?format!\("\{base\}-wal"\)[\s\S]*?format!\("\{base\}-shm"\)/);
});
