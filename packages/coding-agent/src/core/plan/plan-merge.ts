/**
 * The merge join (S7): lands each member's worktree lane onto main in record order, through the land gate. A lane that
 * cannot land gets one merge worker in its own lane (a host revision: a work step that merges that lane's branch into its
 * lane, keeping the other step's intent, ordered before the merge); a second failure for the same member holds the join with
 * plain words. A refusal the owner must fix holds at once, with the fix in words. Every exit is a landed join, a bounded
 * retry or a hold. The module owns the selection of the lanes, the landing order and the per-join landing state; the executor
 * applies each step's result to the plan.
 */

import { harnessLog } from "../../kernel/harness-log.ts";
import { SYSTEM_TIMER_PORT, type TimerPort } from "../../kernel/timer-port.ts";
import {
	MAX_TASK_GOAL_CHARS,
	MAX_TASK_NOTE_CHARS,
	MAX_TASK_REF_CHARS,
	MAX_TASK_REFS,
	taskBriefVersionFor,
} from "../comms/comms-records.ts";
import { WorkerLaneIsolation, type WorkerLaneIsolationDeps } from "../delegation/worker-lane-isolation.ts";
import type { Outcome } from "../delegation/worker-outcome-contract.ts";
import { boundedLine } from "../util/bounded-line.ts";
import { laneBranch } from "../worktree-sync/git-engine.ts";
import type { LandingItem, LaneLanding } from "../worktree-sync/lane-landing.ts";
import {
	landStepOf,
	mergeLandNodeId,
	PLAN_LIMITS,
	type PlanNodeSpec,
	type PlanRecord,
	type PlanRuntimeState,
	planNodeIsLandStepOf,
} from "./plan-graph.ts";
import { type PlanProjection, planNodeOutcome } from "./plan-view.ts";

/** The wait before a landing that a lock held elsewhere refused is tried again, and how many such retries a join gets. */
export const MERGE_RETRY_MS = 30_000;
export const MERGE_RETRY_LIMIT = 30;

/** The skip-reason prefix of a start that no worktree lane could carry (`worker-delegation-controller.ts`). */
export const WORKTREE_UNAVAILABLE = "worktree_unavailable";

/** Files a hold's words name before counting the rest. */
const MERGE_FILES_SHOWN = 6;
/** The detail of a refused land, as a hold's words quote it. */
const MERGE_DETAIL_CHARS = 120;
const MERGE_REPLAN_PAIR = "Re-plan: order them with after, or merge them into one step.";
const MERGE_REPLAN_SINGLE = "Re-plan: change that step or its files, then retry.";

/**
 * Refusals a worker cannot change, with the fix in words for the owner. A land refused with one of these codes holds the join
 * at once; no merge worker is spent on it.
 */
const OWNER_HOLD_REASONS: ReadonlyMap<string, string> = new Map([
	[
		"gate_command_unset",
		'no land check command is set (worktreeSync.gateCommand); set it, or set worktreeSync.gate to "off" to land without one',
	],
	["lane_owner_conflict", "its lane is owned by another live session, which must land it or end it"],
	["hub_missing", "main is not checked out in any worktree; check main out in one worktree"],
	["default_branch_unresolved", "the main branch could not be read (worktreeSync.mainBranch)"],
	["worktree_missing", "its worktree folder is gone"],
	["lane_not_found", "its lane is no longer registered"],
	["not_a_git_repo", "the workspace is not a git repository"],
]);

/** What a landing could not pass: the lane's worklist item, a refusal the engine reports without one, or a sync conflict. */
export type MergeBlock =
	| LandingItem
	| { readonly kind: "refused"; readonly code: string; readonly detail: string }
	| { readonly kind: "sync_conflict"; readonly paths: readonly string[] }
	| { readonly kind: "not_carried" };

/** One lane to land, in record order. `nodeId` is the step whose lane it is: the member, or its land step. */
export interface MergeLane {
	readonly nodeId: string;
	readonly member: string;
	/** The lane the member's attempt ran in, or its land step's lane; undefined when none was recorded. */
	readonly laneCwd: string | undefined;
	/** The member's own lane when `laneCwd` is its land step's lane: the work that lane must carry before it lands. */
	readonly ownLaneCwd?: string;
	/** The member's own changed files: what a conflict between two members is judged by. */
	readonly changedFiles: readonly string[];
}

