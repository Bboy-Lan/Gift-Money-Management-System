// Kept separate so artifact preservation is exercised without invoking an installer.
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { assertBoundDirectory, releasePaths } from "./release-preparation.mjs";
import { localInstallerName } from "./update-manifest.mjs";

export async function buildInstallers(root, version, run) {
  const { target } = releasePaths(root, version);
  await assertBoundDirectory(root, target);
  const staging = await mkdtemp(join(target, "installers-"));
  try {
    await run(["build", "--no-bundle"]);
    for (const offline of [false, true]) {
      await run(["bundle", "--bundles", "nsis", ...(offline ? ["--config", "src-tauri/tauri.offline.conf.json"] : [])]);
      const source = join(target, "release/bundle/nsis", localInstallerName(version));
      for (const suffix of ["", ".sig"]) {
        await assertBoundDirectory(root, source + suffix);
        await copyFile(source + suffix, join(staging, localInstallerName(version, offline) + suffix), constants.COPYFILE_EXCL);
      }
    }
    return staging;
  } catch (error) {
    await assertBoundDirectory(root, staging);
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
