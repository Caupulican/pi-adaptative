/**
 * Sealed directives: the few standing rules the owner wants every agent in every role to hold, for any kind of work,
 * stated once here and written into the front of every provider request's system prompt at the one place agent
 * requests are composed (`materializeContextPlan` in `provider-request-planner.ts`), and at the few other places a request
 * is built outside the planner (the compaction summarizer through `Agent.requestSystemPrompt`, the local prefix warmer,
 * and request-context completions). Nothing above that point can remove or reword them: a custom system prompt,
 * an appended prompt, a project or global context file, the owner's session prompt editor, an extension that
 * rewrites the prompt, a worker or bot profile, a channel session and a persisted prompt all pass through it.
 * A prompt that arrives without the exact block is given it; an altered copy between the same delimiters is replaced
 * and the replacement is logged, so a tampered path still runs under the rule.
 *
 * The text is role-neutral on purpose: it speaks of work, structure and whoever assigned it, so it holds for a coder,
 * a writer, a researcher, an operator and a worker alike. Changing it is an owner decision: its digest is pinned in
 * `scripts/sealed-directives.sha256` and `scripts/check-sealed-directives.mjs` fails when the two differ.
 *
 * Kernel layer: no imports from `core/`.
 */

import { harnessLog } from "./harness-log.ts";

export interface SealedDirective {
	/** Stable id, used in the delimiters and the log. Lowercase words joined by `-`. */
	readonly id: string;
	readonly text: string;
}

/** The craft law: build cleanly, and stop to name a restructuring instead of bolting work on. */
export const CRAFT_LAW: SealedDirective = {
	id: "craft-law",
	text: [
		"Do every piece of work cleanly: modular, with sound structure and a clear separation of concerns. Never bolt something on just because it was requested.",
		"Before you start, check that the work fits the existing structure naturally. If it does not, and restructuring would make the whole cleaner, stop before building: name the restructuring, say why it is needed, and wait for a decision from whoever assigned the work (in an unattended run, report it as the blocker to whoever can decide).",
	].join("\n\n"),
};

/** Every sealed directive, in the order they are written. */
export const SEALED_DIRECTIVES: readonly SealedDirective[] = [CRAFT_LAW];

function open(id: string): string {
	return `<sealed-directive id="${id}">`;
}

function close(): string {
	return "</sealed-directive>";
}

/** The exact block one directive occupies in a prompt. */
export function sealedBlock(directive: SealedDirective): string {
	return `${open(directive.id)}\n${directive.text}\n${close()}`;
}

/** The exact text written at the front of a prompt: every directive's block, then a blank line. */
export function sealedPrefix(directives: readonly SealedDirective[] = SEALED_DIRECTIVES): string {
	return `${directives.map(sealedBlock).join("\n\n")}\n\n`;
}

const STRAY_BLOCK_PATTERN = /<sealed-directive id="[^"\n]*">[\s\S]*?<\/sealed-directive>\s*/;
const STRAY_BLOCK = new RegExp(STRAY_BLOCK_PATTERN.source, "g");

/**
 * The prompt with the sealed prefix at its front and no other sealed block anywhere. A prompt that already starts with
 * the exact prefix and holds no stray block is returned unchanged (the common case: no allocation). Anything else is
 * repaired: every block carrying the sealed delimiters is removed, wherever it sits and whatever it says, and the
 * canonical prefix is written first.
 */
export function sealSystemPrompt(
	prompt: string | undefined,
	directives: readonly SealedDirective[] = SEALED_DIRECTIVES,
): string {
	const prefix = sealedPrefix(directives);
	const body = prompt ?? "";
	const hasPrefix = body.startsWith(prefix);
	// What follows the canonical prefix: a prompt written by the builder carries no block, so a prompt that starts with
	// the prefix and holds no other complete block is already sealed and comes back as it is (no allocation).
	const rest = hasPrefix ? body.slice(prefix.length) : body;
	if (hasPrefix && rest.search(STRAY_BLOCK_PATTERN) < 0) return body;
	// A block that is there but altered, duplicated or out of place is removed, and that is worth a warning; a prompt
	// that simply has no block yet is given it silently.
	const stripped = rest.replace(STRAY_BLOCK, "");
	if (stripped.length !== rest.length)
		harnessLog.warn("prompt", "a system prompt carried an altered or misplaced sealed directive; it was replaced", {
			ids: directives.map((directive) => directive.id).join(","),
		});
	return `${prefix}${hasPrefix ? stripped : stripped.trimStart()}`;
}
