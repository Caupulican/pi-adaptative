/**
 * D2a: proves the live grep/find tool construction in agent-session.ts actually wires a
 * session-scoped, filesystem-backed ArtifactStore -- not just that the ArtifactStore
 * interface/implementation works in isolation (that's covered by
 * test/context-artifacts-file-store.test.ts).
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createFileArtifactStore, isMissingArtifactMarker } from "../../src/core/context/context-artifacts.ts";
import { createArtifactRetrieveTool } from "../../src/core/tools/artifact-retrieve.ts";
import { createHarness, type Harness } from "./harness.ts";

interface ToolDetailsLike {
	artifactId?: string;
}

interface TextContentLike {
	type: "text";
	text: string;
}

function getResultText(result: unknown): string {
	const content = (result as { content: Array<TextContentLike | { type: string }> }).content;
	const part = content.find((c): c is TextContentLike => c.type === "text");
	return part?.text ?? "";
}

function findToolResultDetails(harness: Harness): ToolDetailsLike | undefined {
	const toolResult = harness.session.messages.find(
		(message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult",
	);
	return toolResult?.details as ToolDetailsLike | undefined;
}

function sessionArtifactDir(harness: Harness): string {
	return join(harness.tempDir, "context-artifacts", harness.sessionManager.getSessionId());
}

describe("AgentSession live tool construction wires a session-scoped file ArtifactStore into grep/find", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("a large live grep result writes payload+meta under the session artifact directory, readable by a recreated store", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep", "find"],
		});
		harnesses.push(harness);

		const lines: string[] = [];
		for (let i = 0; i < 3000; i++) lines.push(`needle occurrence number ${i} padded with extra text to add bytes`);
		writeFileSync(join(harness.tempDir, "big.txt"), lines.join("\n"));

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "needle", path: "big.txt", limit: 3000, context: 0 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("search for needle occurrences");

		const details = findToolResultDetails(harness);
		expect(details?.artifactId).toBeDefined();
		const artifactId = details!.artifactId!;

		const artifactDir = sessionArtifactDir(harness);
		expect(existsSync(join(artifactDir, `${artifactId}.payload`))).toBe(true);
		expect(existsSync(join(artifactDir, `${artifactId}.meta.json`))).toBe(true);

		// Recreate the store fresh (simulating a process restart) and confirm the exact
		// raw grep output (all 3000 matches, not the bounded preview the model saw) is
		// still retrievable.
		const recreatedStore = createFileArtifactStore({ baseDir: artifactDir });
		const record = recreatedStore.read(artifactId);
		expect(isMissingArtifactMarker(record)).toBe(false);
		if (!isMissingArtifactMarker(record)) {
			expect(record.content).toContain("needle occurrence number 2999");
			expect(record.content.split("\n").length).toBe(3001); // file header + 3000 matches
			expect(record.ref.toolName).toBe("grep");
		}
	});

	it("a large live find result writes payload+meta under the session artifact directory, readable by a recreated store", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep", "find"],
		});
		harnesses.push(harness);

		const fileCount = 6000;
		for (let i = 0; i < fileCount; i++) {
			writeFileSync(join(harness.tempDir, `file-with-a-longer-name-${i}.txt`), "x");
		}

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("find", { pattern: "*.txt", path: ".", limit: fileCount + 1000 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("find all txt files");

		const details = findToolResultDetails(harness);
		expect(details?.artifactId).toBeDefined();
		const artifactId = details!.artifactId!;

		const artifactDir = sessionArtifactDir(harness);
		const recreatedStore = createFileArtifactStore({ baseDir: artifactDir });
		const record = recreatedStore.read(artifactId);
		expect(isMissingArtifactMarker(record)).toBe(false);
		if (!isMissingArtifactMarker(record)) {
			expect(record.content).toContain(`file-with-a-longer-name-${fileCount - 1}.txt`);
			expect(record.ref.toolName).toBe("find");
		}
	});

	it("a small live grep result is never packed to disk", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep", "find"],
		});
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "small.txt"), "first line\nmatch line\nlast line");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "match", path: "small.txt" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("search for match");

		const details = findToolResultDetails(harness);
		expect(details?.artifactId).toBeUndefined();
		// createFileArtifactStore() creates baseDir immediately at tool-construction time
		// (agent-session.ts builds it whether or not any artifact is ever written), so the
		// directory existing is expected; the assertion is that it holds no artifact files.
		const artifactDir = sessionArtifactDir(harness);
		expect(existsSync(artifactDir)).toBe(true);
		expect(readdirSync(artifactDir)).toEqual([]);
	});

	it("a small live find result is never packed to disk", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep", "find"],
		});
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "small.txt"), "content");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("find", { pattern: "*.txt", path: "." })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("find txt files");

		const details = findToolResultDetails(harness);
		expect(details?.artifactId).toBeUndefined();
		const artifactDir = sessionArtifactDir(harness);
		expect(existsSync(artifactDir)).toBe(true);
		expect(readdirSync(artifactDir)).toEqual([]);
	});

	it("an artifact from an earlier tool call survives a later, unrelated tool call in the same session (current behavior: accumulates without release/cleanup)", async () => {
		// packToolOutput() does register a reference at pack time (toolCallId as holder),
		// so this is NOT "unreferenced and about to be swept" -- it's the opposite risk:
		// nothing ever calls removeReference()/cleanup() in live code, so referenced
		// artifacts accumulate for the whole session with no reclamation. This test pins
		// down today's behavior (survives across turns, including once a completely
		// different tool runs) so D2b's lifecycle work has a concrete regression baseline
		// instead of just a design description.
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep", "find", "ls"],
		});
		harnesses.push(harness);

		const lines: string[] = [];
		for (let i = 0; i < 3000; i++) lines.push(`needle occurrence number ${i} padded with extra text to add bytes`);
		writeFileSync(join(harness.tempDir, "big.txt"), lines.join("\n"));

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "needle", path: "big.txt", limit: 3000, context: 0 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
			// A genuinely unrelated second tool call (ls, not another grep), to prove the
			// first grep's artifact isn't tied to or affected by grep-specific state.
			fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done again"),
		]);

		await harness.session.prompt("search once");
		const firstArtifactId = findToolResultDetails(harness)?.artifactId;
		expect(firstArtifactId).toBeDefined();

		await harness.session.prompt("now list the directory");

		// The first artifact must still be on disk: nothing in this slice deletes it.
		const artifactDir = sessionArtifactDir(harness);
		expect(existsSync(join(artifactDir, `${firstArtifactId}.payload`))).toBe(true);
	});

	it("a live-packed grep artifact id is retrievable through artifact_retrieve after recreating the file store", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep", "find"],
		});
		harnesses.push(harness);

		const lines: string[] = [];
		for (let i = 0; i < 3000; i++) lines.push(`needle occurrence number ${i} padded with extra text to add bytes`);
		writeFileSync(join(harness.tempDir, "big.txt"), lines.join("\n"));

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "needle", path: "big.txt", limit: 3000, context: 0 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("search for needle occurrences");
		const artifactId = findToolResultDetails(harness)?.artifactId;
		expect(artifactId).toBeDefined();

		// Recreate the store fresh (simulating a process restart) and resolve the id
		// through the retrieval TOOL, not just the raw ArtifactStore API -- this is what
		// makes the "Full output: artifact tool-output:<id>" notice actually actionable.
		const artifactDir = sessionArtifactDir(harness);
		const recreatedStore = createFileArtifactStore({ baseDir: artifactDir });
		const retrieveTool = createArtifactRetrieveTool(harness.tempDir, { artifactStore: recreatedStore });

		const metadataResult = await retrieveTool.execute(
			"tc-retrieve-metadata",
			{ artifactId: artifactId!, mode: "metadata" },
			undefined,
			undefined,
		);
		expect(getResultText(metadataResult)).toContain("tool: grep");

		const headResult = await retrieveTool.execute(
			"tc-retrieve-head",
			{ artifactId: artifactId!, mode: "head" },
			undefined,
			undefined,
		);
		expect(getResultText(headResult)).toContain("needle occurrence number 0");

		const tailResult = await retrieveTool.execute(
			"tc-retrieve-tail",
			{ artifactId: artifactId!, mode: "tail" },
			undefined,
			undefined,
		);
		expect(getResultText(tailResult)).toContain("needle occurrence number 2999");
	});

	it("activating grep without explicitly listing artifact_retrieve auto-activates it, and a live packed id is retrievable through it in the same session", async () => {
		// Deliberately omit "artifact_retrieve" and "find" from the requested set -- only
		// "grep" is explicitly requested, to prove the companion tool is auto-activated
		// rather than needing to be listed itself.
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep"],
		});
		harnesses.push(harness);

		expect(harness.session.getActiveToolNames()).toContain("artifact_retrieve");

		const lines: string[] = [];
		for (let i = 0; i < 3000; i++) lines.push(`needle occurrence number ${i} padded with extra text to add bytes`);
		writeFileSync(join(harness.tempDir, "big.txt"), lines.join("\n"));

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "needle", path: "big.txt", limit: 3000, context: 0 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("search for needle occurrences");
		const artifactId = findToolResultDetails(harness)?.artifactId;
		expect(artifactId).toBeDefined();

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("artifact_retrieve", { artifactId, mode: "head" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("retrieved"),
		]);
		await harness.session.prompt("retrieve the full grep output via artifact_retrieve");

		const toolResults = harness.session.messages.filter(
			(message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult",
		);
		const retrieveResult = toolResults[toolResults.length - 1];
		expect(retrieveResult?.toolName).toBe("artifact_retrieve");
		expect(getResultText(retrieveResult)).toContain("needle occurrence number 0");
	});

	it("blocking artifact_retrieve prevents grep from writing artifact files or emitting a retrieval handle", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep", "find"],
			excludedToolNames: ["artifact_retrieve"],
		});
		harnesses.push(harness);

		expect(harness.session.getActiveToolNames()).not.toContain("artifact_retrieve");

		const lines: string[] = [];
		for (let i = 0; i < 3000; i++) lines.push(`needle occurrence number ${i} padded with extra text to add bytes`);
		writeFileSync(join(harness.tempDir, "big.txt"), lines.join("\n"));

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "needle", path: "big.txt", limit: 3000, context: 0 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("search for needle occurrences");

		const details = findToolResultDetails(harness);
		expect(details?.artifactId).toBeUndefined();
		const output = getResultText(
			harness.session.messages.find(
				(message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult",
			),
		);
		expect(output).not.toContain("artifact tool-output:");
		// The output is still truncated/bounded (byte cap unaffected), just never packed
		// to disk -- no false retrieval promise.
		expect(output).toContain("KB limit reached");

		const artifactDir = sessionArtifactDir(harness);
		if (existsSync(artifactDir)) {
			expect(
				readdirSync(artifactDir).filter((name) => name.endsWith(".payload") || name.endsWith(".meta.json")),
			).toEqual([]);
		}
	});

	describe("companion activation cannot be bypassed via the direct setActiveToolsByName() path", () => {
		// setActiveToolsByName() is a public, extension-exposed activation path
		// (`setActiveTools` in the extension context) on its own, independent of the
		// settings/profile refresh flow (_refreshToolRegistry). A prior version of this
		// fix only enforced the grep/find <-> artifact_retrieve coupling inside
		// _refreshToolRegistry, so calling setActiveToolsByName() directly could leave
		// grep active with an artifact store (gated on "allowed", not "active") but
		// artifact_retrieve inactive -- reproducing the exact dangling-handle bug this
		// slice exists to prevent. These tests exercise that direct path specifically.

		it("setActiveToolsByName(['find']) alone (grep not requested) also auto-activates artifact_retrieve", async () => {
			// Symmetry check: the companion condition is includes("grep") || includes("find"),
			// so "find" alone must trigger it too, not just "grep".
			const harness = await createHarness({
				initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal"],
			});
			harnesses.push(harness);
			expect(harness.session.getActiveToolNames()).not.toContain("find");

			harness.session.setActiveToolsByName(["read", "bash", "edit", "write", "context_audit", "goal", "find"]);

			expect(harness.session.getActiveToolNames()).toContain("find");
			expect(harness.session.getActiveToolNames()).toContain("artifact_retrieve");
		});

		it("setActiveToolsByName(['grep']) alone auto-activates artifact_retrieve, and a live packed id is retrievable", async () => {
			const harness = await createHarness({
				initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal"],
			});
			harnesses.push(harness);
			expect(harness.session.getActiveToolNames()).not.toContain("grep");

			harness.session.setActiveToolsByName(["read", "bash", "edit", "write", "context_audit", "goal", "grep"]);

			expect(harness.session.getActiveToolNames()).toContain("grep");
			expect(harness.session.getActiveToolNames()).toContain("artifact_retrieve");

			const lines: string[] = [];
			for (let i = 0; i < 3000; i++) lines.push(`needle occurrence number ${i} padded with extra text to add bytes`);
			writeFileSync(join(harness.tempDir, "big.txt"), lines.join("\n"));

			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("grep", { pattern: "needle", path: "big.txt", limit: 3000, context: 0 })],
					{
						stopReason: "toolUse",
					},
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("search for needle occurrences");
			const artifactId = findToolResultDetails(harness)?.artifactId;
			expect(artifactId).toBeDefined();

			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("artifact_retrieve", { artifactId, mode: "head" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("retrieved"),
			]);
			await harness.session.prompt("retrieve the full grep output via artifact_retrieve");

			const toolResults = harness.session.messages.filter(
				(message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult",
			);
			const retrieveResult = toolResults[toolResults.length - 1];
			expect(retrieveResult?.toolName).toBe("artifact_retrieve");
			expect(getResultText(retrieveResult)).toContain("needle occurrence number 0");
		});

		it("setActiveToolsByName(['grep']) with artifact_retrieve excluded does not activate it, and grep never packs", async () => {
			const harness = await createHarness({
				initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal"],
				excludedToolNames: ["artifact_retrieve"],
			});
			harnesses.push(harness);

			harness.session.setActiveToolsByName(["read", "bash", "edit", "write", "context_audit", "goal", "grep"]);

			expect(harness.session.getActiveToolNames()).toContain("grep");
			expect(harness.session.getActiveToolNames()).not.toContain("artifact_retrieve");

			const lines: string[] = [];
			for (let i = 0; i < 3000; i++) lines.push(`needle occurrence number ${i} padded with extra text to add bytes`);
			writeFileSync(join(harness.tempDir, "big.txt"), lines.join("\n"));

			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("grep", { pattern: "needle", path: "big.txt", limit: 3000, context: 0 })],
					{
						stopReason: "toolUse",
					},
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("search for needle occurrences");

			const details = findToolResultDetails(harness);
			expect(details?.artifactId).toBeUndefined();
			const output = getResultText(
				harness.session.messages.find(
					(message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult",
				),
			);
			expect(output).not.toContain("artifact tool-output:");
			expect(output).toContain("KB limit reached");

			const artifactDir = sessionArtifactDir(harness);
			if (existsSync(artifactDir)) {
				expect(
					readdirSync(artifactDir).filter((name) => name.endsWith(".payload") || name.endsWith(".meta.json")),
				).toEqual([]);
			}
		});
	});
});
