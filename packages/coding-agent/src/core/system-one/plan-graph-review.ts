/**
 * System One judges a plan graph after its code facts pass and before it is recorded (design PG 3.3). Program
 * `JEV-PLAN-GRAPH` asks four atomic yes/no questions; code decides with ordered exits:
 *
 * - J1 `misses_request_part`: does the request ask for something no step does? Once per version, the measured
 *   `JEV-PLAN-REVIEW` question itself, over the goal text and the steps' intents.
 * - J2 `needs_output_of`: does `later` need a result only `earlier` produces? Per candidate pair (code fact F9).
 * - J3 `pair_evidence_sufficient`: do the two steps say enough to tell? Paired with each J2: a J2 answer counts
 *   only when its J3 reaches the acceptance cut.
 * - J4 `brief_self_contained`: can a thin step be done from its brief and named inputs alone?
 *
 * Each question sees only its own state: J1 one request, each pair one request (its J2 and J3 share that pair's
 * state), each J4 candidate one request, all in flight together. The engine takes one state per request, so this
 * isolation costs one request per group; System One answers each request's questions in parallel.
 *
 * Every answer is read on the `orchestration` family (accept at 0.90, require absence at 0.10, no soft band); a
 * reading between the cuts, or an unanswered question, is `open` and becomes a doubt, never an action. Exits, first
 * match wins (exit 1, refusal on code facts, happens before this module is called):
 * 2. System One absent, or any request fails -> `accept_unjudged` on code facts alone.
 * 3. J3 and J2 accepted -> add the edge earlier -> later, when it keeps the graph acyclic (re-checked in code over
 *    the nodes plus the edges already added); a cycle -> `open` for that pair.
 * 4. J3 accepted and J2 absent -> independent, no action.
 * 5. Any other pair reading -> `open` for that pair.
 * 6. J1 accepted -> `accept_with_gap`; J1 absent -> nothing; otherwise a doubt.
 * 7. J4 absent (not self-contained) -> `annotate` that node; J4 between the cuts -> a doubt.
 * 8. Otherwise -> `accept`.
 *
 * Measurement owed: the `orchestration` family ships with a labelled question set per program. Only J1's wording
 * is measured (as `JEV-PLAN-REVIEW`'s `misses_request_part`, in its own steps state); J2, J3 and J4 are unmeasured,
 * and so is J1 over plan-graph steps, until a labelled `JEV-PLAN-GRAPH` set (sound graphs and planted defects: a
 * missing part, a hidden dependency, a pair that cannot be told apart, a brief that leans on the root's context,
 * written in more than one language) is answered once and its cuts re-decided offline from the saved answers. That
 * set lives with the other System One measurements in `src/core/system-one/evals/` (its cases under
 * `evals/corpus/`), run by its own `eval:` package script like `eval:completion`.
 */

import { type NoulDirection, type NoulReading, readNoul } from "../decision/noul.ts";
import { type PlanJudgmentRef, type PlanNodeSpec, planPathExists } from "../plan/plan-graph.ts";
import { programOverOwnerWords } from "../security/owner-paste-boundary.ts";
import type { OperationEffectEngine, OperationEvaluation } from "./operation-classifier.ts";
import { PLAN_REVIEW_PROGRAM } from "./plan-review.ts";
import { noteDecisionTrace } from "./semantic-evaluation-ledger.ts";

/** J1 is `JEV-PLAN-REVIEW`'s measured question, asked over the same `request` and `steps` state keys. */
const MISSES_REQUEST_PART = PLAN_REVIEW_PROGRAM.decisions[0] satisfies { readonly id: "misses_request_part" };

export const PLAN_GRAPH_PROGRAM = {
	schema_version: "2.0",
	program_id: "JEV-PLAN-GRAPH",
	description:
		"Whether a plan graph covers the request, which of its parallel steps depend on each other, and which briefs stand alone.",
	decisions: [
		MISSES_REQUEST_PART,
		{
			id: "needs_output_of",
			instruction: "Does `later` need a result that only `earlier` produces?",
			criteria: {
				true: "`later` reads, changes or builds on something that does not exist until `earlier` has done its work.",
				false: "`later` can be done fully without anything `earlier` produces.",
			},
		},
		{
			id: "pair_evidence_sufficient",
			instruction:
				"Do `earlier` and `later` state enough about what each reads and produces to tell whether `later` needs the result of `earlier`?",
			criteria: {
				true: "Both steps name what they read and what they produce, so the dependency can be read from them.",
				false: "What one of the steps reads or produces is unstated or only implied.",
			},
		},
		{
			id: "brief_self_contained",
			instruction:
				"Can `step` be done from its own text and the results of the steps in `inputs` alone, without knowledge that only the planner holds?",
			criteria: {
				true: "Everything the step needs is in its text, the files it names or its inputs' results.",
				false: "The step relies on context it does not state, such as an earlier conversation or an unnamed decision.",
			},
		},
	],
} as const;

