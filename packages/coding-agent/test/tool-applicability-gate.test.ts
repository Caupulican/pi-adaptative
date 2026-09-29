import { describe, expect, it } from "vitest";
import {
	enforceExplicitOptionalToolRequest,
	type OptionalToolIntent,
	optionalToolIntentFromAnswers,
	optionalToolRequestAliases,
	readOptionalToolIntent,
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

	it("pauses on ambiguous, missing, or malformed judgments without reviving an older grant", () => {
		for (const confidence of [NaN, Infinity, 1.1, 0.949]) {
			expect(
				gate(
					optionalToolIntentFromAnswers(
						"continue",
						{ candidates, previous: requested() },
						{ optional_tool_task: answer("continue", confidence), optional_tool_0: answer("request") },
					),
				)?.block,
			).toBe(true);
		}
		expect(gate(undefined)?.block).toBe(true);
		expect(readOptionalToolIntent({ ...requested(), allowedTools: [{ toolName: "trello" }] })).toBeUndefined();
		expect(gate({ ...requested(), status: "paused" })?.block).toBe(true);
		const continued = optionalToolIntentFromAnswers(
			"continue",
			{ candidates, previous: { ...requested(), status: "paused" } },
			{ optional_tool_task: answer("continue"), optional_tool_0: answer("unchanged") },
		);
		expect(gate(continued)?.block).toBe(true);
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
