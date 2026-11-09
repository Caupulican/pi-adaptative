/**
 * Acceptance of one `plan` tool call (start or revise), design PG 3.3, as ordered code decisions:
 *
 * 1. code facts F1-F7 (and F10's goal-dependency edges, added first) refuse with every fix listed; nothing is recorded;
 * 2. System One absent or failing -> recorded on code facts alone (`unjudged`);
 * 3. J2 and its paired J3 accepted (>= 0.90) for a pair -> the edge is added; the version is re-checked on code facts
 *    with the edges, and a refusal then names the edges that caused it;
 * 4. J3 accepted, J2 absent -> the pair runs in parallel;
 * 5. any other pair reading -> the pair runs as proposed and is reported as open;
 * 6. J1 accepted -> recorded, and the gap is reported to the root;
 * 7. J4 absent for a short step -> the root's last two plain turns (at most 2 KiB) are baked into that step's brief;
 * 8. otherwise -> recorded as proposed.
 *
 * The judgments themselves live in `system-one/plan-graph-review.ts`; this module only combines them with the facts.
 */

import { MAX_TASK_GOAL_CHARS, MAX_TASK_NOTE_CHARS } from "../comms/comms-records.ts";
import type { GoalState } from "../goals/goal-state.ts";
import type { OperationEffectEngine } from "../system-one/operation-classifier.ts";
import { type PlanGraphReview, reviewPlanGraph } from "../system-one/plan-graph-review.ts";
import { lastUserRequest, rootTurnsExcerpt } from "./plan-dispatch.ts";
import type { PlanToolInput } from "./plan-executor-port.ts";
import {
	checkPlanFacts,
	goalDependencyEdges,
	PLAN_LIMITS,
	PLAN_RECORD_VERSION,
	type PlanFactProblem,
	type PlanNodeSpec,
	type PlanRecord,
	type PlanRuntimeState,
	planRecordBytes,
} from "./plan-graph.ts";
import {
	briefLine,
	defaultFinal,
	dependencyCandidates,
	nodeFromStep,
	resolveSince,
	revisedNodes,
	thinSteps,
	withEdges,
} from "./plan-revision.ts";

const REQUEST_MAX_BYTES = 4 * 1024;

export interface PlanAcceptanceContext {
	readonly planId: string;
	readonly objectiveId: string;
	readonly goal: GoalState | undefined;
	/** The plan being revised; absent for a start. */
	readonly current?: { readonly record: PlanRecord; readonly runtime: PlanRuntimeState };
	readonly headroom: { readonly tasks: number; readonly attempts: number };
	readonly engine: OperationEffectEngine | undefined;
	/** The root's session branch, root to leaf. */
	readonly entries: readonly unknown[];
	readonly now: string;
	readonly signal?: AbortSignal;
}

export type PlanAcceptance =
	| {
			readonly ok: true;
			readonly record: PlanRecord;
			/** Plain lines for the tool result: edges added, open pairs, the gap, annotated steps, doubts. */
			readonly notes: readonly string[];
	  }
	| { readonly ok: false; readonly problems: readonly string[] };

function problemLines(problems: readonly PlanFactProblem[]): string[] {
	return problems.map((problem) => problem.fix);
}

function requestText(goal: GoalState | undefined, entries: readonly unknown[], title: string): string {
	if (!goal) return lastUserRequest(entries, REQUEST_MAX_BYTES) ?? title;
	const requirements = goal.requirements.map((requirement) => `- ${requirement.id}: ${requirement.text}`);
	return [goal.userGoal, ...(requirements.length > 0 ? ["Requirements:", ...requirements] : [])].join("\n");
}

/** Exit 7: the root's recent context, baked into a step's brief at acceptance so a restart releases the same task. */
function annotated(
	nodes: readonly PlanNodeSpec[],
	ids: readonly string[],
	entries: readonly unknown[],
): PlanNodeSpec[] {
	const excerpt = rootTurnsExcerpt(entries);
	if (!excerpt || ids.length === 0) return [...nodes];
	const note = `Context from the planner's conversation:\n${excerpt}`.slice(0, MAX_TASK_NOTE_CHARS).trim();
	// A step whose brief already states its acceptance lines keeps them and gains the note.
	return nodes.map((node) =>
		ids.includes(node.id) && !node.brief?.note
			? {
					...node,
					brief: node.brief
						? { ...node.brief, note }
						: { v: 2, goal: briefLine(node.intent, MAX_TASK_GOAL_CHARS), note },
				}
			: node,
	);
}

