import type { BeforeToolCallResult } from "@caupulican/pi-agent-core";
import type { SourceInfo } from "./source-info.ts";
import { DEFAULT_SYSTEM_ONE_CONFIG } from "./system-one/config.ts";

export const OPTIONAL_TOOL_INTENT_CUSTOM_TYPE = "optional_tool_intent";
export const MAX_OPTIONAL_TOOL_INTENT_TOOLS = 32;
export const MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS = 4_000;

export interface OptionalToolIdentity {
	readonly toolName: string;
	readonly sourcePath: string;
}

export interface OptionalToolCandidate extends OptionalToolIdentity {
	readonly aliases: readonly string[];
}

export interface OptionalToolIntent {
	readonly version: 1;
	/**
	 * `paused`: the owner's latest words are still being classified. `unresolved`: the host asked and got
	 * no usable answer (outage, no evaluator, uncertain or sub-threshold judgment). `classified`: the
	 * owner's intent for each optional tool is known.
	 */
	readonly status: "paused" | "unresolved" | "classified";
	readonly taskRequest: string;
	/** The tools the owner asked for by name or by what they provide; a record, not a permission. */
	readonly allowedTools: readonly OptionalToolIdentity[];
	/**
	 * Classified intents only: tools the owner forbade or withdrew. The only tools the gate blocks: the
	 * owner cannot list the tools a task will need, so a tool they neither asked for nor forbade runs.
	 */
	readonly revokedTools?: readonly OptionalToolIdentity[];
	readonly pendingRequests?: readonly string[];
	readonly resumeIntent?: OptionalToolIntent;
}

export interface OptionalToolRequestContext {
	readonly candidates: readonly OptionalToolCandidate[];
	readonly previous: OptionalToolIntent | undefined;
	readonly pendingRequests?: readonly string[];
}

function readToolIdentities(value: unknown): OptionalToolIdentity[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_OPTIONAL_TOOL_INTENT_TOOLS) return undefined;
	const tools: OptionalToolIdentity[] = [];
	for (const tool of value) {
		if (!tool || typeof tool !== "object" || Array.isArray(tool)) return undefined;
		const item = tool as Record<string, unknown>;
		if (
			typeof item.toolName !== "string" ||
			!item.toolName ||
			item.toolName.length > 128 ||
			typeof item.sourcePath !== "string" ||
			item.sourcePath.length > 4096
		)
			return undefined;
		tools.push({ toolName: item.toolName, sourcePath: item.sourcePath });
	}
	return tools;
}

/** Only the newest host snapshot counts; malformed state never resurrects an older grant. */
export function readOptionalToolIntent(value: unknown): OptionalToolIntent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		(record.status !== "paused" && record.status !== "unresolved" && record.status !== "classified") ||
		typeof record.taskRequest !== "string" ||
		record.taskRequest.length > MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS ||
		!Array.isArray(record.allowedTools) ||
		record.allowedTools.length > MAX_OPTIONAL_TOOL_INTENT_TOOLS
	)
		return undefined;
	const allowedTools = readToolIdentities(record.allowedTools);
	if (!allowedTools) return undefined;
	let revokedTools: OptionalToolIdentity[] | undefined;
	if (record.revokedTools !== undefined) {
		if (record.status !== "classified") return undefined;
		revokedTools = readToolIdentities(record.revokedTools);
		if (!revokedTools) return undefined;
	}
	if (record.pendingRequests !== undefined) {
		if (
			record.status === "classified" ||
			!Array.isArray(record.pendingRequests) ||
			record.pendingRequests.length > 8 ||
			record.pendingRequests.some(
				(request) => typeof request !== "string" || request.length > MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS,
			)
		)
			return undefined;
	}
	let resumeIntent: OptionalToolIntent | undefined;
	if (record.resumeIntent !== undefined) {
		const resume = record.resumeIntent as Record<string, unknown>;
		if (
			!resume ||
			typeof resume !== "object" ||
			resume.status !== "classified" ||
			resume.resumeIntent !== undefined ||
			resume.pendingRequests !== undefined
		)
			return undefined;
		resumeIntent = readOptionalToolIntent(resume);
		if (!resumeIntent || record.status === "classified" || !Array.isArray(record.pendingRequests)) return undefined;
	}
	return {
		version: 1,
		status: record.status,
		taskRequest: record.taskRequest,
		allowedTools: record.status === "classified" ? allowedTools : [],
		...(revokedTools?.length ? { revokedTools } : {}),
		...(resumeIntent ? { resumeIntent } : {}),
		...(Array.isArray(record.pendingRequests) ? { pendingRequests: [...record.pendingRequests] as string[] } : {}),
	};
}

