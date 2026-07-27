import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createDeterministicCompaction } from "@caupulican/pi-agent-core/node";
import type { Message } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workerConversationSessionsDir } from "../src/core/agent-paths.ts";
import { WorkerConversation, WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";

function userMessage(text: string): Message {
	return { role: "user", content: text, timestamp: 1 };
}

function assistantMessage(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

describe("WorkerConversationStore", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function createOptions() {
		const root = mkdtempSync(join(tmpdir(), "pi-worker-conversation-"));
		tempDirs.push(root);
		return {
			agentDir: join(root, "agent"),
			parentSessionId: "parent-session-1",
			logicalAgentId: "tmux:job-1:agent-1",
			cwd: join(root, "project"),
			orchestrationProfileId: "implementer",
			modelRef: "openai/gpt-test",
			resourceProfileNames: ["restricted-worker"],
			contextPointers: [
				{
					id: "repo-1",
					kind: "repository" as const,
					uri: "file:///repo",
					readOnly: false,
				},
			],
		};
	}

	it("creates a durable canonical SessionManager transcript and resume context without writing the project cwd", () => {
		const options = createOptions();
		const conversation = new WorkerConversationStore().create(options);
		const resumeContext = conversation.getResumeContext();

		expect(resumeContext).toMatchObject({
			provider: "pi",
			cwd: options.cwd,
			orchestrationProfileId: "implementer",
			modelRef: "openai/gpt-test",
			resourceProfileNames: ["restricted-worker"],
			contextPointers: options.contextPointers,
		});
		expect(resumeContext.sessionId).toMatch(/^worker-[a-f0-9]{32}$/);
		expect(resumeContext.sessionDir).toBe(workerConversationSessionsDir(options.agentDir, options.parentSessionId));
		expect(resumeContext.sessionFile).toBe(join(resumeContext.sessionDir!, `${resumeContext.sessionId}.jsonl`));
		expect(existsSync(resumeContext.sessionFile!)).toBe(true);
		expect(existsSync(options.cwd)).toBe(false);
		expect(relative(options.agentDir, resumeContext.sessionFile!).startsWith("..")).toBe(false);
		expect(conversation.getProviderContext().messages).toEqual([]);

		conversation.appendMessage(userMessage("start worker task"));
		const reopened = new WorkerConversationStore().open({ agentDir: options.agentDir, resumeContext });
		expect(reopened.getProviderContext().messages).toEqual([userMessage("start worker task")]);
	});

	it("rejects oversized worker metadata before parsing or cloning it", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const created = store.create(options);
		const resumeContext = created.getResumeContext();
		writeFileSync(`${resumeContext.sessionFile}.worker.json`, "x".repeat(256 * 1024 + 1));

		expect(() => store.open({ agentDir: options.agentDir, resumeContext })).toThrow(
			"Worker conversation metadata is invalid or exceeds its durable size bound",
		);
	});

	it("reopens the authoritative session file and appends only the new transcript suffix", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const created = store.create(options);
		const transcript = [userMessage("inspect the repository"), assistantMessage("inspection complete")];

		expect(created.commitTranscript(transcript)).toBe(2);
		expect(created.commitTranscript(transcript)).toBe(0);

		const reopened = store.open({ agentDir: options.agentDir, resumeContext: created.getResumeContext() });
		expect(reopened.getProviderContext().messages).toEqual(transcript);
		expect(reopened.commitTranscript([...transcript, userMessage("continue")])).toBe(1);
		expect(reopened.getProviderContext().messages).toEqual([...transcript, userMessage("continue")]);
	});

	it("persists bounded changed-file progress without injecting it into provider context", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const conversation = store.create(options);
		conversation.appendMessage(userMessage("modify the focused files"));

		conversation.recordChangedFile("attempt-1", "src/first.ts");
		conversation.recordChangedFile("attempt-1", "src/first.ts");
		conversation.recordChangedFile("attempt-1", "src/second.ts");
		conversation.recordChangedFile("attempt-2", "src/later.ts");

		expect(conversation.getChangedFiles("attempt-1")).toEqual(["src/first.ts", "src/second.ts"]);
		expect(conversation.getChangedFiles("attempt-2")).toEqual(["src/later.ts"]);
		expect(conversation.getProviderContext().messages).toEqual([userMessage("modify the focused files")]);
		const reopened = store.open({ agentDir: options.agentDir, resumeContext: conversation.getResumeContext() });
		expect(reopened.getChangedFiles("attempt-1")).toEqual(["src/first.ts", "src/second.ts"]);
		expect(reopened.getChangedFiles("attempt-2")).toEqual(["src/later.ts"]);
		expect(reopened.getProviderContext().messages).toEqual([userMessage("modify the focused files")]);
	});

	it("refuses divergent complete transcripts rather than duplicating or branching context", () => {
		const options = createOptions();
		const conversation = new WorkerConversationStore().create(options);
		conversation.commitTranscript([userMessage("first")]);

		expect(() => conversation.commitTranscript([userMessage("changed"), assistantMessage("reply")])).toThrow(
			"diverges from persisted context",
		);
		expect(conversation.getProviderContext().messages).toEqual([userMessage("first")]);
	});

	it("refuses a second create for the same logical worker instead of attaching a conflicting transcript", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		store.create(options);

		expect(() => store.create(options)).toThrow("Worker conversation already exists");
	});

	it("reopens an exact-match transcript through ensure after registration was interrupted", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const created = store.create(options);
		created.appendMessage(userMessage("persist before registration"));

		const reopened = store.ensure(options);
		expect(reopened.getResumeContext()).toEqual(created.getResumeContext());
		expect(reopened.getProviderContext().messages).toEqual([userMessage("persist before registration")]);

		expect(() =>
			store.ensure({
				...options,
				resourceProfileNames: ["different-profile"],
			}),
		).toThrow("resume context conflicts");
	});

	it("accepts an advanced checkpoint cursor without weakening immutable conversation identity", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const created = store.create(options);
		const resumeContext = {
			...created.getResumeContext(),
			latestCheckpointId: "checkpoint-after-turn-1",
		};

		const reopened = store.open({ agentDir: options.agentDir, resumeContext });
		expect(reopened.getResumeContext().latestCheckpointId).toBe("checkpoint-after-turn-1");

		expect(() =>
			store.open({
				agentDir: options.agentDir,
				resumeContext: {
					...resumeContext,
					modelRef: "openai/different-model",
				},
			}),
		).toThrow("resume context conflicts");
	});

	it("rejects resume contexts that point outside the worker transcript namespace", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const created = store.create(options);
		const resumeContext = created.getResumeContext();
		resumeContext.sessionFile = join(options.agentDir, "sessions", `${resumeContext.sessionId}.jsonl`);

		expect(() => store.open({ agentDir: options.agentDir, resumeContext })).toThrow(
			"canonical worker sessions directory",
		);
	});

	it("compacts a long durable transcript into a bounded provider context while retaining exact raw history", async () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const conversation = store.create(options);
		for (let index = 0; index < 24; index++) {
			conversation.appendMessage(userMessage(`turn-${index}: ${"evidence ".repeat(80)}`));
		}

		const before = conversation.getProviderContext();
		expect(before.messages.length).toBe(24);
		const outcome = await conversation.compactProviderContext({
			maxContextTokens: 1_200,
			keepRecentTokens: 400,
		});

		expect(outcome.status).toBe("compacted_deterministic");
		expect(outcome.contextUsage.tokens).toBeLessThanOrEqual(1_200);
		expect(outcome.context.messages.length).toBeLessThan(before.messages.length);
		const sessionFile = conversation.getResumeContext().sessionFile!;
		const rawSession = readFileSync(sessionFile, "utf-8");
		expect(rawSession).toContain("turn-0:");
		expect(rawSession).toContain("turn-23:");

		const reopened = store.open({ agentDir: options.agentDir, resumeContext: conversation.getResumeContext() });
		expect(reopened.getProviderContext()).toEqual(outcome.context);
		expect(reopened.getRawTranscript()).toHaveLength(24);
		expect(reopened.getRawTranscript()[0]).toEqual(userMessage(`turn-0: ${"evidence ".repeat(80)}`));
	});

	it("appends one deterministic compaction checkpoint and is idempotent at an unchanged context boundary", async () => {
		const options = createOptions();
		const conversation = new WorkerConversationStore().create(options);
		for (let index = 0; index < 18; index++) {
			conversation.appendMessage(userMessage(`turn-${index}: ${"context ".repeat(80)}`));
		}
		const sessionFile = conversation.getResumeContext().sessionFile!;
		const beforeLines = readFileSync(sessionFile, "utf-8").trim().split("\n");

		const first = await conversation.compactProviderContext({ maxContextTokens: 1_000, keepRecentTokens: 300 });
		const afterFirstLines = readFileSync(sessionFile, "utf-8").trim().split("\n");
		const second = await conversation.compactProviderContext({ maxContextTokens: 1_000, keepRecentTokens: 300 });
		const afterSecondLines = readFileSync(sessionFile, "utf-8").trim().split("\n");

		expect(first.status).toBe("compacted_deterministic");
		expect(afterFirstLines.slice(0, beforeLines.length)).toEqual(beforeLines);
		expect(afterFirstLines).toHaveLength(beforeLines.length + 1);
		expect(second.status).toBe("within_limit");
		expect(afterSecondLines).toEqual(afterFirstLines);
	});

	it("commits a new raw transcript suffix after provider context was compacted", async () => {
		const options = createOptions();
		const conversation = new WorkerConversationStore().create(options);
		const raw: Message[] = [];
		for (let index = 0; index < 18; index++) {
			const message = userMessage(`turn-${index}: ${"context ".repeat(80)}`);
			raw.push(message);
			conversation.appendMessage(message);
		}
		await conversation.compactProviderContext({ maxContextTokens: 1_000, keepRecentTokens: 300 });
		const suffix = assistantMessage("continued after compaction");

		expect(conversation.commitTranscript([...raw, suffix])).toBe(1);
		expect(conversation.getRawTranscript()).toEqual([...raw, suffix]);
		expect(conversation.getProviderContext().messages.at(-1)).toEqual(suffix);
	});

	it("replays pending mailbox delivery markers without cloning the full raw transcript", () => {
		const options = createOptions();
		const conversation = new WorkerConversationStore().create(options);
		for (let index = 0; index < 256; index++) {
			conversation.appendMessage(userMessage(`ordinary durable turn ${index}`));
		}
		conversation.appendMessage(userMessage("[Worker control worker-message-control-1]\nResume from the checkpoint."));
		const rawTranscript = vi.spyOn(WorkerConversation.prototype, "getRawTranscript");

		try {
			expect(conversation.findDeliveredWorkerControlMessageIds(["worker-message-control-1"])).toEqual(
				new Set(["worker-message-control-1"]),
			);
			expect(rawTranscript).not.toHaveBeenCalled();
		} finally {
			rawTranscript.mockRestore();
		}
	});

	it("uses the shared deterministic checkpoint when a verified compactor fails without losing the durable context", async () => {
		const options = createOptions();
		const conversation = new WorkerConversationStore().create(options);
		for (let index = 0; index < 18; index++) {
			conversation.appendMessage(userMessage(`turn-${index}: ${"context ".repeat(80)}`));
		}
		const sessionFile = conversation.getResumeContext().sessionFile!;
		const before = readFileSync(sessionFile, "utf-8");

		const outcome = await conversation.compactProviderContext({
			maxContextTokens: 1_000,
			keepRecentTokens: 300,
			generateVerifiedCompaction: async () => {
				throw new Error("summarizer unavailable");
			},
			getFailedCompactionUsage: () => ({
				input: 7,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 9,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
			}),
		});

		expect(outcome.status).toBe("compacted_deterministic");
		expect(readFileSync(sessionFile, "utf-8").startsWith(before)).toBe(true);
		expect(conversation.getRawTranscript()).toHaveLength(18);
		expect(outcome.contextUsage.tokens).toBeLessThanOrEqual(1_000);
		expect(existsSync(options.cwd)).toBe(false);
		expect(
			new WorkerConversationStore()
				.open({ agentDir: options.agentDir, resumeContext: conversation.getResumeContext() })
				.getRawTranscriptUsage(),
		).toMatchObject({ inputTokens: 7, outputTokens: 2, totalTokens: 9, costUsd: 0.01 });
	});

	it("does not append a deterministic fallback after worker ownership is aborted", async () => {
		const options = createOptions();
		const conversation = new WorkerConversationStore().create(options);
		for (let index = 0; index < 18; index++) {
			conversation.appendMessage(userMessage(`turn-${index}: ${"context ".repeat(80)}`));
		}
		const sessionFile = conversation.getResumeContext().sessionFile!;
		const before = readFileSync(sessionFile, "utf-8");
		const controller = new AbortController();

		await expect(
			conversation.compactProviderContext(
				{
					maxContextTokens: 1_000,
					keepRecentTokens: 300,
					generateVerifiedCompaction: async () => {
						controller.abort(new Error("worker ownership released"));
						throw new Error("summarizer unavailable");
					},
					getFailedCompactionUsage: () => ({
						input: 7,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 7,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
					}),
				},
				controller.signal,
			),
		).rejects.toThrow("worker ownership released");

		expect(readFileSync(sessionFile, "utf-8")).toBe(before);
		expect(conversation.hasProviderCompaction()).toBe(false);
	});

	it("persists a verified worker checkpoint across a durable conversation restart", async () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const conversation = store.create(options);
		for (let index = 0; index < 18; index++) {
			conversation.appendMessage(userMessage(`turn-${index}: ${"context ".repeat(80)}`));
		}

		const outcome = await conversation.compactProviderContext({
			maxContextTokens: 1_000,
			keepRecentTokens: 300,
			generateVerifiedCompaction: async (preparation) => ({
				...createDeterministicCompaction(preparation),
				usage: {
					input: 3,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 4,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
				},
			}),
		});
		const reopened = store.open({ agentDir: options.agentDir, resumeContext: conversation.getResumeContext() });

		expect(outcome.status).toBe("compacted_verified");
		expect(reopened.getProviderContext()).toEqual(outcome.context);
		expect(reopened.getRawTranscript()).toHaveLength(18);
		expect(reopened.getRawTranscriptUsage()).toMatchObject({
			inputTokens: 3,
			outputTokens: 1,
			totalTokens: 4,
			costUsd: 0.02,
		});
	});
});