type PlanGraphQuestionId = (typeof PLAN_GRAPH_PROGRAM.decisions)[number]["id"];

/** The end each question needs and the family it is read on; J1 asks for a defect, the rest for a property. */
const DIRECTION: Readonly<Record<PlanGraphQuestionId, NoulDirection>> = {
	misses_request_part: "required_false",
	needs_output_of: "required_true",
	pair_evidence_sufficient: "required_true",
	brief_self_contained: "required_true",
};

/** The question that reads the owner's `request`. */
const REQUEST_QUESTIONS: ReadonlySet<string> = new Set(["misses_request_part"]);

/** Bounds on the candidates the caller ranks (design PG 3.3): pairs for J2/J3, thin steps for J4. */
export const PLAN_GRAPH_REVIEW_LIMITS = Object.freeze({ pairs: 12, selfContained: 8 });

export interface PlanGraphReviewInput {
	/** The goal text and its requirement texts. */
	readonly request: string;
	/** Topologically sorted; code facts already passed. */
	readonly nodes: readonly PlanNodeSpec[];
	/** F9 candidates, strongest first; only the first {@link PLAN_GRAPH_REVIEW_LIMITS.pairs} are asked. */
	readonly pairs: readonly { readonly earlier: PlanNodeSpec; readonly later: PlanNodeSpec }[];
	/** J4 candidates; only the first {@link PLAN_GRAPH_REVIEW_LIMITS.selfContained} are asked. */
	readonly selfContained: readonly PlanNodeSpec[];
	readonly signal?: AbortSignal;
}

export interface PlanGraphPairRef {
	readonly earlier: string;
	readonly later: string;
}

export interface PlanGraphReview {
	/** Exit 2: System One was absent or a request failed; the plan is recorded on code facts alone. */
	readonly unjudged: boolean;
	/** Exit 3: edges the harness adds, in the order they were accepted. */
	readonly addEdges: readonly PlanGraphPairRef[];
	/** Exit 3 cycle case and exit 5: pairs that run as proposed, each with why it stayed open. */
	readonly open: readonly (PlanGraphPairRef & { readonly why: string })[];
	/** Exit 6: the plan does not cover the whole request. */
	readonly gap: boolean;
	/** Exit 7: node ids whose brief gets the root's recent context at release. */
	readonly annotate: readonly string[];
	/** What System One could not settle, in plain words. */
	readonly doubts: readonly string[];
	/** One reference per asked question whose evaluation has a ledger row. */
	readonly judgments: readonly PlanJudgmentRef[];
	readonly exit: "accept" | "accept_unjudged" | "accept_with_gap";
}

/** One request: the questions it asks and the state only they see. */
interface ReviewGroup {
	readonly decisions: readonly (typeof PLAN_GRAPH_PROGRAM.decisions)[number][];
	readonly state: Record<string, unknown>;
	/** Owner-paste awareness applies to the request text; the steps' own text is not owner words. */
	readonly judged: readonly string[];
	/** The ledger question id of each asked question (it names the pair or node). */
	readonly questionIds: Readonly<Partial<Record<PlanGraphQuestionId, string>>>;
}

interface AnsweredGroup {
	readonly group: ReviewGroup;
	readonly evaluation: OperationEvaluation;
}

const UNJUDGED_REVIEW = {
	unjudged: true,
	addEdges: [],
	open: [],
	gap: false,
	annotate: [],
	judgments: [],
	exit: "accept_unjudged",
} as const;

function pairKey(pair: PlanGraphPairRef): string {
	return `${pair.earlier}>${pair.later}`;
}

