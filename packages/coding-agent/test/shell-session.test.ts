import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SpawnOptions, spawn, spawnSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquirePersistentShellSession,
	disposePersistentShellSession,
	PersistentShellSession,
	POWERSHELL_SESSION_READY_MARKER,
	POWERSHELL_SESSION_STDERR_READY_MARKER,
	type ShellSessionExecOptions,
} from "../src/core/tools/shell-session.ts";
import { POWERSHELL_STARTUP_PROBE_TIMEOUT_MS } from "../src/utils/shell.ts";

const IS_WINDOWS = process.platform === "win32";

function pwshAvailable(): boolean {
	const executable = IS_WINDOWS ? "pwsh.exe" : "pwsh";
	try {
		return (
			spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output ok"], {
				encoding: "utf-8",
				timeout: POWERSHELL_STARTUP_PROBE_TIMEOUT_MS,
				windowsHide: true,
			}).status === 0
		);
	} catch {
		return false;
	}
}

const HAS_POWERSHELL = IS_WINDOWS || pwshAvailable();

function bashAvailable(): boolean {
	try {
		return spawnSync("bash", ["-c", "true"], { encoding: "utf-8", timeout: 15_000 }).status === 0;
	} catch {
		return false;
	}
}

const HAS_BASH = bashAvailable();

interface RunResult {
	exitCode: number | null;
	output: string;
}

async function run(
	session: PersistentShellSession,
	command: string,
	cwd: string,
	options?: Partial<ShellSessionExecOptions>,
): Promise<RunResult> {
	const chunks: Buffer[] = [];
	const { exitCode } = await session.exec(command, cwd, {
		onData: (data) => chunks.push(data),
		...options,
	});
	return { exitCode, output: Buffer.concat(chunks).toString("utf8") };
}

const liveKeys: string[] = [];

function makeSession(kind: "bash" | "powershell"): PersistentShellSession {
	const key = `test-shell-session-${liveKeys.length}-${Math.random().toString(36).slice(2)}`;
	liveKeys.push(key);
	return acquirePersistentShellSession(key, kind);
}

afterEach(() => {
	for (const key of liveKeys) disposePersistentShellSession(key);
	liveKeys.length = 0;
});

