import { describe, expect, it } from "vitest";
import { createSearchRouter, routeSearchBackend } from "../src/core/tools/search-router.ts";

const baseRequest = {
	tool: "find" as const,
	glob: true,
	ignoreCase: false,
	limit: 10,
	finderAvailable: true,
	pathResolvable: true,
	gitignoreInTree: false,
};

describe("search backend router", () => {
	it("routes small top-N glob searches to FFF", () => {
		expect(routeSearchBackend(baseRequest)).toEqual({ backend: "fff", reason: "fff_topn" });
	});

	it("routes fuzzy file searches to FFF when bounded", () => {
		expect(routeSearchBackend({ ...baseRequest, glob: false })).toEqual({
			backend: "fff",
			reason: "fff_fuzzy_file_search",
		});
	});

	it("routes exhaustive large-limit searches to fd/rg before checking FFF availability", () => {
		expect(routeSearchBackend({ ...baseRequest, limit: 1000, finderAvailable: false })).toEqual({
			backend: "fallback",
			reason: "exhaustive_limit",
		});
	});

	it("routes forced ignore-case searches to fd/rg", () => {
		expect(routeSearchBackend({ ...baseRequest, ignoreCase: true })).toEqual({
			backend: "fallback",
			reason: "forced_ignore_case",
		});
	});

	it("routes gitignore trees to fd/rg for hierarchical ignore semantics", () => {
		expect(routeSearchBackend({ ...baseRequest, gitignoreInTree: true })).toEqual({
			backend: "fallback",
			reason: "gitignore_semantics",
		});
	});

	it("routes paths outside the indexed cwd to fd/rg", () => {
		expect(routeSearchBackend({ ...baseRequest, pathResolvable: false })).toEqual({
			backend: "fallback",
			reason: "path_unresolved",
		});
	});

	it("routes to fd/rg when FFF is unavailable for an otherwise compatible top-N query", () => {
		expect(routeSearchBackend({ ...baseRequest, finderAvailable: false })).toEqual({
			backend: "fallback",
			reason: "fff_unavailable",
		});
	});

	it("uses grep thresholds separately from find thresholds", () => {
		const router = createSearchRouter({ findMaxFffLimit: 50, grepMaxFffLimit: 5 });

		expect(router.route({ ...baseRequest, tool: "find", limit: 50 })).toEqual({
			backend: "fff",
			reason: "fff_topn",
		});
		expect(router.route({ ...baseRequest, tool: "grep", limit: 50 })).toEqual({
			backend: "fallback",
			reason: "exhaustive_limit",
		});
	});
});
