import { type ChildProcess, fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import type { AgentResumeContext } from "../src/core/orchestration/contracts.ts";
import { withFileLock } from "../src/core/util/atomic-file.ts";

interface ControlExpectation {
	messageId: string;
	content: string;
}

interface OwnerSuccess {
	ok: true;
	value: {
		delivered: boolean;
		appended: boolean;
	};
}

interface OwnerFailure {
	ok: false;
	error: {
		name: string;
		message: string;
	};
}

type OwnerResult = OwnerSuccess | OwnerFailure;

interface OwnerProcess {
	child: ChildProcess;
	ready: Promise<void>;
	entered: Promise<void>;
	result: Promise<OwnerResult>;
	completed: Promise<void>;
}

interface ConversationFixture {
	agentDir: string;
	resumeContext: AgentResumeContext;
}

const ownerScript = fileURLToPath(new URL("./fixtures/worker-conversation-process-owner.ts", import.meta.url));
const tempDirectories: string[] = [];
const childProcesses = new Set<ChildProcess>();

afterEach(async () => {
	for (const child of childProcesses) child.kill();
	await Promise.allSettled(
		[...childProcesses].map(
			(child) =>
				new Promise<void>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) resolve();
					else child.once("exit", () => resolve());
				}),
		),
	);
	childProcesses.clear();
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createConversationFixture(label: string): ConversationFixture {
	const root = mkdtempSync(join(tmpdir(), `pi-worker-process-lock-${label}-`));
	tempDirectories.push(root);
	const agentDir = join(root, "agent");
	const conversation = new WorkerConversationStore().create({
		agentDir,
		parentSessionId: `parent-${label}`,
		logicalAgentId: `worker-${label}`,
		cwd: join(root, "project"),
		resourceProfileNames: [],
		contextPointers: [],
	});
	return { agentDir, resumeContext: conversation.getResumeContext() };
}

function spawnOwner(fixture: ConversationFixture, expectation: ControlExpectation): OwnerProcess {
	const child = fork(ownerScript, [], {
		cwd: process.cwd(),
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	childProcesses.add(child);
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
	});

	const ready = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const result = Promise.withResolvers<OwnerResult>();
	void ready.promise.catch(() => {});
	void entered.promise.catch(() => {});
	void result.promise.catch(() => {});
	let resultReceived = false;
	const rejectPending = (error: Error): void => {
		ready.reject(error);
		entered.reject(error);
		result.reject(error);
	};
	child.on("message", (message: unknown) => {
		if (!message || typeof message !== "object" || Array.isArray(message)) {
			rejectPending(new Error("Worker conversation owner emitted an invalid IPC record."));
			return;
		}
		const record = message as {
			phase?: unknown;
			ok?: unknown;
			value?: unknown;
			error?: unknown;
		};
		if (record.phase === "ready") ready.resolve();
		else if (record.phase === "entered") entered.resolve();
		else if (record.phase === "result") {
			resultReceived = true;
			result.resolve(
				record.ok === true
					? ({ ok: true, value: record.value } as OwnerSuccess)
					: ({ ok: false, error: record.error } as OwnerFailure),
			);
		} else if (record.phase === "fatal") {
			rejectPending(new Error(`Worker conversation owner failed: ${JSON.stringify(record.error)}`));
		}
	});
	child.once("error", (error) => rejectPending(error));
	const completed = new Promise<void>((resolve, reject) => {
		child.once("exit", (code, signal) => {
			childProcesses.delete(child);
			if (code === 0 && resultReceived) resolve();
			else {
				const error = new Error(
					`Worker conversation owner exited code=${String(code)} signal=${String(signal)}: ${stderr}`,
				);
				rejectPending(error);
				reject(error);
			}
		});
	});
	void completed.catch(() => {});
	child.send({
		type: "initialize",
		agentDir: fixture.agentDir,
		resumeContext: fixture.resumeContext,
		expectation,
	});
	return { child, ready: ready.promise, entered: entered.promise, result: result.promise, completed };
}

