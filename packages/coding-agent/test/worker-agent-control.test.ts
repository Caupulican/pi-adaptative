import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerAgentMailbox } from "../src/core/delegation/worker-agent-control.ts";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-worker-agent-control-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("WorkerAgentMailbox", () => {
	it("persists queue-only messages across reopen without delivering them", () => {
		const agentDir = root();
		const mailbox = new WorkerAgentMailbox({ agentDir, parentSessionId: "parent-1", agentId: "agent-1" });
		const notice = mailbox.enqueue({ kind: "follow_up", content: "Check the failing test." });

		expect(mailbox.pending("follow_up")).toEqual([notice]);
		expect(
			new WorkerAgentMailbox({ agentDir, parentSessionId: "parent-1", agentId: "agent-1" }).pending("follow_up"),
		).toEqual([notice]);
	});

	it("keeps an interrupted delivery pending until the transcript acknowledges it", () => {
		const mailbox = new WorkerAgentMailbox({ agentDir: root(), parentSessionId: "parent-1", agentId: "agent-1" });
		const notice = mailbox.enqueue({ kind: "steer", content: "Use focused tests." });

		expect(mailbox.pending("steer")).toEqual([notice]);
		mailbox.acknowledgeDelivered(notice.messageId);
		expect(mailbox.pending("steer")).toEqual([]);
	});

	it("rejects oversized messages before any durable write", () => {
		const mailbox = new WorkerAgentMailbox({ agentDir: root(), parentSessionId: "parent-1", agentId: "agent-1" });

		expect(() => mailbox.enqueue({ kind: "follow_up", content: "x".repeat(4_097) })).toThrow("4,096");
		expect(mailbox.pending()).toEqual([]);
	});

	it("rejects corrupt oversized durable mailbox state before exposing it to a worker", () => {
		const agentDir = root();
		const mailbox = new WorkerAgentMailbox({ agentDir, parentSessionId: "parent-1", agentId: "agent-1" });
		mailbox.enqueue({ kind: "follow_up", content: "bounded" });
		const mailboxDir = join(agentDir, "state", "orchestration", "sessions");
		const [sessionEntry] = readdirSync(mailboxDir);
		if (!sessionEntry) throw new Error("test mailbox state missing");
		const [entry] = readdirSync(join(mailboxDir, sessionEntry, "worker-mailboxes"));
		if (!entry) throw new Error("test mailbox state missing");
		const file = join(mailboxDir, sessionEntry, "worker-mailboxes", entry);
		const state = JSON.parse(readFileSync(file, "utf-8")) as { messages: Array<{ content: string }> };
		state.messages[0]!.content = "x".repeat(4_097);
		writeFileSync(file, JSON.stringify(state));

		expect(() => mailbox.pending()).toThrow("invalid message");
	});

	it("does not read a durable mailbox file beyond its byte bound", () => {
		const agentDir = root();
		const mailbox = new WorkerAgentMailbox({ agentDir, parentSessionId: "parent-1", agentId: "agent-1" });
		mailbox.enqueue({ kind: "follow_up", content: "bounded" });
		const mailboxDir = join(agentDir, "state", "orchestration", "sessions");
		const [sessionEntry] = readdirSync(mailboxDir);
		if (!sessionEntry) throw new Error("test mailbox state missing");
		const [entry] = readdirSync(join(mailboxDir, sessionEntry, "worker-mailboxes"));
		if (!entry) throw new Error("test mailbox state missing");
		writeFileSync(join(mailboxDir, sessionEntry, "worker-mailboxes", entry), "x".repeat(128 * 1024 + 1));

		expect(() => mailbox.pending()).toThrow("durable size bound");
	});

	it("does not turn delivered history into a lifetime message limit", () => {
		const mailbox = new WorkerAgentMailbox({ agentDir: root(), parentSessionId: "parent-1", agentId: "agent-1" });

		for (let index = 0; index < 100; index++) {
			const message = mailbox.enqueue({ kind: "follow_up", content: `turn ${index}` });
			mailbox.acknowledgeDelivered(message.messageId);
		}

		expect(mailbox.pending()).toEqual([]);
	});
});
