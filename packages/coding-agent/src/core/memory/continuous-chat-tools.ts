/**
 * The root `zoom` and `date` tools of the ICM continuous chat. A call parses its arguments, runs one navigation
 * command against the live chat and renders the result; parsing, refusals and rendering stay in
 * `continuous-chat-navigation.ts`.
 * Workers hold read-only zoom and date tools through their memory broker by message id only, while private worker logs stay root-readable.
 */

import type { ImageContent } from "@caupulican/pi-ai";
import { type TSchema, Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "../extensions/types.ts";
import {
	CONTINUOUS_CHAT_ZOOM_IMAGE_MAX_BYTES,
	CONTINUOUS_CHAT_ZOOM_IMAGE_MAX_COUNT,
	CONTINUOUS_CHAT_ZOOM_PAGE_BYTES,
	type ContinuousChatNavigationSource,
	ContinuousChatNavigator,
	type ContinuousChatWorkerLogPort,
	parseContinuousChatNavigationCommand,
	renderContinuousChatNavigationResult,
} from "./continuous-chat-navigation.ts";
import { CONTINUOUS_CHAT_TOOL_DEFINITIONS } from "./continuous-chat-prompt.ts";
import { memoryFailure } from "./history-tool.ts";
import { TRANSCRIPT_RECALL_RESULT_MARKER } from "./transcript-memory-contracts.ts";
import { CONTINUOUS_CHAT_DATE_TOOL_NAME, CONTINUOUS_CHAT_ZOOM_TOOL_NAME } from "./worker-memory-tools.ts";

/** What a navigation call reads: the chat's nodes, messages and images, and agent logs where allowed. */
export interface ContinuousChatNavigationPort {
	readonly navigation: ContinuousChatNavigationSource;
	/** Absent for a delegated lane: an agent's private log is the root's to read, never another agent's. */
	readonly workerLogs?: ContinuousChatWorkerLogPort;
}

/** What the live chat exposes to the root's tools and to the ICM system block. */
export interface ContinuousChatPort extends ContinuousChatNavigationPort {
	readonly workerLogs: ContinuousChatWorkerLogPort;
	/** The user's own instructions, appended after the stable system prompt. */
	userInstructions(): string | undefined;
}

/**
 * The session's live chat, resolved on every call: undefined while none runs (a child session, a narrow host, or a
 * disposed host), so a stopped chat is never read through a stale reference.
 */
export type ContinuousChatPortSource = () => ContinuousChatPort | undefined;

/** The navigation port a call reads, resolved per call exactly as {@link ContinuousChatPortSource}. */
export type ContinuousChatNavigationPortSource = () => ContinuousChatNavigationPort | undefined;

export type ContinuousChatNavigationToolName =
	| typeof CONTINUOUS_CHAT_ZOOM_TOOL_NAME
	| typeof CONTINUOUS_CHAT_DATE_TOOL_NAME;

/** The description the stable prompt owns, so the tool text and the prompt cannot disagree. */
function describeTool(name: ContinuousChatNavigationToolName): string {
	const definition = CONTINUOUS_CHAT_TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
	if (definition === undefined) throw new Error(`Continuous-chat tool definition is missing: ${name}`);
	return definition.description;
}

const ZOOM_N_PARAMETER = Type.Optional(
	Type.Integer({ minimum: 1, description: "Messages covered by the line; a power of 2" }),
);
const ZOOM_PAGE_PARAMETER = Type.Optional(
	Type.Integer({ minimum: 0, description: "Page of a long message or agent chat, from 0" }),
);
const ZOOM_PARAMETERS = Type.Object(
	{
		id: Type.Union([Type.Integer({ minimum: 0 }), Type.String({ minLength: 1, maxLength: 128 })], {
			description: "Message id (with n), or an agent name",
		}),
		n: ZOOM_N_PARAMETER,
		page: ZOOM_PAGE_PARAMETER,
	},
	{ additionalProperties: false },
);
/** A worker's zoom: message ids only, since another agent's private log stays readable by the root alone. */
const MESSAGE_ZOOM_PARAMETERS = Type.Object(
	{
		id: Type.Integer({ minimum: 0, description: "Message id (with n)" }),
		n: ZOOM_N_PARAMETER,
		page: ZOOM_PAGE_PARAMETER,
	},
	{ additionalProperties: false },
);

const DATE_PARAMETERS = Type.Object(
	{ id: Type.Integer({ minimum: 0, description: "Message id" }) },
	{ additionalProperties: false },
);

/**
 * Runs one navigation call against the live chat. A refusal is a typed result the model reads; a source or port failure
 * propagates so the kernel records it as a tool failure. Every result carries `TRANSCRIPT_RECALL_RESULT_MARKER` so legacy
 * OKF transcript-history capture skips recall output, while ICM continuous-chat ingestion still logs each tool result once
 * as an `echo` under its own source key. A message's images are attached as image content within `imageBytes` per result;
 * an image past that budget is named in the text, not attached.
 */
export async function executeContinuousChatNavigation(
	source: ContinuousChatNavigationPortSource,
	tool: ContinuousChatNavigationToolName,
	args: unknown,
	signal?: AbortSignal,
	pageBytes = CONTINUOUS_CHAT_ZOOM_PAGE_BYTES,
	imageBytes = CONTINUOUS_CHAT_ZOOM_IMAGE_MAX_BYTES,
): Promise<AgentToolResult<Record<string, unknown>>> {
	const port = source();
	if (port === undefined) {
		return memoryFailure(
			"continuous_chat_unavailable",
			"The continuous chat is not running in this session, so zoom and date cannot read it.",
			{ [TRANSCRIPT_RECALL_RESULT_MARKER]: true },
			"tool_failure",
		);
	}
	const parsed = parseContinuousChatNavigationCommand(tool, args);
	const result =
		"status" in parsed
			? parsed
			: await new ContinuousChatNavigator(port.navigation, port.workerLogs, pageBytes, imageBytes).execute(
					parsed,
					signal,
				);
	const text = renderContinuousChatNavigationResult(result);
	if (result.status === "rejected") {
		return memoryFailure(result.reason, text, { [TRANSCRIPT_RECALL_RESULT_MARKER]: true });
	}
	const details = { [TRANSCRIPT_RECALL_RESULT_MARKER]: true };
	if (result.status !== "message") return { content: [{ type: "text", text }], details };
	const images: ImageContent[] = [];
	let attachedBytes = 0;
	for (const image of result.images) {
		if (images.length >= CONTINUOUS_CHAT_ZOOM_IMAGE_MAX_COUNT || attachedBytes + image.bytes > imageBytes) {
			throw new Error("Continuous-chat navigator returned an over-budget image page.");
		}
		attachedBytes += image.bytes;
		const data = await port.navigation.readImage(image);
		signal?.throwIfAborted();
		images.push({ type: "image", data: data.toString("base64"), mimeType: image.mimeType });
	}
	return { content: [{ type: "text", text }, ...images], details };
}

/** Runs one navigation call and returns its tool result: the root's executor, or a delegated lane's broker. */
export type ContinuousChatNavigationExecutor = (
	tool: ContinuousChatNavigationToolName,
	args: unknown,
	signal?: AbortSignal,
) => Promise<AgentToolResult<Record<string, unknown>>>;

function navigationTool(
	name: ContinuousChatNavigationToolName,
	label: string,
	promptSnippet: string,
	parameters: TSchema,
	description: string,
	execute: ContinuousChatNavigationExecutor,
): ToolDefinition {
	return {
		name,
		label,
		description,
		promptSnippet,
		parameters,
		readOnly: true,
		execute: async (_toolCallId, params: unknown, signal) => execute(name, params, signal),
	};
}

/**
 * The `zoom` and `date` tools over one executor. The root's `zoom` also takes an agent's name for that agent's log; a
 * worker's takes message ids only, and private worker logs stay root-readable.
 */
export function createContinuousChatNavigationTools(
	execute: ContinuousChatNavigationExecutor,
	options: { agentLogs: boolean },
): ToolDefinition[] {
	const messageIdsOnly = options.agentLogs
		? ""
		: " Workers take message ids only; private worker logs stay root-readable.";
	return [
		navigationTool(
			CONTINUOUS_CHAT_ZOOM_TOOL_NAME,
			"Chat Zoom",
			"Open a line of the chat view into its two lines, one message whole, or an agent's chat log.",
			options.agentLogs ? ZOOM_PARAMETERS : MESSAGE_ZOOM_PARAMETERS,
			`${describeTool(CONTINUOUS_CHAT_ZOOM_TOOL_NAME)}${messageIdsOnly}`,
			execute,
		),
		navigationTool(
			CONTINUOUS_CHAT_DATE_TOOL_NAME,
			"Chat Date",
			"Read the date and time of one message in the chat.",
			DATE_PARAMETERS,
			describeTool(CONTINUOUS_CHAT_DATE_TOOL_NAME),
			execute,
		),
	];
}

/** The root's `zoom` and `date` tools, bound to the session's live chat. */
export function createContinuousChatTools(source: ContinuousChatPortSource): ToolDefinition[] {
	return createContinuousChatNavigationTools(
		(tool, args, signal) => executeContinuousChatNavigation(source, tool, args, signal),
		{ agentLogs: true },
	);
}