export type MergeStep =
	| { readonly kind: "landed"; readonly files: readonly string[] }
	| { readonly kind: "retry"; readonly afterMs: number }
	| {
			readonly kind: "merge_worker";
			readonly member: string;
			/** The earlier landed member the failed one overlaps, when there is one. */
			readonly other: string | undefined;
			readonly laneKey: string;
			readonly files: readonly string[];
			readonly item: MergeBlock;
	  }
	| { readonly kind: "hold"; readonly detail: string };

/** One lane's landing attempt: landed, a retry, a block a merge worker may fix, or a hold with its words. */
type LaneTry =
	| { readonly kind: "landed" }
	| { readonly kind: "retry"; readonly holder?: string }
	| { readonly kind: "block"; readonly laneKey: string; readonly item: MergeBlock }
	| { readonly kind: "hold"; readonly detail: string };

/** Whether a step needs its own worktree lane: a merge member, or the land step of one (`plan-dispatch.ts`). */
export function needsOwnWorktree(record: PlanRecord, nodeId: string): boolean {
	const node = record.nodes.find((entry) => entry.id === nodeId);
	return record.nodes.some(
		(merge) =>
			merge.kind === "merge" &&
			(merge.join?.members ?? []).some(
				(member) => member === nodeId || (node !== undefined && planNodeIsLandStepOf(merge, member, node)),
			),
	);
}

/**
 * The refusals of steps whose id a merge reserves for its own land step. A land step the host made in an earlier version is
 * its own; any other step with that id is refused, whether this call states it or it was already in the plan. `stated` holds
 * the ids this call states; `current` is the record being revised, absent for a start.
 */
export function reservedLandIdProblems(
	proposed: readonly PlanNodeSpec[],
	current: PlanRecord | undefined,
	stated: ReadonlySet<string>,
): string[] {
	const problems: string[] = [];
	for (const merge of proposed) {
		if (merge.kind !== "merge") continue;
		for (const member of merge.join?.members ?? []) {
			const id = mergeLandNodeId(merge.id, member);
			if (!proposed.some((node) => node.id === id)) continue;
			const hosted = current !== undefined && landStepOf(current, merge.id, member)?.id === id;
			if (hosted && !stated.has(id)) continue;
			problems.push(
				`step "${id}" is reserved: a merge step makes its own land step with that id; give this step another id`,
			);
		}
	}
	return [...new Set(problems)];
}

function listed(files: readonly string[]): string {
	const more = files.length - MERGE_FILES_SHOWN;
	return `${files.slice(0, MERGE_FILES_SHOWN).join(", ")}${more > 0 ? `, +${more} more` : ""}`;
}

function sharedFiles(a: readonly string[], b: readonly string[]): string[] {
	const other = new Set(b);
	return [...new Set(a.filter((file) => other.has(file)))];
}

function blockWords(item: MergeBlock): string {
	switch (item.kind) {
		case "commit_lane_paths":
			return "uncommitted changes in the lane";
		case "sync_lane":
			return "the lane is behind main";
		case "sync_conflict":
			return item.paths.length > 0
				? `the lane conflicts with main in ${listed(item.paths)}`
				: "the lane conflicts with main";
		case "not_carried":
			return "the merge did not bring the lane's commits in";
		case "clear_hub_paths":
			return "main has local changes in those files";
		case "finish_rebase":
			return "a rebase is unfinished";
		case "retry_land":
			return "another landing holds the integration lock";
		case "fix_gate":
			return `the land check failed: ${boundedLine(item.detail, MERGE_DETAIL_CHARS)}`;
		case "refused":
			return `the land was refused (${item.code}): ${boundedLine(item.detail, MERGE_DETAIL_CHARS)}`;
	}
}

/**
 * The plain-words hold of a join whose landing failed twice. `a` is the earlier step the failing one overlaps (undefined when
 * none does), `b` the step that could not land.
 */