function reviewNotes(review: PlanGraphReview, goalEdges: readonly { earlier: string; later: string }[]): string[] {
	return [
		...(review.unjudged ? ["Checked on code facts alone: System One was unavailable."] : []),
		...goalEdges.map((edge) => `"${edge.later}" runs after "${edge.earlier}" (the goal's requirements depend so).`),
		...review.addEdges.map((edge) => `"${edge.later}" now uses the result of "${edge.earlier}".`),
		...review.open.map(
			(pair) => `Unsettled whether "${pair.later}" needs "${pair.earlier}" (${pair.why}); they run in parallel.`,
		),
		...(review.gap ? ["The plan may miss part of the request; check it and revise if it does."] : []),
		...(review.annotate.length > 0
			? [`Given your recent conversation as context: ${review.annotate.join(", ")}.`]
			: []),
		...review.doubts.slice(0, 6).map((doubt) => `Not settled: ${doubt}.`),
	];
}

/** Checks, judges and builds one plan version; the caller records it. */
export async function acceptPlanCall(input: PlanToolInput, context: PlanAcceptanceContext): Promise<PlanAcceptance> {
	const current = context.current?.record;
	const version = (current?.version ?? 0) + 1;
	const title = input.title?.trim() || current?.title || "";
	let proposed: PlanNodeSpec[];
	let final: string | undefined;
	if (current) {
		const revised = revisedNodes(current, input, version);
		if (revised.problems.length > 0) return { ok: false, problems: revised.problems };
		proposed = revised.nodes;
		final = revised.final;
	} else {
		proposed = (input.steps ?? []).map((step) => nodeFromStep(step, version));
		final = input.final ?? defaultFinal(proposed);
	}
	const goal = context.goal;
	const goalEdges = goal ? goalDependencyEdges(proposed, goal.requirements) : [];
	proposed = withEdges(proposed, goalEdges, "after");
	const changed = new Set(
		resolveSince(current, context.current?.runtime, proposed, version, true)
			.filter((node) => node.since === version)
			.map((node) => node.id),
	);
	const releasedTasks = current
		? Object.entries(context.current?.runtime.nodes ?? {}).filter(([id, node]) => node.release && !changed.has(id))
				.length
		: 0;
	const factContext = {
		version,
		...(goal
			? {
					requirementIds: goal.requirements.map((requirement) => requirement.id),
					openRequirementIds: goal.requirements
						.filter((requirement) => requirement.status === "open")
						.map((requirement) => requirement.id),
				}
			: {}),
		headroom: context.headroom,
		releasedTasks,
		maxScopeChars: PLAN_LIMITS.scopeChars,
	};
	const facts = checkPlanFacts(title, proposed, final ?? "", factContext);
	if (!facts.ok) return { ok: false, problems: problemLines(facts.problems) };
	const focus = current ? changed : undefined;
	const review = await reviewPlanGraph(context.engine, {
		request: requestText(goal, context.entries, title),
		nodes: facts.nodes,
		pairs: dependencyCandidates(facts.nodes, focus),
		selfContained: thinSteps(facts.nodes, focus),
		...(context.signal ? { signal: context.signal } : {}),
	});
	const edged = withEdges(facts.nodes, review.addEdges, "inputs");
	const recheck = checkPlanFacts(title, edged, final ?? "", factContext);
	if (!recheck.ok) {
		const added = review.addEdges.map((edge) => `"${edge.later}" needs the result of "${edge.earlier}"`);
		return {
			ok: false,
			problems: [`System One found: ${added.join("; ")}. With that order:`, ...problemLines(recheck.problems)],
		};
	}
	const nodes = resolveSince(
		current,
		context.current?.runtime,
		annotated(recheck.nodes, review.annotate, context.entries),
		version,
		true,
	);
	const record: PlanRecord = {
		v: PLAN_RECORD_VERSION,
		planId: context.planId,
		version,
		objectiveId: current?.objectiveId ?? context.objectiveId,
		...(current?.goalId ? { goalId: current.goalId } : goal ? { goalId: goal.goalId } : {}),
		title,
		nodes,
		rootOwned: recheck.rootOwned,
		final: final ?? "",
		status: "active",
		unjudged: review.unjudged,
		judgments: [...(current?.judgments ?? []), ...review.judgments].slice(-PLAN_LIMITS.judgments),
		createdAt: current?.createdAt ?? context.now,
		revisedAt: context.now,
	};
	if (planRecordBytes(record) > PLAN_LIMITS.recordBytes) {
		return { ok: false, problems: ["the plan is too large to keep; use fewer or shorter steps"] };
	}
	return { ok: true, record, notes: reviewNotes(review, goalEdges) };
}
