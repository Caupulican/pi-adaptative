import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextPipeline, type ContextPipelineDeps, latestUserPromptText } from "../src/core/context-pipeline.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function toolResultEntry(id: string, parentId: string | null, toolCallId: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-13T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: id }],
			isError: false,
			timestamp: 0,
		},
	};
}

function createPipeline(sessionManager: SessionManager): ContextPipeline {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-context-entry-lookup-"));
	tempDirs.push(agentDir);
	return new ContextPipeline({
		getTurnIndex: () => 1,
		getSessionManager: () => sessionManager,
		getSettingsManager: () => ({}) as ReturnType<ContextPipelineDeps["getSettingsManager"]>,
		getModelRegistry: () => ({}) as ReturnType<ContextPipelineDeps["getModelRegistry"]>,
		getModel: () => undefined,
		getAgentDir: () => agentDir,
		getCwd: () => agentDir,
		getActiveToolNames: () => [],
		isDisposed: () => false,
		getMemoryManager: () => ({}) as ReturnType<ContextPipelineDeps["getMemoryManager"]>,
		addSpawnedUsage: () => undefined,
		runIsolatedCompletion: async () => {
			throw new Error("not used");
		},
	});
}

describe("latestUserPromptText", () => {
	it("bounds large prompt blocks before concatenating them", () => {
		expect(
			latestUserPromptText(
				[
					{
						role: "user",
						content: [
							{ type: "text", text: "first" },
							{ type: "text", text: "second-large-block" },
						],
						timestamp: 1,
					},
				],
				8,
			),
		).toBe("first\nse");
	});
});

describe("ContextPipeline session-entry lookup", () => {
	it("finds the nearest compaction without rebuilding the full branch", () => {
		const compaction: SessionEntry = {
			type: "compaction",
			id: "compaction-1",
			parentId: null,
			timestamp: "2026-07-13T00:00:00.000Z",
			summary: "summary",
			firstKeptEntryId: "entry-1",
			tokensBefore: 10_000,
		};
		const getBranch = vi.fn(() => [compaction]);
		const sessionManager = {
			getSessionId: () => "session",
			getLeafId: () => compaction.id,
			getEntry: (id: string) => (id === compaction.id ? compaction : undefined),
			getBranch,
		} as unknown as SessionManager;
		const pipeline = createPipeline(sessionManager);
		const latestCompaction = (
			pipeline as unknown as { _getLatestCompactionEntry(): SessionEntry | null }
		)._getLatestCompactionEntry.call(pipeline);

		expect(latestCompaction?.id).toBe(compaction.id);
		expect(getBranch).not.toHaveBeenCalled();
	});

	it("updates a linear branch incrementally and rebuilds after a branch switch", () => {
		const first = toolResultEntry("entry-1", null, "call-1");
		const second = toolResultEntry("entry-2", first.id, "call-2");
		const alternate = toolResultEntry("entry-alt", null, "call-alt");
		let leafId: string | null = first.id;
		let branch: SessionEntry[] = [first];
		const entries = new Map<string, SessionEntry>([
			[first.id, first],
			[second.id, second],
			[alternate.id, alternate],
		]);
		const getBranch = vi.fn(() => branch);
		const sessionManager = {
			getSessionId: () => "session",
			getLeafId: () => leafId,
			getEntry: (id: string) => entries.get(id),
			getBranch,
		} as unknown as SessionManager;
		const pipeline = createPipeline(sessionManager);
		const buildLookup = (
			pipeline as unknown as {
				_buildSessionEntryIdLookup(
					wantedToolCallIds: ReadonlySet<string>,
				): (toolCallId: string) => string | undefined;
			}
		)._buildSessionEntryIdLookup.bind(pipeline);

		expect(buildLookup(new Set(["call-1"]))("call-1")).toBe(first.id);
		expect(getBranch).toHaveBeenCalledTimes(1);

		leafId = second.id;
		branch = [first, second];
		const linearLookup = buildLookup(new Set(["call-1", "call-2"]));
		expect(linearLookup("call-1")).toBe(first.id);
		expect(linearLookup("call-2")).toBe(second.id);
		expect(getBranch).toHaveBeenCalledTimes(1);

		const compactedLookup = buildLookup(new Set(["call-2"]));
		expect(compactedLookup("call-1")).toBeUndefined();
		expect(compactedLookup("call-2")).toBe(second.id);
		expect(getBranch).toHaveBeenCalledTimes(1);

		leafId = alternate.id;
		branch = [alternate];
		const switchedLookup = buildLookup(new Set(["call-alt"]));
		expect(switchedLookup("call-alt")).toBe(alternate.id);
		expect(switchedLookup("call-1")).toBeUndefined();
		expect(getBranch).toHaveBeenCalledTimes(2);
	});
});