/** What one step tells a judge: its text, what it reads, changes and uses; never the root's context. */
function stepState(node: PlanNodeSpec): Record<string, unknown> {
	return {
		id: node.id,
		does: node.intent,
		...(node.brief?.note ? { note: node.brief.note } : {}),
		reads: node.brief?.refs ?? [],
		changes: node.writeScope,
		uses: node.inputs,
	};
}

function decisionsOf(ids: readonly PlanGraphQuestionId[]) {
	return PLAN_GRAPH_PROGRAM.decisions.filter((decision) => ids.includes(decision.id));
}

function reviewGroups(
	input: PlanGraphReviewInput,
	pairs: PlanGraphReviewInput["pairs"],
	thin: readonly PlanNodeSpec[],
) {
	const steps = input.nodes.map((node) => node.intent);
	const groups: ReviewGroup[] = [
		{
			decisions: decisionsOf(["misses_request_part"]),
			state: { request: input.request || "(no request recorded)", steps },
			judged: [input.request, ...steps],
			questionIds: { misses_request_part: "misses_request_part" },
		},
	];
	for (const pair of pairs) {
		const key = pairKey({ earlier: pair.earlier.id, later: pair.later.id });
		groups.push({
			decisions: decisionsOf(["needs_output_of", "pair_evidence_sufficient"]),
			state: { earlier: stepState(pair.earlier), later: stepState(pair.later) },
			judged: [],
			questionIds: {
				needs_output_of: `needs_output_of:${key}`,
				pair_evidence_sufficient: `pair_evidence_sufficient:${key}`,
			},
		});
	}
	for (const node of thin) {
		groups.push({
			decisions: decisionsOf(["brief_self_contained"]),
			state: {
				step: stepState(node),
				inputs: input.nodes
					.filter((candidate) => node.inputs.includes(candidate.id))
					.map((candidate) => ({ id: candidate.id, does: candidate.intent })),
			},
			judged: [],
			questionIds: { brief_self_contained: `brief_self_contained:${node.id}` },
		});
	}
	return groups;
}

function ask(engine: OperationEffectEngine, group: ReviewGroup, signal: AbortSignal | undefined) {
	const program = { ...PLAN_GRAPH_PROGRAM, decisions: group.decisions };
	return engine.evaluate(programOverOwnerWords(program, REQUEST_QUESTIONS, ...group.judged), group.state, {
		consequence: "medium",
		...(signal ? { signal } : {}),
	});
}

function read(answered: AnsweredGroup, id: PlanGraphQuestionId): NoulReading {
	return readNoul(answered.evaluation.answers?.[id], DIRECTION[id], "orchestration");
}

/** Why a pair stayed open, from its two readings; undefined when exit 3 or 4 settles it. */
function openReason(needs: NoulReading, sufficient: NoulReading): string | undefined {
	if (needs === "unasked" || sufficient === "unasked") return "System One gave no answer for this pair";
	if (sufficient !== "hard_pass") return "the two steps do not say enough to tell whether one needs the other";
	if (needs === "hard_pass" || needs === "hard_fail") return undefined;
	return "System One could not settle whether the later step needs that result";
}

/**
 * Reviews one plan version. Never throws on a System One failure (that is exit 2); an abort of `signal` propagates.
 */
