import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "@caupulican/pi-ai";
import { expect, it } from "vitest";
import { ownerOrchestrationHome } from "../src/core/agent-paths.ts";
import { SessionRootMailbox } from "../src/core/delegation/session-root-mailbox.ts";
import { WorkerAgentMailbox } from "../src/core/delegation/worker-agent-control.ts";
import { WorkerConversation } from "../src/core/delegation/worker-conversation-store.ts";
import { workerMailboxPath } from "../src/core/delegation/worker-mailbox-record.ts";
import { workerRecoveryEntryCharge } from "../src/core/delegation/worker-transcript-projection.ts";
import { ownerSessionStorageRoots } from "../src/core/orchestration/session-bundle-lifecycle.ts";
import { MAX_WORKER_BRIEF_CHARS } from "../src/core/orchestration/worker-brief-attachment.ts";
import type { SessionMessageEntry } from "../src/kernel/session/session-entries.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";
import { stampWorkerControl } from "../src/kernel/worker-control-stamp.ts";

it("reopens a task, staged reply and root reply losslessly and rejects a changed retry", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "worker-brief-"));
	try {
		const orchestrationHome = ownerOrchestrationHome(agentDir);
		const parentSessionId = "parent";
		const agentId = "worker";
		const worker = () => new WorkerAgentMailbox({ agentDir, orchestrationHome, parentSessionId, agentId });
		const root = () => new SessionRootMailbox({ orchestrationHome, parentSessionId });
		const content = `  ${"body".repeat(8192)}\ud800 `;
		const different = `${content.slice(0, -2)}\ud801 `;
		const input = {
			kind: "follow_up" as const,
			senderAgentId: "owner",
			expectReply: true,
			content,
			idempotencyKey: "task",
			task: { kind: "agent_turn" as const },
		};
		const first = worker().enqueueWithReceipt(input);
		expect(first.created).toBe(true);
		expect(worker().enqueueWithReceipt(input).created).toBe(false);
		expect(worker().pendingTaskBearing()[0]?.content).toBe(content);
		const wire = JSON.parse(readFileSync(workerMailboxPath(orchestrationHome, parentSessionId, agentId), "utf8"));
		expect(wire.messages[0].content).toMatchObject({ encoding: "utf16le-base64", bytes: content.length * 2 });
		expect(() => worker().enqueueWithReceipt({ ...input, content: different })).toThrow(/conflicts/);
		worker().acknowledgeDelivered(first.messageId);
		const reply = { sourceAgentId: agentId, requestMessageId: first.messageId, content };
		const accepted = root().enqueueSourceOwnedReply(reply);
		expect(worker().beginReplyAcknowledgement(first.messageId, accepted.messageId, content)).toBe(true);
		expect(worker().listReplyAcknowledgements()[0]?.replyContent).toBe(content);
		expect(() => worker().resolveCompletedReply(first.messageId, different)).toThrow(/conflicts/);
		expect(root().enqueueSourceOwnedReply(reply).created).toBe(false);
		const reopened = root().pendingReplies({ messageId: accepted.messageId });
		expect(reopened.map((r) => r.content)).toEqual([content]);
		expect(root().pendingReplies({ messageId: "unrelated" })).toEqual([]);
		expect(root().markSourceReconciled(accepted.messageId)).toBe(true);
		expect(root().acknowledge(accepted.messageId, reopened[0]!.ackToken)).toBe(true);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

it("backs off full pending mailboxes without losing the accepted full-size message or its retry identity", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "worker-mail-budget-"));
	try {
		const mailbox = new WorkerAgentMailbox({
			agentDir,
			orchestrationHome: ownerOrchestrationHome(agentDir),
			parentSessionId: "parent",
			agentId: "worker",
		});
		const message = {
			kind: "follow_up" as const,
			content: "x".repeat(MAX_WORKER_BRIEF_CHARS),
			idempotencyKey: "one",
		};
		expect(mailbox.enqueueWithReceipt(message).created).toBe(true);
		expect(() => mailbox.enqueueWithReceipt({ ...message, idempotencyKey: "two" })).toThrow(/storage|size|capacity/);
		expect(mailbox.pending().map(({ content }) => content)).toEqual([message.content]);
		expect(mailbox.enqueueWithReceipt(message).created).toBe(false);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

it("keeps the ordinary recovery byte budget for stamps, framing and unclassified transcript rows", () => {
	const body = "x".repeat(150000);
	const row: SessionMessageEntry = {
		type: "message",
		id: "entry",
		parentId: null,
		timestamp: "2026-11-19T00:00:00.000Z",
		workerControl: { v: 1, k: "follow_up", id: "worker-message-id", body: { from: 0, to: body.length } },
		message: { role: "user", timestamp: 1, content: body },
	};
	const wireBytes = Buffer.byteLength(JSON.stringify(row));
	expect(workerRecoveryEntryCharge(row, wireBytes, 1024, body.length)).toEqual({
		bytes: wireBytes - body.length,
		bodyChars: body.length,
	});
	expect(workerRecoveryEntryCharge(row, wireBytes, 1024, body.length - 1).bytes).toBeGreaterThan(1024);
	expect(
		workerRecoveryEntryCharge({ ...row, workerControl: undefined }, wireBytes, 1024, body.length).bytes,
	).toBeGreaterThan(1024);
});

it("admits a maximum staged acknowledgement and source-owned reply when ordinary body space is occupied", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "mailbox-reserve-"));
	try {
		const options = {
			agentDir,
			orchestrationHome: ownerOrchestrationHome(agentDir),
			parentSessionId: "parent",
			agentId: "worker",
		};
		const mailbox = new WorkerAgentMailbox(options);
		const body = "x".repeat(MAX_WORKER_BRIEF_CHARS);
		const replyBody = "y".repeat(MAX_WORKER_BRIEF_CHARS);
		const request = mailbox.enqueue({ kind: "follow_up", content: body, expectReply: true, senderAgentId: "owner" });
		mailbox.acknowledgeDelivered(request.messageId);
		const root = new SessionRootMailbox(options);
		root.enqueueReply({ sourceAgentId: "peer", requestMessageId: "other-request", content: body });
		const reply = { sourceAgentId: options.agentId, requestMessageId: request.messageId, content: replyBody };
		expect(() => root.enqueueReply(reply)).toThrow(/reserve/);
		const target = root.enqueueSourceOwnedReply(reply);
		expect(mailbox.beginReplyAcknowledgement(request.messageId, target.messageId, replyBody)).toBe(true);
		expect(new WorkerAgentMailbox(options).listReplyAcknowledgements()[0]?.replyContent).toBe(replyBody);
		expect(new SessionRootMailbox(options).pendingReplies({ messageId: target.messageId })[0]?.content).toBe(
			replyBody,
		);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

it("checks the full matching cold transcript row before reconciling worker mail and detects duplicate rows", () => {
	const dir = mkdtempSync(join(tmpdir(), "mailbox-cold-"));
	try {
		const session = SessionManager.create(dir, ownerSessionStorageRoots(dir));
		const conversation = new WorkerConversation(session, {
			provider: "pi",
			sessionId: session.getSessionId(),
			cwd: dir,
			resourceProfileNames: [],
			contextPointers: [],
		});
		const messageId = "worker-message-long";
		const content = "x".repeat(MAX_WORKER_BRIEF_CHARS);
		const append = () => {
			const message: UserMessage = { role: "user", timestamp: 1, content };
			stampWorkerControl(message, { v: 1, k: "follow_up", id: messageId, body: { from: 0, to: content.length } });
			const id = session.appendMessage(message);
			session.flushBufferedEntries();
			session.releasePersistedMessagePayload(id);
			session.visitEntries(session.getEntryCount() - 1, 1, (_entry, _index, bytes) => {
				expect(bytes).toBeGreaterThanOrEqual(content.length);
			});
		};
		append();
		expect(conversation.findDeliveredWorkerControlMessageIds([{ messageId, content }])).toEqual(new Set([messageId]));
		expect(() => conversation.findDeliveredWorkerControlMessageIds([{ messageId, content: `${content}y` }])).toThrow(
			/conflicts/,
		);
		append();
		expect(() => conversation.findDeliveredWorkerControlMessageIds([{ messageId, content }])).toThrow(/duplicate/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
