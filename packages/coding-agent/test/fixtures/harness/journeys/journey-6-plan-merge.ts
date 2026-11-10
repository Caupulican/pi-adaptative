import "../builtin-install.ts";
import { basename, join } from "node:path";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { createBarrier, type ScriptStep } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { TIMEOUTS_PATH } from "./journey-5-plan-verify-rejected.ts";
import {
	CHANGED_FILE_ANSWER_CLAIMS,
	deliveredLines,
	enqueueRoot,
	enqueueStepWorker,
	INTAKE_JUDGMENTS,
	latestAttemptOf,
	PLAN_CALL_JUDGMENTS,
	planCallSteps,
	planTitled,
	reportStep,
	stepTaskLines,
} from "./journey-5-shared.ts";
import { currentRequestCarries, dynamicCalls, LIMITS_PATH, latestBatchResults } from "./shared.ts";

const TITLE = "Raise the retry limit and the request timeout, each in its own lane, and land both";
const GATE = "npm run check";
const MERGE = "land-raises";

/** One member of the merge: the step, the file it changes in its lane, and the commit it makes there. */
interface Member {
	readonly id: string;
	readonly file: string;
	readonly oldText: string;
	readonly newText: string;
	readonly task: string;
	readonly message: string;
}

const MEMBERS: readonly [Member, Member] = [
	{
		id: "raise-limit",
		file: "src/limits.ts",
		oldText: "MAX_RETRIES = 3",
		newText: "MAX_RETRIES = 5",
		task: "In src/limits.ts set MAX_RETRIES to 5.",
		message: "Raise the retry limit to 5",
	},
	{
		id: "raise-wait",
		file: "src/timeouts.ts",
		oldText: "TIMEOUT_MS = 1000",
		newText: "TIMEOUT_MS = 2000",
		task: "In src/timeouts.ts set TIMEOUT_MS to 2000.",
		message: "Raise the request timeout to 2000",
	},
];

/**
 * Merge, both land. Two steps change different files, each in its own worktree lane, and a merge join over them lands the
 * lanes on main in the plan's order.
 */
