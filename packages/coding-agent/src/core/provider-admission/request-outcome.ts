/**
 * How one dispatched provider request settled, in the classes the fleet's adaptive account windows learn from. Every
 * class is a code fact read from the settled message or the thrown failure: the reliability classifier's reason, the
 * HTTP status, and the subscription window diagnostics the providers attach.
 */

import type { AssistantMessage } from "@caupulican/pi-ai";
import { classifyFailure } from "../../kernel/reliability/index.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { providerLimitFromFailure, usageWindowLimit } from "./limit-state.ts";

export type ProviderRequestOutcome =
	/** The request's own signal ended it: says nothing about the account. */
	| { readonly kind: "aborted" }
	/** A subscription usage window is used up: quota, not congestion. */
	| { readonly kind: "usage_window"; readonly resetAt?: number }
	/** A 429, a 529, or a rate-limit or overload refusal. */
	| { readonly kind: "congestion"; readonly resetAt?: number }
	/** A transport failure or a server error that is not an overload. */
	| { readonly kind: "transport" }
	/** Any other failure (authentication, a bad request, a context overflow): not about the account's capacity. */
	| { readonly kind: "other" }
	| { readonly kind: "success" };

/** The window reset an Anthropic subscription diagnostic states when its status is `rejected`, in epoch ms. */
function anthropicRejectedReset(message: AssistantMessage): number | undefined {
	for (const diagnostic of message.diagnostics ?? []) {
		if (diagnostic.type !== "anthropic_subscription_rate_limits" || !isPlainRecord(diagnostic.details)) continue;
		const { status } = diagnostic.details;
		const reset = diagnostic.details.resetsAt ?? diagnostic.details.reset;
		if (status === "rejected" && typeof reset === "number" && Number.isFinite(reset)) return reset * 1000;
	}
	return undefined;
}

function exhaustedCodexWindow(message: AssistantMessage, nowMs: number): number | undefined {
	for (const diagnostic of message.diagnostics ?? []) {
		if (diagnostic.type !== "openai_codex_subscription_rate_limits") continue;
		const rateLimits = diagnostic.details?.rateLimits;
		if (Array.isArray(rateLimits)) {
			const exhausted = usageWindowLimit(rateLimits, nowMs);
			if (exhausted) return exhausted.limitedUntil;
		}
	}
	return undefined;
}

function failureOutcome(provider: string, failure: unknown, nowMs: number): ProviderRequestOutcome {
	const message =
		typeof failure === "string"
			? failure
			: failure instanceof Error
				? failure.message
				: isPlainRecord(failure) && typeof failure.message === "string"
					? failure.message
					: String(failure ?? "");
	const status =
		isPlainRecord(failure) || failure instanceof Error ? (failure as { status?: unknown }).status : undefined;
	const { reason } = classifyFailure({ message, provider });
	if (reason === "aborted") return { kind: "aborted" };
	if (reason === "billing_or_quota") {
		const limit = providerLimitFromFailure(provider, failure, nowMs);
		return limit ? { kind: "usage_window", resetAt: limit.limitedUntil } : { kind: "other" };
	}
	if (reason === "rate_limit" || reason === "overloaded" || status === 429 || status === 529) {
		const limit = providerLimitFromFailure(provider, failure, nowMs);
		return { kind: "congestion", ...(limit ? { resetAt: limit.limitedUntil } : {}) };
	}
	if (reason === "network" || reason === "server_error" || reason === "stream_stall") return { kind: "transport" };
	return { kind: "other" };
}

/** The outcome of a request that ended with a settled assistant message. */
export function messageOutcome(message: AssistantMessage, nowMs: number): ProviderRequestOutcome {
	if (message.stopReason === "aborted") return { kind: "aborted" };
	const rejectedReset = anthropicRejectedReset(message);
	if (rejectedReset !== undefined) return { kind: "usage_window", resetAt: rejectedReset };
	if (message.stopReason === "error") return failureOutcome(message.provider, message.errorMessage ?? "", nowMs);
	const codexReset = exhaustedCodexWindow(message, nowMs);
	return codexReset !== undefined ? { kind: "usage_window", resetAt: codexReset } : { kind: "success" };
}

/** The outcome of a request whose stream failed before a settled message. */
export function thrownOutcome(
	provider: string,
	failure: unknown,
	nowMs: number,
	signal?: AbortSignal,
): ProviderRequestOutcome {
	return signal?.aborted ? { kind: "aborted" } : failureOutcome(provider, failure, nowMs);
}
