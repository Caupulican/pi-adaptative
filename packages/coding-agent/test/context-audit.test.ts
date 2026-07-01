import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type ArtifactStore,
	createFileArtifactStore,
	createInMemoryArtifactStore,
} from "../src/core/context/context-artifacts.ts";
import { buildToolResultContextItem, runContextAudit } from "../src/core/context/context-audit.ts";

function toolResultMessage(overrides: { toolCallId: string; toolName?: string; text?: string; artifactId?: string }) {
	return {
		role: "toolResult" as const,
		toolCallId: overrides.toolCallId,
		toolName: overrides.toolName ?? "grep",
		content: [{ type: "text" as const, text: overrides.text ?? "some tool output" }],
		details: overrides.artifactId ? { artifactId: overrides.artifactId } : undefined,
		isError: false,
		timestamp: 0,
	};
}

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: 0 };
}

describe("context-audit: buildToolResultContextItem", () => {
	it("maps an artifact-backed toolResult to an item with resolved artifact evidence", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: "x".repeat(100_000),
			toolName: "grep",
			createdAtTurn: 3,
			reproducible: true,
		});

		const message = toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id });
		const item = buildToolResultContextItem(message, 5, { turnIndex: 3, artifactStore: store });

		expect(item.kind).toBe("tool_output");
		expect(item.retentionClass).toBe("ephemeral");
		expect(item.primaryRef).toEqual({ type: "artifact", ref });
	});

	it("does not claim artifact evidence when the artifact id is missing from the store", () => {
		const store = createInMemoryArtifactStore();
		const message = toolResultMessage({ toolCallId: "tc-1", artifactId: "never-written" });
		const item = buildToolResultContextItem(message, 0, { turnIndex: 0, artifactStore: store });

		expect(item.primaryRef).toBeUndefined();
	});

	it("attaches a transcript ref as primary evidence when a session-entry id resolves and there is no artifact", () => {
		const message = toolResultMessage({ toolCallId: "tc-1" });
		const item = buildToolResultContextItem(message, 2, {
			turnIndex: 0,
			sessionEntryIdForToolCallId: (id) => (id === "tc-1" ? "entry-1" : undefined),
		});

		expect(item.primaryRef).toEqual({ type: "transcript", ref: { sessionEntryId: "entry-1", messageIndex: 2 } });
	});

	it("uses the artifact's real capture turn for createdAtTurn, not the current audit turn", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: "x".repeat(100_000),
			toolName: "grep",
			createdAtTurn: 3,
			reproducible: true,
		});

		const message = toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id });
		const item = buildToolResultContextItem(message, 0, { turnIndex: 9, artifactStore: store });

		expect(item.createdAtTurn).toBe(3);
	});

	it("falls back to the current audit turn for a transcript-only item (no real creation-turn source yet)", () => {
		const message = toolResultMessage({ toolCallId: "tc-1" });
		const item = buildToolResultContextItem(message, 0, {
			turnIndex: 9,
			sessionEntryIdForToolCallId: () => "entry-1",
		});

		expect(item.createdAtTurn).toBe(9);
	});
});

describe("context-audit: runContextAudit", () => {
	it("gives an artifact-backed grep result an available retrieval path (no missing_retrieval_path)", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: "y".repeat(100_000),
			toolName: "grep",
			createdAtTurn: 1,
			reproducible: true,
		});
		const messages = [toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id })];

		const report = runContextAudit(messages, { turnIndex: 1, artifactStore: store });

		expect(report.items).toHaveLength(1);
		const [entry] = report.items;
		expect(entry.dropFromPromptHardConstraints).not.toContain("missing_retrieval_path");
		expect(entry.packToArtifactHardConstraints).not.toContain("missing_retrieval_path");
		expect(entry.retention.allowedActions).toContain("drop_from_prompt");
	});

	it("gives a normal (non-artifact) tool result conservative treatment even with a resolvable transcript ref", () => {
		const messages = [toolResultMessage({ toolCallId: "tc-1", toolName: "read", text: "small file contents" })];

		const report = runContextAudit(messages, {
			turnIndex: 0,
			artifactStore: createInMemoryArtifactStore(),
			sessionEntryIdForToolCallId: () => "entry-1",
		});

		expect(report.items).toHaveLength(1);
		const [entry] = report.items;
		// A transcript ref is attached (provenance), but it must not be mistaken for a live
		// retrieval mechanism: dropping this content is still flagged as unsafe.
		expect(entry.item.primaryRef).toEqual({
			type: "transcript",
			ref: { sessionEntryId: "entry-1", messageIndex: 0 },
		});
		expect(entry.dropFromPromptHardConstraints).toContain("missing_retrieval_path");
	});

	it("rejects pack_to_artifact when no artifact store is available at all", () => {
		const messages = [toolResultMessage({ toolCallId: "tc-1" })];
		const report = runContextAudit(messages, { turnIndex: 0 });

		const [entry] = report.items;
		expect(entry.packToArtifactHardConstraints).toContain("missing_retrieval_path");
		expect(entry.dropFromPromptHardConstraints).toContain("missing_retrieval_path");
	});

	it("skips non-toolResult messages", () => {
		const messages = [userMessage("hello"), toolResultMessage({ toolCallId: "tc-1" })];
		const report = runContextAudit(messages, { turnIndex: 0 });
		expect(report.items).toHaveLength(1);
	});

	it("is deterministic across repeated calls with the same messages and store state", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: "z".repeat(100_000),
			toolName: "find",
			createdAtTurn: 2,
			reproducible: true,
		});
		const messages = [
			toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id }),
			toolResultMessage({ toolCallId: "tc-2", toolName: "read" }),
		];

		const first = runContextAudit(messages, { turnIndex: 2, artifactStore: store });
		const second = runContextAudit(messages, { turnIndex: 2, artifactStore: store });

		expect(second).toEqual(first);
	});

	it("never calls the store's payload-loading read() against a real file store, only readRef()", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-context-audit-"));
		try {
			const fileStore = createFileArtifactStore({ baseDir });
			let readCalls = 0;
			const spyStore: ArtifactStore = {
				...fileStore,
				read(id) {
					readCalls++;
					return fileStore.read(id);
				},
			};

			// Large enough that a payload read would be an obvious, measurable cost -- the
			// point of this test is that it never happens at all during an audit pass.
			const { ref } = fileStore.write({
				kind: "tool_output",
				content: "q".repeat(5_000_000),
				toolName: "grep",
				createdAtTurn: 4,
				reproducible: true,
			});
			const messages = [toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id })];

			const report = runContextAudit(messages, { turnIndex: 4, artifactStore: spyStore });

			expect(readCalls).toBe(0);
			expect(report.items[0]?.item.primaryRef).toEqual({ type: "artifact", ref });
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
