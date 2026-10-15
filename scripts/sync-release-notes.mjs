import { readFile, writeFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const changelog = await readFile(new URL("CHANGELOG.md", root), "utf8");
const content = changelog.replace(/^# 更新明细\s*/, "").trim();
await writeFile(new URL("src/releaseNotes.ts", root), `// Generated from CHANGELOG.md by scripts/sync-release-notes.mjs.\nexport const CURRENT_RELEASE_NOTES = ${JSON.stringify(content)};\n`);
