import { createHash, createPublicKey, verify } from "node:crypto";

export const repository = "Bboy-Lan/Gift-Money-Management-System";
export const releaseInstallerName = (version, offline = false) => `Gift-Money-Management-System_${version}_x64${offline ? "-offline" : ""}-setup.exe`;
export const localInstallerName = (version, offline = false) => `礼金簿_${version}_x64${offline ? "-offline" : ""}-setup.exe`;
// Independent release-time check of Minisign's Ed25519 artifact and comment signatures.
// The client continues to use the official Tauri verifier, not this helper.
export function verifyUpdateSignature(bytes, encodedSignature, encodedKey, expectedVersion) {
  const pubLines = Buffer.from(encodedKey, "base64").toString("utf8").split(/\r?\n/);
  const sigLines = Buffer.from(encodedSignature, "base64").toString("utf8").split(/\r?\n/);
  const pub = Buffer.from(pubLines[1] ?? "", "base64");
  const sig = Buffer.from(sigLines[1] ?? "", "base64");
  if (pub.length !== 42 || pub.subarray(0, 2).toString() !== "Ed") throw new Error("Invalid public key");
  if (sig.length !== 74 || !["Ed", "ED"].includes(sig.subarray(0, 2).toString())
    || !pub.subarray(2, 10).equals(sig.subarray(2, 10)) || !sigLines[2]?.startsWith("trusted comment: ")) throw new Error("Invalid signature");
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub.subarray(10)]), type: "spki", format: "der" });
  const data = sig.subarray(0, 2).toString() === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes;
  const comment = sigLines[2].slice(17);
  if (!verify(null, data, key, sig.subarray(10)) || !verify(null, Buffer.concat([sig.subarray(10), Buffer.from(comment)]), key, Buffer.from(sigLines[3] ?? "", "base64"))) throw new Error("Artifact signature verification failed");
  if (expectedVersion && comment.split("\t").find(field => field.startsWith("version:")) !== `version:${expectedVersion}`) throw new Error("Signed version mismatch");
  return comment;
}
export function createUpdateManifest(version, notes, signature, publishedAt = new Date().toISOString()) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Invalid version");
  signature = signature.trim();
  const decoded = Buffer.from(signature, "base64").toString("utf8");
  if (!/^[A-Za-z0-9+/=]+$/.test(signature) || !decoded.startsWith("untrusted comment:") || !decoded.includes("\ntrusted comment:")) throw new Error("Invalid updater signature");
  if (!notes.trim() || !Number.isFinite(Date.parse(publishedAt))) throw new Error("Release notes and date required");
  return { version, notes, pub_date: publishedAt, productId: "com.codex.lijinbook.remediation", channel: "stable",
    platforms: { "lijinbook-remediation-windows-x86_64": {
      url: `https://github.com/${repository}/releases/download/v${version}/${releaseInstallerName(version)}`,
      signature,
    } } };
}
