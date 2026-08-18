/**
 * Persistent shell sessions for the bash tool.
 *
 * One long-lived shell process per agent (keyed registry) replaces process-per-command spawning.
 * On Windows every command previously paid a full PowerShell boot; a persistent session pays it
 * once. Shell state (current directory, environment variables) persists across an agent's
 * commands; each key gets an isolated session so concurrently running agents never share state.
 *
 * Protocol: commands stream to the session over stdin and are terminated by a per-command
 * sentinel carrying a random nonce, the exit code, and (bash) the shell's `$PWD` so failures can
 * report where the command actually ran. Bash wraps commands in an eval of a quoted
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
 * stage to merge it) — it arrives on the session's own stderr pipe instead. A nonce-bearing barrier
 * on that pipe joins it deterministically with the stdout completion frame before the command
 * resolves. PowerShell 5.1's habit of wrapping redirected stderr text in a `NativeCommandError`
 * record also disappears, which is an accuracy improvement (the raw stderr bytes are reported,
 * not a wrapped/duplicated rendering of them).
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
	createPowerShellHostEnvironment,
	POWERSHELL_ARGS,
	POWERSHELL_BOOTSTRAP,
	POWERSHELL_SESSION_READY_MARKER,
	POWERSHELL_SESSION_STDERR_READY_MARKER,
	POWERSHELL_STDERR_BARRIER_LABEL,
} from "../../utils/powershell-session-protocol.ts";
import {
	getPowerShellCandidateConfigs,
	getShellConfig,
	getShellEnv,
	type PlatformShellToolName,
	POWERSHELL_STARTUP_PROBE_TIMEOUT_MS,
	type ShellConfig,
} from "../../utils/shell.ts";
import { claimCliPowerShellWarmStart } from "./early-powershell-session.ts";
import { PersistentProcessCoordinator } from "./persistent-process-coordinator.ts";

export {
	POWERSHELL_SESSION_READY_MARKER,
	POWERSHELL_SESSION_STDERR_READY_MARKER,
} from "../../utils/powershell-session-protocol.ts";

const SENTINEL_BYTE = 0x1e;
const BASH_SENTINEL_PAYLOAD_PREFIX = Buffer.from("v1:", "latin1");
const MAX_STARTUP_DIAGNOSTIC_BYTES = 16 * 1024;
const POWERSHELL_SESSION_READY_BYTES = Buffer.from(POWERSHELL_SESSION_READY_MARKER, "latin1");
const POWERSHELL_SESSION_STDERR_READY_BYTES = Buffer.from(POWERSHELL_SESSION_STDERR_READY_MARKER, "latin1");

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
		// Version and byte length make the frame unambiguous even when a legal POSIX path contains
		// the record-separator byte used to terminate the sentinel. The subshell keeps its status
		// scratch variable and LC_ALL change out of the persistent caller session.
		`(__pi_status=$?; LC_ALL=C; printf '\\n\\036%s:v1:%s:%s:%s\\036' '${nonce}' "$__pi_status" "\${#PWD}" "$PWD")`,
		"",
	].join("\n");
}

interface ParsedShellSentinel {
	closeIndex: number;
	exitCode: number | null;
	cwd?: string;
}

/** Parse the versioned bash frame plus the legacy exit-only/exit+cwd PowerShell test frames. */
function parseShellSentinel(buffer: Buffer, payloadStart: number): ParsedShellSentinel | undefined {
	const available = buffer.length - payloadStart;
	const prefixComparisonLength = Math.min(available, BASH_SENTINEL_PAYLOAD_PREFIX.length);
	const couldBeVersioned =
		prefixComparisonLength > 0 &&
		buffer.compare(
			BASH_SENTINEL_PAYLOAD_PREFIX,
			0,
			prefixComparisonLength,
			payloadStart,
			payloadStart + prefixComparisonLength,
		) === 0;
	if (couldBeVersioned && available < BASH_SENTINEL_PAYLOAD_PREFIX.length) return undefined;

	if (
		available >= BASH_SENTINEL_PAYLOAD_PREFIX.length &&
		buffer.compare(
			BASH_SENTINEL_PAYLOAD_PREFIX,
			0,
			BASH_SENTINEL_PAYLOAD_PREFIX.length,
			payloadStart,
			payloadStart + BASH_SENTINEL_PAYLOAD_PREFIX.length,
		) === 0
	) {
		const exitStart = payloadStart + BASH_SENTINEL_PAYLOAD_PREFIX.length;
		const exitEnd = buffer.indexOf(0x3a, exitStart);
		if (exitEnd === -1) return undefined;
		const lengthEnd = buffer.indexOf(0x3a, exitEnd + 1);
		if (lengthEnd === -1) return undefined;
		const exitCodeText = buffer.subarray(exitStart, exitEnd).toString("latin1");
		const cwdLengthText = buffer.subarray(exitEnd + 1, lengthEnd).toString("latin1");
		const cwdByteLength = /^\d+$/.test(cwdLengthText) ? Number.parseInt(cwdLengthText, 10) : Number.NaN;
		if (Number.isSafeInteger(cwdByteLength)) {
			const cwdStart = lengthEnd + 1;
			const closeIndex = cwdStart + cwdByteLength;
			if (buffer.length <= closeIndex) return undefined;
			if (buffer[closeIndex] === SENTINEL_BYTE) {
				const parsedExitCode = Number.parseInt(exitCodeText, 10);
				return {
					closeIndex,
					exitCode: Number.isNaN(parsedExitCode) ? null : parsedExitCode,
					...(cwdByteLength > 0 ? { cwd: buffer.subarray(cwdStart, closeIndex).toString("utf8") } : {}),
				};
			}
		}
		// A corrupt versioned payload must still settle like the legacy parser: retain the exit
		// classification when possible and degrade only the cwd field.
		const closeIndex = buffer.indexOf(SENTINEL_BYTE, lengthEnd + 1);
		if (closeIndex === -1) return undefined;
		const parsedExitCode = Number.parseInt(exitCodeText, 10);
		return { closeIndex, exitCode: Number.isNaN(parsedExitCode) ? null : parsedExitCode };
	}

	const closeIndex = buffer.indexOf(SENTINEL_BYTE, payloadStart);
	if (closeIndex === -1) return undefined;
	const payload = buffer.subarray(payloadStart, closeIndex);
	const separatorIndex = payload.indexOf(0x3a);
	const exitCodeText = (separatorIndex === -1 ? payload : payload.subarray(0, separatorIndex)).toString("latin1");
	const parsedExitCode = Number.parseInt(exitCodeText, 10);
	return {
		closeIndex,
		exitCode: Number.isNaN(parsedExitCode) ? null : parsedExitCode,
		...(separatorIndex !== -1 && separatorIndex < payload.length - 1
			? { cwd: payload.subarray(separatorIndex + 1).toString("utf8") }
			: {}),
	};
}

