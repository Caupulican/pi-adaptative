# Pi Adaptative Windows installer.
#
# Supported invocation:
#   irm https://github.com/Caupulican/pi-adaptative/releases/latest/download/install.ps1 | iex
#
# This script intentionally has no package-manager or runtime dependency.

$ErrorActionPreference = "Stop"
$script:ManagedMarkerName = ".pi-adaptative-managed"
$script:ManagedMarkerContent = "pi-adaptative-managed-release-v1"

try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Fail([string]$Message) {
    throw "Pi Adaptative installer: $Message"
}

function Test-ReparsePoint($Item) {
    return (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Test-ManagedRelease([string]$Directory) {
    $releaseItem = Get-Item -LiteralPath $Directory -Force -ErrorAction SilentlyContinue
    if ($null -eq $releaseItem -or -not $releaseItem.PSIsContainer -or $releaseItem.LinkType -or (Test-ReparsePoint $releaseItem)) { return $false }
    $marker = Join-Path $Directory $script:ManagedMarkerName
    $markerItem = Get-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    if ($null -eq $markerItem -or $markerItem.PSIsContainer -or $markerItem.LinkType -or (Test-ReparsePoint $markerItem)) { return $false }
    return ((Get-Content -LiteralPath $marker -Raw).Trim() -eq $script:ManagedMarkerContent)
}

function Ensure-ManagedRelease([string]$Directory) {
    $releaseItem = Get-Item -LiteralPath $Directory -Force -ErrorAction SilentlyContinue
    if ($null -eq $releaseItem -or -not $releaseItem.PSIsContainer -or $releaseItem.LinkType -or (Test-ReparsePoint $releaseItem)) {
        Fail "refusing to trust an incomplete managed release '$Directory'."
    }
    $marker = Join-Path $Directory $script:ManagedMarkerName
    $markerItem = Get-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    if ($null -ne $markerItem) {
        if ($markerItem.PSIsContainer -or $markerItem.LinkType -or (Test-ReparsePoint $markerItem) -or (Get-Content -LiteralPath $marker -Raw).Trim() -ne $script:ManagedMarkerContent) {
            Fail "refusing an invalid release ownership marker '$marker'."
        }
        return
    }
    [System.IO.File]::WriteAllText($marker, "$script:ManagedMarkerContent`r`n", [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::SetAttributes($marker, [System.IO.File]::GetAttributes($marker) -bor [System.IO.FileAttributes]::Hidden)
}

function New-ManagedMarker([string]$Directory) {
    $marker = Join-Path $Directory $script:ManagedMarkerName
    if (Test-Path -LiteralPath $marker) { Fail "release archive contains the reserved ownership marker." }
    [System.IO.File]::WriteAllText($marker, "$script:ManagedMarkerContent`r`n", [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::SetAttributes($marker, [System.IO.File]::GetAttributes($marker) -bor [System.IO.FileAttributes]::Hidden)
}

function Get-InstallerPath([string]$Value, [string]$Name) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        Fail "$Name cannot be empty."
    }
    if ($Value.IndexOf([char]34) -ge 0 -or $Value.IndexOf([char]0) -ge 0) {
        Fail "$Name contains an unsupported character."
    }
    $full = [System.IO.Path]::GetFullPath($Value)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ([string]::IsNullOrWhiteSpace($root) -or $full.TrimEnd([char]92, [char]47) -eq $root.TrimEnd([char]92, [char]47)) {
        Fail "$Name must not be a filesystem root."
    }
    if ($full -match '(?i)^[A-Z]:\\Users\\[^\\]+$' -or $full -match '(?i)^[A-Z]:\\Windows$') {
        Fail "$Name must not be a profile or Windows directory."
    }
    return $full.TrimEnd([char]92, [char]47)
}

function Get-Architecture {
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrWhiteSpace($architecture)) {
        $architecture = $env:PROCESSOR_ARCHITECTURE
    }
    if ([string]::IsNullOrWhiteSpace($architecture)) { $architecture = "unknown" }
    switch ($architecture.ToUpperInvariant()) {
        "AMD64" { return "x64" }
        "X86_64" { return "x64" }
        "ARM64" { return "arm64" }
        "AARCH64" { return "arm64" }
        default { Fail "unsupported Windows architecture '$architecture'; use x64 or arm64." }
    }
}

function Assert-WindowsHost {
    # PlatformID.Win32NT is available in Windows PowerShell 5.1 and pwsh.
    if ($env:PI_INSTALL_TEST_MODE -eq "1" -and $env:PI_INSTALL_TEST_ASSUME_WINDOWS -eq "1") { return }
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        Fail "Windows PowerShell is required; Linux, macOS, Git Bash, and WSL are unsupported."
    }
    if (-not [string]::IsNullOrWhiteSpace($env:WSL_INTEROP) -or -not [string]::IsNullOrWhiteSpace($env:MSYSTEM)) {
        Fail "run the native Windows PowerShell installer, not from WSL or Git Bash."
    }
}

function Assert-Version([string]$Version) {
    if ($Version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
        Fail "version '$Version' is invalid; expected vMAJOR.MINOR.PATCH."
    }
}

function Get-ReleaseVersion {
    if (-not [string]::IsNullOrWhiteSpace($env:PI_VERSION)) {
        Assert-Version $env:PI_VERSION
        return $env:PI_VERSION
    }

    # Resolve latest exactly once. Every subsequent request uses this validated tag.
    $release = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/Caupulican/pi-adaptative/releases/latest" -Headers @{ Accept = "application/vnd.github+json" }
    $version = [string]$release.tag_name
    Assert-Version $version
    return $version
}

function Get-ReleaseBaseUrl([string]$Version) {
    # The test-only override is deliberately opt-in and cannot affect normal installs.
    $base = "https://github.com/Caupulican/pi-adaptative/releases/download/$Version"
    if ($env:PI_INSTALL_TEST_MODE -eq "1" -and -not [string]::IsNullOrWhiteSpace($env:PI_INSTALL_TEST_BASE_URL)) {
        $base = [System.IO.Path]::GetFullPath($env:PI_INSTALL_TEST_BASE_URL)
        if (-not (Test-Path -LiteralPath $base -PathType Container)) {
            Fail "PI_INSTALL_TEST_BASE_URL must be an existing local directory."
        }
    } elseif ($env:PI_INSTALL_TEST_MODE -eq "1") {
        Fail "PI_INSTALL_TEST_BASE_URL is required in test mode."
    }
    return $base
}

function Save-Download([string]$Uri, [string]$Destination) {
    if ($env:PI_INSTALL_TEST_MODE -eq "1") {
        $source = Join-Path $env:PI_INSTALL_TEST_BASE_URL ([System.IO.Path]::GetFileName($Uri))
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            Fail "test release asset is missing '$source'."
        }
        Copy-Item -LiteralPath $source -Destination $Destination
        return
    }
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
    if (-not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
        Fail "download did not produce '$Destination'."
    }
}

function Get-SelectedChecksum([string]$ChecksumPath, [string]$AssetName) {
    $valid = @()
    $candidateCount = 0
    $assetPattern = [regex]::Escape($AssetName)
    foreach ($line in Get-Content -LiteralPath $ChecksumPath) {
        if ($line -match ('(?:\s|\*)' + $assetPattern + '\s*$')) {
            $candidateCount++
            if ($line -match '^\s*([0-9A-Fa-f]{64})\s+\*?([^\s]+)\s*$' -and $Matches[2] -eq $AssetName) {
                $valid += $Matches[1].ToLowerInvariant()
            }
        }
    }
    if ($candidateCount -ne 1 -or $valid.Count -ne 1) {
        Fail "SHA256SUMS must contain exactly one valid checksum entry for $AssetName."
    }
    return $valid[0]
}

function Assert-Checksum([string]$Path, [string]$Expected) {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha256.ComputeHash($stream)
        $actual = ([System.BitConverter]::ToString($hash)).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
    if ($actual -ne $Expected) {
        Fail "checksum verification failed for '$Path'."
    }
}

function Assert-ZipEntries([string]$ArchivePath) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $hasExecutable = $false
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace([char]92, [char]47)
            if ([string]::IsNullOrWhiteSpace($name) -or $name.EndsWith('/')) { continue }
            if ($name.StartsWith('/') -or $name -match '^[A-Za-z]:/' -or $name.Split('/') -contains '..') {
                Fail "release archive contains an unsafe path '$($entry.FullName)'."
            }
            if ($name -eq 'pi.exe') { $hasExecutable = $true }
        }
        if (-not $hasExecutable) {
            Fail "release archive does not contain the expected root-level pi.exe."
        }
    } finally {
        $zip.Dispose()
    }
}