async function raceStaleOwners(
	fixture: ConversationFixture,
	expectations: readonly [ControlExpectation, ControlExpectation],
): Promise<readonly [OwnerResult, OwnerResult]> {
	const owners = expectations.map((expectation) => spawnOwner(fixture, expectation)) as [OwnerProcess, OwnerProcess];
	await Promise.all(owners.map((owner) => owner.ready));
	const sessionFile = fixture.resumeContext.sessionFile;
	if (!sessionFile) throw new Error("Expected a persisted worker conversation session file.");
	await withFileLock(sessionFile, async () => {
		for (const owner of owners) owner.child.send({ type: "start" });
		await Promise.all(owners.map((owner) => owner.entered));
	});
	const results = (await Promise.all(owners.map((owner) => owner.result))) as [OwnerResult, OwnerResult];
	await Promise.all(owners.map((owner) => owner.completed));
	return results;
}

function transcript(fixture: ConversationFixture): Message[] {
	return new WorkerConversationStore()
		.open({ agentDir: fixture.agentDir, resumeContext: fixture.resumeContext })
		.getRawTranscript();
}

describe("WorkerConversation cross-process lock ownership", () => {
	it("commits one exact control delivery across two stale process owners", async () => {
		const fixture = createConversationFixture("exact-replay");
		const expectation = {
			messageId: "worker-message-process-race",
			content: "[Worker control worker-message-process-race]\nDeliver once across processes.",
		};

		const results = await raceStaleOwners(fixture, [expectation, expectation]);

		expect(results).toEqual(
			expect.arrayContaining([
				{ ok: true, value: { delivered: true, appended: true } },
				{ ok: true, value: { delivered: true, appended: false } },
			]),
		);
		expect(
			transcript(fixture).filter((message) => message.role === "user" && message.content === expectation.content),
		).toHaveLength(1);
	});

	it("fails closed when stale process owners reuse one control id with conflicting content", async () => {
		const fixture = createConversationFixture("conflict");
		const first = {
			messageId: "worker-message-process-conflict",
			content: "[Worker control worker-message-process-conflict]\nFirst body.",
		};
		const second = {
			messageId: first.messageId,
			content: "[Worker control worker-message-process-conflict]\nSecond body.",
		};

		const results = await raceStaleOwners(fixture, [first, second]);
		const successes = results.filter((result): result is OwnerSuccess => result.ok);
		const failures = results.filter((result): result is OwnerFailure => !result.ok);

		expect(successes).toEqual([{ ok: true, value: { delivered: true, appended: true } }]);
		expect(failures).toHaveLength(1);
		expect(failures[0]!.error.message).toMatch(/identity conflicts with existing content/i);
		const messages = transcript(fixture).filter(
			(message) =>
				message.role === "user" &&
				typeof message.content === "string" &&
				message.content.startsWith(`[Worker control ${first.messageId}]`),
		);
		expect(messages).toHaveLength(1);
		expect([first.content, second.content]).toContain(messages[0]!.content);
	});

	it("allows distinct control identities through the same process barrier", async () => {
		const fixture = createConversationFixture("distinct-negative-control");
		const first = {
			messageId: "worker-message-process-first",
			content: "[Worker control worker-message-process-first]\nFirst distinct delivery.",
		};
		const second = {
			messageId: "worker-message-process-second",
			content: "[Worker control worker-message-process-second]\nSecond distinct delivery.",
		};

		const results = await raceStaleOwners(fixture, [first, second]);

		expect(results).toEqual([
			{ ok: true, value: { delivered: true, appended: true } },
			{ ok: true, value: { delivered: true, appended: true } },
		]);
		const contents = transcript(fixture)
			.filter((message) => message.role === "user" && typeof message.content === "string")
			.map((message) => message.content);
		expect(contents).toEqual(expect.arrayContaining([first.content, second.content]));
		expect(contents).toHaveLength(2);
	});
});
