import { describe, expect, it, vi } from "vitest";
import type { CompactionResult } from "../../src/compaction/compaction.ts";
import { runCompactionLoop } from "../../src/compaction/loop.ts";
import { SessionManager } from "../../src/session/session-manager.ts";

describe("provider-request compaction continuation", () => {
	it("can tighten an immediately preceding checkpoint deterministically on a bounded replan", async () => {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "history" }],
			timestamp: 1,
		});
		session.appendCompaction("first checkpoint", firstId, 2_000);
		const tightened: CompactionResult = {
			summary: "tight checkpoint",
			firstKeptEntryId: firstId,
			tokensBefore: 1_500,
		};
		const apply = vi.fn();
		const summarize = vi.fn();
		const build = vi.fn(() => ({ result: tightened }));

		const outcome = await runCompactionLoop({
			measureLiveTokens: () => 1_500,
			shouldCompact: () => true,
			getPostApplyMargin: () => 0,
			getBranch: () => session.getBranch(),
			resolveModelAndAuth: async () => {
				throw new Error("deterministic continuation must not resolve a model");
			},
			summarizeAndVerify: summarize,
			buildDeterministicCheckpoint: build,
			apply,
			onTransition: () => {},
			allowTrailingCompactionAsPrevious: true,
			forceDeterministic: true,
		});

		expect(outcome).toMatchObject({ kind: "success", result: tightened, cycles: 1 });
		expect(build).toHaveBeenCalledTimes(1);
		expect(apply).toHaveBeenCalledWith(tightened);
		expect(summarize).not.toHaveBeenCalled();
	});
});
