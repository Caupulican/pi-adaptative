import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import tmuxAgentManagerExtension, {
	getTmuxAgentManagerDataRoot,
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
type ManagedLaneEventCapture = {
	laneId: string;
	phase: "dispatch" | "terminal";
	goalId?: string;
	status?: string;
	reasonCode?: string;
	usage?: unknown;
};

/** Minimal in-memory session custom-entry store — the tmux extension unconditionally calls
 * `registerFlag` at load time and reads/writes entries when a grant action needs them; neither
 * scenario here dispatches a real launch, so this only needs to exist, not be exercised. */
function makeCustomEntryStore() {
	const entries: StoredEntry[] = [];
	return {
		entries,
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ id: `entry-${entries.length + 1}`, parentId: null, type: "custom", customType, data });
		},
		getLatestCustomEntryOnBranch: () => undefined,
		getBranch: () => entries.slice(),
	};
}

function writeJob(
	jobDir: string,
	job: {
		id: string;
		sessionName: string;
		parentSessionFile: string;
		agents: Array<{ id: string; name: string; result?: { status: string }; notifiedTurn?: number }>;
	},
): string {
	const jobPath = path.join(jobDir, "job.json");
	fs.mkdirSync(jobDir, { recursive: true });
	fs.writeFileSync(
		jobPath,
		JSON.stringify(
			{
				id: job.id,
				createdAt: new Date().toISOString(),
				parentSessionFile: job.parentSessionFile,
				workspaceName: "orphan-workspace",
				sessionName: job.sessionName,
				cwd: jobDir,
				task: "test",
				deadlineSeconds: 60,
				jobDir,
				jobPath,
				varsPath: path.join(jobDir, "variables.json"),
				watcherPath: path.join(jobDir, "pane-watcher.mjs"),
				launchCommands: [],
				agents: job.agents.map((agent) => ({
					id: agent.id,
					provider: "pi",
					name: agent.name,
					cwd: jobDir,
					doneMarker: "DONE",
					blockedMarker: "BLOCKED",
					promptPath: path.join(jobDir, `${agent.id}.prompt.txt`),
					logPath: path.join(jobDir, `${agent.id}.log`),
					resultPath: path.join(jobDir, `${agent.id}.result.json`),
					notifiedTurn: agent.notifiedTurn,
				})),
			},
			null,
			2,
		),
	);
	// loadJob() re-derives each agent's `result` from its OWN result file on disk (turn 1's
	// currentResultPath), ignoring any `result` embedded in job.json — so a "terminal" agent needs a
	// real result file, matching how the pane watcher itself reports completion.
	for (const agent of job.agents) {
		if (agent.result === undefined) continue;
		fs.writeFileSync(path.join(jobDir, `${agent.id}.result.json`), JSON.stringify(agent.result));
	}
	return jobPath;
}

function writeFakeTmux(binDir: string, liveSessions: string[]): void {
	fs.mkdirSync(binDir, { recursive: true });
	const sessionLines = liveSessions.join("\\n");
	fs.writeFileSync(
		path.join(binDir, "tmux"),
		[
			"#!/bin/sh",
			`if [ "\${1:-}" = "-V" ]; then printf 'tmux test\\n'; exit 0; fi`,
			`if [ "\${1:-}" = "list-sessions" ]; then printf '${sessionLines}\\n'; exit 0; fi`,
			"exit 0",
			"",
		].join("\n"),
		{ mode: 0o700 },
	);
}

