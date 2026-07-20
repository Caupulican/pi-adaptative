import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildGrant,
	buildLaunchProfileFlags,
	countGrantUsages,
	DEFAULT_READ_BIASED_TOOLS,
	decodeTmuxWorkerUsageClaim,
	GRANT_CUSTOM_TYPE,
	grantCovers,
	isGrantBudgetExhausted,
	isTmuxDispatchGrant,
	isTmuxDispatchGrantTombstone,
	isTmuxDispatchGrantUsage,
	ONE_SHOT_LAUNCH_PROFILE_SOURCE,
} from "../src/bundled-resources/extensions/tmux-agent-manager/dispatch-grant.ts";
import tmuxAgentManagerExtension, {
	getTmuxAgentManagerDataRoot,
} from "../src/bundled-resources/extensions/tmux-agent-manager/index.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

// ---------------------------------------------------------------------------
// Pure dispatch-grant.ts unit tests — no session/tmux access, direct function calls.
// ---------------------------------------------------------------------------

describe("dispatch-grant pure logic", () => {
	it("type guards distinguish a grant, a tombstone, and a usage entry", () => {
		const grant = buildGrant({ agent: "pi", maxLaunches: 3 });
		expect(isTmuxDispatchGrant(grant)).toBe(true);
		expect(isTmuxDispatchGrantTombstone(grant)).toBe(false);

		const tombstone = { tombstone: true as const, grantId: "g1", revokedAt: new Date().toISOString() };
		expect(isTmuxDispatchGrantTombstone(tombstone)).toBe(true);
		expect(isTmuxDispatchGrant(tombstone)).toBe(false);

		expect(isTmuxDispatchGrantUsage({ grantId: "g1", jobId: "j1", at: new Date().toISOString() })).toBe(true);
		expect(isTmuxDispatchGrant(null)).toBe(false);
		expect(isTmuxDispatchGrant("not an object")).toBe(false);
		expect(isTmuxDispatchGrant({ ...grant, budget: { maxLaunches: "three" } })).toBe(false);
	});

	it("grantCovers matches agent + goal scope and respects expiry", () => {
		const unscoped = buildGrant({ agent: "pi", maxLaunches: 5 });
		expect(grantCovers(unscoped, { agent: "pi" })).toBe(true);
		expect(grantCovers(unscoped, { agent: "pi", goalId: "goal-1" })).toBe(true);
		expect(grantCovers(unscoped, { agent: "agy" })).toBe(false);

		const scoped = buildGrant({ agent: "pi", goalId: "goal-1", maxLaunches: 5 });
		expect(grantCovers(scoped, { agent: "pi", goalId: "goal-1" })).toBe(true);
		expect(grantCovers(scoped, { agent: "pi", goalId: "goal-2" })).toBe(false);
		expect(grantCovers(scoped, { agent: "pi" })).toBe(false);

		const expired: ReturnType<typeof buildGrant> = {
			...buildGrant({ agent: "pi", maxLaunches: 5 }),
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
		};
		expect(grantCovers(expired, { agent: "pi" })).toBe(false);
	});

	it("counts usages per grantId and reports budget exhaustion", () => {
		const grant = buildGrant({ agent: "pi", maxLaunches: 2 });
		const usages = [
			{ grantId: grant.grantId, jobId: "a", at: new Date().toISOString() },
			{ grantId: grant.grantId, jobId: "b", at: new Date().toISOString() },
			{ grantId: "other-grant", jobId: "c", at: new Date().toISOString() },
		];
		expect(countGrantUsages(grant.grantId, usages)).toBe(2);
		expect(isGrantBudgetExhausted(grant, 1)).toBe(false);
		expect(isGrantBudgetExhausted(grant, 2)).toBe(true);
	});

	it("buildGrant rejects maxLaunches < 1 and derives expiresAt from expiresInMinutes", () => {
		expect(() => buildGrant({ agent: "pi", maxLaunches: 0 })).toThrow(/maxLaunches/);
		const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
		const grant = buildGrant({ agent: "pi", maxLaunches: 1, expiresInMinutes: 10 }, now);
		expect(grant.expiresAt).toBe(new Date(Date.parse(now) + 10 * 60_000).toISOString());
		expect(buildGrant({ agent: "pi", maxLaunches: 1 }, now).expiresAt).toBeUndefined();
	});

	it("buildLaunchProfileFlags derives --tools/--resource-profile (or --no-extensions --no-skills) and a scoped --append-system-prompt", () => {
		const withProfile = buildLaunchProfileFlags({
			identity: "grant g1",
			allowedTools: ["read", "grep"],
			resourceProfile: "backend",
			writePaths: ["/tmp/x"],
		});
		expect(withProfile[0]).toEqual({ flag: "--tools", value: "read,grep" });
		expect(withProfile[1]).toEqual({ flag: "--resource-profile", value: "backend" });
		expect(withProfile[2]?.flag).toBe("--append-system-prompt");
		expect(withProfile[2]?.value).toContain("grant g1");
		expect(withProfile[2]?.value).toContain("/tmp/x");
		expect(withProfile[2]?.value).toContain("BLOCKED");

		const withoutProfile = buildLaunchProfileFlags(ONE_SHOT_LAUNCH_PROFILE_SOURCE);
		expect(withoutProfile[0]).toEqual({ flag: "--tools", value: DEFAULT_READ_BIASED_TOOLS.join(",") });
		expect(withoutProfile).toContainEqual({ flag: "--no-extensions" });
		expect(withoutProfile).toContainEqual({ flag: "--no-skills" });
	});

	it("buildLaunchProfileFlags appends --parent-pid/--parent-session only when present on the source", () => {
		const withParent = buildLaunchProfileFlags({
			...ONE_SHOT_LAUNCH_PROFILE_SOURCE,
			parentPid: 4242,
			parentSession: "master-session-1",
		});
		expect(withParent).toContainEqual({ flag: "--parent-pid", value: "4242" });
		expect(withParent).toContainEqual({ flag: "--parent-session", value: "master-session-1" });

		const withoutParent = buildLaunchProfileFlags(ONE_SHOT_LAUNCH_PROFILE_SOURCE);
		expect(withoutParent.some((flag) => flag.flag === "--parent-pid")).toBe(false);
		expect(withoutParent.some((flag) => flag.flag === "--parent-session")).toBe(false);
	});

	it("decodeTmuxWorkerUsageClaim permissively decodes a partial claim and rejects non-objects", () => {
		expect(decodeTmuxWorkerUsageClaim(null)).toBeUndefined();
		expect(decodeTmuxWorkerUsageClaim("nope")).toBeUndefined();
		expect(decodeTmuxWorkerUsageClaim({ input: 10, output: 5, cost: { total: 0.02 } })).toEqual({
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
		});
	});
});