export async function runJourney6PlanMergePhase(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	const started = createBarrier();
	const done = createBarrier();
	const updateCodes: string[] = [];
	const offered = new Map<string, string[]>();
	const tasks = new Map<string, string[]>();
	const seenByCheck = new Map<string, string>();
	const laneOf = (nodeId: string): string => {
		const taskId = planTitled(session, TITLE).nodes[nodeId]?.release?.taskId;
		const cwd = latestAttemptOf(session, taskId)?.dispatch.executionContract?.worker.authority.cwd;
		if (cwd === undefined) throw new Error(`step ${nodeId} has no directory of its own yet`);
		return cwd;
	};
	const memberSteps = (member: Member): ScriptStep[] => {
		const command = `git add ${member.file} && git commit -m "${member.message}"`;
		world.shell.enqueue({
			name: `j6-${member.id}-git`,
			command,
			output: "",
			exitCode: 0,
			// The worker's own git commands, applied to the repository where it ran them.
			effect: (request) => {
				world.git.run(["add", member.file], request.cwd);
				world.git.run(["commit", "-m", member.message], request.cwd);
			},
		});
		return [
			{
				name: `j6-${member.id}-edit`,
				check: (request) => {
					offered.set(
						member.id,
						(request.context.tools ?? []).map((tool) => tool.name),
					);
					tasks.set(member.id, stepTaskLines(request));
				},
				reply: () => ({
					content: [
						{
							type: "toolCall",
							id: `j6-${member.id}-edit-1`,
							name: "edit",
							arguments: {
								path: join(laneOf(member.id), member.file),
								edits: [{ oldText: member.oldText, newText: member.newText }],
							},
						},
					],
					stopReason: "toolUse",
				}),
			},
			{
				name: `j6-${member.id}-commit`,
				check: (request) => {
					const edit = latestBatchResults(request).find((result) => result.toolName === "edit");
					if (edit?.isError) throw new Error(`the step's edit was refused: ${edit.text}`);
				},
				reply: {
					content: [{ type: "toolCall", id: `j6-${member.id}-commit-1`, name: "bash", arguments: { command } }],
					stopReason: "toolUse",
				},
			},
			{
				...reportStep(`j6-${member.id}-report`, {
					status: "completed",
					summary: `${member.message}.`,
					changes: [{ file: member.file, what: `${member.message}.` }],
				}),
				check: (request) => {
					const commit = latestBatchResults(request).find((result) => result.toolName === "bash");
					if (commit?.isError) throw new Error(`the step's commit was refused: ${commit.text}`);
				},
			},
		];
	};
	for (const member of MEMBERS) enqueueStepWorker(world, member.id, ...memberSteps(member));
	// Each member's result is unverified, so the plan checks it before the merge. The check reads the changed file by the name
	// the member reported, as a real review would: it must find the member's work, which is in the member's lane and not yet
	// in the shared checkout.
	for (const member of MEMBERS) {
		enqueueStepWorker(
			world,
			`${member.id}-check`,
			{
				name: `j6-${member.id}-check-read`,
				reply: {
					content: [
						{
							type: "toolCall",
							id: `j6-${member.id}-check-read-1`,
							name: "read",
							arguments: { path: member.file },
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				...reportStep(`j6-${member.id}-verdict`, {
					status: "completed",
					summary: `${member.message}: the file holds the change.`,
					verdict: "accepted",
					reasonCodes: ["change_is_in_the_file"],
				}),
				check: (request) => {
					const read = latestBatchResults(request).find((result) => result.toolName === "read");
					seenByCheck.set(member.id, read?.text ?? "");
				},
			},
		);
	}
	world.shell.enqueue(
		{ name: "j6-gate-first", command: GATE, output: "check passed", exitCode: 0 },
		{ name: "j6-gate-second", command: GATE, output: "check passed", exitCode: 0 },
	);
	enqueueRoot(
		world,
		...planCallSteps(
			"j6-merge",
			{
				action: "start",
				title: TITLE,
				final: MERGE,
				steps: [
					...MEMBERS.map((member) => ({ id: member.id, do: member.task, files: [member.file], proof: "diff" })),
					{ id: MERGE, do: "Land both changes on main.", join: "merge", uses: MEMBERS.map((member) => member.id) },
				],
			},
			"PLAN_STARTED",
			() => started.release(),
		),
		{
			name: "j6-merge-wake",
			maxRequests: 8,
			// The root is woken by each member's check and by the plan's result; this step answers every wake and ends with the last.
			until: (request) => {
				updateCodes.push(...deliveredLines(request).filter((line) => line.includes("h PLAN_UPDATE,")));
				if (!currentRequestCarries(request, "PLAN_UPDATE,PLAN_DONE")) return false;
				done.release();
				return true;
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
	);
	world.settingsManager.applyOverrides({ worktreeSync: { gate: "on", gateCommand: GATE } });
	const mainBefore = world.git.refSha("refs/heads/main");
	world.systemOne.enterPhase("j6-merge", {
		...PLAN_CALL_JUDGMENTS,
		...CHANGED_FILE_ANSWER_CLAIMS,
		needs_output_of: { kind: "noul", probability: 0.02 },
		pair_evidence_sufficient: { kind: "noul", probability: 0.97 },
	});
	await withDeadline(
		trace,
		"J6 merge turn",
		session.prompt(
			"Raise the retry limit to 5 and the request timeout to 2000, each in its own lane, and land both.",
		),
	);
	await withDeadline(trace, "J6 merge: the plan started", started.promise);
	await withDeadline(trace, "J6 merge: the plan's result woke the root", done.promise, 60_000);
	await withDeadline(trace, "J6 merge: root idle", session.waitForForegroundIdle());
	const plan = planTitled(session, TITLE);
	const lanes = MEMBERS.map((member) => laneOf(member.id));
	const branchTip = (lane: string) => world.git.refSha(`refs/heads/pi/wt/${basename(lane)}`);
	expect(
		{
			laneEach: lanes.map((lane) => lane !== HARNESS_PROJECT_CWD),
			ownLaneEach: lanes[0] !== lanes[1],
			offeredWorktreeTool: MEMBERS.map((member) => offered.get(member.id)?.includes("worktree_sync")),
			offeredShell: MEMBERS.map((member) => offered.get(member.id)?.includes("bash")),
			commitWords: MEMBERS.map(
				(member) =>
					(tasks.get(member.id) ?? []).filter((line) => line.startsWith("Your work is in your own worktree lane"))
						.length,
			),
			namesTheMissingTool: MEMBERS.map((member) =>
				(tasks.get(member.id) ?? []).some((line) => line.includes("worktree_sync")),
			),
		},
		"each member's worker works in its own lane, is told to commit there with git, and is neither given nor told of a tool it does not have",
	).toEqual({
		laneEach: [true, true],
		ownLaneEach: true,
		offeredWorktreeTool: [false, false],
		offeredShell: [true, true],
		commitWords: [1, 1],
		namesTheMissingTool: [false, false],
	});
	expect(
		{
			checkRanIn: MEMBERS.map((member) => laneOf(`${member.id}-check`)),
			checkSaw: MEMBERS.map((member) => (seenByCheck.get(member.id) ?? "").includes(member.newText)),
			checkSawTheOldFile: MEMBERS.map((member) => (seenByCheck.get(member.id) ?? "").includes(member.oldText)),
		},
		"each member's check ran in that member's lane and read the changed file there, not the unchanged one in the shared checkout",
	).toEqual({
		checkRanIn: lanes,
		checkSaw: [true, true],
		checkSawTheOldFile: [false, false],
	});
	const merge = plan.nodes[MERGE]?.join;
	// An outcome written by a newer build is opaque; this build wrote this one.
	const merged = merge && "status" in merge.outcome ? merge.outcome : undefined;
	const checks = MEMBERS.map((member) => plan.nodes[`${member.id}-check`]?.join);
	expect(
		{
			checks: checks.map((check) => (check && "status" in check.outcome ? check.outcome.status : undefined)),
			merge: merged && { status: merged.status, scope: merged.scope, blocker: merged.blocker },
			mergeRanNoWorker: plan.nodes[MERGE]?.release === undefined,
			closed: plan.closed?.status,
			gateRanIn: world.shell.requests.filter((request) => request.command === GATE).map((request) => request.cwd),
			mainMoved: world.git.refSha("refs/heads/main") !== mainBefore,
			mainIsTheLastLane: world.git.refSha("refs/heads/main") === branchTip(lanes[1]),
			firstLaneIsInMain:
				world.git.run(["merge-base", "--is-ancestor", branchTip(lanes[0]) ?? "", "main"], HARNESS_PROJECT_CWD)
					.code === 0,
			checkout: [world.io.readFileSync(LIMITS_PATH, "utf8"), world.io.readFileSync(TIMEOUTS_PATH, "utf8")],
			checkoutClean: world.git.run(["status", "--porcelain"], HARNESS_PROJECT_CWD).stdout,
		},
		"both checks accepted, the merge landed both lanes on main in the plan's order through the land check, and the checkout holds both changes",
	).toEqual({
		checks: ["succeeded", "succeeded"],
		merge: { status: "succeeded", scope: "join", blocker: "none" },
		mergeRanNoWorker: true,
		closed: "settled",
		gateRanIn: lanes,
		mainMoved: true,
		mainIsTheLastLane: true,
		firstLaneIsInMain: true,
		checkout: ["export const MAX_RETRIES = 5;\n", "export const TIMEOUT_MS = 2000;\n"],
		checkoutClean: "",
	});
	const result = JSON.parse(String(world.io.readFileSync(merge!.artifact, "utf8"))) as {
		kind: string;
		members: { nodeId: string; status: string }[];
		gaps: string[];
		conflicts: unknown[];
	};
	expect(
		{
			kind: result.kind,
			members: result.members.map((member) => [member.nodeId, member.status]),
			gaps: result.gaps,
			conflicts: result.conflicts,
		},
		"the merge's result names both members as succeeded, with no gap and no conflict",
	).toEqual({
		kind: "merge",
		members: MEMBERS.map((member) => [member.id, "succeeded"]),
		gaps: [],
		conflicts: [],
	});
	expect(
		updateCodes.slice().sort(),
		"the root was told of each member's accepted check and of the plan's result, once each",
	).toEqual([
		"h PLAN_UPDATE,JOIN_DONE,READ_REPORT",
		"h PLAN_UPDATE,JOIN_DONE,READ_REPORT",
		"h PLAN_UPDATE,PLAN_DONE,READ_REPORT",
	]);
	trace.mark("root", "j6.plan-merge");
}

/**
 * A lane's end. Each member's check ran in that member's lane without owning it, so retiring a check releases nothing;
 * retiring a member's worker releases its lane, which holds nothing main lacks once it has landed. The first member's worker
 * stays, so its lane is the control: both of its visitors are gone and it is still there. A release is finished when the
 * session closes, which is where the lanes are read.
 */
export async function runJourney6LaneEndPhase(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	const plan = planTitled(session, TITLE);
	const attemptOf = (nodeId: string) => latestAttemptOf(session, plan.nodes[nodeId]?.release?.taskId);
	const agentOf = (nodeId: string): string => {
		const agentId = attemptOf(nodeId)?.agentId;
		if (agentId === undefined) throw new Error(`step ${nodeId} has no worker to retire`);
		return agentId;
	};
	const [kept, released] = MEMBERS.map((member) => {
		const lane = attemptOf(member.id)?.dispatch.executionContract?.worker.authority.cwd;
		if (lane === undefined) throw new Error(`step ${member.id} has no lane`);
		return { member, lane, branch: `refs/heads/pi/wt/${basename(lane)}` };
	});
	const retiring = [`${kept.member.id}-check`, `${released.member.id}-check`, released.member.id];
	const lanesNow = () => ({
		folders: [world.io.existsSync(kept.lane), world.io.existsSync(released.lane)],
		branches: [world.git.refSha(kept.branch) !== undefined, world.git.refSha(released.branch) !== undefined],
	});
	expect(lanesNow(), "both lanes are still there after the merge landed them").toEqual({
		folders: [true, true],
		branches: [true, true],
	});
	const warningsBefore = world.warnings.length;
	const mainBefore = world.git.refSha("refs/heads/main");
	enqueueRoot(
		world,
		dynamicCalls("j6-retire", () =>
			retiring.map((nodeId, index) => ({
				id: `j6-retire-${index + 1}`,
				name: "delegate",
				arguments: { action: "retire", agentId: agentOf(nodeId) },
			})),
		),
		{
			name: "j6-retired",
			check: (request) => {
				const retirements = latestBatchResults(request).filter((result) => result.toolName === "delegate");
				if (
					retirements.length !== retiring.length ||
					retirements.some((result) => result.isError || !result.text.includes("retired"))
				)
					throw new Error(`the plan's workers were not all retired: ${JSON.stringify(retirements)}`);
			},
			reply: { content: [{ type: "text", text: "The three workers are retired." }] },
		},
	);
	world.systemOne.enterPhase("j6-lane-end", INTAKE_JUDGMENTS);
	await withDeadline(
		trace,
		"J6 lane end turn",
		session.prompt("Retire both checks and the worker of the second step; keep the first step's worker."),
	);
	expect(await world.disposeSessionInBody(session), "the root disposes cleanly").toBeUndefined();
	expect(
		{
			...lanesNow(),
			warnings: world.warnings.slice(warningsBefore),
			mainMoved: world.git.refSha("refs/heads/main") !== mainBefore,
			checkout: [world.io.readFileSync(LIMITS_PATH, "utf8"), world.io.readFileSync(TIMEOUTS_PATH, "utf8")],
		},
		"retiring the checks released no lane and warned nothing; retiring the second step's worker released its landed lane, and main kept both changes",
	).toEqual({
		folders: [true, false],
		branches: [true, false],
		warnings: [],
		mainMoved: false,
		checkout: ["export const MAX_RETRIES = 5;\n", "export const TIMEOUT_MS = 2000;\n"],
	});
	trace.mark("root", "j6.lane-end");
}
