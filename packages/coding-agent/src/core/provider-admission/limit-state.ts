import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { classifyFailure } from "@caupulican/pi-agent-core/reliability";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { describeProviderAccountKey, splitProviderAccountKey } from "./account-key.ts";
import { providerAdmissionDir } from "./ledger.ts";

/**
 * Machine-wide "this provider is limited until T" state, shared by every pi process on the agent
 * directory. The first process to receive a 429, an overload, or an exhausted subscription window
 * records the reset time; every other process consults it BEFORE sending, so a limit observed once
 * is not rediscovered by every worker and every retry ladder on the box.
 *
 * Why: a provider request that is going to be refused still counts against the account's request
 * budget, and each retry ladder retries it several times. Measured 2026-09-11 on the owner's box,
 * eight requests to one account were in flight at once with no process aware of the others.
 * A record always carries a reset the provider stated or a retry policy chose; nothing here
 * invents a cooldown. A successful response clears a rate-limit or overload record (the provider
 * is serving again); a usage-window record is refreshed by the provider's own window snapshots.
 */

export type ProviderLimitReason = "rate_limit" | "overloaded" | "usage_window";

export interface ProviderLimitRecord {
	/** The provider account key this limit applies to (`<provider>` or `<provider>#<identity>`). */
	provider: string;
	limitedUntil: number;
	reason: ProviderLimitReason;
	recordedAt: number;
	pid: number;
	sessionId?: string;
	detail?: string;
}

/** One provider's most recent subscription window snapshots, as the provider reported them. */
export interface ProviderUsageRecord {
	provider: string;
	at: number;
	pid: number;
	rateLimits: unknown[];
}

export interface ProviderLimitStoreOptions {
	now?: () => number;
	pid?: number;
	sessionId?: string;
}

/** A subscription window counts as exhausted only when fully used. */
export const USAGE_WINDOW_EXHAUSTED_PERCENT = 100;
const MAX_DETAIL_LENGTH = 500;

function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "provider";
}

function isLimitRecord(value: unknown): value is ProviderLimitRecord {
	return (
		isPlainRecord(value) &&
		typeof value.provider === "string" &&
		typeof value.limitedUntil === "number" &&
		Number.isFinite(value.limitedUntil) &&
		(value.reason === "rate_limit" || value.reason === "overloaded" || value.reason === "usage_window") &&
		typeof value.recordedAt === "number" &&
		Number.isSafeInteger(value.pid)
	);
}

function isUsageRecord(value: unknown): value is ProviderUsageRecord {
	return (
		isPlainRecord(value) &&
		typeof value.provider === "string" &&
		typeof value.at === "number" &&
		Number.isSafeInteger(value.pid) &&
		Array.isArray(value.rateLimits)
	);
}

export { splitProviderAccountKey };

/**
 * Thrown instead of sending when a provider is limited for longer than the lane may wait. The
 * message is shaped for the reliability classifier: it names the rate limit and carries the
 * remaining delay as "retry after N seconds", so the owner's retry controller and a worker's retry
 * ladder both sleep until the recorded reset with no request sent.
 */
export class ProviderLimitedError extends Error {
	readonly failureCode = "rate_limit" as const;
	readonly retryAfterMs: number;
	readonly record: ProviderLimitRecord;

	constructor(record: ProviderLimitRecord, nowMs: number) {
		const retryAfterMs = Math.max(0, record.limitedUntil - nowMs);
		const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
		super(
			`Provider ${describeProviderAccountKey(record.provider)} is rate-limited machine-wide until ${new Date(record.limitedUntil).toISOString()} ` +
				`(${record.reason.replace("_", " ")} recorded by pid ${record.pid}` +
				`${record.detail ? `: ${record.detail}` : ""}); retry after ${seconds} seconds.`,
		);
		this.name = "ProviderLimitedError";
		this.retryAfterMs = retryAfterMs;
		this.record = record;
	}
}

export class ProviderLimitStore {
	private readonly limitsDir: string;
	private readonly usageDir: string;
	private readonly now: () => number;
	private readonly pid: number;
	private readonly sessionId: string | undefined;

