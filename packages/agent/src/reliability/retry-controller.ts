/**
 * Host-agnostic auto-retry driver.
 *
 * Owns the retry attempt counter and the abortable backoff for one agent run. It reads the
 * failure verdict from {@link classifyFailure} (fed a host-computed context-overflow flag), so
 * billing/auth are terminal and overflow routes to compaction — never to a pointless retry.
 * The controller only ever touches `agent.state.messages` (it drops the trailing assistant error
 * before retrying); durable history stays the host session's responsibility.
 *
 * Ported from AgentSession._prepareRetry / _isRetryableError so the exact event ordering and
 * exhaustion semantics carry over: the retry window is marked active (isRetrying) before the
 * start event fires, so prompts arriving inside start handlers queue as steering instead of
 * racing the retry continuation.
 */

import { type AssistantMessage, isContextOverflow } from "@caupulican/pi-ai";
import type { AgentMessage } from "../types.ts";
import { classifyFailure } from "./classifier.ts";
import { computeRetryDelayMs, type RetryPolicy, sleepAbortable } from "./retry.ts";

/** The slice of an Agent the retry driver reads and mutates: just the live transcript. */
export interface RetryAgent {
	readonly state: { messages: AgentMessage[] };
}

export interface RetryStartInfo {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}

export interface RetryEndInfo {
	success: boolean;
	attempt: number;
	finalError?: string;
}

export interface RetryEvents {
	onRetryStart(info: RetryStartInfo): void;
	onRetryEnd(info: RetryEndInfo): void;
}

/** Runtime retry policy: the backoff shape plus the on/off switch the host resolves per call. */
export type RetryControllerPolicy = RetryPolicy & { enabled: boolean };

export class RetryController {
	private _attempt = 0;
	private _abortController: AbortController | undefined;
	private readonly agent: RetryAgent;
	private readonly getPolicy: () => RetryControllerPolicy;
	private readonly events: RetryEvents;
	private readonly getContextWindow: () => number;

	constructor(
		agent: RetryAgent,
		getPolicy: () => RetryControllerPolicy,
		events: RetryEvents,
		getContextWindow: () => number,
	) {
		this.agent = agent;
		this.getPolicy = getPolicy;
		this.events = events;
		this.getContextWindow = getContextWindow;
	}

	/** Completed retry attempts for the current run (0 when not retrying). */
	get attempt(): number {
		return this._attempt;
	}

	/** True from the instant onRetryStart fires until the backoff sleep resolves or is aborted. */
	get isRetrying(): boolean {
		return this._abortController !== undefined;
	}

	/** Clear the attempt counter — the host calls this after a successful turn or a final failure. */
	reset(): void {
		this._attempt = 0;
	}

	/** Cancel an in-progress backoff; the pending prepareRetry resolves false. */
	abort(): void {
		this._abortController?.abort();
	}

	/**
	 * Classify `message`; if it is retryable and attempts remain, drop the trailing assistant
	 * error from agent state, emit the start event, and wait out the backoff (abortable).
	 * @returns true if the caller should continue the agent, false otherwise.
	 */
	async prepareRetry(message: AssistantMessage): Promise<boolean> {
		const policy = this.getPolicy();
		if (!policy.enabled) {
			return false;
		}

		// The classifier is the single source of the retry verdict: context overflow (host-computed
		// from the live window) routes to compaction, billing/auth are terminal, transient failures retry.
		const classified = classifyFailure({
			message: message.errorMessage ?? "",
			contextOverflow: isContextOverflow(message, this.getContextWindow()),
			provider: message.provider,
		});
		if (!classified.retryable) {
			return false;
		}

		this._attempt++;
		if (this._attempt > policy.maxAttempts) {
			// Preserve the completed attempt count so the host can emit the final failure.
			this._attempt--;
			return false;
		}

		const delayMs = computeRetryDelayMs(policy, this._attempt);

		// The retry window counts as active work from the instant listeners hear about it:
		// isRetrying must already be true inside onRetryStart handlers so prompts arriving there
		// queue as steering instead of racing the retry continuation.
		this._abortController = new AbortController();

		this.events.onRetryStart({
			attempt: this._attempt,
			maxAttempts: policy.maxAttempts,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove the trailing assistant error from live agent state (the host session keeps it in history).
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		try {
			await sleepAbortable(delayMs, this._abortController.signal);
		} catch {
			// Aborted mid-backoff: report the cancellation and reset so the next turn starts clean.
			const attempt = this._attempt;
			this._attempt = 0;
			this.events.onRetryEnd({ success: false, attempt, finalError: "Retry cancelled" });
			return false;
		} finally {
			this._abortController = undefined;
		}

		return true;
	}
}