/**
 * An owner-intent answer counts only at the plane's own hard-gate choice confidence. The controller
 * passes its configured value; this default is the same number, not a second owner of it.
 */
export const DEFAULT_INTENT_CONFIDENCE_FLOOR = DEFAULT_SYSTEM_ONE_CONFIG.thresholds.choice.hard_gate_auto_confidence;
const TASK_RELATIONS = ["continue", "replace", "end", "uncertain"];
const TOOL_DECISIONS = ["request", "revoke", "unchanged", "uncertain"];

/** The task relation is judged only against a previous classified intent; with none it is `replace` by definition. */
export function optionalToolRelationAsked(context: Pick<OptionalToolRequestContext, "previous">): boolean {
	return context.previous?.status === "classified";
}

/** Confidence is checked once at this intent owner; malformed choices are not semantic approval. */
function intentChoice(answer: unknown, allowed: readonly string[], floor: number): string | undefined {
	if (!answer || typeof answer !== "object" || Array.isArray(answer)) return undefined;
	const value = answer as { choice?: unknown; confidence?: unknown };
	return typeof value.choice === "string" &&
		allowed.includes(value.choice) &&
		typeof value.confidence === "number" &&
		Number.isFinite(value.confidence) &&
		value.confidence >= floor &&
		value.confidence <= 1
		? value.choice
		: undefined;
}

/** What the evaluator answered and whether the intent owner accepted it, one line per question. */
function describeJudgment(
	question: string,
	answer: unknown,
	allowed: readonly string[],
	floor: number,
): {
	question: string;
	uncertain: boolean;
	text: string;
} {
	const value =
		answer && typeof answer === "object" && !Array.isArray(answer) ? (answer as Record<string, unknown>) : {};
	const accepted = intentChoice(answer, allowed, floor);
	const confidence = typeof value.confidence === "number" ? value.confidence.toFixed(3) : "missing";
	const choice = typeof value.choice === "string" ? value.choice : "missing";
	const verdict = accepted === undefined ? `rejected (floor ${floor})` : "accepted";
	return {
		question,
		uncertain: accepted === undefined || accepted === "uncertain",
		text: `${question}: ${choice} @${confidence} ${verdict}`,
	};
}

/** Raw optional-tool judgments for the semantic evaluation ledger, so a paused verdict can be traced to its cause. */
export function traceOptionalToolJudgments(
	context: Pick<OptionalToolRequestContext, "candidates" | "previous">,
	answers: Readonly<Record<string, unknown>>,
	floor: number = DEFAULT_INTENT_CONFIDENCE_FLOOR,
): { question: string; uncertain: boolean; text: string }[] {
	return [
		...(optionalToolRelationAsked(context)
			? [describeJudgment("optional_tool_task", answers.optional_tool_task, TASK_RELATIONS, floor)]
			: []),
		...context.candidates.map((candidate, index) => {
			const trace = describeJudgment(
				`optional_tool_${index}`,
				answers[`optional_tool_${index}`],
				TOOL_DECISIONS,
				floor,
			);
			return { ...trace, text: `${trace.text} (${candidate.toolName})` };
		}),
	];
}