describe("PersistentShellSession startup", () => {
	it("prewarms one usable PowerShell process and falls back without a disposable probe", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-shell-prewarm-"));
		const badFixture = join(directory, "bad-powershell.mjs");
		const goodFixture = join(directory, "good-powershell.mjs");
		writeFileSync(badFixture, "process.exit(9);\n");
		writeFileSync(
			goodFixture,
			`const marker = ${JSON.stringify(POWERSHELL_SESSION_READY_MARKER)};
const stderrMarker = ${JSON.stringify(POWERSHELL_SESSION_STDERR_READY_MARKER)};
process.stderr.write(stderrMarker);
process.stdout.write(marker.slice(0, 4));
setImmediate(() => process.stdout.write(marker.slice(4)));
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	pending += chunk;
	let newline = pending.indexOf("\\n");
	while (newline !== -1) {
		const line = pending.slice(0, newline);
		pending = pending.slice(newline + 1);
		const separator = line.indexOf(" ");
		const nonce = line.slice(0, separator);
		process.stderr.write("\\x1e" + nonce + ":stderr\\x1e\\n");
		process.stdout.write("ok\\n\\n\\x1e" + nonce + ":0\\x1e");
		newline = pending.indexOf("\\n");
	}
});
`,
		);
		chmodSync(badFixture, 0o755);
		chmodSync(goodFixture, 0o755);

		const spawnCalls: string[] = [];
		const spawnEnvironments: Array<NodeJS.ProcessEnv | undefined> = [];
		let resolutionCalls = 0;
		const session = new PersistentShellSession("prewarm-fallback", "powershell", {
			resolvePowerShellCandidates: () => {
				resolutionCalls += 1;
				return [
					{ shell: "bad-powershell", args: [] },
					{ shell: "good-powershell", args: [] },
				];
			},
			spawn: (command: string, args: string[], options: SpawnOptions) => {
				spawnCalls.push(command);
				spawnEnvironments.push(options.env);
				const fixture = command === "bad-powershell" ? badFixture : goodFixture;
				return spawn(process.execPath, [fixture, ...args], options);
			},
			startupTimeoutMs: 2_000,
		});
		try {
			const firstPrewarm = session.prewarm(process.cwd(), process.env);
			const repeatedPrewarm = session.prewarm(process.cwd(), process.env);
			const command = run(session, "Write-Output ok", process.cwd(), { env: process.env });
			await Promise.all([firstPrewarm, repeatedPrewarm]);
			expect(await command).toEqual({
				exitCode: 0,
				output: "ok\n",
			});
			expect(resolutionCalls).toBe(1);
			expect(spawnCalls).toEqual(["bad-powershell", "good-powershell"]);
			for (const environment of spawnEnvironments) {
				expect(environment).toMatchObject({
					NO_COLOR: "1",
					POWERSHELL_DIAGNOSTICS_OPTOUT: "1",
					POWERSHELL_TELEMETRY_OPTOUT: "1",
					POWERSHELL_UPDATECHECK: "Off",
				});
			}
		} finally {
			session.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("waits for delayed PowerShell stderr before resolving a command", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-shell-stderr-barrier-"));
		const fixture = join(directory, "powershell-fixture.mjs");
		writeFileSync(
			fixture,
			`const marker = ${JSON.stringify(POWERSHELL_SESSION_READY_MARKER)};
const stderrMarker = ${JSON.stringify(POWERSHELL_SESSION_STDERR_READY_MARKER)};
process.stderr.write(stderrMarker);
process.stdout.write(marker);
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	pending += chunk;
	let newline = pending.indexOf("\\n");
	while (newline !== -1) {
		const line = pending.slice(0, newline);
		pending = pending.slice(newline + 1);
		const separator = line.indexOf(" ");
		const nonce = line.slice(0, separator);
		process.stdout.write("host-before-stderr\\n\\n\\x1e" + nonce + ":0\\x1e");
		setTimeout(
			() => process.stderr.write("late-stderr\\x1e" + nonce + ":stderr\\x1e\\n"),
			50,
		);
		newline = pending.indexOf("\\n");
	}
});
`,
		);
		chmodSync(fixture, 0o755);

		const session = new PersistentShellSession("stderr-barrier", "powershell", {
			resolvePowerShellCandidates: () => [{ shell: "fixture-powershell", args: [] }],
			spawn: (_command: string, args: string[], options: SpawnOptions) =>
				spawn(process.execPath, [fixture, ...args], options),
			startupTimeoutMs: 2_000,
		});
		try {
			expect(await run(session, "Write-Output ignored", process.cwd())).toEqual({
				exitCode: 0,
				output: "host-before-stderr\nlate-stderr",
			});
		} finally {
			session.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("PersistentShellSession sentinel cwd parsing", () => {
	function makeFixtureSession(fixture: string, key: string): PersistentShellSession {
		return new PersistentShellSession(key, "powershell", {
			resolvePowerShellCandidates: () => [{ shell: "fixture-powershell", args: [] }],
			spawn: (_command: string, args: string[], options: SpawnOptions) =>
				spawn(process.execPath, [fixture, ...args], options),
			startupTimeoutMs: 2_000,
		});
	}

	it("degrades a missing or empty cwd segment to undefined without failing the exec", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-shell-cwd-degrade-"));
		const fixture = join(directory, "degrade-fixture.mjs");
		writeFileSync(
			fixture,
			`const marker = ${JSON.stringify(POWERSHELL_SESSION_READY_MARKER)};
const stderrMarker = ${JSON.stringify(POWERSHELL_SESSION_STDERR_READY_MARKER)};
process.stderr.write(stderrMarker);
process.stdout.write(marker);
let commands = 0;
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	pending += chunk;
	let newline = pending.indexOf("\\n");
	while (newline !== -1) {
		const line = pending.slice(0, newline);
		pending = pending.slice(newline + 1);
		const separator = line.indexOf(" ");
		const nonce = line.slice(0, separator);
		commands += 1;
		process.stderr.write("\\x1e" + nonce + ":stderr\\x1e\\n");
		const payload = commands === 1 ? ":5" : ":0:";
		process.stdout.write("data\\n\\n\\x1e" + nonce + payload + "\\x1e");
		newline = pending.indexOf("\\n");
	}
});
`,
		);
		const session = makeFixtureSession(fixture, "cwd-degrade");
		try {
			const missing = await session.exec("first", process.cwd(), { onData: () => {} });
			expect(missing.exitCode).toBe(5);
			expect(missing.cwd).toBeUndefined();
			const empty = await session.exec("second", process.cwd(), { onData: () => {} });
			expect(empty.exitCode).toBe(0);
			expect(empty.cwd).toBeUndefined();
		} finally {
			session.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reassembles a sentinel with a long colon-and-multibyte cwd split across chunks", async () => {
		const expectedCwd = `/tmp/pi split:colon é${"x".repeat(2000)}`;
		const directory = mkdtempSync(join(tmpdir(), "pi-shell-cwd-split-"));
		const fixture = join(directory, "split-fixture.mjs");
		writeFileSync(
			fixture,
			`const marker = ${JSON.stringify(POWERSHELL_SESSION_READY_MARKER)};
const stderrMarker = ${JSON.stringify(POWERSHELL_SESSION_STDERR_READY_MARKER)};
process.stderr.write(stderrMarker);
process.stdout.write(marker);
const cwdBytes = Buffer.from(${JSON.stringify(expectedCwd)}, "utf8");
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	pending += chunk;
	let newline = pending.indexOf("\\n");
	while (newline !== -1) {
		const line = pending.slice(0, newline);
		pending = pending.slice(newline + 1);
		const separator = line.indexOf(" ");
		const nonce = line.slice(0, separator);
		process.stderr.write("\\x1e" + nonce + ":stderr\\x1e\\n");
		process.stdout.write("head ");
		setImmediate(() => {
			process.stdout.write("output\\n");
			setImmediate(() => {
				process.stdout.write("\\n\\x1e" + nonce.slice(0, 6));
				setImmediate(() => {
					// Split inside the nonce, at a colon, and mid-multibyte-character.
					process.stdout.write(
						Buffer.concat([Buffer.from(nonce.slice(6) + ":3:", "utf8"), cwdBytes.subarray(0, 21)]),
					);
					setImmediate(() => process.stdout.write(Buffer.concat([cwdBytes.subarray(21), Buffer.from("\\x1e", "latin1")])));
				});
			});
		});
		newline = pending.indexOf("\\n");
	}
});
`,
		);
		const session = makeFixtureSession(fixture, "cwd-split");
		try {
			const chunks: Buffer[] = [];
			const result = await session.exec("go", process.cwd(), { onData: (data) => chunks.push(data) });
			expect(result).toEqual({ exitCode: 3, cwd: expectedCwd });
			expect(Buffer.concat(chunks).toString("utf8")).toBe("head output\n");
		} finally {
			session.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe.skipIf(IS_WINDOWS)("PersistentShellSession (bash)", () => {
	const cwd = process.cwd();

	it("persists environment variables and cwd across commands", async () => {
		const session = makeSession("bash");
		const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-shell-session-")));
		try {
			expect(await run(session, "export PI_SESSION_PROBE=alive", cwd)).toEqual({ exitCode: 0, output: "" });
			expect((await run(session, "echo $PI_SESSION_PROBE", cwd)).output.trim()).toBe("alive");
			expect((await run(session, `cd '${tempDir}' && pwd`, cwd)).output.trim()).toBe(tempDir);
			// Unchanged host cwd: the agent's own `cd` persists.
			expect((await run(session, "pwd", cwd)).output.trim()).toBe(tempDir);
			// Changed host cwd: the session follows the host.
			expect((await run(session, "pwd", tmpdir())).output.trim()).toBe(realpathSync(tmpdir()));
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("reports exit codes without losing the session", async () => {
		const session = makeSession("bash");
		expect((await run(session, "false", cwd)).exitCode).toBe(1);
		expect((await run(session, "(exit 7)", cwd)).exitCode).toBe(7);
		expect((await run(session, "echo still-here", cwd)).output.trim()).toBe("still-here");
	});

	it("survives a command that exits the shell and respawns with fresh state", async () => {
		const session = makeSession("bash");
		await run(session, "export PI_DOOMED=1", cwd);
		expect((await run(session, "exit 3", cwd)).exitCode).toBe(3);
		const after = await run(session, 'echo "doomed=[$PI_DOOMED]"', cwd);
		expect(after.exitCode).toBe(0);
		expect(after.output.trim()).toBe("doomed=[]");
	});

	it("settles a compound diagnostic command that ends in exit zero", async () => {
		const session = makeSession("bash");
		const result = await run(session, `false; rc=$?; printf 'exit=%s\\n' "$rc"; exit 0`, cwd);

		expect(result).toEqual({ exitCode: 0, output: "exit=1\n" });
		expect((await run(session, "printf recovered", cwd)).output).toBe("recovered");
	});

	it("contains syntax errors without killing the session", async () => {
		const session = makeSession("bash");
		const bad = await run(session, "if then fi", cwd);
		expect(bad.exitCode).not.toBe(0);
		expect((await run(session, "echo recovered", cwd)).output.trim()).toBe("recovered");
	});

	it("reports the shell-reported cwd with the exit code after an in-session cd", async () => {
		const session = makeSession("bash");
		const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-shell-cwd-")));
		try {
			const result = await session.exec(`cd '${tempDir}' && false`, cwd, { onData: () => {} });
			expect(result).toEqual({ exitCode: 1, cwd: tempDir });
			// An unchanged host cwd preserves the in-session cd; the report follows it.
			const followUp = await session.exec("(exit 7)", cwd, { onData: () => {} });
			expect(followUp).toEqual({ exitCode: 7, cwd: tempDir });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("parses a cwd containing colons whole", async () => {
		const session = makeSession("bash");
		const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-shell-colon-")));
		const colonDir = join(base, "a:b:c");
		mkdirSync(colonDir);
		try {
			const result = await session.exec(`cd '${colonDir}' && (exit 4)`, cwd, { onData: () => {} });
			expect(result).toEqual({ exitCode: 4, cwd: colonDir });
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("reports the stale $PWD when the current directory was deleted before a failure", async () => {
		const session = makeSession("bash");
		const doomed = realpathSync(mkdtempSync(join(tmpdir(), "pi-shell-doomed-")));
		const result = await session.exec(`cd '${doomed}' && rmdir '${doomed}' && false`, cwd, { onData: () => {} });
		expect(result).toEqual({ exitCode: 1, cwd: doomed });
	});

	it("passes nonce-like fake sentinels through as data and still parses the real one", async () => {
		const session = makeSession("bash");
		const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-shell-fake-")));
		try {
			const chunks: Buffer[] = [];
			const result = await session.exec(
				`printf '\\n\\0360123456789abcdef:999:/bogus\\036\\n'; cd '${tempDir}' && false`,
				cwd,
				{ onData: (data) => chunks.push(data) },
			);
			expect(result).toEqual({ exitCode: 1, cwd: tempDir });
			expect(Buffer.concat(chunks).toString("utf8")).toContain("\x1e0123456789abcdef:999:/bogus\x1e");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("handles hostile quoting, multi-line commands, and sentinel-byte output", async () => {
		const session = makeSession("bash");
		const tricky = await run(session, `printf '%s\\n' "d'oh" 'a"b' 'x\`y'\nprintf 'tail-no-newline'`, cwd);
		expect(tricky.exitCode).toBe(0);
		expect(tricky.output).toBe(`d'oh\na"b\nx\`y\ntail-no-newline`);
		const sentinelish = await run(session, "printf '\\036deadbeefdeadbeef:0\\036'", cwd);
		expect(sentinelish.exitCode).toBe(0);
		expect(sentinelish.output).toBe("deadbeefdeadbeef:0");
	});

	it("streams large output intact", async () => {
		const session = makeSession("bash");
		const result = await run(session, "seq 1 20000", cwd);
		expect(result.exitCode).toBe(0);
		const lines = result.output.trim().split("\n");
		expect(lines.length).toBe(20000);
		expect(lines[0]).toBe("1");
		expect(lines.at(-1)).toBe("20000");
	});

	it("kills the session on timeout and recovers on the next command", async () => {
		const session = makeSession("bash");
		await run(session, "export PI_BEFORE_TIMEOUT=1", cwd);
		await expect(run(session, "sleep 5", cwd, { timeoutSeconds: 0.3 })).rejects.toThrow("timeout:0.3");
		const after = await run(session, 'echo "probe=[$PI_BEFORE_TIMEOUT]"', cwd);
		expect(after.output.trim()).toBe("probe=[]");
	});

	it("kills the session on abort", async () => {
		const session = makeSession("bash");
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		await expect(run(session, "sleep 5", cwd, { signal: controller.signal })).rejects.toThrow("aborted");
		expect((await run(session, "echo back", cwd)).output.trim()).toBe("back");
	});

	it("kills the session on output silence", async () => {
		const session = makeSession("bash");
		await expect(run(session, "sleep 5", cwd, { silenceMs: 300 })).rejects.toThrow("silence:0.3");
		expect((await run(session, "echo back", cwd)).output.trim()).toBe("back");
	});

	it("isolates sessions with different keys", async () => {
		const first = makeSession("bash");
		const second = makeSession("bash");
		await run(first, "export PI_ISOLATION=first-only", cwd);
		expect((await run(second, 'echo "iso=[$PI_ISOLATION]"', cwd)).output.trim()).toBe("iso=[]");
		expect((await run(first, "echo $PI_ISOLATION", cwd)).output.trim()).toBe("first-only");
	});

	it("respawns when the caller provides a different environment", async () => {
		const session = makeSession("bash");
		const envA = { ...process.env, PI_ENV_MARKER: "a" };
		await run(session, "export PI_SURVIVES=1", cwd, { env: envA });
		expect((await run(session, "echo $PI_SURVIVES", cwd, { env: envA })).output.trim()).toBe("1");
		const envB = { ...process.env, PI_ENV_MARKER: "b" };
		const after = await run(session, 'echo "survives=[$PI_SURVIVES]:$PI_ENV_MARKER"', cwd, { env: envB });
		expect(after.output.trim()).toBe("survives=[]:b");
	});

	it("serializes concurrent commands on one session", async () => {
		const session = makeSession("bash");
		const [first, second] = await Promise.all([
			run(session, "sleep 0.2; echo first", cwd),
			run(session, "echo second", cwd),
		]);
		expect(first.output.trim()).toBe("first");
		expect(second.output.trim()).toBe("second");
	});

	it("returns the same session for the same key and a fresh one after dispose", async () => {
		const key = "test-shell-session-registry";
		liveKeys.push(key);
		const first = acquirePersistentShellSession(key, "bash");
		expect(acquirePersistentShellSession(key, "bash")).toBe(first);
		disposePersistentShellSession(key);
		expect(acquirePersistentShellSession(key, "bash")).not.toBe(first);
	});

	it("rejects the active command when its owning session is disposed", async () => {
		const session = makeSession("bash");
		let reportStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			reportStarted = resolve;
		});
		// The protocol retains only a sentinel-consistent tail while scanning; this
		// newline-free marker therefore streams immediately.
		const active = session.exec("printf 'started%080d' 0; sleep 30", cwd, {
			onData: (data) => {
				if (data.includes("started")) reportStarted?.();
			},
		});

		await started;
		session.dispose();

		let pendingTimer: NodeJS.Timeout | undefined;
		const outcome = await Promise.race([
			active.then(
				() => "resolved",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			),
			new Promise<string>((resolve) => {
				pendingTimer = setTimeout(() => resolve("pending"), 250);
			}),
		]);
		if (pendingTimer) clearTimeout(pendingTimer);

		expect(outcome).toContain("is disposed");
	}, 1_500);
});

describe.skipIf(!HAS_POWERSHELL)("PersistentShellSession (powershell)", () => {
	const cwd = process.cwd();

	it("keeps the native code page while preserving managed Unicode output", async () => {
		const session = makeSession("powershell");
		const result = await run(
			session,
			"$__pi_cp = [Console]::OutputEncoding.CodePage; Write-Output 'ação 日本 €'; Write-Output ('codepage=' + $__pi_cp + ':' + [Console]::OutputEncoding.CodePage)",
			cwd,
		);
		expect(result.output).toContain("ação 日本 €");
		const codePages = result.output.match(/codepage=(\d+):(\d+)/u);
		expect(codePages?.[1]).toBe(codePages?.[2]);
	});

	it("persists state across commands and reports native exit codes", async () => {
		const session = makeSession("powershell");
		expect((await run(session, "$pi_probe = 'alive'", cwd)).exitCode).toBe(0);
		expect((await run(session, "Write-Output $pi_probe", cwd)).output.trim()).toBe("alive");
	});

	it("reports failure exit codes and keeps the session alive", async () => {
		const session = makeSession("powershell");
		const bad = await run(session, "throw 'boom'", cwd);
		expect(bad.exitCode).toBe(1);
		expect(bad.output).toContain("boom");
		expect((await run(session, "Write-Output recovered", cwd)).output.trim()).toBe("recovered");
	});

	it("survives a command that exits the shell", async () => {
		const session = makeSession("powershell");
		expect((await run(session, "exit 5", cwd)).exitCode).toBe(5);
		expect((await run(session, "Write-Output back", cwd)).output.trim()).toBe("back");
	});

	it("emits host and stderr text once without CLIXML serialization", async () => {
		const session = makeSession("powershell");
		const result = await run(session, "Write-Host 'pi-host-line'; [Console]::Error.WriteLine('pi-stderr-line')", cwd);

		expect(result.exitCode).toBe(0);
		expect(result.output.match(/pi-host-line/gu)).toHaveLength(1);
		expect(result.output.match(/pi-stderr-line/gu)).toHaveLength(1);
		expect(result.output).not.toContain("#< CLIXML");
		expect(result.output).not.toContain("<Objs Version=");
	});
});

// This is Node event-loop semantics, not Windows-specific behavior: Node only fires a child
// process's "close" event once every inherited stdio stream has ended. A detached grandchild that
// inherits the shell's stdout/stderr pipes (e.g. a backgrounded job started right before the shell
// exits) keeps those pipes open long after the shell itself is dead, so "close" never fires while
// the grandchild lives — even on Linux. Gated on tool availability, not platform, so the class is
// enforced on every CI lane.
describe.skipIf(!HAS_BASH)("PersistentShellSession (shell dies under a live grandchild)", () => {
	const cwd = process.cwd();

	it("resolves promptly when the shell exits while a backgrounded grandchild still holds the inherited stdio pipes", async () => {
		const session = makeSession("bash");
		const start = Date.now();
		// `sleep 30 &` backgrounds a grandchild that inherits this bash process's stdout/stderr pipe
		// before `exit 3` kills the shell itself. If settlement waited on "close" instead of "exit",
		// this would hang for the full 30s sleep instead of resolving as soon as the shell dies.
		const result = await run(session, "sleep 30 & exit 3", cwd);
		const elapsedMs = Date.now() - start;
		expect(result.exitCode).toBe(3);
		expect(elapsedMs).toBeLessThan(5_000);
	});
});
