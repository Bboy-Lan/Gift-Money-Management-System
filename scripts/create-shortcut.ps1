param([string]$Root, [string]$Executable, [string]$Desktop, [string]$Archive)
$ErrorActionPreference = 'Stop'

function Assert-NoReparsePath([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        $item = Get-Item -Force -LiteralPath $current -ErrorAction SilentlyContinue
        if ($null -ne $item) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Linked/reparse paths are not allowed: $current"
            }
        }
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}

function Get-SystemWebViewAvailable {
    $client = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($base in @('HKCU:\Software\Microsoft\EdgeUpdate\Clients', 'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients')) {
        $entry = Get-ItemProperty -LiteralPath "$base\$client" -Name pv -ErrorAction SilentlyContinue
        $version = $null
        if ($entry -and [Version]::TryParse($entry.pv, [ref]$version) -and $version.Major -gt 0) { return $true }
    }
    return $false
}

function Assert-PortableTarget([string]$Root, [string]$Target, [string]$Product) {
    Assert-NoReparsePath $Target
    $prefix = [IO.Path]::GetFullPath((Join-Path $Root 'release')).TrimEnd('\') + '\'
    $full = [IO.Path]::GetFullPath($Target)
    if (!$full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($full) -ne "$Product.exe" -or
        !([IO.Path]::GetFileName([IO.Path]::GetDirectoryName($full)) -match '^\d+\.\d+\.\d+$') -or
        [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($full)) -ne $prefix.TrimEnd('\')) {
        throw 'Refusing installed/outside release shortcut target'
    }
    if (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.Equals($full, [StringComparison]::OrdinalIgnoreCase) }) {
        throw 'Refusing running shortcut target mutation'
    }
    foreach ($registry in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
        foreach ($entry in (Get-ItemProperty $registry -ErrorAction SilentlyContinue)) {
            if ($entry.InstallLocation -and $full.StartsWith($entry.InstallLocation.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing installed shortcut target mutation' }
        }
    }
}

function Invoke-ReleaseShortcut([string]$Root, [string]$Executable, [string]$Desktop, [string]$Archive) {
    $product = [string]::Concat([char]0x793c, [char]0x91d1, [char]0x7c3f)
    $Root = [IO.Path]::GetFullPath($Root)
    if ($Root -ne [IO.Path]::GetPathRoot($Root)) { $Root = $Root.TrimEnd([char[]]@('\', '/')) }
    if (!$Desktop) { $Desktop = [Environment]::GetFolderPath('Desktop') }
    $defaultArchive = Join-Path ([IO.Directory]::GetParent($Root).FullName) ($product + [char]0x5f52 + [char]0x6863 + '/shortcuts')
    if (!$Archive) { $Archive = $defaultArchive }
    $Desktop = [IO.Path]::GetFullPath($Desktop)
    $Archive = [IO.Path]::GetFullPath($Archive)
    foreach ($path in @($Root, $Desktop, $Archive)) { Assert-NoReparsePath $path }
    if (!$Archive.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -and
        !$Archive.Equals([IO.Path]::GetFullPath($defaultArchive), [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive must remain inside release project or the approved sibling archive' }
    Assert-PortableTarget $Root $Executable $product
    if (!(Test-Path -LiteralPath $Executable -PathType Leaf)) { throw 'Release EXE missing' }
    $working = [IO.Path]::GetDirectoryName($Executable)
    Assert-NoReparsePath (Join-Path $working 'webview2-fixed/msedgewebview2.exe')
    if (!(Get-SystemWebViewAvailable) -and !(Test-Path -LiteralPath (Join-Path $working 'webview2-fixed/msedgewebview2.exe') -PathType Leaf)) {
        throw 'WebView2 missing: use offline portable runtime or manually install the offline installer before creating a runnable shortcut.'
    }
    $link = Join-Path $Desktop "$product.lnk"
    Assert-NoReparsePath $link
    $shell = New-Object -ComObject WScript.Shell
    if (Test-Path -LiteralPath $link) {
        if (!(Test-Path -LiteralPath $link -PathType Leaf)) { throw 'Shortcut path is not a file' }
    }
    $temporary = Join-Path $Desktop (([Guid]::NewGuid().ToString()) + '.lnk')
    $backup = $null
    try {
        $shortcut = $shell.CreateShortcut($temporary)
        $shortcut.TargetPath = $Executable
        $shortcut.WorkingDirectory = $working
        $shortcut.Description = $product
        $shortcut.Save()
        if (Test-Path -LiteralPath $link) {
            New-Item -ItemType Directory -Force -Path $Archive | Out-Null
            Assert-NoReparsePath $Archive
            $backup = Join-Path $Archive (([Guid]::NewGuid().ToString()) + '.lnk')
            Move-Item -LiteralPath $link -Destination $backup
        }
        Move-Item -LiteralPath $temporary -Destination $link
        Write-Output "SHORTCUT=$link"
        if ($backup) { Write-Output "RECOVERABLE_PREVIOUS_SHORTCUT=$backup" }
    } catch {
        if ($backup -and !(Test-Path -LiteralPath $link)) { Move-Item -LiteralPath $backup -Destination $link }
        throw
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-ReleaseShortcut -Root $Root -Executable $Executable -Desktop $Desktop -Archive $Archive }
