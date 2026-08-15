/** Native PowerShell cold starts can cross five seconds under loaded Windows/WSL hosts. */
export const POWERSHELL_STARTUP_PROBE_TIMEOUT_MS = 15_000;
export const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] as const;
export const POWERSHELL_7_GUARD =
	"if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Pi requires PowerShell 7 or newer.' }\n";
export const POWERSHELL_SESSION_READY_MARKER = "\x1epi-shell-ready\x1e";
export const POWERSHELL_SESSION_STDERR_READY_MARKER = "\x1epi-shell-stderr-ready\x1e\n";
export const POWERSHELL_STDERR_BARRIER_LABEL = "stderr";

const POWERSHELL_HEADLESS_ENVIRONMENT = {
	NO_COLOR: "1",
	POWERSHELL_DIAGNOSTICS_OPTOUT: "1",
	POWERSHELL_TELEMETRY_OPTOUT: "1",
	POWERSHELL_UPDATECHECK: "Off",
} as const;
const POWERSHELL_HEADLESS_ENVIRONMENT_NAMES = new Set(
	Object.keys(POWERSHELL_HEADLESS_ENVIRONMENT).map((name) => name.toLowerCase()),
);

/** Deterministic process-only settings for Pi's non-interactive PowerShell host. */
export function createPowerShellHostEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const resolved: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(environment)) {
		if (!POWERSHELL_HEADLESS_ENVIRONMENT_NAMES.has(name.toLowerCase())) resolved[name] = value;
	}
	return { ...resolved, ...POWERSHELL_HEADLESS_ENVIRONMENT };
}

/**
 * PowerShell 7 persistent REPL bootstrap. The stdout/stderr readiness markers let the process that
 * actually serves commands double as its own availability probe and prime both pipes. Command I/O
 * encoding remains owned by PowerShell and the invoked program; only Pi's base64 wire is UTF-8.
 */
export const POWERSHELL_BOOTSTRAP = [
	POWERSHELL_7_GUARD.trimEnd(),
	"$ProgressPreference = 'SilentlyContinue'",
	"$__pi_stdout = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), [System.Text.UTF8Encoding]::new($false))",
	"$__pi_stdout.AutoFlush = $true",
	"[Console]::SetOut($__pi_stdout)",
	"$__pi_stderr = [System.IO.StreamWriter]::new([Console]::OpenStandardError(), [System.Text.UTF8Encoding]::new($false))",
	"$__pi_stderr.AutoFlush = $true",
	"[Console]::SetError($__pi_stderr)",
	"$null = Invoke-Expression \"Write-Output '__pi_warmup'\"",
	"[Console]::Error.Write(([char]30) + 'pi-shell-stderr-ready' + ([char]30) + ([char]10))",
	"[Console]::Error.Flush()",
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
	`\t[Console]::Error.Write(('{0}{1}:${POWERSHELL_STDERR_BARRIER_LABEL}{0}{2}' -f [char]30, $__pi_nonce, [char]10))`,
	"\t[Console]::Error.Flush()",
	"\t[Console]::Out.Write(('{0}{1}{2}:{3}{1}' -f [char]10, [char]30, $__pi_nonce, $__pi_code))",
	"}",
].join("\n");
