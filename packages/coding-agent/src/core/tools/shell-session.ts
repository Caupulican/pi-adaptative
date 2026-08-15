/**
 * Persistent shell sessions for the bash tool.
 *
 * One long-lived shell process per agent (keyed registry) replaces process-per-command spawning.
 * On Windows every command previously paid a full PowerShell boot; a persistent session pays it
 * once. Shell state (current directory, environment variables) persists across an agent's
 * commands; each key gets an isolated session so concurrently running agents never share state.
 *
 * Protocol: commands stream to the session over stdin and are terminated by a per-command
 * sentinel carrying a random nonce and the exit code. Bash wraps commands in an eval of a quoted
 * heredoc (arbitrary content stays data; syntax errors stay contained in eval); PowerShell runs a
 * ReadLine loop decoding base64 lines (no external binaries involved). On bash, command stderr is
 * merged into stdout at the shell so sentinel ordering is guaranteed on one pipe.
 *
 * PowerShell runs each command as a bare `Invoke-Expression`, NOT piped into `Out-Default`: piping
 * a native command's output into another pipeline stage forces PowerShell's NativeCommandProcessor
 * to capture that child's stdout/stderr into an internal pipe and read it to EOF before the
 * pipeline completes. A detached grandchild that inherited those handles (e.g. `start /b` holding
 * stdio open) then keeps that internal pipe's write end open, so the sentinel — written after the
 * pipeline "completes" — waits for the grandchild to die instead of the direct child. The bare
 * invocation lets a native command's stdout/stderr handles be inherited directly by the child
 * process; the direct child's own exit is what unblocks the sentinel line, exactly like the
 * per-command backend and like bash's stdio inheritance above. The bounded consequence: a native
 * command's stderr no longer merges into the session's stdout pipe (there is no capturing pipeline
 * stage to merge it) — it arrives on the session's own stderr pipe instead, forwarded via
 * `onStderr` -> `onData` same as the shell's own diagnostics. PowerShell 5.1's habit of wrapping
 * redirected stderr text in a `NativeCommandError` record also disappears, which is an accuracy
 * improvement (the raw stderr bytes are reported, not a wrapped/duplicated rendering of them).
 *
 * Kill semantics: timeout/abort/silence kill the WHOLE session process tree (a hung foreground
 * command cannot be killed individually without job control) and the next exec respawns a fresh
 * session, losing accumulated shell state by design. A command that exits the shell itself
 * (`exit 3`) reports the shell's exit code and also respawns lazily afterwards.
 */

import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { createSilenceWatchdog } from "@caupulican/pi-agent-core/reliability";
import { type ChildProcess, type SpawnOptions, spawn } from "child_process";
import {
	getPowerShellCandidateConfigs,
	getShellConfig,
	getShellEnv,
	type PlatformShellToolName,
	POWERSHELL_STARTUP_PROBE_TIMEOUT_MS,
	type ShellConfig,
} from "../../utils/shell.ts";
import { PersistentProcessCoordinator } from "./persistent-process-coordinator.ts";

const SENTINEL_BYTE = 0x1e;
/** Longest possible sentinel: "\n" + 0x1e + 16-hex nonce + ":" + exit code digits + 0x1e. */
const SENTINEL_HOLDBACK_BYTES = 64;
const MAX_STARTUP_DIAGNOSTIC_BYTES = 16 * 1024;
export const POWERSHELL_SESSION_READY_MARKER = "\x1epi-shell-ready\x1e";
const POWERSHELL_SESSION_READY_BYTES = Buffer.from(POWERSHELL_SESSION_READY_MARKER, "latin1");

export interface ShellSessionExecOptions {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	/** Wall-clock bound in seconds; when set, a breach kills the session and throws `timeout:<s>`. */
	timeoutSeconds?: number;
	/** Output-silence bound in ms; when set, silence kills the session and throws `silence:<s>`. */
	silenceMs?: number;
	env?: NodeJS.ProcessEnv;
}

export interface PersistentShellSessionOptions {
	resolvePowerShellCandidates?: () => ShellConfig[];
	spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	startupTimeoutMs?: number;
}