export function mergeHoldWords(a: string | undefined, b: string, files: readonly string[], item: MergeBlock): string {
	const words = blockWords(item);
	if (a === undefined) return `Step ${b} could not land after a second try: ${words}. ${MERGE_REPLAN_SINGLE}`;
	return `Steps ${a} and ${b} changed the same files (${listed(files)}); landing failed twice: ${words}. ${MERGE_REPLAN_PAIR}`;
}

/** The plain-words hold of a refusal the owner must fix: the reason and the fix, for the step that could not land. */
function ownerHoldWords(member: string, code: string): string {
	return `Step ${member} cannot land: ${OWNER_HOLD_REASONS.get(code)}. Fix that, then revise the plan to retry the merge.`;
}

/** A refused attempt: an owner-fixable code holds at once, any other refusal is a block a merge worker may fix. */
function refusedAttempt(laneKey: string, member: string, code: string, detail: string): LaneTry {
	if (OWNER_HOLD_REASONS.has(code)) return { kind: "hold", detail: ownerHoldWords(member, code) };
	return { kind: "block", laneKey, item: { kind: "refused", code, detail } };
}

function goneWords(member: string): LaneTry {
	return { kind: "hold", detail: `step ${member}'s worktree is gone` };
}

export interface LandNextMemberInput {
	readonly isolation: WorkerLaneIsolation;
	readonly gate: { readonly mode: "on" | "off"; readonly command?: string };
	readonly members: readonly MergeLane[];
	readonly landed: Set<string>;
	/** Members that already have a land step: a failure of that step holds the join. */
	readonly mergeWorkerFailed: ReadonlySet<string>;
	readonly retries: number;
}

/**
 * One lane's landing. A land step's lane must carry its member's commits before it lands, or the member's work would stay out
 * of main while the land reads as done. A lane the gate reports behind main is synced in process: a clean sync lands again, a
 * sync conflict is aborted (the lane returns to its tip) and goes to a merge worker. A lane whose tip main already contains
 * has landed: the gate reported it stale only because main moved on, and a stale report comes only for a clean lane.
 */
async function landOne(input: LandNextMemberInput, lane: MergeLane, cwd: string): Promise<LaneTry> {
	const { isolation, gate } = input;
	const laneKey = await isolation.laneKeyAt(cwd);
	if (laneKey === undefined) return goneWords(lane.member);
	if (lane.ownLaneCwd !== undefined) {
		const carried = await isolation.tipContained(lane.ownLaneCwd, cwd);
		if (carried === undefined) return goneWords(lane.member);
		if (!carried) return { kind: "block", laneKey, item: { kind: "not_carried" } };
	}
	let landing: LaneLanding | undefined = await isolation.land(cwd, gate);
	if (landing?.kind === "worklist" && landing.item.kind === "sync_lane") {
		if ((await isolation.tipContained(cwd)) === true) return { kind: "landed" };
		const synced = await isolation.sync(cwd);
		if (synced === undefined) return goneWords(lane.member);
		if (synced.code === "sync_conflicts") {
			// The merge worker starts in its own lane; the member's lane goes back to its tip, stale, for that worker to sync.
			const aborted = await isolation.abortSync(cwd);
			if (aborted === undefined) return goneWords(lane.member);
			if (aborted.code !== "ok") return refusedAttempt(laneKey, lane.member, aborted.code, aborted.message);
			const paths = synced.worklist.files.map((file) => file.path);
			return { kind: "block", laneKey, item: { kind: "sync_conflict", paths } };
		}
		if (synced.code !== "sync_clean") return refusedAttempt(laneKey, lane.member, synced.code, synced.message);
		landing = await isolation.land(cwd, gate);
	}
	if (landing === undefined) return goneWords(lane.member);
	if (landing.kind === "landed" || landing.kind === "nothing_to_land") return { kind: "landed" };
	if (landing.kind === "worklist") {
		if (landing.item.kind === "retry_land") return { kind: "retry", holder: landing.item.holder };
		// Still behind main after a sync: main moved again meanwhile, so the next attempt syncs again.
		if (landing.item.kind === "sync_lane") return { kind: "retry" };
		return { kind: "block", laneKey, item: landing.item };
	}
	return refusedAttempt(laneKey, lane.member, landing.code, landing.detail);
}

