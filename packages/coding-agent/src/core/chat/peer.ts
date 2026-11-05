import { MAX_PEER_FIELD_CHARS } from "./constants.ts";
import type { PeerRecord } from "./state.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Peer identity text reaches prompts and the UI, so it is bounded and carries no control or line-break characters. */
export function isPeerText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_PEER_FIELD_CHARS &&
		!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
	);
}

export function isPeerRecord(value: unknown): value is PeerRecord {
	return (
		isRecord(value) &&
		isPeerText(value.id) &&
		isPeerText(value.name) &&
		isPeerText(value.address) &&
		(value.scope === "local" || value.scope === "network" || value.scope === "relay") &&
		(value.busy === undefined || typeof value.busy === "boolean") &&
		(value.verified === undefined || typeof value.verified === "boolean") &&
		(value.lastSeen === undefined || isPeerText(value.lastSeen))
	);
}
