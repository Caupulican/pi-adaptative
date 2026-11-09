/**
 * The pure core of a delegation to a leader: the request a root or a leader makes with `bot lead`, the envelope of authority
 * the leader receives (always the parent's narrowed, never widened), the chain check that refuses cycles and over-deep
 * nesting, the brief the leader reads, and the words of its Outcome and of the notices a leader's goal sends. No I/O: the
 * leader controller owns persistence and delivery.
 */

import { conversationTurnOrigin } from "../orchestration/attempt-agent-identity.ts";
import { MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH } from "../orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { boundedText } from "../util/bounded-line.ts";
import type { BotCreationRequest } from "./bot-creation.ts";
import type { DelegationCloseReason } from "./leader-delegation-ledger.ts";
import {
	aggregateOutcomes,
	BLOCKER_ATTRIBUTION,
	type BlockerCode,
	describeNextAction,
	describeOutcomeForHandoff,
	type NextAction,
	type Outcome,
	type OutcomeStatus,
	sameOutcomeAttempt,
} from "./worker-outcome.ts";

/** How deep leaders may nest under the root by default: a root's leader cannot appoint another leader. */
export const LEADER_MAX_DEPTH_DEFAULT = 1;
/** The highest `leaders.maxDepth` the owner may set. */
export const LEADER_MAX_DEPTH_CEILING = 2;
/** The machine id of this machine in a delegation chain; a remote hop carries its link machine name. */
export const LOCAL_MACHINE_ID = "local";
/** The `bot lead` fields besides the action and the leader id; the one list both the orchestrator's and a leader's tool read. */
export const LEAD_FIELDS = ["goal", "requirements", "constraints", "files", "budgetUsd", "minutes", "context"] as const;
/** The cap on a leader report or question quoted in a notice. */
export const MAX_REPORT_CHARS = 2000;

export const LEAD_LIMITS = {
	goalChars: 4000,
	requirements: 16,
	requirementIdChars: 64,
	requirementTextChars: 500,
	constraints: 16,
	constraintChars: 300,
	files: 64,
	fileChars: 512,
	contextChars: 4000,
	/** A week: a longer deadline is no deadline the owner would wait on. */
	maxMinutes: 7 * 24 * 60,
	maxBudgetUsd: 10_000,
} as const;

const REQUIREMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface LeadRequirement {
	readonly id: string;
	readonly text: string;
}

/** What the root asks a leader to do. */
export interface LeadRequest {
	readonly goal: string;
	readonly requirements: readonly LeadRequirement[];
	readonly constraints: readonly string[];
	/** Project-relative paths the leader's subtree may change; absent or empty leaves the whole subtree read-only. */
	readonly files: readonly string[];
	/** A metered spending bound for the whole subtree; subscription use is not money and is not counted. */
	readonly budgetUsd?: number;
	/** Minutes from the start until the delegation is stopped. */
	readonly minutes?: number;
	readonly context?: string;
	/** The leader to use; absent appoints a new goal leader for this goal. */
	readonly agentId?: string;
}

