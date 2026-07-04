/**
 * D2b-2: reference-release + cleanup lifecycle. Proves that once context-gc packs a
 * grep/find tool result out of live prompt context (no longer current/active working
 * context), the artifact reference registered at pack time is released, and cleanup()
 * reclaims the artifact if that was its last reference -- closing the accumulation/leak
 * gap left open by D2b-1 (references were registered but nothing ever released them).
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentMessage, compactToolResultDetailsForRetention } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createFileArtifactStore, isMissingArtifactMarker } from "../../src/core/context/context-artifacts.ts";
import { createHarness, type Harness } from "./harness.ts";

interface ToolDetailsLike {
	artifactId?: string;
}

function firstToolResultArtifactId(harness: Harness): string | undefined {
	for (const message of harness.session.messages) {
		if (message.role === "toolResult") {
			const details = (message as { details?: ToolDetailsLike }).details;
			if (details?.artifactId) return details.artifactId;
		}
	}
	return undefined;
}

function sessionArtifactDir(harness: Harness): string {
	return join(harness.tempDir, "context-artifacts", harness.sessionManager.getSessionId());
}

function bigGrepFile(harness: Harness): void {
	const lines: string[] = [];
	for (let i = 0; i < 3000; i++) lines.push(`needle occurrence number ${i} padded with extra text to add bytes`);
	writeFileSync(join(harness.tempDir, "big.txt"), lines.join("\n"));
}

describe("D2b-2: artifact reference release + cleanup tied to context-gc eviction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("releases the artifact reference and reclaims it once context-gc packs the grep result out of live context", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep"],
		});
		harnesses.push(harness);
		bigGrepFile(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "needle", path: "big.txt", limit: 3000, context: 0 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("search for needle occurrences");

		const artifactId = firstToolResultArtifactId(harness);
		expect(artifactId).toBeDefined();

		const artifactDir = sessionArtifactDir(harness);
		const storeRightAfterPack = createFileArtifactStore({ baseDir: artifactDir });
		expect(storeRightAfterPack.has(artifactId!)).toBe(true);
		expect(storeRightAfterPack.referenceCount(artifactId!)).toBeGreaterThan(0);

		// Drive enough additional plain (non-tool) turns for the grep tool result to fall
		// outside context-gc's preserveRecentMessages window (default 8), so context-gc's
		// own per-turn packing pass actually evicts it from live context.
		const plainResponses = Array.from({ length: 6 }, (_, i) => fauxAssistantMessage(`ok ${i}`));
		harness.setResponses(plainResponses);
		for (let i = 0; i < plainResponses.length; i++) {
			await harness.session.prompt(`continue ${i}`);
		}

		const storeAfterEviction = createFileArtifactStore({ baseDir: artifactDir });
		expect(storeAfterEviction.has(artifactId!)).toBe(false);
		const record = storeAfterEviction.read(artifactId!);
		expect(isMissingArtifactMarker(record)).toBe(true);
	});

	it("does not release or reclaim an artifact whose tool result is still within the recent-message window", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep"],
		});
		harnesses.push(harness);
		bigGrepFile(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "needle", path: "big.txt", limit: 3000, context: 0 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("search for needle occurrences");

		const artifactId = firstToolResultArtifactId(harness);
		expect(artifactId).toBeDefined();

		// Only one more turn -- nowhere near context-gc's preserveRecentMessages window, so
		// the grep result is still "current" and must not be released or collected.
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("continue");

		const artifactDir = sessionArtifactDir(harness);
		const store = createFileArtifactStore({ baseDir: artifactDir });
		expect(store.has(artifactId!)).toBe(true);
	});

	it("inspecting the context-gc report read-only (getContextGcReport) does not release or reclaim anything", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep"],
		});
		harnesses.push(harness);
		bigGrepFile(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "needle", path: "big.txt", limit: 3000, context: 0 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("search for needle occurrences");

		const artifactId = firstToolResultArtifactId(harness);
		expect(artifactId).toBeDefined();

		// Read-only status inspection must be side-effect-free, even if it would otherwise
		// report packing (writePayloads=false internally).
		harness.session.getContextGcReport(harness.session.messages);

		const artifactDir = sessionArtifactDir(harness);
		const store = createFileArtifactStore({ baseDir: artifactDir });
		expect(store.has(artifactId!)).toBe(true);
	});

	describe("retention/release coupling", () => {
		// The release path (_releaseGcPackedArtifactReferences) reads artifactId back off
		// the canonical session message at eviction time -- potentially many turns after
		// packing. message-retention.ts's compactToolResultDetailsForRetention replaces the
		// *entire* details object with a stub whenever it exceeds
		// MAX_RETAINED_TOOL_RESULT_DETAILS_BYTES (32KB), which would silently drop
		// artifactId and permanently break release/cleanup for that artifact. Today this
		// can't happen because grep.ts/find.ts empty out `truncation.content` before
		// storing it in `details` (see the comments there) -- this test pins that guarantee
		// down explicitly, independent of the dynamic multi-turn proof in the tests above.
		it("a packed grep/find details object survives compactToolResultDetailsForRetention (artifactId is not stripped)", () => {
			const message = {
				role: "toolResult" as const,
				toolCallId: "tc-1",
				toolName: "grep",
				content: [{ type: "text" as const, text: "some bounded preview text" }],
				details: {
					artifactId: "abc123def456abc123def456",
					matchLimitReached: 3000,
					truncation: {
						content: "", // emptied by grep.ts/find.ts before storing in details
						truncated: true,
						truncatedBy: "bytes" as const,
						totalLines: 50_000,
						totalBytes: 4_000_000,
						outputLines: 50_000,
						outputBytes: 51_200,
						lastLinePartial: false,
						firstLineExceedsLimit: false,
						maxLines: Number.MAX_SAFE_INTEGER,
						maxBytes: 51_200,
					},
				},
				isError: false,
				timestamp: 0,
			};

			compactToolResultDetailsForRetention(message);

			expect((message.details as { artifactId?: string }).artifactId).toBe("abc123def456abc123def456");
			expect(
				(message.details as { piToolResultDetailsTruncated?: boolean }).piToolResultDetailsTruncated,
			).toBeUndefined();
		});

		it("characterizes the failure mode the comment warns about: an oversized details object DOES lose artifactId", () => {
			// Not exercised by grep/find today (that's exactly what the content:"" fix
			// prevents) -- this documents why that fix matters, using the same retention
			// function real packed results pass through.
			const oversizedContent = "x".repeat(50_000);
			const message = {
				role: "toolResult" as const,
				toolCallId: "tc-2",
				toolName: "grep",
				content: [{ type: "text" as const, text: "preview" }],
				details: {
					artifactId: "should-be-lost",
					truncation: { content: oversizedContent, truncated: true },
				},
				isError: false,
				timestamp: 0,
			};

			compactToolResultDetailsForRetention(message);

			expect((message.details as { artifactId?: string }).artifactId).toBeUndefined();
			expect((message.details as { piToolResultDetailsTruncated?: boolean }).piToolResultDetailsTruncated).toBe(
				true,
			);
		});
	});

	describe("dispose() best-effort artifact sweep", () => {
		it("does not force-release a still-active reference (conservative -- preserves resumability)", async () => {
			const harness = await createHarness({
				initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep"],
			});
			// Not pushed to `harnesses`: this test calls session.dispose() itself, and
			// afterEach's harness.cleanup() would call dispose() a second time.
			try {
				bigGrepFile(harness);
				harness.setResponses([
					fauxAssistantMessage(
						[fauxToolCall("grep", { pattern: "needle", path: "big.txt", limit: 3000, context: 0 })],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("search for needle occurrences");
				const artifactId = firstToolResultArtifactId(harness);
				expect(artifactId).toBeDefined();
				const artifactDir = sessionArtifactDir(harness);

				harness.session.dispose();

				const store = createFileArtifactStore({ baseDir: artifactDir });
				expect(store.has(artifactId!)).toBe(true);
			} finally {
				harness.faux.unregister();
				if (existsSync(harness.tempDir)) rmSync(harness.tempDir, { recursive: true, force: true });
			}
		});

		it("reclaims an artifact that was already released but never swept (defensive final cleanup)", async () => {
			const harness = await createHarness({
				initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep"],
			});
			try {
				bigGrepFile(harness);
				harness.setResponses([
					fauxAssistantMessage(
						[fauxToolCall("grep", { pattern: "needle", path: "big.txt", limit: 3000, context: 0 })],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("search for needle occurrences");
				const artifactId = firstToolResultArtifactId(harness);
				expect(artifactId).toBeDefined();
				const artifactDir = sessionArtifactDir(harness);

				// Simulate a release that happened through some other path without its own
				// cleanup() call (e.g. a transient cleanup failure), by releasing the
				// reference directly against a second store instance over the same
				// directory, without calling cleanup().
				const toolResult = harness.session.messages.find(
					(message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult",
				);
				const externalStore = createFileArtifactStore({ baseDir: artifactDir });
				expect(externalStore.removeReference(artifactId!, toolResult!.toolCallId)).toBe(true);
				expect(externalStore.has(artifactId!)).toBe(true); // released, but not yet reclaimed

				harness.session.dispose();

				const storeAfterDispose = createFileArtifactStore({ baseDir: artifactDir });
				expect(storeAfterDispose.has(artifactId!)).toBe(false);
			} finally {
				harness.faux.unregister();
				if (existsSync(harness.tempDir)) rmSync(harness.tempDir, { recursive: true, force: true });
			}
		});
	});
});
