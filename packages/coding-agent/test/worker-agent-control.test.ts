import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerAgentMailbox } from "../src/core/delegation/worker-agent-control.ts";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-worker-agent-control-"));
	roots.push(value);
	return value;
}

function mailboxFile(agentDir: string): string {
	const mailboxDir = join(agentDir, "state", "orchestration", "sessions");
	const [sessionEntry] = readdirSync(mailboxDir);
	if (!sessionEntry) throw new Error("test mailbox state missing");
	const [entry] = readdirSync(join(mailboxDir, sessionEntry, "worker-mailboxes"));
	if (!entry) throw new Error("test mailbox state missing");
	return join(mailboxDir, sessionEntry, "worker-mailboxes", entry);
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

	it("keeps task-bearing identity and its first accepted delivery projection immutable on replay", () => {
		const agentDir = root();
		const mailbox = new WorkerAgentMailbox({ agentDir, parentSessionId: "parent-1", agentId: "agent-1" });
		const task = { kind: "terminal_handoff" as const, sourceAttemptId: "attempt-child-1" };
		const accepted = mailbox.enqueueWithReceipt({
			kind: "steer",
			content: "Worker terminal handoff",
			senderAgentId: "child-1",
			idempotencyKey: "terminal-handoff:attempt-child-1",
			task,
		});
		if (accepted.status !== "retained") throw new Error("Expected retained task-bearing control.");

		const replayed = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-1",
			agentId: "agent-1",
		}).enqueueWithReceipt({
			kind: "follow_up",
			content: "Worker terminal handoff",
			senderAgentId: "child-1",
			idempotencyKey: "terminal-handoff:attempt-child-1",
			task,
		});
		if (replayed.status !== "retained") throw new Error("Expected retained task-bearing replay.");
		expect(replayed).toMatchObject({
			created: false,
			message: { messageId: accepted.message.messageId, kind: "steer", task },
		});
		expect(mailbox.pendingTaskBearing()).toEqual([accepted.message]);
		expect(() =>
			mailbox.enqueueWithReceipt({
				kind: "follow_up",
				content: "Worker terminal handoff",
				senderAgentId: "child-1",
				idempotencyKey: "terminal-handoff:attempt-child-1",
				task: { kind: "terminal_handoff", sourceAttemptId: "attempt-child-2" },
			}),
		).toThrow("idempotency identity conflicts");
	});

	it("keeps a compact replay receipt after completed message history is evicted", () => {
		const mailbox = new WorkerAgentMailbox({ agentDir: root(), parentSessionId: "parent-1", agentId: "agent-1" });
		const accepted = mailbox.enqueueWithReceipt({
			kind: "follow_up",
			content: "exact replay intent",
			idempotencyKey: "host-call-1",
		});
		if (accepted.status !== "retained") throw new Error("Expected retained replay intent.");
		mailbox.acknowledgeDelivered(accepted.messageId);
		for (let index = 0; index < 160; index++) {
			const history = mailbox.enqueue({ kind: "follow_up", content: `history ${index}` });
			mailbox.acknowledgeDelivered(history.messageId);
		}
		expect(mailbox.getMessage(accepted.messageId)).toBeUndefined();

		expect(
			mailbox.enqueueWithReceipt({
				kind: "follow_up",
				content: "exact replay intent",
				idempotencyKey: "host-call-1",
			}),
		).toEqual({ status: "completed_replay", messageId: accepted.messageId, created: false });
		expect(() =>
			mailbox.enqueueWithReceipt({
				kind: "follow_up",
				content: "divergent replay intent",
				idempotencyKey: "host-call-1",
			}),
		).toThrow("durable replay receipt");
		expect(mailbox.pending()).toEqual([]);
	});

	it("backpressures keyed admissions before an accepted replay identity could expire", () => {
		const mailbox = new WorkerAgentMailbox({ agentDir: root(), parentSessionId: "parent-1", agentId: "agent-1" });
		const original = mailbox.enqueueWithReceipt({
			kind: "follow_up",
			content: "original intent",
			idempotencyKey: "host-call-original",
		});
		if (original.status !== "retained") throw new Error("Expected retained original intent.");
		mailbox.acknowledgeDelivered(original.messageId);

		let rejected = false;
		for (let index = 0; index < 600; index++) {
			try {
				const accepted = mailbox.enqueueWithReceipt({
					kind: "follow_up",
					content: `later intent ${index}`,
					idempotencyKey: `host-call-${index}`,
				});
				if (accepted.status !== "retained") throw new Error("Expected a distinct retained intent.");
				mailbox.acknowledgeDelivered(accepted.messageId);
			} catch (error) {
				expect(error).toEqual(expect.objectContaining({ message: expect.stringContaining("replay receipt") }));
				rejected = true;
				break;
			}
		}

		expect(rejected).toBe(true);
		expect(mailbox.hasControlReplayReceipt(original.messageId)).toBe(true);
		const maximumIdentity = `i${"\0".repeat(511)}`;
		const reply = mailbox.enqueueWithReceipt({
			kind: "follow_up",
			content: `r${"\0".repeat(4_095)}`,
			senderAgentId: maximumIdentity,
			threadId: maximumIdentity,
			replyToMessageId: maximumIdentity,
			idempotencyKey: "mandatory-reply-after-ledger-pressure",
			task: { kind: "agent_turn" },
		});
		const terminal = mailbox.enqueueWithReceipt({
			kind: "follow_up",
			content: "mandatory terminal",
			senderAgentId: "child-agent",
			idempotencyKey: "mandatory-terminal-after-ledger-pressure",
			task: { kind: "terminal_handoff", sourceAttemptId: "child-attempt" },
		});
		expect(reply.status).toBe("retained");
		expect(terminal.status).toBe("retained");
		expect(mailbox.hasControlReplayReceipt(reply.messageId)).toBe(false);
		expect(mailbox.hasControlReplayReceipt(terminal.messageId)).toBe(false);
		mailbox.acknowledgeDelivered(reply.messageId);
		mailbox.acknowledgeDelivered(terminal.messageId);
		expect(
			mailbox.enqueueWithReceipt({
				kind: "follow_up",
				content: "original intent",
				idempotencyKey: "host-call-original",
			}),
		).toEqual({ status: "completed_replay", messageId: original.messageId, created: false });
		expect(mailbox.pending()).toEqual([]);
	});

	it("does not classify passive pending controls as executable task intent", () => {
		const mailbox = new WorkerAgentMailbox({ agentDir: root(), parentSessionId: "parent-1", agentId: "agent-1" });
		mailbox.enqueue({ kind: "follow_up", content: "queue-only context" });
		const task = mailbox.enqueue({ kind: "follow_up", content: "execute this", task: { kind: "agent_turn" } });

		expect(mailbox.pendingTaskBearing()).toEqual([task]);
	});

	it("reserves bounded pending capacity for mandatory replies and terminal handoffs", () => {
		const mailbox = new WorkerAgentMailbox({ agentDir: root(), parentSessionId: "parent-1", agentId: "agent-1" });
		for (let index = 0; index < 64; index++) {
			mailbox.enqueue({ kind: "follow_up", content: `ordinary pending ${index}` });
		}
		expect(() => mailbox.enqueue({ kind: "follow_up", content: "ordinary overflow" })).toThrow("message limit");

		for (let index = 0; index < 64; index++) {
			mailbox.enqueueWithReceipt({
				kind: "follow_up",
				content: `mandatory pending ${index}`,
				senderAgentId: "source-agent",
				replyToMessageId: `source-request-${index}`,
				idempotencyKey: `mandatory-pending-${index}`,
				task: { kind: "agent_turn" },
			});
		}
		expect(mailbox.pending()).toHaveLength(128);
		expect(() =>
			mailbox.enqueueWithReceipt({
				kind: "follow_up",
				content: "mandatory overflow",
				senderAgentId: "child-agent",
				idempotencyKey: "mandatory-overflow",
				task: { kind: "terminal_handoff", sourceAttemptId: "overflow-attempt" },
			}),
		).toThrow("mandatory message limit");
	});

	it("reserves retained entries for mandatory controls behind protected ordinary history", () => {
		const agentDir = root();
		const mailbox = new WorkerAgentMailbox({ agentDir, parentSessionId: "parent-1", agentId: "agent-1" });
		for (let index = 0; index < 64; index++) {
			const request = mailbox.enqueue({
				kind: "follow_up",
				content: `protected request ${index}`,
				senderAgentId: "requester",
				expectReply: true,
			});
			mailbox.acknowledgeDelivered(request.messageId);
		}
		for (let index = 0; index < 64; index++) {
			mailbox.enqueue({ kind: "follow_up", content: `ordinary pending ${index}` });
		}
		expect(() => mailbox.enqueue({ kind: "follow_up", content: "ordinary retained overflow" })).toThrow(
			"message limit",
		);

		const mandatory = mailbox.enqueueWithReceipt({
			kind: "follow_up",
			content: "mandatory behind protected ordinary history",
			senderAgentId: "child-agent",
			idempotencyKey: "mandatory-retained-reserve",
			task: { kind: "terminal_handoff", sourceAttemptId: "child-attempt" },
		});

		expect(mandatory.status).toBe("retained");
		const reopened = new WorkerAgentMailbox({ agentDir, parentSessionId: "parent-1", agentId: "agent-1" });
		expect(reopened.pending()).toHaveLength(65);
		reopened.acknowledgeDelivered(mandatory.messageId);
		expect(
			new WorkerAgentMailbox({ agentDir, parentSessionId: "parent-1", agentId: "agent-1" }).pending(),
		).toHaveLength(64);
	});

	it("reserves replay evidence slots for an admitted reply obligation", () => {
		const mailbox = new WorkerAgentMailbox({ agentDir: root(), parentSessionId: "parent-1", agentId: "agent-1" });
		const request = mailbox.enqueueWithReceipt({
			kind: "follow_up",
			content: "reply obligation",
			senderAgentId: "requester",
			expectReply: true,
			idempotencyKey: "reply-obligation",
		});
		if (request.status !== "retained") throw new Error("Expected retained reply obligation.");
		mailbox.acknowledgeDelivered(request.messageId);
		for (let index = 0; index < 510; index++) {
			const control = mailbox.enqueueWithReceipt({
				kind: "follow_up",
				content: `control receipt ${index}`,
				idempotencyKey: `control-receipt-${index}`,
			});
			if (control.status !== "retained") throw new Error("Expected retained control receipt.");
			mailbox.acknowledgeDelivered(control.messageId);
		}
		expect(() =>
			mailbox.enqueueWithReceipt({
				kind: "follow_up",
				content: "control receipt overflow",
				idempotencyKey: "control-receipt-overflow",
			}),
		).toThrow("replay evidence capacity");

		expect(mailbox.beginReplyAcknowledgement(request.messageId, "reply-evidence", "exact evidence")).toBe(true);
		expect(mailbox.getReplyAcknowledgementId(request.messageId)).toBe("reply-evidence");
	});

	it("migrates a legacy full replay ledger by swapping an outstanding obligation into its receipt", () => {
		const agentDir = root();
		const mailbox = new WorkerAgentMailbox({ agentDir, parentSessionId: "parent-1", agentId: "agent-1" });
		for (let index = 0; index < 512; index++) {
			const control = mailbox.enqueueWithReceipt({
				kind: "follow_up",
				content: `legacy control ${index}`,
				idempotencyKey: `legacy-control-${index}`,
			});
			if (control.status !== "retained") throw new Error("Expected retained legacy control.");
			mailbox.acknowledgeDelivered(control.messageId);
		}
		const file = mailboxFile(agentDir);
		const state = JSON.parse(readFileSync(file, "utf-8")) as {
			messages: Array<Record<string, unknown>>;
		};
		state.messages.shift();
		state.messages.push({
			messageId: "legacy-reply-obligation",
			kind: "follow_up",
			content: "legacy reply obligation",
			senderAgentId: "requester",
			expectReply: true,
			createdAt: "2026-08-07T00:00:00.000Z",
			deliveredAt: "2026-08-07T00:00:00.000Z",
		});
		writeFileSync(file, `${JSON.stringify(state)}\n`);
		const recovered = new WorkerAgentMailbox({ agentDir, parentSessionId: "parent-1", agentId: "agent-1" });

		expect(
			recovered.beginReplyAcknowledgement(
				"legacy-reply-obligation",
				"legacy-reply-evidence",
				"exact legacy evidence",
			),
		).toBe(true);
		expect(recovered.getReplyAcknowledgementId("legacy-reply-obligation")).toBe("legacy-reply-evidence");
	});

	it("reserves encoded bytes for a maximum-size mandatory control under passive backlog pressure", () => {
		const mailbox = new WorkerAgentMailbox({ agentDir: root(), parentSessionId: "parent-1", agentId: "agent-1" });
		let ordinaryCount = 0;
		for (; ordinaryCount < 64; ordinaryCount++) {
			try {
				mailbox.enqueue({ kind: "follow_up", content: "o".repeat(4_096) });
			} catch (error) {
				expect(error).toEqual(expect.objectContaining({ message: expect.stringContaining("mandatory") }));
				break;
			}
		}
		expect(ordinaryCount).toBeGreaterThan(0);
		expect(ordinaryCount).toBeLessThan(64);

		const maximumIdentity = `i${"\0".repeat(511)}`;
		const reply = mailbox.enqueueWithReceipt({
			kind: "follow_up",
			content: `r${"\0".repeat(4_095)}`,
			senderAgentId: maximumIdentity,
			threadId: maximumIdentity,
			replyToMessageId: maximumIdentity,
			expectReply: true,
			idempotencyKey: "maximum-size-mandatory-reply",
			task: { kind: "terminal_handoff", sourceAttemptId: maximumIdentity },
		});
		expect(reply.status).toBe("retained");
		expect(mailbox.hasControlReplayReceipt(reply.messageId)).toBe(false);
		expect(() => mailbox.acknowledgeDelivered(reply.messageId)).not.toThrow();
		expect(mailbox.getMessage(reply.messageId)).toEqual(expect.objectContaining({ deliveredAt: expect.any(String) }));
	});

	it("keeps the mandatory reserve available through ordinary dead-lettering and a maximum source outbox", () => {
		const mailbox = new WorkerAgentMailbox({ agentDir: root(), parentSessionId: "parent-1", agentId: "agent-1" });
		const maximumIdentity = `i${"\0".repeat(511)}`;
		const request = mailbox.enqueue({
			kind: "follow_up",
			content: "Return maximum source evidence.",
			senderAgentId: maximumIdentity,
			threadId: maximumIdentity,
			expectReply: true,
		});
		mailbox.acknowledgeDelivered(request.messageId);
		const task = mailbox.enqueue({
			kind: "follow_up",
			content: "ordinary task",
			task: { kind: "agent_turn" },
		});
		for (let index = 0; index < 64; index++) {
			try {
				mailbox.enqueue({ kind: "follow_up", content: "o".repeat(4_096) });
			} catch (error) {
				expect(error).toEqual(expect.objectContaining({ message: expect.stringContaining("mandatory") }));
				break;
			}
		}

		expect(mailbox.deadLetterOrdinaryTask(task.messageId, maximumIdentity)).toBe(true);
		expect(mailbox.beginReplyAcknowledgement(request.messageId, maximumIdentity, `r${"\0".repeat(4_095)}`)).toBe(
			true,
		);
		expect(mailbox.listReplyAcknowledgements()).toEqual([
			expect.objectContaining({
				messageId: request.messageId,
				acknowledgementId: maximumIdentity,
				replyContent: `r${"\0".repeat(4_095)}`,
			}),
		]);
	});

	it("keeps durable mutations authoritative and notifies later subscribers when one observer throws", () => {
		const mailbox = new WorkerAgentMailbox({ agentDir: root(), parentSessionId: "parent-1", agentId: "agent-1" });
		const observed = vi.fn();
		mailbox.subscribe(() => {
			throw new Error("simulated mailbox observer failure");
		});
		mailbox.subscribe(observed);

		const request = mailbox.enqueue({
			kind: "follow_up",
			content: "reply requested",
			senderAgentId: "requester",
			expectReply: true,
		});
		expect(() => mailbox.acknowledgeDelivered(request.messageId)).not.toThrow();
		expect(mailbox.awaitingReplies()).toEqual([expect.objectContaining({ messageId: request.messageId })]);
		expect(mailbox.beginReplyAcknowledgement(request.messageId, "reply-1", "reply evidence")).toBe(true);
		expect(mailbox.awaitingReplies()).toEqual([]);
		expect(observed).toHaveBeenCalledTimes(3);
	});

	it("persists peer thread identity and reply expectations through delivery", () => {
		const mailbox = new WorkerAgentMailbox({ agentDir: root(), parentSessionId: "parent-1", agentId: "agent-2" });
		const notice = mailbox.enqueue({
			kind: "follow_up",
			content: "Can you verify the scheduler invariant?",
			senderAgentId: "agent-1",
			threadId: "thread-scheduler",
			expectReply: true,
		});

		mailbox.acknowledgeDelivered(notice.messageId);
		expect(mailbox.awaitingReplies()).toEqual([
			expect.objectContaining({
				messageId: notice.messageId,
				senderAgentId: "agent-1",
				threadId: "thread-scheduler",
				expectReply: true,
			}),
		]);

		mailbox.beginReplyAcknowledgement(notice.messageId, "reply-thread-scheduler", "verified");
		expect(mailbox.awaitingReplies()).toEqual([]);
	});

	it("rejects acknowledgement identity reuse without corrupting either retained request", () => {
		const agentDir = root();
		const mailbox = new WorkerAgentMailbox({ agentDir, parentSessionId: "parent-1", agentId: "agent-2" });
		const first = mailbox.enqueue({
			kind: "follow_up",
			content: "first request",
			senderAgentId: "requester",
			expectReply: true,
		});
		const second = mailbox.enqueue({
			kind: "follow_up",
			content: "second request",
			senderAgentId: "requester",
			expectReply: true,
		});
		mailbox.acknowledgeDelivered(first.messageId);
		mailbox.acknowledgeDelivered(second.messageId);

		expect(mailbox.beginReplyAcknowledgement(first.messageId, "reply-transaction-1", "first reply")).toBe(true);
		expect(() => mailbox.beginReplyAcknowledgement(second.messageId, "reply-transaction-1", "second reply")).toThrow(
			"identity conflicts",
		);
		const reopened = new WorkerAgentMailbox({ agentDir, parentSessionId: "parent-1", agentId: "agent-2" });
		expect(reopened.getMessage(first.messageId)).toMatchObject({ repliedAt: expect.any(String) });
		expect(reopened.awaitingReplies()).toEqual([expect.objectContaining({ messageId: second.messageId })]);
		expect(reopened.rollbackReplyAcknowledgement(first.messageId, "reply-transaction-1")).toBe(true);
		expect(reopened.awaitingReplies().map((message) => message.messageId)).toEqual([
			first.messageId,
			second.messageId,
		]);
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
		const file = mailboxFile(agentDir);
		const state = JSON.parse(readFileSync(file, "utf-8")) as { messages: Array<{ content: string }> };
		state.messages[0]!.content = "x".repeat(4_097);
		writeFileSync(file, JSON.stringify(state));

		expect(() => mailbox.pending()).toThrow("invalid message");
	});

	it("rejects duplicate durable message identities before exposing authorization fields", () => {
		const agentDir = root();
		const mailbox = new WorkerAgentMailbox({ agentDir, parentSessionId: "parent-1", agentId: "agent-1" });
		mailbox.enqueue({ kind: "follow_up", content: "first" });
		mailbox.enqueue({ kind: "follow_up", content: "second" });
		const file = mailboxFile(agentDir);
		const state = JSON.parse(readFileSync(file, "utf-8")) as {
			messages: Array<{ messageId: string }>;
		};
		state.messages[1]!.messageId = state.messages[0]!.messageId;
		writeFileSync(file, JSON.stringify(state));

		expect(() => mailbox.pending()).toThrow("duplicate message identities");
	});

	it("rejects noncanonical and order-inconsistent durable lifecycle timestamps", () => {
		const agentDir = root();
		const mailbox = new WorkerAgentMailbox({ agentDir, parentSessionId: "parent-1", agentId: "agent-1" });
		const message = mailbox.enqueue({
			kind: "follow_up",
			content: "reply",
			senderAgentId: "requester",
			expectReply: true,
		});
		mailbox.acknowledgeDelivered(message.messageId);
		mailbox.beginReplyAcknowledgement(message.messageId, "reply-timestamp", "reply content");
		mailbox.commitReplyAcknowledgement(message.messageId, "reply-timestamp");
		const file = mailboxFile(agentDir);
		const original = JSON.parse(readFileSync(file, "utf-8")) as {
			messages: Array<{ createdAt: string; deliveredAt?: string; repliedAt?: string }>;
		};

		const noncanonical = structuredClone(original);
		noncanonical.messages[0]!.createdAt = "2026-08-07";
		writeFileSync(file, JSON.stringify(noncanonical));
		expect(() => mailbox.pending()).toThrow("creation timestamp");

		const deliveredBeforeCreation = structuredClone(original);
		deliveredBeforeCreation.messages[0]!.createdAt = "2026-08-07T03:00:00.000Z";
		deliveredBeforeCreation.messages[0]!.deliveredAt = "2026-08-07T02:59:59.999Z";
		writeFileSync(file, JSON.stringify(deliveredBeforeCreation));
		expect(() => mailbox.pending()).toThrow("delivery timestamp predates creation");

		const repliedBeforeDelivery = structuredClone(original);
		repliedBeforeDelivery.messages[0]!.createdAt = "2026-08-07T02:00:00.000Z";
		repliedBeforeDelivery.messages[0]!.deliveredAt = "2026-08-07T03:00:00.000Z";
		repliedBeforeDelivery.messages[0]!.repliedAt = "2026-08-07T02:59:59.999Z";
		writeFileSync(file, JSON.stringify(repliedBeforeDelivery));
		expect(() => mailbox.pending()).toThrow("reply timestamp predates delivery");

		const expandedYearOrdering = structuredClone(original);
		expandedYearOrdering.messages[0]!.createdAt = "+010000-01-01T00:00:00.000Z";
		expandedYearOrdering.messages[0]!.deliveredAt = "9999-12-31T23:59:59.999Z";
		expandedYearOrdering.messages[0]!.repliedAt = undefined;
		writeFileSync(file, JSON.stringify(expandedYearOrdering));
		expect(() => mailbox.pending()).toThrow("delivery timestamp predates creation");
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
		writeFileSync(join(mailboxDir, sessionEntry, "worker-mailboxes", entry), "x".repeat(176 * 1024 + 1));

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

	it("evicts oldest delivered history under byte pressure before admitting a fresh control", () => {
		const mailbox = new WorkerAgentMailbox({ agentDir: root(), parentSessionId: "parent-1", agentId: "agent-1" });
		for (let index = 0; index < 10; index++) {
			const message = mailbox.enqueue({ kind: "follow_up", content: "界".repeat(4_096) });
			mailbox.acknowledgeDelivered(message.messageId);
		}
		for (let index = 0; index < 28; index++) {
			const message = mailbox.enqueue({ kind: "follow_up", content: `small control ${index}` });
			mailbox.acknowledgeDelivered(message.messageId);
		}

		expect(mailbox.pending()).toEqual([]);
		const fresh = mailbox.enqueue({ kind: "follow_up", content: "fresh control" });
		expect(mailbox.pending()).toEqual([fresh]);
	});
});