function boundedString(value: unknown, label: string, max: number): string {
	if (typeof value !== "string") throw new Error(`${label} must be text.`);
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} must not be empty.`);
	if (trimmed.length > max) throw new Error(`${label} is longer than ${max} characters.`);
	return trimmed;
}

function positiveNumber(value: unknown, label: string, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max)
		throw new Error(`${label} must be a positive number no larger than ${max}.`);
	return value;
}

/**
 * A project-relative path in one spelling: forward slashes, no `.` segments. An absolute path or one that climbs out of
 * the project is refused, so a write scope can never name a place outside it.
 */
export function normalizeProjectPath(value: string): string | undefined {
	const parts = value.trim().replace(/\\/g, "/").split("/");
	if (parts[0] === "" && parts.length > 1) return undefined;
	if (/^[A-Za-z]:$/.test(parts[0] ?? "")) return undefined;
	const kept = parts.filter((part) => part !== "" && part !== ".");
	if (kept.some((part) => part === "..")) return undefined;
	return kept.length === 0 ? "." : kept.join("/");
}

function pathWithin(parent: string, child: string): boolean {
	return parent === "." || child === parent || child.startsWith(`${parent}/`);
}

/** The `bot lead` fields, validated against their bounds; the first violation is the error the root reads. */
export function leadRequestFrom(input: {
	readonly goal?: unknown;
	readonly requirements?: unknown;
	readonly constraints?: unknown;
	readonly files?: unknown;
	readonly budgetUsd?: unknown;
	readonly minutes?: unknown;
	readonly context?: unknown;
	readonly agentId?: unknown;
}): LeadRequest {
	const goal = boundedString(input.goal, "goal", LEAD_LIMITS.goalChars);
	const requirementsInput = input.requirements ?? [];
	if (!Array.isArray(requirementsInput) || requirementsInput.length > LEAD_LIMITS.requirements)
		throw new Error(`requirements must be a list of at most ${LEAD_LIMITS.requirements}.`);
	const requirements = requirementsInput.map((entry, index): LeadRequirement => {
		const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
		const id = boundedString(record.id, `requirements[${index}].id`, LEAD_LIMITS.requirementIdChars);
		if (!REQUIREMENT_ID.test(id))
			throw new Error(`requirements[${index}].id must use letters, digits, '.', '_' or '-'.`);
		return { id, text: boundedString(record.text, `requirements[${index}].text`, LEAD_LIMITS.requirementTextChars) };
	});
	if (new Set(requirements.map((requirement) => requirement.id)).size !== requirements.length)
		throw new Error("requirements must have distinct ids.");
	const constraintsInput = input.constraints ?? [];
	if (!Array.isArray(constraintsInput) || constraintsInput.length > LEAD_LIMITS.constraints)
		throw new Error(`constraints must be a list of at most ${LEAD_LIMITS.constraints}.`);
	const constraints = constraintsInput.map((entry, index) =>
		boundedString(entry, `constraints[${index}]`, LEAD_LIMITS.constraintChars),
	);
	const filesInput = input.files ?? [];
	if (!Array.isArray(filesInput) || filesInput.length > LEAD_LIMITS.files)
		throw new Error(`files must be a list of at most ${LEAD_LIMITS.files} paths.`);
	const files = filesInput.map((entry, index) => {
		const path = normalizeProjectPath(boundedString(entry, `files[${index}]`, LEAD_LIMITS.fileChars));
		if (!path) throw new Error(`files[${index}] must be a path inside the project.`);
		return path;
	});
	return {
		goal,
		requirements,
		constraints,
		files: [...new Set(files)],
		...(input.budgetUsd !== undefined
			? { budgetUsd: positiveNumber(input.budgetUsd, "budgetUsd", LEAD_LIMITS.maxBudgetUsd) }
			: {}),
		...(input.minutes !== undefined
			? { minutes: positiveNumber(input.minutes, "minutes", LEAD_LIMITS.maxMinutes) }
			: {}),
		...(input.context !== undefined
			? { context: boundedString(input.context, "context", LEAD_LIMITS.contextChars) }
			: {}),
		...(input.agentId !== undefined ? { agentId: boundedString(input.agentId, "agentId", 128) } : {}),
	};
}

export const LEADER_CAPABILITIES = ["read", "write", "create_bots", "delegate"] as const;
export type LeaderCapability = (typeof LEADER_CAPABILITIES)[number];

/** One step of a delegation chain, root first: which leader on which machine works for which delegation. */
export interface DelegationHop {
	readonly machineId: string;
	readonly objectiveId: string;
	readonly leader: string;
}

/** What a leader may do. A child's envelope is its parent's narrowed: every field is a subset or a tighter bound. */
export interface LeaderEnvelope {
	readonly capabilities: readonly LeaderCapability[];
	/** Project-relative root of what the subtree may read. */
	readonly readRoot: string;
	/** Project-relative paths the subtree may change; empty means read-only. */
	readonly writePaths: readonly string[];
	readonly leaderMayWrite: boolean;
	/** Metered spending bound; absent means no money bound beyond the owner's own. */
	readonly budgetUsd?: number;
	readonly deadlineAt?: string;
	/** Providers the subtree may run on; absent means any the parent may use. */
	readonly models: { readonly providers?: readonly string[] };
	/** How many more leader levels may nest below this one. */
	readonly remainingDepth: number;
	readonly chain: readonly DelegationHop[];
}

/** What `bot lead` answers. */
export interface LeadResult {
	readonly delegated: true;
	readonly leader: string;
	/** True when the orchestrator appointed a new goal leader for this goal. */
	readonly goalLeader: boolean;
	readonly envelope: LeaderEnvelope;
	readonly clipped: readonly string[];
	/** The goal of the earlier delegation this one waits behind on the same leader. */
	readonly queuedBehind?: string;
}

/** The root's own envelope: everything, bounded only by the owner's depth setting. */
export function rootLeaderEnvelope(maxDepth: number): LeaderEnvelope {
	return {
		capabilities: [...LEADER_CAPABILITIES],
		readRoot: ".",
		writePaths: ["."],
		leaderMayWrite: true,
		models: {},
		remainingDepth: Math.max(0, Math.min(LEADER_MAX_DEPTH_CEILING, Math.floor(maxDepth))),
		chain: [],
	};
}

/**
 * The envelope a nested goal's parent offers: the parent delegation's own envelope, with its money bound replaced by what the
 * parent's budget has left (`remainingBudgetUsd`, undefined when the parent has no budget). The deadline is kept.
 */
export function leaderEnvelopeFromRecord(
	record: { readonly charter: { readonly envelope: LeaderEnvelope } },
	remainingBudgetUsd?: number,
): LeaderEnvelope {
	const { envelope } = record.charter;
	return remainingBudgetUsd === undefined ? envelope : { ...envelope, budgetUsd: remainingBudgetUsd };
}

export interface NarrowRequest {
	readonly lead: LeadRequest;
	/** The leader can write only when its bot record allows it and the owner made it a standing leader. */
	readonly leaderCanWrite: boolean;
	readonly appointedBy: "owner" | "root";
	readonly hop: DelegationHop;
	readonly nowMs: number;
}

/**
 * The child envelope: the parent's, narrowed to the request. Nothing is refused here; what the parent cannot give is
 * clipped, and each clip is one plain sentence the root reads in the `bot lead` answer.
 */
export function narrowEnvelope(
	parent: LeaderEnvelope,
	request: NarrowRequest,
): { envelope: LeaderEnvelope; clipped: string[] } {
	const clipped: string[] = [];
	const { lead } = request;
	const writePaths: string[] = [];
	for (const file of lead.files) {
		if (parent.writePaths.some((scope) => pathWithin(scope, file))) writePaths.push(file);
		else clipped.push(`${file} is outside what this delegation may change, so it stays read-only.`);
	}
	let leaderMayWrite = parent.leaderMayWrite && writePaths.length > 0;
	if (leaderMayWrite && request.appointedBy === "root") {
		clipped.push(
			"A goal leader works read-only, so the files stay unchanged; name a standing leader that can write to change them.",
		);
		leaderMayWrite = false;
	} else if (leaderMayWrite && !request.leaderCanWrite) {
		clipped.push(`${request.hop.leader} cannot write, so the files stay unchanged.`);
		leaderMayWrite = false;
	}
	const remainingDepth = Math.max(0, parent.remainingDepth - 1);
	let budgetUsd = parent.budgetUsd;
	if (lead.budgetUsd !== undefined) {
		if (budgetUsd !== undefined && lead.budgetUsd > budgetUsd)
			clipped.push(`The budget is held to the parent's $${budgetUsd}.`);
		else budgetUsd = lead.budgetUsd;
	}
	let deadlineAt = parent.deadlineAt;
	if (lead.minutes !== undefined) {
		const requested = new Date(request.nowMs + lead.minutes * 60_000).toISOString();
		if (deadlineAt !== undefined && Date.parse(requested) > Date.parse(deadlineAt))
			clipped.push("The deadline is held to the parent's.");
		else deadlineAt = requested;
	}
	const capabilities = parent.capabilities.filter(
		(capability) => (capability !== "write" || leaderMayWrite) && (capability !== "delegate" || remainingDepth > 0),
	);
	return {
		envelope: {
			capabilities,
			readRoot: parent.readRoot,
			writePaths: leaderMayWrite ? writePaths : [],
			leaderMayWrite,
			...(budgetUsd !== undefined ? { budgetUsd } : {}),
			...(deadlineAt !== undefined ? { deadlineAt } : {}),
			models: parent.models.providers ? { providers: [...parent.models.providers] } : {},
			remainingDepth,
			chain: [...parent.chain, request.hop],
		},
		clipped,
	};
}

