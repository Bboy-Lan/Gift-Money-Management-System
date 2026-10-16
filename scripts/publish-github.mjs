// Explicit, resumable release upload. Credentials stay in memory in this process.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repository, releaseInstallerName, localInstallerName, verifyUpdateSignature } from "./update-manifest.mjs";
import { assertBoundDirectory } from "./release-preparation.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const directory = join(root, "release", version);
const installer = `礼金簿_${version}_x64-setup.exe`;
const offlineInstaller = localInstallerName(version, true);
const standardOnly = process.argv.includes("--standard-only");
const filenames = [installer, installer + ".sig", ...(standardOnly ? [] : [offlineInstaller, offlineInstaller + ".sig"]), "latest.json", "RELEASE_NOTES.md", "SHA256SUMS.txt", "README.md"];
const assets = [];
for (const name of filenames) {
  const path = join(directory, name);
  await assertBoundDirectory(root, path);
  const bytes = await readFile(path);
  const sourceName = [installer, offlineInstaller].find(candidate => name === candidate || name === candidate + ".sig");
  const uploadName = sourceName ? releaseInstallerName(version, sourceName === offlineInstaller) + name.slice(sourceName.length) : name;
  assets.push({ name: uploadName, path, size: bytes.length, digest: "sha256:" + createHash("sha256").update(bytes).digest("hex") });
}
const manifest = JSON.parse(await readFile(join(directory, "latest.json"), "utf8"));
if (manifest.version !== version || manifest.productId !== "com.codex.lijinbook.remediation") throw new Error("Manifest identity/version mismatch");
const platform = manifest.platforms["lijinbook-remediation-windows-x86_64"];
const channels = JSON.parse(await readFile(join(root, "update-channels.json"), "utf8"));
verifyUpdateSignature(await readFile(join(directory, installer)), platform.signature, channels.publicKey, version);
if (!standardOnly) verifyUpdateSignature(await readFile(join(directory, offlineInstaller)), (await readFile(join(directory, offlineInstaller + ".sig"), "utf8")).trim(), channels.publicKey, version);
if (platform.signature !== (await readFile(join(directory, installer + ".sig"), "utf8")).trim()
  || platform.url !== `https://github.com/${repository}/releases/download/v${version}/${releaseInstallerName(version)}`) throw new Error("Manifest asset mismatch");
function git(args, input) {
  const result = spawnSync("git", args, { cwd: root, input, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error("Git operation failed: " + args[0]);
  return result.stdout.trim();
}
const origin = git(["remote", "get-url", "origin"]);
if (origin !== `https://github.com/${repository}.git`) throw new Error("Unexpected repository remote");
if (!process.argv.includes("--publish")) {
  console.log(JSON.stringify({ mode: "check-only", version, repository, assets: assets.map(({ name, size, digest }) => ({ name, size, digest })) }, null, 2));
  process.exit(0);
}
if (git(["status", "--porcelain"])) throw new Error("Commit verified changes before publishing");
const head = git(["rev-parse", "HEAD"]);
const remote = git(["ls-remote", "origin", "refs/heads/main"]).split(/\s/)[0];
if (head !== remote) throw new Error("Push the verified commit to main before publishing");
const tag = `v${version}`;
const remoteTag = git(["ls-remote", "origin", `refs/tags/${tag}^{}`]).split(/\s/)[0];
if (remoteTag !== head) throw new Error("Push an annotated release tag targeting the verified commit first");
const credentials = git(["-c", "credential.interactive=never", "credential", "fill"], "protocol=https\nhost=github.com\n\n");
const token = credentials.split(/\r?\n/).find(line => line.startsWith("password="))?.slice(9);
if (!token) throw new Error("GitHub credentials unavailable; no token was stored or printed");
const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "lijinbook-release" };
async function request(url, options = {}) {
  if (!["api.github.com", "uploads.github.com"].includes(new URL(url).hostname)) throw new Error("Unexpected GitHub API host");
  const result = await fetch(url, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!result.ok) throw new Error(`GitHub API HTTP ${result.status} (${options.method ?? "GET"})`);
  return result.json();
}
const api = `https://api.github.com/repos/${repository}`;
const releases = await request(`${api}/releases?per_page=100`);
let release = releases.find(item => item.tag_name === tag);
if (release && !release.draft) throw new Error("Release already public; refusing to overwrite");
if (!release) {
  release = await request(`${api}/releases`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    tag_name: tag, target_commitish: head, name: `礼金簿 ${tag}`, body: await readFile(join(directory, "RELEASE_NOTES.md"), "utf8"), draft: true, prerelease: false,
  }) });
}
console.log(`Draft release ${release.id}; uploading ${assets.length} verified assets`);
let uploaded = await request(`${api}/releases/${release.id}/assets?per_page=100`);
for (const asset of assets) {
  const existing = uploaded.find(item => item.name === asset.name);
  if (existing) {
    if (existing.size !== asset.size || existing.digest !== asset.digest) throw new Error("Existing draft asset differs; manual review required: " + asset.name);
    console.log("Verified existing: " + asset.name); continue;
  }
  const url = new URL(release.upload_url.split("{")[0]);
  url.searchParams.set("name", asset.name);
  console.log(`Uploading ${asset.name} (${asset.size} bytes)`);
  const file = await request(url.href, { method: "POST", headers: { "Content-Type": "application/octet-stream", "Content-Length": String((await stat(asset.path)).size) }, body: createReadStream(asset.path), duplex: "half" });
  if (file.name !== asset.name || file.size !== asset.size || file.digest !== asset.digest) throw new Error("Uploaded asset verification failed: " + asset.name);
  console.log("Verified uploaded: " + asset.name);
}
uploaded = await request(`${api}/releases/${release.id}/assets?per_page=100`);
if (!assets.every(asset => uploaded.some(file => file.name === asset.name && file.digest === asset.digest && file.size === asset.size))) throw new Error("Release incomplete; left as draft");
release = await request(`${api}/releases/${release.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft: false, make_latest: "true" }) });
console.log("Published: " + release.html_url);
