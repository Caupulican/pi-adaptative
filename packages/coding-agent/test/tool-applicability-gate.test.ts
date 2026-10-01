import { describe, expect, it } from "vitest";
import {
	enforceExplicitOptionalToolRequest,
	type OptionalToolIntent,
	optionalToolIntentFromAnswers,
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

	it("does not grant credentials, another tool source, or tools in a replacement task", () => {
		const previous = requested();
		expect(gate(previous, candidates[1]!)?.block).toBe(true);
		expect(gate(previous, { ...candidates[0]!, sourcePath: "/evil/trello.ts" })?.block).toBe(true);
		for (const relation of ["replace", "end"]) {
			expect(
				gate(
					optionalToolIntentFromAnswers(
						"New local task.",
						{ candidates, previous },
						{ optional_tool_task: answer(relation), optional_tool_0: answer("unchanged") },
					),
				)?.block,
			).toBe(true);
		}
	});

	it("leaves an unresolved judgment as no owner decision and never revives an older grant", () => {
		for (const confidence of [NaN, Infinity, 1.1, 0.949]) {
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

	it("blocks while classification is in flight and when a classified intent does not name the tool", () => {
		const inFlight = readOptionalToolIntent({ version: 1, status: "paused", taskRequest: "x", allowedTools: [] });
		expect(gate(inFlight)?.block).toBe(true);
		const notRequested = optionalToolIntentFromAnswers(
			"Explain this function.",
			{ candidates, previous: undefined },
			{ optional_tool_task: answer("replace"), optional_tool_0: answer("unchanged") },
		);
		const blocked = gate(notRequested);
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain("was not requested by the owner");
		expect(blocked?.reason).not.toMatch(/probe|credential/i);
		const longName = "t".repeat(128);
		expect(gate(notRequested, { toolName: longName, sourcePath: "/x.ts", aliases: [] })?.reason?.length).toBeLessThan(
			240,
		);
	});

	it("treats a sub-threshold or uncertain per-tool judgment as undecided, never as not requested", () => {
		const intent = optionalToolIntentFromAnswers(
			"Use trello and check the credentials.",
			{ candidates, previous: undefined },
			{
				optional_tool_task: answer("replace", 0.99),
				optional_tool_0: answer("request", 0.74),
				optional_tool_1: answer("unchanged", 0.99),
			},
		);
		expect(intent.status).toBe("classified");
		expect(intent.allowedTools).toEqual([]);
		expect(intent.undecidedTools).toEqual([{ toolName: "trello", sourcePath: "/extensions/trello.ts" }]);
		// The undecided tool passes; a tool the evaluator decided against with confidence still blocks.
		expect(gate(intent)).toBeUndefined();
		const decided = gate(intent, candidates[1]!);
		expect(decided?.block).toBe(true);
		expect(decided?.reason).toContain("was not requested by the owner");
		// Uncertain is undecided too, and the persisted shape survives a round trip.
		const uncertain = optionalToolIntentFromAnswers(
			"Check things.",
			{ candidates, previous: undefined },
			{
				optional_tool_task: answer("replace"),
				optional_tool_0: answer("uncertain"),
				optional_tool_1: answer("request"),
			},
		);
		expect(readOptionalToolIntent(JSON.parse(JSON.stringify(uncertain)))).toEqual(uncertain);
		expect(gate(uncertain)).toBeUndefined();
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

	it("keeps secret_store metadata actions available and gates only activation and migration", () => {
		const secretStore = candidates[1]!;
		const notRequested = optionalToolIntentFromAnswers(
			"Explain this function.",
			{ candidates, previous: undefined },
			{
				optional_tool_task: answer("replace"),
				optional_tool_0: answer("unchanged"),
				optional_tool_1: answer("unchanged"),
			},
		);
		const gateWith = (action: string) =>
			enforceExplicitOptionalToolRequest({ ...secretStore, intent: notRequested, args: { action } });
		for (const action of ["status", "list", "discover"]) expect(gateWith(action)).toBeUndefined();
		for (const action of ["activate", "migrate"]) expect(gateWith(action)?.block).toBe(true);
		expect(gate(notRequested, secretStore)?.block).toBe(true);
	});

	it("traces each raw judgment with its confidence and acceptance for the evaluation ledger", () => {
		const trace = traceOptionalToolJudgments(
			{ candidates },
			{ optional_tool_task: answer("replace", 0.91), optional_tool_0: answer("request", 0.97) },
		);
		expect(trace.map((entry) => entry.text)).toEqual([
			"optional_tool_task: replace @0.910 rejected (floor 0.95)",
			"optional_tool_0: request @0.970 accepted (trello)",
			"optional_tool_1: missing @missing rejected (floor 0.95) (secret_store)",
		]);
		expect(trace.map((entry) => entry.uncertain)).toEqual([true, false, true]);
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
