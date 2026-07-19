import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tmuxAgentManagerExtension, {
	getTmuxAgentManagerDataRoot,
	makePaneWatcherScript,
} from "../src/bundled-resources/extensions/tmux-agent-manager/index.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

type StoredEntry = { id: string; parentId: string | null; type: "custom"; customType: string; data: unknown };
type TestContext = {
	cwd: string;
	hasUI: boolean;
	sessionManager: {
		getSessionFile(): string;
		getLatestCustomEntryOnBranch(customType: string, fromId?: string): StoredEntry | undefined;
		getBranch(): StoredEntry[];
	};
	ui: { notify(message: string, level: string): void; confirm(title: string, message: string): Promise<boolean> };
};

type Handler = (event: unknown, context: TestContext) => Promise<void> | void;
type RegisteredTool = {
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: () => void,
		context: TestContext,
	): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
};
/** A minimal in-memory session custom-entry store backing appendEntry/getLatestCustomEntryOnBranch/
 * getBranch — just enough to exercise the STANDING GRANT lifecycle (grant_dispatch/revoke_grant, and
 * the approval gate in front of a real fire_task/send_followup dispatch). See tmux-dispatch-grant.test.ts
 * for the dedicated, exhaustive grant-lifecycle coverage. */
function makeCustomEntryStore() {
	const entries: StoredEntry[] = [];
	let leafId: string | null = null;
	let entrySeq = 0;
	return {
		entries,
		appendEntry: (customType: string, data?: unknown) => {
			const id = `entry-${++entrySeq}`;
			entries.push({ id, parentId: leafId, type: "custom", customType, data });
			leafId = id;
		},
		getLatestCustomEntryOnBranch(customType: string, fromId?: string): StoredEntry | undefined {
			let currentId = fromId ?? leafId;
			while (currentId) {
				const current = entries.find((entry) => entry.id === currentId);
				if (!current) return undefined;
				if (current.customType === customType) return current;
				currentId = current.parentId;
			}
			return undefined;
		},
		getBranch: () => entries.slice(),
	};
}
type SentMessage = {
	message: {
		customType: string;
		content: string;
		display: boolean;
		details?: unknown;
	};
	options?: { triggerTurn?: boolean; deliverAs?: string };
};