	constructor(agentDir: string, options: ProviderLimitStoreOptions = {}) {
		this.limitsDir = join(providerAdmissionDir(agentDir), "limits");
		this.usageDir = join(providerAdmissionDir(agentDir), "usage");
		this.now = options.now ?? Date.now;
		this.pid = options.pid ?? process.pid;
		this.sessionId = options.sessionId;
	}

	private limitPath(provider: string): string {
		return join(this.limitsDir, `${safeSegment(provider)}.json`);
	}

	private usagePath(provider: string): string {
		return join(this.usageDir, `${safeSegment(provider)}.json`);
	}

	/**
	 * Record a limit. A later reset time replaces an earlier one; an earlier reset time never
	 * shortens a live record, because the longer window is the one the provider will enforce.
	 */
	record(
		provider: string,
		input: { limitedUntil: number; reason: ProviderLimitReason; detail?: string },
	): ProviderLimitRecord {
		const nowMs = this.now();
		const existing = this.read(provider);
		if (existing && existing.limitedUntil >= input.limitedUntil) return existing;
		const record: ProviderLimitRecord = {
			provider,
			limitedUntil: input.limitedUntil,
			reason: input.reason,
			recordedAt: nowMs,
			pid: this.pid,
			...(this.sessionId ? { sessionId: this.sessionId } : {}),
			...(input.detail ? { detail: input.detail.slice(0, MAX_DETAIL_LENGTH) } : {}),
		};
		mkdirSync(this.limitsDir, { recursive: true });
		writeFileAtomicSync(this.limitPath(provider), `${JSON.stringify(record)}\n`, { mode: 0o600 });
		return record;
	}

	/** The live limit for `provider`, or undefined (an expired record is removed on read). */
	read(provider: string): ProviderLimitRecord | undefined {
		return this.readPath(this.limitPath(provider));
	}