function escapeSingleQuotesPosix(value: string): string {
	return value.replace(/'/g, "'\\''");
}

function escapeSingleQuotesPowerShell(value: string): string {
	return value.replace(/'/g, "''");
}

/**
 * The whole command is heredoc-quoted data: eval keeps syntax errors contained (a raw syntax
 * error on the session's stdin would abort the shell), and the random delimiter makes content
 * collisions with agent output practically impossible. `< /dev/null` gives commands the same
 * EOF-stdin the per-command backend's `stdio: ["ignore", ...]` provided.
 */
export function buildBashWire(command: string, nonce: string, cdTo: string | null): string {
	const body = cdTo ? `command cd -- '${escapeSingleQuotesPosix(cdTo)}' && {\n${command}\n}` : command;
	return [
		`{ eval "$(cat <<'PI_EOF_${nonce}'`,
		body,
		`PI_EOF_${nonce}`,
		`)"; } < /dev/null 2>&1`,
		`printf '\\n\\036%s:%s\\036' '${nonce}' "$?"`,
		"",
	].join("\n");
}

/** One protocol line: `<nonce> <base64(utf8 command)>`. Base64 keeps arbitrary multi-line commands line-safe. */
export function buildPowerShellWire(command: string, nonce: string, cdTo: string | null): string {
	const body = cdTo
		? `Set-Location -LiteralPath '${escapeSingleQuotesPowerShell(cdTo)}' -ErrorAction Stop\n${command}`
		: command;
	return `${nonce} ${Buffer.from(body, "utf8").toString("base64")}\n`;
}

/**
 * PowerShell 5.1-compatible REPL bootstrap. Exit code mirrors `-Command` semantics as closely as
 * a loop can: a native command's $LASTEXITCODE wins, a terminating error forces 1, otherwise 0.
 * Passed as one direct `-Command` argument. `-EncodedCommand` makes PowerShell serialize host,
 * warning, and progress records as CLIXML on stderr whenever pipes are attached; Pi then sees
 * duplicate XML mixed into the same command's plain stdout. Node preserves this script as one
 * argv entry without involving cmd.exe quoting.
 *
 * The command runs as a bare `Invoke-Expression` (no `2>&1 | Out-Default` capture pipeline) — see
 * the module doc header for why: a native command's stdio handles are inherited directly by its
 * child process instead of being captured through a PowerShell-internal pipe, so the sentinel is
 * unblocked by the direct child's own exit rather than by any grandchild holding those handles.
 */
const POWERSHELL_BOOTSTRAP = [
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
	"\t[Console]::Out.Write(('{0}{1}{2}:{3}{1}' -f [char]10, [char]30, $__pi_nonce, $__pi_code))",
	"}",
].join("\n");

function shallowEnvEquals(a: NodeJS.ProcessEnv, b: NodeJS.ProcessEnv): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (a[key] !== b[key]) return false;
	}
	return true;
}

interface ActiveExec {
	onStdout(data: Buffer): void;
	onStderr(data: Buffer): void;
	onChildClose(code: number | null): void;
	fail(error: Error): void;
}

export class PersistentShellSession {
	private readonly key: string;
	private readonly kind: PlatformShellToolName;
	private readonly resolvePowerShellCandidates: () => ShellConfig[];
	private readonly spawnProcess: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	private readonly startupTimeoutMs: number;
	private readonly coordinator = new PersistentProcessCoordinator();
	private childEnv: NodeJS.ProcessEnv | null = null;
	private lastRequestedCwd: string | null = null;
	private activeExec: ActiveExec | null = null;
	private rejectStartup: ((error: Error) => void) | null = null;
	private disposed = false;

	constructor(key: string, kind: PlatformShellToolName, options: PersistentShellSessionOptions = {}) {
		this.key = key;
		this.kind = kind;
		this.resolvePowerShellCandidates = options.resolvePowerShellCandidates ?? getPowerShellCandidateConfigs;
		this.spawnProcess = options.spawn ?? spawn;
		this.startupTimeoutMs = options.startupTimeoutMs ?? POWERSHELL_STARTUP_PROBE_TIMEOUT_MS;
	}