export function optionalToolIntentFromAnswers(
	request: string,
	context: OptionalToolRequestContext,
	answers: Readonly<Record<string, unknown>>,
	floor: number = DEFAULT_INTENT_CONFIDENCE_FLOOR,
): OptionalToolIntent {
	const relation = optionalToolRelationAsked(context)
		? intentChoice(answers.optional_tool_task, TASK_RELATIONS, floor)
		: "replace";
	const unresolved: OptionalToolIntent = {
		version: 1,
		status: "unresolved",
		taskRequest: request.slice(0, MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS),
		allowedTools: [],
	};
	if (
		!relation ||
		relation === "uncertain" ||
		request.length > MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS ||
		context.candidates.length > MAX_OPTIONAL_TOOL_INTENT_TOOLS
	)
		return unresolved;
	const previous = relation === "continue" && context.previous?.status === "classified" ? context.previous : undefined;
	const sameTool = (tool: OptionalToolIdentity, identity: OptionalToolIdentity) =>
		tool.toolName === identity.toolName && tool.sourcePath === identity.sourcePath;
	const allowedTools: OptionalToolIdentity[] = [];
	const revokedTools: OptionalToolIdentity[] = [];
	if (relation !== "end")
		context.candidates.forEach((candidate, index) => {
			const identity = { toolName: candidate.toolName, sourcePath: candidate.sourcePath };
			const decision = intentChoice(answers[`optional_tool_${index}`], TOOL_DECISIONS, floor);
			const askedBefore = previous?.allowedTools.some((tool) => sameTool(tool, identity)) ?? false;
			const forbiddenBefore = previous?.revokedTools?.some((tool) => sameTool(tool, identity)) ?? false;
			// Only the owner's own words change a tool's standing: a missing, uncertain, below-the-floor or
			// silent judgment leaves what the task already had, and a tool never forbidden runs.
			if (decision === "request") allowedTools.push(identity);
			else if (decision === "revoke" || forbiddenBefore) revokedTools.push(identity);
			else if (askedBefore) allowedTools.push(identity);
		});
	return {
		version: 1,
		status: "classified",
		taskRequest: previous?.taskRequest ?? request,
		allowedTools,
		...(revokedTools.length ? { revokedTools } : {}),
	};
}

const SECRET_STORE_REQUEST_ALIASES = [
	"secret store",
	"credentials",
	"credential",
	"authentication",
	"oauth",
	"api key",
];
const UNGATED_TOOL_SOURCES = new Set(["builtin", "bundled", "inline", "sdk"]);

export function optionalToolRequestAliases(
	toolName: string,
	sourceInfo: SourceInfo | undefined,
	getExtensionVerificationTarget?: () => { toolName: string; path: string } | undefined,
): readonly string[] | undefined {
	if (toolName === "secret_store") return SECRET_STORE_REQUEST_ALIASES;
	if (!sourceInfo || UNGATED_TOOL_SOURCES.has(sourceInfo.source)) return undefined;
	const verification = getExtensionVerificationTarget?.();
	if (verification?.toolName === toolName && verification.path === sourceInfo.path) return undefined;
	return [toolName.replaceAll("_", " ").replaceAll("-", " ")];
}

/** Actions that return names and metadata only; activating or migrating loads or writes credentials. */
const SECRET_STORE_METADATA_ACTIONS: ReadonlySet<unknown> = new Set(["status", "list", "discover"]);

/**
 * An optional tool runs unless the owner forbade it: the owner cannot list the tools a task will need, so
 * a tool they neither asked for nor forbade is theirs to use, as every other command is once they direct
 * the work. Only a classified intent that records a forbidding blocks the tool; while the owner's latest
 * words are being classified, the forbiddings of the intent they continue still stand. An unresolved or
 * absent snapshot is no owner decision and denies nothing. Credential values are protected by the
 * exposure guard on the tool's output, not by availability.
 */
export function enforceExplicitOptionalToolRequest(input: {
	toolName: string;
	sourcePath: string;
	intent: OptionalToolIntent | undefined;
	args?: unknown;
}): BeforeToolCallResult | undefined {
	const { intent, toolName } = input;
	if (!intent || intent.status === "unresolved") return undefined;
	if (toolName === "secret_store") {
		const action = (input.args as { action?: unknown } | undefined)?.action;
		if (SECRET_STORE_METADATA_ACTIONS.has(action)) return undefined;
	}
	const standing = intent.status === "classified" ? intent : intent.resumeIntent;
	const forbidden = standing?.revokedTools?.some(
		(tool) => tool.toolName === toolName && tool.sourcePath === input.sourcePath,
	);
	if (!forbidden) return undefined;
	return {
		block: true,
		reason: `Optional tool ${toolName} was forbidden by the owner. Continue without it unless the owner asks for it again.`,
	};
}
