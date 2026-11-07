/**
 * The owner's admission policy per registered channel (`channels.<name>`). It is read only from the settings layers the
 * owner writes under the agent directory (directory profile, then global); a repository's own settings never name who
 * may start a turn in the owner's session. A channel with no policy, or with one that does not parse, is not started.
 */

import { isAbsolute } from "node:path";
import { type EdgeClass, isEdgeClass } from "../autonomy/edge-policy.ts";
import { isPlainRecord } from "../util/value-guards.ts";

/** The usage percent at which a subscription counts as out of allowance unless a setting says otherwise; the cost guard applies the same rule. */
export const DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT = 95;

export const MAX_ALLOWED_SENDERS = 50;
export const MAX_CHANNEL_BATCH = 25;
const MAX_SENDER_ID_CHARS = 256;
const MAX_AWAY_CWD_CHARS = 4096;
export const MAX_OWNER_SENDERS = 10;
/**
 * The channels whose shipped transport can prove an owner's identity and a private chat, with the shape of the
 * platform-assigned id each lists: a Telegram user number, a Slack user id.
 */
const OWNER_SENDER_ID: Readonly<Record<string, RegExp>> = {
	telegram: /^[1-9][0-9]{0,15}$/,
	slack: /^[UW][A-Z0-9]{2,30}$/,
};

export function isOwnerChannelName(name: string): boolean {
	return Object.hasOwn(OWNER_SENDER_ID, name);
}

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
	/**
	 * The working directory the daemon serves the channel in while no session is open (`away-channels.ts`). The daemon
	 * honors it only from the global layer; an open session ignores it.
	 */
	readonly awayCwd?: string;
	/**
	 * Platform-assigned ids of the owner's own accounts (`owner-channel.ts`): a verified message from one of them in a
	 * private chat of a shipped Telegram or Slack transport is the owner's words. Empty: no owner authority.
	 */
	readonly ownerSenders: readonly string[];
	/** The owner pool's spend over a rolling 24 hours; 0 starts no owner turn (control words still answer). */
	readonly ownerMaxUsdPerDay: number;
	/** One owner turn's spend; the turn is stopped once a message takes it there, and an offer reserves it. */
	readonly ownerMaxUsdPerTurn: number;
	/**
	 * While the session's model is a subscription login whose account usage reports every window below this percent, the
	 * two dollar bounds above do not apply (`ownerMaxUsdPerDay: 0` still starts none). 0: the dollar bounds always apply.
	 */
	readonly ownerQuotaMaxUsedPercent: number;
	/** Updates pushed to the owner's chat per rolling hour; past it one line says how many more wait. */
	readonly ownerPushPerHour: number;
	/** Classes of held action the owner releases only at the terminal, never by `approve` from the phone. */
	readonly ownerTerminalOnlyClasses: readonly EdgeClass[];
	/**
	 * `ownerAuthority: "full"`: a verified owner turn runs with the owner's own authority (the session's grants, the
	 * terminal's classification and mode) instead of the guarded remote-owner gate. Present only when set to "full".
	 */
	readonly ownerFullAuthority?: true;
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

function numberIn(value: unknown, fallback: number, min: number, max: number, key: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
		throw new Error(`${key} must be a number from ${min} to ${max}`);
	return value;
}

/** The owner's ids: platform-assigned, of the channel's shape, at most `MAX_OWNER_SENDERS`, each once. */
function parseOwnerSenders(name: string, value: unknown, key: string): string[] {
	if (value === undefined) return [];
	// A number past the safe integers was already rounded when the settings were read: it fails the id shape below.
	const listed = Array.isArray(value)
		? value.map((id: unknown) =>
				typeof id === "number" ? (Number.isSafeInteger(id) && id > 0 ? String(id) : "") : id,
			)
		: value;
	if (!Array.isArray(listed) || listed.length > MAX_OWNER_SENDERS || listed.some((id) => typeof id !== "string"))
		throw new Error(`${key}.ownerSenders must list at most ${MAX_OWNER_SENDERS} sender ids`);
	if (listed.length === 0) return [];
	const shape = OWNER_SENDER_ID[name];
	if (!shape)
		throw new Error(
			`${key}.ownerSenders is only read on the telegram and slack channels, whose shipped transports verify the sender and a private chat`,
		);
	const ids = listed as string[];
	if (ids.some((id) => !shape.test(id)))
		throw new Error(
			`${key}.ownerSenders must list ${name === "telegram" ? "Telegram user numbers" : "Slack user ids (U or W, then capitals and digits)"}`,
		);
	if (new Set(ids).size !== ids.length) throw new Error(`${key}.ownerSenders lists a sender twice`);
	return ids;
}

function parseTerminalOnlyClasses(value: unknown, key: string): EdgeClass[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every(isEdgeClass))
		throw new Error(`${key}.ownerTerminalOnlyClasses must list edge class names`);
	return [...new Set(value)];
}

/** `ownerAuthority`: "guarded" (the default) or "full"; "full" only on the channels that can carry owner authority. */
function parseOwnerFullAuthority(name: string, value: unknown, key: string): boolean {
	if (value === undefined || value === "guarded") return false;
	if (value !== "full") throw new Error(`${key}.ownerAuthority must be "guarded" or "full"`);
	if (!isOwnerChannelName(name))
		throw new Error(`${key}.ownerAuthority "full" is only read on the telegram and slack channels`);
	return true;
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
	const awayCwd = value.awayCwd;
	if (
		awayCwd !== undefined &&
		(typeof awayCwd !== "string" || !isAbsolute(awayCwd) || awayCwd.length > MAX_AWAY_CWD_CHARS)
	)
		throw new Error(`${key}.awayCwd must be an absolute path`);
	const ownerFullAuthority = parseOwnerFullAuthority(name, value.ownerAuthority, key);
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
		...(awayCwd === undefined ? {} : { awayCwd }),
		ownerSenders: parseOwnerSenders(name, value.ownerSenders, key),
		ownerMaxUsdPerDay: numberIn(value.ownerMaxUsdPerDay, 5, 0, 100, `${key}.ownerMaxUsdPerDay`),
		ownerMaxUsdPerTurn: numberIn(value.ownerMaxUsdPerTurn, 1, 0.05, 20, `${key}.ownerMaxUsdPerTurn`),
		ownerQuotaMaxUsedPercent: numberIn(
			value.ownerQuotaMaxUsedPercent,
			DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT,
			0,
			100,
			`${key}.ownerQuotaMaxUsedPercent`,
		),
		ownerPushPerHour: integerIn(value.ownerPushPerHour, 12, 0, 60, `${key}.ownerPushPerHour`),
		ownerTerminalOnlyClasses: parseTerminalOnlyClasses(value.ownerTerminalOnlyClasses, key),
		...(ownerFullAuthority ? { ownerFullAuthority: true as const } : {}),
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
