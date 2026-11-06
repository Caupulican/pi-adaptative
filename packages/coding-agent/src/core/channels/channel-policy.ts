/**
 * The owner's admission policy per registered channel (`channels.<name>`). It is read only from the settings layers the
 * owner writes under the agent directory (directory profile, then global); a repository's own settings never name who
 * may start a turn in the owner's session. A channel with no policy, or with one that does not parse, is not started.
 */

import { isPlainRecord } from "../util/value-guards.ts";

export const MAX_ALLOWED_SENDERS = 50;
export const MAX_CHANNEL_BATCH = 25;
const MAX_SENDER_ID_CHARS = 256;

/** A channel name the harness admits: it becomes the turn origin's channel, so it is short, plain and never `pi-chat`. */
const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESERVED_CHANNEL_NAMES = new Set(["pi-chat"]);

export function isValidChannelName(name: string): boolean {
	return CHANNEL_NAME_PATTERN.test(name) && !RESERVED_CHANNEL_NAMES.has(name);
}

export type ChannelReplyMode = "draft" | "auto";

export interface ResolvedChannelPolicy {
	readonly mode: "ignore" | "explicit";
	readonly allowedSenders: readonly string[];
	readonly maxWakesPerDay: number;
	readonly maxUsdPerDay: number;
	readonly maxBatch: number;
	readonly maxPendingPerConversation: number;
	readonly replyMode: ChannelReplyMode;
}

/** A channel's policy as read: usable, or present but unreadable (which starts nothing). */
export type ChannelPolicyResolution =
	| { readonly kind: "policy"; readonly policy: ResolvedChannelPolicy }
	| { readonly kind: "invalid"; readonly reason: string };

function integerIn(value: unknown, fallback: number, min: number, max: number, key: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
		throw new Error(`${key} must be an integer from ${min} to ${max}`);
	return value;
}

function parsePolicy(name: string, value: unknown): ResolvedChannelPolicy {
	const key = `channels.${name}`;
	if (!isPlainRecord(value)) throw new Error(`${key} must be an object`);
	const mode = value.mode ?? "ignore";
	if (mode !== "ignore" && mode !== "explicit") throw new Error(`${key}.mode must be "ignore" or "explicit"`);
	const replyMode = value.replyMode ?? "draft";
	if (replyMode !== "draft" && replyMode !== "auto") throw new Error(`${key}.replyMode must be "draft" or "auto"`);
	const listed = value.allowedSenders ?? [];
	// A numeric id (a Telegram user id) may be written unquoted; it is compared as the provider's string id.
	const senders = Array.isArray(listed)
		? listed.map((id: unknown) => (typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? String(id) : id))
		: listed;
	if (
		!Array.isArray(senders) ||
		senders.length > MAX_ALLOWED_SENDERS ||
		senders.some((id) => typeof id !== "string" || id.length === 0 || id.length > MAX_SENDER_ID_CHARS)
	)
		throw new Error(
			`${key}.allowedSenders must list at most ${MAX_ALLOWED_SENDERS} sender ids (strings or whole numbers)`,
		);
	const maxUsdPerDay = value.maxUsdPerDay ?? 0.5;
	if (typeof maxUsdPerDay !== "number" || !Number.isFinite(maxUsdPerDay) || maxUsdPerDay < 0 || maxUsdPerDay > 100)
		throw new Error(`${key}.maxUsdPerDay must be a number from 0 to 100`);
	return {
		mode,
		allowedSenders: [...new Set(senders as string[])],
		maxWakesPerDay: integerIn(value.maxWakesPerDay, 10, 0, 200, `${key}.maxWakesPerDay`),
		maxUsdPerDay,
		maxBatch: integerIn(value.maxBatch, 10, 1, MAX_CHANNEL_BATCH, `${key}.maxBatch`),
		maxPendingPerConversation: integerIn(
			value.maxPendingPerConversation,
			25,
			1,
			100,
			`${key}.maxPendingPerConversation`,
		),
		replyMode,
	};
}

/**
 * Policies from the owner-written layers, highest precedence first: the first layer naming a channel decides it whole
 * (no field merging across layers, so a profile's narrower allowlist is never widened by the global one). A layer whose
 * `channels` is not an object leaves every channel without a policy.
 */
export function resolveChannelPolicies(layers: readonly unknown[]): ReadonlyMap<string, ChannelPolicyResolution> {
	const resolved = new Map<string, ChannelPolicyResolution>();
	if (layers.some((layer) => layer !== undefined && !isPlainRecord(layer))) return resolved;
	for (const layer of layers) {
		if (!isPlainRecord(layer)) continue;
		for (const [name, value] of Object.entries(layer)) {
			if (resolved.has(name)) continue;
			try {
				resolved.set(name, { kind: "policy", policy: parsePolicy(name, value) });
			} catch (error) {
				resolved.set(name, { kind: "invalid", reason: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	return resolved;
}
