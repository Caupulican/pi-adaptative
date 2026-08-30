import { type SpawnOptions, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	claimCliPowerShellWarmStart,
	disposeUnclaimedCliPowerShellWarmStart,
	resetCliPowerShellWarmStartForTests,
	startCliPowerShellWarmStart,
} from "../src/core/tools/early-powershell-session.ts";
import {
	PersistentShellSession,
	POWERSHELL_SESSION_READY_MARKER,
	POWERSHELL_SESSION_STDERR_READY_MARKER,
	type ShellSessionExecOptions,
} from "../src/core/tools/shell-session.ts";

async function run(
	session: PersistentShellSession,
	command: string,
	cwd: string,
	options: Partial<ShellSessionExecOptions>,
): Promise<{ exitCode: number | null; output: string }> {
	const chunks: Buffer[] = [];
	const { exitCode } = await session.exec(command, cwd, {
		onData: (data) => chunks.push(data),
		...options,
	});
	return { exitCode, output: Buffer.concat(chunks).toString("utf8") };
}

afterEach(async () => {
	await resetCliPowerShellWarmStartForTests();
});

describe("early CLI PowerShell session handoff", () => {
	it("starts before the runtime import, reconciles the final environment, and reuses the same process", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-early-powershell-"));
		const fixture = join(directory, "powershell-fixture.mjs");
		const capture = join(directory, "commands.jsonl");
		writeFileSync(
			fixture,
			`import { appendFileSync } from "node:fs";
const marker = ${JSON.stringify(POWERSHELL_SESSION_READY_MARKER)};
const stderrMarker = ${JSON.stringify(POWERSHELL_SESSION_STDERR_READY_MARKER)};
process.stderr.write(stderrMarker);
process.stdout.write(marker.slice(0, 3));
setImmediate(() => process.stdout.write(marker.slice(3)));
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
		const body = Buffer.from(line.slice(separator + 1), "base64").toString("utf8");
		appendFileSync(process.env.PI_CAPTURE_PATH, JSON.stringify(body) + "\\n");
		process.stderr.write("\\x1e" + nonce + ":stderr\\x1e\\n");
		process.stdout.write("ok\\n\\n\\x1e" + nonce + ":0\\x1e");
		newline = pending.indexOf("\\n");
	}
});
`,
		);
		chmodSync(fixture, 0o755);

		const earlyEnv = { ...process.env, PI_CAPTURE_PATH: capture, PI_EARLY_ENV: "old" };
		const desiredEnv = { ...earlyEnv, PI_EARLY_ENV: "new", PI_LATE_ENV: "present" };
		let earlySpawns = 0;
		let fallbackResolutions = 0;
		let spawnedEnvironment: NodeJS.ProcessEnv | undefined;
		startCliPowerShellWarmStart({
			platform: "win32",
			cwd: directory,
			env: earlyEnv,
			candidates: ["fixture-powershell"],
			spawn: (_command: string, args: string[], options: SpawnOptions) => {
				earlySpawns += 1;
				spawnedEnvironment = options.env;
				return spawn(process.execPath, [fixture, ...args], options);
			},
			startupTimeoutMs: 2_000,
		});

		const session = new PersistentShellSession("early-handoff", "powershell", {
			resolvePowerShellCandidates: () => {
				fallbackResolutions += 1;
				return [];
			},
		});
		try {
			await session.prewarm(directory, desiredEnv);
			expect(await run(session, "Write-Output ok", directory, { env: desiredEnv })).toEqual({
				exitCode: 0,
				output: "ok\n",
			});
			expect(earlySpawns).toBe(1);
			expect(fallbackResolutions).toBe(0);
			expect(spawnedEnvironment).toMatchObject({
				NO_COLOR: "1",
				POWERSHELL_DIAGNOSTICS_OPTOUT: "1",
				POWERSHELL_TELEMETRY_OPTOUT: "1",
				POWERSHELL_UPDATECHECK: "Off",
			});

			const commands = readFileSync(capture, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string);
			expect(commands).toHaveLength(2);
			const encodedDelta = commands[0]?.match(/FromBase64String\('([^']+)'\)/u)?.[1];
			expect(encodedDelta).toBeDefined();
			const delta = JSON.parse(Buffer.from(encodedDelta ?? "", "base64").toString("utf8")) as {
				setValues: Array<{ name: string; value: string }>;
			};
			expect(delta.setValues).toEqual(
				expect.arrayContaining([
					{ name: "PI_EARLY_ENV", value: "new" },
					{ name: "PI_LATE_ENV", value: "present" },
				]),
			);
		} finally {
			session.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

/** Kill a child and wait for the OS to actually reap it before touching its cwd. */
async function killAndWait(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill();
	await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
}

describe("unclaimed CLI PowerShell warm start", () => {
	/** A fake host that reports ready and then idles, like a real warm-started shell. */
	function writeIdleFixture(directory: string): string {
		const fixture = join(directory, "idle-host.mjs");
		writeFileSync(
			fixture,
			`const marker = ${JSON.stringify(POWERSHELL_SESSION_READY_MARKER)};
process.stderr.write(${JSON.stringify(POWERSHELL_SESSION_STDERR_READY_MARKER)});
process.stdout.write(marker);
process.stdin.resume();
setInterval(() => {}, 1000);
`,
		);
		chmodSync(fixture, 0o755);
		return fixture;
	}

	it("kills a warm start nobody claimed, so it cannot outlive the CLI", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-warm-unclaimed-"));
		try {
			const fixture = writeIdleFixture(directory);
			let spawned: ReturnType<typeof spawn> | undefined;
			startCliPowerShellWarmStart({
				platform: "win32",
				cwd: directory,
				env: { ...process.env },
				candidates: [process.execPath],
				spawn: (command: string, _args: string[], options: SpawnOptions) => {
					spawned = spawn(command, [fixture], options);
					return spawned;
				},
			});

			await disposeUnclaimedCliPowerShellWarmStart();

			expect(spawned).toBeDefined();
			// The host process must be gone: nothing else in production reaps an unclaimed warm start.
			await expect
				.poll(() => spawned?.exitCode !== null || spawned?.signalCode !== null, { timeout: 10_000 })
				.toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});

	it("leaves a claimed warm start alone, since ownership has transferred", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-warm-claimed-"));
		try {
			const fixture = writeIdleFixture(directory);
			let spawned: ReturnType<typeof spawn> | undefined;
			startCliPowerShellWarmStart({
				platform: "win32",
				cwd: directory,
				env: { ...process.env },
				candidates: [process.execPath],
				spawn: (command: string, _args: string[], options: SpawnOptions) => {
					spawned = spawn(command, [fixture], options);
					return spawned;
				},
			});

			const claimed = await claimCliPowerShellWarmStart();
			expect(claimed).not.toBeNull();

			await disposeUnclaimedCliPowerShellWarmStart();
			expect(spawned?.exitCode).toBeNull();
			expect(spawned?.signalCode).toBeNull();

			claimed?.releaseStartupListeners();
			if (claimed) await killAndWait(claimed.child);
		} finally {
			// Windows refuses to remove a directory a live process still holds as its cwd, and kill()
			// is asynchronous — hence the wait above plus bounded retries here.
			rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
});
