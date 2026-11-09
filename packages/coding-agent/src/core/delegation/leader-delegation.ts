/**
 * The pure core of a delegation to a leader: the request a root makes with `bot lead`, the envelope of authority the
 * leader receives (always the parent's narrowed, never widened), the chain check that refuses cycles and over-deep
 * nesting, and the brief the leader reads. No I/O: the leader controller owns persistence and delivery.
 */

import { MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH } from "../orchestration/contracts.ts";
import { boundedText } from "../util/bounded-line.ts";

/** How deep leaders may nest under the root by default: a root's leader cannot appoint another leader. */
export const LEADER_MAX_DEPTH_DEFAULT = 1;
/** The highest `leaders.maxDepth` the owner may set. */
export const LEADER_MAX_DEPTH_CEILING = 2;
/** The machine id of this machine in a delegation chain; a remote hop carries its link machine name. */
export const LOCAL_MACHINE_ID = "local";

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
