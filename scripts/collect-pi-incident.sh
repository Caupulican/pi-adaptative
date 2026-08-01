#!/usr/bin/env bash

set -euo pipefail

usage() {
	cat <<'EOF'
Usage: collect-pi-incident.sh [options]

Collect the latest human Pi session and related local diagnostics into one ZIP.
Run this inside the same WSL distribution where Pi runs.
For a native Windows Pi incident, run collect-pi-incident.ps1 from PowerShell instead.

Options:
  --agent-dir PATH   Pi agent directory (default: configured value or ~/.pi/agent)
  --session-dir PATH Session directory override
  --session PATH     Exact affected session JSONL instead of the latest session
  --command-log PATH Additional command log to include
  --output-dir PATH  ZIP destination directory (default: WSL home)
  -h, --help         Show this help
EOF
}

agent_dir="${PI_ADAPTATIVE_CODING_AGENT_DIR:-${PI_CHAT_CODING_AGENT_DIR:-${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}}}"
session_dir="${PI_ADAPTATIVE_CODING_AGENT_SESSION_DIR:-${PI_CHAT_CODING_AGENT_SESSION_DIR:-${PI_CODING_AGENT_SESSION_DIR:-}}}"
session_file=""
command_log=""
output_dir="$HOME"

while (($# > 0)); do
	case "$1" in
		--agent-dir)
			[[ $# -ge 2 ]] || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
			agent_dir="$2"
			shift 2
			;;
		--session-dir)
			[[ $# -ge 2 ]] || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
			session_dir="$2"
			shift 2
			;;
		--session)
			[[ $# -ge 2 ]] || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
			session_file="$2"
			shift 2
			;;
		--command-log)
			[[ $# -ge 2 ]] || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
			command_log="$2"
			shift 2
			;;
		--output-dir)
			[[ $# -ge 2 ]] || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
			output_dir="$2"
			shift 2
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			printf 'Unknown option: %s\n' "$1" >&2
			usage >&2
			exit 2
			;;
	esac
done

[[ -d "$agent_dir" ]] || {
	printf 'Pi agent directory was not found: %s\n' "$agent_dir" >&2
	printf 'Pass --agent-dir with the directory used by Pi.\n' >&2
	exit 1
}
agent_dir="$(cd "$agent_dir" && pwd -P)"

if [[ -z "$session_dir" ]]; then
	session_dir="$agent_dir/sessions"
fi

find_latest_session() {
	local root="$1"
	local candidate header mtime
	local latest=""
	local latest_mtime=-1

	[[ -d "$root" ]] || return 0
	while IFS= read -r -d '' candidate; do
		header="$(head -n 1 -- "$candidate" 2>/dev/null || true)"
		[[ "$header" == *'"type":"session"'* ]] || continue
		[[ "$header" != *'"id":"auto-learn-'* ]] || continue
		mtime="$(stat -c '%Y' -- "$candidate" 2>/dev/null || printf '0')"
		if ((mtime > latest_mtime)); then
			latest="$candidate"
			latest_mtime="$mtime"
		fi
	done < <(find "$root" -mindepth 1 -maxdepth 2 -type f -name '*.jsonl' -print0 2>/dev/null)
	printf '%s' "$latest"
}

if [[ -n "$session_file" ]]; then
	[[ -f "$session_file" ]] || { printf 'Session file was not found: %s\n' "$session_file" >&2; exit 1; }
	session_file="$(readlink -f -- "$session_file")"
else
	session_file="$(find_latest_session "$session_dir")"
fi

mkdir -p -- "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"
timestamp="$(date -u '+%Y%m%d-%H%M%S')"
archive_path="$output_dir/pi-incident-$timestamp.zip"
if [[ -e "$archive_path" ]]; then
	archive_path="$output_dir/pi-incident-$timestamp-$$.zip"
fi

tmp_root="${TMPDIR:-/tmp}"
mkdir -p -- "$tmp_root"
tmp_root="$(cd "$tmp_root" && pwd -P)"
staging="$(mktemp -d "$tmp_root/pi-incident.XXXXXXXXXX")"

cleanup() {
	case "$staging" in
		"$tmp_root"/pi-incident.*) rm -rf -- "$staging" ;;
	esac
}
trap cleanup EXIT

declare -a collected_sources=()
declare -a collected_destinations=()
declare -a warnings=()

copy_file() {
	local source="$1"
	local destination="$2"
	[[ -f "$source" ]] || return 1
	mkdir -p -- "$(dirname "$staging/$destination")"
	cp -p -- "$source" "$staging/$destination"
	collected_sources+=("$(readlink -f -- "$source")")
	collected_destinations+=("$destination")
}

copy_directory() {
	local source="$1"
	local destination="$2"
	[[ -d "$source" ]] || return 1
	mkdir -p -- "$staging/$destination"
	cp -a -- "$source/." "$staging/$destination/"
}

session_id=""
if [[ -n "$session_file" ]]; then
	copy_file "$session_file" "session/$(basename "$session_file")"
	session_id="$(head -n 1 -- "$session_file" | sed -n 's/.*"id":"\([A-Za-z0-9._-]*\)".*/\1/p')"
else
	warnings+=("No human session JSONL was found under $session_dir")
fi

for state_log in tool-recovery-events.jsonl failure-corpus.jsonl; do
	if ! copy_file "$agent_dir/state/$state_log" "state/$state_log"; then
		warnings+=("State log was not found: $agent_dir/state/$state_log")
	fi
done

if [[ -n "$session_id" && -d "$agent_dir/state/orchestration" ]]; then
	orchestration_key="${session_id:0:80}-$(printf '%s' "$session_id" | sha256sum | cut -c1-16)"
	orchestration_source="$agent_dir/state/orchestration/sessions/$orchestration_key"
	if [[ -d "$orchestration_source" ]]; then
		copy_directory "$orchestration_source" "state/orchestration/sessions/$orchestration_key"
	else
		warnings+=("No orchestration records matched session $session_id")
	fi
fi

if [[ -n "$command_log" ]]; then
	if ! copy_file "$command_log" "command-logs/$(basename "$command_log")"; then
		warnings+=("Requested command log was not found: $command_log")
	fi
fi

declare -a tui_log_roots=()
if [[ -n "${PI_TUI_WRITE_LOG:-}" ]]; then
	tui_log_roots+=("$PI_TUI_WRITE_LOG")
fi
tui_log_roots+=("/tmp/pi-tui-logs")

declare -A seen_tui_logs=()
for root in "${tui_log_roots[@]}"; do
	if [[ -f "$root" ]]; then
		resolved="$(readlink -f -- "$root")"
		if [[ -z "${seen_tui_logs[$resolved]:-}" ]]; then
			seen_tui_logs[$resolved]=1
			copy_file "$resolved" "tui/$(basename "$resolved")"
		fi
	elif [[ -d "$root" ]]; then
		count=0
		while IFS= read -r log; do
			resolved="$(readlink -f -- "$log")"
			[[ -z "${seen_tui_logs[$resolved]:-}" ]] || continue
			seen_tui_logs[$resolved]=1
			copy_file "$resolved" "tui/$(basename "$resolved")"
			((count += 1))
			((count < 3)) || break
		done < <(find "$root" -maxdepth 1 -type f -name '*.log' -printf '%T@ %p\n' 2>/dev/null | sort -nr | cut -d' ' -f2-)
	fi
done

mkdir -p -- "$staging/diagnostics"
pi_executable=""
{
	printf 'collected_at_utc=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
	printf 'collected_at_local=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%:z')"
	printf 'hostname=%s\n' "$(hostname)"
	printf 'kernel=%s\n' "$(uname -srmo)"
	printf 'boot_started_local=%s\n' "$(uptime -s 2>/dev/null || true)"
	printf 'boot_id=%s\n' "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)"
	printf 'working_directory=%s\n' "$PWD"
	printf 'agent_dir=%s\n' "$agent_dir"
	printf 'session_dir=%s\n' "$session_dir"
	printf 'selected_session=%s\n' "${session_file:-none}"
	if [[ -r /etc/os-release ]]; then
		printf '\n[os-release]\n'
		grep -E '^(NAME|VERSION|ID|VERSION_ID)=' /etc/os-release || true
	fi
	for executable in pi-adaptative pi-chat pi; do
		if command -v "$executable" >/dev/null 2>&1; then
			pi_executable="$(command -v "$executable")"
			printf '\n[pi-command]\npath=%s\n' "$pi_executable"
			"$executable" --version 2>&1 || true
			break
		fi
	done
	if command -v node >/dev/null 2>&1; then
		printf 'node=%s\n' "$(node --version 2>/dev/null || true)"
	fi
	if command -v bun >/dev/null 2>&1; then
		printf 'bun=%s\n' "$(bun --version 2>/dev/null || true)"
	fi
} >"$staging/diagnostics/environment.txt"

if [[ -n "$pi_executable" ]]; then
	resolved_pi_executable="$(readlink -f -- "$pi_executable")"
	package_root="$(dirname "$(dirname "$resolved_pi_executable")")"
	if [[ -f "$package_root/package.json" ]]; then
		{
			printf 'package_root=%s\n' "$package_root"
			for relative_path in \
				package.json \
				dist/core/tools/shell-session.js \
				dist/core/tools/bash.js \
				dist/core/agent-session.js; do
				file="$package_root/$relative_path"
				if [[ -f "$file" ]]; then
					printf '%s  %s\n' "$(sha256sum -- "$file" | cut -d' ' -f1)" "$relative_path"
				fi
			done
			shell_session_file="$package_root/dist/core/tools/shell-session.js"
			if [[ -f "$shell_session_file" ]]; then
				if grep -Fq 'child.on("exit"' "$shell_session_file" && grep -Fq 'setImmediate' "$shell_session_file"; then
					printf 'shell_exit_settlement=exit-event\n'
				else
					printf 'shell_exit_settlement=marker-missing\n'
				fi
			fi
		} >"$staging/diagnostics/installed-runtime.txt"
	fi
fi

if command -v dmesg >/dev/null 2>&1; then
	if dmesg --ctime 2>/dev/null | tail -n 800 | grep -Ei 'segfault|out of memory|oom-kill|killed process|node\[[0-9]+\]|bun\[[0-9]+\]|wsl.*(error|crash|fatal)' | tail -n 80 >"$staging/diagnostics/kernel-errors.txt"; then
		[[ -s "$staging/diagnostics/kernel-errors.txt" ]] || rm -f -- "$staging/diagnostics/kernel-errors.txt"
	else
		rm -f -- "$staging/diagnostics/kernel-errors.txt"
	fi
fi

if command -v powershell.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
	windows_event_collector="$staging/diagnostics/collect-windows-events.ps1"
	cat >"$windows_event_collector" <<'POWERSHELL'
$ErrorActionPreference = "SilentlyContinue"
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$start = (Get-Date).AddHours(-24)

function Emit-Events {
    param([string]$LogName, [object[]]$Events)
    foreach ($event in $Events | Select-Object -First 100) {
        $message = [string]$event.Message
        if ($message.Length -gt 4000) { $message = $message.Substring(0, 4000) + "..." }
        [ordered]@{
            timestampUtc = $event.TimeCreated.ToUniversalTime().ToString("o")
            log = $LogName
            provider = $event.ProviderName
            id = $event.Id
            level = $event.LevelDisplayName
            message = $message
        } | ConvertTo-Json -Compress
    }
}

foreach ($logName in @(
    "Microsoft-Windows-Hyper-V-Compute-Admin",
    "Microsoft-Windows-Hyper-V-Compute-Operational"
)) {
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = $logName; StartTime = $start } -MaxEvents 200)
    Emit-Events $logName $events
}

$applicationEvents = @(Get-WinEvent -FilterHashtable @{ LogName = "Application"; StartTime = $start } -MaxEvents 500 |
    Where-Object {
        $_.ProviderName -in @("Application Error", "Windows Error Reporting") -and
        $_.Message -match "(?i)(wsl|wslhost|vmmem|lxss|node\.exe|bun\.exe|pi-adaptative|AppTermFailureEvent)"
    })
Emit-Events "Application" $applicationEvents

$systemEvents = @(Get-WinEvent -FilterHashtable @{ LogName = "System"; StartTime = $start } -MaxEvents 500 |
    Where-Object {
        $_.Level -le 3 -and (
            $_.ProviderName -match "(?i)(Lxss|WSL|Hyper-V|Host.Compute)" -or
            $_.Message -match "(?i)(wsl|wslhost|vmmem|lxss|subsystem for linux)"
        )
    })
Emit-Events "System" $systemEvents
POWERSHELL
	windows_event_output="$staging/diagnostics/windows-events.jsonl"
	windows_event_errors="$staging/diagnostics/windows-event-errors.txt"
	if ! powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(wslpath -w "$windows_event_collector")" \
		>"$windows_event_output" 2>"$windows_event_errors"; then
		warnings+=("Windows event-log collection failed; see diagnostics/windows-event-errors.txt")
	fi
	rm -f -- "$windows_event_collector"
	[[ -s "$windows_event_output" ]] || rm -f -- "$windows_event_output"
	[[ -s "$windows_event_errors" ]] || rm -f -- "$windows_event_errors"
fi

{
	printf 'Pi incident archive\n'
	printf 'Created (UTC): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
	printf 'Selected session ID: %s\n' "${session_id:-unknown}"
	printf '\nSensitive-data notice:\n'
	printf 'Session diagnostics may contain prompts, source text, paths, commands, and output.\n'
	printf 'auth.json, settings.json, .env files, and vault files are not collected. Review before sharing.\n'
	if ((${#warnings[@]} > 0)); then
		printf '\nWarnings:\n'
		printf -- '- %s\n' "${warnings[@]}"
	fi
	printf '\nCollected source files:\n'
	for ((index = 0; index < ${#collected_sources[@]}; index += 1)); do
		printf -- '- %s -> %s\n' "${collected_sources[$index]}" "${collected_destinations[$index]}"
	done
	printf '\nArchive files (SHA-256):\n'
	while IFS= read -r -d '' file; do
		printf '%s  %s\n' "$(sha256sum -- "$file" | cut -d' ' -f1)" "${file#"$staging/"}"
	done < <(find "$staging" -type f ! -name manifest.txt -print0 | sort -z)
} >"$staging/manifest.txt"

if command -v zip >/dev/null 2>&1; then
	(
		cd "$staging"
		zip -q -r "$archive_path" .
	)
elif command -v python3 >/dev/null 2>&1; then
	python3 - "$staging" "$archive_path" <<'PY'
from pathlib import Path
from sys import argv
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(argv[1])
with ZipFile(argv[2], "w", ZIP_DEFLATED) as archive:
    for path in sorted(root.rglob("*")):
        if path.is_file():
            archive.write(path, path.relative_to(root))
PY
else
	printf 'Neither zip nor python3 is installed; cannot create a ZIP.\n' >&2
	exit 1
fi

printf 'Incident archive created:\n%s\n' "$archive_path"
if command -v wslpath >/dev/null 2>&1; then
	windows_path="$(wslpath -w "$archive_path" 2>/dev/null || true)"
	if [[ -n "$windows_path" ]]; then
		printf 'Windows path:\n%s\n' "$windows_path"
	fi
fi
if ((${#warnings[@]} > 0)); then
	printf 'Warnings:\n' >&2
	printf -- '- %s\n' "${warnings[@]}" >&2
fi
printf 'Review the ZIP before sharing; session history can contain private project data.\n' >&2
