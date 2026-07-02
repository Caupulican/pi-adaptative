/**
 * Toolkit script registry + the Level-0 conservative matcher.
 *
 * The registry is the user's blessed daily-ops toolkit: named scripts with fixed runners. The
 * matcher maps a natural-language request to a script WITHOUT guessing: exact name/alias hits
 * match directly; scored matches win only with a clear margin over the runner-up; anything else
 * is a shortlist (disambiguate) or none. Ambiguity never executes — "prepare db" must never
 * silently run update-db.
 */

export type ToolkitRunner = "uv" | "powershell" | "bash";

export interface ToolkitScript {
	/** Registry key, kebab-case (e.g. "restore-db"). */
	name: string;
	description: string;
	/** User-taught phrases that map directly to this script. */
	aliases?: string[];
	runner: ToolkitRunner;
	/** Script path, relative to cwd or absolute. */
	path: string;
	/** Dangerous scripts require explicit confirmation at every level. */
	danger?: boolean;
}

export type ToolkitMatch =
	| { kind: "exact"; script: ToolkitScript }
	| { kind: "ambiguous"; shortlist: ToolkitScript[] }
	| { kind: "none"; closest: ToolkitScript[] };

function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function tokens(text: string): string[] {
	return normalize(text).split(" ").filter(Boolean);
}

const STOP_WORDS = new Set(["the", "a", "an", "my", "run", "execute", "please", "now", "thing", "for", "me", "to"]);

/** Score a request against one script: shared meaningful tokens with name/alias/description. */
function scoreScript(requestTokens: string[], script: ToolkitScript): number {
	const nameTokens = new Set([...tokens(script.name), ...(script.aliases ?? []).flatMap((alias) => tokens(alias))]);
	const descriptionTokens = new Set(tokens(script.description));
	let score = 0;
	// Deduplicate: repeating a word ("backup backup backup") must not multiply the score past
	// MIN_SCORE/margin and turn an ambiguous request into a confident match.
	for (const token of new Set(requestTokens)) {
		if (STOP_WORDS.has(token)) continue;
		if (nameTokens.has(token)) score += 3;
		else if (descriptionTokens.has(token)) score += 1;
	}
	return score;
}

/** Margin rule: the winner must beat the runner-up by at least this factor AND absolute gap. */
const MARGIN_FACTOR = 1.5;
const MIN_SCORE = 3;

export function matchToolkitScript(request: string, scripts: readonly ToolkitScript[]): ToolkitMatch {
	const normalizedRequest = normalize(request);
	if (normalizedRequest.length === 0 || scripts.length === 0) {
		return { kind: "none", closest: [] };
	}

	// 1. Exact name or alias (normalized) matches directly.
	for (const script of scripts) {
		if (normalize(script.name) === normalizedRequest) return { kind: "exact", script };
		for (const alias of script.aliases ?? []) {
			if (normalize(alias) === normalizedRequest) return { kind: "exact", script };
		}
	}

	// 2. Scored matching with the margin rule.
	const requestTokens = tokens(request);
	const scored = scripts
		.map((script) => ({ script, score: scoreScript(requestTokens, script) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score);

	if (scored.length === 0) {
		return { kind: "none", closest: scripts.slice(0, 3) };
	}
	const [best, runnerUp] = scored;
	if (
		best.score >= MIN_SCORE &&
		(runnerUp === undefined || (best.score >= runnerUp.score * MARGIN_FACTOR && best.score - runnerUp.score >= 2))
	) {
		return { kind: "exact", script: best.script };
	}

	// No clear winner: shortlist for disambiguation — never guess.
	return { kind: "ambiguous", shortlist: scored.slice(0, 4).map((entry) => entry.script) };
}
