import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, Model, Usage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../src/core/agent-session-contracts.ts";
import { latestAssistantText } from "../src/core/context/message-text.ts";
import { runIsolatedTextCompletion } from "../src/core/isolated-text-completion.ts";
import { resolveSessionEntryIndex } from "../src/core/session-entry-index.ts";
import { writeJsonLinesSync } from "../src/core/session-jsonl-writer.ts";
import { deriveSpawnedUsageReportId, reportSpawnedUsage } from "../src/core/spawned-usage.ts";
import { runReflexInterpreterCompletion } from "../src/core/toolkit/reflex-interpreter.ts";
import type { ToolkitScript } from "../src/core/toolkit/script-registry.ts";

function usage(totalTokens: number, totalCost: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: totalCost, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
	};
}

function model(): Model<Api> {
	return {
		id: "brain",
		name: "brain",
		provider: "test",
		api: "messages",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 512,
	} as Model<Api>;
}

describe("indexed session-entry ownership", () => {
	it("binds indexed access to the manager and rejects incomplete adapters", () => {
		const manager = {
			marker: "bound",
			getLeafId(this: { marker: string }) {
				expect(this.marker).toBe("bound");
				return "leaf";
			},
			getEntry(this: { marker: string }, id: string) {
				expect(this.marker).toBe("bound");
				return id === "leaf"
					? ({
							type: "message",
							id,
							parentId: null,
							message: { role: "user", content: "x", timestamp: 1 },
						} as never)
					: undefined;
			},
		} as unknown as SessionManager;

		const index = resolveSessionEntryIndex(manager);

		expect(index?.leafId).toBe("leaf");
		expect(index?.getEntry("leaf")?.id).toBe("leaf");
		expect(resolveSessionEntryIndex({ getLeafId: () => "leaf" } as unknown as SessionManager)).toBeUndefined();
	});
});

describe("isolated completion projection", () => {
	it("forwards cancellation and projects the route result without inherited context", async () => {
		const signal = new AbortController().signal;
		const completionUsage = usage(12, 0.04);
		const run = vi.fn<(options: IsolatedCompletionOptions) => Promise<IsolatedCompletionResult>>(async () => ({
			text: "classified",
			usage: completionUsage,
			stopReason: "stop",
		}));
		const runner = {
			marker: "bound",
			runIsolatedCompletion(options: IsolatedCompletionOptions) {
				expect(this.marker).toBe("bound");
				return run(options);
			},
		};

		const result = await runIsolatedTextCompletion(runner, {
			systemPrompt: "classify",
			userPrompt: "only this prompt",
			model: model(),
			thinkingLevel: "off",
			maxTokens: 64,
			signal,
			cacheRetention: "short",
			laneKind: "route-judge",
		});

		expect(run).toHaveBeenCalledTimes(1);
		const options = run.mock.calls[0][0];
		expect(options.signal).toBe(signal);
		expect(options.messages).toHaveLength(1);
		expect(options.messages[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "only this prompt" }],
		});
		expect(result).toEqual({ text: "classified", costUsd: 0.04, stopReason: "stop", usage: completionUsage });
	});
});

describe("assistant text projection", () => {
	it("scans backward without copying history and joins text blocks once", () => {
		const textBlocks = Array.from({ length: 2_000 }, () => ({ type: "text" as const, text: "x" }));
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "older" }], stopReason: "stop", timestamp: 1 },
			{ role: "assistant", content: textBlocks, stopReason: "stop", timestamp: 2 },
			{ role: "assistant", content: [], stopReason: "aborted", timestamp: 3 },
		] as AgentMessage[];

		expect(latestAssistantText(messages)).toBe("x".repeat(2_000));
		expect(latestAssistantText([{ role: "user", content: "none", timestamp: 1 }])).toBeUndefined();
	});
});

