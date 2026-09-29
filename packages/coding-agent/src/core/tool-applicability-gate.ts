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
	readonly status: "paused" | "classified";
	readonly taskRequest: string;
	readonly allowedTools: readonly OptionalToolIdentity[];
	readonly pendingRequests?: readonly string[];
	readonly resumeIntent?: OptionalToolIntent;
}

export interface OptionalToolRequestContext {
	readonly candidates: readonly OptionalToolCandidate[];
	readonly previous: OptionalToolIntent | undefined;
	readonly pendingRequests?: readonly string[];
}

/** Only the newest host snapshot counts; malformed state never resurrects an older grant. */
export function readOptionalToolIntent(value: unknown): OptionalToolIntent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		(record.status !== "paused" && record.status !== "classified") ||
		typeof record.taskRequest !== "string" ||
		record.taskRequest.length > MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS ||
		!Array.isArray(record.allowedTools) ||
		record.allowedTools.length > MAX_OPTIONAL_TOOL_INTENT_TOOLS
	)
		return undefined;
	const allowedTools: OptionalToolIdentity[] = [];
	for (const tool of record.allowedTools) {
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
		allowedTools.push({ toolName: item.toolName, sourcePath: item.sourcePath });
	}
	if (record.pendingRequests !== undefined) {
		if (
			record.status !== "paused" ||
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
		if (!resumeIntent || record.status !== "paused" || !Array.isArray(record.pendingRequests)) return undefined;
	}
	return {
		version: 1,
		status: record.status,
		taskRequest: record.taskRequest,
		allowedTools: record.status === "paused" ? [] : allowedTools,
		...(resumeIntent ? { resumeIntent } : {}),
		...(Array.isArray(record.pendingRequests) ? { pendingRequests: [...record.pendingRequests] as string[] } : {}),
	};
}

/** Confidence is checked once at this intent owner; malformed choices are not semantic approval. */
function intentChoice(answer: unknown, allowed: readonly string[]): string | undefined {
	if (!answer || typeof answer !== "object" || Array.isArray(answer)) return undefined;
	const value = answer as { choice?: unknown; confidence?: unknown };
	return typeof value.choice === "string" &&
		allowed.includes(value.choice) &&
		typeof value.confidence === "number" &&
		Number.isFinite(value.confidence) &&
		value.confidence >= 0.95 &&
		value.confidence <= 1
		? value.choice
		: undefined;
}

export function optionalToolIntentFromAnswers(
	request: string,
	context: OptionalToolRequestContext,
	answers: Readonly<Record<string, unknown>>,
): OptionalToolIntent {
	const relation = intentChoice(answers.optional_tool_task, ["continue", "replace", "end", "uncertain"]);
	const paused: OptionalToolIntent = {
		version: 1,
		status: "paused",
		taskRequest: request.slice(0, MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS),
		allowedTools: [],
	};
	if (
		!relation ||
		relation === "uncertain" ||
		request.length > MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS ||
		context.candidates.length > MAX_OPTIONAL_TOOL_INTENT_TOOLS
	)
		return paused;
	const previous = relation === "continue" && context.previous?.status === "classified" ? context.previous : undefined;
	const allowedTools: OptionalToolIdentity[] = [];
	if (relation !== "end")
		context.candidates.forEach((candidate, index) => {
			const decision = intentChoice(answers[`optional_tool_${index}`], [
				"request",
				"revoke",
				"unchanged",
				"uncertain",
			]);
			const retained =
				decision === "unchanged" &&
				previous?.allowedTools.some(
					(tool) => tool.toolName === candidate.toolName && tool.sourcePath === candidate.sourcePath,
				);
			if (decision === "request" || retained)
				allowedTools.push({ toolName: candidate.toolName, sourcePath: candidate.sourcePath });
		});
	return { version: 1, status: "classified", taskRequest: previous?.taskRequest ?? request, allowedTools };
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

export function enforceExplicitOptionalToolRequest(input: {
	toolName: string;
	sourcePath: string;
	intent: OptionalToolIntent | undefined;
}): BeforeToolCallResult | undefined {
	const requested =
		input.intent?.status === "classified" &&
		input.intent.allowedTools.some(
			(tool) => tool.toolName === input.toolName && tool.sourcePath === input.sourcePath,
		);
	if (requested) return undefined;
	return {
		block: true,
		reason: `Optional tool ${input.toolName} is paused because the host has no current classified owner intent for this tool and source. Continue the requested work without this integration. Do not probe credentials or another optional integration as a fallback.`,
	};
}
