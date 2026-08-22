import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import {
	AUTO_LEARN_HISTORY_RETENTION_MS,
	AutoLearnController,
	type AutoLearnSpawnTarget,
	buildAutoLearnSpawnArgs,
	findAutoLearnSpawnNullByteInput,
	pruneAutoLearnConversationHistory,
} from "../src/modes/interactive/auto-learn-controller.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];

beforeAll(() => {
	initTheme("dark");
});

interface AutoLearnLaunchHarness {
	deps: unknown;
	getAutoLearnDataDir: () => string;
	getAutoLearnSpawnTarget: () => AutoLearnSpawnTarget | undefined;
	updateAutoLearnFooter: () => void;
	launchAutoLearn: (
		reason: string,
		force?: boolean,
		options?: {
			cooldownKind?: "auto" | "reflection";
			promptKind?: "auto" | "reflection";
			turnDigest?: string;
			bypassReflectionCooldown?: boolean;
		},
	) => string;
	maybeStartAutoLearn: () => boolean;
	maybeStartAutonomyReview: (messages: unknown[]) => boolean;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		try {
			const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as {
				runs?: Record<string, { pid?: unknown }>;
			};
			for (const run of Object.values(state.runs ?? {})) {
				if (typeof run.pid !== "number") continue;
				try {
					process.kill(run.pid);
				} catch {
					// The child already exited.
				}
			}
		} catch {
			// Tests that never launch a child have no state file.
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
		getTaskStepsStateSnapshot: () => undefined,
		sendCustomMessage: () => Promise.resolve(),
	};
	const harness = Object.create(AutoLearnController.prototype) as AutoLearnLaunchHarness;
	harness.deps = {
		getSession: () => session,
		resolveSelfModificationSource: () => undefined,
		ui: {
			showStatus: () => undefined,
			footerDataProvider: { setExtensionStatus: () => undefined },
			invalidateFooter: () => undefined,
			requestRender: () => undefined,
		},
	};
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
			thinkingLevel: "xhigh",
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
			"--thinking",
			"xhigh",
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

	it("refuses every reflection-flavored background learner before resolving or spawning the CLI", () => {
		const dataDir = createTempDir();
		const mode = createAutoLearnHarness(dataDir, {
			command: `${process.execPath}\0must-not-be-inspected`,
			argsPrefix: [],
		});

		const result = mode.launchAutoLearn("reflection null-byte regression", true, {
			cooldownKind: "reflection",
			promptKind: "reflection",
			turnDigest: "toolResult: before-null\0after-null",
			bypassReflectionCooldown: true,
		});

		expect(result).toBe(
			"Auto Learn not started: automatic reflection runs only in the current root session; background reflection learners are disabled.",
		);
		expect(readAutoLearnRunCount(dataDir)).toBe(0);
	});

	it("does not fall through the native-reflection kill switch into an automatic Auto Learn spawn", () => {
		const dataDir = createTempDir();
		const mode = createAutoLearnHarness(dataDir, { command: process.execPath, argsPrefix: ["unused.mjs"] });
		const launchAutoLearn = vi.fn(() => "Auto Learn started");
		const internals = mode as AutoLearnLaunchHarness & {
			evaluateAutoLearn: () => { shouldRun: boolean; reason: string };
		};
		internals.evaluateAutoLearn = () => ({ shouldRun: true, reason: "message trigger" });
		mode.launchAutoLearn = launchAutoLearn;
		const original = process.env.PI_NATIVE_REFLECTION;
		process.env.PI_NATIVE_REFLECTION = "0";

		try {
			expect(mode.maybeStartAutoLearn()).toBe(false);
			expect(launchAutoLearn).not.toHaveBeenCalled();
		} finally {
			if (original === undefined) delete process.env.PI_NATIVE_REFLECTION;
			else process.env.PI_NATIVE_REFLECTION = original;
		}
	});

	it("never launches a completed-turn autonomy review in a background process", () => {
		const dataDir = createTempDir();
		const mode = createAutoLearnHarness(dataDir, { command: process.execPath, argsPrefix: ["unused.mjs"] });
		const launchAutoLearn = vi.fn(() => "Auto Learn started");
		const internals = mode as AutoLearnLaunchHarness & {
			evaluateAutonomyReview: () => { shouldRun: boolean; reason: string; digest: string };
		};
		internals.evaluateAutonomyReview = () => ({ shouldRun: true, reason: "correction", digest: "bounded" });
		mode.launchAutoLearn = launchAutoLearn;

		expect(mode.maybeStartAutonomyReview([{ role: "user", content: "No, remember this." }])).toBe(false);
		expect(launchAutoLearn).not.toHaveBeenCalled();
	});

