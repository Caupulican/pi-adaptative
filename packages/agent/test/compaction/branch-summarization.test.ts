import {
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateBranchSummary, prepareBranchEntries } from "../../src/compaction/branch-summarization.ts";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "../../src/session/session-manager.ts";
import type { StreamFn } from "../../src/types.ts";

function createModel(): Model<any> {
	return {
		id: "model",
		name: "model",
		provider: "test",
		api: "test",
		baseUrl: "https://example.test",
		input: ["text"],
		reasoning: false,
		contextWindow: 100_000,
		maxTokens: 2048,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function entry(content: string): SessionMessageEntry {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content, timestamp: Date.now() },
	};
}

function streamWith(event: AssistantMessageEvent): ReturnType<StreamFn> {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => stream.push(event));
	return stream;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("generateBranchSummary reliability", () => {
	it("ignores malformed persisted file-operation values", () => {
		const malformed = {
			type: "branch_summary",
			id: "summary-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "summary",
			fromId: "entry-1",
			details: { readFiles: ["read.ts", 42], modifiedFiles: [null, "edited.ts"] },
		} as unknown as SessionEntry;

		const result = prepareBranchEntries([malformed]);

		expect([...result.fileOps.read]).toEqual(["read.ts"]);
		expect([...result.fileOps.edited]).toEqual(["edited.ts"]);
	});

	it("retains trusted compaction details while preparing a branch summary", () => {
		const details = { piVerificationObligations: { version: 1, activeIds: ["unit-suite"] } };
		const compacted: CompactionEntry = {
			type: "compaction",
			id: "compaction-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "Compacted verification checkpoint",
			firstKeptEntryId: "entry-1",
			tokensBefore: 100,
			details,
		};

		const result = prepareBranchEntries([compacted]);

		expect(result.messages).toMatchObject([
			{
				role: "compactionSummary",
				summary: "Compacted verification checkpoint",
				details,
			},
		]);
	});

	it("uses the injected stream function instead of bypassing through completeSimple", async () => {
		let calls = 0;
		const streamFn: StreamFn = () => {
			calls++;
			return streamWith({
				type: "done",
				reason: "stop",
				message: fauxAssistantMessage("## Goal\nused injected stream"),
			});
		};

		const result = await generateBranchSummary([entry("summarize me")], {
			model: createModel(),
			apiKey: "key",
			signal: new AbortController().signal,
			streamFn,
		});

		expect(calls).toBe(1);
		expect(result.summary).toContain("used injected stream");
	});

	it("does not expose tools or force toolChoice on branch-summary requests (F5 negative control)", async () => {
		let capturedContext: Parameters<StreamFn>[1] | undefined;
		let capturedOptions: Parameters<StreamFn>[2] | undefined;
		const streamFn: StreamFn = (_model, context, options) => {
			capturedContext = context;
			capturedOptions = options;
			return streamWith({
				type: "done",
				reason: "stop",
				message: fauxAssistantMessage("## Goal\nno tools here"),
			});
		};

		await generateBranchSummary([entry("summarize me")], {
			model: createModel(),
			apiKey: "key",
			signal: new AbortController().signal,
			streamFn,
		});

		expect(capturedContext?.tools).toBeUndefined();
		expect((capturedOptions as { toolChoice?: unknown } | undefined)?.toolChoice).toBeUndefined();
	});

	it("classifies and retries stalled stream errors instead of hanging", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const streamFn: StreamFn = () => {
			calls++;
			return streamWith({
				type: "error",
				reason: "error",
				error: fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "stream stalled: no events for 30000ms (active phase)",
				}),
			});
		};

		const resultPromise = generateBranchSummary([entry("summarize me")], {
			model: createModel(),
			apiKey: "key",
			signal: new AbortController().signal,
			streamFn,
		});
		await vi.runAllTimersAsync();
		const result = await resultPromise;

		expect(calls).toBe(3);
		expect(result.error).toContain("stream stalled");
	});

	it("does not reissue a branch-summary request before the provider boundary", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const streamFn: StreamFn = () => {
			calls++;
			return streamWith(
				calls === 1
					? {
							type: "error",
							reason: "error",
							error: fauxAssistantMessage("", {
								stopReason: "error",
								errorMessage: "429 rate limited. Please try again in 1.5s.",
							}),
						}
					: {
							type: "done",
							reason: "stop",
							message: fauxAssistantMessage("## Goal\nretry succeeded"),
						},
			);
		};

		const resultPromise = generateBranchSummary([entry("summarize me")], {
			model: createModel(),
			apiKey: "key",
			signal: new AbortController().signal,
			streamFn,
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toBe(1);
		await vi.advanceTimersByTimeAsync(1499);
		expect(calls).toBe(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(resultPromise).resolves.toMatchObject({ summary: expect.stringContaining("retry succeeded") });
		expect(calls).toBe(2);
	});

	it("fails closed when branch summary stops due to length limit (F6)", async () => {
		const streamFn: StreamFn = () => {
			return streamWith({
				type: "done",
				reason: "length",
				message: fauxAssistantMessage("## Incomplete clipped summary...", {
					stopReason: "length",
				}),
			});
		};

		const result = await generateBranchSummary([entry("summarize me")], {
			model: createModel(),
			apiKey: "key",
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBe("branch summary hit its output cap before completing");
		expect(result.summary).toBeUndefined();
	});
});