export async function reviewPlanGraph(
	engine: OperationEffectEngine | undefined,
	input: PlanGraphReviewInput,
): Promise<PlanGraphReview> {
	input.signal?.throwIfAborted();
	const pairs = input.pairs.slice(0, PLAN_GRAPH_REVIEW_LIMITS.pairs);
	const thin = input.selfContained.slice(0, PLAN_GRAPH_REVIEW_LIMITS.selfContained);
	const unasked = [
		...(input.pairs.length > pairs.length
			? [
					`whether ${input.pairs.length - pairs.length} more pairs of parallel steps depend on each other (not asked)`,
				]
			: []),
		...(input.selfContained.length > thin.length
			? [`whether ${input.selfContained.length - thin.length} more short steps stand alone (not asked)`]
			: []),
	];
	// Exit 2: without System One the plan's facts are all there is.
	if (!engine) return { ...UNJUDGED_REVIEW, doubts: ["the plan was checked without System One", ...unasked] };
	const groups = reviewGroups(input, pairs, thin);
	const settled = await Promise.allSettled(groups.map((group) => ask(engine, group, input.signal)));
	const failure = settled.find((result) => result.status === "rejected");
	if (failure) {
		input.signal?.throwIfAborted();
		// Exit 2 decides for the requests that did answer too: their ledger rows say the plan went unjudged.
		for (const result of settled) {
			if (result.status === "fulfilled")
				noteDecisionTrace(engine, result.value, {
					decision: "plan graph review: unjudged",
					exit: "accept_unjudged",
				});
		}
		const reason = failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
		return { ...UNJUDGED_REVIEW, doubts: [`the plan was checked without System One (${reason})`, ...unasked] };
	}
	const answered = settled.map((result, index) => ({
		group: groups[index] as ReviewGroup,
		evaluation: (result as PromiseFulfilledResult<OperationEvaluation>).value,
	}));
	const [requestGroup, ...rest] = answered as [AnsweredGroup, ...AnsweredGroup[]];
	const pairGroups = rest.slice(0, pairs.length);
	const thinGroups = rest.slice(pairs.length);

	const judgments: PlanJudgmentRef[] = [];
	/** Records the exit a group's answers led to: its decision trace and a ledger reference per question asked. */
	const settle = (answer: AnsweredGroup, subject: string, exit: string) => {
		noteDecisionTrace(engine, answer.evaluation, {
			decision: `plan graph review of ${subject}: ${exit}`,
			drove: answer.group.decisions.map((decision) => decision.id),
			exit,
			read: (id) =>
				id in DIRECTION ? { family: "orchestration", direction: DIRECTION[id as PlanGraphQuestionId] } : undefined,
		});
		const ledgerRef = answer.evaluation.evaluationId;
		if (ledgerRef === undefined) return;
		for (const decision of answer.group.decisions) {
			const questionId = answer.group.questionIds[decision.id];
			if (questionId) judgments.push({ program: PLAN_GRAPH_PROGRAM.program_id, questionId, ledgerRef });
		}
	};
	const doubts: string[] = [];

	// Exit 6, read first so its doubt leads.
	const coverage = read(requestGroup, "misses_request_part");
	const gap = coverage === "hard_fail";
	if (!gap && coverage !== "hard_pass") doubts.push("whether the plan covers everything the goal asks");
	settle(requestGroup, "the request", gap ? "gap" : coverage === "hard_pass" ? "covered" : "doubt");

	// Exits 3-5, in rank order: an accepted edge joins the graph the next pair's cycle check reads.
	const addEdges: PlanGraphPairRef[] = [];
	const open: (PlanGraphPairRef & { readonly why: string })[] = [];
	let graph: readonly PlanNodeSpec[] = input.nodes;
	pairs.forEach((pair, index) => {
		const answer = pairGroups[index] as AnsweredGroup;
		const ref = { earlier: pair.earlier.id, later: pair.later.id };
		const needs = read(answer, "needs_output_of");
		const why = openReason(needs, read(answer, "pair_evidence_sufficient"));
		const cycle = !why && needs === "hard_pass" && planPathExists(graph, ref.later, ref.earlier);
		if (why || cycle) {
			open.push({
				...ref,
				why: why ?? "ordering it after that step would make the steps wait on each other in a loop",
			});
			doubts.push(`whether "${ref.later}" needs the result of "${ref.earlier}"`);
			settle(answer, pairKey(ref), cycle ? "open_cycle" : "open");
		} else if (needs === "hard_fail") {
			settle(answer, pairKey(ref), "independent");
		} else {
			addEdges.push(ref);
			graph = graph.map((node) =>
				node.id === ref.later ? { ...node, inputs: [...node.inputs, ref.earlier] } : node,
			);
			settle(answer, pairKey(ref), "add_edge");
		}
	});

	// Exit 7.
	const annotate: string[] = [];
	thin.forEach((node, index) => {
		const answer = thinGroups[index] as AnsweredGroup;
		const reading = read(answer, "brief_self_contained");
		if (reading === "hard_fail") annotate.push(node.id);
		else if (reading !== "hard_pass") doubts.push(`whether step "${node.id}" can be done from its brief alone`);
		settle(
			answer,
			node.id,
			reading === "hard_fail" ? "annotate" : reading === "hard_pass" ? "self_contained" : "doubt",
		);
	});

	return {
		unjudged: false,
		addEdges,
		open,
		gap,
		annotate,
		doubts: [...doubts, ...unasked],
		judgments,
		exit: gap ? "accept_with_gap" : "accept",
	};
}
