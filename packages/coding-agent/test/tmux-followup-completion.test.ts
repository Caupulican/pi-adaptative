import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
	ui: { notify(message: string, level: string): void };
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
type SentMessage = {
	message: { customType: string; content: string; display: boolean; details?: unknown };
	options?: { triggerTurn?: boolean; deliverAs?: string };
};
type LaneEvent = { laneId: string; phase: "dispatch" | "terminal"; status?: string; request?: unknown };

/** A smarter fake tmux than a plain `exit 0` stub: it answers list-sessions/has-session/list-panes/
 * `display-message -p ... #{pane_pipe}` from small state files under `stateDir`, and appends every
 * invocation (full argv, space-joined) to `calls.log` so tests can assert what was (or crucially,
 * was NOT) invoked — e.g. that reconcile never calls kill-session on an orphaned job. */
function writeFakeTmux(binDir: string, stateDir: string): void {
	fs.mkdirSync(binDir, { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
	const script = [
		"#!/bin/sh",
		`state=${quote(stateDir)}`,
		'printf "%s\\n" "$*" >> "$state/calls.log"',
		'cmd="$1"',
		"shift",
		'target=""',
		'prev=""',
		'for a in "$@"; do',
		'  if [ "$prev" = "-t" ]; then target="$a"; fi',
		'  prev="$a"',
		"done",
		'case "$cmd" in',
		"  -V)",
		"    printf 'tmux fake 1.0\\n'",
		"    ;;",
		"  has-session)",
		'    if [ -f "$state/sessions.txt" ] && grep -qxF "$target" "$state/sessions.txt"; then exit 0; else exit 1; fi',
		"    ;;",
		"  list-sessions)",
		'    [ -f "$state/sessions.txt" ] && cat "$state/sessions.txt"',
		"    ;;",
		"  list-panes)",
		'    [ -f "$state/panes-$target.txt" ] && cat "$state/panes-$target.txt"',
		"    ;;",
		"  display-message)",
		'    case " $* " in',
		'      *" -p "*)',
		"        if [ -f \"$state/pipe-$target.flag\" ]; then printf '1\\n'; else printf '0\\n'; fi",
		"        ;;",
		"    esac",
		"    ;;",
		"esac",
		"exit 0",
	].join("\n");
	fs.writeFileSync(path.join(binDir, "tmux"), `${script}\n`, { mode: 0o700 });
}
function quote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
function setSessions(stateDir: string, names: string[]): void {
	fs.writeFileSync(path.join(stateDir, "sessions.txt"), `${names.join("\n")}\n`);
}
function setPanes(stateDir: string, sessionName: string, paneIds: string[]): void {
	fs.writeFileSync(path.join(stateDir, `panes-${sessionName}.txt`), `${paneIds.join("\n")}\n`);
}
function markPanePiped(stateDir: string, paneId: string): void {
	fs.writeFileSync(path.join(stateDir, `pipe-${paneId}.flag`), "1\n");
}
function readCalls(stateDir: string): string[] {
	try {
		return fs
			.readFileSync(path.join(stateDir, "calls.log"), "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0);
	} catch {
		return [];
	}
}

describe.skipIf(process.platform === "win32")("tmux follow-up + dismiss + session reconcile", () => {
	let tempDir: string;
	let stateDir: string;
	let previousAgentDir: string | undefined;
	let previousPath: string | undefined;
	const sessionFilePath = () => path.join(tempDir, "parent-session.jsonl");

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-followup-"));
		stateDir = path.join(tempDir, "fake-tmux-state");
		const binDir = path.join(tempDir, "bin");
		writeFakeTmux(binDir, stateDir);
		previousAgentDir = process.env[ENV_AGENT_DIR];
		previousPath = process.env.PATH;
		process.env[ENV_AGENT_DIR] = tempDir;
		process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		fs.rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function writeJob(jobId: string, opts: { paneId: string; sessionName: string; withTerminalTurn1?: boolean }) {
		const jobDir = path.join(getTmuxAgentManagerDataRoot(), "jobs", jobId);
		const logPath = path.join(jobDir, "worker.log");
		const resultPath = path.join(jobDir, "worker.result.json");
		fs.mkdirSync(jobDir, { recursive: true });
		fs.writeFileSync(logPath, "turn 1 captured output\n");
		if (opts.withTerminalTurn1 !== false) {
			fs.writeFileSync(
				resultPath,
				`${JSON.stringify({
					jobId,
					agentId: "worker",
					agentName: "worker",
					status: "done",
					exitCode: null,
					logPath,
					paneId: opts.paneId,
					finishedAt: new Date().toISOString(),
					notifiedBy: "pane-output-event",
				})}\n`,
			);
		}
		const jobPath = path.join(jobDir, "job.json");
		fs.writeFileSync(
			jobPath,
			JSON.stringify(
				{
					id: jobId,
					createdAt: new Date().toISOString(),
					parentSessionFile: sessionFilePath(),
					workspaceName: opts.sessionName,
					sessionName: opts.sessionName,
					cwd: tempDir,
					task: "initial task",
					deadlineSeconds: 60,
					jobDir,
					jobPath,
					varsPath: path.join(jobDir, "variables.json"),
					watcherPath: path.join(jobDir, "pane-watcher.sh"),
					launchCommands: [],
					// Already notified for turn 1, matching a job whose first-turn handoff already fired.
					notifiedAt: opts.withTerminalTurn1 === false ? undefined : new Date().toISOString(),
					agents: [
						{
							id: "worker",
							provider: "pi",
							name: "worker",
							command: "pi",
							cwd: tempDir,
							promptPath: path.join(jobDir, "worker.prompt.md"),
							logPath,
							resultPath,
							doneMarker: "TMUX_TURN1_DONE",
							blockedMarker: "TMUX_TURN1_BLOCKED",
							paneId: opts.paneId,
							currentTurn: 1,
							notifiedTurn: opts.withTerminalTurn1 === false ? undefined : 1,
						},
					],
				},
				null,
				2,
			),
		);
		return { jobDir, jobPath, resultPath };
	}

	function installExtension() {
		const handlers = new Map<string, Handler[]>();
		const sent: SentMessage[] = [];
		const laneEvents: LaneEvent[] = [];
		let registeredTool: RegisteredTool | undefined;
		// A minimal in-memory session custom-entry store — just enough to back the STANDING GRANT
		// (appendEntry/getLatestCustomEntryOnBranch/getBranch), added because a real (non-dryRun)
		// send_followup dispatch is now approval-gated (see tmux-dispatch-grant.test.ts for the dedicated
		// grant-lifecycle coverage). Not used by the dismiss/reconcile tests below.
		const entries: StoredEntry[] = [];
		let leafId: string | null = null;
		let entrySeq = 0;
		const appendEntry = (customType: string, data?: unknown) => {
			const id = `entry-${++entrySeq}`;
			entries.push({ id, parentId: leafId, type: "custom", customType, data });
			leafId = id;
		};
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
			sendMessage(message: SentMessage["message"], options?: SentMessage["options"]) {
				sent.push({ message, options });
			},
			reportManagedLane(event: LaneEvent) {
				laneEvents.push(event);
			},
			appendEntry,
		};
		const context: TestContext = {
			cwd: tempDir,
			hasUI: false,
			sessionManager: {
				getSessionFile: () => sessionFilePath(),
				getLatestCustomEntryOnBranch(customType: string, fromId?: string) {
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
			},
			ui: { notify() {} },
		};
		tmuxAgentManagerExtension(pi as never);
		if (!registeredTool) throw new Error("tmux_agent_manager tool was not registered");
		return { registeredTool, handlers, sent, laneEvents, context, seedCustomEntry: appendEntry };
	}

	it("send_followup dispatches a fresh turn and its terminal fires exactly once via the same followUp handoff path", async () => {
		const jobId = "followup-job";
		const paneId = "%1";
		const sessionName = "followup-session";
		setSessions(stateDir, [sessionName]);
		setPanes(stateDir, sessionName, [paneId]);
		const { jobDir, jobPath } = writeJob(jobId, { paneId, sessionName });
		const { registeredTool, sent, laneEvents, context, seedCustomEntry } = installExtension();
		// A real (non-dryRun) send_followup is approval-gated (standing-grant doctrine); seed one
		// covering this job's agent so this test still exercises the follow-up MECHANICS unattended. The
		// grant lifecycle itself (creation approval, budget, refusal without one) is covered in
		// tmux-dispatch-grant.test.ts.
		seedCustomEntry("tmux-dispatch-grant", {
			grantId: "test-grant",
			createdAt: new Date().toISOString(),
			agent: "pi",
			scope: {},
			envelope: {},
			budget: { maxLaunches: 10 },
		});
		const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(() => {
			throw new Error("completion polling is forbidden");
		});

		const followup = await registeredTool.execute(
			"followup-call",
			{ action: "send_followup", jobId, task: "take another look" },
			new AbortController().signal,
			() => {},
			context,
		);
		expect(followup.content[0]?.text).toContain("turn 2");
		expect(sent).toEqual([]); // turn 2 has not settled yet — no premature handoff

		const jobAfterDispatch = JSON.parse(fs.readFileSync(jobPath, "utf8"));
		expect(jobAfterDispatch.agents[0].currentTurn).toBe(2);
		expect(fs.existsSync(path.join(jobDir, "worker.turn-2.prompt.md"))).toBe(true);
		expect(fs.existsSync(path.join(jobDir, "pane-watcher.turn-2.sh"))).toBe(true);

		const calls = readCalls(stateDir);
		expect(calls.some((line) => line.startsWith("pipe-pane") && line.includes(paneId))).toBe(true);
		expect(laneEvents).toContainEqual(
			expect.objectContaining({ laneId: `tmux:${jobId}:worker`, phase: "dispatch", status: "follow-up" }),
		);

		// Simulate the re-armed watcher settling on turn 2's marker.
		const turn2ResultPath = path.join(jobDir, "worker.turn-2.result.json");
		fs.writeFileSync(
			turn2ResultPath,
			`${JSON.stringify({
				jobId,
				agentId: "worker",
				agentName: "worker",
				status: "done",
				exitCode: null,
				logPath: path.join(jobDir, "worker.log"),
				paneId,
				finishedAt: new Date().toISOString(),
				notifiedBy: "pane-output-event",
			})}\n`,
		);

		// A cheap, harmless call is enough to trigger the wrapper's post-execute queueJobHandoffRefresh
		// (every execute() call does this — no reliance on real fs.watch timing, matching how the
		// existing completion test drives its own handoff assertion).
		await registeredTool.execute("poke-1", { action: "list_jobs" }, new AbortController().signal, () => {}, context);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(sent[0]?.message.customType).toBe("tmux-background-completion");
		expect(sent[0]?.message.content).toContain("worker: done");
		expect(laneEvents).toContainEqual(expect.objectContaining({ laneId: `tmux:${jobId}:worker`, phase: "terminal" }));

		const jobAfterTerminal = JSON.parse(fs.readFileSync(jobPath, "utf8"));
		expect(jobAfterTerminal.agents[0].notifiedTurn).toBe(2);

		// A further refresh must NOT re-deliver the same turn's handoff.
		await registeredTool.execute("poke-2", { action: "list_jobs" }, new AbortController().signal, () => {}, context);
		expect(sent).toHaveLength(1);
		expect(intervalSpy).not.toHaveBeenCalled();
	});

	it("refuses send_followup when the tmux session or the target pane is gone, without relaunching anything", async () => {
		const jobId = "gone-job";
		const paneId = "%9";
		const sessionName = "gone-session";
		// Session never registered as live.
		setSessions(stateDir, []);
		writeJob(jobId, { paneId, sessionName });
		const { registeredTool, context } = installExtension();

		await expect(
			registeredTool.execute(
				"followup-call",
				{ action: "send_followup", jobId, task: "keep going" },
				new AbortController().signal,
				() => {},
				context,
			),
		).rejects.toThrow(/session is gone/);
	});

	it("dismiss stops tracking a job and leaves the tmux session running (never calls kill-session)", async () => {
		const jobId = "dismiss-job";
		const paneId = "%1";
		const sessionName = "dismiss-session";
		setSessions(stateDir, [sessionName]);
		setPanes(stateDir, sessionName, [paneId]);
		// Non-terminal job: dismiss must stop it from being tracked even though it never finished.
		const { jobPath } = writeJob(jobId, { paneId, sessionName, withTerminalTurn1: false });
		const { registeredTool, sent, laneEvents, context } = installExtension();

		const dismissed = await registeredTool.execute(
			"dismiss-call",
			{ action: "dismiss", jobId },
			new AbortController().signal,
			() => {},
			context,
		);
		expect(dismissed.content[0]?.text).toContain("Dismissed");
		expect(dismissed.content[0]?.text).toContain("not killed");
		expect(JSON.parse(fs.readFileSync(jobPath, "utf8"))).toHaveProperty("dismissedAt");
		expect(laneEvents).toContainEqual(
			expect.objectContaining({ laneId: `tmux:${jobId}:worker`, phase: "terminal", status: "dismissed" }),
		);

		// Dismissing again is a no-op that says so, not a re-dismiss.
		const again = await registeredTool.execute(
			"dismiss-call-2",
			{ action: "dismiss", jobId },
			new AbortController().signal,
			() => {},
			context,
		);
		expect(again.content[0]?.text).toContain("already dismissed");

		await registeredTool.execute("poke", { action: "list_jobs" }, new AbortController().signal, () => {}, context);
		expect(sent).toEqual([]); // a dismissed, still-non-terminal job never gets a handoff

		const calls = readCalls(stateDir);
		expect(calls.some((line) => line.startsWith("kill-session"))).toBe(false);
	});

	it("session_start reconcile marks an orphaned job informational (session gone) without ever killing anything", async () => {
		const jobId = "orphan-job";
		const paneId = "%1";
		const sessionName = "orphan-session";
		// The session is NOT in the live set — simulates a tmux server/session that died while the
		// job never reached a terminal state (e.g. a hard kill that skipped the watcher's own
		// EOF-triggered finish()).
		setSessions(stateDir, []);
		const { jobPath } = writeJob(jobId, { paneId, sessionName, withTerminalTurn1: false });
		const { handlers, context } = installExtension();
		const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(() => {
			throw new Error("completion polling is forbidden");
		});

		for (const handler of handlers.get("session_start") ?? []) await handler({}, context);

		expect(JSON.parse(fs.readFileSync(jobPath, "utf8"))).toHaveProperty("orphanedAt");
		const calls = readCalls(stateDir);
		expect(calls.some((line) => line.startsWith("kill-session"))).toBe(false);
		expect(intervalSpy).not.toHaveBeenCalled();

		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
	});

	it("session_start reconcile resumes a live job by re-arming its watcher only when no pipe is already attached", async () => {
		const resumableId = "resumable-job";
		const alreadyPipedId = "already-piped-job";
		const resumablePane = "%2";
		const pipedPane = "%3";
		const sessionName = "shared-session";
		setSessions(stateDir, [sessionName]);
		setPanes(stateDir, sessionName, [resumablePane, pipedPane]);
		markPanePiped(stateDir, pipedPane); // this pane already has a live watcher attached

		const resumable = writeJob(resumableId, { paneId: resumablePane, sessionName, withTerminalTurn1: false });
		const alreadyPiped = writeJob(alreadyPipedId, { paneId: pipedPane, sessionName, withTerminalTurn1: false });
		const { handlers, laneEvents, context } = installExtension();
		const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(() => {
			throw new Error("completion polling is forbidden");
		});

		for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
		expect(intervalSpy).not.toHaveBeenCalled();

		expect(JSON.parse(fs.readFileSync(resumable.jobPath, "utf8"))).not.toHaveProperty("orphanedAt");
		expect(JSON.parse(fs.readFileSync(alreadyPiped.jobPath, "utf8"))).not.toHaveProperty("orphanedAt");

		const calls = readCalls(stateDir);
		expect(calls.some((line) => line.startsWith("pipe-pane") && line.includes(resumablePane))).toBe(true);
		expect(calls.some((line) => line.startsWith("pipe-pane") && line.includes(pipedPane))).toBe(false);
		expect(laneEvents).toContainEqual(
			expect.objectContaining({ laneId: `tmux:${resumableId}:worker`, phase: "dispatch", status: "resumed" }),
		);
		expect(
			laneEvents.some((event) => event.laneId === `tmux:${alreadyPipedId}:worker` && event.status === "resumed"),
		).toBe(false);

		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
	});
});
