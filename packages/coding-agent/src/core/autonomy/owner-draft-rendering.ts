/**
 * What a call held on a run opened from an owner channel is bound to, and what the owner reads before approving it.
 * The digest covers the complete call as the edge received it; the rendering is built from the same complete arguments
 * (never from a draft's shortened operation line), with secret-shaped text replaced by an explicit marker and every
 * control, bidirectional or zero-width character shown, so what the owner reads is what runs.
 */

import { OWNER_DRAFT_RENDERING_MAX_CHARS } from "../channels/owner-channel-types.ts";
import { redactKnownSecrets } from "../security/secret-text.ts";
import { canonicalJson, strictCanonicalDigest, withoutUndefinedMembers } from "../steering/canonical.ts";

/** The version prefix of a call digest: a later canonical form gets a new prefix, so no old approval matches it. */
const CALL_DIGEST_VERSION = "v1";

/**
 * SHA-256 over the strict canonical JSON of the complete `{ toolName, arguments }`, undefined members stripped first.
 * `undefined` when the call is not JSON data (a Map, a class instance, an undefined array element, a cycle): no
 * approval can bind such a call, so the caller refuses it instead of holding a draft nothing can admit.
 */
export function ownerCallDigest(toolName: string, args: unknown): string | undefined {
	try {
		return `${CALL_DIGEST_VERSION}:${strictCanonicalDigest(withoutUndefinedMembers({ toolName, arguments: args }))}`;
	} catch (error) {
		// The strict encoder refuses a non-JSON value with a TypeError; any other failure is not a refusal of the call.
		if (error instanceof TypeError) return undefined;
		throw error;
	}
}

const VISIBLE_SYMBOLS: Readonly<Record<string, string>> = { "\n": "\u23ce", "\r": "\u240d", "\t": "\u2409" };
/** Every control, format character (bidirectional marks, zero-width characters), lone surrogate, line and paragraph
 * separator, and variation selector (`Variation_Selector`: U+FE00-FE0F, U+E0100-E01EF and the Mongolian ones). */
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Variation_Selector}]/gu;

function visible(text: string): string {
	return text.replace(
		HIDDEN_CHARACTERS,
		(character) =>
			VISIBLE_SYMBOLS[character] ?? `\\u{${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`,
	);
}

function redactDeep(value: unknown): unknown {
	if (typeof value === "string") return redactKnownSecrets(value);
	if (Array.isArray(value)) return value.map(redactDeep);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[redactKnownSecrets(key)] = redactDeep(item);
		return out;
	}
	return value;
}

function renderValue(value: unknown): string {
	return visible(typeof value === "string" ? redactKnownSecrets(value) : canonicalJson(redactDeep(value)));
}

/**
 * The tool name, then one `key: value` line per argument in canonical (sorted) order; `undefined` when the rendering
 * exceeds `OWNER_DRAFT_RENDERING_MAX_CHARS`, which leaves the call to the owner's terminal.
 */
export function renderOwnerDraftCall(toolName: string, args: unknown): string | undefined {
	const lines = [visible(toolName)];
	if (args && typeof args === "object" && !Array.isArray(args)) {
		const record = args as Record<string, unknown>;
		for (const key of Object.keys(record).sort()) {
			if (record[key] === undefined) continue;
			lines.push(`${visible(redactKnownSecrets(key))}: ${renderValue(record[key])}`);
		}
	} else if (args !== undefined) {
		lines.push(renderValue(args));
	}
	const rendering = lines.join("\n");
	return rendering.length <= OWNER_DRAFT_RENDERING_MAX_CHARS ? rendering : undefined;
}
