import { afterEach, describe, expect, it } from "vitest";
import {
	buildLaunchProfileFlags,
	DEFAULT_MANAGED_WORKER_TOOLS,
	decodeCollaborationUsageClaim,
	deriveWorkerLaunchProfile,
} from "../src/core/collaboration/launch-profile.ts";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("profile-derived persistent native dispatch", () => {
	it("launches and follows up autonomously with the same immutable profile and native session", async () => {
		const f = await collaborationFixture();
		cleanups.push(f.cleanup);
		await f.execute({
			action: "fire_task",
			launchKey: "autonomous",
			task: "implement",
			agents: [
				{
					provider: "pi",
					tools: ["read", "bash", "edit", "write"],
					resourceProfile: "backend",
					path: f.root,
					thinkingLevel: "high",
					worktreeLane: "lane-one",
				},
			],
		});
		const job = f.store.load("autonomous");
		const agent = job.agents[0];
		expect(agent.args).toEqual(
			expect.arrayContaining([
				"--tools",
				"read,write,edit,bash",
				"--thinking",
				"high",
				"--resource-profile",
				"backend",
				"--worktree-lane",
				"lane-one",
				"--session-mode",
				"worker",
			]),
		);
		expect(agent.args).not.toEqual(expect.arrayContaining(["--no-extensions", "--no-skills"]));
		expect(agent.env.PI_WORKER_ALLOWED_PATHS).toBe(JSON.stringify([f.root]));
		expect(f.report).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "dispatch",
				worktreeLaneKey: "lane-one",
				dispatch: expect.objectContaining({
					sequence: 1,
					authorizationKind: "profile-derived",
					writePaths: [f.root],
				}),
			}),
		);
		f.store.finishTurn(job.id, agent.id, agent.turnId, "done", "verified");
		await f.execute({ action: "send_followup", jobId: job.id, task: "review" });
		expect(f.store.load(job.id).agents[0]).toMatchObject({
			turn: 2,
			profile: agent.profile,
			backendName: agent.backendName,
			terminalId: agent.terminalId,
		});
		expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
		expect(f.launchTurn).toHaveBeenCalledTimes(2);
		expect(f.confirm).not.toHaveBeenCalled();
	});
	it("validates explicit tools before reservation and inherits only compatible parent tools", async () => {
		const f = await collaborationFixture();
		cleanups.push(f.cleanup);
		await expect(
			f.execute({
				action: "fire_task",
				launchKey: "invalid",
				task: "no",
				agents: [{ provider: "pi", tools: ["read", "delegate", "unknown-extension"] }],
			}),
		).rejects.toMatchObject({ code: "worker_profile_tools_rejected" });
		expect(f.store.list()).toEqual([]);
		expect(f.backend.createWorkspace).not.toHaveBeenCalled();
		expect(f.report).not.toHaveBeenCalled();
		await f.execute({ action: "fire_task", launchKey: "inherited", task: "work", agents: [{ provider: "pi" }] });
		const tools = f.store.load("inherited").agents[0].profile.allowedTools;
		expect(tools).toEqual(
			expect.arrayContaining(["pipeline", "ask_question", "skill", "tool_task", "worktree_sync"]),
		);
		for (const denied of ["delegate", "pi_collaboration", "memory", "unknown-extension"])
			expect(tools).not.toContain(denied);
	});
	it("inherits an effective resource snapshot unless an explicit profile replaces it", async () => {
		const f = await collaborationFixture();
		cleanups.push(f.cleanup);
		f.api.getEffectiveResourceProfile = () => ({
			extensions: { allow: ["parent-extension"], block: ["blocked-extension"] },
			skills: { allow: ["parent-skill"] },
		});
		await f.execute({
			action: "fire_task",
			launchKey: "resources",
			task: "work",
			agents: [
				{ provider: "pi", task: "Implement the task" },
				{ provider: "pi", resourceProfile: "explicit", task: "Review the implementation" },
			],
		});
		const [inherited, explicit] = f.store.load("resources").agents;
		expect(inherited.profile.resourceProfileJson).toContain("parent-extension");
		expect(inherited.profile.resourceProfileJson).toContain("blocked-extension");
		expect(inherited.profile.resourceProfileJson).toContain("parent-skill");
		expect(explicit.profile.resourceProfile).toBe("explicit");
		expect(explicit.profile.resourceProfileJson).toBeUndefined();
	});
	it.each([{ tools: ["read"] }, { resourceProfile: "backend" }, { thinkingLevel: "high" }, { worktreeLane: "lane" }])(
		"rejects Pi-only controls on an external CLI: %j",
		async (override) => {
			const f = await collaborationFixture();
			cleanups.push(f.cleanup);
			await expect(
				f.execute({ action: "workspace_plan", agents: [{ provider: "claude", ...override }] }),
			).rejects.toThrow(/Pi-only/);
			expect(f.store.list()).toEqual([]);
			expect(f.run).not.toHaveBeenCalled();
		},
	);
	it("audits external CLI host access without pretending Pi tool confinement applies", async () => {
		const f = await collaborationFixture();
		cleanups.push(f.cleanup);
		await f.execute({
			action: "fire_task",
			launchKey: "external",
			task: "work",
			agents: [{ provider: "agy", command: "agy", path: f.root }],
		});
		expect(f.report).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "dispatch",
				dispatch: expect.objectContaining({ provider: "agy", allowedTools: ["bash"], writePaths: [] }),
			}),
		);
		expect(f.backend.startAgent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "agy", args: ["--dangerously-skip-permissions"] }),
		);
	});
	it("ignores stale jobId on fresh plans and prevents native launch after host reservation refusal", async () => {
		const f = await collaborationFixture();
		cleanups.push(f.cleanup);
		const results = await Promise.all(
			[1, 2, 3, 4].map(() =>
				f.execute({
					action: "fire_task",
					dryRun: true,
					jobId: "stale",
					task: "work",
					agents: [{ provider: "pi" }],
				}),
			),
		);
		const ids = results.map((result) => (result.details as { job: { id: string } }).job.id);
		expect(new Set(ids).size).toBe(4);
		expect(ids).not.toContain("stale");
		f.report.mockImplementation((event) => {
			if (event.phase === "dispatch") throw new Error("reservation unavailable");
		});
		await expect(
			f.execute({ action: "fire_task", launchKey: "refused", task: "no", agents: [{ provider: "pi" }] }),
		).rejects.toThrow("reservation unavailable");
		expect(f.backend.createWorkspace).not.toHaveBeenCalled();
		expect(f.launchTurn).not.toHaveBeenCalled();
	});
});

describe("collaboration launch-profile pure logic", () => {
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
				"pi_collaboration",
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
		expect(profile.allowedTools).not.toEqual(expect.arrayContaining(["memory", "delegate", "pi_collaboration"]));
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

	it("decodeCollaborationUsageClaim permissively decodes a partial claim and rejects non-objects", () => {
		expect(decodeCollaborationUsageClaim(null)).toBeUndefined();
		expect(decodeCollaborationUsageClaim("nope")).toBeUndefined();
		expect(decodeCollaborationUsageClaim({ input: 10, output: 5, cost: { total: 0.02 } })).toEqual({
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
		});
	});
});
