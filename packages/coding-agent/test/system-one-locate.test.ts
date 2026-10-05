import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLocator, LOCATE_QUESTIONS_PER_REQUEST, locateQuestionId } from "../src/core/system-one/locate.ts";
import {
	collectLocateCandidates,
	LOCATE_EXCERPT_RADIUS,
	type LocateHit,
	type LocateSearch,
	MAX_LOCATE_CANDIDATES,
	rankLocateFiles,
} from "../src/core/system-one/locate-candidates.ts";
import { LocateInputError } from "../src/core/system-one/locate-input.ts";
import {
	MODEL_EVALUATION_REQUEST_BYTES,
	planEvaluationBatches,
	planModelEvaluations,
} from "../src/core/system-one/model-evaluation-batches.ts";
import type { SemanticEvaluationObserver } from "../src/core/system-one/semantic-evaluation-ledger.ts";

const hit = (file: string, line: number, text = ""): LocateHit => ({ path: file, line, text });

describe("rankLocateFiles", () => {
	it("judges files covering more distinct queries first, then more hits, then path ascending", () => {
		const ranked = rankLocateFiles(
			["alpha", "beta"],
			[
				[hit("many.ts", 1), hit("many.ts", 2), hit("many.ts", 3), hit("b.ts", 1), hit("a.ts", 1)],
				[hit("b.ts", 9), hit("a.ts", 9)],
			],
		);
		expect(ranked.map((file) => file.path)).toEqual(["a.ts", "b.ts", "many.ts"]);
	});

	it("takes a declaration of a queried name as the best hit over a denser use", () => {
		const ranked = rankLocateFiles(
			["visibleWidth"],
			[
				[
					hit("utils.ts", 10, "export function visibleWidth(text: string): number {"),
					hit("utils.ts", 200, "\t\tconst width = visibleWidth(a) + visibleWidth(b);"),
					hit("utils.ts", 201, "\t\tconst other = visibleWidth(c);"),
				],
			],
		);
		expect(ranked[0]?.bestLine).toBe(10);
	});

	it("falls back to the densest window, then the earliest line", () => {
		const ranked = rankLocateFiles(
			["x"],
			[[hit("f.ts", 1, "x"), hit("f.ts", 100, "x"), hit("f.ts", 102, "x"), hit("f.ts", 300, "x")]],
		);
		expect(ranked[0]?.bestLine).toBe(100);
	});
});

