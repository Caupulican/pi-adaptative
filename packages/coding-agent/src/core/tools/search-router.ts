/**
 * Search backend router.
 *
 * The agent sees one stable tool interface (`find`, `grep`). Internally each tool
 * can be served by more than one backend:
 *
 * - `fff`: the resident FFF index (in-process, ranked top-N, fuzzy file search),
 * - `fallback`: the fd/rg subprocess path (exhaustive, forced ignore-case,
 *   fd/rg-native hierarchical `.gitignore` semantics).
 *
 * This module is the single, pure, auditable place that decides which backend a
 * given call should use, based on the filters the agent supplied plus a few
 * environment facts. It does no IO; callers gather facts and pass them in.
 *
 * Why route at all (measured, warm cache, synthetic corpora 8k-20k files):
 *
 *   find, default limit 1000 : FFF 110-163ms vs fd 27-29ms   -> fd wins
 *   find, small  limit 50    : FFF 34-92ms   vs fd 21-23ms   -> fd wins
 *   grep, default limit 100  : FFF 46-92ms   vs rg 26-27ms   -> rg wins
 *   raw glob   pageSize 20   : 5.6ms (12k files)             -> FFF strong
 *   raw glob   pageSize 20000: 778ms (12k files)             -> FFF collapses
 *   raw fuzzy  pageSize 20   : 7.5ms (fd cannot do fuzzy)    -> FFF only
 *
 * The dominant factor is the requested result count: FFF is a ranked top-N engine
 * and must score/sort the whole corpus when asked for a large page, which is its
 * worst case and fd/rg's amortized best case. So the router keeps small top-N and
 * fuzzy queries on FFF and sends exhaustive/forced-ignore-case/gitignore-tree
 * queries to fd/rg. Thresholds are configurable so they can be retuned per
 * environment with the benchmark suite instead of being hardcoded guesses.
 */

export type SearchBackend = "fff" | "fallback";

export type SearchToolKind = "find" | "grep";

export type SearchRouteReason =
	| "fff_unavailable"
	| "path_unresolved"
	| "forced_ignore_case"
	| "gitignore_semantics"
	| "exhaustive_limit"
	| "fff_fuzzy_file_search"
	| "fff_topn";

export interface SearchRouteRequest {
	/** Which built-in tool is routing. */
	tool: SearchToolKind;
	/** Filter: the request targets glob-style matching (find) rather than fuzzy file search. */
	glob: boolean;
	/** Filter: forced case-insensitive matching was requested. */
	ignoreCase: boolean;
	/** Filter: maximum number of results the caller will keep. */
	limit: number;
	/** Env fact: an FFF resident finder is usable for this cwd. */
	finderAvailable: boolean;
	/** Env fact: the search path is inside the indexed cwd and exists. */
	pathResolvable: boolean;
	/** Env fact: a `.gitignore` exists under the search path. */
	gitignoreInTree: boolean;
}

export interface SearchRouteDecision {
	backend: SearchBackend;
	reason: SearchRouteReason;
}

export interface SearchRouterThresholds {
	/** Result limit at or below which `find` prefers the FFF top-N/fuzzy path. */
	findMaxFffLimit: number;
	/** Result limit at or below which `grep` prefers the FFF top-N path. */
	grepMaxFffLimit: number;
}

export const DEFAULT_SEARCH_ROUTER_THRESHOLDS: SearchRouterThresholds = {
	findMaxFffLimit: 20,
	grepMaxFffLimit: 20,
};

/**
 * Pure routing decision. Fail-closed toward the fallback: any missing capability
 * or unsupported filter routes to fd/rg, never silently to a backend that cannot
 * honor the request. Order matters — the earliest matching guard wins so the
 * reason code reflects the most fundamental reason FFF was rejected.
 */
export function routeSearchBackend(
	request: SearchRouteRequest,
	thresholds: SearchRouterThresholds = DEFAULT_SEARCH_ROUTER_THRESHOLDS,
): SearchRouteDecision {
	if (!request.pathResolvable) {
		return { backend: "fallback", reason: "path_unresolved" };
	}
	if (request.ignoreCase) {
		// FFF exposes smart-case/case-sensitive modes but no forced ignore-case
		// equivalent to `fd --ignore-case` / `rg --ignore-case`.
		return { backend: "fallback", reason: "forced_ignore_case" };
	}

	const maxFff = request.tool === "find" ? thresholds.findMaxFffLimit : thresholds.grepMaxFffLimit;

	if (request.tool === "find" && !request.glob) {
		// Fuzzy ranked file search: the fd fallback cannot honor this filter at all,
		// so FFF is the only backend that satisfies it. Still bounded so a pathological
		// huge pull degrades to a normal exhaustive listing instead of scoring the
		// entire corpus.
		if (request.limit > maxFff) return { backend: "fallback", reason: "exhaustive_limit" };
		if (request.gitignoreInTree) return { backend: "fallback", reason: "gitignore_semantics" };
		if (!request.finderAvailable) return { backend: "fallback", reason: "fff_unavailable" };
		return { backend: "fff", reason: "fff_fuzzy_file_search" };
	}

	if (request.limit > maxFff) {
		return { backend: "fallback", reason: "exhaustive_limit" };
	}
	if (request.gitignoreInTree) {
		// FFF's `.gitignore` handling diverges from fd/rg's hierarchical, per-subtree
		// semantics (see regression #3303), so defer to fd/rg when one is present.
		return { backend: "fallback", reason: "gitignore_semantics" };
	}
	if (!request.finderAvailable) {
		return { backend: "fallback", reason: "fff_unavailable" };
	}

	return { backend: "fff", reason: "fff_topn" };
}

export interface SearchRouter {
	route(request: SearchRouteRequest): SearchRouteDecision;
}

/** Build a router bound to a fixed threshold set. */
export function createSearchRouter(
	thresholds: SearchRouterThresholds = DEFAULT_SEARCH_ROUTER_THRESHOLDS,
): SearchRouter {
	return {
		route: (request) => routeSearchBackend(request, thresholds),
	};
}

/** Default router used by the built-in `find`/`grep` tools when none is injected. */
export const defaultSearchRouter: SearchRouter = createSearchRouter();