	it("marks a background learner as a worker session", async () => {
		const dataDir = createTempDir();
		const fakeCliPath = writeFakeCli(
			dataDir,
			`console.log("session-role=" + process.env.PI_SESSION_ROLE); setTimeout(() => undefined, 1000);\n`,
		);
		const mode = createAutoLearnHarness(dataDir, { command: process.execPath, argsPrefix: [fakeCliPath] });

		const result = mode.launchAutoLearn("worker privilege regression", true);

		expect(result).toContain("Auto Learn started");
		const logPath = result.match(/Log: (.*)$/)?.[1];
		expect(logPath).toBeDefined();
		await waitForFileToContain(logPath!, "session-role=worker");
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

	it("instructs a manual Auto Learn run to code-bake behavioral improvements instead of stopping at memory", () => {
		const mode = Object.create(AutoLearnController.prototype) as any;
		mode.deps = {
			getSession: () => ({
				settingsManager: {
					getAutonomySettings: () => ({ mode: "full" }),
					getSelfModificationSettings: () => ({ enabled: true, sourcePath: "/repo/pi-adaptative" }),
				},
			}),
			resolveSelfModificationSource: (settings: { sourcePath?: string }) => settings.sourcePath,
		};

		const prompt = mode.buildAutoLearnPrompt(
			"manual self-improvement run",
			{
				applyHighConfidence: true,
				complexTaskToolCalls: 5,
			} as any,
			{ kind: "auto" },
		);

		expect(prompt).toContain("Hermes-style learning cycle");
		expect(prompt).toContain("after a complex task (5+ tool calls)");
		expect(prompt).toContain("Memory stores compact facts/preferences/state");
		expect(prompt).toContain("Skill update preference order");
		expect(prompt).toContain("patch the currently loaded or consulted skill");
		expect(prompt).toContain("create a new class-level umbrella skill only when no existing artifact fits");
		expect(prompt).toContain("Behavioral self-improvement is code-baked by default");
		expect(prompt).toContain("memory alone is not completion");
		expect(prompt).toContain("patch an existing skill/prompt/agent/extension/tool");
		expect(prompt).toContain("authorized Pi source");
		expect(prompt).toContain("Do not harden transient or environment-dependent failures");
	});

	it("isolates concurrent learner limits by tenant while sharing state for visibility", () => {
		const dataDir = createTempDir();
		const fakeCliPath = writeFakeCli(dataDir, `console.log("reserved"); setTimeout(() => undefined, 1000);\n`);
		const spawnTarget = { command: process.execPath, argsPrefix: [fakeCliPath] };
		const tenantA = createAutoLearnHarness(dataDir, spawnTarget, { sessionId: "tenant-a" });
		const tenantB = createAutoLearnHarness(dataDir, spawnTarget, { sessionId: "tenant-b" });

		expect(tenantA.launchAutoLearn("tenant A", true)).toContain("Auto Learn started");
		expect(tenantB.launchAutoLearn("tenant B", true)).toContain("Auto Learn started");
		expect(readAutoLearnRunCount(dataDir)).toBe(2);
	});

	it("keeps Auto Learn footer compact and free of model/log paths", () => {
		let footerStatus: string | undefined;
		const mode = Object.create(AutoLearnController.prototype) as any;
		mode.getEffectiveAutoLearnSettings = () => ({ enabled: true });
		mode.getAutoLearnTenantKey = () => "tenant-a";
		mode.getPrunedAutoLearnState = () => ({
			runs: {
				active: {
					tenant: "tenant-a",
					pid: 123,
					modelPattern: "openai-codex/gpt-5.5",
					logPath: "/home/user/.pi/agent/auto-learn/active.log",
				},
			},
		});
		mode.isAutoLearnPidAlive = () => true;
		mode.deps = {
			ui: {
				showStatus: () => undefined,
				footerDataProvider: {
					setExtensionStatus: (_name: string, value: string | undefined) => {
						footerStatus = value;
					},
				},
				invalidateFooter: () => undefined,
				requestRender: () => undefined,
			},
		};

		mode.updateAutoLearnFooter();

		expect(footerStatus).toContain("(learning)");
		expect(footerStatus).not.toContain("openai-codex");
		expect(footerStatus).not.toContain("gpt-5.5");
		expect(footerStatus).not.toContain("/home/user");
		expect(footerStatus).not.toContain("learn:");

		mode.isAutoLearnPidAlive = () => false;
		mode.updateAutoLearnFooter();
		expect(footerStatus).toBeUndefined();
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