/**
 * Lands the lanes in order. A lane that is already landed is passed; the first lane that does not land decides the exit: a
 * retry while the lock is held elsewhere (bounded), one merge worker for that member, or a hold. `landed` is updated in place
 * with the lanes this call landed, so the next call starts after them.
 */
export async function landNextMember(input: LandNextMemberInput): Promise<MergeStep> {
	const passed: MergeLane[] = [];
	for (const lane of input.members) {
		if (input.landed.has(lane.nodeId)) {
			passed.push(lane);
			continue;
		}
		if (lane.laneCwd === undefined)
			return { kind: "hold", detail: `step ${lane.member} needs its own worktree and none was recorded` };
		let attempt: LaneTry;
		try {
			attempt = await landOne(input, lane, lane.laneCwd);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			return {
				kind: "hold",
				detail: `the landing of step ${lane.member} failed: ${boundedLine(text, MERGE_DETAIL_CHARS)}`,
			};
		}
		if (attempt.kind === "landed") {
			input.landed.add(lane.nodeId);
			passed.push(lane);
			continue;
		}
		if (attempt.kind === "retry") {
			return input.retries < MERGE_RETRY_LIMIT
				? { kind: "retry", afterMs: MERGE_RETRY_MS }
				: { kind: "hold", detail: `landing kept waiting for ${attempt.holder ?? "another landing"}` };
		}
		if (attempt.kind === "hold") return { kind: "hold", detail: attempt.detail };
		const partner = passed.find((entry) => sharedFiles(entry.changedFiles, lane.changedFiles).length > 0);
		const shared = partner ? sharedFiles(partner.changedFiles, lane.changedFiles) : [];
		if (!input.mergeWorkerFailed.has(lane.member)) {
			const conflicted = attempt.item.kind === "sync_conflict" ? attempt.item.paths : [];
			const files = conflicted.length > 0 ? conflicted : shared.length > 0 ? shared : lane.changedFiles;
			return {
				kind: "merge_worker",
				member: lane.member,
				other: partner?.member,
				laneKey: attempt.laneKey,
				files,
				item: attempt.item,
			};
		}
		return { kind: "hold", detail: mergeHoldWords(partner?.member, lane.member, shared, attempt.item) };
	}
	return { kind: "landed", files: [...new Set(input.members.flatMap((lane) => lane.changedFiles))] };
}

/**
 * The host revision for a failed landing: one work step in its own lane that merges the failed lane's branch into its lane,
 * keeping the other step's intent when there is one, ordered before the merge. Undefined when the plan has no room, the id is
 * taken, or a named step is missing.
 */
export function mergeWorkerNodes(
	record: PlanRecord,
	mergeId: string,
	step: Extract<MergeStep, { kind: "merge_worker" }>,
	version: number,
): { readonly nodes: PlanNodeSpec[]; readonly final: string } | undefined {
	const { member, other, files, laneKey } = step;
	const merge = record.nodes.find((node) => node.id === mergeId);
	const subject = record.nodes.find((node) => node.id === member);
	const partner = other === undefined ? undefined : record.nodes.find((node) => node.id === other);
	const id = mergeLandNodeId(mergeId, member);
	if (!merge || !subject || (other !== undefined && !partner)) return undefined;
	if (record.nodes.length >= PLAN_LIMITS.nodes || version > PLAN_LIMITS.versions) return undefined;
	if (record.nodes.some((node) => node.id === id)) return undefined;
	const refs = files.filter((file) => file.length <= MAX_TASK_REF_CHARS).slice(0, MAX_TASK_REFS);
	const keep = other === undefined ? "this step's work" : "both steps' work (the note has each intent)";
	const conflicts = other !== undefined && files.length > 0 ? `; resolve conflicts in ${listed(files)}` : "";
	const branch = laneBranch(laneKey);
	const keepWords = `keeping ${keep}${conflicts}`;
	const intent =
		`Merge branch ${branch} (the work of lane ${laneKey}) into your lane with git merge, ${keepWords}, then commit. If your lane is behind main, sync it first.`.slice(
			0,
			PLAN_LIMITS.intentChars,
		);
	const intents = [`Step ${member}: ${subject.intent}`, ...(partner ? [`Step ${other}: ${partner.intent}`] : [])];
	const landStep: PlanNodeSpec = {
		id,
		kind: "work",
		intent,
		brief: {
			v: taskBriefVersionFor({}),
			goal: intent.slice(0, MAX_TASK_GOAL_CHARS),
			note: intents.join("\n").slice(0, MAX_TASK_NOTE_CHARS),
			...(refs.length > 0 ? { refs } : {}),
		},
		inputs: [member],
		after: [],
		writeScope: [...new Set([...subject.writeScope, ...(partner?.writeScope ?? [])])],
		requirementIds: [],
		effort: "normal",
		since: version,
	};
	return {
		nodes: [
			...record.nodes.map((node) => (node.id === mergeId ? { ...node, after: [...node.after, id] } : node)),
			landStep,
		],
		final: record.final,
	};
}

