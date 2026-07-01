import { describe, expect, it } from "vitest";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import { createArtifactRetrieveTool } from "../src/core/tools/artifact-retrieve.ts";

interface TextContentLike {
	type: "text";
	text: string;
}

interface ToolResultLike {
	content: Array<TextContentLike | { type: string }>;
	details?: { found: boolean; mode: string };
}

function toToolResult(result: unknown): ToolResultLike {
	return result as ToolResultLike;
}

function getText(result: ToolResultLike): string {
	const part = result.content.find((c): c is TextContentLike => c.type === "text");
	return part?.text ?? "";
}

function writeArtifact(store: ReturnType<typeof createInMemoryArtifactStore>, content: string) {
	return store.write({
		kind: "tool_output",
		content,
		toolName: "grep",
		command: "grep -rn pattern",
		path: "src",
		createdAtTurn: 1,
		reproducible: true,
	});
}

describe("createArtifactRetrieveTool", () => {
	it("reports unavailable when no artifact store is configured", async () => {
		const tool = createArtifactRetrieveTool(process.cwd());
		const result = toToolResult(await tool.execute("tc-1", { artifactId: "any-id" }, undefined, undefined));

		expect(result.details?.found).toBe(false);
		expect(getText(result)).toContain("No artifact store is configured");
	});

	it("returns an explicit not-found message for an unknown id, never fabricated content", async () => {
		const store = createInMemoryArtifactStore();
		const tool = createArtifactRetrieveTool(process.cwd(), { artifactStore: store });
		const result = toToolResult(await tool.execute("tc-2", { artifactId: "never-written" }, undefined, undefined));

		expect(result.details?.found).toBe(false);
		expect(getText(result)).toContain("Artifact not found");
		expect(getText(result)).toContain("never-written");
	});

	it("resolves an id with the 'tool-output:' prefix stripped, matching the notice format", async () => {
		const store = createInMemoryArtifactStore();
		const { ref } = writeArtifact(store, "line one\nline two");
		const tool = createArtifactRetrieveTool(process.cwd(), { artifactStore: store });

		const result = toToolResult(
			await tool.execute("tc-3", { artifactId: `tool-output:${ref.id}` }, undefined, undefined),
		);

		expect(result.details?.found).toBe(true);
		expect(getText(result)).toContain("line one");
	});

	it("returns metadata only (no content) in metadata mode", async () => {
		const store = createInMemoryArtifactStore();
		const { ref } = writeArtifact(store, "line one\nline two");
		const tool = createArtifactRetrieveTool(process.cwd(), { artifactStore: store });

		const result = toToolResult(
			await tool.execute("tc-4", { artifactId: ref.id, mode: "metadata" }, undefined, undefined),
		);

		expect(result.details).toEqual({ found: true, mode: "metadata" });
		const text = getText(result);
		expect(text).toContain("tool: grep");
		expect(text).toContain("path: src");
		expect(text).not.toContain("line one");
	});

	it("defaults to head mode and bounds the slice", async () => {
		const store = createInMemoryArtifactStore();
		const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
		const { ref } = writeArtifact(store, lines.join("\n"));
		const tool = createArtifactRetrieveTool(process.cwd(), { artifactStore: store });

		const result = toToolResult(await tool.execute("tc-5", { artifactId: ref.id }, undefined, undefined));

		expect(result.details?.mode).toBe("head");
		const text = getText(result);
		expect(text).toContain("line 0");
		expect(text).not.toContain("line 499");
		expect(text).toContain("Showing head");
	});

	it("supports tail mode", async () => {
		const store = createInMemoryArtifactStore();
		const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
		const { ref } = writeArtifact(store, lines.join("\n"));
		const tool = createArtifactRetrieveTool(process.cwd(), { artifactStore: store });

		const result = toToolResult(
			await tool.execute("tc-6", { artifactId: ref.id, mode: "tail" }, undefined, undefined),
		);

		expect(getText(result)).toContain("line 499");
	});

	it("does not append a truncation footer when the content fits fully within bounds", async () => {
		const store = createInMemoryArtifactStore();
		const { ref } = writeArtifact(store, "short content");
		const tool = createArtifactRetrieveTool(process.cwd(), { artifactStore: store });

		const result = toToolResult(await tool.execute("tc-7", { artifactId: ref.id }, undefined, undefined));

		expect(getText(result)).toBe("short content");
	});
});
