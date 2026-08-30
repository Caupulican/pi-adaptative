/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@caupulican/pi-agent-core";
import type { CompactionResult } from "@caupulican/pi-agent-core/node";
import type { ImageContent, Model } from "@caupulican/pi-ai";
import type { SessionStats, ToolProbeReport } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { HumanInputAnswer, HumanInputPresentationRequest } from "../../core/human-input.ts";
import type { SourceInfo } from "../../core/source-info.ts";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "clear_queue" }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "get_available_thinking_levels" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "get_tool_repair_health" }
	| { id?: string; type: "tool_probe"; model?: string }
	| { id?: string; type: "remove_tool_repair_rule"; model: string; mode: string }
	| { id?: string; type: "reset_tool_protocol"; model: string }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" };

function isRpcImageContent(value: unknown): value is ImageContent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string";
}

function hasOptionalImages(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) && value.every(isRpcImageContent));
}

function hasOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function hasOptionalBoolean(value: unknown): boolean {
	return value === undefined || typeof value === "boolean";
}

/** Fail-closed runtime decoder for the full untrusted JSONL command union. */
export function decodeRpcCommand(value: unknown): RpcCommand | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.type !== "string" || (record.id !== undefined && typeof record.id !== "string")) {
		return undefined;
	}
	switch (record.type) {
		case "prompt":
			if (
				typeof record.message !== "string" ||
				!hasOptionalImages(record.images) ||
				(record.streamingBehavior !== undefined &&
					record.streamingBehavior !== "steer" &&
					record.streamingBehavior !== "followUp")
			)
				return undefined;
			break;
		case "steer":
		case "follow_up":
			if (typeof record.message !== "string" || !hasOptionalImages(record.images)) return undefined;
			break;
		case "new_session":
			if (!hasOptionalString(record.parentSession)) return undefined;
			break;
		case "set_model":
			if (typeof record.provider !== "string" || typeof record.modelId !== "string") return undefined;
			break;
		case "set_thinking_level":
			if (
				record.level !== "off" &&
				record.level !== "minimal" &&
				record.level !== "low" &&
				record.level !== "medium" &&
				record.level !== "high" &&
				record.level !== "xhigh" &&
				record.level !== "max" &&
				record.level !== "ultra"
			)
				return undefined;
			break;
		case "set_steering_mode":
		case "set_follow_up_mode":
			if (record.mode !== "all" && record.mode !== "one-at-a-time") return undefined;
			break;
		case "compact":
			if (!hasOptionalString(record.customInstructions)) return undefined;
			break;
		case "set_auto_compaction":
		case "set_auto_retry":
			if (typeof record.enabled !== "boolean") return undefined;
			break;
		case "bash":
			if (typeof record.command !== "string" || !hasOptionalBoolean(record.excludeFromContext)) return undefined;
			break;
		case "tool_probe":
			if (!hasOptionalString(record.model)) return undefined;
			break;
		case "remove_tool_repair_rule":
			if (typeof record.model !== "string" || typeof record.mode !== "string") return undefined;
			break;
		case "reset_tool_protocol":
			if (typeof record.model !== "string") return undefined;
			break;
		case "export_html":
			if (!hasOptionalString(record.outputPath)) return undefined;
			break;
		case "switch_session":
			if (typeof record.sessionPath !== "string") return undefined;
			break;
		case "fork":
			if (typeof record.entryId !== "string") return undefined;
			break;
		case "set_session_name":
			if (typeof record.name !== "string") return undefined;
			break;
		case "clear_queue":
		case "abort":
		case "get_state":
		case "cycle_model":
		case "get_available_models":
		case "cycle_thinking_level":
		case "get_available_thinking_levels":
		case "abort_retry":
		case "abort_bash":
		case "get_session_stats":
		case "get_tool_repair_health":
		case "clone":
		case "get_fork_messages":
		case "get_last_assistant_text":
		case "get_messages":
		case "get_commands":
			break;
		default:
			return undefined;
	}
	return record as RpcCommand;
}

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill";
	/** Source metadata for the owning resource */
	sourceInfo: SourceInfo;
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| {
			id?: string;
			type: "response";
			command: "clear_queue";
			success: true;
			data: { steering: string[]; followUp: string[]; commands: string[] };
	  }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_thinking_levels";
			success: true;
			data: { levels: ThinkingLevel[] };
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "get_tool_repair_health"; success: true; data: { report: string } }
	| { id?: string; type: "response"; command: "tool_probe"; success: true; data: ToolProbeReport }
	| { id?: string; type: "response"; command: "remove_tool_repair_rule"; success: true; data: { removed: boolean } }
	| { id?: string; type: "response"; command: "reset_tool_protocol"; success: true; data: { removed: boolean } }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "questions"; request: HumanInputPresentationRequest }
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| {
			type: "extension_ui_response";
			id: string;
			answers: HumanInputAnswer[];
			images?: ImageContent[];
	  }
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

/** Fail-closed decoder for the untrusted JSONL extension-UI boundary. */
export function decodeRpcExtensionUIResponse(value: unknown): RpcExtensionUIResponse | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.type !== "extension_ui_response" || typeof record.id !== "string") return undefined;
	const isCancelled = record.cancelled === true;
	const hasValue = typeof record.value === "string";
	const hasConfirmation = typeof record.confirmed === "boolean";
	const hasAnswers = Array.isArray(record.answers) && (record.images === undefined || Array.isArray(record.images));
	if (Number(isCancelled) + Number(hasValue) + Number(hasConfirmation) + Number(hasAnswers) !== 1) {
		return undefined;
	}
	return record as RpcExtensionUIResponse;
}

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