/** The lane of the attempt that produced an outcome: the execution directory the worker was admitted in. */
function laneOf(projection: PlanProjection, outcome: Outcome): string | undefined {
	const attemptId = outcome.attempts.at(-1)?.attemptId;
	return attemptId === undefined
		? undefined
		: projection.attempts[attemptId]?.dispatch.executionContract?.worker.authority.cwd;
}

function settledOutcome(projection: PlanProjection, plan: PlanRuntimeState, nodeId: string): Outcome | undefined {
	return plan.nodes[nodeId]?.held ? undefined : planNodeOutcome(projection, plan, nodeId);
}

/**
 * The independent checks a merge orders before itself for one member: each must have accepted the member. Returns the words
 * of the first check that did not, or undefined when every check accepted (or none was made).
 */
function uncheckedBy(
	projection: PlanProjection,
	plan: PlanRuntimeState,
	record: PlanRecord,
	merge: PlanNodeSpec,
	memberId: string,
): string | undefined {
	for (const check of record.nodes) {
		if (check.kind !== "verify" || !merge.after.includes(check.id)) continue;
		if (check.join?.members.length !== 1 || check.join.members[0] !== memberId) continue;
		if (settledOutcome(projection, plan, check.id)?.status !== "succeeded")
			return `the independent check of step ${memberId} did not accept it`;
	}
	return undefined;
}

/**
 * The lanes a merge lands, in record order: each member that succeeded, as its own lane or, when the merge made one, as its
 * land step's lane. A member that did not succeed is not landed and its lane is left alone. `blocked` names the first step
 * that blocks the landing before any lane is tried: a land step with no accepted result, or a member an independent check
 * did not accept.
 */
export function mergeLanes(
	projection: PlanProjection,
	plan: PlanRuntimeState,
	record: PlanRecord,
	merge: PlanNodeSpec,
): MergeLanes {
	const members: MergeLane[] = [];
	for (const member of record.nodes) {
		if (!merge.join?.members.includes(member.id)) continue;
		const own = settledOutcome(projection, plan, member.id);
		if (own?.status !== "succeeded") continue;
		const rejected = uncheckedBy(projection, plan, record, merge, member.id);
		if (rejected !== undefined) return { members, blocked: rejected };
		const landStep = landStepOf(record, merge.id, member.id);
		if (landStep === undefined) {
			members.push({
				nodeId: member.id,
				member: member.id,
				laneCwd: laneOf(projection, own),
				changedFiles: own.changedFiles,
			});
			continue;
		}
		const landed = settledOutcome(projection, plan, landStep.id);
		if (landed?.status !== "succeeded")
			return { members, blocked: `the merge worker for step ${member.id} has no accepted result` };
		members.push({
			nodeId: landStep.id,
			member: member.id,
			laneCwd: laneOf(projection, landed),
			ownLaneCwd: laneOf(projection, own),
			changedFiles: own.changedFiles,
		});
	}
	return { members };
}

/** The lanes a merge join lands, and whether a step blocks the landing before any lane is tried (a hold). */
export interface MergeLanes {
	readonly members: readonly MergeLane[];
	readonly blocked?: string;
}

