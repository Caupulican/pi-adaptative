import type { BeforeToolCallResult } from "@caupulican/pi-agent-core";
import type { SourceInfo } from "./source-info.ts";

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
	readonly allowedTools: readonly OptionalToolIdentity[];
	/**
	 * Classified intents only: tools whose own judgment was missing, uncertain or below the confidence
	 * floor. No owner decision exists for them, so the gate denies them nothing.
	 */
	readonly undecidedTools?: readonly OptionalToolIdentity[];
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
	let undecidedTools: OptionalToolIdentity[] | undefined;
	if (record.undecidedTools !== undefined) {
		if (record.status !== "classified") return undefined;
		undecidedTools = readToolIdentities(record.undecidedTools);
		if (!undecidedTools) return undefined;
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
		...(undecidedTools?.length ? { undecidedTools } : {}),
		...(resumeIntent ? { resumeIntent } : {}),
		...(Array.isArray(record.pendingRequests) ? { pendingRequests: [...record.pendingRequests] as string[] } : {}),
	};
}

const INTENT_CONFIDENCE_FLOOR = 0.95;
const TASK_RELATIONS = ["continue", "replace", "end", "uncertain"];
const TOOL_DECISIONS = ["request", "revoke", "unchanged", "uncertain"];

/** Confidence is checked once at this intent owner; malformed choices are not semantic approval. */
function intentChoice(answer: unknown, allowed: readonly string[]): string | undefined {
	if (!answer || typeof answer !== "object" || Array.isArray(answer)) return undefined;
	const value = answer as { choice?: unknown; confidence?: unknown };
	return typeof value.choice === "string" &&
		allowed.includes(value.choice) &&
		typeof value.confidence === "number" &&
		Number.isFinite(value.confidence) &&
		value.confidence >= INTENT_CONFIDENCE_FLOOR &&
		value.confidence <= 1
		? value.choice
		: undefined;
}

/** What the evaluator answered and whether the intent owner accepted it, one line per question. */
function describeJudgment(
	question: string,
	answer: unknown,
	allowed: readonly string[],
): {
	question: string;
	uncertain: boolean;
	text: string;
} {
	const value =
		answer && typeof answer === "object" && !Array.isArray(answer) ? (answer as Record<string, unknown>) : {};
	const accepted = intentChoice(answer, allowed);
	const confidence = typeof value.confidence === "number" ? value.confidence.toFixed(3) : "missing";
	const choice = typeof value.choice === "string" ? value.choice : "missing";
	const verdict = accepted === undefined ? `rejected (floor ${INTENT_CONFIDENCE_FLOOR})` : "accepted";
	return {
		question,
		uncertain: accepted === undefined || accepted === "uncertain",
		text: `${question}: ${choice} @${confidence} ${verdict}`,
	};
}

/** Raw optional-tool judgments for the semantic evaluation ledger, so a paused verdict can be traced to its cause. */
export function traceOptionalToolJudgments(
	context: Pick<OptionalToolRequestContext, "candidates">,
	answers: Readonly<Record<string, unknown>>,
): { question: string; uncertain: boolean; text: string }[] {
	return [
		describeJudgment("optional_tool_task", answers.optional_tool_task, TASK_RELATIONS),
		...context.candidates.map((candidate, index) => {
			const trace = describeJudgment(`optional_tool_${index}`, answers[`optional_tool_${index}`], TOOL_DECISIONS);
			return { ...trace, text: `${trace.text} (${candidate.toolName})` };
		}),
	];
}

export function optionalToolIntentFromAnswers(
	request: string,
	context: OptionalToolRequestContext,
	answers: Readonly<Record<string, unknown>>,
): OptionalToolIntent {
	const relation = intentChoice(answers.optional_tool_task, TASK_RELATIONS);
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
	const allowedTools: OptionalToolIdentity[] = [];
	const undecidedTools: OptionalToolIdentity[] = [];
	if (relation !== "end")
		context.candidates.forEach((candidate, index) => {
			const identity = { toolName: candidate.toolName, sourcePath: candidate.sourcePath };
			const decision = intentChoice(answers[`optional_tool_${index}`], TOOL_DECISIONS);
			const heldBefore =
				previous?.allowedTools.some(
					(tool) => tool.toolName === candidate.toolName && tool.sourcePath === candidate.sourcePath,
				) ?? false;
			// A judgment that is missing, uncertain or below the floor is no owner decision: a grant held
			// before stands, and otherwise the tool stays undecided rather than "not requested".
			if (decision === "request" || (heldBefore && (decision === "unchanged" || decision === undefined)))
				allowedTools.push(identity);
			else if (decision === undefined || decision === "uncertain") undecidedTools.push(identity);
		});
	return {
		version: 1,
		status: "classified",
		taskRequest: previous?.taskRequest ?? request,
		allowedTools,
		...(undecidedTools.length ? { undecidedTools } : {}),
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
 * Optional tools follow the owner's classified intent, never the host's inability to classify it: only a
 * `paused` snapshot (classification in flight) or a `classified` one that decided against this tool
 * blocks. An `unresolved` or absent snapshot, or a tool left `undecided`, is no owner decision, so it
 * denies nothing. Credential values are protected by the exposure guard on the tool's output, not by
 * availability.
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
	if (intent.status === "paused")
		return {
			block: true,
			reason: `Optional tool ${toolName} waits for the owner's latest request to be classified. Retry after it settles.`,
		};
	const named = (tool: OptionalToolIdentity) => tool.toolName === toolName && tool.sourcePath === input.sourcePath;
	if (intent.allowedTools.some(named) || intent.undecidedTools?.some(named)) return undefined;
	return {
		block: true,
		reason: `Optional tool ${toolName} was not requested by the owner. Use it only if the owner asks; otherwise continue without it.`,
	};
}