describe("collectLocateCandidates", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "locate-candidates-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
	const searching =
		(hits: readonly LocateHit[]): LocateSearch =>
		async () => ({ hits });

	it("cuts a window of the radius around the best hit, redacted, and skips protected, binary and missing files", async () => {
		writeFileSync(path.join(root, "a.ts"), `${lines(30)}\n`);
		writeFileSync(path.join(root, "bin.dat"), Buffer.from([65, 0, 66]));
		writeFileSync(path.join(root, ".env"), "SECRET=1\n");
		const result = await collectLocateCandidates({
			queries: ["line"],
			roots: [root],
			cwd: root,
			redact: (text) => text.replace("line 15", "[R]"),
			search: searching([hit("a.ts", 15), hit("bin.dat", 1), hit(".env", 1), hit("gone.ts", 1)]),
		});
		expect(result.filesMatched).toBe(4);
		expect(result.excluded).toBe(3);
		expect(result.candidates).toHaveLength(1);
		const candidate = result.candidates[0]!;
		expect(candidate.excerpt.split("\n")).toHaveLength(2 * LOCATE_EXCERPT_RADIUS + 1);
		expect(candidate.excerpt).toContain("line 12");
		expect(candidate.excerpt).toContain("line 18");
		expect(candidate.excerpt).not.toContain("line 11");
		expect(candidate.excerpt).not.toContain("line 19");
		expect(candidate.excerpt).toContain("[R]");
		expect(candidate.matchLine).toBe("[R]");
	});

	it("cards a file with its leading comment and declared names, queried and exported first", async () => {
		writeFileSync(
			path.join(root, "card.ts"),
			[
				"/**",
				" * Measures how wide text is.",
				" * Second line.",
				" */",
				"import x from 'y';",
				"function helperOne() {}",
				"function helperTwo() {}",
				"export function visibleWidth(text: string) {",
				"\treturn text.length;",
				"}",
				"export const unrelated = 2;",
			].join("\n"),
		);
		const result = await collectLocateCandidates({
			queries: ["visibleWidth"],
			roots: [root],
			cwd: root,
			redact: (text) => text,
			search: searching([hit("card.ts", 8, "export function visibleWidth(text: string) {")]),
		});
		const card = result.candidates[0]!;
		expect(card.doc).toBe("Measures how wide text is.\nSecond line.");
		expect(card.declarations).toEqual(["visibleWidth", "unrelated", "helperOne", "helperTwo"]);
		expect(card.line).toBe(8);
	});

	it("reports a query whose search hit the cap", async () => {
		writeFileSync(path.join(root, "a.ts"), "x\n");
		const result = await collectLocateCandidates({
			queries: ["x"],
			roots: [root],
			cwd: root,
			redact: (text) => text,
			search: async () => ({ hits: [hit("a.ts", 1)], truncated: true }),
		});
		expect(result.truncatedQueries).toEqual(["x"]);
	});

	it("keeps at most the candidate cap and counts the rest", async () => {
		mkdirSync(path.join(root, "src"));
		const hits: LocateHit[] = [];
		for (let index = 0; index < MAX_LOCATE_CANDIDATES + 5; index++) {
			const name = `src/f${String(index).padStart(3, "0")}.ts`;
			writeFileSync(path.join(root, name), "one\ntwo\n");
			hits.push(hit(name, 1));
		}
		const result = await collectLocateCandidates({
			queries: ["one"],
			roots: [root],
			cwd: root,
			redact: (text) => text,
			search: searching(hits),
		});
		expect(result.candidates).toHaveLength(MAX_LOCATE_CANDIDATES);
		expect(result.beyondCap).toBe(5);
		expect(result.candidates[0]?.path).toBe("src/f000.ts");
	});

	it("reports a query that could not run without failing the others", async () => {
		writeFileSync(path.join(root, "a.ts"), "x\n");
		const search: LocateSearch = async (query) =>
			query === "(" ? { hits: [], error: "regex parse error" } : { hits: [hit("a.ts", 1)] };
		const result = await collectLocateCandidates({
			queries: ["(", "x"],
			roots: [root],
			cwd: root,
			redact: (text) => text,
			search,
		});
		expect(result.invalidQueries).toEqual([{ query: "(", message: "regex parse error" }]);
		expect(result.candidates).toHaveLength(1);
	});
});

describe("planEvaluationBatches", () => {
	const question = () => ({ type: "boolean" as const, instructions: "q" });

	it("splits at the question cap", () => {
		const batches = planEvaluationBatches({
			count: 60,
			model: "m",
			empty: () => ({}) as Record<string, string>,
			withItem: (state, index) => ({ ...state, [`c${index}`]: "x" }),
			questionId: locateQuestionId,
			question,
			maxQuestions: LOCATE_QUESTIONS_PER_REQUEST,
		});
		expect(batches.map((batch) => batch.indexes.length)).toEqual([25, 25, 10]);
		expect(batches.flatMap((batch) => [...batch.indexes])).toEqual(Array.from({ length: 60 }, (_, index) => index));
	});

	it("splits at the byte budget and never truncates evidence", () => {
		const text = "y".repeat(10_000);
		const batches = planEvaluationBatches({
			count: 5,
			model: "m",
			empty: () => ({}) as Record<string, string>,
			withItem: (state, index) => ({ ...state, [`c${index}`]: text }),
			questionId: locateQuestionId,
			question,
		});
		expect(batches.length).toBeGreaterThan(1);
		for (const batch of batches)
			expect(Buffer.byteLength(JSON.stringify(batch.state))).toBeLessThanOrEqual(MODEL_EVALUATION_REQUEST_BYTES);
		expect(batches.flatMap((batch) => Object.values(batch.state))).toEqual(Array.from({ length: 5 }, () => text));
	});

	it("rejects one item that cannot fit alone", () => {
		expect(() =>
			planEvaluationBatches({
				count: 1,
				model: "m",
				empty: () => ({}) as Record<string, string>,
				withItem: (state) => ({ ...state, c0: "z".repeat(MODEL_EVALUATION_REQUEST_BYTES) }),
				questionId: locateQuestionId,
				question,
			}),
		).toThrow(/request budget/);
	});

	it("keeps the whole comparison universe together and splits independent targets", () => {
		const small = Array.from({ length: 6 }, (_, index) => ({ description: `d${index}${"w".repeat(2_000)}` }));
		const compared = planModelEvaluations(small, "m", true, (index) => `q${index}`, question);
		expect(compared).toHaveLength(1);
		expect(Object.keys(compared[0]!.state.models)).toHaveLength(6);
		const large = Array.from({ length: 6 }, (_, index) => ({ description: `d${index}${"w".repeat(9_000)}` }));
		const independent = planModelEvaluations(large, "m", false, (index) => `q${index}`, question);
		expect(independent.length).toBeGreaterThan(1);
		expect(independent.flatMap((batch) => Object.keys(batch.state.models)).sort()).toEqual([
			"m0",
			"m1",
			"m2",
			"m3",
			"m4",
			"m5",
		]);
	});
});

