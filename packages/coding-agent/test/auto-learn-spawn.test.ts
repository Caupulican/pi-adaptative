import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import {
	AUTO_LEARN_HISTORY_RETENTION_MS,
	type AutoLearnSpawnTarget,
	buildAutoLearnSpawnArgs,
	findAutoLearnSpawnNullByteInput,
	InteractiveMode,
	pruneAutoLearnConversationHistory,
} from "../src/modes/interactive/interactive-mode.ts";

const tempDirs: string[] = [];

interface AutoLearnLaunchHarness {
	runtimeHost: unknown;
	autoLearnLastStatus: string;
	getAutoLearnDataDir: () => string;
	getAutoLearnSpawnTarget: () => AutoLearnSpawnTarget | undefined;
	updateAutoLearnFooter: () => void;
	launchAutoLearn: (
		reason: string,
		force?: boolean,
		options?: { cooldownKind?: "auto" | "reflection"; promptKind?: "auto" | "reflection"; turnDigest?: string },
	) => string;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-auto-learn-spawn-"));
	tempDirs.push(dir);
	return dir;
}

async function waitForFileToContain(filePath: string, expected: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		try {
			if (readFileSync(filePath, "utf-8").includes(expected)) {
				return;
			}
		} catch {
			// The child process may not have created/flushed the log yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for ${filePath} to contain ${expected}`);
}

function readAutoLearnRunCount(dataDir: string): number {
	const statePath = join(dataDir, "state.json");
	if (!existsSync(statePath)) return 0;
	const state = JSON.parse(readFileSync(statePath, "utf-8")) as {
		runs?: Record<string, unknown>;
	};
	return Object.keys(state.runs ?? {}).length;
}

function setMtime(filePath: string, timestampMs: number): void {
	const timestamp = new Date(timestampMs);
	utimesSync(filePath, timestamp, timestamp);
}

function writeAutoLearnSessionFile(dataDir: string, sessionId: string): string {
	const sessionsDir = join(dataDir, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const filePath = join(sessionsDir, `2026-06-03T00-00-00-000Z_${sessionId}.jsonl`);
	writeFileSync(
		filePath,
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-06-03T00:00:00.000Z", cwd: "/tmp" })}\n` +
			`${JSON.stringify({ type: "message", id: "1", parentId: null, timestamp: "2026-06-03T00:00:01.000Z", message: { role: "user", content: "learn me", timestamp: 1 } })}\n`,
		"utf-8",
	);
	return filePath;
}

interface AutoLearnHarnessOptions {
	model?: string;
	maxConcurrentLearners?: number;
	reflectionCooldownMinutes?: number;
	cooldownMinutes?: number;
	sessionId?: string;
	cwd?: string;
}

function writeFakeCli(dataDir: string, source: string): string {
	const fakeCliPath = join(dataDir, `fake-pi-${Math.random().toString(16).slice(2)}.mjs`);
	writeFileSync(fakeCliPath, source, "utf-8");
	return fakeCliPath;
}

function createAutoLearnHarness(
	dataDir: string,
	spawnTarget: AutoLearnSpawnTarget,
	options: AutoLearnHarnessOptions = {},
): AutoLearnLaunchHarness {
	const settingsManager = {
		getAutoLearnSettings: () => ({
			enabled: true,
			model: options.model ?? "test/model",
			longSessionMessages: 32,
			longSessionContextPercent: 70,
			cooldownMinutes: options.cooldownMinutes ?? 0,
			leaseMinutes: 1,
			maxConcurrentLearners: options.maxConcurrentLearners ?? 1,
			applyHighConfidence: false,
			reflectionReview: true,
			reflectionMinToolCalls: 1,
			reflectionCooldownMinutes: options.reflectionCooldownMinutes ?? 0,
		}),
		getAutonomySettings: () => ({ mode: "balanced" }),
		getSelfModificationSettings: () => ({ enabled: false }),
	};
	const sessionManager = {
		getCwd: () => options.cwd ?? dataDir,
		getBranch: () => [],
		getSessionFile: () => undefined,
	};
	const session = {
		settingsManager,
		sessionManager,
		model: { provider: "test", id: "model" },
		sessionId: options.sessionId ?? "auto-learn-test-session",
		getContextUsage: () => undefined,
	};
	const harness = Object.create(InteractiveMode.prototype) as AutoLearnLaunchHarness;
	harness.runtimeHost = { session };
	harness.autoLearnLastStatus = "idle";
	harness.getAutoLearnDataDir = () => dataDir;
	harness.getAutoLearnSpawnTarget = () => spawnTarget;
	harness.updateAutoLearnFooter = () => undefined;
	return harness;
}

describe("Auto Learn spawn args", () => {
	it("passes the background learner prompt by @file instead of argv text", () => {
		const promptWithNullByte = "Latest turn digest: abc\0def";
		const spawnTarget: AutoLearnSpawnTarget = { command: "node", argsPrefix: ["/repo/dist/cli.js"] };

		const args = buildAutoLearnSpawnArgs(spawnTarget, {
			name: "Auto Learn test-run",
			modelPattern: "openai/gpt-5.5",
			sessionDir: "/tmp/pi auto learn/sessions",
			sessionId: "auto-learn-reflection-test-run",
			promptPath: "/tmp/pi auto learn/test-run.prompt.md",
		});

		expect(promptWithNullByte).toContain("\0");
		expect(args).toEqual([
			"/repo/dist/cli.js",
			"--print",
			"--name",
			"Auto Learn test-run",
			"--model",
			"openai/gpt-5.5",
			"--session-dir",
			"/tmp/pi auto learn/sessions",
			"--session-id",
			"auto-learn-reflection-test-run",
			"@/tmp/pi auto learn/test-run.prompt.md",
		]);
		expect(args).not.toContain(promptWithNullByte);
		expect(findAutoLearnSpawnNullByteInput(spawnTarget.command, args)).toBeUndefined();
	});

	it("prunes internal Auto Learn conversation history older than seven days", () => {
		const dataDir = createTempDir();
		const now = Date.parse("2026-06-03T00:00:00.000Z");
		const oldTimestamp = now - AUTO_LEARN_HISTORY_RETENTION_MS - 1000;
		const freshTimestamp = now - AUTO_LEARN_HISTORY_RETENTION_MS + 1000;
		const oldRunId = "1780000000000-oldrun01";
		const freshRunId = "1780000000000-freshrun";
		const oldPrompt = join(dataDir, `${oldRunId}.prompt.md`);
		const oldLog = join(dataDir, `${oldRunId}.log`);
		const freshPrompt = join(dataDir, `${freshRunId}.prompt.md`);
		const oldSession = writeAutoLearnSessionFile(dataDir, `auto-learn-auto-${oldRunId}`);
		const malformedOldSession = join(dataDir, "sessions", "2026-06-03T00-00-00-000Z_auto-learn-auto-malformed.jsonl");
		const freshSession = writeAutoLearnSessionFile(dataDir, `auto-learn-auto-${freshRunId}`);
		const nonAutoLearnSession = writeAutoLearnSessionFile(dataDir, "user-session-kept");

		writeFileSync(oldPrompt, "old prompt", "utf-8");
		writeFileSync(oldLog, "old log", "utf-8");
		writeFileSync(freshPrompt, "fresh prompt", "utf-8");
		writeFileSync(malformedOldSession, "not-json\n", "utf-8");
		for (const filePath of [oldPrompt, oldLog, oldSession, malformedOldSession, nonAutoLearnSession]) {
			setMtime(filePath, oldTimestamp);
		}
		for (const filePath of [freshPrompt, freshSession]) setMtime(filePath, freshTimestamp);

		const result = pruneAutoLearnConversationHistory({ dataDir, now });

		expect(result).toEqual({ promptFiles: 1, logFiles: 1, sessionFiles: 2, errors: 0 });
		expect(existsSync(oldPrompt)).toBe(false);
		expect(existsSync(oldLog)).toBe(false);
		expect(existsSync(oldSession)).toBe(false);
		expect(existsSync(malformedOldSession)).toBe(false);
		expect(existsSync(freshPrompt)).toBe(true);
		expect(existsSync(freshSession)).toBe(true);
		expect(existsSync(nonAutoLearnSession)).toBe(true);
	});

	it("keeps active Auto Learn artifacts even when they exceed the seven-day retention window", () => {
		const dataDir = createTempDir();
		const now = Date.parse("2026-06-03T00:00:00.000Z");
		const oldTimestamp = now - AUTO_LEARN_HISTORY_RETENTION_MS - 1000;
		const runId = "1780000000000-active";
		const sessionId = `auto-learn-reflection-${runId}`;
		const promptPath = join(dataDir, `${runId}.prompt.md`);
		const logPath = join(dataDir, `${runId}.log`);
		const sessionPath = writeAutoLearnSessionFile(dataDir, sessionId);

		writeFileSync(promptPath, "active prompt", "utf-8");
		writeFileSync(logPath, "active log", "utf-8");
		for (const filePath of [promptPath, logPath, sessionPath]) setMtime(filePath, oldTimestamp);

		const result = pruneAutoLearnConversationHistory({
			dataDir,
			now,
			activeRunIds: [runId],
			activeSessionIds: [sessionId],
		});

		expect(result).toEqual({ promptFiles: 0, logFiles: 0, sessionFiles: 0, errors: 0 });
		expect(existsSync(promptPath)).toBe(true);
		expect(existsSync(logPath)).toBe(true);
		expect(existsSync(sessionPath)).toBe(true);
	});

	it("launches with a null-byte reflection digest without putting prompt content in argv", async () => {
		const dataDir = createTempDir();
		const fakeCliPath = join(dataDir, "fake-pi.mjs");
		writeFileSync(
			fakeCliPath,
			`
import { readFileSync } from "node:fs";

const promptArg = process.argv.at(-1);
if (!promptArg?.startsWith("@")) {
	console.error("missing @ prompt file");
	process.exit(2);
}
if (process.argv.some((arg) => arg.includes("\\0"))) {
	console.error("argv contains null byte");
	process.exit(3);
}
const prompt = readFileSync(promptArg.slice(1), "utf-8");
if (!prompt.includes("\\0")) {
	console.error("prompt file does not contain null byte");
	process.exit(4);
}
console.log("received-null-byte-prompt-file");
`,
			"utf-8",
		);
		const mode = createAutoLearnHarness(dataDir, { command: process.execPath, argsPrefix: [fakeCliPath] });

		const result = mode.launchAutoLearn("reflection null-byte regression", true, {
			cooldownKind: "reflection",
			promptKind: "reflection",
			turnDigest: "toolResult: before-null\0after-null",
		});

		expect(result).toContain("Auto Learn started");
		const logPath = result.match(/Log: (.*)$/)?.[1];
		expect(logPath).toBeDefined();
		await waitForFileToContain(logPath!, "received-null-byte-prompt-file");
		const state = JSON.parse(readFileSync(join(dataDir, "state.json"), "utf-8")) as {
			runs: Record<string, { promptPath: string }>;
		};
		const promptPath = Object.values(state.runs)[0]?.promptPath;
		expect(promptPath).toBeDefined();
		expect(readFileSync(promptPath!, "utf-8")).toContain("before-null\0after-null");
	});

	it("refuses null bytes in spawn command before child_process.spawn", () => {
		const dataDir = createTempDir();
		const mode = createAutoLearnHarness(dataDir, { command: `${process.execPath}\0`, argsPrefix: [] });

		const result = mode.launchAutoLearn("null-byte command regression", true);

		expect(result).toContain("Auto Learn not started: command contains a null byte");
		expect(readAutoLearnRunCount(dataDir)).toBe(0);
	});

	it("refuses null bytes in model-derived spawn args before child_process.spawn", () => {
		const dataDir = createTempDir();
		const mode = createAutoLearnHarness(
			dataDir,
			{ command: process.execPath, argsPrefix: ["fake-pi.mjs"] },
			{
				model: "test/model\0broken",
			},
		);

		const result = mode.launchAutoLearn("null-byte model regression", true);

		expect(result).toContain("Auto Learn not started: args[5] contains a null byte");
		expect(readAutoLearnRunCount(dataDir)).toBe(0);
	});

	it("handles missing CLI spawn failure without throwing or recording a running learner", () => {
		const dataDir = createTempDir();
		const missingCli = join(dataDir, "missing-pi-cli");
		const mode = createAutoLearnHarness(dataDir, { command: missingCli, argsPrefix: [] });

		const result = mode.launchAutoLearn("missing cli regression", true);

		expect(result).toContain("Auto Learn not started: failed to spawn background learner");
		expect(readAutoLearnRunCount(dataDir)).toBe(0);
	});

	it("serializes same-tenant reflection reservations so a second launch observes cooldown", () => {
		const dataDir = createTempDir();
		const fakeCliPath = writeFakeCli(dataDir, `console.log("reserved"); setTimeout(() => undefined, 1000);\n`);
		const spawnTarget = { command: process.execPath, argsPrefix: [fakeCliPath] };
		const first = createAutoLearnHarness(dataDir, spawnTarget, {
			maxConcurrentLearners: 2,
			reflectionCooldownMinutes: 10,
		});
		const second = createAutoLearnHarness(dataDir, spawnTarget, {
			maxConcurrentLearners: 2,
			reflectionCooldownMinutes: 10,
		});

		expect(
			first.launchAutoLearn("same tenant first", true, { cooldownKind: "reflection", promptKind: "reflection" }),
		).toContain("Auto Learn started");
		expect(
			second.launchAutoLearn("same tenant second", true, { cooldownKind: "reflection", promptKind: "reflection" }),
		).toContain("Auto Learn not started: reflection cooldown");
		expect(readAutoLearnRunCount(dataDir)).toBe(1);
	});

	it("enforces max concurrent learners across tenants through shared state", () => {
		const dataDir = createTempDir();
		const fakeCliPath = writeFakeCli(dataDir, `console.log("reserved"); setTimeout(() => undefined, 1000);\n`);
		const spawnTarget = { command: process.execPath, argsPrefix: [fakeCliPath] };
		const tenantA = createAutoLearnHarness(dataDir, spawnTarget, { sessionId: "tenant-a" });
		const tenantB = createAutoLearnHarness(dataDir, spawnTarget, { sessionId: "tenant-b" });

		expect(tenantA.launchAutoLearn("tenant A", true)).toContain("Auto Learn started");
		expect(tenantB.launchAutoLearn("tenant B", true)).toContain("Auto Learn not started: max learners running (1/1)");
		expect(readAutoLearnRunCount(dataDir)).toBe(1);
	});

	it("keeps --print @prompt-file in the CLI file-input path", () => {
		const parsed = parseArgs(["--print", "@/tmp/pi-auto-learn/test-run.prompt.md"]);

		expect(parsed.print).toBe(true);
		expect(parsed.messages).toEqual([]);
		expect(parsed.fileArgs).toEqual(["/tmp/pi-auto-learn/test-run.prompt.md"]);
	});

	it("detects null bytes before calling child_process.spawn", () => {
		expect(findAutoLearnSpawnNullByteInput("node\0", ["--print"])).toBe("command");
		expect(findAutoLearnSpawnNullByteInput("node", ["--print", "bad\0arg"])).toBe("args[1]");
		expect(findAutoLearnSpawnNullByteInput("node", ["--print", "@/tmp/prompt.md"])).toBeUndefined();
	});

	it("node itself rejects argv null bytes, proving the regression input is lethal when passed directly", () => {
		expect(() => spawnSync(process.execPath, ["-e", "", "raw-prompt\0payload"])).toThrow(/null bytes/);
	});
});
