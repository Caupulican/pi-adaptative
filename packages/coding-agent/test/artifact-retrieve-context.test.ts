import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { ToolResultMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { applyContextGc } from "../src/core/context-gc.ts";
import { createArtifactRetrieveTool } from "../src/core/tools/artifact-retrieve.ts";

/**
 * A context-GC packed stub names its original as `artifact_retrieve context:<key>`; the tool resolves
 * that key only inside the owning session's GC store, returns bounded slices, keeps the original tool's
 * trust wrapping, and answers a reclaimed original as expired.
 */
const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function gcDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-gc-retrieve-"));
	dirs.push(dir);
	return dir;
}

function toolResult(index: number, toolName: string, text: string, details?: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${index}`,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: index,
		...(details ? { details } : {}),
	};
}

function pack(storageDir: string, messages: AgentMessage[]) {
	return applyContextGc(messages, {
		cwd: "/repo",
		preserveRecentMessages: 0,
		minToolResultChars: 10,
		tools: ["bash", "webfetch", "artifact_retrieve"],
		writePayloads: true,
		storageDir,
		semanticMemory: { preserveRecentPages: 0, minChars: Number.MAX_SAFE_INTEGER },
		frozenBelow: 0,
	});
}

const LINES = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");

async function retrieve(dir: string, args: Record<string, unknown>) {
	const tool = createArtifactRetrieveTool("/repo", { getContextStoreDir: () => dir });
	const result = await tool.execute("retrieve", args as never);
	const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	return { text, details: result.details as { found: boolean; retrievedKey?: string } };
}

describe("artifact_retrieve context:<key>", () => {
	it("names the original in the packed stub and returns head, offset and metadata slices", async () => {
		const dir = gcDir();
		const packed = pack(dir, [toolResult(0, "bash", LINES)]);
		const key = packed.report.records[0]?.key;
		expect(key).toMatch(/^[0-9a-f]{24}$/);
		const stub = (packed.messages[0] as ToolResultMessage).content[0];
		expect(stub?.type === "text" && stub.text).toContain(`exact old text: artifact_retrieve context:${key}`);

		const head = await retrieve(dir, { artifactId: `context:${key}`, maxLines: 2 });
		expect(head.text).toContain("line 1\nline 2");
		expect(head.text).toContain("of 50 lines");
		expect(head.details).toMatchObject({ found: true, retrievedKey: key });

		const offset = await retrieve(dir, { artifactId: `context:${key}`, mode: "offset", offset: 10, maxLines: 3 });
		expect(offset.text).toContain("line 10\nline 11\nline 12");
		expect(offset.text).toContain("lines 10 to 12 of 50");

		const metadata = await retrieve(dir, { artifactId: `context:${key}`, mode: "metadata" });
		expect(metadata.text).toContain("tool: bash");
		expect(metadata.text).toContain("lines: 50");
	});

	it("resolves only exact 24-hex keys, so an id cannot leave the store", async () => {
		const dir = gcDir();
		for (const bad of ["../../etc/passwd", `${"a".repeat(24)}/../x`, "A".repeat(24), "abc"]) {
			const result = await retrieve(dir, { artifactId: `context:${bad}` });
			expect(result.details.found).toBe(false);
			expect(result.text).toContain("Invalid context key");
		}
	});

	it("answers a reclaimed original as expired with its recovery", async () => {
		const dir = gcDir();
		const key = pack(dir, [toolResult(0, "bash", LINES)]).report.records[0]?.key;
		unlinkSync(join(dir, `${key}.txt`));
		const result = await retrieve(dir, { artifactId: `context:${key}` });
		expect(result.details.found).toBe(false);
		expect(result.text).toContain("expired");
		expect(result.text).toContain("Rerun the command");
	});

	it("keeps the original tool's trust wrapping", async () => {
		const dir = gcDir();
		const key = pack(dir, [toolResult(0, "webfetch", LINES)]).report.records[0]?.key;
		const result = await retrieve(dir, { artifactId: `context:${key}` });
		expect(result.text).toContain("untrusted");
	});

	it("packs a retrieved slice back to the original's key without storing a copy", async () => {
		const dir = gcDir();
		const key = pack(dir, [toolResult(0, "bash", LINES)]).report.records[0]?.key;
		const slice = toolResult(1, "artifact_retrieve", `line 1\n${"x".repeat(40)}`, {
			found: true,
			mode: "head",
			retrievedKey: key,
		});
		const repacked = pack(dir, [slice]);
		expect(repacked.report.records[0]).toMatchObject({ key, retrieved: true });
		const original = await retrieve(dir, { artifactId: `context:${key}`, maxLines: 1 });
		expect(original.text).toContain("line 1");
		expect(original.text).toContain("of 50 lines");
	});
});