export type ChainAdmission = "ok" | "cycle_refused" | "too_deep";

/**
 * Whether one more hop may join a chain: a leader already in it (on the same machine) or a delegation already in it is a
 * cycle; a chain longer than the owner's depth is too deep.
 */
export function admitChain(chain: readonly DelegationHop[], self: DelegationHop, maxHops: number): ChainAdmission {
	if (
		chain.some(
			(hop) =>
				hop.objectiveId === self.objectiveId || (hop.machineId === self.machineId && hop.leader === self.leader),
		)
	)
		return "cycle_refused";
	return chain.length + 1 > maxHops ? "too_deep" : "ok";
}

/** A bot the leader already owns, offered in its brief so it reuses one before making another. */
export interface BriefBot {
	readonly agentId: string;
	readonly description?: string;
}

const BRIEF_CONTEXT_ELISION = "\n[context shortened to fit the brief]";

/**
 * The leader's first message for a delegation. It fits the dispatch bound: the context is cut first, then the list of
 * bots the leader owns; the goal, requirements, constraints and scope are always whole (their own bounds keep them small).
 */
export function renderLeaderBrief(input: {
	readonly lead: LeadRequest;
	readonly envelope: LeaderEnvelope;
	readonly clipped: readonly string[];
	readonly ownedBots: readonly BriefBot[];
	readonly maxChars?: number;
}): string {
	const maxChars = input.maxChars ?? MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH;
	const { lead, envelope } = input;
	const head = [
		"The orchestrator has made you the leader of this goal.",
		"",
		"Goal:",
		lead.goal,
		...(lead.requirements.length > 0
			? ["", "Requirements:", ...lead.requirements.map((requirement) => `- ${requirement.id}: ${requirement.text}`)]
			: []),
		...(lead.constraints.length > 0 ? ["", "Constraints:", ...lead.constraints.map((text) => `- ${text}`)] : []),
		"",
		envelope.leaderMayWrite
			? `You may change only these paths: ${envelope.writePaths.join(", ")}.`
			: "This goal is read-only: neither you nor your bots change files.",
		...(envelope.deadlineAt ? [`It is stopped at ${envelope.deadlineAt} if it has not ended.`] : []),
		...(envelope.budgetUsd !== undefined
			? [`Metered spending for the whole goal stops at $${envelope.budgetUsd}.`]
			: []),
		"Subscription turns cost nothing in metered terms, so the budget does not count them; the goal also stops when a subscription it uses has no allowance left.",
		...(input.clipped.length > 0 ? ["", "Held back:", ...input.clipped.map((text) => `- ${text}`)] : []),
		"",
		"How to lead: split the goal into parts, give each part to a bot with bot_message (create one with action create when none of yours fits), collect their replies, and end with one report of what was done, what is proven and what is left. Ask the orchestrator in your report only when you cannot go on without its answer; it answers you with a new message.",
		...(envelope.capabilities.includes("delegate")
			? [
					"You may hand a part of the goal to a leader of your own with bot_message action lead (the same goal fields; agentId names a standing leader, and leaving it out appoints a goal leader for that part). It reports back to you once; a message you send to it reaches it as an update.",
				]
			: []),
	].join("\n");
	const botLines = input.ownedBots.map(
		(bot) =>
			`- ${bot.agentId}${bot.description ? `: ${boundedText(bot.description.replace(/\s+/g, " "), 200)}` : ""}`,
	);
	const context = lead.context ? `\n\nContext:\n${lead.context}` : "";
	const assemble = (bots: readonly string[], contextText: string) =>
		`${head}${bots.length > 0 ? `\n\nYour bots:\n${bots.join("\n")}` : ""}${contextText}`;
	let brief = assemble(botLines, context);
	if (brief.length <= maxChars) return brief;
	const withoutContext = assemble(botLines, "");
	const room = maxChars - withoutContext.length - "\n\nContext:\n".length - BRIEF_CONTEXT_ELISION.length;
	if (lead.context && room > 0)
		return assemble(botLines, `\n\nContext:\n${lead.context.slice(0, room)}${BRIEF_CONTEXT_ELISION}`);
	const bots = [...botLines];
	brief = withoutContext;
	while (brief.length > maxChars && bots.length > 0) {
		bots.pop();
		brief = assemble(bots, "");
	}
	return brief.length <= maxChars ? brief : brief.slice(0, maxChars);
}

