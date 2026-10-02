import { describe, expect, it } from "vitest";
import {
	enforceExplicitOptionalToolRequest,
	type OptionalToolIntent,
	optionalToolIntentFromAnswers,
	optionalToolRelationAsked,
	optionalToolRequestAliases,
	readOptionalToolIntent,
	traceOptionalToolJudgments,
} from "../src/core/tool-applicability-gate.ts";

describe("optional tool applicability gate", () => {
	const candidates = [
		{ toolName: "trello", sourcePath: "/extensions/trello.ts", aliases: ["trello"] },
		{ toolName: "secret_store", sourcePath: "builtin", aliases: ["credentials"] },
	];
	const answer = (choice: string, confidence = 0.99) => ({ choice, confidence });
	const gate = (intent: OptionalToolIntent | undefined, tool = candidates[0]!) =>
		enforceExplicitOptionalToolRequest({ ...tool, intent });
	const requested = () =>
		optionalToolIntentFromAnswers(
			"Use Trello to inspect cards.",
			{ candidates, previous: undefined },
			{
				optional_tool_task: answer("replace"),
				optional_tool_0: answer("request"),
				optional_tool_1: answer("unchanged"),
			},
		);

	it("retains admitted task intent through continuation and removes explicit revocation", () => {
		const previous = requested();
		expect(gate(previous)).toBeUndefined();
		const continued = optionalToolIntentFromAnswers(
			"Continue inspecting cards.",
			{ candidates, previous },
			{ optional_tool_task: answer("continue"), optional_tool_0: answer("unchanged") },
		);
		expect(gate(continued)).toBeUndefined();
		const revoked = optionalToolIntentFromAnswers(
			"Stop using Trello and continue locally.",
			{ candidates, previous: continued },
			{ optional_tool_task: answer("continue"), optional_tool_0: answer("revoke") },
		);
		expect(gate(revoked)?.block).toBe(true);
	});

	it("blocks only the tool the owner forbade, at its own source, and only for the task that forbade it", () => {
		const forbidden = optionalToolIntentFromAnswers(
			"Stop using Trello.",
			{ candidates, previous: undefined },
			{
				optional_tool_task: answer("replace"),
				optional_tool_0: answer("revoke"),
				optional_tool_1: answer("unchanged"),
			},
		);
		expect(forbidden.revokedTools).toEqual([{ toolName: "trello", sourcePath: "/extensions/trello.ts" }]);
		expect(gate(forbidden)?.block).toBe(true);
		expect(gate(forbidden)?.reason).toContain("was forbidden by the owner");
		// Another tool, and another source of the same name, are not the forbidden tool.
		expect(gate(forbidden, candidates[1]!)).toBeUndefined();
		expect(gate(forbidden, { ...candidates[0]!, sourcePath: "/other/trello.ts" })).toBeUndefined();
		// The forbidding outlives later words that neither ask for nor forbid the tool, however clearly
		// or unclearly they were judged, and ends when the owner asks for it again or the task ends.
		for (const decision of [answer("unchanged"), answer("uncertain"), answer("unchanged", 0.5)]) {
			const continued = optionalToolIntentFromAnswers(
				"Keep going.",
				{ candidates, previous: forbidden },
				{ optional_tool_task: answer("continue"), optional_tool_0: decision },
			);
			expect(gate(continued)?.block).toBe(true);
		}
		const asked = optionalToolIntentFromAnswers(
			"Use Trello again.",
			{ candidates, previous: forbidden },
			{ optional_tool_task: answer("continue"), optional_tool_0: answer("request") },
		);
		expect(gate(asked)).toBeUndefined();
		for (const relation of ["replace", "end"]) {
			expect(
				gate(
					optionalToolIntentFromAnswers(
						"New local task.",
						{ candidates, previous: forbidden },
						{ optional_tool_task: answer(relation), optional_tool_0: answer("unchanged") },
					),
				),
			).toBeUndefined();
		}
	});

	it("leaves an unresolved judgment as no owner decision and never revives an older grant", () => {
		for (const confidence of [NaN, Infinity, 1.1, 0.92]) {
			const intent = optionalToolIntentFromAnswers(
				"continue",
				{ candidates, previous: requested() },
				{ optional_tool_task: answer("continue", confidence), optional_tool_0: answer("request") },
			);
			expect(intent.status).toBe("unresolved");
			expect(intent.allowedTools).toEqual([]);
			expect(gate(intent)).toBeUndefined();
		}
		expect(
			optionalToolIntentFromAnswers(
				"continue",
				{ candidates, previous: requested() },
				{ optional_tool_task: answer("uncertain"), optional_tool_0: answer("request") },
			).status,
		).toBe("unresolved");
		expect(gate(undefined)).toBeUndefined();
		expect(readOptionalToolIntent({ ...requested(), allowedTools: [{ toolName: "trello" }] })).toBeUndefined();
		const unresolved = readOptionalToolIntent({
			version: 1,
			status: "unresolved",
			taskRequest: "use bw",
			allowedTools: [{ toolName: "trello", sourcePath: "/extensions/trello.ts" }],
			pendingRequests: ["use bw"],
			resumeIntent: requested(),
		});
		expect(unresolved?.status).toBe("unresolved");
		expect(unresolved?.allowedTools).toEqual([]);
		expect(unresolved?.resumeIntent?.status).toBe("classified");
		expect(gate(unresolved)).toBeUndefined();
	});

	it("runs a tool the owner neither asked for nor forbade, and keeps standing forbiddings while words are classified", () => {
		const notMentioned = optionalToolIntentFromAnswers(
			"Explain this function.",
			{ candidates, previous: undefined },
			{
				optional_tool_task: answer("replace"),
				optional_tool_0: answer("unchanged"),
				optional_tool_1: answer("unchanged"),
			},
		);
		expect(notMentioned.revokedTools).toBeUndefined();
		expect(gate(notMentioned)).toBeUndefined();
		expect(gate(notMentioned, candidates[1]!)).toBeUndefined();
		const longName = "t".repeat(128);
		expect(gate(notMentioned, { toolName: longName, sourcePath: "/x.ts", aliases: [] })).toBeUndefined();

		// Classification in flight blocks nothing by itself.
		const inFlight = readOptionalToolIntent({ version: 1, status: "paused", taskRequest: "x", allowedTools: [] });
		expect(gate(inFlight)).toBeUndefined();
		// What the owner already forbade still stands until their new words are classified.
		const forbidden = optionalToolIntentFromAnswers(
			"Stop using Trello.",
			{ candidates, previous: undefined },
			{ optional_tool_task: answer("replace"), optional_tool_0: answer("revoke") },
		);
		const pausedAfterForbidding = readOptionalToolIntent({
			version: 1,
			status: "paused",
			taskRequest: "go on",
			allowedTools: [],
			pendingRequests: ["go on"],
			resumeIntent: forbidden,
		});
		const blocked = gate(pausedAfterForbidding);
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).not.toMatch(/probe|credential/i);
		expect(blocked?.reason?.length).toBeLessThan(240);
		expect(gate(pausedAfterForbidding, candidates[1]!)).toBeUndefined();
	});

	it("never reads a sub-threshold or uncertain per-tool judgment as a forbidding", () => {
		const intent = optionalToolIntentFromAnswers(
			"Use trello and check the credentials.",
			{ candidates, previous: undefined },
			{
				optional_tool_task: answer("replace", 0.99),
				optional_tool_0: answer("request", 0.74),
				optional_tool_1: answer("revoke", 0.74),
			},
		);
		expect(intent.status).toBe("classified");
		expect(intent.allowedTools).toEqual([]);
		expect(intent.revokedTools).toBeUndefined();
		expect(gate(intent)).toBeUndefined();
		expect(gate(intent, candidates[1]!)).toBeUndefined();
		const uncertain = optionalToolIntentFromAnswers(
			"Check things.",
			{ candidates, previous: undefined },
			{
				optional_tool_task: answer("replace"),
				optional_tool_0: answer("uncertain"),
				optional_tool_1: answer("revoke"),
			},
		);
		expect(gate(uncertain)).toBeUndefined();
		expect(gate(uncertain, candidates[1]!)?.block).toBe(true);
		// The persisted shape survives a round trip; a forbidding only exists on a classified snapshot.
		expect(readOptionalToolIntent(JSON.parse(JSON.stringify(uncertain)))).toEqual(uncertain);
		expect(readOptionalToolIntent({ ...uncertain, status: "paused" })).toBeUndefined();
	});

	it("keeps a grant held before when its later judgment is below the floor", () => {
		const previous = requested();
		const continued = optionalToolIntentFromAnswers(
			"Keep going.",
			{ candidates, previous },
			{ optional_tool_task: answer("continue"), optional_tool_0: answer("unchanged", 0.6) },
		);
		expect(continued.allowedTools).toEqual([{ toolName: "trello", sourcePath: "/extensions/trello.ts" }]);
		expect(gate(continued)).toBeUndefined();
	});

	it("keeps secret_store metadata actions available even after the owner forbade credentials", () => {
		const secretStore = candidates[1]!;
		const notMentioned = optionalToolIntentFromAnswers(
			"Explain this function.",
			{ candidates, previous: undefined },
			{
				optional_tool_task: answer("replace"),
				optional_tool_0: answer("unchanged"),
				optional_tool_1: answer("unchanged"),
			},
		);
		const forbidden = optionalToolIntentFromAnswers(
			"Continue without credentials.",
			{ candidates, previous: undefined },
			{
				optional_tool_task: answer("replace"),
				optional_tool_0: answer("unchanged"),
				optional_tool_1: answer("revoke"),
			},
		);
		const gateWith = (intent: OptionalToolIntent, action: string) =>
			enforceExplicitOptionalToolRequest({ ...secretStore, intent, args: { action } });
		for (const action of ["status", "list", "discover", "activate", "migrate"])
			expect(gateWith(notMentioned, action)).toBeUndefined();
		for (const action of ["status", "list", "discover"]) expect(gateWith(forbidden, action)).toBeUndefined();
		for (const action of ["activate", "migrate"]) expect(gateWith(forbidden, action)?.block).toBe(true);
		expect(gate(forbidden, secretStore)?.block).toBe(true);
	});

	it("traces each raw judgment with its confidence and acceptance for the evaluation ledger", () => {
		const answers = {
			optional_tool_task: answer("continue", 0.91),
			optional_tool_0: answer("request", 0.97),
		};
		// With no previous classified intent the relation is `replace` by definition and is not judged.
		const withoutPrevious = traceOptionalToolJudgments({ candidates, previous: undefined }, answers);
		expect(withoutPrevious.map((entry) => entry.text)).toEqual([
			"optional_tool_0: request @0.970 accepted (trello)",
			"optional_tool_1: missing @missing rejected (floor 0.93) (secret_store)",
		]);
		expect(withoutPrevious.map((entry) => entry.uncertain)).toEqual([false, true]);
		const withPrevious = traceOptionalToolJudgments({ candidates, previous: requested() }, answers);
		expect(withPrevious.map((entry) => entry.text)).toEqual([
			"optional_tool_task: continue @0.910 rejected (floor 0.93)",
			"optional_tool_0: request @0.970 accepted (trello)",
			"optional_tool_1: missing @missing rejected (floor 0.93) (secret_store)",
		]);
	});

	it("judges the task relation only against a previous classified intent, and uses the given floor", () => {
		expect(optionalToolRelationAsked({ previous: undefined })).toBe(false);
		expect(optionalToolRelationAsked({ previous: { ...requested(), status: "unresolved" } })).toBe(false);
		expect(optionalToolRelationAsked({ previous: requested() })).toBe(true);
		const answers = { optional_tool_0: answer("request", 0.94), optional_tool_1: answer("unchanged", 0.94) };
		const atDefault = optionalToolIntentFromAnswers("Use trello.", { candidates, previous: undefined }, answers);
		expect(atDefault.status).toBe("classified");
		expect(atDefault.allowedTools).toEqual([{ toolName: "trello", sourcePath: "/extensions/trello.ts" }]);
		const strict = optionalToolIntentFromAnswers("Use trello.", { candidates, previous: undefined }, answers, 0.95);
		expect(strict.allowedTools).toEqual([]);
		expect(strict.revokedTools).toBeUndefined();
	});

	it("gates profile extensions while leaving built-in and bundled tools alone", () => {
		const source = (name: string) => ({
			path: `/extensions/${name}/index.ts`,
			source: name,
			scope: "user" as const,
			origin: "top-level" as const,
		});

		expect(optionalToolRequestAliases("trello", source("profile"))).toEqual(["trello"]);
		expect(optionalToolRequestAliases("pi_collaboration", source("bundled"))).toBeUndefined();
		expect(optionalToolRequestAliases("read", source("builtin"))).toBeUndefined();
		expect(optionalToolRequestAliases("secret_store", source("builtin"))).toContain("credentials");
	});

	it("admits only the active extension verifier while retaining credential and unrelated-tool gates", () => {
		const source = {
			path: "/extensions/new-tool.ts",
			source: "local",
			scope: "temporary" as const,
			origin: "top-level" as const,
		};
		const verification = () => ({ toolName: "new_probe", path: source.path });
		expect(optionalToolRequestAliases("new_probe", source, verification)).toBeUndefined();
		expect(optionalToolRequestAliases("other_probe", source, verification)).toEqual(["other probe"]);
		expect(
			optionalToolRequestAliases("new_probe", { ...source, path: "/extensions/unrelated.ts" }, verification),
		).toEqual(["new probe"]);
		expect(optionalToolRequestAliases("new_probe", source, () => undefined)).toEqual(["new probe"]);
		expect(
			optionalToolRequestAliases("secret_store", source, () => ({ toolName: "secret_store", path: source.path })),
		).toContain("credentials");
	});
});
