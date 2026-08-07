import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createDeterministicCompaction } from "@caupulican/pi-agent-core/node";
import { SessionManager } from "@caupulican/pi-agent-core/session";
import type { AssistantMessage, Message, UserMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workerConversationSessionsDir } from "../src/core/agent-paths.ts";
import { WorkerContextForkStore } from "../src/core/delegation/worker-context-fork-store.ts";
import {
	MAX_WORKER_TRANSCRIPT_PAGE_BYTES,
	MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES,
	WorkerConversation,
	WorkerConversationStore,
} from "../src/core/delegation/worker-conversation-store.ts";

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function assistantMessage(text: string): AssistantMessage {
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

function commitNewMessages(conversation: WorkerConversation, completeTranscript: readonly Message[]): number {
	const persistedMessages = conversation.getRawTranscript().length;
	const cursor = conversation.captureTranscriptCommitCursor();
	return conversation.commitTranscript(cursor, completeTranscript.slice(persistedMessages));
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

	function captureBirthContext(options: ReturnType<typeof createOptions>, parentSessionId = options.parentSessionId) {
		return new WorkerContextForkStore({ agentDir: options.agentDir, parentSessionId }).capture({
			logicalAgentId: options.logicalAgentId,
			messages: [userMessage("immutable parent context")],
		});
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

		expect(commitNewMessages(created, transcript)).toBe(2);
		expect(commitNewMessages(created, transcript)).toBe(0);

		const reopened = store.open({ agentDir: options.agentDir, resumeContext: created.getResumeContext() });
		expect(reopened.getProviderContext().messages).toEqual(transcript);
		expect(commitNewMessages(reopened, [...transcript, userMessage("continue")])).toBe(1);
		expect(reopened.getProviderContext().messages).toEqual([...transcript, userMessage("continue")]);
	});

	it("reuses one warm canonical session across repeated opens and transcript commits", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const created = store.create(options);
		const resumeContext = created.getResumeContext();
		const openSession = vi.spyOn(SessionManager, "open");
		const visitEntries = vi.spyOn(SessionManager.prototype, "visitEntries");

		try {
			for (let index = 0; index < 32; index++) {
				const conversation = store.open({
					agentDir: options.agentDir,
					resumeContext: { ...resumeContext, latestCheckpointId: `checkpoint-${index}` },
				});
				const cursor = conversation.captureTranscriptCommitCursor();
				const next = userMessage(`turn ${index}`);
				conversation.appendMessage(next);
				expect(conversation.commitTranscript(cursor, [next])).toBe(0);
				expect(conversation.getResumeContext().latestCheckpointId).toBe(`checkpoint-${index}`);
			}

			expect(openSession).not.toHaveBeenCalled();
			expect(visitEntries.mock.calls.reduce((total, [, count]) => total + count, 0)).toBeLessThanOrEqual(64);
		} finally {
			openSession.mockRestore();
			visitEntries.mockRestore();
		}
	});

	it("revalidates a cached birth prefix only when its durable metadata revision changes", () => {
		const options = createOptions();
		const reference = captureBirthContext(options);
		const store = new WorkerConversationStore();
		const openBirthContext = vi.spyOn(WorkerContextForkStore.prototype, "open");
		try {
			const conversation = store.ensure({ ...options, birthContextForkReference: reference });
			const resumeContext = conversation.getResumeContext();
			const initialValidations = openBirthContext.mock.calls.length;

			for (let index = 0; index < 8; index++) {
				store.open({ agentDir: options.agentDir, resumeContext });
			}
			expect(openBirthContext).toHaveBeenCalledTimes(initialValidations);

			const metadataFile = `${resumeContext.sessionFile}.worker.json`;
			const exactMetadata = readFileSync(metadataFile);
			const before = statSync(metadataFile);
			writeFileSync(metadataFile, exactMetadata);
			utimesSync(metadataFile, before.atime, new Date(before.mtimeMs + 5_000));
			store.open({ agentDir: options.agentDir, resumeContext });

			expect(openBirthContext).toHaveBeenCalledTimes(initialValidations + 1);
		} finally {
			openBirthContext.mockRestore();
		}
	});

	it("rejects an idle cached metadata swap to another valid parent birth snapshot", () => {
		const options = createOptions();
		const reference = captureBirthContext(options);
		const store = new WorkerConversationStore();
		const conversation = store.ensure({ ...options, birthContextForkReference: reference });
		const resumeContext = conversation.getResumeContext();
		const metadataFile = `${resumeContext.sessionFile}.worker.json`;
		const alternateParentSessionId = "alternate-parent-session";
		const alternateReference = captureBirthContext(options, alternateParentSessionId);
		const metadata = JSON.parse(readFileSync(metadataFile, "utf8")) as Record<string, unknown>;
		writeFileSync(
			metadataFile,
			`${JSON.stringify({
				...metadata,
				parentSessionId: alternateParentSessionId,
				birthContextForkReference: alternateReference,
			})}\n`,
		);

		expect(() => store.open({ agentDir: options.agentDir, resumeContext })).toThrow(
			/parent session identity conflicts/i,
		);
	});

	it("rejects removal of an idle cached birth-context identity", () => {
		const options = createOptions();
		const reference = captureBirthContext(options);
		const store = new WorkerConversationStore();
		const conversation = store.ensure({ ...options, birthContextForkReference: reference });
		const resumeContext = conversation.getResumeContext();
		const metadataFile = `${resumeContext.sessionFile}.worker.json`;
		const metadata = JSON.parse(readFileSync(metadataFile, "utf8")) as Record<string, unknown>;
		delete metadata.parentSessionId;
		delete metadata.birthContextForkReference;
		writeFileSync(metadataFile, `${JSON.stringify(metadata)}\n`);

		expect(() => store.open({ agentDir: options.agentDir, resumeContext })).toThrow(
			/parent session identity conflicts/i,
		);
	});

	it("rejects an idle cached usage-accounting version downgrade", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const conversation = store.create(options);
		const resumeContext = conversation.getResumeContext();
		const metadataFile = `${resumeContext.sessionFile}.worker.json`;
		const metadata = JSON.parse(readFileSync(metadataFile, "utf8")) as Record<string, unknown>;
		delete metadata.usageAccountingVersion;
		writeFileSync(metadataFile, `${JSON.stringify(metadata)}\n`);

		expect(() => store.open({ agentDir: options.agentDir, resumeContext })).toThrow(
			/usage accounting version cannot be downgraded/i,
		);
	});

	it("projects a first birth-context binding through every live shared-core view", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const created = store.create(options);
		const peer = store.open({ agentDir: options.agentDir, resumeContext: created.getResumeContext() });
		const reference = captureBirthContext(options);

		const bound = store.ensure({ ...options, birthContextForkReference: reference });

		for (const conversation of [created, peer, bound]) {
			expect(conversation.getBirthContextForkReference()).toEqual(reference);
			expect(conversation.getProviderMessages()).toEqual([userMessage("immutable parent context")]);
		}
		created.appendMessage(userMessage("continued through the original view"));
		expect(bound.getProviderMessages()).toEqual([
			userMessage("immutable parent context"),
			userMessage("continued through the original view"),
		]);
	});

	it("atomically binds provider history to the raw cursor that fences its next suffix", () => {
		const conversation = new WorkerConversationStore().create(createOptions());
		conversation.appendMessage(userMessage("captured history"));
		const transcriptCommit = conversation.beginTranscriptCommit();
		conversation.appendMessage(userMessage("racing control"));

		expect(transcriptCommit.history).toEqual([userMessage("captured history")]);
		try {
			expect(() =>
				conversation.commitTranscript(transcriptCommit.cursor, [assistantMessage("provider suffix")], {
					appendMissing: false,
				}),
			).toThrow(/suffix diverges/i);
		} finally {
			conversation.abortTranscriptCommit(transcriptCommit.cursor);
		}
	});

	it("rejects a same-size durable prefix rewrite before appending a transcript suffix", () => {
		const options = createOptions();
		const conversation = new WorkerConversationStore().create(options);
		const transcript = [userMessage("first")];
		commitNewMessages(conversation, transcript);
		const cursor = conversation.captureTranscriptCommitCursor();
		const sessionFile = conversation.getResumeContext().sessionFile!;
		const before = statSync(sessionFile);
		const rewritten = readFileSync(sessionFile, "utf8").replace('"content":"first"', '"content":"other"');
		expect(Buffer.byteLength(rewritten)).toBe(before.size);
		writeFileSync(sessionFile, rewritten);
		utimesSync(sessionFile, before.atime, before.mtime);

		expect(() => conversation.commitTranscript(cursor, [userMessage("suffix")])).toThrow(
			/ownership|changed|diverge/i,
		);
		expect(readFileSync(sessionFile, "utf8")).not.toContain('"content":"suffix"');
	});

	it("rejects when the raw bytes written by an owned append disagree with its in-memory entry", () => {
		const options = createOptions();
		const conversation = new WorkerConversationStore().create(options);
		const sessionFile = conversation.getResumeContext().sessionFile!;
		const originalAppendMessage = SessionManager.prototype.appendMessage;
		const appendMessage = vi.spyOn(SessionManager.prototype, "appendMessage").mockImplementation(function (
			this: SessionManager,
			message,
		) {
			const entryId = originalAppendMessage.call(this, message);
			const rewritten = readFileSync(sessionFile, "utf8").replace(
				'"content":"owned append"',
				'"content":"rogue append"',
			);
			writeFileSync(sessionFile, rewritten);
			return entryId;
		});

		try {
			expect(() => conversation.appendMessage(userMessage("owned append"))).toThrow(
				"Worker conversation changed during its owned append.",
			);
		} finally {
			appendMessage.mockRestore();
		}
		expect(readFileSync(sessionFile, "utf8")).toContain('"content":"rogue append"');
		expect(readFileSync(sessionFile, "utf8")).not.toContain('"content":"owned append"');
	});

	it("rejects a truncated final entry without repairing or appending to the damaged file", () => {
		const options = createOptions();
		const conversation = new WorkerConversationStore().create(options);
		conversation.appendMessage(userMessage("durable message"));
		const sessionFile = conversation.getResumeContext().sessionFile!;
		truncateSync(sessionFile, statSync(sessionFile).size - 1);
		const damaged = readFileSync(sessionFile);

		expect(() => conversation.appendMessage(userMessage("must not append"))).toThrow(/partial entry/i);
		expect(readFileSync(sessionFile)).toEqual(damaged);
	});

	it("compares completed transcripts using the exact JSON storage shape without accepting content drift", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const conversation = store.create(options);
		conversation.ensureAttemptUserPrompt("attempt-json-shape", "inspect the durable transcript");
		const completion = {
			...assistantMessage("durable completion"),
			errorMessage: undefined,
			responseId: undefined,
		};
		const cursor = conversation.captureTranscriptCommitCursor();
		conversation.appendMessage(completion);

		expect(conversation.commitTranscript(cursor, [completion])).toBe(0);
		const reopened = store.open({ agentDir: options.agentDir, resumeContext: conversation.getResumeContext() });
		expect(conversation.commitTranscript(cursor, [completion])).toBe(0);
		expect(Object.hasOwn(reopened.getRawTranscript().at(-1)!, "errorMessage")).toBe(false);
		expect(() =>
			conversation.commitTranscript(cursor, [
				{ ...completion, content: [{ type: "text", text: "different completion" }] },
			]),
		).toThrow(/conflicts with its committed suffix/i);
		expect(reopened.getRawTranscript().at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "durable completion" }],
		});
	});

	it("applies the shared tool-result retention shape before transcript comparison", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const conversation = store.create(options);
		conversation.ensureAttemptUserPrompt("attempt-large-details", "run the bounded tool");
		const toolResult: Message = {
			role: "toolResult",
			toolCallId: "tool-large-details",
			toolName: "bash",
			content: [{ type: "text", text: "model-visible result remains exact" }],
			details: { preview: "x".repeat(40 * 1024), fullOutputPath: "/tmp/exact-output.log" },
			isError: false,
			timestamp: 3,
		};
		const cursor = conversation.captureTranscriptCommitCursor();
		conversation.appendMessage(toolResult);

		expect(conversation.commitTranscript(cursor, [toolResult])).toBe(0);
		const reopened = store.open({ agentDir: options.agentDir, resumeContext: conversation.getResumeContext() });
		expect(conversation.commitTranscript(cursor, [toolResult])).toBe(0);
		expect(reopened.getRawTranscript().at(-1)).toMatchObject({
			role: "toolResult",
			content: [{ type: "text", text: "model-visible result remains exact" }],
			details: {
				piToolResultDetailsTruncated: true,
				maxRetainedBytes: 32 * 1024,
			},
		});
		expect(() =>
			conversation.commitTranscript(cursor, [
				{ ...toolResult, content: [{ type: "text", text: "changed model-visible result" }] },
			]),
		).toThrow(/conflicts with its committed suffix/i);
	});

	it("bounds and projects durable failure diagnostics consistently across commit and reopen", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const created = store.create(options);
		const secret = "secret-token-123456789";
		const failure: AssistantMessage = {
			...assistantMessage("ordinary assistant content remains exact"),
			stopReason: "error",
			errorMessage: `Provider rejected Authorization: Bearer ${secret} ${"detail ".repeat(100)}`,
			diagnostics: Array.from({ length: 12 }, (_entry, index) => ({
				type: `transport-${index}`,
				timestamp: index,
				error: {
					name: "TransportFailure",
					code: `credential=${secret}`,
					message: `socket failed Authorization: Bearer ${secret}\nraw second line`,
					stack: `Error: ${secret}\n at provider.ts:${index}`,
				},
				details: { rawAuthorization: `Bearer ${secret}`, index },
			})),
		};
		const transcript: Message[] = [userMessage("run provider request"), failure];

		const cursor = created.captureTranscriptCommitCursor();
		expect(created.commitTranscript(cursor, transcript)).toBe(2);
		expect(created.commitTranscript(cursor, transcript)).toBe(0);
		const reopened = store.open({ agentDir: options.agentDir, resumeContext: created.getResumeContext() });
		expect(commitNewMessages(reopened, transcript)).toBe(0);

		const persisted = reopened
			.getRawTranscript()
			.findLast((message): message is AssistantMessage => message.role === "assistant");
		expect(persisted?.errorMessage).toHaveLength(240);
		expect(persisted?.errorMessage?.endsWith("…")).toBe(true);
		expect(persisted?.content).toEqual([{ type: "text", text: "ordinary assistant content remains exact" }]);
		expect(persisted?.diagnostics?.map((diagnostic) => diagnostic.type)).toEqual(
			Array.from({ length: 8 }, (_entry, index) => `transport-${index + 4}`),
		);
		expect(persisted?.diagnostics?.at(-1)).toEqual({
			type: "transport-11",
			timestamp: 11,
			error: {
				name: "TransportFailure",
				code: "[REDACTED]",
				message: "socket failed [REDACTED]",
			},
		});
		expect(JSON.stringify(persisted)).not.toContain(secret);
		expect(JSON.stringify(persisted)).not.toContain("rawAuthorization");
		expect(JSON.stringify(persisted)).not.toContain("provider.ts");
	});

	it("drops provider diagnostics whose timestamps are not finite nonnegative numbers", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const created = store.create(options);
		created.appendMessage({
			...assistantMessage("provider recovered"),
			diagnostics: [
				{ type: "valid-zero", timestamp: 0 },
				{ type: "not-a-number", timestamp: Number.NaN },
				{ type: "infinite", timestamp: Number.POSITIVE_INFINITY },
				{ type: "negative", timestamp: -1 },
				{ type: "valid-later", timestamp: 2 },
			],
		});

		const reopened = store.open({ agentDir: options.agentDir, resumeContext: created.getResumeContext() });
		const persisted = reopened
			.getRawTranscript()
			.findLast((message): message is AssistantMessage => message.role === "assistant");
		expect(persisted?.diagnostics).toEqual([
			{ type: "valid-zero", timestamp: 0 },
			{ type: "valid-later", timestamp: 2 },
		]);
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

	it("scans changed-file progress only inside its versioned attempt boundary", () => {
		const manager = SessionManager.inMemory("/repo");
		for (let index = 0; index < 2_048; index++) {
			manager.appendMessage(userMessage(`prior persistent-worker turn ${index}`));
		}
		const conversation = new WorkerConversation(manager, {
			provider: "pi",
			sessionId: manager.getSessionId(),
			cwd: "/repo",
			resourceProfileNames: [],
			contextPointers: [],
		});
		conversation.beginAttemptUsage("attempt-current");
		conversation.recordChangedFile("attempt-current", "src/current.ts");
		conversation.beginAttemptUsage("attempt-next");
		conversation.recordChangedFile("attempt-next", "src/next.ts");
		const visits = vi.spyOn(manager, "visitEntries");

		expect(conversation.getChangedFiles("attempt-current")).toEqual(["src/current.ts"]);
		expect(visits.mock.calls.every(([startIndex]) => startIndex >= 2_049)).toBe(true);
		expect(visits.mock.calls.reduce((total, [, count]) => total + count, 0)).toBeLessThanOrEqual(2);

		visits.mockClear();
		expect(conversation.getChangedFiles("attempt-missing")).toEqual([]);
		expect(visits).not.toHaveBeenCalled();
	});

	it("recovers usage only from the current durable attempt boundary", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const conversation = store.create(options);
		conversation.appendMessage({
			...assistantMessage("prior task"),
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.6 },
			},
		});

		conversation.beginAttemptUsage("attempt-2");
		conversation.beginAttemptUsage("attempt-2");
		conversation.appendMessage({
			...assistantMessage("current task"),
			usage: {
				input: 3,
				output: 2,
				cacheRead: 4,
				cacheWrite: 1,
				totalTokens: 10,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
			},
		});
		conversation.appendMessage({
			role: "toolResult",
			toolCallId: "tool-attempt-2",
			toolName: "read",
			content: [{ type: "text", text: "current result" }],
			isError: false,
			timestamp: 3,
		});

		const reopened = store.open({ agentDir: options.agentDir, resumeContext: conversation.getResumeContext() });
		expect(reopened.getRawTranscriptUsage("attempt-2")).toEqual({
			toolCalls: 1,
			inputTokens: 3,
			outputTokens: 2,
			cacheReadTokens: 4,
			cacheWriteTokens: 1,
			totalTokens: 10,
			costUsd: 0.03,
			activeWallClockMs: 0,
		});
		expect(reopened.getProviderContext().messages).toHaveLength(3);
	});

	it("indexes attempt boundaries incrementally instead of rescanning a long durable prefix", () => {
		const manager = SessionManager.inMemory("/repo");
		for (let index = 0; index < 2_048; index++) {
			manager.appendMessage(userMessage(`prior persistent-worker turn ${index}`));
		}
		const conversation = new WorkerConversation(manager, {
			provider: "pi",
			sessionId: manager.getSessionId(),
			cwd: "/repo",
			resourceProfileNames: [],
			contextPointers: [],
		});
		const visits = vi.spyOn(manager, "visitEntries");

		conversation.beginAttemptUsage("attempt-linear");
		conversation.beginAttemptUsage("attempt-linear");
		conversation.ensureAttemptUserPrompt("attempt-linear", "perform the current task");
		conversation.ensureAttemptUserPrompt("attempt-linear", "perform the current task");
		expect(conversation.getLastAttemptMessage("attempt-linear")).toMatchObject({
			role: "user",
			content: "perform the current task",
		});
		expect(conversation.getRawTranscriptUsage("attempt-linear")).toMatchObject({ totalTokens: 0 });

		const prefixScans = visits.mock.calls.filter(([startIndex]) => startIndex < 2_048);
		expect(prefixScans.map(([startIndex, maxEntries]) => [startIndex, maxEntries])).toEqual([
			[0, 1_024],
			[1_024, 1_024],
		]);
	});

	it("rebuilds the attempt-boundary index when the canonical session manager is replaced", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const conversation = store.create(options);
		conversation.beginAttemptUsage("attempt-original-owner");

		const externalOwner = new WorkerConversationStore().open({
			agentDir: options.agentDir,
			resumeContext: conversation.getResumeContext(),
		});
		externalOwner.beginAttemptUsage("attempt-external-owner");
		externalOwner.appendMessage({
			...assistantMessage("external owner result"),
			usage: {
				input: 7,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 9,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.09 },
			},
		});

		expect(
			conversation.findDeliveredWorkerControlMessageIds([
				{
					messageId: "worker-message-index-refresh",
					content: "[Worker control worker-message-index-refresh]\nRefresh the canonical owner.",
				},
			]),
		).toEqual(new Set());
		expect(conversation.getRawTranscriptUsage("attempt-external-owner")).toMatchObject({
			inputTokens: 7,
			outputTokens: 2,
			totalTokens: 9,
			costUsd: 0.09,
		});
	});

	it("distinguishes a versioned missing boundary from a genuinely legacy transcript", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const conversation = store.create(options);
		conversation.appendMessage({
			...assistantMessage("prior task"),
			usage: {
				input: 9,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.12 },
			},
		});
		const resumeContext = conversation.getResumeContext();

		// A new-format task durably prepared before its boundary was appended owns none of the prior spend.
		const versioned = store.open({ agentDir: options.agentDir, resumeContext });
		expect(versioned.getRawTranscriptUsage("attempt-missing-after-crash")).toMatchObject({
			totalTokens: 0,
			costUsd: 0,
		});

		const metadataFile = `${resumeContext.sessionFile}.worker.json`;
		const legacyMetadata = JSON.parse(readFileSync(metadataFile, "utf-8")) as Record<string, unknown>;
		delete legacyMetadata.usageAccountingVersion;
		writeFileSync(metadataFile, `${JSON.stringify(legacyMetadata)}\n`);
		const legacyStore = new WorkerConversationStore();
		const legacy = legacyStore.open({ agentDir: options.agentDir, resumeContext });
		const legacyPeer = legacyStore.open({ agentDir: options.agentDir, resumeContext });
		expect(legacy.usesAttemptUsageBoundaries()).toBe(false);
		expect(legacyPeer.usesAttemptUsageBoundaries()).toBe(false);
		expect(legacy.getRawTranscriptUsage("attempt-never-versioned")).toMatchObject({
			inputTokens: 9,
			outputTokens: 3,
			totalTokens: 12,
			costUsd: 0.12,
		});

		legacy.enableAttemptUsageBoundaries();
		expect(legacyPeer.usesAttemptUsageBoundaries()).toBe(true);
		const upgraded = legacyStore.open({ agentDir: options.agentDir, resumeContext });
		expect(upgraded.usesAttemptUsageBoundaries()).toBe(true);
		expect(upgraded.getRawTranscriptUsage("attempt-prepared-after-upgrade")).toMatchObject({ totalTokens: 0 });
	});

	it("refuses divergent complete transcripts rather than duplicating or branching context", () => {
		const options = createOptions();
		const conversation = new WorkerConversationStore().create(options);
		const cursor = conversation.captureTranscriptCommitCursor();
		conversation.commitTranscript(cursor, [userMessage("first")]);

		expect(() => conversation.commitTranscript(cursor, [userMessage("changed"), assistantMessage("reply")])).toThrow(
			/conflicts with its committed suffix/i,
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
		const cursor = conversation.captureTranscriptCommitCursor();

		expect(conversation.commitTranscript(cursor, [suffix])).toBe(1);
		expect(conversation.getRawTranscript()).toEqual([...raw, suffix]);
		expect(conversation.getProviderContext().messages.at(-1)).toEqual(suffix);
	});

	it("replays pending mailbox delivery markers without cloning the full raw transcript", () => {
		const options = createOptions();
		const conversation = new WorkerConversationStore().create(options);
		const controlContent = "[Worker control worker-message-control-1]\nResume from the checkpoint.";
		conversation.appendMessage(userMessage(controlContent));
		for (let index = 0; index < 2_048; index++) {
			conversation.appendMessage(userMessage(`ordinary durable turn ${index}`));
		}
		const rawTranscript = vi.spyOn(WorkerConversation.prototype, "getRawTranscript");
		const fullEntries = vi.spyOn(SessionManager.prototype, "getEntries");

		try {
			expect(
				conversation.findDeliveredWorkerControlMessageIds([
					{ messageId: "worker-message-control-1", content: controlContent },
				]),
			).toEqual(new Set(["worker-message-control-1"]));
			expect(rawTranscript).not.toHaveBeenCalled();
			expect(fullEntries).not.toHaveBeenCalled();
		} finally {
			rawTranscript.mockRestore();
			fullEntries.mockRestore();
		}
	});

	it("serializes stale recovery owners when reconciling one exact worker-control message", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const created = store.create(options);
		const resumeContext = created.getResumeContext();
		const firstStaleOwner = new WorkerConversationStore().open({ agentDir: options.agentDir, resumeContext });
		const secondStaleOwner = new WorkerConversationStore().open({ agentDir: options.agentDir, resumeContext });
		const expectation = {
			messageId: "worker-message-race",
			content: "[Worker control worker-message-race]\nDeliver exactly once.",
		};
		const message = userMessage(expectation.content);

		expect(firstStaleOwner.reconcileWorkerControlMessage(expectation, message, true)).toEqual({
			delivered: true,
			appended: true,
		});
		expect(secondStaleOwner.reconcileWorkerControlMessage(expectation, message, true)).toEqual({
			delivered: true,
			appended: false,
		});
		const reopened = store.open({ agentDir: options.agentDir, resumeContext });
		expect(
			reopened.getRawTranscript().filter((entry) => entry.role === "user" && entry.content === expectation.content),
		).toHaveLength(1);

		const conflicting = {
			...expectation,
			content: "[Worker control worker-message-race]\nConflicting body.",
		};
		expect(() =>
			reopened.reconcileWorkerControlMessage(conflicting, userMessage(conflicting.content), false),
		).toThrow(/identity conflicts with existing content/i);
	});

	it("rejects an ordinary stale owner before it appends across independent stores", () => {
		const options = createOptions();
		const firstStore = new WorkerConversationStore();
		const firstOwner = firstStore.create(options);
		const resumeContext = firstOwner.getResumeContext();
		const staleOwner = new WorkerConversationStore().open({ agentDir: options.agentDir, resumeContext });
		const staleCursor = staleOwner.captureTranscriptCommitCursor();
		firstOwner.appendMessage(userMessage("new canonical owner message"));

		expect(() => staleOwner.commitTranscript(staleCursor, [userMessage("stale owner message")])).toThrow(
			/advanced under a different owner/i,
		);
		expect(
			new WorkerConversationStore().open({ agentDir: options.agentDir, resumeContext }).getRawTranscript(),
		).toEqual([userMessage("new canonical owner message")]);
	});

	it("fails closed when a worker-control id is already duplicated in the durable transcript", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const conversation = store.create(options);
		const expectation = {
			messageId: "worker-message-duplicate",
			content: "[Worker control worker-message-duplicate]\nDuplicate detector.",
		};
		conversation.appendMessage(userMessage(expectation.content));
		conversation.appendMessage(userMessage(expectation.content));

		expect(() => conversation.findDeliveredWorkerControlMessageIds([expectation])).toThrow(/duplicate message id/i);
	});

	it("fails closed on an oversized compacted worker-control message without restoring its payload", async () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const conversation = store.create(options);
		const messageId = "worker-message-cold-conflict";
		conversation.appendMessage(userMessage(`[Worker control ${messageId}]\n${"oversized ".repeat(4_096)}`));
		for (let index = 0; index < 18; index++) {
			conversation.appendMessage(userMessage(`later turn ${index}: ${"context ".repeat(80)}`));
		}
		await conversation.compactProviderContext({ maxContextTokens: 1_000, keepRecentTokens: 300 });
		const reopened = store.open({ agentDir: options.agentDir, resumeContext: conversation.getResumeContext() });
		const fullEntries = vi.spyOn(SessionManager.prototype, "getEntries");

		try {
			expect(() =>
				reopened.findDeliveredWorkerControlMessageIds([
					{
						messageId,
						content: `[Worker control ${messageId}]\nExpected bounded body.`,
					},
				]),
			).toThrow(/oversized persisted content/i);
			expect(fullEntries).not.toHaveBeenCalled();
		} finally {
			fullEntries.mockRestore();
		}
	});

	it("pages raw transcript messages without cloning or slicing the complete SessionManager history", () => {
		const options = createOptions();
		const conversation = new WorkerConversationStore().create(options);
		for (let index = 0; index < 80; index++) {
			conversation.appendMessage(userMessage(`ordinary durable turn ${index}`));
		}
		const fullEntries = vi.spyOn(SessionManager.prototype, "getEntries");

		try {
			const page = conversation.getRawTranscriptPage({ cursor: 7, maxMessages: 5, maxBytes: 4 * 1024 });
			expect(page).toMatchObject({
				cursor: 7,
				nextCursor: 12,
				omittedMessages: 0,
			});
			expect(page.messages).toEqual(
				Array.from({ length: 5 }, (_, index) => userMessage(`ordinary durable turn ${index + 7}`)),
			);
			expect(page.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(page.messages), "utf8"));
			expect(page.serializedBytes).toBeLessThanOrEqual(4 * 1024);
			expect(fullEntries).not.toHaveBeenCalled();
		} finally {
			fullEntries.mockRestore();
		}
	});

	it("enforces the shared transcript page-message ceiling", () => {
		const conversation = new WorkerConversationStore().create(createOptions());

		expect(() => conversation.getRawTranscriptPage({ maxMessages: MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES + 1 })).toThrow(
			`through ${MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES}`,
		);
	});

	it("omits one oversized cold message and advances its opaque cursor without loading a full transcript", () => {
		const options = createOptions();
		const store = new WorkerConversationStore();
		const conversation = store.create(options);
		conversation.appendMessage(userMessage("x".repeat(68 * 1024)));
		conversation.appendMessage(userMessage("small durable suffix"));
		const openSession = vi.spyOn(SessionManager, "open");
		const reopened = store.open({ agentDir: options.agentDir, resumeContext: conversation.getResumeContext() });
		const fullEntries = vi.spyOn(SessionManager.prototype, "getEntries");

		try {
			const first = reopened.getRawTranscriptPage({ cursor: 0, maxMessages: 1, maxBytes: 64 * 1024 });
			expect(first).toMatchObject({
				cursor: 0,
				messages: [],
				nextCursor: 1,
				omittedMessages: 1,
				serializedBytes: 2,
			});
			const second = reopened.getRawTranscriptPage({ cursor: first.nextCursor, maxMessages: 1 });
			expect(second).toMatchObject({
				cursor: 1,
				messages: [userMessage("small durable suffix")],
				omittedMessages: 0,
			});
			expect(second.nextCursor).toBeUndefined();
			expect(second.serializedBytes).toBeLessThanOrEqual(MAX_WORKER_TRANSCRIPT_PAGE_BYTES);
			expect(openSession).not.toHaveBeenCalled();
			expect(fullEntries).not.toHaveBeenCalled();
		} finally {
			openSession.mockRestore();
			fullEntries.mockRestore();
		}
	});

	it("advances later pages by raw entry offset without rescanning an earlier prefix", () => {
		const manager = SessionManager.inMemory("/repo");
		for (let index = 0; index < 2_048; index++) {
			manager.appendCustomEntry("non-transcript-marker", { index });
		}
		manager.appendMessage(userMessage("first transcript message"));
		manager.appendMessage(userMessage("second transcript message"));
		const conversation = new WorkerConversation(manager, {
			provider: "pi",
			sessionId: "linear-transcript-page",
			cwd: "/repo",
			resourceProfileNames: [],
			contextPointers: [],
		});
		const visits = vi.spyOn(manager, "visitEntries");
		const fullEntries = vi.spyOn(manager, "getEntries");

		const first = conversation.getRawTranscriptPage({ cursor: 0, maxMessages: 1 });
		const second = conversation.getRawTranscriptPage({ cursor: first.nextCursor, maxMessages: 1 });
		const third = conversation.getRawTranscriptPage({ cursor: second.nextCursor, maxMessages: 1 });
		const fourth = conversation.getRawTranscriptPage({ cursor: third.nextCursor, maxMessages: 1 });

		expect([first.messages, second.messages, third.messages, fourth.messages]).toEqual([
			[],
			[],
			[userMessage("first transcript message")],
			[userMessage("second transcript message")],
		]);
		expect(visits.mock.calls.map(([startIndex, maxEntries]) => [startIndex, maxEntries])).toEqual([
			[0, 1_024],
			[1_024, 1_024],
			[2_048, 2],
			[2_049, 1],
		]);
		expect(fourth.nextCursor).toBeUndefined();
		expect(fullEntries).not.toHaveBeenCalled();
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

	it("rejects a compaction checkpoint when the transcript advances during summary generation", async () => {
		const options = createOptions();
		const conversation = new WorkerConversationStore().create(options);
		for (let index = 0; index < 18; index++) {
			conversation.appendMessage(userMessage(`turn-${index}: ${"context ".repeat(80)}`));
		}

		await expect(
			conversation.compactProviderContext({
				maxContextTokens: 1_000,
				keepRecentTokens: 300,
				generateVerifiedCompaction: async (preparation) => {
					conversation.appendMessage(userMessage("racing durable append"));
					return createDeterministicCompaction(preparation);
				},
			}),
		).rejects.toThrow(/changed while its compaction checkpoint/i);
		expect(conversation.hasProviderCompaction()).toBe(false);
		expect(conversation.getRawTranscript().at(-1)).toEqual(userMessage("racing durable append"));
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