describe.skipIf(process.platform === "win32")("bundled tmux agent manager completion", () => {
	let tempDir: string;
	let previousAgentDir: string | undefined;
	let previousPath: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-completion-"));
		previousAgentDir = process.env[ENV_AGENT_DIR];
		previousPath = process.env.PATH;
		process.env[ENV_AGENT_DIR] = tempDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		fs.rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it.skipIf(process.platform === "win32")(
		"writes a terminal result from pane output without requiring Node or Bun in the worker",
		() => {
			const jobDir = path.join(tempDir, "portable-watcher");
			const binDir = path.join(tempDir, "bin");
			fs.mkdirSync(jobDir, { recursive: true });
			fs.mkdirSync(binDir, { recursive: true });
			const fakeTmux = path.join(binDir, "tmux");
			fs.writeFileSync(fakeTmux, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
			const resultPath = path.join(jobDir, "worker result.json");
			const logPath = path.join(jobDir, "worker output.log");
			const watcherPath = path.join(jobDir, "pane-watcher.sh");
			const job = {
				id: "portable-job",
				createdAt: new Date().toISOString(),
				workspaceName: "portable-workspace",
				sessionName: "portable-session",
				cwd: tempDir,
				task: "test",
				deadlineSeconds: 10,
				jobDir,
				jobPath: path.join(jobDir, "job.json"),
				varsPath: path.join(jobDir, "variables.json"),
				watcherPath,
				launchCommands: [],
				agents: [
					{
						id: "worker",
						provider: "pi" as const,
						name: 'worker\'s "quoted" name',
						cwd: tempDir,
						doneMarker: "PI_TMUX_DONE",
						blockedMarker: "PI_TMUX_BLOCKED",
						promptPath: path.join(jobDir, "worker.prompt.txt"),
						logPath,
						resultPath,
						paneId: "%1",
					},
				],
			};
			const watcher = makePaneWatcherScript(job);
			expect(watcher).not.toContain("process.execPath");
			expect(watcher).not.toContain("setInterval");
			fs.writeFileSync(watcherPath, watcher, { mode: 0o700 });

			const result = spawnSync("sh", [watcherPath, "worker"], {
				encoding: "utf8",
				input: "provider output\nPI_TMUX_DONE\n",
				env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
				timeout: 15_000,
			});
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			const terminal = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
				status: string;
				agentName: string;
				notifiedBy: string;
			};
			expect(terminal, result.stderr).toMatchObject({
				status: "done",
				agentName: 'worker\'s "quoted" name',
				notifiedBy: "pane-output-event",
			});
			expect(fs.readFileSync(logPath, "utf8")).toContain("PI_TMUX_DONE");
		},
	);

	it.skipIf(process.platform === "win32")("records a one-shot deadline and terminates a silent watcher", async () => {
		const jobDir = path.join(tempDir, "deadline-watcher");
		const binDir = path.join(tempDir, "deadline-bin");
		fs.mkdirSync(jobDir, { recursive: true });
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(path.join(binDir, "tmux"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		const resultPath = path.join(jobDir, "worker.result.json");
		const watcherPath = path.join(jobDir, "pane-watcher.sh");
		// Assigned to a named `job` const (matching the sibling test above) rather than passed as an
		// inline object literal: makePaneWatcherScript's parameter type is intentionally narrowed to
		// what it actually reads (id/sessionName/deadlineSeconds/agents), so a fresh literal carrying
		// the rest of a real job's fields would fail TypeScript's excess-property check even though a
		// same-shaped named variable is structurally assignable just fine.
		const job = {
			id: "deadline-job",
			createdAt: new Date().toISOString(),
			workspaceName: "deadline-workspace",
			sessionName: "deadline-session",
			cwd: tempDir,
			task: "test",
			deadlineSeconds: 1,
			jobDir,
			jobPath: path.join(jobDir, "job.json"),
			varsPath: path.join(jobDir, "variables.json"),
			watcherPath,
			launchCommands: [],
			agents: [
				{
					id: "worker",
					provider: "pi" as const,
					name: "silent-worker",
					cwd: tempDir,
					doneMarker: "PI_TMUX_DONE",
					blockedMarker: "PI_TMUX_BLOCKED",
					promptPath: path.join(jobDir, "worker.prompt.txt"),
					logPath: path.join(jobDir, "worker.log"),
					resultPath,
					paneId: "%2",
				},
			],
		};
		fs.writeFileSync(watcherPath, makePaneWatcherScript(job), { mode: 0o700 });
		const child = spawn("sh", [watcherPath, "worker"], {
			env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const terminalExit = new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => resolve(code));
		});
		const guard = setTimeout(() => child.kill("SIGKILL"), 5_000);
		try {
			expect(await terminalExit, stderr).toBe(0);
		} finally {
			clearTimeout(guard);
			child.stdin.destroy();
		}
		expect(JSON.parse(fs.readFileSync(resultPath, "utf8"))).toMatchObject({
			status: "timeout",
			notifiedBy: "deadline-event",
		});
	});

	it("wakes the parent exactly once from a terminal result-file event without polling or peeking", async () => {
		const jobId = "event-job";
		const jobDir = path.join(getTmuxAgentManagerDataRoot(), "jobs", jobId);
		const resultPath = path.join(jobDir, "worker.result.json");
		const logPath = path.join(jobDir, "worker.log");
		const jobPath = path.join(jobDir, "job.json");
		fs.mkdirSync(jobDir, { recursive: true });
		fs.writeFileSync(logPath, "bounded-worker-marker\n");
		fs.writeFileSync(
			jobPath,
			JSON.stringify(
				{
					id: jobId,
					createdAt: new Date().toISOString(),
					workspaceName: "test-workspace",
					sessionName: "test-session",
					cwd: tempDir,
					task: "test",
					deadlineSeconds: 60,
					jobDir,
					jobPath,
					varsPath: path.join(jobDir, "variables.json"),
					watcherPath: path.join(jobDir, "pane-watcher.mjs"),
					launchCommands: [],
					agents: [
						{
							id: "worker",
							provider: "pi",
							name: "worker",
							command: "pi",
							promptPath: path.join(jobDir, "worker.prompt.txt"),
							logPath,
							resultPath,
							doneMarker: "DONE",
							blockedMarker: "BLOCKED",
						},
					],
				},
				null,
				2,
			),
		);

		const tmuxBinDir = path.join(tempDir, "parent-event-bin");
		fs.mkdirSync(tmuxBinDir, { recursive: true });
		fs.writeFileSync(
			path.join(tmuxBinDir, "tmux"),
			// biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion.
			'#!/bin/sh\nif [ "${1:-}" = "-V" ]; then printf \'tmux test\\n\'; fi\nexit 0\n',
			{ mode: 0o700 },
		);
		process.env.PATH = `${tmuxBinDir}:${process.env.PATH ?? ""}`;

		const handlers = new Map<string, Handler[]>();
		const sent: SentMessage[] = [];
		let registeredTool: RegisteredTool | undefined;
		let resolveHandoff: ((message: SentMessage) => void) | undefined;
		const handoff = new Promise<SentMessage>((resolve) => {
			resolveHandoff = resolve;
		});
		const customEntries = makeCustomEntryStore();
		const pi = {
			on(event: string, handler: Handler) {
				const current = handlers.get(event) ?? [];
				current.push(handler);
				handlers.set(event, current);
			},
			registerTool(tool: RegisteredTool) {
				registeredTool = tool;
			},
			registerCommand() {},
			registerFlag() {},
			getFlag() {
				return undefined;
			},
			appendEntry: customEntries.appendEntry,
			reportManagedLane() {},
			reportSpawnedUsage() {},
			sendMessage(message: SentMessage["message"], options?: SentMessage["options"]) {
				const record = { message, options };
				sent.push(record);
				resolveHandoff?.(record);
				resolveHandoff = undefined;
			},
		};
		const context: TestContext = {
			cwd: tempDir,
			hasUI: false,
			sessionManager: {
				getSessionFile: () => path.join(tempDir, "parent-session.jsonl"),
				getLatestCustomEntryOnBranch: customEntries.getLatestCustomEntryOnBranch,
				getBranch: customEntries.getBranch,
			},
			ui: { notify() {}, confirm: async () => true },
		};
		tmuxAgentManagerExtension(pi as never);
		if (!registeredTool) throw new Error("tmux_agent_manager tool was not registered");
		const listed = await registeredTool.execute(
			"list-call",
			{ action: "list_jobs" },
			new AbortController().signal,
			() => {},
			context,
		);
		expect(listed.content[0]?.text).toContain(jobId);
		const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(() => {
			throw new Error("completion polling is forbidden");
		});

		for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
		expect(sent).toEqual([]);

		await registeredTool.execute(
			"stop-call",
			{ action: "stop_job", jobId, dryRun: false, confirm: "yes-tmux-stop" },
			new AbortController().signal,
			() => {},
			context,
		);
		const timeout = new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error("terminal handoff was not delivered")), 5_000).unref?.();
		});
		const delivered = await Promise.race([handoff, timeout]);

		expect(delivered.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(delivered.message.customType).toBe("tmux-background-completion");
		expect(delivered.message.content).toContain("bounded-worker-marker");
		expect(delivered.message.content).toContain("worker: stopped");
		expect(delivered.message.content).toContain("<untrusted_content");
		expect(delivered.message.content.length).toBeLessThan(16_000);
		expect(intervalSpy).not.toHaveBeenCalled();

		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
		for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
		expect(sent).toHaveLength(1);
		expect(JSON.parse(fs.readFileSync(jobPath, "utf8"))).toHaveProperty("notifiedAt");
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
	});

	it("threads the worker's usage claim onto the terminal reportManagedLane event", async () => {
		const jobId = "usage-claim-job";
		const jobDir = path.join(getTmuxAgentManagerDataRoot(), "jobs", jobId);
		const resultPath = path.join(jobDir, "worker.result.json");
		const logPath = path.join(jobDir, "worker.log");
		const jobPath = path.join(jobDir, "job.json");
		fs.mkdirSync(jobDir, { recursive: true });
		fs.writeFileSync(logPath, "usage-claim-marker\n");
		// The worker's own terminal result, written the same way the pane watcher writes it.
		fs.writeFileSync(resultPath, JSON.stringify({ status: "done" }));
		// A cooperative, OPTIONAL usage claim the worker wrote alongside its result — advisory only,
		// per readWorkerUsageClaim's own contract (never fabricated by the host).
		fs.writeFileSync(
			`${resultPath}.usage.json`,
			JSON.stringify({
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
			}),
		);
		fs.writeFileSync(
			jobPath,
			JSON.stringify(
				{
					id: jobId,
					createdAt: new Date().toISOString(),
					workspaceName: "usage-workspace",
					sessionName: "usage-session",
					cwd: tempDir,
					task: "test",
					deadlineSeconds: 60,
					jobDir,
					jobPath,
					varsPath: path.join(jobDir, "variables.json"),
					watcherPath: path.join(jobDir, "pane-watcher.mjs"),
					launchCommands: [],
					agents: [
						{
							id: "worker",
							provider: "pi",
							name: "worker",
							command: "pi",
							promptPath: path.join(jobDir, "worker.prompt.txt"),
							logPath,
							resultPath,
							doneMarker: "DONE",
							blockedMarker: "BLOCKED",
						},
					],
				},
				null,
				2,
			),
		);

		const handlers = new Map<string, Handler[]>();
		const managedLaneEvents: Array<{ laneId: string; phase: string; status?: string; usage?: unknown }> = [];
		const spawnedUsageReports: Array<{ usage: unknown; opts: unknown }> = [];
		const customEntries = makeCustomEntryStore();
		const pi = {
			on(event: string, handler: Handler) {
				const current = handlers.get(event) ?? [];
				current.push(handler);
				handlers.set(event, current);
			},
			registerTool() {},
			registerCommand() {},
			registerFlag() {},
			getFlag() {
				return undefined;
			},
			appendEntry: customEntries.appendEntry,
			reportManagedLane(event: { laneId: string; phase: string; status?: string; usage?: unknown }) {
				managedLaneEvents.push(event);
			},
			reportSpawnedUsage(usage: unknown, opts: unknown) {
				spawnedUsageReports.push({ usage, opts });
			},
			sendMessage() {},
		};
		const context: TestContext = {
			cwd: tempDir,
			hasUI: false,
			sessionManager: {
				getSessionFile: () => path.join(tempDir, "usage-claim-session.jsonl"),
				getLatestCustomEntryOnBranch: customEntries.getLatestCustomEntryOnBranch,
				getBranch: customEntries.getBranch,
			},
			ui: { notify() {}, confirm: async () => true },
		};
		tmuxAgentManagerExtension(pi as never);

		for (const handler of handlers.get("session_start") ?? []) await handler({}, context);

		expect(managedLaneEvents).toContainEqual(
			expect.objectContaining({
				laneId: `tmux:${jobId}:worker`,
				phase: "terminal",
				status: "done",
				usage: expect.objectContaining({ cost: expect.objectContaining({ total: 0.003 }) }),
			}),
		);
		// The SAME claim already reaches reportSpawnedUsage (pre-existing behavior) — the bridge threads
		// it onto reportManagedLane too, it does not replace the existing spend report.
		expect(spawnedUsageReports).toHaveLength(1);

		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
	});

	it("fire_task refuses a real launch with NO standing grant and NO interactive approval (doctrine-regression)", async () => {
		const tmuxBinDir = path.join(tempDir, "doctrine-bin");
		fs.mkdirSync(tmuxBinDir, { recursive: true });
		fs.writeFileSync(
			path.join(tmuxBinDir, "tmux"),
			// biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion.
			'#!/bin/sh\nif [ "${1:-}" = "-V" ]; then printf \'tmux test\\n\'; exit 0; fi\nif [ "${1:-}" = "has-session" ]; then exit 1; fi\nexit 0\n',
			{ mode: 0o700 },
		);
		process.env.PATH = `${tmuxBinDir}:${process.env.PATH ?? ""}`;

		let registeredTool: RegisteredTool | undefined;
		const customEntries = makeCustomEntryStore();
		const pi = {
			on() {},
			registerTool(tool: RegisteredTool) {
				registeredTool = tool;
			},
			registerCommand() {},
			registerFlag() {},
			getFlag() {
				return undefined;
			},
			appendEntry: customEntries.appendEntry,
			reportManagedLane() {},
			reportSpawnedUsage() {},
			sendMessage() {},
		};
		const context: TestContext = {
			cwd: tempDir,
			hasUI: false,
			sessionManager: {
				getSessionFile: () => path.join(tempDir, "doctrine-session.jsonl"),
				getLatestCustomEntryOnBranch: customEntries.getLatestCustomEntryOnBranch,
				getBranch: customEntries.getBranch,
			},
			ui: {
				notify() {},
				confirm: async () => {
					throw new Error("no UI is available in this test; confirm must never be reached");
				},
			},
		};
		tmuxAgentManagerExtension(pi as never);
		if (!registeredTool) throw new Error("tmux_agent_manager tool was not registered");

		// No grant was ever appended (customEntries starts empty) and hasUI is false, so a REAL
		// (non-dryRun) fire_task launch must be refused outright — never a silent dispatch.
		await expect(
			registeredTool.execute(
				"fire-call",
				{
					action: "fire_task",
					task: "do the thing",
					jobId: "doctrine-job",
					agents: [{ provider: "pi" }],
					dryRun: false,
				},
				new AbortController().signal,
				() => {},
				context,
			),
		).rejects.toThrow(/no standing grant for tmux dispatch; run grant_dispatch first/);
		expect(customEntries.entries).toHaveLength(0);
	});
});
