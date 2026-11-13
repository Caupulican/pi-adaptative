/**
 * Names for bots. An id is the stable handle (`trello-scout`: what is typed after `@` and `/bot msg`); the display name is
 * what the screen shows (`Trello Scout`). A bot made on the fly without an id is named from its purpose, so the creator never
 * invents one, and a name already taken gets a number.
 */

import { isGeneratedWorkerLaneId } from "./worker-lane-id.ts";

const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"bot",
	"by",
	"for",
	"from",
	"has",
	"have",
	"in",
	"is",
	"it",
	"its",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"with",
	"you",
	"your",
	"will",
	"should",
	"must",
	"never",
	"always",
	"only",
]);
const MAX_ID_CHARS = 28;
const MAX_WORDS = 3;
/** The id of a bot with nothing to name it by, numbered: `helper`, `helper-2`. */
const FALLBACK_ID = "helper";

function words(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.split(" ")
		.filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/** An id for a bot from its purpose (its description or soul), unique among `taken` and never a delegate worker's id (`worker-<n>`). */
export function suggestBotId(purpose: string | undefined, taken: ReadonlySet<string>): string {
	const base =
		words(purpose ?? "")
			.slice(0, MAX_WORDS)
			.join("-")
			.slice(0, MAX_ID_CHARS)
			.replace(/-+$/, "") || FALLBACK_ID;
	const available = (id: string) => !taken.has(id) && !isGeneratedWorkerLaneId(id);
	if (available(base)) return base;
	for (let n = 2; n < 1000; n++) {
		const candidate = `${base.slice(0, MAX_ID_CHARS - String(n).length - 1)}-${n}`;
		if (available(candidate)) return candidate;
	}
	return `${base}-${Date.now().toString(36)}`;
}

/** The name the screen shows for an id: its words capitalized (`trello-scout` is `Trello Scout`). */
export function displayNameFor(agentId: string): string {
	return agentId
		.split(/[-_.]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}