/** One protocol line: `<nonce> <base64(utf8 command)>`. Base64 keeps arbitrary multi-line commands line-safe. */
export function buildPowerShellWire(command: string, nonce: string, cdTo: string | null): string {
	const body = cdTo
		? `Set-Location -LiteralPath '${escapeSingleQuotesPowerShell(cdTo)}' -ErrorAction Stop\n${command}`
		: command;
	return `${nonce} ${Buffer.from(body, "utf8").toString("base64")}\n`;
}

function shallowEnvEquals(a: NodeJS.ProcessEnv, b: NodeJS.ProcessEnv): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (a[key] !== b[key]) return false;
	}
	return true;
}

function buildPowerShellEnvironmentPrelude(current: NodeJS.ProcessEnv, desired: NodeJS.ProcessEnv): string | null {
	const currentByName = new Map(
		Object.entries(current)
			.filter((entry): entry is [string, string] => entry[1] !== undefined)
			.map(([name, value]) => [name.toLowerCase(), { name, value }]),
	);
	const desiredByName = new Map(
		Object.entries(desired)
			.filter((entry): entry is [string, string] => entry[1] !== undefined)
			.map(([name, value]) => [name.toLowerCase(), { name, value }]),
	);
	const setValues = [...desiredByName.entries()].flatMap(([identity, entry]) =>
		currentByName.get(identity)?.value === entry.value ? [] : [entry],
	);
	const removeNames = [...currentByName.entries()].flatMap(([identity, entry]) =>
		desiredByName.has(identity) ? [] : [entry.name],
	);
	if (setValues.length === 0 && removeNames.length === 0) return null;
	const encoded = Buffer.from(JSON.stringify({ setValues, removeNames }), "utf8").toString("base64");
	return [
		`$__pi_env_delta = ConvertFrom-Json ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encoded}')))`,
		"foreach ($__pi_env_item in @($__pi_env_delta.setValues)) { [System.Environment]::SetEnvironmentVariable([string]$__pi_env_item.name, [string]$__pi_env_item.value, 'Process') }",
		"foreach ($__pi_env_name in @($__pi_env_delta.removeNames)) { [System.Environment]::SetEnvironmentVariable([string]$__pi_env_name, $null, 'Process') }",
		"Remove-Variable -Name __pi_env_delta,__pi_env_item,__pi_env_name -ErrorAction SilentlyContinue",
	].join("\n");
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
	exec(
		command: string,
		cwd: string,
		options: ShellSessionExecOptions,
	): Promise<{ exitCode: number | null; cwd?: string }> {
		return this.coordinator.runSerialized(() => this.execNow(command, cwd, options));
	}

	/** Start and validate the long-lived shell before the first user command. Idempotent per session. */
	prewarm(cwd: string, env: NodeJS.ProcessEnv = getShellEnv()): Promise<void> {
		return this.coordinator.runSerialized(async () => {
			if (this.disposed) throw new Error(`Shell session "${this.key}" is disposed`);
			const resolvedEnv = this.kind === "powershell" ? createPowerShellHostEnvironment(env) : env;
			if (
				this.kind !== "powershell" &&
				this.coordinator.child &&
				this.childEnv &&
				!shallowEnvEquals(this.childEnv, resolvedEnv)
			) {
				this.killChild();
			}
			if (!this.coordinator.child) await this.spawnChild(cwd, resolvedEnv);
			if (
				this.kind === "powershell" &&
				this.childEnv &&
				(!shallowEnvEquals(this.childEnv, resolvedEnv) || this.lastRequestedCwd !== cwd)
			) {
				const result = await this.execNow("", cwd, { onData: () => {}, env: resolvedEnv });
				if (result.exitCode !== 0) {
					this.killChild();
					throw new Error(`PowerShell session reconciliation failed with exit code ${result.exitCode ?? "null"}`);
				}
			}
			this.coordinator.setLoopRef(false);
		});
	}

	get terminalPromise(): Promise<void> {
		return this.coordinator.terminalPromise;
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
	): Promise<{ exitCode: number | null; cwd?: string }> {
		if (this.disposed) throw new Error(`Shell session "${this.key}" is disposed`);
		if (signal?.aborted) throw new Error("aborted");

		const requestedEnv = env ?? getShellEnv();
		const resolvedEnv = this.kind === "powershell" ? createPowerShellHostEnvironment(requestedEnv) : requestedEnv;
		// The environment is spawn-time shell config: an env that differs from the running
		// session's (e.g. a spawn hook rewriting it per command) requires a fresh shell.
		if (
			this.kind !== "powershell" &&
			this.coordinator.child &&
			this.childEnv &&
			!shallowEnvEquals(this.childEnv, resolvedEnv)
		) {
			this.killChild();
		}

		// Re-enter the host-requested cwd only when it CHANGES between calls; an unchanged
		// request preserves the agent's own in-session `cd` (that persistence is the feature).
		let cdTo: string | null = null;
		if (!this.coordinator.child) await this.spawnChild(cwd, resolvedEnv);
		if (this.lastRequestedCwd !== cwd) cdTo = cwd;
		this.lastRequestedCwd = cwd;
		let resolvedCommand = command;
		if (this.kind === "powershell" && this.childEnv && !shallowEnvEquals(this.childEnv, resolvedEnv)) {
			const environmentPrelude = buildPowerShellEnvironmentPrelude(this.childEnv, resolvedEnv);
			if (environmentPrelude) resolvedCommand = `${environmentPrelude}\n${command}`;
			this.childEnv = { ...resolvedEnv };
		}

		const child = this.coordinator.child;
		if (!child?.stdin || !child.stdout || !child.stderr) {
			this.killChild();
			throw new Error(`Failed to start ${this.kind} session`);
		}

		const nonce = randomBytes(8).toString("hex");
		const wire =
			this.kind === "powershell"
				? buildPowerShellWire(resolvedCommand, nonce, cdTo)
				: buildBashWire(resolvedCommand, nonce, cdTo);
		const sentinelPrefix = Buffer.from(`\n\x1e${nonce}:`, "latin1");
		const stderrBarrier = Buffer.from(`\x1e${nonce}:${POWERSHELL_STDERR_BARRIER_LABEL}\x1e\n`, "latin1");

		this.coordinator.setLoopRef(true);
		try {
			return await new Promise<{ exitCode: number | null; cwd?: string }>((resolve, reject) => {
				let settled = false;
				let stdoutPending: Buffer = Buffer.alloc(0);
				let stderrPending: Buffer = Buffer.alloc(0);
				let commandExitCode: number | null | undefined;
				let commandCwd: string | undefined;
				let stderrBarrierSeen = this.kind !== "powershell";
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

				const emitStdoutPending = (upTo: number) => {
					if (upTo <= 0) return;
					onData(stdoutPending.subarray(0, upTo));
					stdoutPending = stdoutPending.subarray(upTo);
				};
				const emitStderrPending = (upTo: number) => {
					if (upTo <= 0) return;
					onData(stderrPending.subarray(0, upTo));
					stderrPending = stderrPending.subarray(upTo);
				};
				const resolveWhenComplete = () => {
					const exitCode = commandExitCode;
					if (exitCode === undefined || !stderrBarrierSeen) return;
					settle(() => resolve({ exitCode, cwd: commandCwd }));
				};
				// Retain only a tail that could still be a sentinel in progress: a sentinel starts
				// with "\n" + 0x1e + nonce, so anything whose suffix is inconsistent with that
				// prefix streams through immediately. Once the random prefix matches, retain the
				// complete length-framed cwd rather than imposing a false filesystem path bound.
				const sentinelHoldback = (): number => {
					for (let index = 0; index < stdoutPending.length; index++) {
						if (stdoutPending[index] !== 0x0a) continue;
						if (index + 1 < stdoutPending.length && stdoutPending[index + 1] !== SENTINEL_BYTE) continue;
						const length = Math.min(stdoutPending.length - index, sentinelPrefix.length);
						if (stdoutPending.compare(sentinelPrefix, 0, length, index, index + length) === 0) {
							return stdoutPending.length - index;
						}
					}
					return 0;
				};

				this.activeExec = {
					onStdout: (data) => {
						silenceWatchdog?.touch();
						if (commandExitCode !== undefined) {
							onData(data);
							return;
						}
						stdoutPending = stdoutPending.length === 0 ? data : Buffer.concat([stdoutPending, data]);
						const prefixIndex = stdoutPending.indexOf(sentinelPrefix);
						if (prefixIndex !== -1) {
							const parsed = parseShellSentinel(stdoutPending, prefixIndex + sentinelPrefix.length);
							if (parsed) {
								emitStdoutPending(prefixIndex);
								stdoutPending = stdoutPending.subarray(parsed.closeIndex - prefixIndex + 1);
								emitStdoutPending(stdoutPending.length);
								commandExitCode = parsed.exitCode;
								commandCwd = parsed.cwd;
								resolveWhenComplete();
								return;
							}
						}
						// Stream promptly but retain any tail that could be a split sentinel.
						emitStdoutPending(stdoutPending.length - sentinelHoldback());
					},
					onStderr: (data) => {
						silenceWatchdog?.touch();
						if (this.kind !== "powershell" || stderrBarrierSeen) {
							onData(data);
							return;
						}
						stderrPending = stderrPending.length === 0 ? data : Buffer.concat([stderrPending, data]);
						const barrierIndex = stderrPending.indexOf(stderrBarrier);
						if (barrierIndex !== -1) {
							emitStderrPending(barrierIndex);
							stderrPending = stderrPending.subarray(stderrBarrier.length);
							emitStderrPending(stderrPending.length);
							stderrBarrierSeen = true;
							resolveWhenComplete();
							return;
						}
						// Preserve enough bytes to recognize a barrier split across chunks.
						emitStderrPending(stderrPending.length - stderrBarrier.length + 1);
					},
					onChildClose: (code) => {
						// The command terminated the shell itself (e.g. `exit 3`) or the shell
						// crashed: report its exit code like the per-command backend would.
						emitStdoutPending(stdoutPending.length);
						emitStderrPending(stderrPending.length);
						settle(() => resolve({ exitCode: code }));
					},
					fail: (error) => {
						this.killChild();
						settle(() => reject(error));
					},
				};

				if (signal) {
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) {
						onAbort();
						return;
					}
				}
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
		let spawnedCwd = cwd;
		let spawnedEnv = env;
		if (this.kind === "powershell") {
			({ cwd: spawnedCwd, env: spawnedEnv } = await this.spawnPowerShellChild(cwd, env));
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
		this.childEnv = { ...spawnedEnv };
		this.lastRequestedCwd = spawnedCwd;
	}

	private async spawnPowerShellChild(
		cwd: string,
		env: NodeJS.ProcessEnv,
	): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> {
		const warmStart = await claimCliPowerShellWarmStart();
		if (warmStart) {
			try {
				this.attachReadyChild(warmStart.child);
			} finally {
				warmStart.releaseStartupListeners();
			}
			return { cwd: warmStart.cwd, env: warmStart.env };
		}
		const failures: string[] = [];
		for (const candidate of this.resolvePowerShellCandidates()) {
			try {
				await this.spawnPowerShellCandidate(candidate.shell, cwd, env);
				return { cwd, env };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push(`${candidate.shell}: ${message}`);
			}
		}
		const detail = failures.length > 0 ? ` Candidate failures: ${failures.join("; ")}` : "";
		throw new Error(`PowerShell 7 (pwsh) was not found. Install pwsh before using the Windows shell.${detail}`);
	}

	private spawnPowerShellCandidate(shell: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let startupSettled = false;
			let startupStdout: Buffer = Buffer.alloc(0);
			let startupStderr: Buffer = Buffer.alloc(0);
			let stdoutReady = false;
			let stderrReady = false;
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
			const resolveWhenReady = (): void => {
				if (!stdoutReady || !stderrReady) return;
				settleStartup(resolve);
			};

			let child: ChildProcess;
			try {
				child = this.spawnProcess(shell, [...POWERSHELL_ARGS, POWERSHELL_BOOTSTRAP], {
					cwd,
					env,
					detached: process.platform !== "win32",
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				});
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
					stdoutReady ||= startupStdout.indexOf(POWERSHELL_SESSION_READY_BYTES) !== -1;
					resolveWhenReady();
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
					stderrReady ||= startupStderr.indexOf(POWERSHELL_SESSION_STDERR_READY_BYTES) !== -1;
					resolveWhenReady();
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
const retiredShellSessionTerminals = new Map<string, Promise<void>>();

function retainShellSessionTerminal(key: string, terminalPromise: Promise<void>): Promise<void> {
	const previous = retiredShellSessionTerminals.get(key);
	const combined = Promise.all([previous ?? Promise.resolve(), terminalPromise])
		.then(() => undefined)
		.finally(() => {
			if (retiredShellSessionTerminals.get(key) === combined) {
				retiredShellSessionTerminals.delete(key);
			}
		});
	retiredShellSessionTerminals.set(key, combined);
	return combined;
}

/** Get or lazily create the persistent session for a key. A kind change replaces the session. */
export function acquirePersistentShellSession(key: string, kind: PlatformShellToolName): PersistentShellSession {
	const existing = shellSessions.get(key);
	if (existing && existing.sessionKind === kind) return existing;
	if (existing) {
		existing.dispose();
		retainShellSessionTerminal(key, existing.terminalPromise);
	}
	const session = new PersistentShellSession(key, kind);
	shellSessions.set(key, session);
	return session;
}

/** Kill and forget a session (agent teardown). Safe to call for keys that never spawned. */
export function disposePersistentShellSession(key: string): Promise<void> {
	const session = shellSessions.get(key);
	if (!session) return retiredShellSessionTerminals.get(key) ?? Promise.resolve();
	shellSessions.delete(key);
	session.dispose();
	return retainShellSessionTerminal(key, session.terminalPromise);
}