/** The host ports a landing reads: the executor's own deps, so a host without worktree deps holds the join. */
export interface MergeHost {
	readonly lanes?: () => WorkerLaneIsolationDeps;
	readonly landGate?: () => { readonly gate: "on" | "off"; readonly gateCommand?: string };
	readonly timers?: () => TimerPort;
}

interface JoinLanding {
	/** The lanes this join landed. In memory: a run after a restart lands them again, and git answers for each. */
	readonly landed: Set<string>;
	retries: number;
	timer?: unknown;
}

/** The key of one merge join's landing state. */
function joinKey(planId: string, nodeId: string): string {
	return `${planId}:${nodeId}`;
}

/**
 * The landing state of the merge joins: one landing per join at a time, the retry timer of a join, and the lane isolation,
 * built once when a landing first needs it.
 */
export class MergeLandings {
	private readonly host: MergeHost;
	/** Asks the executor for a drain when a retry is due. */
	private readonly wake: () => void;
	private readonly joins = new Map<string, JoinLanding>();
	private readonly running = new Set<string>();
	private isolation: WorkerLaneIsolation | undefined;

	constructor(host: MergeHost, wake: () => void) {
		this.host = host;
		this.wake = wake;
	}

	/**
	 * Starts the join's landing unless one runs or a retry waits. The step it reaches goes to `act`; the executor drains again
	 * when the landing ends, whether it landed or failed.
	 */
	start(planId: string, nodeId: string, lanes: MergeLanes, act: (step: MergeStep) => void): void {
		const key = joinKey(planId, nodeId);
		if (this.running.has(key) || this.joins.get(key)?.timer !== undefined) return;
		void this.land(planId, nodeId, lanes)
			.then(act)
			.catch((error: unknown) =>
				harnessLog.warn("plan", "a merge join failed", { planId, nodeId, error: String(error) }),
			)
			.finally(() => this.wake());
	}

	/**
	 * Lands the lanes in order (`landNextMember`). Blocked lanes are a hold, and so is a host without worktree landing. A
	 * member whose land step exists already had its merge worker, so its failure holds the join.
	 */
	private async land(planId: string, nodeId: string, lanes: MergeLanes): Promise<MergeStep> {
		if (lanes.blocked !== undefined) return { kind: "hold", detail: lanes.blocked };
		const worktrees = this.host.lanes?.();
		const gate = this.host.landGate?.();
		if (!worktrees || !gate) return { kind: "hold", detail: "this plan host cannot land worktrees" };
		const key = joinKey(planId, nodeId);
		const state = this.joins.get(key) ?? { landed: new Set<string>(), retries: 0 };
		this.joins.set(key, state);
		this.isolation ??= new WorkerLaneIsolation(worktrees);
		const mergeWorkerFailed = new Set(
			lanes.members.filter((lane) => lane.nodeId !== lane.member).map((lane) => lane.member),
		);
		this.running.add(key);
		try {
			return await landNextMember({
				isolation: this.isolation,
				gate: { mode: gate.gate, ...(gate.gateCommand ? { command: gate.gateCommand } : {}) },
				members: lanes.members,
				landed: state.landed,
				mergeWorkerFailed,
				retries: state.retries,
			});
		} finally {
			this.running.delete(key);
		}
	}

	/** Counts a retry and arms the timer that wakes the executor when it is due; no landing starts before then. */
	retry(planId: string, nodeId: string, afterMs: number): void {
		const state = this.joins.get(joinKey(planId, nodeId));
		if (!state) return;
		state.retries += 1;
		state.timer = this.timers().setTimeout(() => {
			state.timer = undefined;
			this.wake();
		}, afterMs);
	}

	/** A plan closed: the timers and landed sets of its joins go. */
	forgetPlan(planId: string): void {
		for (const key of [...this.joins.keys()]) if (key.startsWith(`${planId}:`)) this.clear(key);
	}

	dispose(): void {
		for (const key of [...this.joins.keys()]) this.clear(key);
	}

	private timers(): TimerPort {
		return this.host.timers?.() ?? SYSTEM_TIMER_PORT;
	}

	private clear(key: string): void {
		const state = this.joins.get(key);
		if (state?.timer !== undefined) this.timers().clearTimeout(state.timer);
		this.joins.delete(key);
	}
}
