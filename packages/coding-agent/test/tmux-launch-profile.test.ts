import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import tmuxAgentManagerExtension, {
	getTmuxAgentManagerDataRoot,
} from "../src/bundled-resources/extensions/tmux-agent-manager/index.ts";
import {
	buildLaunchProfileFlags,
	DEFAULT_MANAGED_WORKER_TOOLS,
	decodeTmuxWorkerUsageClaim,
	deriveWorkerLaunchProfile,
} from "../src/bundled-resources/extensions/tmux-agent-manager/launch-profile.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

// ---------------------------------------------------------------------------
// Pure launch-profile.ts unit tests — no session/tmux access, direct function calls.
// ---------------------------------------------------------------------------

describe("tmux launch-profile pure logic", () => {
	it("inherits the policy-owned parent surface, strips spawn controls, and freezes the result", () => {
		const profile = deriveWorkerLaunchProfile({
			identity: "profile-1",
			inheritedTools: [
				"read",
				"bash",
				"write",
				"pipeline",
				"create_goal",
				"get_goal",
				"update_goal",
				"ask_question",
				"skill",
				"run_toolkit_script",
				"tool_task",
				"worktree_sync",
				"memory",
				"python",
				"delegate",
				"tmux_agent_manager",
				"unknown-extension",
			],
		});
		expect(profile.allowedTools).toEqual(
			expect.arrayContaining([
				"read",
				"write",
				"python",
				"bash",
				"run_toolkit_script",
				"skill",
				"create_goal",
				"get_goal",
				"update_goal",
				"pipeline",
				"tool_task",
				"worktree_sync",
				"ask_question",
			]),
		);
		expect(profile.allowedTools).not.toEqual(expect.arrayContaining(["memory", "delegate", "tmux_agent_manager"]));
		expect(DEFAULT_MANAGED_WORKER_TOOLS).toContain("python");
		expect(DEFAULT_MANAGED_WORKER_TOOLS).toContain("pipeline");
		expect(DEFAULT_MANAGED_WORKER_TOOLS).not.toContain("memory");
		expect(profile.writePaths).toEqual([]);
		expect(Object.isFrozen(profile)).toBe(true);
		expect(Object.isFrozen(profile.allowedTools)).toBe(true);
		expect(Object.isFrozen(profile.writePaths)).toBe(true);
	});

	it("rejects an explicit profile when any requested tool cannot survive the worker ceiling", () => {
		expect(() =>
			deriveWorkerLaunchProfile({
				identity: "invalid-tools",
				allowedTools: ["read", "delegate", "unknown-extension"],
			}),
		).toThrow(
			expect.objectContaining({
				code: "worker_profile_tools_rejected",
				rejectedTools: ["delegate", "unknown-extension"],
			}),
		);
	});

	it("rejects an explicit tool that is policy-owned but unavailable on the inherited parent surface", () => {
		expect(() =>
			deriveWorkerLaunchProfile({
				identity: "unavailable-tools",
				inheritedTools: ["read", "bash"],
				allowedTools: ["read", "pipeline"],
			}),
		).toThrow(
			expect.objectContaining({
				code: "worker_profile_tools_rejected",
				rejectedTools: ["pipeline"],
			}),
		);
	});

	it("buildLaunchProfileFlags derives Pi CLI controls without disabling inherited extensions or skills", () => {
		const withProfile = buildLaunchProfileFlags(
			deriveWorkerLaunchProfile({
				identity: "profile p1",
				allowedTools: ["read", "grep"],
				resourceProfile: "backend",
				writePaths: ["/tmp/x"],
				thinkingLevel: "high",
			}),
		);
		expect(withProfile[0]).toEqual({ flag: "--tools", value: "read,grep" });
		expect(withProfile[1]).toEqual({ flag: "--resource-profile", value: "backend" });
		expect(withProfile[2]).toEqual({ flag: "--thinking", value: "high" });
		expect(withProfile[3]?.flag).toBe("--append-system-prompt");
		expect(withProfile[3]?.value).toContain("profile p1");
		expect(withProfile[3]?.value).toContain("/tmp/x");
		expect(withProfile[3]?.value).toContain("BLOCKED");
		expect(withProfile[3]?.value).not.toContain("owner approval");

		const withoutOverrides = buildLaunchProfileFlags(deriveWorkerLaunchProfile({ identity: "inherited" }));
		expect(withoutOverrides[0]).toEqual({ flag: "--tools", value: DEFAULT_MANAGED_WORKER_TOOLS.join(",") });
		expect(withoutOverrides.some((flag) => flag.flag === "--no-extensions")).toBe(false);
		expect(withoutOverrides.some((flag) => flag.flag === "--no-skills")).toBe(false);
	});

	it("buildLaunchProfileFlags appends process identity only when present on the source", () => {
		const withParent = buildLaunchProfileFlags(
			deriveWorkerLaunchProfile({
				identity: "parent-profile",
				parentPid: 4242,
				parentSession: "master-session-1",
				taskRef: "goal-1",
			}),
		);
		expect(withParent).toContainEqual({ flag: "--parent-pid", value: "4242" });
		expect(withParent).toContainEqual({ flag: "--parent-session", value: "master-session-1" });
		expect(withParent).toContainEqual({ flag: "--task-ref", value: "goal-1" });

		const withoutParent = buildLaunchProfileFlags(deriveWorkerLaunchProfile({ identity: "no-parent" }));
		expect(withoutParent.some((flag) => flag.flag === "--parent-pid")).toBe(false);
		expect(withoutParent.some((flag) => flag.flag === "--parent-session")).toBe(false);
		expect(withoutParent.some((flag) => flag.flag === "--task-ref")).toBe(false);
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
// Integration tests — exercise the registered tool end to end against a fake tmux + a fake pi/ctx.
// ---------------------------------------------------------------------------

type RegisteredTool = {
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
	parameters?: unknown;
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
	reasonCode?: string;
	goalId?: string;
	worktreeLaneKey?: string;
	dispatch?: {
		sequence: number;
		instructions: string;
		profileId: string;
		provider: string;
		authorizationId: string;
		authorizationKind: "profile-derived" | "legacy-recovery";
		allowedTools: readonly string[];
		writePaths: readonly string[];
		leaseTtlMs: number;
	};
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

function readFakeTmuxCalls(stateDir: string): string[] {
	try {
		return fs
			.readFileSync(path.join(stateDir, "calls.log"), "utf8")
			.split("\n")
			.filter((line) => line.length > 0);
	} catch {
		return [];
	}
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
		activeTools?: string[];
		effectiveResourceProfile?: Record<string, { allow?: string[]; block?: string[] }>;
		reportManagedLane?: (event: LaneEvent) => void;
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
		getActiveTools() {
			return opts?.activeTools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"];
		},
		...(opts?.effectiveResourceProfile
			? { getEffectiveResourceProfile: () => opts.effectiveResourceProfile ?? {} }
			: {}),
		appendEntry,
		reportManagedLane(event: LaneEvent) {
			laneEvents.push(event);
			opts?.reportManagedLane?.(event);
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

describe("tmux extension routing guidance", () => {
	it("keeps native delegate as the standard cross-platform subagent route", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-guidance-"));
		try {
			const { registeredTool } = installExtension(tempDir);
			const promptGuidelines = registeredTool.promptGuidelines ?? [];
			const guidance = [registeredTool.description, registeredTool.promptSnippet, ...promptGuidelines]
				.filter((value): value is string => value !== undefined)
				.join("\n");
			expect(guidance).toContain("native delegate");
			expect(guidance).toContain("detection is automatic");
			expect(guidance).toContain("immutable profile");
			expect(guidance).toContain("Pi-only");
			expect(guidance).not.toContain("Use tmux_agent_manager for Windows/Linux tmux-managed workers");
			expect(registeredTool.promptSnippet?.length).toBeLessThanOrEqual(120);
			expect(promptGuidelines.every((guideline) => guideline.length <= 140)).toBe(true);
			expect(promptGuidelines.reduce((total, guideline) => total + guideline.length, 0)).toBeLessThanOrEqual(1_200);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("exposes one profile-derived launch contract and no grant or revocation actions", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-profile-schema-"));
		try {
			const { registeredTool } = installExtension(tempDir);
			const contract = JSON.stringify({
				description: registeredTool.description,
				promptSnippet: registeredTool.promptSnippet,
				promptGuidelines: registeredTool.promptGuidelines,
				parameters: registeredTool.parameters,
			});
			expect(contract).not.toContain("grant_dispatch");
			expect(contract).not.toContain("revoke_grant");
			expect(contract).not.toContain("allow-tmux-dispatch");
			expect(contract).not.toContain("one-shot");
			expect(contract).not.toContain("owner approval");
			expect(contract).toContain("thinkingLevel");
			expect(contract).toContain("path");
			expect(contract).not.toContain("writePaths");
			expect(contract).toContain("tools");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe.skipIf(process.platform === "win32")("tmux autonomous profiled dispatch", () => {
	let tempDir: string;
	let stateDir: string;
	let previousAgentDir: string | undefined;
	let previousPath: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-profile-"));
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

	it("launches and follows up autonomously without a UI confirmation handshake", async () => {
		const confirmImpl = async () => {
			throw new Error("autonomous tmux work must never request confirmation");
		};
		const installed = installExtension(tempDir, {
			hasUI: true,
			confirmImpl,
			activeTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "delegate", "tmux_agent_manager"],
		});
		const launched = await installed.registeredTool.execute(
			"autonomous-fire",
			{
				action: "fire_task",
				launchKey: "autonomous-job",
				workspaceName: "autonomous-session",
				task: "implement and verify the assigned change",
				agents: [
					{
						provider: "pi",
						name: "implementer",
						tools: ["read", "bash", "edit", "write"],
						resourceProfile: "backend",
						path: tempDir,
						thinkingLevel: "high",
					},
				],
			},
			new AbortController().signal,
			() => {},
			installed.context,
		);

		expect(installed.confirmCalls).toHaveLength(0);
		const details = launched.details as {
			job: { id: string; agents: Array<{ id: string; command?: string }> };
		};
		expect(details.job.id).toBe("autonomous-job");
		const command = details.job.agents[0]?.command ?? "";
		expect(command).toContain("--tools 'read,write,edit,bash'");
		const toolFlag = command.match(/--tools '([^']*)'/)?.[1]?.split(",") ?? [];
		expect(toolFlag).not.toContain("delegate");
		expect(toolFlag).not.toContain("tmux_agent_manager");
		expect(command).toContain("--resource-profile 'backend'");
		expect(command).not.toContain("--resource-profile-json");
		expect(command).toContain("--thinking 'high'");
		expect(command).toContain("PI_WORKER_ALLOWED_PATHS=");
		expect(command).not.toContain("--no-extensions");
		expect(command).not.toContain("--no-skills");
		expect(command).not.toContain("owner approval");
		expect(installed.laneEvents).toContainEqual(
			expect.objectContaining({
				laneId: `tmux:${details.job.id}:${details.job.agents[0]?.id}`,
				phase: "dispatch",
				dispatch: expect.objectContaining({
					authorizationKind: "profile-derived",
					allowedTools: ["read", "write", "edit", "bash"],
					writePaths: [tempDir],
				}),
			}),
		);

		const followed = await installed.registeredTool.execute(
			"autonomous-followup",
			{ action: "send_followup", jobId: details.job.id, task: "review and finish" },
			new AbortController().signal,
			() => {},
			installed.context,
		);
		expect(followed.content[0]?.text).toContain("Sent follow-up turn 2");
		expect(installed.confirmCalls).toHaveLength(0);
		expect(installed.laneEvents).toContainEqual(
			expect.objectContaining({
				laneId: `tmux:${details.job.id}:${details.job.agents[0]?.id}`,
				phase: "dispatch",
				dispatch: expect.objectContaining({
					sequence: 2,
					authorizationId: `tmux-profile:${details.job.id}:${details.job.agents[0]?.id}`,
					allowedTools: ["read", "write", "edit", "bash"],
					writePaths: [tempDir],
				}),
			}),
		);
	});

	it("rejects an invalid explicit tool profile before durable reservation or process side effects", async () => {
		const jobId = "invalid-explicit-tools";
		const { registeredTool, context, laneEvents } = installExtension(tempDir, { hasUI: false });
		const callsBefore = readFakeTmuxCalls(stateDir).length;

		await expect(
			registeredTool.execute(
				"fire-invalid-tools",
				{
					action: "fire_task",
					launchKey: jobId,
					task: "must not launch",
					agents: [{ provider: "pi", tools: ["read", "delegate", "unknown-extension"] }],
				},
				new AbortController().signal,
				() => {},
				context,
			),
		).rejects.toMatchObject({
			code: "worker_profile_tools_rejected",
			rejectedTools: ["delegate", "unknown-extension"],
		});

		expect(laneEvents).toHaveLength(0);
		const launchCalls = readFakeTmuxCalls(stateDir).slice(callsBefore);
		expect(launchCalls.some((call) => /^(new-session|split-window|send-keys|pipe-pane)\b/.test(call))).toBe(false);
		expect(fs.existsSync(path.join(getTmuxAgentManagerDataRoot(), "jobs", jobId))).toBe(false);
	});

	it("inherits every compatible policy-owned parent tool when no explicit tool profile is supplied", async () => {
		const installed = installExtension(tempDir, {
			hasUI: false,
			activeTools: [
				"read",
				"bash",
				"pipeline",
				"create_goal",
				"get_goal",
				"update_goal",
				"ask_question",
				"skill",
				"run_toolkit_script",
				"tool_task",
				"worktree_sync",
				"memory",
				"delegate",
				"tmux_agent_manager",
				"unknown-extension",
			],
		});
		const launched = await installed.registeredTool.execute(
			"fire-inherited-tools",
			{
				action: "fire_task",
				launchKey: "inherited-tools",
				task: "use the inherited worker surface",
				agents: [{ provider: "pi" }],
			},
			new AbortController().signal,
			() => {},
			installed.context,
		);

		const details = launched.details as { job: { agents: Array<{ command?: string }> } };
		const command = details.job.agents[0]?.command ?? "";
		const toolFlag = command.match(/--tools '([^']*)'/)?.[1]?.split(",") ?? [];
		expect(toolFlag).toEqual(
			expect.arrayContaining([
				"read",
				"bash",
				"pipeline",
				"create_goal",
				"get_goal",
				"update_goal",
				"ask_question",
				"skill",
				"run_toolkit_script",
				"tool_task",
				"worktree_sync",
			]),
		);
		expect(toolFlag).not.toEqual(
			expect.arrayContaining(["memory", "delegate", "tmux_agent_manager", "unknown-extension"]),
		);
	});

	it("arms capture before atomically starting an Agy worker with its initial task", async () => {
		const installed = installExtension(tempDir, { hasUI: false });
		await installed.registeredTool.execute(
			"fire-agy-ready",
			{
				action: "fire_task",
				launchKey: "agy-ready",
				task: "write the requested implementation and verify it",
				agents: [{ provider: "agy", command: "agy --dangerously-skip-permissions" }],
			},
			new AbortController().signal,
			() => {},
			installed.context,
		);

		const calls = readFakeTmuxCalls(stateDir);
		const captureIndex = calls.findIndex((call) => call.startsWith("pipe-pane -O"));
		const literalInputCalls = calls.filter((call) => call.startsWith("send-keys") && call.includes(" -l "));
		expect(captureIndex).toBeGreaterThanOrEqual(0);
		expect(literalInputCalls).toHaveLength(1);
		expect(calls.indexOf(literalInputCalls[0] as string)).toBeGreaterThan(captureIndex);
		expect(literalInputCalls[0]).toContain("agy --dangerously-skip-permissions --prompt-interactive");
		expect(literalInputCalls[0]).toContain("$(cat '");
	});

	it("audits an unrestricted external CLI as a host-trusted process instead of a Pi tool profile", async () => {
		const installed = installExtension(tempDir, {
			hasUI: false,
			activeTools: ["read", "grep", "find", "ls"],
		});
		await installed.registeredTool.execute(
			"fire-external-host-trust",
			{
				action: "fire_task",
				launchKey: "external-host-trust",
				task: "perform the requested edits",
				agents: [{ provider: "agy", command: "agy --dangerously-skip-permissions", path: tempDir }],
			},
			new AbortController().signal,
			() => {},
			installed.context,
		);

		expect(installed.laneEvents).toContainEqual(
			expect.objectContaining({
				laneId: "tmux:external-host-trust:agy-1",
				phase: "dispatch",
				dispatch: expect.objectContaining({
					provider: "agy",
					allowedTools: ["bash"],
					writePaths: [],
				}),
			}),
		);
	});

	it("inherits the parent's effective resource profile when no agent override is supplied", async () => {
		const installed = installExtension(tempDir, {
			hasUI: false,
			effectiveResourceProfile: {
				extensions: { allow: ["parent-extension"], block: ["blocked-extension"] },
				skills: { allow: ["parent-skill"] },
				tools: { allow: ["read", "bash"] },
			},
		});
		const launched = await installed.registeredTool.execute(
			"inherited-resource-profile",
			{
				action: "fire_task",
				launchKey: "inherited-resource-profile",
				workspaceName: "inherited-resource-session",
				task: "inherit the parent resource surface",
				agents: [{ provider: "pi", name: "inheritor" }],
			},
			new AbortController().signal,
			() => {},
			installed.context,
		);
		const command = (launched.details as { job: { agents: Array<{ command?: string }> } }).job.agents[0]?.command;
		expect(command).toContain("--resource-profile-json '");
		expect(command).toContain('"parent-extension"');
		expect(command).toContain('"blocked-extension"');
		expect(command).toContain('"parent-skill"');
		expect(command).toMatch(/--resource-profile 'tmux-inherited-[a-f0-9]{12}'/);
	});

	it("ignores an auto-retained stale jobId across concurrent fresh fire_task plans", async () => {
		const installed = installExtension(tempDir, { hasUI: false });
		const launch = async (workspaceName: string) =>
			installed.registeredTool.execute(
				`fire-${workspaceName}`,
				{
					action: "fire_task",
					jobId: "stale-autofilled-job",
					workspaceName,
					task: `inspect ${workspaceName}`,
					agents: [{ provider: "agy", name: workspaceName, command: "agy" }],
					dryRun: true,
				},
				new AbortController().signal,
				() => {},
				installed.context,
			);

		const launches = await Promise.all(
			["fresh-session-one", "fresh-session-two", "fresh-session-three", "fresh-session-four"].map(launch),
		);
		const jobIds = launches.map((result) => (result.details as { job: { id: string } }).job.id);
		expect(jobIds).not.toContain("stale-autofilled-job");
		expect(new Set(jobIds).size).toBe(jobIds.length);
	});

	it.each([
		{ override: { tools: ["read"] }, field: "tools" },
		{ override: { resourceProfile: "backend" }, field: "resourceProfile" },
		{ override: { thinkingLevel: "high" }, field: "thinkingLevel" },
		{ override: { worktreeLane: "lane-1" }, field: "worktreeLane" },
	])("rejects non-Pi $field overrides instead of claiming the external CLI enforces them", async ({ override }) => {
		const { registeredTool, context } = installExtension(tempDir, { hasUI: false });
		await expect(
			registeredTool.execute(
				"non-pi-override",
				{
					action: "fire_task",
					launchKey: "non-pi-override",
					task: "inspect",
					agents: [{ provider: "claude", ...override }],
					dryRun: true,
				},
				new AbortController().signal,
				() => {},
				context,
			),
		).rejects.toThrow(/Pi-only/);
	});

	it("reserves the durable managed lane before creating a process or job artifact", async () => {
		const jobId = "reservation-failure-job";
		const { registeredTool, context, laneEvents } = installExtension(tempDir, {
			hasUI: false,
			reportManagedLane(event) {
				if (event.phase === "dispatch") throw new Error("host reservation unavailable");
			},
		});
		const callsBefore = readFakeTmuxCalls(stateDir).length;

		await expect(
			registeredTool.execute(
				"fire-reservation-failure",
				{
					action: "fire_task",
					task: "must not launch",
					launchKey: jobId,
					agents: [{ provider: "pi" }],
					dryRun: false,
				},
				new AbortController().signal,
				() => {},
				context,
			),
		).rejects.toThrow("host reservation unavailable");

		const launchCalls = readFakeTmuxCalls(stateDir).slice(callsBefore);
		expect(launchCalls.some((call) => /^(new-session|split-window|send-keys|pipe-pane)\b/.test(call))).toBe(false);
		expect(fs.existsSync(path.join(getTmuxAgentManagerDataRoot(), "jobs", jobId))).toBe(false);
		expect(laneEvents).toMatchObject([
			{ phase: "dispatch", laneId: `tmux:${jobId}:pi-1` },
			{
				phase: "terminal",
				laneId: `tmux:${jobId}:pi-1`,
				reasonCode: "managed_process_launch_reservation_failed",
			},
		]);
	});

	it("a lane-first dispatch (agent carrying worktreeLane) appends --worktree-lane plus a lane-doctrine system-prompt clause, and reports the lane key on the managed-lane dispatch event", async () => {
		const { registeredTool, context, laneEvents } = installExtension(tempDir, { hasUI: false });

		const launched = await registeredTool.execute(
			"fire-lane",
			{
				action: "fire_task",
				task: "work the lane",
				launchKey: "lane-job-1",
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
			expect.objectContaining({
				phase: "dispatch",
				worktreeLaneKey: "adhoc-1",
				dispatch: expect.objectContaining({
					authorizationId: "tmux-profile:lane-job-1:pi-1",
					authorizationKind: "profile-derived",
					sequence: 1,
					writePaths: [tempDir],
				}),
			}),
		);
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