	private readPath(path: string): ProviderLimitRecord | undefined {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		} catch (error) {
			if (!isMissingFileError(error)) rmSync(path, { force: true });
			return undefined;
		}
		if (!isLimitRecord(parsed) || parsed.limitedUntil <= this.now()) {
			rmSync(path, { force: true });
			return undefined;
		}
		return parsed;
	}

	/** Forget a live limit whose reason is one of `reasons` (all reasons when omitted). */
	clear(provider: string, reasons?: readonly ProviderLimitReason[]): boolean {
		const existing = this.read(provider);
		if (!existing) return false;
		if (reasons && !reasons.includes(existing.reason)) return false;
		rmSync(this.limitPath(provider), { force: true });
		return true;
	}

	list(): ProviderLimitRecord[] {
		if (!existsSync(this.limitsDir)) return [];
		const records: ProviderLimitRecord[] = [];
		for (const name of readdirSync(this.limitsDir)) {
			if (!name.endsWith(".json")) continue;
			const record = this.readPath(join(this.limitsDir, name));
			if (record) records.push(record);
		}
		return records.sort((a, b) => a.provider.localeCompare(b.provider));
	}

	recordUsage(provider: string, rateLimits: unknown[]): ProviderUsageRecord {
		const record: ProviderUsageRecord = { provider, at: this.now(), pid: this.pid, rateLimits };
		mkdirSync(this.usageDir, { recursive: true });
		writeFileAtomicSync(this.usagePath(provider), `${JSON.stringify(record)}\n`, { mode: 0o600 });
		return record;
	}

	readUsage(provider: string): ProviderUsageRecord | undefined {
		try {
			const parsed = JSON.parse(readFileSync(this.usagePath(provider), "utf-8")) as unknown;
			return isUsageRecord(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	listUsage(): ProviderUsageRecord[] {
		if (!existsSync(this.usageDir)) return [];
		const records: ProviderUsageRecord[] = [];
		for (const name of readdirSync(this.usageDir)) {
			if (!name.endsWith(".json")) continue;
			try {
				const parsed = JSON.parse(readFileSync(join(this.usageDir, name), "utf-8")) as unknown;
				if (isUsageRecord(parsed)) records.push(parsed);
			} catch {
				// A half-written usage file is not evidence.
			}
		}
		return records.sort((a, b) => a.provider.localeCompare(b.provider));
	}
}

/**
 * A provider limit implied by a failed response. Only a rate limit or overload qualifies, and only
 * when a reset is known: the provider stated one in the message, or the caller supplies the delay
 * its own retry policy chose (`delayMs`). A bare 429 with neither publishes nothing: inventing a
 * cooldown here once made the owner's turn sleep a minute after one overload the retry controller
 * would have retried in two seconds.
 */
export function providerLimitFromFailure(
	provider: string,
	errorMessage: string,
	nowMs: number,
	delayMs?: number,
): { limitedUntil: number; reason: ProviderLimitReason; detail: string } | undefined {
	const classified = classifyFailure({ message: errorMessage, provider });
	if (classified.reason !== "rate_limit" && classified.reason !== "overloaded") return undefined;
	const waitMs = delayMs ?? classified.retryAfterMs;
	if (waitMs === undefined) return undefined;
	return {
		limitedUntil: nowMs + waitMs,
		reason: classified.reason,
		detail: errorMessage.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL_LENGTH),
	};
}

interface UsageWindowLike {
	usedPercent?: unknown;
	resetsAt?: unknown;
	resetAfterSeconds?: unknown;
}

/**
 * The reset time of the first fully used subscription window in a provider's snapshots
 * (the Codex `x-codex-*-used-percent` / `-reset-at` family: `resetsAt` is epoch seconds), or
 * undefined when no window is exhausted or no window states when it resets.
 */
export function usageWindowLimit(
	rateLimits: readonly unknown[],
	nowMs: number,
): { limitedUntil: number; detail: string } | undefined {
	for (const snapshot of rateLimits) {
		if (!isPlainRecord(snapshot)) continue;
		for (const key of ["primary", "secondary"] as const) {
			const window = snapshot[key] as UsageWindowLike | undefined;
			if (!isPlainRecord(window)) continue;
			const used = window.usedPercent;
			if (typeof used !== "number" || used < USAGE_WINDOW_EXHAUSTED_PERCENT) continue;
			const resetsAt = typeof window.resetsAt === "number" ? window.resetsAt * 1000 : undefined;
			const resetAfter =
				typeof window.resetAfterSeconds === "number" ? nowMs + window.resetAfterSeconds * 1000 : undefined;
			const limitedUntil = resetsAt ?? resetAfter;
			if (limitedUntil === undefined || limitedUntil <= nowMs) continue;
			const name =
				typeof snapshot.limitName === "string" ? snapshot.limitName : String(snapshot.limitId ?? "window");
			return { limitedUntil, detail: `${name} ${key} window ${used}% used` };
		}
	}
	return undefined;
}

/**
 * Fold one settled assistant message into the shared state: a rate limit or overload records a
 * limit, a success clears those two, and Codex subscription window snapshots are persisted and
 * turn into a usage-window limit when a window is fully used.
 */
export function observeProviderResult(
	store: ProviderLimitStore,
	message: AssistantMessage,
	nowMs: number,
	key: string = message.provider,
): void {
	const provider = key;
	if (message.stopReason === "error") {
		const limit = providerLimitFromFailure(message.provider, message.errorMessage ?? "", nowMs);
		if (limit) store.record(provider, limit);
	} else if (message.stopReason !== "aborted") {
		store.clear(provider, ["rate_limit", "overloaded"]);
	}
	for (const diagnostic of message.diagnostics ?? []) {
		if (diagnostic.type !== "openai_codex_subscription_rate_limits") continue;
		const rateLimits = diagnostic.details?.rateLimits;
		if (!Array.isArray(rateLimits)) continue;
		store.recordUsage(provider, rateLimits);
		const exhausted = usageWindowLimit(rateLimits, nowMs);
		if (exhausted) store.record(provider, { ...exhausted, reason: "usage_window" });
	}
}