	get sessionKind(): PlatformShellToolName {
		return this.kind;
	}

	/** Serialized: one command at a time per session, later calls queue behind earlier ones. */
	exec(command: string, cwd: string, options: ShellSessionExecOptions): Promise<{ exitCode: number | null }> {
		return this.coordinator.runSerialized(() => this.execNow(command, cwd, options));
	}

	/** Start and validate the long-lived shell before the first user command. Idempotent per session. */
	prewarm(cwd: string, env: NodeJS.ProcessEnv = getShellEnv()): Promise<void> {
		return this.coordinator.runSerialized(async () => {
			if (this.disposed) throw new Error(`Shell session "${this.key}" is disposed`);
			if (this.coordinator.child && this.childEnv && !shallowEnvEquals(this.childEnv, env)) this.killChild();
			if (!this.coordinator.child) await this.spawnChild(cwd, env);
			this.coordinator.setLoopRef(false);
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.rejectStartup?.(new Error(`Shell session "${this.key}" is disposed`));
		this.activeExec?.fail(new Error(`Shell session "${this.key}" is disposed`));
		this.coordinator.dispose();
		this.resetChildState();
	}

	private async execNow(
		command: string,
		cwd: string,
		{ onData, signal, timeoutSeconds, silenceMs, env }: ShellSessionExecOptions,
	): Promise<{ exitCode: number | null }> {
		if (this.disposed) throw new Error(`Shell session "${this.key}" is disposed`);
		if (signal?.aborted) throw new Error("aborted");

		const resolvedEnv = env ?? getShellEnv();
		// The environment is spawn-time shell config: an env that differs from the running
		// session's (e.g. a spawn hook rewriting it per command) requires a fresh shell.
		if (this.coordinator.child && this.childEnv && !shallowEnvEquals(this.childEnv, resolvedEnv)) {
			this.killChild();
		}

		// Re-enter the host-requested cwd only when it CHANGES between calls; an unchanged
		// request preserves the agent's own in-session `cd` (that persistence is the feature).
		let cdTo: string | null = null;
		if (!this.coordinator.child) {
			await this.spawnChild(cwd, resolvedEnv);
		} else if (this.lastRequestedCwd !== cwd) {
			cdTo = cwd;
		}
		this.lastRequestedCwd = cwd;

		const child = this.coordinator.child;
		if (!child?.stdin || !child.stdout || !child.stderr) {
			this.killChild();
			throw new Error(`Failed to start ${this.kind} session`);
		}

		const nonce = randomBytes(8).toString("hex");
		const wire =
			this.kind === "powershell" ? buildPowerShellWire(command, nonce, cdTo) : buildBashWire(command, nonce, cdTo);
		const sentinelPrefix = Buffer.from(`\n\x1e${nonce}:`, "latin1");

		this.coordinator.setLoopRef(true);
		try {
			return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
				let settled = false;
				let pending: Buffer = Buffer.alloc(0);
				let timeoutTimer: NodeJS.Timeout | undefined;

				const silenceWatchdog =
					timeoutSeconds === undefined && silenceMs !== undefined && silenceMs > 0
						? createSilenceWatchdog({
								silenceMs,
								onSilence: () => {
									this.killChild();
									settle(() => reject(new Error(`silence:${silenceMs / 1000}`)));
								},
							})
						: undefined;

				const settle = (finish: () => void) => {
					if (settled) return;
					settled = true;
					if (timeoutTimer) clearTimeout(timeoutTimer);
					silenceWatchdog?.disarm();
					if (signal) signal.removeEventListener("abort", onAbort);
					this.activeExec = null;
					finish();
				};

				const onAbort = () => {
					this.killChild();
					settle(() => reject(new Error("aborted")));
				};

				const emitPending = (upTo: number) => {
					if (upTo <= 0) return;
					onData(pending.subarray(0, upTo));
					pending = pending.subarray(upTo);
				};

				this.activeExec = {
					onStdout: (data) => {
						silenceWatchdog?.touch();
						pending = pending.length === 0 ? data : Buffer.concat([pending, data]);
						const prefixIndex = pending.indexOf(sentinelPrefix);
						if (prefixIndex !== -1) {
							const closeIndex = pending.indexOf(SENTINEL_BYTE, prefixIndex + sentinelPrefix.length);
							if (closeIndex !== -1) {
								const codeText = pending
									.subarray(prefixIndex + sentinelPrefix.length, closeIndex)
									.toString("latin1");
								emitPending(prefixIndex);
								const parsed = Number.parseInt(codeText, 10);
								// Defer the settle by one microtask turn: with the bare Invoke-Expression
								// form a native command's stderr now arrives on the session's OWN stderr
								// pipe (see module doc header) instead of being pre-merged into the same
								// stdout bytes the sentinel rides on. Node fires already-queued stream
								// 'data' events in event-loop order; queueing the resolution behind a
								// microtask guarantees any stderr chunk the kernel delivered alongside (or
								// just before) this stdout chunk has already run its 'data' handler — and
								// thus reached `onData` — before the promise settles, so callers never see a
								// truncated stderr tail immediately after resolution.
								queueMicrotask(() => settle(() => resolve({ exitCode: Number.isNaN(parsed) ? null : parsed })));
								return;
							}
						}
						// Stream promptly but retain a tail large enough to hold any split sentinel.
						emitPending(pending.length - SENTINEL_HOLDBACK_BYTES);
					},
					onStderr: (data) => {
						// The command's stderr is merged into stdout at the shell; this pipe only
						// carries the session shell's own diagnostics. Forward for visibility.
						silenceWatchdog?.touch();
						onData(data);
					},
					onChildClose: (code) => {
						// The command terminated the shell itself (e.g. `exit 3`) or the shell
						// crashed: report its exit code like the per-command backend would.
						emitPending(pending.length);
						settle(() => resolve({ exitCode: code }));
					},
					fail: (error) => {
						this.killChild();
						settle(() => reject(error));
					},
				};

				if (signal) signal.addEventListener("abort", onAbort, { once: true });
				if (timeoutSeconds !== undefined && timeoutSeconds > 0) {
					timeoutTimer = setTimeout(() => {
						this.killChild();
						settle(() => reject(new Error(`timeout:${timeoutSeconds}`)));
					}, timeoutSeconds * 1000);
				}

				child.stdin?.write(wire, (error) => {
					if (!error) return;
					this.killChild();
					settle(() => reject(new Error(`Failed to write to ${this.kind} session: ${error.message}`)));
				});
			});
		} finally {
			this.coordinator.setLoopRef(false);
		}
	}