describe.skipIf(process.platform === "win32")("tmux orphan-release", () => {
	let tempDir: string;
	let previousAgentDir: string | undefined;
	let previousPath: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-orphan-"));
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
	});

	// Fixed for the lifetime of a test (keyed off tempDir) so writeJob's parentSessionFile and the
	// context's getSessionFile() always agree — reconcileTmuxSessions only picks up a job whose
	// parentSessionFile matches the current session file.
	function parentSessionFilePath(): string {
		return path.join(tempDir, "parent-session.jsonl");
	}

	function setUp(liveSessions: string[]) {
		const tmuxBinDir = path.join(tempDir, "bin");
		writeFakeTmux(tmuxBinDir, liveSessions);
		process.env.PATH = `${tmuxBinDir}:${process.env.PATH ?? ""}`;

		const handlers = new Map<string, Handler[]>();
		const managedLaneEvents: ManagedLaneEventCapture[] = [];
		const customEntries = makeCustomEntryStore();
		const sessionFile = parentSessionFilePath();
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
			reportManagedLane(event: ManagedLaneEventCapture) {
				managedLaneEvents.push(event);
			},
			reportSpawnedUsage() {},
			sendMessage() {},
		};
		const context: TestContext = {
			cwd: tempDir,
			hasUI: false,
			sessionManager: {
				getSessionFile: () => sessionFile,
				getLatestCustomEntryOnBranch: customEntries.getLatestCustomEntryOnBranch,
				getBranch: customEntries.getBranch,
			},
			ui: { notify() {}, confirm: async () => true },
		};
		tmuxAgentManagerExtension(pi as never);

		return {
			sessionFile,
			managedLaneEvents,
			async triggerSessionStart(): Promise<void> {
				for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
			},
			async triggerSessionShutdown(): Promise<void> {
				for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
			},
		};
	}

	function jobDirFor(jobId: string): string {
		return path.join(getTmuxAgentManagerDataRoot(), "jobs", jobId);
	}

	it("releases the managed lane for a non-terminal agent when its tmux session is dead", async () => {
		const jobId = "orphan-job";
		const jobDir = jobDirFor(jobId);
		const jobPath = writeJob(jobDir, {
			id: jobId,
			sessionName: "dead-session",
			parentSessionFile: parentSessionFilePath(),
			agents: [{ id: "worker", name: "worker" }],
		});

		const harness = setUp([]); // no live sessions => "dead-session" is gone
		await harness.triggerSessionStart();

		expect(harness.managedLaneEvents).toContainEqual({
			laneId: "tmux:orphan-job:worker",
			phase: "terminal",
			status: "orphaned",
			reasonCode: "tmux_session_orphaned",
		});
		// Nothing was killed — only the lane record was released. orphanedAt is informational.
		expect(JSON.parse(fs.readFileSync(jobPath, "utf8"))).toHaveProperty("orphanedAt");

		await harness.triggerSessionShutdown();
	});

	it("releases exactly one lane per non-terminal agent, and none for an already-terminal agent in the same job", async () => {
		const jobId = "orphan-mixed-job";
		const jobDir = jobDirFor(jobId);
		writeJob(jobDir, {
			id: jobId,
			sessionName: "dead-session-2",
			parentSessionFile: parentSessionFilePath(),
			agents: [
				{ id: "worker-a", name: "worker-a" },
				{ id: "worker-b", name: "worker-b" },
				{ id: "worker-c", name: "worker-c", result: { status: "done" }, notifiedTurn: 1 },
			],
		});

		const harness = setUp([]);
		await harness.triggerSessionStart();

		const orphanEvents = harness.managedLaneEvents.filter((event) => event.reasonCode === "tmux_session_orphaned");
		expect(orphanEvents).toHaveLength(2);
		expect(orphanEvents.map((event) => event.laneId).sort()).toEqual([
			"tmux:orphan-mixed-job:worker-a",
			"tmux:orphan-mixed-job:worker-b",
		]);

		await harness.triggerSessionShutdown();
	});

	it("does not release the lane for a job that already reached a terminal state (session dead)", async () => {
		const jobId = "already-terminal-job";
		const jobDir = jobDirFor(jobId);
		const jobPath = writeJob(jobDir, {
			id: jobId,
			sessionName: "dead-session-3",
			parentSessionFile: parentSessionFilePath(),
			// notifiedTurn === currentTurn (both default to 1) so the completion-handoff path (a
			// separate reportManagedLane caller) has nothing pending and stays quiet too — isolating
			// this assertion to the orphan-release branch under test.
			agents: [{ id: "worker", name: "worker", result: { status: "done" }, notifiedTurn: 1 }],
		});

		const harness = setUp([]); // session is dead, but the job is already terminal
		await harness.triggerSessionStart();

		expect(harness.managedLaneEvents).toEqual([]);
		// A terminal job is never marked orphaned — the guard is `!isFireTaskTerminal(job)`.
		expect(JSON.parse(fs.readFileSync(jobPath, "utf8"))).not.toHaveProperty("orphanedAt");

		await harness.triggerSessionShutdown();
	});

	it("does not release the lane for a non-terminal agent whose tmux session is alive", async () => {
		const jobId = "live-session-job";
		const jobDir = jobDirFor(jobId);
		const jobPath = writeJob(jobDir, {
			id: jobId,
			sessionName: "live-session",
			parentSessionFile: parentSessionFilePath(),
			agents: [{ id: "worker", name: "worker" }],
		});

		const harness = setUp(["live-session"]); // the job's session is still alive
		await harness.triggerSessionStart();

		expect(harness.managedLaneEvents.filter((event) => event.reasonCode === "tmux_session_orphaned")).toEqual([]);
		expect(JSON.parse(fs.readFileSync(jobPath, "utf8"))).not.toHaveProperty("orphanedAt");

		await harness.triggerSessionShutdown();
	});
});