/** The bot facts the leader controller reads; the bot store is their owner. */
export interface LeaderBotView {
	readonly agentId: string;
	readonly displayName: string;
	readonly leader: boolean;
	readonly canWrite: boolean;
	readonly retired: boolean;
	readonly remote: boolean;
	readonly createdBy?: string;
	readonly description?: string;
}

/** The leader view of one stored bot. */
export function leaderBotViewOf(bot: {
	readonly agentId: string;
	readonly displayName: string;
	readonly leader?: boolean;
	readonly canWrite?: boolean;
	readonly retired?: boolean;
	readonly remote?: boolean;
	readonly createdBy?: string;
	readonly description?: string;
}): LeaderBotView {
	return {
		agentId: bot.agentId,
		displayName: bot.displayName,
		leader: bot.leader === true,
		canWrite: bot.canWrite === true,
		retired: bot.retired === true,
		remote: bot.remote === true,
		...(bot.createdBy ? { createdBy: bot.createdBy } : {}),
		...(bot.description ? { description: bot.description } : {}),
	};
}

/** The standing instructions of a goal leader the orchestrator (or a leader) appoints; it exists for one goal. */
export const GOAL_LEADER_SOUL =
	"You lead one goal for the orchestrator and nothing else. Split it into parts, give each part to a bot with bot_message (create the bots you need with action create), collect their replies, and end with one report of what was done, what is proven and what is left. You and your bots never change files. Ask the orchestrator in your report only when you cannot go on without its answer.";