function Invoke-VersionSmoke([string]$Executable, [string]$Version) {
    $expected = $Version.Substring(1)
    if ($env:PI_INSTALL_TEST_MODE -eq "1" -and $null -ne $env:PI_INSTALL_TEST_VERSION_OUTPUT) {
        $output = $env:PI_INSTALL_TEST_VERSION_OUTPUT.Trim()
        $exitCode = 0
    } else {
        $output = (& $Executable --version 2>&1 | Out-String).Trim()
        $exitCode = $LASTEXITCODE
    }
    if ($exitCode -ne 0 -or $output -ne $expected) {
        Fail "staged pi.exe --version did not report exactly $expected."
    }
}

function Set-AtomicTextFile([string]$Path, [string]$Content) {
    $temporary = "$Path.tmp-$([Guid]::NewGuid().ToString('N'))"
    [System.IO.File]::WriteAllText($temporary, $Content, [System.Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $backup = "$Path.backup-$([Guid]::NewGuid().ToString('N'))"
        [System.IO.File]::Replace($temporary, $Path, $backup)
        if (Test-Path -LiteralPath $backup -PathType Leaf) { Remove-Item -LiteralPath $backup -Force }
    } else {
        Move-Item -LiteralPath $temporary -Destination $Path
    }
}

function Assert-OwnedPointer([string]$Pointer) {
    if (-not (Test-Path -LiteralPath $Pointer)) { return }
    $item = Get-Item -LiteralPath $Pointer -Force
    if ($item.PSIsContainer -or $item.LinkType) {
        Fail "refusing to overwrite unsafe current-version pointer '$Pointer'."
    }
}

function Assert-OwnedLauncher([string]$Launcher) {
    if (-not (Test-Path -LiteralPath $Launcher)) { return }
    $item = Get-Item -LiteralPath $Launcher -Force
    if ($item.PSIsContainer -or $item.LinkType -or (Get-Content -LiteralPath $Launcher -Raw) -notmatch 'PI_ADAPTATIVE_MANAGED_LAUNCHER') {
        Fail "refusing to overwrite unowned '$Launcher'."
    }
}

function Ensure-UserPath([string]$BinDir) {
    if ($env:PI_INSTALL_TEST_MODE -eq "1" -and $env:PI_INSTALL_TEST_SKIP_PATH -eq "1") { return $true }
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @()
    if (-not [string]::IsNullOrWhiteSpace($userPath)) { $parts = $userPath -split ';' }
    foreach ($part in $parts) {
        if ([string]::Equals($part.TrimEnd([char]92), $BinDir.TrimEnd([char]92), [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    try {
        $newPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $BinDir } else { "$userPath;$BinDir" }
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        return $true
    } catch {
        Write-Warning "Could not update the user PATH automatically. Add '$BinDir' to your user PATH."
        return $false
    }
}

function New-Launcher([string]$Launcher, [string]$InstallRoot) {
    Assert-OwnedLauncher $Launcher
    $safeRoot = $InstallRoot.Replace('%', '%%')
    $content = @"
@echo off
REM PI_ADAPTATIVE_MANAGED_LAUNCHER
setlocal
set "PI_ADAPTATIVE_ROOT=$safeRoot"
set "PI_ADAPTATIVE_VERSION="
for /f "usebackq delims=" %%V in ("%PI_ADAPTATIVE_ROOT%\current.version") do set "PI_ADAPTATIVE_VERSION=%%V"
if not defined PI_ADAPTATIVE_VERSION (
  echo Pi Adaptative is not activated. 1>&2
  exit /b 1
)
if not exist "%PI_ADAPTATIVE_ROOT%\releases\%PI_ADAPTATIVE_VERSION%\pi.exe" (
  echo Pi Adaptative release is incomplete. 1>&2
  exit /b 1
)
"%PI_ADAPTATIVE_ROOT%\releases\%PI_ADAPTATIVE_VERSION%\pi.exe" %*
exit /b %ERRORLEVEL%
"@
    $content = $content.TrimStart("`r", "`n").Replace("`n", "`r`n")
    Set-AtomicTextFile $Launcher $content
}

function Get-CurrentVersion([string]$Pointer) {
    if (-not (Test-Path -LiteralPath $Pointer -PathType Leaf)) { return $null }
    $value = (Get-Content -LiteralPath $Pointer -Raw).Trim()
    if ($value -match '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { return $value }
    return $null
}

function Prune-Releases([string]$ReleaseDir, [string]$CurrentVersion, [string]$PreviousVersion) {
    $releaseRoot = [System.IO.Path]::GetFullPath($ReleaseDir).TrimEnd([char]92, [char]47) + [char]92
    foreach ($item in Get-ChildItem -LiteralPath $ReleaseDir -Directory) {
        if ($item.Name -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { continue }
        $candidate = [System.IO.Path]::GetFullPath($item.FullName)
        if (-not $candidate.StartsWith($releaseRoot, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if ($item.LinkType -or (Test-ReparsePoint $item)) { continue }
        if ($item.Name -ne $CurrentVersion -and $item.Name -ne $PreviousVersion -and (Test-ManagedRelease $candidate)) {
            Remove-Item -LiteralPath $candidate -Recurse -Force
        }
    }
}

function Install-PiAdaptative {
    Assert-WindowsHost
    $architecture = Get-Architecture
    $version = Get-ReleaseVersion
    $assetName = "pi-windows-$architecture.zip"
    $baseUrl = Get-ReleaseBaseUrl $version
    $localAppData = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($localAppData)) { $localAppData = Join-Path $env:USERPROFILE "AppData\Local" }
    $installRootValue = if ([string]::IsNullOrWhiteSpace($env:PI_INSTALL_DIR)) { Join-Path $localAppData "PiAdaptative" } else { $env:PI_INSTALL_DIR }
    $installRoot = Get-InstallerPath $installRootValue "PI_INSTALL_DIR"
    $binDirValue = if ([string]::IsNullOrWhiteSpace($env:PI_BIN_DIR)) { Join-Path $installRoot "bin" } else { $env:PI_BIN_DIR }
    $binDir = Get-InstallerPath $binDirValue "PI_BIN_DIR"
    $launcher = Join-Path $binDir "pi.cmd"
    $releaseDir = Join-Path $installRoot "releases"
    $targetDir = Join-Path $releaseDir $version
    $pointer = Join-Path $installRoot "current.version"
    $parent = Split-Path -Parent $installRoot
    New-Item -ItemType Directory -Force -Path $parent | Out-Null

    $mutex = New-Object System.Threading.Mutex($false, "Local\PiAdaptativeInstaller")
    $locked = $false
    try {
        if (-not $mutex.WaitOne(0)) { Fail "another installation is already running." }
        $locked = $true
        New-Item -ItemType Directory -Force -Path $releaseDir, $binDir | Out-Null
        Assert-OwnedPointer $pointer
        Assert-OwnedLauncher $launcher
        $previousVersion = Get-CurrentVersion $pointer
        $staging = Join-Path $releaseDir (".staging-" + [Guid]::NewGuid().ToString('N'))
        $downloadDir = Join-Path $parent (".pi-download-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $staging, $downloadDir | Out-Null
        try {
            $checksumPath = Join-Path $downloadDir "SHA256SUMS"
            $archivePath = Join-Path $downloadDir $assetName
            Save-Download "$baseUrl/SHA256SUMS" $checksumPath
            Save-Download "$baseUrl/$assetName" $archivePath
            $checksum = Get-SelectedChecksum $checksumPath $assetName
            Assert-Checksum $archivePath $checksum
            Assert-ZipEntries $archivePath
            Expand-Archive -LiteralPath $archivePath -DestinationPath $staging -Force
            $stagedExecutable = Join-Path $staging "pi.exe"
            if (-not (Test-Path -LiteralPath $stagedExecutable -PathType Leaf)) { Fail "release archive extracted without root-level pi.exe." }
            Invoke-VersionSmoke $stagedExecutable $version

            $existingTarget = Get-Item -LiteralPath $targetDir -Force -ErrorAction SilentlyContinue
            if ($null -ne $existingTarget) {
                if (-not $existingTarget.PSIsContainer -or $existingTarget.LinkType -or (Test-ReparsePoint $existingTarget)) { Fail "refusing to replace an unsafe existing release '$targetDir'." }
                if ((Get-CurrentVersion $pointer) -ne $version) { Fail "refusing to replace an unowned existing release '$targetDir'." }
                if (-not (Test-Path -LiteralPath (Join-Path $targetDir "pi.exe") -PathType Leaf)) { Fail "existing release directory is incomplete." }
                Invoke-VersionSmoke (Join-Path $targetDir "pi.exe") $version
                Ensure-ManagedRelease $targetDir
                Remove-Item -LiteralPath $staging -Recurse -Force
            } else {
                New-ManagedMarker $staging
                Move-Item -LiteralPath $staging -Destination $targetDir
            }
            New-Launcher $launcher $installRoot
            Set-AtomicTextFile $pointer "$version`r`n"
            try { Prune-Releases $releaseDir $version $previousVersion } catch { Write-Warning "Could not prune old Pi Adaptative releases: $($_.Exception.Message)" }
            [void](Ensure-UserPath $binDir)
            Write-Output "Pi Adaptative $version installed for Windows $architecture."
            Write-Output "Open a new PowerShell window, then run: pi --version"
        } finally {
            if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
            if (Test-Path -LiteralPath $downloadDir) { Remove-Item -LiteralPath $downloadDir -Recurse -Force }
        }
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

Install-PiAdaptative
