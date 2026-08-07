<#
.SYNOPSIS
Collect a native Windows Pi incident into one bounded ZIP archive.

.DESCRIPTION
Collects the latest human Pi session, recovery/orchestration state, optional command output,
recent TUI logs, environment/runtime fingerprints, and relevant Windows event records. Credential
and configuration stores are never scanned or copied. Review the archive before sharing it.

.PARAMETER AgentDir
Pi agent directory. Defaults to the configured environment value or %USERPROFILE%\.pi\agent.

.PARAMETER SessionDir
Session directory override. Defaults to <AgentDir>\sessions.

.PARAMETER Session
Exact affected session JSONL instead of the latest human session.

.PARAMETER CommandLog
Additional command log to include explicitly.

.PARAMETER OutputDir
ZIP destination directory. Defaults to the directory containing this collector.

.PARAMETER EventHours
Fallback number of recent hours to inspect when the selected session has no usable timestamps.

.PARAMETER EventPaddingMinutes
Minutes to include before and after the selected session when correlating state and Windows event records.

.EXAMPLE
.\collect-pi-incident.ps1

.EXAMPLE
.\collect-pi-incident.ps1 -Session C:\Users\me\.pi\agent\sessions\project\session.jsonl -CommandLog C:\Temp\pi-console.log
#>

[CmdletBinding()]
param(
    [string]$AgentDir,
    [string]$SessionDir,
    [string]$Session,
    [string]$CommandLog,
    [string]$OutputDir,
    [ValidateRange(1, 168)]
    [int]$EventHours = 24,
    [ValidateRange(0, 1440)]
    [int]$EventPaddingMinutes = 15
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
$warnings = New-Object "System.Collections.Generic.List[string]"
$collectedSources = New-Object "System.Collections.Generic.List[string]"
$collectedDestinations = New-Object "System.Collections.Generic.List[string]"

function Get-FirstEnvironmentValue {
    param([string[]]$Names)

    foreach ($name in $Names) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value
        }
    }
    return $null
}

