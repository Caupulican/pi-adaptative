import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, UserMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerContextForkStore } from "../src/core/delegation/worker-context-fork-store.ts";
import {
	type CreateWorkerConversationOptions,
	WorkerConversationStore,
} from "../src/core/delegation/worker-conversation-store.ts";
import type { WorkerContextForkReference } from "../src/core/orchestration/worker-context-fork-reference.ts";

const roots: string[] = [];

function userMessage(text: string, timestamp: number): UserMessage {
	return { role: "user", content: text, timestamp };
}

function assistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "parent-model",
		usage: {
			input: 11,
			output: 3,
			cacheRead: 2,
			cacheWrite: 0,
			totalTokens: 16,
			cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function options(logicalAgentId = "agent-child"): CreateWorkerConversationOptions {
	const directory = mkdtempSync(join(tmpdir(), "pi-worker-conversation-context-fork-"));
	roots.push(directory);
	return {
		agentDir: join(directory, "agent"),
		parentSessionId: "parent-session",
		logicalAgentId,
		cwd: join(directory, "project"),
		orchestrationProfileId: "implementer",
		modelRef: "openai/worker-model",
		resourceProfileNames: [],
		contextPointers: [],
	};
}

function captureBirthContext(
	createOptions: CreateWorkerConversationOptions,
	messages = [
		userMessage("parent request", 1),
		assistantMessage("parent response", 2),
		userMessage("latest parent turn", 3),
	],
): WorkerContextForkReference {
	return new WorkerContextForkStore({
		agentDir: createOptions.agentDir,
		parentSessionId: createOptions.parentSessionId,
	}).capture({ logicalAgentId: createOptions.logicalAgentId, messages });
}

afterEach(() => {
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("WorkerConversationStore birth context", () => {
	it("binds an empty none snapshot without inventing a provider message", () => {
		const createOptions = options();
		const reference = captureBirthContext(createOptions, []);
		const store = new WorkerConversationStore();
		const conversation = store.ensure({ ...createOptions, birthContextForkReference: reference });

		expect(conversation.getBirthContextForkReference()).toEqual(reference);
		expect(conversation.getProviderMessages()).toEqual([]);
		conversation.beginAttemptUsage("attempt-empty-fork");
		expect(conversation.getRawTranscriptUsage("attempt-empty-fork")).toMatchObject({ totalTokens: 0 });
		expect(
			store.ensure({ ...createOptions, birthContextForkReference: reference }).getBirthContextForkReference(),
		).toEqual(reference);
	});

	it("binds one immutable fork reference and seeds it before the first attempt usage boundary", () => {
		const createOptions = options();
		const reference = captureBirthContext(createOptions);
		const store = new WorkerConversationStore();
		const conversation = store.ensure({ ...createOptions, birthContextForkReference: reference });

		expect(conversation.getProviderMessages()).toEqual([
			userMessage("parent request", 1),
			assistantMessage("parent response", 2),
			userMessage("latest parent turn", 3),
		]);
		expect(conversation.getBirthContextForkReference()).toEqual(reference);
		conversation.beginAttemptUsage("attempt-first");
		expect(conversation.getRawTranscriptUsage("attempt-first")).toMatchObject({
			totalTokens: 0,
			costUsd: 0,
		});

		const resumeContext = conversation.getResumeContext();
		const metadata = JSON.parse(readFileSync(`${resumeContext.sessionFile}.worker.json`, "utf-8")) as Record<
			string,
			unknown
		>;
		expect(metadata).toMatchObject({
			parentSessionId: createOptions.parentSessionId,
			birthContextForkReference: reference,
		});
		const beforeReplay = readFileSync(resumeContext.sessionFile!, "utf-8");
		const replay = store.ensure({ ...createOptions, birthContextForkReference: reference });
		expect(replay.getBirthContextForkReference()).toEqual(reference);
		expect(readFileSync(resumeContext.sessionFile!, "utf-8")).toBe(beforeReplay);
	});

	it("persists one authoritative attempt prompt across inherited context, queued controls, and restart", () => {
		const createOptions = options();
		const reference = captureBirthContext(createOptions);
		const store = new WorkerConversationStore();
		const conversation = store.ensure({ ...createOptions, birthContextForkReference: reference });
		conversation.beginAttemptUsage("attempt-prompt");
		conversation.appendMessage(
			userMessage("[Worker control worker-message-peer]\nUntrusted peer evidence arrived while queued.", 10),
		);
		conversation.ensureAttemptUserPrompt("attempt-prompt", "Authoritative delegated task");

		const reopened = store.open({
			agentDir: createOptions.agentDir,
			resumeContext: conversation.getResumeContext(),
			expectedLogicalAgentId: createOptions.logicalAgentId,
		});
		reopened.ensureAttemptUserPrompt("attempt-prompt", "Authoritative delegated task");

		expect(
			reopened
				.getRawTranscript()
				.filter((message) => message.role === "user" && message.content === "Authoritative delegated task"),
		).toHaveLength(1);
	});

	it("recovers only an exact persisted birth prefix and remains idempotent after restart", () => {
		const createOptions = options();
		const reference = captureBirthContext(createOptions);
		const store = new WorkerConversationStore();
		const conversation = store.ensure({ ...createOptions, birthContextForkReference: reference });
		const resumeContext = conversation.getResumeContext();
		const sessionFile = resumeContext.sessionFile!;
		const completeLines = readFileSync(sessionFile, "utf-8").trimEnd().split("\n");
		expect(completeLines).toHaveLength(4);
		writeFileSync(sessionFile, `${completeLines.slice(0, 2).join("\n")}\n`);

		expect(() => store.open({ agentDir: createOptions.agentDir, resumeContext })).toThrow(
			"birth context prefix is incomplete",
		);
		const recovered = store.ensure({ ...createOptions, birthContextForkReference: reference });
		expect(recovered.getRawTranscript()).toEqual([
			userMessage("parent request", 1),
			assistantMessage("parent response", 2),
			userMessage("latest parent turn", 3),
		]);
		const afterRecovery = readFileSync(sessionFile, "utf-8");
		store.ensure({ ...createOptions, birthContextForkReference: reference });
		expect(readFileSync(sessionFile, "utf-8")).toBe(afterRecovery);
	});

	it("fails closed on a divergent birth prefix without appending any snapshot suffix", () => {
		const createOptions = options();
		const reference = captureBirthContext(createOptions);
		const store = new WorkerConversationStore();
		const conversation = store.ensure({ ...createOptions, birthContextForkReference: reference });
		const sessionFile = conversation.getResumeContext().sessionFile!;
		const lines = readFileSync(sessionFile, "utf-8").trimEnd().split("\n");
		const firstMessage = JSON.parse(lines[1]!) as { message: { content: string } };
		firstMessage.message.content = "tampered parent request";
		lines[1] = JSON.stringify(firstMessage);
		writeFileSync(sessionFile, `${lines.slice(0, 2).join("\n")}\n`);
		const divergent = readFileSync(sessionFile, "utf-8");

		expect(() => store.ensure({ ...createOptions, birthContextForkReference: reference })).toThrow(
			"birth context diverges",
		);
		expect(readFileSync(sessionFile, "utf-8")).toBe(divergent);
	});

	it("refuses to bind a birth reference after transcript or attempt use", () => {
		const createOptions = options();
		const reference = captureBirthContext(createOptions);
		const store = new WorkerConversationStore();
		const legacy = store.create(createOptions);
		legacy.appendMessage(userMessage("worker already started", 10));
		legacy.beginAttemptUsage("attempt-existing");
		const sessionFile = legacy.getResumeContext().sessionFile!;
		const metadataFile = `${sessionFile}.worker.json`;
		const beforeSession = readFileSync(sessionFile, "utf-8");
		const beforeMetadata = readFileSync(metadataFile, "utf-8");

		expect(() => store.ensure({ ...createOptions, birthContextForkReference: reference })).toThrow(
			"cannot bind birth context after transcript use",
		);
		expect(readFileSync(sessionFile, "utf-8")).toBe(beforeSession);
		expect(readFileSync(metadataFile, "utf-8")).toBe(beforeMetadata);
	});

	it("rejects another logical agent's fork reference before mutating an empty conversation", () => {
		const createOptions = options();
		const otherOptions = { ...createOptions, logicalAgentId: "agent-other" };
		const foreignReference = captureBirthContext(otherOptions, [userMessage("foreign context", 1)]);
		const store = new WorkerConversationStore();
		const empty = store.create(createOptions);
		const sessionFile = empty.getResumeContext().sessionFile!;
		const metadataFile = `${sessionFile}.worker.json`;
		const beforeSession = readFileSync(sessionFile, "utf-8");
		const beforeMetadata = readFileSync(metadataFile, "utf-8");

		expect(() => store.ensure({ ...createOptions, birthContextForkReference: foreignReference })).toThrow(
			"reference conflicts with the requested logical agent",
		);
		expect(readFileSync(sessionFile, "utf-8")).toBe(beforeSession);
		expect(readFileSync(metadataFile, "utf-8")).toBe(beforeMetadata);
	});
});
