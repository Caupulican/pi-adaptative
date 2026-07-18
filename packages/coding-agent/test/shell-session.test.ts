import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquirePersistentShellSession,
	disposePersistentShellSession,
	type PersistentShellSession,
	type ShellSessionExecOptions,
} from "../src/core/tools/shell-session.ts";

const IS_WINDOWS = process.platform === "win32";

function pwshAvailable(): boolean {
	const executable = IS_WINDOWS ? "pwsh.exe" : "pwsh";
	try {
		return (
			spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output ok"], {
				encoding: "utf-8",
				timeout: 15_000,
				windowsHide: true,
			}).status === 0
		);
	} catch {
		return false;
	}
}

const HAS_POWERSHELL = IS_WINDOWS || pwshAvailable();

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

	it("contains syntax errors without killing the session", async () => {
		const session = makeSession("bash");
		const bad = await run(session, "if then fi", cwd);
		expect(bad.exitCode).not.toBe(0);
		expect((await run(session, "echo recovered", cwd)).output.trim()).toBe("recovered");
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
});

describe.skipIf(!HAS_POWERSHELL)("PersistentShellSession (powershell)", () => {
	const cwd = process.cwd();

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
});
