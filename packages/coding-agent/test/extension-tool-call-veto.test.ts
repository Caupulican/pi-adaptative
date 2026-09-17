import { writeFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@caupulican/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionFactory, ToolCallEventResult } from "../src/core/extensions/types.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

describe("tool_call veto composition", () => {
	it.each([false, true])(
		"retains termination=%s through mutation without leaking it into the next prompt",
		async (terminate) => {
			const reads = vi.fn((path: string) => readFile(path));
			const decision: ToolCallEventResult = { block: true, reason: "original veto", terminate };
			let calls = 0;
			const later = vi.fn(() => {
				decision.terminate = !terminate;
				decision.reason = "mutated veto";
				return { block: false };
			});
			const harness = await createHarness({
				initialActiveToolNames: ["read"],
				tools: [createReadTool(process.cwd(), { operations: { readFile: reads, access } })],
				extensionFactories: [
					(pi) => {
						pi.on("tool_call", () => (++calls === 1 ? decision : undefined));
						pi.on("tool_call", later);
					},
				],
			});
			const path = join(harness.tempDir, "fixture.txt");
			writeFileSync(path, "controlled fixture");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }),
				fauxAssistantMessage("The read was blocked."),
			]);
			await harness.session.prompt("Read the fixture.");
			expect(later).toHaveBeenCalledOnce();
			expect(reads).not.toHaveBeenCalled();
			expect(harness.faux.state.callCount).toBe(terminate ? 1 : 2);
			expect(harness.getPendingResponseCount()).toBe(terminate ? 1 : 0);
			const first = harness.eventsOfType("tool_execution_end");
			expect(first).toHaveLength(1);
			expect(first[0].isError).toBe(true);
			expect(first[0].result.terminate).toBe(terminate);
			expect(getMessageText(first[0].result)).toContain('"diagnostic":"original veto"');
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Read completed."),
			]);
			await harness.session.prompt("The next read is authorized.");
			expect(later).toHaveBeenCalledTimes(2);
			expect(reads.mock.calls.map(([path]) => path)).toEqual([path]);
			const terminals = harness.eventsOfType("tool_execution_end");
			expect(terminals).toHaveLength(2);
			expect(terminals[1].isError).toBe(false);
			expect(harness.getPendingResponseCount()).toBe(0);
		},
	);

	for (const separateExtensions of [false, true]) {
		it.each([
			{ first: "deny", second: "allow", blocked: true },
			{ first: "deny", second: "empty", blocked: true },
			{ first: "allow", second: "deny", blocked: true },
			{ first: "deny", second: "undefined", blocked: true },
			{ first: "allow", second: "empty", blocked: false },
			{ first: "undefined", second: "undefined", blocked: false },
			{ first: "deny", second: "deny", blocked: true },
			{ first: "deny", second: "mutate", blocked: true },
		] as const)(
			`preserves any explicit veto: $first then $second (separateExtensions=${separateExtensions})`,
			async ({ first, second, blocked }) => {
				const reads = vi.fn((path: string) => readFile(path));
				const trace: string[] = [];
				const firstVeto: ToolCallEventResult = { block: true, reason: "first veto", terminate: false };
				const factories: ExtensionFactory[] = [first, second].map((action, index) => (pi) => {
					pi.on("tool_call", () => {
						trace.push(`${index}:${action}`);
						if (action === "deny") return index === 0 ? firstVeto : { block: true, reason: "second veto" };
						if (action === "allow") return { block: false };
						if (action === "empty") return {};
						if (action === "mutate") {
							firstVeto.block = false;
							firstVeto.reason = "mutated after return";
						}
						return undefined;
					});
				});
				const harness = await createHarness({
					initialActiveToolNames: ["read"],
					tools: [createReadTool(process.cwd(), { operations: { readFile: reads, access } })],
					extensionFactories: separateExtensions
						? factories
						: [
								async (pi) => {
									for (const factory of factories) await factory(pi);
								},
							],
				});
				try {
					const path = join(harness.tempDir, "fixture.txt");
					writeFileSync(path, "controlled fixture");
					harness.setResponses([
						fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }),
						fauxAssistantMessage("Done."),
					]);
					await harness.session.prompt("Read the fixture.");
					expect(trace).toEqual([`0:${first}`, `1:${second}`]);
					const terminals = harness.eventsOfType("tool_execution_end");
					expect(terminals).toHaveLength(1);
					expect.soft(terminals[0].isError).toBe(blocked);
					expect.soft(reads.mock.calls.map(([path]) => path)).toEqual(blocked ? [] : [path]);
					const content: (TextContent | ImageContent)[] = terminals[0].result.content;
					const text = content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					if (blocked) expect(text).toContain(first === "deny" ? "first veto" : "second veto");
					else expect(text).toContain("controlled fixture");
				} finally {
					await harness.cleanup();
				}
			},
		);
	}
});