/** The request a goal leader for one goal is created with: a read-only bot, described by the goal's first line. */
export function goalLeaderRequest(lead: LeadRequest): BotCreationRequest {
	return {
		soul: GOAL_LEADER_SOUL,
		description: boundedText(lead.goal.split(/\r?\n/, 1)[0]!.trim(), 200),
		canWrite: false,
	};
}

/** The bots a leader owns, offered in its brief so it reuses one before making another. */
export function briefBotsOwnedBy(bots: Iterable<LeaderBotView>, leader: string): BriefBot[] {
	return [...bots]
		.filter((bot) => bot.createdBy === leader && !bot.retired)
		.map((bot) => ({ agentId: bot.agentId, ...(bot.description ? { description: bot.description } : {}) }));
}

/** Why a named leader cannot lead a goal, in the words the orchestrator reads; undefined when it can. */
export function namedLeaderRefusal(named: LeaderBotView | undefined, agentId: string): string | undefined {
	if (!named || named.retired)
		return `There is no bot named ${agentId}. Name a leader (bot list marks them), or leave agentId out to appoint a goal leader.`;
	if (!named.leader)
		return `${named.displayName} is not a standing leader. Only the owner makes one, with /bot lead ${named.agentId} (not /lead, which shows goals). Name a leader, or leave agentId out to appoint a goal leader.`;
	if (named.remote)
		return `${named.displayName} works on another machine, which cannot lead a goal from here yet. Name a leader on this machine, or leave agentId out.`;
	return undefined;
}

/** The question an Outcome's next action puts to the orchestrator; empty when it asks nothing. */
export function questionOf(outcome: Outcome): string {
	const action = outcome.nextAction;
	return action.kind === "ask_owner" || action.kind === "ask_root" ? action.question : "";
}

