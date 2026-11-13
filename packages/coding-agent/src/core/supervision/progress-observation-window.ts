/**
 * The window of recent tool calls a live supervision observation is built from: one record per executed call, the
 * deterministic repetition and stall facts, and the tail of the attempt's own output. A worker attempt and a bot's own
 * session turn both build their observations here, so the supervisor judges the same evidence whichever loop ran the
 * calls.
 */
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "../../kernel/index.ts";
import type { WorkerProgressObservation } from "./worker-supervision-coordinator.ts";

const RECENT_SUPERVISION_TOOL_WINDOW = 8;
const CONSECUTIVE_TOOL_FAILURE_THRESHOLD = 3;
const OUTPUT_TAIL_CHARS = 2000;

/** Distinct arguments to the same tool are progress, especially during read-only review. */
export function isRepeatedWorkerToolInvocation(calls: readonly { name: string; args: unknown }[]): boolean {
	if (calls.length < 3) return false;
	const recent = calls.slice(-3);
	return recent.every((call) => call.name === recent[0]!.name && isDeepStrictEqual(call.args, recent[0]!.args));
}

/** The last words of the newest assistant message that has any, bounded: what the observed loop said it is doing. */
export function assistantOutputTail(messages: readonly AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant" || !("content" in message) || !Array.isArray(message.content)) continue;
		const text = message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("");
		if (text) return text.slice(-OUTPUT_TAIL_CHARS);
	}
	return "";
}

/** The facts of one observation that come from the window rather than from the attempt's identity. */
export type ProgressWindowFacts = Pick<
	WorkerProgressObservation,
	| "toolCalls"
	| "changedFiles"
	| "recentFailures"
	| "recentToolNames"
	| "recentToolCalls"
	| "changedFileCountAtWindowStart"
	| "changedFileCount"
	| "isRepeating"
	| "isStalled"
>;

export class ProgressObservationWindow {
	private readonly recentToolNames: string[] = [];
	private readonly recentToolCalls: { name: string; args: unknown }[] = [];
	private readonly recentToolOutcomes: { name: string; failed: boolean }[] = [];
	private executed = 0;
	private changedAtWindowStart: number;

	/** `changedFileCount`: the files the attempt had changed when the window opened. */
	constructor(changedFileCount: number) {
		this.changedAtWindowStart = changedFileCount;
	}

	/**
	 * Records one executed call and returns the window's facts after it, given the attempt's changed files and its
	 * standing issues. A grown change set opens the next churn window.
	 */
	record(
		call: { name: string; args: unknown; isError: boolean },
		changedFiles: ReadonlySet<string>,
		issues: ReadonlySet<string>,
	): ProgressWindowFacts {
		this.executed++;
		this.recentToolNames.push(call.name);
		if (this.recentToolNames.length > RECENT_SUPERVISION_TOOL_WINDOW) this.recentToolNames.shift();
		this.recentToolCalls.push({ name: call.name, args: call.args });
		if (this.recentToolCalls.length > 3) this.recentToolCalls.shift();
		this.recentToolOutcomes.push({ name: call.name, failed: call.isError });
		if (this.recentToolOutcomes.length > RECENT_SUPERVISION_TOOL_WINDOW) this.recentToolOutcomes.shift();
		const isRepeating = isRepeatedWorkerToolInvocation(this.recentToolCalls);
		const consecutiveToolFailures =
			this.recentToolOutcomes.length >= CONSECUTIVE_TOOL_FAILURE_THRESHOLD &&
			this.recentToolOutcomes.slice(-CONSECUTIVE_TOOL_FAILURE_THRESHOLD).every((outcome) => outcome.failed);
		const facts: ProgressWindowFacts = {
			toolCalls: this.executed,
			changedFiles: [...changedFiles],
			recentFailures: [
				...issues,
				...this.recentToolOutcomes.flatMap((outcome) => (outcome.failed ? [`${outcome.name} failed`] : [])),
			],
			recentToolNames: [...this.recentToolNames],
			recentToolCalls: [...this.recentToolCalls],
			changedFileCountAtWindowStart: this.changedAtWindowStart,
			changedFileCount: changedFiles.size,
			isRepeating,
			isStalled:
				changedFiles.size === 0 &&
				this.executed >= 4 &&
				(isRepeating || consecutiveToolFailures || issues.size > 0),
		};
		if (changedFiles.size > this.changedAtWindowStart) this.changedAtWindowStart = changedFiles.size;
		return facts;
	}
}
