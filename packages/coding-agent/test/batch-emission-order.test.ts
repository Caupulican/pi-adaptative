import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHarness } from "./test-harness.ts";

/**
 * Emission order across a real parallel batch, driven through the real write and bash tools.
 *
 * Live symptom: `[write rotina.json, bash "tfps run rotina"]` in one assistant message ran the
 * command before the file existed, twice, and the model concluded the filesystem was slow and
 * started sleeping before every run. The batch is dispatched concurrently; `write` only joins the
 * mutation barrier's reader side deep inside its execute, after its own lease/credential preflight,
 * while bash reaches the exclusive barrier immediately and finds no reader to wait for.
 *
 * The fix is sequencing, never reordering: emission order is honored, so a command emitted BEFORE a
 * write still runs first and still fails on the missing file.
 */
describe("emission order inside one tool batch", () => {
	function toolResultText(harness: ReturnType<typeof createHarness>, toolCallId: string): string {
		const entry = harness.sessionManager
			.getBranch()
			.find(
				(branchEntry) =>
					branchEntry.type === "message" &&
					branchEntry.message.role === "toolResult" &&
					branchEntry.message.toolCallId === toolCallId,
			);
		if (entry?.type !== "message" || entry.message.role !== "toolResult") {
			throw new Error(`No tool result recorded for ${toolCallId}`);
		}
		return entry.message.content
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("\n")
			.trim();
	}

	it("a command emitted after a write in the same batch sees the written file", async () => {
		const harness = createHarness({
			responses: [
				{
					toolCalls: [
						{ id: "write-1", name: "write", args: { path: "emission.txt", content: "hello" } },
						// The command does NOT name the path: only the reservation-time announcement can
						// order these two, not the argument-text partition rule.
						{ id: "bash-1", name: "bash", args: { command: "cat *.txt" } },
					],
				},
				"done",
			],
		});
		try {
			await harness.session.prompt("write the file and read it back");
			expect(readFileSync(join(harness.tempDir, "emission.txt"), "utf8")).toBe("hello");
			expect(toolResultText(harness, "bash-1")).toContain("hello");
		} finally {
			await harness.cleanup();
		}
	});

	it("a command emitted before a write keeps emission order and fails on the missing file", async () => {
		const harness = createHarness({
			responses: [
				{
					toolCalls: [
						{ id: "bash-1", name: "bash", args: { command: "cat before.txt" } },
						{ id: "write-1", name: "write", args: { path: "before.txt", content: "late" } },
					],
				},
				"done",
			],
		});
		try {
			await harness.session.prompt("read it back and write it");
			// Sequencing, never reordering: the write is not pulled forward to satisfy the command.
			expect(toolResultText(harness, "bash-1")).toMatch(/No such file|cannot open|not found/i);
			expect(readFileSync(join(harness.tempDir, "before.txt"), "utf8")).toBe("late");
		} finally {
			await harness.cleanup();
		}
	});

	it("a write rejected by its own preflight does not park a later command in the same batch", async () => {
		const harness = createHarness({
			responses: [
				{
					toolCalls: [
						// write is create-only: this collides and never reaches the mutation queue at all.
						{ id: "write-1", name: "write", args: { path: "taken.txt", content: "new" } },
						{ id: "bash-1", name: "bash", args: { command: "cat *.txt" } },
					],
				},
				"done",
			],
		});
		try {
			writeFileSync(join(harness.tempDir, "taken.txt"), "original", "utf8");
			await harness.session.prompt("write the file and read it back");
			expect(toolResultText(harness, "bash-1")).toContain("original");
		} finally {
			await harness.cleanup();
		}
	});

	it("a call naming an earlier sibling's write target runs after that write has landed", async () => {
		const harness = createHarness({
			responses: [
				{
					toolCalls: [
						{ id: "write-1", name: "write", args: { path: "named.txt", content: "landed" } },
						{ id: "read-1", name: "read", args: { path: "named.txt" } },
					],
				},
				"done",
			],
		});
		try {
			await harness.session.prompt("write the file and read it");
			expect(toolResultText(harness, "read-1")).toContain("landed");
		} finally {
			await harness.cleanup();
		}
	});
});