function Resolve-ExistingPath {
    param(
        [string]$Path,
        [string]$Description,
        [string]$PathType
    )

    if (-not (Test-Path -LiteralPath $Path -PathType $PathType)) {
        throw "$Description was not found: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).ProviderPath
}

function Write-Utf8Lines {
    param(
        [string]$Path,
        [string[]]$Lines
    )

    [IO.File]::WriteAllLines($Path, $Lines, $script:utf8WithoutBom)
}

function Get-FileSha256 {
    param([string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $digestBytes = $sha256.ComputeHash($stream)
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
    return ([BitConverter]::ToString($digestBytes)).Replace("-", "").ToLowerInvariant()
}

function Initialize-EvidenceCopy {
    param(
        [string]$Source,
        [string]$Destination,
        [string]$PathType
    )

    if (-not (Test-Path -LiteralPath $Source -PathType $PathType)) {
        return $null
    }
    $resolvedSource = (Resolve-Path -LiteralPath $Source).ProviderPath
    $target = Join-Path $script:staging $Destination
    [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target))
    return [pscustomobject]@{
        Source = $resolvedSource
        Target = $target
    }
}

function Copy-EvidenceFile {
    param(
        [string]$Source,
        [string]$Destination
    )

    $copy = Initialize-EvidenceCopy -Source $Source -Destination $Destination -PathType Leaf
    if ($null -eq $copy) {
        return $false
    }
    Copy-Item -LiteralPath $copy.Source -Destination $copy.Target -Force
    [void]$script:collectedSources.Add($copy.Source)
    [void]$script:collectedDestinations.Add($Destination.Replace("\", "/"))
    return $true
}

function Copy-EvidenceDirectory {
    param(
        [string]$Source,
        [string]$Destination
    )

    $copy = Initialize-EvidenceCopy -Source $Source -Destination $Destination -PathType Container
    if ($null -eq $copy) {
        return $false
    }
    Copy-Item -LiteralPath $copy.Source -Destination $copy.Target -Recurse -Force
    [void]$script:collectedSources.Add($copy.Source)
    [void]$script:collectedDestinations.Add(($Destination.TrimEnd("\", "/") + "/"))
    return $true
}

function Get-SessionHeader {
    param([string]$Path)

    try {
        $line = Get-Content -LiteralPath $Path -TotalCount 1 -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($line)) {
            return $null
        }
        $header = $line | ConvertFrom-Json -ErrorAction Stop
        $typeProperty = $header.PSObject.Properties["type"]
        if ($null -eq $typeProperty -or [string]$typeProperty.Value -ne "session") {
            return $null
        }
        return $header
    }
    catch {
        return $null
    }
}

function Get-LatestHumanSession {
    param([string]$Root)

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return $null
    }

    $candidates = New-Object "System.Collections.Generic.List[System.IO.FileInfo]"
    foreach ($candidate in @(Get-ChildItem -LiteralPath $Root -File -Filter "*.jsonl" -ErrorAction SilentlyContinue)) {
        [void]$candidates.Add($candidate)
    }
    foreach ($directory in @(Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue)) {
        foreach ($candidate in @(Get-ChildItem -LiteralPath $directory.FullName -File -Filter "*.jsonl" -ErrorAction SilentlyContinue)) {
            [void]$candidates.Add($candidate)
        }
    }

    foreach ($candidate in @($candidates | Sort-Object LastWriteTimeUtc -Descending)) {
        $header = Get-SessionHeader -Path $candidate.FullName
        if ($null -eq $header) {
            continue
        }
        $idProperty = $header.PSObject.Properties["id"]
        if ($null -ne $idProperty -and ([string]$idProperty.Value).StartsWith("auto-learn-", [StringComparison]::Ordinal)) {
            continue
        }
        return $candidate.FullName
    }
    return $null
}

function Get-SessionId {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }
    $header = Get-SessionHeader -Path $Path
    if ($null -eq $header) {
        return ""
    }
    $idProperty = $header.PSObject.Properties["id"]
    if ($null -eq $idProperty) {
        return ""
    }
    $id = [string]$idProperty.Value
    if ($id -notmatch "^[A-Za-z0-9._-]+$") {
        return ""
    }
    return $id
}

function ConvertTo-UtcTimestamp {
    param([object]$Value)

    if ($null -eq $Value) {
        return $null
    }
    $parsed = [DateTimeOffset]::MinValue
    $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    if (-not [DateTimeOffset]::TryParse(
        [string]$Value,
        [Globalization.CultureInfo]::InvariantCulture,
        $styles,
        [ref]$parsed
    )) {
        return $null
    }
    return $parsed.ToUniversalTime()
}

function Get-SessionTimeRange {
    param(
        [string]$Path,
        [int]$FallbackHours,
        [int]$PaddingMinutes
    )

    $startUtc = $null
    $endUtc = $null
    if (-not [string]::IsNullOrWhiteSpace($Path) -and (Test-Path -LiteralPath $Path -PathType Leaf)) {
        $reader = [IO.File]::OpenText($Path)
        try {
            while ($null -ne ($line = $reader.ReadLine())) {
                if ([string]::IsNullOrWhiteSpace($line)) {
                    continue
                }
                try {
                    $record = $line | ConvertFrom-Json -ErrorAction Stop
                    $timestampProperty = $record.PSObject.Properties["timestamp"]
                    if ($null -eq $timestampProperty) {
                        continue
                    }
                    $timestampUtc = ConvertTo-UtcTimestamp -Value $timestampProperty.Value
                    if ($null -eq $timestampUtc) {
                        continue
                    }
                    if ($null -eq $startUtc -or $timestampUtc -lt $startUtc) {
                        $startUtc = $timestampUtc
                    }
                    if ($null -eq $endUtc -or $timestampUtc -gt $endUtc) {
                        $endUtc = $timestampUtc
                    }
                }
                catch {
                    continue
                }
            }
        }
        finally {
            $reader.Dispose()
        }
    }

    if ($null -eq $startUtc -or $null -eq $endUtc) {
        $endUtc = [DateTimeOffset]::UtcNow
        $startUtc = $endUtc.AddHours(-$FallbackHours)
        return [pscustomobject]@{
            StartUtc = $startUtc
            EndUtc = $endUtc
            Source = "collection-time fallback"
        }
    }

    return [pscustomobject]@{
        StartUtc = $startUtc.AddMinutes(-$PaddingMinutes)
        EndUtc = $endUtc.AddMinutes($PaddingMinutes)
        Source = "selected session timestamps"
    }
}

function Copy-CorrelatedStateLog {
    param(
        [string]$Source,
        [string]$Destination,
        [string]$SessionId,
        [object]$IncidentWindow,
        [bool]$MatchSessionId
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        return -1
    }

    $resolvedSource = (Resolve-Path -LiteralPath $Source).ProviderPath
    $target = Join-Path $script:staging $Destination
    [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target))
    $matchedCount = 0
    $reader = [IO.File]::OpenText($resolvedSource)
    $writer = New-Object IO.StreamWriter($target, $false, $script:utf8WithoutBom)
    try {
        while ($null -ne ($line = $reader.ReadLine())) {
            if ([string]::IsNullOrWhiteSpace($line)) {
                continue
            }
            try {
                $record = $line | ConvertFrom-Json -ErrorAction Stop
            }
            catch {
                continue
            }

            $matches = $false
            $recordSessionId = ""
            $sessionIdProperty = $record.PSObject.Properties["sessionId"]
            if ($null -ne $sessionIdProperty) {
                $recordSessionId = [string]$sessionIdProperty.Value
            }
            if ($MatchSessionId -and -not [string]::IsNullOrWhiteSpace($recordSessionId)) {
                $matches = -not [string]::IsNullOrWhiteSpace($SessionId) -and $recordSessionId -eq $SessionId
            }
            else {
                $timestampProperty = $record.PSObject.Properties["ts"]
                if ($null -ne $timestampProperty) {
                    $timestampUtc = ConvertTo-UtcTimestamp -Value $timestampProperty.Value
                    $matches = $null -ne $timestampUtc -and
                        $timestampUtc -ge $IncidentWindow.StartUtc -and
                        $timestampUtc -le $IncidentWindow.EndUtc
                }
            }

            if ($matches) {
                $writer.WriteLine($line)
                $matchedCount += 1
            }
        }
    }
    finally {
        $reader.Dispose()
        $writer.Dispose()
    }

    if ($matchedCount -eq 0) {
        Remove-Item -LiteralPath $target -Force
        return 0
    }
    [void]$script:collectedSources.Add($resolvedSource)
    [void]$script:collectedDestinations.Add($Destination.Replace("\", "/"))
    return $matchedCount
}

function Get-OrchestrationSessionKey {
    param([string]$SessionId)

    $readableLength = [Math]::Min(80, $SessionId.Length)
    $readable = $SessionId.Substring(0, $readableLength)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $digestBytes = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($SessionId))
    }
    finally {
        $sha256.Dispose()
    }
    $digest = ([BitConverter]::ToString($digestBytes)).Replace("-", "").ToLowerInvariant().Substring(0, 16)
    return "$readable-$digest"
}

function Add-CommandDiagnostic {
    param(
        [System.Collections.Generic.List[string]]$Lines,
        [string]$Name,
        [bool]$ReadVersion
    )

    $command = Get-Command $Name -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) {
        return $null
    }
    $path = [string]$command.Path
    [void]$Lines.Add("${Name}_path=$path")
    if ($ReadVersion) {
        try {
            $versionLines = @(& $path --version 2>&1 | Select-Object -First 5)
            foreach ($versionLine in $versionLines) {
                [void]$Lines.Add("${Name}_version=$([string]$versionLine)")
            }
        }
        catch {
            [void]$Lines.Add("${Name}_version_error=$($_.Exception.Message)")
        }
    }
    return $path
}

function Find-PiPackageRoot {
    param([string]$PiCommandPath)

    $configuredPackage = [Environment]::GetEnvironmentVariable("PI_PACKAGE_DIR")
    if (-not [string]::IsNullOrWhiteSpace($configuredPackage)) {
        $configuredManifest = Join-Path $configuredPackage "package.json"
        if (Test-Path -LiteralPath $configuredManifest -PathType Leaf) {
            return (Resolve-Path -LiteralPath $configuredPackage).ProviderPath
        }
    }

    if ([string]::IsNullOrWhiteSpace($PiCommandPath) -or -not (Test-Path -LiteralPath $PiCommandPath -PathType Leaf)) {
        return $null
    }

    $packagePaths = @(
        "@caupulican/pi-adaptative",
        "@earendil-works/pi-coding-agent",
        "@mariozechner/pi-coding-agent"
    )
    $cursor = Split-Path -Parent (Resolve-Path -LiteralPath $PiCommandPath).ProviderPath
    for ($depth = 0; $depth -lt 6 -and -not [string]::IsNullOrWhiteSpace($cursor); $depth += 1) {
        foreach ($packagePath in $packagePaths) {
            foreach ($candidate in @((Join-Path $cursor $packagePath), (Join-Path $cursor (Join-Path "node_modules" $packagePath)))) {
                if (Test-Path -LiteralPath (Join-Path $candidate "package.json") -PathType Leaf) {
                    return (Resolve-Path -LiteralPath $candidate).ProviderPath
                }
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent -or $parent.FullName -eq $cursor) {
            break
        }
        $cursor = $parent.FullName
    }
    return $null
}

function Write-InstalledRuntimeDiagnostic {
    param([string]$PiCommandPath)

    if ([string]::IsNullOrWhiteSpace($PiCommandPath)) {
        return
    }

    $lines = New-Object "System.Collections.Generic.List[string]"
    [void]$lines.Add("pi_command=$PiCommandPath")
    if (Test-Path -LiteralPath $PiCommandPath -PathType Leaf) {
        try {
            [void]$lines.Add("pi_command_sha256=$(Get-FileSha256 -Path $PiCommandPath)")
        }
        catch {
            [void]$lines.Add("pi_command_hash_error=$($_.Exception.Message)")
        }
    }

    $packageRoot = Find-PiPackageRoot -PiCommandPath $PiCommandPath
    if (-not [string]::IsNullOrWhiteSpace($packageRoot)) {
        [void]$lines.Add("package_root=$packageRoot")
        foreach ($relativePath in @(
            "package.json",
            "dist/core/tools/shell-session.js",
            "dist/core/tools/bash.js",
            "dist/core/agent-session.js"
        )) {
            $file = Join-Path $packageRoot $relativePath
            if (Test-Path -LiteralPath $file -PathType Leaf) {
                $hash = Get-FileSha256 -Path $file
                [void]$lines.Add("$hash  $($relativePath.Replace('\', '/'))")
            }
        }

        $shellSessionFile = Join-Path $packageRoot "dist/core/tools/shell-session.js"
        if (Test-Path -LiteralPath $shellSessionFile -PathType Leaf) {
            $hasExitMarker = [bool](Select-String -LiteralPath $shellSessionFile -SimpleMatch 'child.on("exit"' -Quiet)
            $hasDeferredSettlement = [bool](Select-String -LiteralPath $shellSessionFile -SimpleMatch "setImmediate" -Quiet)
            if ($hasExitMarker -and $hasDeferredSettlement) {
                [void]$lines.Add("shell_exit_settlement=exit-event")
            }
            else {
                [void]$lines.Add("shell_exit_settlement=marker-missing")
            }
        }
    }

    Write-Utf8Lines -Path (Join-Path $script:staging "diagnostics/installed-runtime.txt") -Lines $lines.ToArray()
}

function Write-EventRecords {
    param(
        [IO.StreamWriter]$Writer,
        [string]$LogName,
        [object[]]$Events
    )

    foreach ($event in @($Events | Select-Object -First 100)) {
        $message = [string]$event.Message
        if ($message.Length -gt 4000) {
            $message = $message.Substring(0, 4000) + "..."
        }
        $timestamp = $null
        if ($null -ne $event.TimeCreated) {
            $timestamp = $event.TimeCreated.ToUniversalTime().ToString("o")
        }
        $record = [ordered]@{
            timestampUtc = $timestamp
            log = $LogName
            provider = $event.ProviderName
            id = $event.Id
            level = $event.LevelDisplayName
            message = $message
        }
        $Writer.WriteLine(($record | ConvertTo-Json -Compress))
    }
}

function Write-WindowsEventDiagnostics {
    param(
        [DateTimeOffset]$StartUtc,
        [DateTimeOffset]$EndUtc
    )

    $eventOutput = Join-Path $script:staging "diagnostics/windows-events.jsonl"
    $eventErrors = New-Object "System.Collections.Generic.List[string]"
    $writer = New-Object IO.StreamWriter($eventOutput, $false, $script:utf8WithoutBom)
    try {
        $start = $StartUtc.LocalDateTime
        $end = $EndUtc.LocalDateTime
        foreach ($logName in @(
            "Microsoft-Windows-Hyper-V-Compute-Admin",
            "Microsoft-Windows-Hyper-V-Compute-Operational"
        )) {
            try {
                $events = @(Get-WinEvent -FilterHashtable @{ LogName = $logName; StartTime = $start; EndTime = $end } -MaxEvents 200 -ErrorAction Stop)
                Write-EventRecords -Writer $writer -LogName $logName -Events $events
            }
            catch {
                [void]$eventErrors.Add("${logName}: $($_.Exception.Message)")
            }
        }

        try {
            $applicationEvents = @(Get-WinEvent -FilterHashtable @{ LogName = "Application"; StartTime = $start; EndTime = $end } -MaxEvents 500 -ErrorAction Stop |
                Where-Object {
                    $_.ProviderName -in @("Application Error", "Windows Error Reporting") -and
                    $_.Message -match "(?i)(node\.exe|bun\.exe|pi\.exe|pi-adaptative|AppTermFailureEvent)"
                })
            Write-EventRecords -Writer $writer -LogName "Application" -Events $applicationEvents
        }
        catch {
            [void]$eventErrors.Add("Application: $($_.Exception.Message)")
            [void]$script:warnings.Add("Application event-log collection failed; see diagnostics/windows-event-errors.txt")
        }

        try {
            $systemEvents = @(Get-WinEvent -FilterHashtable @{ LogName = "System"; StartTime = $start; EndTime = $end } -MaxEvents 500 -ErrorAction Stop |
                Where-Object {
                    $_.Level -le 3 -and (
                        $_.ProviderName -match "(?i)(Lxss|WSL|Hyper-V|Host.Compute)" -or
                        $_.Message -match "(?i)(node\.exe|bun\.exe|pi\.exe|pi-adaptative|wsl|wslhost|vmmem|lxss)"
                    )
                })
            Write-EventRecords -Writer $writer -LogName "System" -Events $systemEvents
        }
        catch {
            [void]$eventErrors.Add("System: $($_.Exception.Message)")
            [void]$script:warnings.Add("System event-log collection failed; see diagnostics/windows-event-errors.txt")
        }
    }
    finally {
        $writer.Dispose()
    }

    if ((Get-Item -LiteralPath $eventOutput).Length -eq 0) {
        Remove-Item -LiteralPath $eventOutput -Force
    }
    if ($eventErrors.Count -gt 0) {
        Write-Utf8Lines -Path (Join-Path $script:staging "diagnostics/windows-event-errors.txt") -Lines $eventErrors.ToArray()
    }
}

$agentDirWasExplicitlySupplied = -not [string]::IsNullOrWhiteSpace($AgentDir)
$configuredAgentDir = Get-FirstEnvironmentValue -Names @(
    "PI_ADAPTATIVE_CODING_AGENT_DIR",
    "PI_CHAT_CODING_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "PI_AGENT_DIR"
)
if ([string]::IsNullOrWhiteSpace($AgentDir)) {
    if (-not [string]::IsNullOrWhiteSpace($configuredAgentDir)) {
        $AgentDir = $configuredAgentDir
    }
    else {
        $AgentDir = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".pi/agent"
    }
}
$AgentDir = Resolve-ExistingPath -Path $AgentDir -Description "Pi agent directory" -PathType Container

if ([string]::IsNullOrWhiteSpace($SessionDir)) {
    if ($agentDirWasExplicitlySupplied) {
        $SessionDir = Join-Path $AgentDir "sessions"
    }
    else {
        $configuredSessionDir = Get-FirstEnvironmentValue -Names @(
            "PI_ADAPTATIVE_CODING_AGENT_SESSION_DIR",
            "PI_CHAT_CODING_AGENT_SESSION_DIR",
            "PI_CODING_AGENT_SESSION_DIR"
        )
        if (-not [string]::IsNullOrWhiteSpace($configuredSessionDir)) {
            $SessionDir = $configuredSessionDir
        }
        else {
            $SessionDir = Join-Path $AgentDir "sessions"
        }
    }
}

if (-not [string]::IsNullOrWhiteSpace($Session)) {
    $sessionFile = Resolve-ExistingPath -Path $Session -Description "Session file" -PathType Leaf
}
else {
    $sessionFile = Get-LatestHumanSession -Root $SessionDir
}
$incidentWindow = Get-SessionTimeRange -Path $sessionFile -FallbackHours $EventHours -PaddingMinutes $EventPaddingMinutes

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($OutputDir)) {
        $OutputDir = (Get-Location).Path
    }
}
[void](New-Item -ItemType Directory -Force -Path $OutputDir)
$OutputDir = (Resolve-Path -LiteralPath $OutputDir).ProviderPath

$timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$archivePath = Join-Path $OutputDir "pi-incident-$timestamp.zip"
if (Test-Path -LiteralPath $archivePath) {
    $archivePath = Join-Path $OutputDir "pi-incident-$timestamp-$PID.zip"
}
if (Test-Path -LiteralPath $archivePath) {
    $archivePath = Join-Path $OutputDir "pi-incident-$timestamp-$PID-$([Guid]::NewGuid().ToString('N')).zip"
}

$staging = Join-Path ([IO.Path]::GetTempPath()) ("pi-incident." + [Guid]::NewGuid().ToString("N"))
[void](New-Item -ItemType Directory -Path $staging)

try {
    $sessionId = ""
    if (-not [string]::IsNullOrWhiteSpace($sessionFile)) {
        [void](Copy-EvidenceFile -Source $sessionFile -Destination ("session/" + [IO.Path]::GetFileName($sessionFile)))
        $sessionId = Get-SessionId -Path $sessionFile
    }
    else {
        [void]$warnings.Add("No human session JSONL was found under $SessionDir")
    }

    foreach ($stateLog in @(
        [pscustomobject]@{ Name = "tool-recovery-events.jsonl"; MatchSessionId = $true },
        [pscustomobject]@{ Name = "failure-corpus.jsonl"; MatchSessionId = $false }
    )) {
        $stateLogPath = Join-Path (Join-Path $AgentDir "state") $stateLog.Name
        $matchedStateRecords = Copy-CorrelatedStateLog `
            -Source $stateLogPath `
            -Destination ("state/" + $stateLog.Name) `
            -SessionId $sessionId `
            -IncidentWindow $incidentWindow `
            -MatchSessionId $stateLog.MatchSessionId
        if ($matchedStateRecords -lt 0) {
            [void]$warnings.Add("State log was not found: $stateLogPath")
        }
        elseif ($matchedStateRecords -eq 0) {
            [void]$warnings.Add("No state records matched the affected session: $stateLogPath")
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($sessionId)) {
        $orchestrationKey = Get-OrchestrationSessionKey -SessionId $sessionId
        $orchestrationSource = Join-Path (Join-Path (Join-Path (Join-Path $AgentDir "state") "orchestration") "sessions") $orchestrationKey
        if (Test-Path -LiteralPath $orchestrationSource -PathType Container) {
            [void](Copy-EvidenceDirectory -Source $orchestrationSource -Destination ("state/orchestration/sessions/" + $orchestrationKey))
        }
        elseif (Test-Path -LiteralPath (Join-Path (Join-Path $AgentDir "state") "orchestration") -PathType Container) {
            [void]$warnings.Add("No orchestration records matched session $sessionId")
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($CommandLog)) {
        if (-not (Copy-EvidenceFile -Source $CommandLog -Destination ("command-logs/" + [IO.Path]::GetFileName($CommandLog)))) {
            [void]$warnings.Add("Requested command log was not found: $CommandLog")
        }
    }

    $tuiLogRoots = New-Object "System.Collections.Generic.List[string]"
    $configuredTuiLog = [Environment]::GetEnvironmentVariable("PI_TUI_WRITE_LOG")
    if (-not [string]::IsNullOrWhiteSpace($configuredTuiLog)) {
        [void]$tuiLogRoots.Add($configuredTuiLog)
    }
    [void]$tuiLogRoots.Add((Join-Path ([IO.Path]::GetTempPath()) "pi-tui-logs"))

    $seenTuiLogs = @{}
    foreach ($root in $tuiLogRoots) {
        $logs = @()
        if (Test-Path -LiteralPath $root -PathType Leaf) {
            $logs = @((Get-Item -LiteralPath $root))
        }
        elseif (Test-Path -LiteralPath $root -PathType Container) {
            $logs = @(Get-ChildItem -LiteralPath $root -File -Filter "*.log" -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTimeUtc -Descending |
                Select-Object -First 3)
        }
        foreach ($log in $logs) {
            $resolvedLog = (Resolve-Path -LiteralPath $log.FullName).ProviderPath
            if ($seenTuiLogs.ContainsKey($resolvedLog)) {
                continue
            }
            $seenTuiLogs[$resolvedLog] = $true
            [void](Copy-EvidenceFile -Source $resolvedLog -Destination ("tui/" + [IO.Path]::GetFileName($resolvedLog)))
        }
    }

    $diagnosticsDir = Join-Path $staging "diagnostics"
    [void](New-Item -ItemType Directory -Force -Path $diagnosticsDir)
    $environmentLines = New-Object "System.Collections.Generic.List[string]"
    [void]$environmentLines.Add("collected_at_utc=$((Get-Date).ToUniversalTime().ToString('o'))")
    [void]$environmentLines.Add("collected_at_local=$((Get-Date).ToString('o'))")
    [void]$environmentLines.Add("hostname=$([Environment]::MachineName)")
    [void]$environmentLines.Add("os=$([Environment]::OSVersion.VersionString)")
    [void]$environmentLines.Add("os_architecture=$([Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE'))")
    [void]$environmentLines.Add("process_architecture=$([Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITEW6432'))")
    [void]$environmentLines.Add("powershell_edition=$($PSVersionTable.PSEdition)")
    [void]$environmentLines.Add("powershell_version=$($PSVersionTable.PSVersion)")
    [void]$environmentLines.Add("working_directory=$((Get-Location).Path)")
    [void]$environmentLines.Add("agent_dir=$AgentDir")
    [void]$environmentLines.Add("session_dir=$SessionDir")
    [void]$environmentLines.Add("selected_session=$(if ([string]::IsNullOrWhiteSpace($sessionFile)) { 'none' } else { $sessionFile })")
    [void]$environmentLines.Add("incident_window_source=$($incidentWindow.Source)")
    [void]$environmentLines.Add("incident_window_start_utc=$($incidentWindow.StartUtc.ToString('o'))")
    [void]$environmentLines.Add("incident_window_end_utc=$($incidentWindow.EndUtc.ToString('o'))")

    $isNativeWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
    if ($isNativeWindows) {
        try {
            $operatingSystem = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
            [void]$environmentLines.Add("windows_caption=$($operatingSystem.Caption)")
            [void]$environmentLines.Add("windows_version=$($operatingSystem.Version)")
            [void]$environmentLines.Add("windows_build=$($operatingSystem.BuildNumber)")
            [void]$environmentLines.Add("boot_started_local=$($operatingSystem.LastBootUpTime.ToString('o'))")
        }
        catch {
            [void]$warnings.Add("Windows OS metadata collection failed: $($_.Exception.Message)")
        }
    }

    $piCommandPath = $null
    foreach ($piName in @("pi-adaptative", "pi-chat", "pi")) {
        $piCommandPath = Add-CommandDiagnostic -Lines $environmentLines -Name $piName -ReadVersion $true
        if (-not [string]::IsNullOrWhiteSpace($piCommandPath)) {
            break
        }
    }
    foreach ($toolName in @("node", "bun")) {
        [void](Add-CommandDiagnostic -Lines $environmentLines -Name $toolName -ReadVersion $true)
    }
    foreach ($toolName in @("git", "rg", "fd", "uv", "python", "py")) {
        [void](Add-CommandDiagnostic -Lines $environmentLines -Name $toolName -ReadVersion $false)
    }
    Write-Utf8Lines -Path (Join-Path $diagnosticsDir "environment.txt") -Lines $environmentLines.ToArray()
    Write-InstalledRuntimeDiagnostic -PiCommandPath $piCommandPath

    if ($isNativeWindows -and $null -ne (Get-Command Get-WinEvent -ErrorAction SilentlyContinue)) {
        Write-WindowsEventDiagnostics -StartUtc $incidentWindow.StartUtc -EndUtc $incidentWindow.EndUtc
    }

    $manifestLines = New-Object "System.Collections.Generic.List[string]"
    [void]$manifestLines.Add("Pi native Windows incident archive")
    [void]$manifestLines.Add("Created (UTC): $((Get-Date).ToUniversalTime().ToString('o'))")
    [void]$manifestLines.Add("Affected session ID: $(if ([string]::IsNullOrWhiteSpace($sessionId)) { 'unknown' } else { $sessionId })")
    [void]$manifestLines.Add("Incident window (UTC): $($incidentWindow.StartUtc.ToString('o')) through $($incidentWindow.EndUtc.ToString('o'))")
    [void]$manifestLines.Add("Incident window source: $($incidentWindow.Source)")
    [void]$manifestLines.Add("")
    [void]$manifestLines.Add("Sensitive-data notice:")
    [void]$manifestLines.Add("Session diagnostics may contain prompts, source text, paths, commands, and output.")
    [void]$manifestLines.Add("auth.json, settings.json, dotenv files, and vault files are not scanned or collected. Review before sharing.")
    if ($warnings.Count -gt 0) {
        [void]$manifestLines.Add("")
        [void]$manifestLines.Add("Warnings:")
        foreach ($warning in $warnings) {
            [void]$manifestLines.Add("- $warning")
        }
    }
    [void]$manifestLines.Add("")
    [void]$manifestLines.Add("Collected source files:")
    for ($index = 0; $index -lt $collectedSources.Count; $index += 1) {
        [void]$manifestLines.Add("- $($collectedSources[$index]) -> $($collectedDestinations[$index])")
    }
    [void]$manifestLines.Add("")
    [void]$manifestLines.Add("Archive files (SHA-256):")
    foreach ($file in @(Get-ChildItem -LiteralPath $staging -File -Recurse | Sort-Object FullName)) {
        $relativePath = $file.FullName.Substring($staging.Length).TrimStart("\", "/").Replace("\", "/")
        $hash = Get-FileSha256 -Path $file.FullName
        [void]$manifestLines.Add("$hash  $relativePath")
    }
    Write-Utf8Lines -Path (Join-Path $staging "manifest.txt") -Lines $manifestLines.ToArray()

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory(
        $staging,
        $archivePath,
        [IO.Compression.CompressionLevel]::Optimal,
        $false
    )

    Write-Output "Incident archive created:"
    Write-Output $archivePath
    foreach ($warning in $warnings) {
        Write-Warning $warning
    }
    [Console]::Error.WriteLine("Review the ZIP before sharing; session history can contain private project data.")
}
catch {
    if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
        Remove-Item -LiteralPath $archivePath -Force
    }
    throw
}
finally {
    if (Test-Path -LiteralPath $staging -PathType Container) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}
