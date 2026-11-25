/**
 * The arguments a tool call runs with. Before schema validation the tool's own compatibility shim
 * (`prepareArguments`) runs; after it, the validated arguments give the call's forms (`backgroundArguments`). A call with
 * a background form runs in it only once its handoff to a background session task is accepted, and in its foreground
 * form otherwise. A nested call (one tool calling another) is never handed off, so it always runs in its foreground form.
 */

import { formatToolRepairStandingRule } from "@caupulican/pi-ai/tool-repair-registry";
import { ToolArgumentValidationError, type ToolArgumentValidationTelemetryEvent } from "@caupulican/pi-ai/validation";
import type { AgentLoopConfig, BackgroundToolCallContext } from "./loop-config.ts";
import { sanitizeToolFailureEvidence } from "./tool-failure-memory.ts";
import type { AgentTool, AgentToolCall, ToolCallBackgroundForms } from "./types.ts";

/**
 * A call's forms: the arguments it runs with in the foreground and, for a call that can start as a background task, the
 * arguments it runs with as one and why (the tool's reason when its caller did not ask).
 */
export interface ToolCallForm {
	readonly arguments: Record<string, any>;
	readonly background?: { readonly arguments: Record<string, any>; readonly reason?: string };
}

/** Whether the host can hand a call off to a background task now: it hands calls off and says it can. */
export function canHandOffToolCalls(config: AgentLoopConfig): boolean {
	return config.backgroundHandoff?.canHandOff() === true;
}

/** The tool's compatibility shim on the raw arguments, before schema validation. */
export function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) return toolCall;
	const prepared = tool.prepareArguments(toolCall.arguments);
	return prepared === toolCall.arguments ? toolCall : { ...toolCall, arguments: prepared as Record<string, any> };
}

export interface ToolArgumentFailure {
	message: string;
	toolName: string;
	signature: string;
	enrichment: string | (() => string);
}

export function readToolArgumentValidationError(error: unknown): ToolArgumentFailure | undefined {
	if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
	try {
		if (Reflect.get(error, "name") !== "ToolArgumentValidationError") return undefined;
		const message = Reflect.get(error, "message");
		const toolName = Reflect.get(error, "toolName");
		const signature = Reflect.get(error, "signature");
		const local = error instanceof ToolArgumentValidationError;
		const enrichment = local ? () => error.enrichment : Reflect.get(error, "enrichment");
		if (typeof message !== "string" || message.length === 0) return undefined;
		if (typeof toolName !== "string" || typeof signature !== "string" || (!local && typeof enrichment !== "string")) {
			return undefined;
		}
		return { message, toolName, signature, enrichment };
	} catch {
		return undefined;
	}
}

export function materializeToolValidationFeedback(enrichment: ToolArgumentFailure["enrichment"]): string | undefined {
	try {
		const text = typeof enrichment === "function" ? enrichment() : enrichment;
		return typeof text === "string" ? text : undefined;
	} catch {
		// A guidance failure cannot replace the original refused-call diagnostic.
		return undefined;
	}
}

export function validationFailureCorrection(
	tool: AgentTool<any>,
	args: unknown,
	event: ToolArgumentValidationTelemetryEvent | undefined,
): string {
	try {
		const correction = sanitizeToolFailureEvidence(tool.failureRecovery?.getValidationCorrection?.(args));
		if (correction) return correction;
	} catch {
		// An extension's guidance can fail. The schema diagnostic still describes the refused call.
	}
	const shape = event?.failureShape
		?.slice(0, 3)
		.map((entry) =>
			// A constraint failure on a well-typed value is only actionable with the constraint itself;
			// "expected string, received string" is what a length cap used to print.
			entry.constraint
				? `${entry.path}: ${entry.keyword ?? "constraint"} ${entry.constraint}`
				: `${entry.path}: expected ${entry.expectedType}, received ${entry.receivedType}`,
		)
		.join("; ");
	const rules = [
		...new Set(
			(event?.failureModes ?? [])
				.filter((mode) => mode !== "other")
				.map((mode) => formatToolRepairStandingRule(mode)),
		),
	];
	return [`Match ${tool.name} arguments to its current schema.`, shape ? `Fix ${shape}.` : undefined, ...rules]
		.filter((part): part is string => part !== undefined)
		.join(" ");
}