/** The fields of an Outcome a notice to the orchestrator carries as details. */
export function outcomeDetails(outcome: Outcome): Record<string, string> {
	return {
		outcomeId: outcome.outcomeId,
		status: outcome.status,
		blocker: outcome.blocker,
		assurance: outcome.assurance,
		nextAction: outcome.nextAction.kind,
	};
}

/** A notice reporting work a third party's words reached opens a third-party run, as a worker handoff does. */
export function touchedByThirdParty(
	snapshot: TaskRuntimeProjection,
	attempts: readonly AttemptRuntimeState[],
): boolean {
	return attempts.some((attempt) => conversationTurnOrigin(snapshot, attempt)?.thirdParty === true);
}

export const UNPRICED_BUDGET_REMEDY = "Lead it again without a budget, or pin a priced leader or worker model.";

/** The early close each reason states over the children's aggregate: the status, the blocker and the next action. */
const EARLY_CLOSE: Readonly<
	Partial<Record<DelegationCloseReason, { status: OutcomeStatus; blocker: BlockerCode; nextAction: NextAction }>>
> = {
	cancelled: {
		status: "cancelled",
		blocker: "cancelled_by_owner",
		nextAction: { kind: "abandon", reason: "cancelled" },
	},
	deadline: {
		status: "blocked",
		blocker: "deadline_reached",
		nextAction: { kind: "fix_request", remedy: "Lead it again with more time or a smaller goal." },
	},
	budget: {
		status: "blocked",
		blocker: "budget_exhausted",
		nextAction: { kind: "fix_request", remedy: "Lead it again with a larger budget or a smaller goal." },
	},
	allowance: {
		status: "blocked",
		blocker: "budget_exhausted",
		nextAction: { kind: "fix_request", remedy: "Lead it again once the subscription's usage window reopens." },
	},
	leader_unavailable: {
		status: "failed",
		blocker: "request_rejected",
		nextAction: { kind: "fix_request", remedy: "Name another leader, or leave agentId out to appoint one." },
	},
};

export interface DelegationOutcomeInput {
	readonly objectiveId: string;
	readonly snapshot: TaskRuntimeProjection;
	readonly leaderAttempts: readonly AttemptRuntimeState[];
	readonly ownedAttempts: readonly AttemptRuntimeState[];
	readonly reason: DelegationCloseReason;
	readonly remedy?: string;
	readonly recordedAt: string;
}

/**
 * The delegation's Outcome. The children are the leader's last turn and each owned bot's last turn in the window,
 * aggregated as they are; an early close states its own cause (who or what ended it) over that aggregate.
 */
export function composeDelegationOutcome(input: DelegationOutcomeInput): Outcome {
	const { snapshot, leaderAttempts, ownedAttempts, reason, remedy } = input;
	const latestByAgent = new Map<string, AttemptRuntimeState>();
	for (const attempt of ownedAttempts) if (attempt.agentId) latestByAgent.set(attempt.agentId, attempt);
	const lastLeader = leaderAttempts.at(-1);
	const children = [...latestByAgent.values(), ...(lastLeader ? [lastLeader] : [])]
		.map((attempt) => sameOutcomeAttempt(snapshot.tasks[attempt.taskId]?.outcome, attempt.attemptId))
		.filter((outcome): outcome is Outcome => outcome !== undefined);
	const aggregate = aggregateOutcomes(children, "all", "leader", {
		outcomeId: `outcome-obj-${input.objectiveId}`,
		nodeId: input.objectiveId,
		objectiveId: input.objectiveId,
		generation: 1,
		recordedAt: input.recordedAt,
	});
	const early = EARLY_CLOSE[reason];
	if (!early) return aggregate;
	return {
		...aggregate,
		status: early.status,
		blocker: early.blocker,
		attribution: BLOCKER_ATTRIBUTION[early.blocker],
		sourceCodes: [`delegation_${reason}`, ...aggregate.sourceCodes].slice(0, 8),
		assurance: "unverified",
		nextAction: remedy === undefined ? early.nextAction : { kind: "fix_request", remedy },
		ladder: { rung: 0, exit: `delegation_${reason}` },
	};
}