// ---------------------------------------------------------------------------
// Integration tests — exercise the registered tool end to end against a fake tmux + a fake pi/ctx that
// implements a minimal in-memory session custom-entry store (appendEntry/getLatestCustomEntryOnBranch/
// getBranch), matching the real branch-walk semantics well enough to prove the grant lifecycle.
// ---------------------------------------------------------------------------

type RegisteredTool = {
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: () => void,
		context: unknown,
	): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
};
type LaneEvent = {
	laneId: string;
	phase: "dispatch" | "terminal";
	status?: string;
	goalId?: string;
	request?: unknown;
	worktreeLaneKey?: string;
};
type UsageReport = { usage: unknown; opts?: { label?: string; sourceSessionId?: string; reportId?: string } };
type StoredEntry = { id: string; parentId: string | null; type: "custom"; customType: string; data: unknown };

/** A fake tmux good enough to drive real fire_task/send_followup dispatch: `has-session`/`list-panes`
 * answer from small state files under `stateDir` (pre-seedable via `seedAliveSession`, or populated live
 * by `new-session`, which allocates and prints a fresh `%N` pane id like real tmux -P -F "#{pane_id}"). */
function writeFakeTmux(binDir: string, stateDir: string): void {
	fs.mkdirSync(binDir, { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
	const script = [
		"#!/bin/sh",
		`state=${quote(stateDir)}`,
		'printf "%s\\n" "$*" >> "$state/calls.log"',
		'cmd="$1"',
		"shift",
		'case "$cmd" in',
		"  -V)",
		"    printf 'tmux fake 1.0\\n'",
		"    exit 0",
		"    ;;",
		"  has-session)",
		'    target=""; prevflag=""',
		'    for arg in "$@"; do',
		'      if [ "$prevflag" = "-t" ]; then target="$arg"; fi',
		'      prevflag="$arg"',
		"    done",
		'    if [ -f "$state/sessions.txt" ] && grep -qxF "$target" "$state/sessions.txt"; then exit 0; else exit 1; fi',
		"    ;;",
		"  list-sessions)",
		'    [ -f "$state/sessions.txt" ] && cat "$state/sessions.txt"',
		"    exit 0",
		"    ;;",
		"  list-panes)",
		'    target=""; prevflag=""',
		'    for arg in "$@"; do',
		'      if [ "$prevflag" = "-t" ]; then target="$arg"; fi',
		'      prevflag="$arg"',
		"    done",
		'    [ -f "$state/panes-$target.txt" ] && cat "$state/panes-$target.txt"',
		"    exit 0",
		"    ;;",
		"  new-session)",
		'    sess=""; prevflag=""',
		'    for arg in "$@"; do',
		'      if [ "$prevflag" = "-s" ]; then sess="$arg"; fi',
		'      prevflag="$arg"',
		"    done",
		'    n=$(( $(cat "$state/pane-seq" 2>/dev/null || echo 0) + 1 ))',
		'    printf "%s" "$n" > "$state/pane-seq"',
		'    pane="%$n"',
		'    if [ -n "$sess" ]; then',
		'      printf "%s\\n" "$sess" >> "$state/sessions.txt"',
		'      printf "%s\\n" "$pane" >> "$state/panes-$sess.txt"',
		"    fi",
		'    printf "%s\\n" "$pane"',
		"    exit 0",
		"    ;;",
		"  display-message)",
		'    target=""; prevflag=""; wants_p=0',
		'    for arg in "$@"; do',
		'      if [ "$arg" = "-p" ]; then wants_p=1; fi',
		'      if [ "$prevflag" = "-t" ]; then target="$arg"; fi',
		'      prevflag="$arg"',
		"    done",
		'    if [ "$wants_p" = "1" ]; then',
		'      if [ -f "$state/pipe-$target.flag" ]; then printf "1\\n"; else printf "0\\n"; fi',
		"    fi",
		"    exit 0",
		"    ;;",
		"  *)",
		"    exit 0",
		"    ;;",
		"esac",
	].join("\n");
	fs.writeFileSync(path.join(binDir, "tmux"), `${script}\n`, { mode: 0o700 });
}
function quote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
function seedAliveSession(stateDir: string, sessionName: string, paneId: string): void {
	fs.appendFileSync(path.join(stateDir, "sessions.txt"), `${sessionName}\n`);
	fs.appendFileSync(path.join(stateDir, `panes-${sessionName}.txt`), `${paneId}\n`);
}

function writeJobFixture(
	tempDir: string,
	parentSessionFile: string,
	jobId: string,
	opts: { paneId: string; sessionName: string; notified?: boolean },
): { jobDir: string; jobPath: string; resultPath: string } {
	const jobDir = path.join(getTmuxAgentManagerDataRoot(), "jobs", jobId);
	const logPath = path.join(jobDir, "worker.log");
	const resultPath = path.join(jobDir, "worker.result.json");
	fs.mkdirSync(jobDir, { recursive: true });
	fs.writeFileSync(logPath, "turn 1 captured output\n");
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
	const jobPath = path.join(jobDir, "job.json");
	fs.writeFileSync(
		jobPath,
		JSON.stringify(
			{
				id: jobId,
				createdAt: new Date().toISOString(),
				parentSessionFile,
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
				notifiedAt: opts.notified === false ? undefined : new Date().toISOString(),
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
						notifiedTurn: opts.notified === false ? undefined : 1,
					},
				],
			},
			null,
			2,
		),
	);
	return { jobDir, jobPath, resultPath };
}

