import { mkdir, access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = join(root, ".local-signing");
await mkdir(directory, { recursive: true });
const key = join(directory, "lijinbook.key");
try { await access(key); }
catch {
  const result = spawnSync(process.execPath, [join(root, "node_modules/@tauri-apps/cli/tauri.js"), "signer", "generate", "--ci", "--password", "", "--write-keys", key], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // The CLI prints key material: it must never be forwarded to logs.
  if (result.status !== 0) throw new Error("Signing key generation failed; no key material logged.");
}
const publicKey = (await readFile(key + ".pub", "utf8")).trim();
console.log(JSON.stringify({ publicKey, privateKeyStoredLocally: true, ignoredByGit: ".local-signing/" }));