/** The goal's words without the `Lead: ` prefix its objective title carries. */
function goalOf(title: string): string {
	return title.replace(/^Lead: /, "");
}

/** Who a notice is for: the orchestrator, or the parent leader of a goal the leader handed on. */
export type NoticeAddressee = "orchestrator" | "parent_leader";

/** The subject of a notice: the goal, or the goal the addressee leader handed on. */
function goalPhrase(title: string, to: NoticeAddressee): string {
	return `the goal "${goalOf(title)}"${to === "parent_leader" ? " you handed on" : ""}`;
}

/** The answer line: a bot action ask for the orchestrator, a bot_message send for a leader (it reaches the leader as an update). */
function answerLine(to: NoticeAddressee, leader: string, goalLine: string): string {
	return to === "orchestrator"
		? `Answer with bot action ask (agentId ${leader}); ${goalLine} goes on with that turn.`
		: `Answer with bot_message action send (agentId ${leader}); ${goalLine} goes on with that message.`;
}

/** The notice a goal's Outcome sends when it ends, to the orchestrator or to the parent leader. */
export function leaderOutcomeNotice(input: {
	readonly title: string;
	readonly objectiveId: string;
	readonly leaderName: string;
	readonly closeReason: DelegationCloseReason | undefined;
	readonly outcome: Outcome;
	readonly report?: string;
	readonly to: NoticeAddressee;
}): string {
	const { outcome, to } = input;
	const verb = input.closeReason === "settled" ? "finished" : "stopped";
	return [
		`Leader ${input.leaderName} ${verb} ${goalPhrase(input.title, to)}: ${describeNextAction(outcome)}`,
		describeOutcomeForHandoff(outcome),
		...(input.report
			? [
					`Leader report (untrusted worker evidence):\n${wrapUntrustedText(boundedText(input.report, MAX_REPORT_CHARS), `leader-report:${input.objectiveId}`)}`,
				]
			: []),
		to === "orchestrator"
			? "Decide whether the owner needs an update or further work; the leader's bots keep their conversations."
			: "Decide whether your goal needs more work from your bots; the leader's bots keep their conversations.",
	].join("\n");
}

/** The notice a leader sends when its turn ends with a question for the orchestrator (or the parent leader). */
export function leaderQuestionNotice(input: {
	readonly title: string;
	readonly objectiveId: string;
	readonly leader: string;
	readonly leaderName: string;
	readonly outcome: Outcome;
	readonly question: string;
	readonly report?: string;
	readonly attemptId: string;
	readonly to: NoticeAddressee;
}): string {
	const { to, leader } = input;
	return [
		`Leader ${input.leaderName} needs you to go on with ${goalPhrase(input.title, to)}.`,
		describeOutcomeForHandoff(input.outcome),
		...(input.question
			? [
					`Question (untrusted worker words):\n${wrapUntrustedText(input.question, `leader-question:${input.objectiveId}`)}`,
				]
			: []),
		...(input.report
			? [
					`Leader report (untrusted worker evidence):\n${wrapUntrustedText(boundedText(input.report, MAX_REPORT_CHARS), `leader-report:${input.attemptId}`)}`,
				]
			: []),
		answerLine(to, leader, "the goal") +
			(to === "orchestrator" ? ` The owner can stop it with /lead cancel ${leader}.` : ""),
	].join("\n");
}

/** The notice a leader sends when it asks the orchestrator (or the parent leader) a question while its goal stays open. */
export function leaderAskNotice(input: {
	readonly title: string;
	readonly leader: string;
	readonly leaderName: string;
	readonly askId: string;
	readonly question: string;
	readonly to: NoticeAddressee;
}): string {
	return [
		`Leader ${input.leaderName} asks you about ${goalPhrase(input.title, input.to)} while it keeps working.`,
		`Question (untrusted worker words):\n${wrapUntrustedText(boundedText(input.question, MAX_REPORT_CHARS), `leader-ask:${input.askId}`)}`,
		answerLine(input.to, input.leader, "the goal"),
	].join("\n");
}