function installExtension(
	tempDir: string,
	opts?: {
		hasUI?: boolean;
		confirmImpl?: (title: string, message: string) => Promise<boolean>;
		flags?: Record<string, boolean | string>;
	},
) {
	const entries: StoredEntry[] = [];
	let leafId: string | null = null;
	let entrySeq = 0;
	const appendEntry = (customType: string, data?: unknown) => {
		const id = `entry-${++entrySeq}`;
		entries.push({ id, parentId: leafId, type: "custom", customType, data });
		leafId = id;
	};
	const laneEvents: LaneEvent[] = [];
	const usageReports: UsageReport[] = [];
	const confirmCalls: Array<{ title: string; message: string }> = [];
	const flags: Record<string, boolean | string> = { ...(opts?.flags ?? {}) };
	const sessionFile = path.join(tempDir, "parent-session.jsonl");
	let registeredTool: RegisteredTool | undefined;

	const pi = {
		on() {
			/* no session_start/session_shutdown wiring needed for these tests */
		},
		registerTool(tool: RegisteredTool) {
			registeredTool = tool;
		},
		registerCommand() {},
		sendMessage() {},
		appendEntry,
		reportManagedLane(event: LaneEvent) {
			laneEvents.push(event);
		},
		reportSpawnedUsage(usage: unknown, reportOpts?: UsageReport["opts"]) {
			usageReports.push({ usage, opts: reportOpts });
		},
		registerFlag() {
			/* flags are pre-seeded via opts.flags; nothing to register against in this fake */
		},
		getFlag(name: string) {
			return flags[name];
		},
	};
	const context = {
		cwd: tempDir,
		hasUI: opts?.hasUI ?? false,
		sessionManager: {
			getSessionFile: () => sessionFile,
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
			getBranch() {
				return entries.slice();
			},
		},
		ui: {
			notify() {},
			confirm: async (title: string, message: string) => {
				confirmCalls.push({ title, message });
				return opts?.confirmImpl ? opts.confirmImpl(title, message) : true;
			},
		},
	};
	tmuxAgentManagerExtension(pi as never);
	if (!registeredTool) throw new Error("tmux_agent_manager tool was not registered");
	return {
		registeredTool,
		context,
		entries,
		laneEvents,
		usageReports,
		confirmCalls,
		flags,
		seedCustomEntry: appendEntry,
	};
}

