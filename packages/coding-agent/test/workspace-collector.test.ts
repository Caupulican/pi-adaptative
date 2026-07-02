import { describe, expect, it, vi } from "vitest";
import {
	collectWorkspaceSources,
	deriveSearchTerms,
	type WorkspaceExecFileFn,
} from "../src/core/research/workspace-collector.ts";

/**
 * Build a fake `execFile` that answers ripgrep calls off their args. The discovery call carries
 * `--files-with-matches`; the content call carries `-n`. Each entry may be a string (exit 0 with that
 * stdout), a number (exit code, e.g. 1 = no matches), or `"ENOENT"` (rg binary absent).
 */
function fakeRg(responder: (args: string[]) => string | number | "ENOENT"): WorkspaceExecFileFn {
	const fn = ((
		_file: string,
		args: string[],
		_options: unknown,
		callback: (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void,
	) => {
		const result = responder(args);
		queueMicrotask(() => {
			if (result === "ENOENT") {
				const error = Object.assign(new Error("spawn rg ENOENT"), { code: "ENOENT" });
				callback(error, "", "");
			} else if (typeof result === "number") {
				const error = Object.assign(new Error(`rg exited ${result}`), { code: result });
				callback(result === 0 ? null : error, "", "");
			} else {
				callback(null, result, "");
			}
		});
		return undefined as never;
	}) as unknown as WorkspaceExecFileFn;
	return fn;
}

const DISCOVERY_FILES = ["src/core/research/research-runner.ts", "src/core/research/research-gate.ts"].join("\n");
const CONTENT_LINES = [
	"src/core/research/research-runner.ts:16:export const RESEARCH_LANE_SYSTEM_PROMPT = [",
	"src/core/research/research-runner.ts:142:export async function runResearch(options: ResearchRunnerOptions) {",
].join("\n");

describe("deriveSearchTerms", () => {
	it("splits on non-word runs, lowercases, drops stopwords and short tokens, dedupes, keeps order", () => {
		const terms = deriveSearchTerms("Research the research-lane for goal:g1 requirements/req-1");
		// "the" (stopword), "g1"/"1" (too short) drop; "research" dedupes to one; source order preserved.
		expect(terms).toEqual(["research", "lane", "goal", "requirements"]);
	});

	it("caps at four terms", () => {
		expect(deriveSearchTerms("alpha bravo charlie delta echo foxtrot")).toEqual([
			"alpha",
			"bravo",
			"charlie",
			"delta",
		]);
	});

	it("returns nothing when every token is a stopword or too short", () => {
		expect(deriveSearchTerms("the and a of x1 y2")).toEqual([]);
	});
});

describe("collectWorkspaceSources", () => {
	it("passes derived terms to the discovery call and scans the best term over matched files only", async () => {
		const seen: string[][] = [];
		const execFileFn = fakeRg((args) => {
			seen.push(args);
			return args.includes("--files-with-matches") ? DISCOVERY_FILES : CONTENT_LINES;
		});

		const sources = await collectWorkspaceSources({
			query: "improve the research lane runner",
			cwd: "/repo",
			maxSources: 8,
			execFileFn,
		});

		const discovery = seen.find((a) => a.includes("--files-with-matches"));
		const content = seen.find((a) => a.includes("-n") && !a.includes("--files-with-matches"));
		expect(discovery).toBeDefined();
		expect(content).toBeDefined();
		// Terms from "improve the research lane runner" (the/for-style stopwords dropped).
		expect(discovery).toEqual(
			expect.arrayContaining(["-e", "improve", "-e", "research", "-e", "lane", "-e", "runner"]),
		);
		// The best (longest) term — "research" — drives the content pass, restricted to the discovered files.
		expect(content).toEqual(expect.arrayContaining(["-e", "research", "--"]));
		const dashIndex = content?.indexOf("--") ?? -1;
		expect(content?.slice(dashIndex + 1)).toEqual([
			"src/core/research/research-runner.ts",
			"src/core/research/research-gate.ts",
		]);

		expect(sources.every((source) => source.kind === "workspace")).toBe(true);
		expect(sources.every((source) => source.trusted === true)).toBe(true);
	});

	it("produces pointer-first sources: repo-relative path, bounded excerpt, line number", async () => {
		const longLine = `src/x.ts:7:${"a".repeat(400)}`;
		const execFileFn = fakeRg((args) =>
			args.includes("--files-with-matches") ? "src/x.ts" : `src/x.ts:3:const runner = 1;\n${longLine}`,
		);

		const sources = await collectWorkspaceSources({
			query: "runner behaviour",
			cwd: "/repo",
			maxSources: 8,
			execFileFn,
		});

		expect(sources[0]).toMatchObject({
			kind: "workspace",
			title: "src/x.ts:3",
			uri: "src/x.ts",
			excerpt: "const runner = 1;",
			metadata: { line: 3 },
		});
		// Never a whole file body: the 400-char line is clamped to <= 200 chars with an ellipsis.
		expect(sources[1]?.excerpt?.length).toBeLessThanOrEqual(200);
		expect(sources[1]?.excerpt?.endsWith("…")).toBe(true);
		// No source carries a raw multi-line body.
		expect(sources.every((source) => !source.excerpt?.includes("\n"))).toBe(true);
	});

	it("adds file-level pointers for candidates the best-term pass did not cover", async () => {
		const execFileFn = fakeRg((args) =>
			args.includes("--files-with-matches") ? "src/hit.ts\nsrc/other.ts" : "src/hit.ts:9:const runner = 2;",
		);

		const sources = await collectWorkspaceSources({
			query: "runner other",
			cwd: "/repo",
			maxSources: 8,
			execFileFn,
		});

		const pointer = sources.find((source) => source.uri === "src/hit.ts");
		const fileLevel = sources.find((source) => source.uri === "src/other.ts");
		expect(pointer?.metadata).toMatchObject({ line: 9 });
		expect(fileLevel).toBeDefined();
		expect(fileLevel?.title).toBe("src/other.ts");
		expect(fileLevel?.excerpt).toBeUndefined();
	});

	it("honors the maxSources bound", async () => {
		const content = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts:${i + 1}:match ${i}`).join("\n");
		const execFileFn = fakeRg((args) =>
			args.includes("--files-with-matches")
				? Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`).join("\n")
				: content,
		);

		const sources = await collectWorkspaceSources({
			query: "match term",
			cwd: "/repo",
			maxSources: 3,
			execFileFn,
		});

		expect(sources).toHaveLength(3);
		expect(new Set(sources.map((source) => source.id)).size).toBe(3);
	});

	it("returns [] when rg is missing (ENOENT)", async () => {
		const execFileFn = fakeRg(() => "ENOENT");
		const sources = await collectWorkspaceSources({
			query: "research lane",
			cwd: "/repo",
			maxSources: 8,
			execFileFn,
		});
		expect(sources).toEqual([]);
	});

	it("returns [] when rg errors (exit code 2)", async () => {
		const execFileFn = fakeRg(() => 2);
		const sources = await collectWorkspaceSources({
			query: "research lane",
			cwd: "/repo",
			maxSources: 8,
			execFileFn,
		});
		expect(sources).toEqual([]);
	});

	it("returns [] on a clean no-match discovery (exit code 1) without a content call", async () => {
		const calls: string[][] = [];
		const execFileFn = fakeRg((args) => {
			calls.push(args);
			return 1;
		});
		const sources = await collectWorkspaceSources({
			query: "research lane",
			cwd: "/repo",
			maxSources: 8,
			execFileFn,
		});
		expect(sources).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	it("returns [] when no usable search terms can be derived, without spawning rg", async () => {
		const execFileFn = vi.fn(fakeRg(() => ""));
		const sources = await collectWorkspaceSources({ query: "the and a of", cwd: "/repo", maxSources: 8, execFileFn });
		expect(sources).toEqual([]);
		expect(execFileFn).not.toHaveBeenCalled();
	});
});