describe("FileLocator", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "locate-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	/** One file per name, each declaring a function; `padded` surrounds the hit with long lines so cards are large. */
	function project(names: readonly string[], padded = false): LocateSearch {
		const filler = Array.from({ length: 4 }, () => `// ${"w".repeat(130)}`).join("\n");
		for (const name of names) {
			const declaration = `export function ${name.replace(".ts", "")}() {`;
			writeFileSync(
				path.join(root, name),
				padded ? `${filler}\n${declaration}\n${filler}\n` : `${declaration}\n\treturn 1;\n}\n`,
			);
		}
		return async () => ({
			hits: names.map((name) => hit(name, padded ? 5 : 1, `export function ${name.replace(".ts", "")}() {`)),
		});
	}

	function recorder() {
		const events: string[] = [];
		const observer: SemanticEvaluationObserver = {
			start: (input) => {
				events.push(`start:${input.programId}`);
				return `e${events.length}`;
			},
			settleOk: () => void events.push("ok"),
			settleFailed: () => void events.push("failed"),
			settleCancelled: () => void events.push("cancelled"),
			noteVerdict: () => {},
		};
		return { events, observer };
	}

	function judge(probabilities: Record<string, number>) {
		const states: Record<string, { path: string }>[] = [];
		const adapter = {
			evaluate: async (input: { state: unknown; questions: Record<string, unknown> }) => {
				const state = input.state as Record<string, { path: string }>;
				states.push(state);
				const answers: Record<string, unknown> = {};
				for (const id of Object.keys(input.questions)) {
					const key = `c${id.replace("locate_c", "")}`;
					answers[id] = { noul: probabilities[state[key]!.path] ?? 0.1 };
				}
				return { model: "m", answers, latency_ms: 1 };
			},
		};
		return { adapter, states };
	}

	function locator(search: LocateSearch, adapter: unknown, observer?: SemanticEvaluationObserver) {
		return new FileLocator({
			getCwd: () => root,
			getAdapter: () => adapter as never,
			getObserver: () => observer,
			redact: (text) => text,
			search,
		});
	}

	it("ranks by probability with path order on ties, above the floor first, and records each request", async () => {
		const search = project(["b.ts", "a.ts", "c.ts", "d.ts"]);
		const { adapter } = judge({ "a.ts": 0.97, "b.ts": 0.97, "c.ts": 0.9, "d.ts": 0.4 });
		const { events, observer } = recorder();
		const outcome = await locator(search, adapter, observer).locate({ target: "the thing", queries: ["f"] });
		expect(outcome.judged).toBe(true);
		expect(outcome.matches.map((match) => match.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
		expect(outcome.text.split("\n").filter((line) => line.startsWith("a.ts:1  p=0.97"))).toHaveLength(1);
		expect(outcome.text).toContain("1 further below the floor");
		expect(outcome.text).not.toMatch(/\u001b/);
		expect(events).toEqual(["start:system-one:locate", "ok"]);
	});

	it("clips a long matched line at a word without control codes", async () => {
		writeFileSync(path.join(root, "long.ts"), `${"word ".repeat(80)}\n`);
		const { adapter } = judge({ "long.ts": 0.95 });
		const outcome = await locator(async () => ({ hits: [hit("long.ts", 1)] }), adapter).locate({
			target: "the thing",
			queries: ["word"],
		});
		const line = outcome.text.split("\n").find((entry) => entry.startsWith("long.ts:1"))!;
		expect(line.endsWith(" …")).toBe(true);
		expect(line).not.toMatch(/\u001b/);
	});

	it("tops a short accepted list up with the best below the floor, labeled", async () => {
		const search = project(["a.ts", "b.ts", "c.ts"]);
		const { adapter } = judge({ "a.ts": 0.2, "b.ts": 0.6, "c.ts": 0.5 });
		const outcome = await locator(search, adapter).locate({ target: "the thing", queries: ["f"] });
		expect(outcome.matches).toEqual([]);
		expect(outcome.closest.map((match) => match.path)).toEqual(["b.ts", "c.ts", "a.ts"]);
		expect(outcome.text).toContain("No candidate reached the acceptance floor");
		expect(outcome.text).toContain("(below floor)");
	});

	it("returns the lexical ranking marked unjudged on an outage, never an error", async () => {
		const search = project(["a.ts", "b.ts"]);
		const { events, observer } = recorder();
		const adapter = {
			evaluate: async () => {
				throw new Error("System One unavailable");
			},
		};
		const outcome = await locator(search, adapter, observer).locate({ target: "the thing", queries: ["f"] });
		expect(outcome.judged).toBe(false);
		expect(outcome.text).toContain("locate unjudged (System One unavailable)");
		expect(outcome.text).toContain("hits=1");
		expect(outcome.text).not.toMatch(/nothing found|No file/i);
		expect(events).toEqual(["start:system-one:locate", "failed"]);
	});

	it("is unjudged when no judge is bound", async () => {
		const search = project(["a.ts"]);
		const outcome = await new FileLocator({
			getCwd: () => root,
			getAdapter: () => undefined,
			getObserver: () => undefined,
			redact: (text) => text,
			search,
		}).locate({ target: "the thing", queries: ["f"] });
		expect(outcome.judged).toBe(false);
		expect(outcome.text).toContain("not bound to this session");
	});

	it("keeps what judged and marks the failed request's candidates unjudged", async () => {
		const names = Array.from(
			{ length: MAX_LOCATE_CANDIDATES },
			(_, index) => `f${String(index).padStart(2, "0")}.ts`,
		);
		const search = project(names, true);
		let calls = 0;
		const adapter = {
			evaluate: async (input: { state: unknown; questions: Record<string, unknown> }) => {
				calls += 1;
				if (calls === 2) throw new Error("timeout");
				return {
					model: "m",
					answers: Object.fromEntries(Object.keys(input.questions).map((id) => [id, { noul: 0.95 }])),
					latency_ms: 1,
				};
			},
		};
		const outcome = await new FileLocator({
			getCwd: () => root,
			getAdapter: () => adapter as never,
			getObserver: () => undefined,
			redact: (text) => text,
			search,
			concurrency: 1,
		}).locate({ target: "the thing", queries: ["f"], limit: 10 });
		expect(outcome.judged).toBe(true);
		expect(outcome.requests.map((request) => request.failed)).toEqual([false, true]);
		expect(outcome.text).toMatch(/\d+ unjudged \(timeout\)/);
	});

	it("sends redacted excerpts and the target, one question per candidate", async () => {
		const search = project(["a.ts"]);
		const { adapter, states } = judge({});
		await new FileLocator({
			getCwd: () => root,
			getAdapter: () => adapter as never,
			getObserver: () => undefined,
			redact: (text) => text.replace("return 1", "return [R]"),
			search,
		}).locate({ target: "the thing", queries: ["f"] });
		expect(states).toHaveLength(1);
		expect(states[0]).toMatchObject({ target: "the thing" });
		expect(JSON.stringify(states[0])).toContain("return [R]");
		expect(JSON.stringify(states[0])).not.toContain("return 1");
	});

	it("rejects unusable input and a search where no query could run", async () => {
		const { adapter } = judge({});
		const failing: LocateSearch = async () => ({ hits: [], error: "bad pattern" });
		await expect(locator(failing, adapter).locate({ target: "t", queries: ["("] })).rejects.toThrow(/bad pattern/);
		await expect(locator(failing, adapter).locate({ target: " ", queries: ["x"] })).rejects.toBeInstanceOf(
			LocateInputError,
		);
		await expect(locator(failing, adapter).locate({ target: "t", queries: [] })).rejects.toBeInstanceOf(
			LocateInputError,
		);
		await expect(
			locator(failing, adapter).locate({ target: "x".repeat(501), queries: ["x"] }),
		).rejects.toBeInstanceOf(LocateInputError);
		await expect(
			locator(failing, adapter).locate({ target: "t", queries: ["x"], paths: ["../outside"] }),
		).rejects.toThrow(/outside the task directory|not found/);
	});
});