	private async spawnChild(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
		if (this.kind === "powershell") {
			await this.spawnPowerShellChild(cwd, env);
		} else {
			const { shell } = getShellConfig(undefined, this.kind);
			const args = basename(shell).toLowerCase().includes("bash") ? ["--noprofile", "--norc"] : [];
			const child = this.spawnProcess(shell, args, {
				cwd,
				env,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			this.attachReadyChild(child);
		}
		this.childEnv = env;
		this.lastRequestedCwd = cwd;
	}

	private async spawnPowerShellChild(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
		const failures: string[] = [];
		for (const candidate of this.resolvePowerShellCandidates()) {
			try {
				await this.spawnPowerShellCandidate(candidate.shell, cwd, env);
				return;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push(`${candidate.shell}: ${message}`);
			}
		}
		const detail = failures.length > 0 ? ` Candidate failures: ${failures.join("; ")}` : "";
		throw new Error(
			`No PowerShell executable found. Install PowerShell 7 (pwsh), restore Windows PowerShell, or set shellPath in settings.json.${detail}`,
		);
	}

	private spawnPowerShellCandidate(shell: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let startupSettled = false;
			let startupStdout: Buffer = Buffer.alloc(0);
			let startupStderr: Buffer = Buffer.alloc(0);
			let timeoutTimer: NodeJS.Timeout | undefined;

			const settleStartup = (finish: () => void): void => {
				if (startupSettled) return;
				startupSettled = true;
				if (timeoutTimer) clearTimeout(timeoutTimer);
				if (this.rejectStartup === rejectStartup) this.rejectStartup = null;
				finish();
			};
			const startupDiagnostic = (): string => {
				const combined = Buffer.concat([startupStdout, startupStderr]).toString("utf8").trim();
				return combined ? `: ${combined}` : "";
			};
			const rejectStartup = (error: Error): void => {
				settleStartup(() => reject(error));
			};

			let child: ChildProcess;
			try {
				child = this.spawnProcess(
					shell,
					["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_BOOTSTRAP],
					{
						cwd,
						env,
						detached: process.platform !== "win32",
						stdio: ["pipe", "pipe", "pipe"],
						windowsHide: true,
					},
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				rejectStartup(new Error(`spawn failed: ${message}`));
				return;
			}

			this.rejectStartup = rejectStartup;
			this.coordinator.attach(child, {
				onStdout: (data) => {
					if (startupSettled) {
						this.activeExec?.onStdout(data);
						return;
					}
					startupStdout =
						startupStdout.length === 0
							? data
							: Buffer.concat([startupStdout, data]).subarray(-MAX_STARTUP_DIAGNOSTIC_BYTES);
					const markerIndex = startupStdout.indexOf(POWERSHELL_SESSION_READY_BYTES);
					if (markerIndex === -1) return;
					const trailing = startupStdout.subarray(markerIndex + POWERSHELL_SESSION_READY_BYTES.length);
					settleStartup(resolve);
					if (trailing.length > 0) this.activeExec?.onStdout(trailing);
				},
				onStderr: (data) => {
					if (startupSettled) {
						this.activeExec?.onStderr(data);
						return;
					}
					startupStderr =
						startupStderr.length === 0
							? data
							: Buffer.concat([startupStderr, data]).subarray(-MAX_STARTUP_DIAGNOSTIC_BYTES);
				},
				onError: (error) => {
					this.resetChildState();
					if (!startupSettled) rejectStartup(new Error(`${error.message}${startupDiagnostic()}`));
					else this.activeExec?.fail(error);
				},
				onClose: (code) => {
					this.resetChildState();
					if (!startupSettled) {
						rejectStartup(new Error(`exited with code ${code ?? "null"} before readiness${startupDiagnostic()}`));
					} else {
						this.activeExec?.onChildClose(code);
					}
				},
			});
			timeoutTimer = setTimeout(() => {
				this.coordinator.kill();
				this.resetChildState();
				rejectStartup(new Error(`startup timed out after ${this.startupTimeoutMs}ms${startupDiagnostic()}`));
			}, this.startupTimeoutMs);
		});
	}

	private attachReadyChild(child: ChildProcess): void {
		this.coordinator.attach(child, {
			onStdout: (data) => this.activeExec?.onStdout(data),
			onStderr: (data) => this.activeExec?.onStderr(data),
			onError: (error) => {
				this.resetChildState();
				this.activeExec?.fail(error);
			},
			onClose: (code) => {
				this.resetChildState();
				this.activeExec?.onChildClose(code);
			},
		});
	}

	private resetChildState(): void {
		this.childEnv = null;
		this.lastRequestedCwd = null;
	}

	private killChild(): void {
		this.coordinator.kill();
		this.resetChildState();
	}
}

const shellSessions = new Map<string, PersistentShellSession>();

/** Get or lazily create the persistent session for a key. A kind change replaces the session. */
export function acquirePersistentShellSession(key: string, kind: PlatformShellToolName): PersistentShellSession {
	const existing = shellSessions.get(key);
	if (existing && existing.sessionKind === kind) return existing;
	existing?.dispose();
	const session = new PersistentShellSession(key, kind);
	shellSessions.set(key, session);
	return session;
}

/** Kill and forget a session (agent teardown). Safe to call for keys that never spawned. */
export function disposePersistentShellSession(key: string): void {
	const session = shellSessions.get(key);
	if (!session) return;
	shellSessions.delete(key);
	session.dispose();
}
