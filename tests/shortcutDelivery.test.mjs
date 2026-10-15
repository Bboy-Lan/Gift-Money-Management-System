import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const project = resolve(import.meta.dirname, "..");
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function ps(script) {
  return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " + script, "utf16le").toString("base64")], { encoding:"utf8", windowsHide:true });
}
test("shortcut replaces fixed name recoverably and points real COM link to versioned EXE", {skip:process.platform!=="win32"}, async () => {
  const root = await mkdtemp(join(project, "src-tauri/target/shortcut-test-"));
  try {
    const desktop = join(root,"desktop"), archive = join(root,"archive"), exe = join(root,"release/0.4.29/礼金簿.exe");
    await mkdir(desktop); await mkdir(join(root,"release/0.4.29"), {recursive:true}); await writeFile(exe,"fixture");
    const setup = `. ${quote(join(project,"scripts/create-shortcut.ps1"))}; function Get-SystemWebViewAvailable { return $true }; `;
    const invoke = `Invoke-ReleaseShortcut -Root ${quote(root)} -Executable ${quote(exe)} -Desktop ${quote(desktop)} -Archive ${quote(archive)}; `;
    let result = ps(setup + invoke + invoke + `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${quote(join(desktop,"礼金簿.lnk"))}); Write-Output $s.TargetPath; Write-Output $s.WorkingDirectory`);
    assert.equal(result.status,0,result.stderr);
    assert.ok(result.stdout.includes(exe)); assert.ok(result.stdout.includes(join(root,"release/0.4.29")));
    assert.equal((await readdir(archive)).length,1);
    result = ps(setup.replace("return $true", "return $false") + invoke);
    assert.notEqual(result.status,0); assert.match(result.stderr,/WebView2/);
    assert.equal((await readdir(archive)).length,1);
    await mkdir(join(root,"release/0.4.29/webview2-fixed"));
    await writeFile(join(root,"release/0.4.29/webview2-fixed/msedgewebview2.exe"),"fixture runtime");
    result = ps(setup.replace("return $true", "return $false") + invoke);
    assert.equal(result.status,0,result.stderr);
    const external = join(root,"installed.exe"); await writeFile(external,"installed fixture");
    result = ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${quote(join(desktop,"礼金簿.lnk"))}); $s.TargetPath=${quote(external)}; $s.Save(); ` + setup + invoke);
    assert.equal(result.status,0,result.stderr);
    assert.equal((await readdir(archive)).length,3);
    result = ps(setup + `function Get-Process { [pscustomobject]@{Path=${quote(exe)}} }; ` + invoke);
    assert.notEqual(result.status,0); assert.match(result.stderr,/running/i);
    assert.equal((await readdir(archive)).length,3);
    result = ps(setup + `function Get-ItemProperty { [pscustomobject]@{InstallLocation=${quote(join(root,"release/0.4.29"))}} }; ` + invoke);
    assert.notEqual(result.status,0); assert.match(result.stderr,/installed/i);
    assert.equal((await readdir(archive)).length,3);
    const linkedDesktop = join(root,"linked-desktop"); await symlink(desktop, linkedDesktop, "junction");
    result = ps(setup + invoke.replace(quote(desktop),quote(linkedDesktop)));
    assert.notEqual(result.status,0); assert.match(result.stderr,/reparse|link/i);
  } finally { await rm(root,{recursive:true,force:true}); }
});
