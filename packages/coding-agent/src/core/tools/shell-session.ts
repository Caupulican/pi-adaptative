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
 * ReadLine loop decoding base64 lines (no external binaries involved). Command stderr is merged
 * into stdout at the shell so sentinel ordering is guaranteed on one pipe — the per-command
 * backend already delivered both streams to a single merged accumulator.
 *
 * Kill semantics: timeout/abort/silence kill the WHOLE session process tree (a hung foreground
 * command cannot be killed individually without job control) and the next exec respawns a fresh
 * session, losing accumulated shell state by design. A command that exits the shell itself
 * (`exit 3`) reports the shell's exit code and also respawns lazily afterwards.
 */

import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { createSilenceWatchdog } from "@caupulican/pi-agent-core";
import { type ChildProcess, spawn, spawnSync } from "child_process";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	type PlatformShellToolName,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";

const SENTINEL_BYTE = 0x1e;
/** Longest possible sentinel: "\n" + 0x1e + 16-hex nonce + ":" + exit code digits + 0x1e. */
const SENTINEL_HOLDBACK_BYTES = 64;

export interface ShellSessionExecOptions {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	/** Wall-clock bound in seconds; when set, a breach kills the session and throws `timeout:<s>`. */
	timeoutSeconds?: number;
	/** Output-silence bound in ms; when set, silence kills the session and throws `silence:<s>`. */
	silenceMs?: number;
	env?: NodeJS.ProcessEnv;
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
 * Passed via -EncodedCommand so quoting and newlines never touch the process command line.
 */
const POWERSHELL_BOOTSTRAP = [
	"$ProgressPreference = 'SilentlyContinue'",
	"try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
	"$__pi_in = [Console]::In",
	"while ($true) {",
	"\t$__pi_line = $__pi_in.ReadLine()",
	"\tif ($null -eq $__pi_line) { break }",
	"\t$__pi_sp = $__pi_line.IndexOf(' ')",
	"\tif ($__pi_sp -lt 1) { continue }",
	"\t$__pi_nonce = $__pi_line.Substring(0, $__pi_sp)",
	"\t$__pi_cmd = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($__pi_line.Substring($__pi_sp + 1)))",
	"\t$global:LASTEXITCODE = 0",
	"\t$__pi_thrown = $false",
	"\ttry { Invoke-Expression $__pi_cmd 2>&1 | Out-Default } catch { $__pi_thrown = $true; $__pi_msg = ($_ | Out-String).TrimEnd(); if ($__pi_msg) { [Console]::Out.WriteLine($__pi_msg) } }",
	"\t$__pi_code = $global:LASTEXITCODE",
	"\tif ($null -eq $__pi_code) { $__pi_code = 0 }",
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
	private child: ChildProcess | null = null;
	private childEnv: NodeJS.ProcessEnv | null = null;
	private lastRequestedCwd: string | null = null;
	private activeExec: ActiveExec | null = null;
	private queue: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(key: string, kind: PlatformShellToolName) {
		this.key = key;
		this.kind = kind;
	}

	get sessionKind(): PlatformShellToolName {
		return this.kind;
	}

	/** Serialized: one command at a time per session, later calls queue behind earlier ones. */
	exec(command: string, cwd: string, options: ShellSessionExecOptions): Promise<{ exitCode: number | null }> {
		const run = this.queue.then(() => this.execNow(command, cwd, options));
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	dispose(): void {
		this.disposed = true;
		this.killChild();
	}

	/** Synchronous best-effort kill for process-exit hooks (async spawn never runs during exit). */
	killForProcessExit(): void {
		const pid = this.child?.pid;
		this.child = null;
		if (!pid) return;
		untrackDetachedChildPid(pid);
		if (process.platform === "win32") {
			try {
				spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
			} catch {
				// Best effort only.
			}
			return;
		}
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already dead.
			}
		}
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
		if (this.child && this.childEnv && !shallowEnvEquals(this.childEnv, resolvedEnv)) {
			this.killChild();
		}

		// Re-enter the host-requested cwd only when it CHANGES between calls; an unchanged
		// request preserves the agent's own in-session `cd` (that persistence is the feature).
		let cdTo: string | null = null;
		if (!this.child) {
			this.spawnChild(cwd, resolvedEnv);
		} else if (this.lastRequestedCwd !== cwd) {
			cdTo = cwd;
		}
		this.lastRequestedCwd = cwd;

		const child = this.child;
		if (!child?.stdin || !child.stdout || !child.stderr) {
			this.killChild();
			throw new Error(`Failed to start ${this.kind} session`);
		}

		const nonce = randomBytes(8).toString("hex");
		const wire =
			this.kind === "powershell" ? buildPowerShellWire(command, nonce, cdTo) : buildBashWire(command, nonce, cdTo);
		const sentinelPrefix = Buffer.from(`\n\x1e${nonce}:`, "latin1");

		this.setLoopRef(true);
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
								settle(() => resolve({ exitCode: Number.isNaN(parsed) ? null : parsed }));
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
			this.setLoopRef(false);
		}
	}

	private spawnChild(cwd: string, env: NodeJS.ProcessEnv): void {
		const { shell } = getShellConfig(undefined, this.kind);
		const args =
			this.kind === "powershell"
				? [
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-EncodedCommand",
						Buffer.from(POWERSHELL_BOOTSTRAP, "utf16le").toString("base64"),
					]
				: basename(shell).toLowerCase().includes("bash")
					? ["--noprofile", "--norc"]
					: [];
		const child = spawn(shell, args, {
			cwd,
			env,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		if (child.pid) trackDetachedChildPid(child.pid);
		// Every listener gates on the child still being the session's current one: after a
		// timeout/abort kill replaced it, the dead shell's late data/close events are stale noise
		// that must never reach the NEXT command's handlers.
		child.stdout?.on("data", (data: Buffer) => {
			if (this.child === child) this.activeExec?.onStdout(data);
		});
		child.stderr?.on("data", (data: Buffer) => {
			if (this.child === child) this.activeExec?.onStderr(data);
		});
		child.on("error", (error) => {
			if (this.child !== child) return;
			this.clearChild(child);
			this.activeExec?.fail(error instanceof Error ? error : new Error(String(error)));
		});
		child.on("close", (code) => {
			if (this.child !== child) return;
			this.clearChild(child);
			this.activeExec?.onChildClose(code);
		});
		this.child = child;
		this.childEnv = env;
		this.lastRequestedCwd = cwd;
	}

	private clearChild(child: ChildProcess): void {
		if (child.pid) untrackDetachedChildPid(child.pid);
		this.child = null;
		this.childEnv = null;
		this.lastRequestedCwd = null;
	}

	private killChild(): void {
		const child = this.child;
		if (!child) return;
		this.clearChild(child);
		if (child.pid) killProcessTree(child.pid);
	}

	/**
	 * An idle session must not keep the Node event loop alive (one-shot modes have to exit
	 * naturally); during a command the child and its pipes are re-referenced so the loop stays
	 * alive even without an armed timer.
	 */
	private setLoopRef(active: boolean): void {
		const child = this.child;
		if (!child) return;
		// Stdio pipes are Sockets at runtime (ref/unref exist) but are typed as plain streams.
		const streams = [child.stdin, child.stdout, child.stderr] as unknown as Array<{
			ref?: () => void;
			unref?: () => void;
		} | null>;
		if (active) {
			child.ref();
			for (const stream of streams) stream?.ref?.();
		} else {
			child.unref();
			for (const stream of streams) stream?.unref?.();
		}
	}
}

const shellSessions = new Map<string, PersistentShellSession>();
let exitHookInstalled = false;

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	// Detached sessions outlive the parent on clean exits unless explicitly killed; shutdown
	// signals are already covered by the tracked-detached-children mechanism.
	process.on("exit", () => {
		for (const session of shellSessions.values()) {
			session.killForProcessExit();
		}
	});
}

/** Get or lazily create the persistent session for a key. A kind change replaces the session. */
export function acquirePersistentShellSession(key: string, kind: PlatformShellToolName): PersistentShellSession {
	installExitHook();
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