describe("session JSONL projection", () => {
	it("consumes a one-pass iterable and writes one record per line", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-session-jsonl-owner-"));
		const filePath = join(directory, "session.jsonl");
		let consumed = 0;
		function* records(): Generator<unknown> {
			consumed++;
			yield { id: 1, text: "first" };
			consumed++;
			yield { id: 2, text: "second" };
		}

		try {
			writeJsonLinesSync(filePath, records());
			expect(consumed).toBe(2);
			expect(readFileSync(filePath, "utf8")).toBe('{"id":1,"text":"first"}\n{"id":2,"text":"second"}\n');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("writes an oversized record directly before continuing bounded batches", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-session-jsonl-large-"));
		const filePath = join(directory, "session.jsonl");
		try {
			writeJsonLinesSync(filePath, [{ text: "x".repeat(300_000) }, { tail: true }]);
			const lines = readFileSync(filePath, "utf8").trimEnd().split("\n");
			expect(lines).toHaveLength(2);
			expect((JSON.parse(lines[0]) as { text: string }).text).toHaveLength(300_000);
			expect(JSON.parse(lines[1])).toEqual({ tail: true });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("spawned usage ownership", () => {
	it("keeps retry identities stable without joining identity chunks", () => {
		expect(deriveSpawnedUsageReportId("curator", "session", ["job-a", "job-b"])).toBe(
			deriveSpawnedUsageReportId("curator", "session", "job-a job-b"),
		);
	});

	it("reports billable or token-visible work and ignores a zero-usage negative control", () => {
		const addSpawnedUsage = vi.fn<
			(reportedUsage: Usage, options: { label?: string; sourceSessionId?: string; reportId: string }) => string
		>(() => "entry");
		const reporter = {
			marker: "bound",
			addSpawnedUsage(
				reportedUsage: Usage,
				options: { label?: string; sourceSessionId?: string; reportId: string },
			) {
				expect(this.marker).toBe("bound");
				return addSpawnedUsage(reportedUsage, options);
			},
		};
		const reported = reportSpawnedUsage(reporter, usage(5, 0), {
			kind: "route-judge",
			label: "router-judge",
			sessionId: "session",
			identity: "request",
		});
		const skipped = reportSpawnedUsage(reporter, usage(0, 0), {
			kind: "route-judge",
			label: "router-judge",
			sessionId: "session",
			identity: "empty",
		});

		expect(reported).toBe("entry");
		expect(skipped).toBeUndefined();
		expect(addSpawnedUsage).toHaveBeenCalledTimes(1);
		expect(addSpawnedUsage.mock.calls[0][1]).toMatchObject({
			label: "router-judge",
			reportId: deriveSpawnedUsageReportId("route-judge", "session", "request"),
		});
	});
});

describe("reflex completion ownership", () => {
	it("uses the caller lane and accounting identity while returning the parsed plan", async () => {
		const scripts: ToolkitScript[] = [
			{ name: "update-db", description: "Apply migrations", runner: "bash", path: "update.sh" },
		];
		const run = vi.fn<(options: IsolatedCompletionOptions) => Promise<IsolatedCompletionResult>>(async () => ({
			text: '{"script":"update-db","args":[],"danger":false,"confidence":0.9}',
			usage: usage(8, 0.02),
			stopReason: "stop",
		}));
		const addSpawnedUsage = vi.fn<
			(reportedUsage: Usage, options: { label?: string; sourceSessionId?: string; reportId: string }) => string
		>(() => "entry");

		const plan = await runReflexInterpreterCompletion({
			request: "update the database",
			scripts,
			model: model(),
			laneKind: "executor",
			usageKind: "executor-brain",
			usageLabel: "executor-brain-warmup",
			sessionId: "session",
			completionRunner: { runIsolatedCompletion: run },
			usageReporter: { addSpawnedUsage },
		});

		expect(plan?.script).toBe("update-db");
		expect(run.mock.calls[0][0]).toMatchObject({ laneKind: "executor", maxTokens: 256 });
		expect(addSpawnedUsage.mock.calls[0][1]).toMatchObject({ label: "executor-brain-warmup" });
	});
});
