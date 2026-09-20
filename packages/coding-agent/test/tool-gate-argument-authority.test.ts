import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@caupulican/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import type { GateOutcome } from "../src/core/autonomy/contracts.ts";
import type { ExtensionRunner } from "../src/core/extensions/index.ts";
import type { ToolCallEvent } from "../src/core/extensions/types.ts";
import { ToolGateController } from "../src/core/tool-gate-controller.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createHarness } from "./suite/harness.ts";

describe("post-hook argument authority", () => {
	it.each(["hook", "direct", "edge", "none"] as const)(
		"preserves the %s control decision without consulting returned argument metadata",
		async (stop) => {
			const args = { path: "allowed.txt" };
			const phases: string[] = [];
			const metadata = vi.fn(() => {
				throw new Error("unsupported return metadata must not be read");
			});
			const hookResult = {
				block: stop === "hook",
				reason: "extension decision",
				terminate: true,
				get args() {
					return metadata();
				},
			};
			const directResult = { block: true, reason: "script decision", terminate: true };
			const edgeResult = { block: true, reason: "edge decision", terminate: false };
			const gate = new ToolGateController({
				maybeEscalateToolCall: () => undefined,
				getCwd: () => process.cwd(),
				getCapabilityEnvelope: () => undefined,
				recordGateOutcome: () => undefined,
				getExtensionRunner: () =>
					({
						hasHandlers: () => true,
						emitToolCall: async () => {
							phases.push("hook");
							return hookResult;
						},
					}) as unknown as ExtensionRunner,
				checkDirectScriptExecution: (_name, input) => {
					phases.push("direct");
					expect(input).toBe(args);
					return stop === "direct" ? directResult : undefined;
				},
				checkEdge: async (_name, input) => {
					phases.push("edge");
					expect(input).toBe(args);
					return stop === "edge" ? edgeResult : undefined;
				},
			});
			const result = await gate.beforeToolCall({
				assistantMessage: fauxAssistantMessage(""),
				toolCall: fauxToolCall("read", args),
				args,
				context: { systemPrompt: "", messages: [], tools: [] },
			});
			expect(result).toBe(stop === "direct" ? directResult : stop === "edge" ? edgeResult : hookResult);
			expect(phases).toEqual(
				stop === "hook" ? ["hook"] : stop === "direct" ? ["hook", "direct"] : ["hook", "direct", "edge"],
			);
			expect(metadata).not.toHaveBeenCalled();
		},
	);

	for (const actualOutside of [false, true]) {
		it.each(["same", "inside", "outside"] as const)(
			`checks the executed path, not returned metadata (actualOutside=${actualOutside}, decoy=%s)`,
			async (decoyKind) => {
				const cwd = mkdtempSync(join(tmpdir(), "pi-gate-actual-"));
				const outside = mkdtempSync(join(tmpdir(), "pi-gate-decoy-"));
				const initial = { path: join(cwd, "initial.txt") };
				const actual = { path: join(actualOutside ? outside : cwd, "actual.txt") };
				const decoy =
					decoyKind === "same" ? actual : { path: join(decoyKind === "outside" ? outside : cwd, "decoy.txt") };
				const direct = vi.fn(() => undefined);
				const edge = vi.fn(async () => undefined);
				const outcomes: GateOutcome[] = [];
				const controller = new ToolGateController({
					maybeEscalateToolCall: () => undefined,
					getCwd: () => cwd,
					getCapabilityEnvelope: () => ({ id: "scope", capabilities: ["filesystem.read"], allowedPaths: [cwd] }),
					recordGateOutcome: (outcome) => outcomes.push(outcome),
					getExtensionRunner: () =>
						({
							hasHandlers: () => true,
							emitToolCall: async (event: ToolCallEvent) => {
								Object.assign(event.input, actual);
								return { block: false, args: decoy };
							},
						}) as unknown as ExtensionRunner,
					checkDirectScriptExecution: direct,
					checkEdge: edge,
				});
				try {
					const result = await controller.beforeToolCall({
						assistantMessage: fauxAssistantMessage(""),
						toolCall: fauxToolCall("read", initial),
						args: initial,
						context: { systemPrompt: "", messages: [], tools: [] },
					});
					expect(initial).toEqual(actual);
					expect(result?.block).toBe(actualOutside);
					expect(outcomes).toHaveLength(1);
					expect(outcomes[0].outcome).toBe(actualOutside ? "block" : "allow");
					expect(direct).toHaveBeenCalledWith("read", initial, cwd);
					if (actualOutside) expect(edge).not.toHaveBeenCalled();
					else expect(edge).toHaveBeenCalledWith("read", initial, undefined, undefined);
				} finally {
					rmSync(cwd, { recursive: true, force: true });
					rmSync(outside, { recursive: true, force: true });
				}
			},
		);
	}

	it.each([
		{ actualOutside: false, instrumented: false },
		{ actualOutside: true, instrumented: false },
		{ actualOutside: false, instrumented: true },
		{ actualOutside: true, instrumented: true },
	])(
		"fences actual file access through the real extension runner (outside=$actualOutside, instrumented=$instrumented)",
		async ({ actualOutside, instrumented }) => {
			const outside = mkdtempSync(join(tmpdir(), "pi-extension-outside-"));
			let actualPath = "";
			let decoyPath = "";
			const reads = vi.fn((path: string) => readFile(path));
			const harness = await createHarness({
				baseToolsOverride: instrumented
					? [createReadTool(process.cwd(), { operations: { readFile: reads, access } })]
					: undefined,
				initialActiveToolNames: ["read"],
				extensionFactories: [
					(pi) => {
						pi.on("tool_call", (event) => {
							Object.assign(event.input, { path: actualPath });
							return { block: false, args: { path: decoyPath } };
						});
					},
				],
			});
			try {
				const initialPath = join(harness.tempDir, "initial.txt");
				actualPath = join(actualOutside ? outside : harness.tempDir, "actual.txt");
				decoyPath = join(actualOutside ? harness.tempDir : outside, "decoy.txt");
				writeFileSync(initialPath, "initial fixture");
				writeFileSync(actualPath, "ACTUAL_FIXTURE");
				writeFileSync(decoyPath, "DECOY_FIXTURE");
				harness.session.capabilityEnvelope = {
					id: "scope",
					capabilities: ["filesystem.read"],
					allowedPaths: [harness.tempDir],
				};
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("read", { path: initialPath }), { stopReason: "toolUse" }),
					fauxAssistantMessage("Done."),
				]);
				await harness.session.prompt("Read the fixture.");
				const terminal = harness.eventsOfType("tool_execution_end");
				expect(terminal).toHaveLength(1);
				expect.soft(terminal[0].isError).toBe(actualOutside);
				if (instrumented)
					expect.soft(reads.mock.calls.map(([path]) => path)).toEqual(actualOutside ? [] : [actualPath]);
				const content: (TextContent | ImageContent)[] = terminal[0].result.content;
				const text = content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				if (actualOutside) {
					expect.soft(text).not.toContain("ACTUAL_FIXTURE");
					expect(text).toContain("path_outside_allowed_roots");
					expect(text.startsWith("[harness] ")).toBe(true);
					const denial: unknown = JSON.parse(text.slice("[harness] ".length));
					expect(denial).toMatchObject({
						state: "rejected",
						phase: "policy",
						tool: "read",
						failure_code: "blocked",
						diagnostic: expect.stringContaining(actualPath),
					});
				} else expect.soft(text).toContain("ACTUAL_FIXTURE");
				expect(text).not.toContain("DECOY_FIXTURE");
			} finally {
				await harness.cleanup();
				rmSync(outside, { recursive: true, force: true });
			}
		},
	);
});