describe.skipIf(process.platform === "win32")("tmux dispatch grant — approval-gated launch", () => {
	let tempDir: string;
	let stateDir: string;
	let previousAgentDir: string | undefined;
	let previousPath: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-grant-"));
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
	});

	it("fire_task refuses a real launch with NO grant and NO interactive approval (doctrine-regression)", async () => {
		const { registeredTool, context } = installExtension(tempDir, { hasUI: false });
		await expect(
			registeredTool.execute(
				"fire-call",
				{
					action: "fire_task",
					task: "do the thing",
					jobId: "no-grant-job",
					agents: [{ provider: "pi" }],
					dryRun: false,
				},
				new AbortController().signal,
				() => {},
				context,
			),
		).rejects.toThrow(/no standing grant for tmux dispatch; run grant_dispatch first/);
	});

	it("send_followup refuses a real dispatch with NO grant and NO interactive approval (doctrine-regression)", async () => {
		const sessionName = "followup-session";
		const paneId = "%1";
		seedAliveSession(stateDir, sessionName, paneId);
		const { registeredTool, context } = installExtension(tempDir, { hasUI: false });
		writeJobFixture(tempDir, context.sessionManager.getSessionFile(), "followup-job", { paneId, sessionName });
		await expect(
			registeredTool.execute(
				"followup-call",
				{ action: "send_followup", jobId: "followup-job", task: "keep going" },
				new AbortController().signal,
				() => {},
				context,
			),
		).rejects.toThrow(/no standing grant for tmux dispatch; run grant_dispatch first/);
	});

	it("grant_dispatch requires interactive confirm (hasUI) or the opt-in flag — never silent", async () => {
		const declining = installExtension(tempDir, { hasUI: true, confirmImpl: async () => false });
		await expect(
			declining.registeredTool.execute(
				"g1",
				{ action: "grant_dispatch", agent: "pi", maxLaunches: 3 },
				new AbortController().signal,
				() => {},
				declining.context,
			),
		).rejects.toThrow(/declined by the owner/);
		expect(declining.entries).toHaveLength(0);

		const approving = installExtension(tempDir, { hasUI: true, confirmImpl: async () => true });
		const created = await approving.registeredTool.execute(
			"g2",
			{ action: "grant_dispatch", agent: "pi", maxLaunches: 3 },
			new AbortController().signal,
			() => {},
			approving.context,
		);
		expect(created.content[0]?.text).toContain("Created tmux dispatch grant");
		expect(approving.entries).toHaveLength(1);
		expect(approving.confirmCalls).toHaveLength(1);

		const noFlag = installExtension(tempDir, { hasUI: false });
		await expect(
			noFlag.registeredTool.execute(
				"g3",
				{ action: "grant_dispatch", agent: "pi", maxLaunches: 3 },
				new AbortController().signal,
				() => {},
				noFlag.context,
			),
		).rejects.toThrow(/requires interactive approval/);
		expect(noFlag.entries).toHaveLength(0);

		const withFlag = installExtension(tempDir, { hasUI: false, flags: { "allow-tmux-dispatch": true } });
		const createdNoUI = await withFlag.registeredTool.execute(
			"g4",
			{ action: "grant_dispatch", agent: "pi", maxLaunches: 3 },
			new AbortController().signal,
			() => {},
			withFlag.context,
		);
		expect(createdNoUI.content[0]?.text).toContain("Created tmux dispatch grant");
		expect(withFlag.confirmCalls).toHaveLength(0);
		expect(withFlag.entries).toHaveLength(1);
	});

	it("revoke_grant tombstones the active grant so a later launch sees no grant", async () => {
		const { registeredTool, context, entries } = installExtension(tempDir, {
			hasUI: false,
			flags: { "allow-tmux-dispatch": true },
		});
		await registeredTool.execute(
			"grant",
			{ action: "grant_dispatch", agent: "pi", maxLaunches: 5 },
			new AbortController().signal,
			() => {},
			context,
		);
		expect(entries).toHaveLength(1);
		const revoked = await registeredTool.execute(
			"revoke",
			{ action: "revoke_grant" },
			new AbortController().signal,
			() => {},
			context,
		);
		expect(revoked.content[0]?.text).toContain("Revoked");
		expect(entries).toHaveLength(2);

		await expect(
			registeredTool.execute(
				"fire-after-revoke",
				{
					action: "fire_task",
					task: "do the thing",
					jobId: "after-revoke-job",
					agents: [{ provider: "pi" }],
					dryRun: false,
				},
				new AbortController().signal,
				() => {},
				context,
			),
		).rejects.toThrow(/no standing grant for tmux dispatch/);
	});

	it("a valid grant lets fire_task dispatch UNATTENDED (no confirm prompt), carries grant-derived launch-profile flags on the child pi command, reports the tmux-worker lane, and decrements the launch budget until exhausted", async () => {
		const { registeredTool, context, laneEvents, confirmCalls, seedCustomEntry } = installExtension(tempDir, {
			hasUI: true,
			confirmImpl: async () => {
				throw new Error("must not prompt for a one-shot when a standing grant already covers the launch");
			},
		});
		const grant = buildGrant({
			agent: "pi",
			maxLaunches: 1,
			allowedTools: ["read", "grep"],
			resourceProfile: "backend",
			writePaths: ["/tmp/scope"],
		});
		seedCustomEntry(GRANT_CUSTOM_TYPE, grant);

		const launched = await registeredTool.execute(
			"fire-1",
			{
				action: "fire_task",
				task: "investigate",
				jobId: "grant-job-1",
				agents: [{ provider: "pi" }],
				dryRun: false,
			},
			new AbortController().signal,
			() => {},
			context,
		);
		expect(confirmCalls).toHaveLength(0);
		const details = launched.details as { job: { agents: Array<{ command?: string }> } };
		const command = details.job.agents[0]?.command ?? "";
		expect(command).toContain("--tools 'read,grep'");
		expect(command).toContain("--resource-profile 'backend'");
		expect(command).toContain("--append-system-prompt");
		expect(command).toContain(grant.grantId);
		// Process-matrix parent identity is threaded onto every pi-provider child, independent of the
		// grant envelope (fire_task always spreads its own pid/sessionId onto the launch profile).
		expect(command).toContain(`--parent-pid '${process.pid}'`);
		expect(command).toContain(`--parent-session '${context.sessionManager.getSessionFile()}'`);
		expect(command).not.toContain("--no-approve");
		expect(laneEvents).toContainEqual(expect.objectContaining({ phase: "dispatch", status: "launched" }));

		// Budget was 1; it is now exhausted, so a SECOND real launch under the SAME (still hasUI-capable,
		// but here forced non-interactive) session is refused rather than silently reusing the grant.
		context.hasUI = false;
		await expect(
			registeredTool.execute(
				"fire-2",
				{
					action: "fire_task",
					task: "investigate again",
					jobId: "grant-job-2",
					agents: [{ provider: "pi" }],
					dryRun: false,
				},
				new AbortController().signal,
				() => {},
				context,
			),
		).rejects.toThrow(/no standing grant for tmux dispatch/);
	});

	it("a lane-first dispatch (agent carrying worktreeLane) appends --worktree-lane plus a lane-doctrine system-prompt clause, and reports the lane key on the managed-lane dispatch event", async () => {
		const { registeredTool, context, laneEvents, seedCustomEntry } = installExtension(tempDir, { hasUI: false });
		const grant = buildGrant({ agent: "pi", maxLaunches: 1 });
		seedCustomEntry(GRANT_CUSTOM_TYPE, grant);

		const launched = await registeredTool.execute(
			"fire-lane",
			{
				action: "fire_task",
				task: "work the lane",
				jobId: "lane-job-1",
				agents: [{ provider: "pi", cwd: tempDir, worktreeLane: "adhoc-1" }],
				dryRun: false,
			},
			new AbortController().signal,
			() => {},
			context,
		);
		const details = launched.details as { job: { agents: Array<{ command?: string }> } };
		const command = details.job.agents[0]?.command ?? "";
		expect(command).toContain("--worktree-lane 'adhoc-1'");
		// The whole --append-system-prompt VALUE is shell-quoted (quoteShell), so the doctrine
		// sentence's own inner quotes around the lane key come through escaped (`'\''adhoc-1'\'''`)
		// rather than as a bare `'adhoc-1'` substring -- assert on the surrounding text instead.
		expect(command).toContain("bound to worktree-sync lane");
		expect(command).toContain("adhoc-1");
		expect(command).toContain("never touch main directly");
		expect(laneEvents).toContainEqual(
			expect.objectContaining({ phase: "dispatch", status: "launched", worktreeLaneKey: "adhoc-1" }),
		);
	});

	it("a one-shot interactively-approved launch (no grant) still applies the conservative default profile and never persists a grant", async () => {
		const { registeredTool, context, confirmCalls, entries } = installExtension(tempDir, {
			hasUI: true,
			confirmImpl: async () => true,
		});
		const launched = await registeredTool.execute(
			"fire-oneshot",
			{ action: "fire_task", task: "one shot", jobId: "oneshot-job", agents: [{ provider: "pi" }], dryRun: false },
			new AbortController().signal,
			() => {},
			context,
		);
		expect(confirmCalls).toHaveLength(1);
		expect(entries).toHaveLength(0);
		const details = launched.details as { job: { agents: Array<{ command?: string }> } };
		const command = details.job.agents[0]?.command ?? "";
		expect(command).toContain(`--tools '${DEFAULT_READ_BIASED_TOOLS.join(",")}'`);
		expect(command).toContain("--no-extensions");
		expect(command).toContain("--no-skills");
	});

	it("attributes a cooperative worker's self-reported usage claim via reportSpawnedUsage with a deterministic, idempotent reportId", async () => {
		const sessionName = "usage-session";
		const paneId = "%9";
		seedAliveSession(stateDir, sessionName, paneId);
		const jobId = "usage-job";
		const { registeredTool, context, usageReports } = installExtension(tempDir, { hasUI: false });
		const { resultPath } = writeJobFixture(tempDir, context.sessionManager.getSessionFile(), jobId, {
			paneId,
			sessionName,
			notified: false,
		});
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

		await registeredTool.execute("poke-1", { action: "list_jobs" }, new AbortController().signal, () => {}, context);
		expect(usageReports).toHaveLength(1);
		expect(usageReports[0]?.opts?.reportId).toBe(`tmux-worker:${sessionName}:${jobId}:1`);
		expect(usageReports[0]?.opts?.label).toBe("tmux-worker");
		expect(usageReports[0]?.usage).toEqual({
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		});

		// A further refresh must not re-report the same turn's usage claim (matches the notifiedTurn gate
		// that also prevents re-delivering the terminal handoff).
		await registeredTool.execute("poke-2", { action: "list_jobs" }, new AbortController().signal, () => {}, context);
		expect(usageReports).toHaveLength(1);
	});

	it("a worker that offers no usage claim file reports nothing (never fabricated)", async () => {
		const sessionName = "no-usage-session";
		const paneId = "%8";
		seedAliveSession(stateDir, sessionName, paneId);
		const jobId = "no-usage-job";
		const { registeredTool, context, usageReports } = installExtension(tempDir, { hasUI: false });
		writeJobFixture(tempDir, context.sessionManager.getSessionFile(), jobId, {
			paneId,
			sessionName,
			notified: false,
		});

		await registeredTool.execute("poke", { action: "list_jobs" }, new AbortController().signal, () => {}, context);
		expect(usageReports).toHaveLength(0);
	});
});
