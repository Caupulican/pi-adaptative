/** Native PowerShell cold starts can cross five seconds under loaded Windows/WSL hosts. */
export const POWERSHELL_STARTUP_PROBE_TIMEOUT_MS = 15_000;
export const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] as const;
export const POWERSHELL_SESSION_READY_MARKER = "\x1epi-shell-ready\x1e";
export const POWERSHELL_STDERR_BARRIER_LABEL = "stderr";

/**
 * PowerShell 5.1-compatible persistent REPL bootstrap. The readiness marker lets the process that
 * actually serves commands double as its own availability probe.
 */
export const POWERSHELL_BOOTSTRAP = [
	"$ProgressPreference = 'SilentlyContinue'",
	"try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
	"[Console]::Out.Write(([char]30) + 'pi-shell-ready' + ([char]30))",
	"function global:__pi_complete_status([int]$Code) { $global:LASTEXITCODE = $Code }",
	"$__pi_in = [Console]::In",
	"while ($true) {",
	"\t$__pi_line = $__pi_in.ReadLine()",
	"\tif ($null -eq $__pi_line) { break }",
	"\t$__pi_sp = $__pi_line.IndexOf(' ')",
	"\tif ($__pi_sp -lt 1) { continue }",
	"\t$__pi_nonce = $__pi_line.Substring(0, $__pi_sp)",
	"\t$__pi_cmd = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($__pi_line.Substring($__pi_sp + 1)))",
	"\t$global:LASTEXITCODE = $null",
	"\t$__pi_thrown = $false",
	"\t$__pi_succeeded = $false",
	"\ttry { Invoke-Expression $__pi_cmd; $__pi_succeeded = $? } catch { $__pi_thrown = $true; $__pi_msg = ($_ | Out-String).TrimEnd(); if ($__pi_msg) { [Console]::Out.WriteLine($__pi_msg) } }",
	"\t$__pi_code = $global:LASTEXITCODE",
	"\tif ($null -eq $__pi_code) { $__pi_code = if ($__pi_succeeded) { 0 } else { 1 } }",
	"\tif ($__pi_thrown -and ($__pi_code -eq 0)) { $__pi_code = 1 }",
	`\t[Console]::Error.Write(('{0}{1}:${POWERSHELL_STDERR_BARRIER_LABEL}{0}' -f [char]30, $__pi_nonce))`,
	"\t[Console]::Error.Flush()",
	"\t[Console]::Out.Write(('{0}{1}{2}:{3}{1}' -f [char]10, [char]30, $__pi_nonce, $__pi_code))",
	"}",
].join("\n");