/** A call's forms, read from its validated arguments; both are schema-valid, so neither is re-validated. */
export function toolCallForm(tool: AgentTool<any>, args: Record<string, any>): ToolCallForm {
	const forms = tool.backgroundArguments?.(args) as ToolCallBackgroundForms<Record<string, any>> | undefined;
	if (forms === undefined) return { arguments: args };
	const reason = forms.reason === undefined ? {} : { reason: forms.reason };
	return { arguments: forms.foreground, background: { arguments: forms.background, ...reason } };
}

/**
 * A prepared call across its handoff, the one place its form is decided. A call with a background form starts its body
 * only once the handoff is decided: handed off, it runs in its background form; refused, or no longer possible, it runs
 * in its foreground form, so a background form never runs in the foreground. Any other call starts at once.
 */
export interface ToolCallHandoff {
	/** Whether the host can hand this call off at all: it can now, and something would move the call. */
	readonly canHandOff: boolean;
	/** The arguments the call runs with if it is handed off. */
	readonly handoffArguments: Record<string, any>;
	/** The arguments the body runs with, once it may start. */
	readonly decided: Promise<Record<string, any>>;
	/**
	 * Arms the clock that moves the call, if any: at once for a call with a background form, whose body is held until its
	 * handoff is decided, so no timer stands between the call and its start (an unreferenced one would let the process
	 * exit with the call never started); else the operator's delay, an unreferenced timer beside a body already running.
	 */
	armClock(): { readonly reached: Promise<{ kind: "deadline" }>; disarm(): void } | undefined;
	/** What moves the call if it is handed off now: the host by hand, the model's request, the tool, or the clock. */
	trigger(manual: boolean): Pick<BackgroundToolCallContext, "trigger" | "reason">;
	/** The handoff was accepted: the body starts in the background form. */
	handedOff(): void;
	/** The call stays in the foreground: the body starts in its foreground form. Returns `completion`. */
	inForeground<T>(completion: T): T;
}

export function toolCallHandoff(form: ToolCallForm, config: AgentLoopConfig): ToolCallHandoff {
	const background = form.background;
	const delayMs = background !== undefined ? undefined : backgroundToolCallDelay(config);
	let start: (args: Record<string, any>) => void = () => {};
	const decided = new Promise<Record<string, any>>((resolve) => {
		start = resolve;
	});
	if (background === undefined) start(form.arguments);
	return {
		canHandOff:
			canHandOffToolCalls(config) &&
			(background !== undefined || delayMs !== undefined || config.subscribeToolCallHandoffRequest !== undefined),
		handoffArguments: background?.arguments ?? form.arguments,
		decided,
		armClock() {
			if (background !== undefined) return { reached: Promise.resolve({ kind: "deadline" }), disarm() {} };
			if (delayMs === undefined) return undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const reached = new Promise<{ kind: "deadline" }>((resolve) => {
				timer = setTimeout(() => resolve({ kind: "deadline" }), delayMs);
				(timer as { unref?: () => void }).unref?.();
			});
			return { reached, disarm: () => clearTimeout(timer) };
		},
		trigger(manual) {
			if (manual) return { trigger: "manual" };
			if (background === undefined) return { trigger: "clock" };
			return background.reason === undefined
				? { trigger: "requested" }
				: { trigger: "tool", reason: background.reason };
		},
		handedOff: () => start(background?.arguments ?? form.arguments),
		inForeground(completion) {
			start(form.arguments);
			return completion;
		},
	};
}

/** The operator's clock: a positive `backgroundToolCallAfterMs` moves a foreground call running longer; unset is off. */
function backgroundToolCallDelay(config: AgentLoopConfig): number | undefined {
	const delay = config.backgroundToolCallAfterMs;
	if (delay === undefined || !Number.isFinite(delay) || delay <= 0) return undefined;
	return delay;
}

/**
 * The forms of a call whose own `background: true` asks for a background task: that call as it is, and the call without
 * `background` for the foreground. A call that does not ask has none.
 */
export function requestedBackgroundForms<T extends { background?: boolean }>(
	args: T,
): { background: T; foreground: T } | undefined {
	if (args?.background !== true) return undefined;
	const { background: _requested, ...foreground } = args;
	return { background: args, foreground: foreground as T };
}
