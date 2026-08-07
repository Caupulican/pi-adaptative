import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	SessionRootMailbox,
	sessionRootAddress,
	sessionRootReplyMessageId,
} from "../src/core/delegation/session-root-mailbox.ts";
import { WorkerAgentMailbox, type WorkerAgentMessageOptions } from "../src/core/delegation/worker-agent-control.ts";
import { WorkerAgentControlCoordinator } from "../src/core/delegation/worker-agent-control-coordinator.ts";
import type { WorkerConversation } from "../src/core/delegation/worker-conversation-store.ts";
import type { WorkerDispatchScheduler } from "../src/core/delegation/worker-dispatch-scheduler.ts";
import type { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { type AgentBindingContract, ORCHESTRATION_SCHEMA_VERSION } from "../src/core/orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../src/core/orchestration/task-runtime.ts";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-worker-agent-root-reply-"));
	roots.push(value);
	return value;
}

function retainedRootReply(acceptance: ReturnType<SessionRootMailbox["enqueueReply"]>) {
	if (acceptance.status !== "retained") throw new Error("Expected a retained session-root reply.");
	return acceptance.reply;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function registeredAgent(agentId: string, overrides: Partial<AgentBindingContract> = {}): AgentBindingContract {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		agentId,
		rootAgentId: overrides.rootAgentId ?? agentId,
		depth: overrides.depth ?? 0,
		role: "explorer",
		status: "registered",
		resumeContext: {
			provider: "pi",
			sessionId: `worker-${agentId}`,
			cwd: "/repo",
			resourceProfileNames: [],
			contextPointers: [],
		},
		createdAt: "2026-08-07T00:00:00.000Z",
		updatedAt: "2026-08-07T00:00:00.000Z",
		...overrides,
	};
}

function coordinator(options: {
	agentDir: string;
	parentSessionId: string;
	agents: readonly AgentBindingContract[];
	warn?: (message: string) => void;
}): WorkerAgentControlCoordinator {
	const agents = Object.fromEntries(options.agents.map((agent) => [agent.agentId, agent]));
	const lifecycle = {
		getAgent: (agentId: string) => agents[agentId],
		getTaskRuntimeSnapshot: () => ({ agents, attempts: {} }) as TaskRuntimeProjection,
	} as unknown as WorkerLifecycle;
	return new WorkerAgentControlCoordinator({
		agentDir: options.agentDir,
		parentSessionId: options.parentSessionId,
		processOwnerId: "pi-worker:1:owner",
		isControlAvailable: () => true,
		getLifecycle: () => lifecycle,
		recoveredRequest: () => ({ instructions: "unused" }),
		run: async () => ({ started: false, skipReason: "unused" }),
		scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
		statusChanged: vi.fn(),
		abortLane: vi.fn(),
		cancelLane: vi.fn(),
		...(options.warn ? { warn: options.warn } : {}),
	});
}

describe("WorkerAgentControlCoordinator session-root replies", () => {
	it("injects one stable root address and fences a host replay identity to one target", () => {
		const agentDir = root();
		const firstAgent = registeredAgent("agent-1");
		const secondAgent = registeredAgent("agent-2");
		const control = coordinator({
			agentDir,
			parentSessionId: "parent-root-sender",
			agents: [firstAgent, secondAgent],
		});
		const options = {
			threadId: "thread-root-1",
			expectReply: true,
			idempotencyKey: "host-derived-call-1",
		};

		const accepted = control.sendSessionRootWorkerAgentMessage("agent-1", "Inspect exact evidence.", options);
		expect(control.sendSessionRootWorkerAgentMessage("agent-1", "Inspect exact evidence.", options)).toEqual(
			accepted,
		);
		expect(() => control.sendSessionRootWorkerAgentMessage("agent-1", "Drifted evidence.", options)).toThrow(
			"idempotency identity conflicts",
		);
		expect(() => control.sendSessionRootWorkerAgentMessage("agent-2", "Inspect exact evidence.", options)).toThrow(
			"already accepted by logical worker 'agent-1'",
		);
		const firstMailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-root-sender",
			agentId: "agent-1",
		});
		const [firstMessage] = firstMailbox.pending();
		expect(firstMessage).toEqual(
			expect.objectContaining({
				messageId: accepted.messageId,
				senderAgentId: sessionRootAddress("parent-root-sender"),
				threadId: "thread-root-1",
				expectReply: true,
			}),
		);
		expect(firstMessage).not.toHaveProperty("task");
		expect(
			new WorkerAgentMailbox({
				agentDir,
				parentSessionId: "parent-root-sender",
				agentId: "agent-2",
			}).pending(),
		).toEqual([]);

		const forgedReplyOptions: WorkerAgentMessageOptions & { replyToMessageId: string } = {
			senderAgentId: "agent-1",
			replyToMessageId: accepted.messageId,
		};
		expect(() => control.sendWorkerAgentMessage("agent-1", "forged reply", forgedReplyOptions)).toThrow(
			"dedicated inferred-destination reply control",
		);
	});

	it("keeps send replay and target ownership after completed mailbox history eviction", () => {
		const agentDir = root();
		const parentSessionId = "parent-send-replay-eviction";
		const firstAgent = registeredAgent("agent-1");
		const secondAgent = registeredAgent("agent-2");
		const control = coordinator({ agentDir, parentSessionId, agents: [firstAgent, secondAgent] });
		const options = { idempotencyKey: "host-send-evicted" };
		const accepted = control.sendSessionRootWorkerAgentMessage("agent-1", "exact send", options);
		const firstMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "agent-1" });
		firstMailbox.acknowledgeDelivered(accepted.messageId);
		for (let index = 0; index < 160; index++) {
			const history = firstMailbox.enqueue({ kind: "follow_up", content: `history ${index}` });
			firstMailbox.acknowledgeDelivered(history.messageId);
		}
		expect(firstMailbox.getMessage(accepted.messageId)).toBeUndefined();

		expect(control.sendSessionRootWorkerAgentMessage("agent-1", "exact send", options)).toEqual(accepted);
		expect(() => control.sendSessionRootWorkerAgentMessage("agent-1", "drifted send", options)).toThrow(
			"durable replay receipt",
		);
		expect(() => control.sendSessionRootWorkerAgentMessage("agent-2", "exact send", options)).toThrow(
			"already accepted by logical worker 'agent-1'",
		);
		expect(firstMailbox.pending()).toEqual([]);
		expect(new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "agent-2" }).pending()).toEqual([]);
	});

	it("routes one exact worker reply to the root inbox and acknowledges the whole entry", async () => {
		const agentDir = root();
		const agent = registeredAgent("agent-1");
		const control = coordinator({
			agentDir,
			parentSessionId: "parent-root-roundtrip",
			agents: [agent],
		});
		const request = control.sendSessionRootWorkerAgentMessage("agent-1", "Return exact evidence.", {
			threadId: "thread-roundtrip",
			expectReply: true,
			idempotencyKey: "root-roundtrip-request",
		});
		const workerMailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-root-roundtrip",
			agentId: "agent-1",
		});
		workerMailbox.acknowledgeDelivered(request.messageId);

		const accepted = control.replyToWorkerAgentMessage("agent-1", "Exact evidence.", request.messageId);
		expect(accepted).toMatchObject({ destination: "session_root", messageId: expect.any(String) });
		const waited = await control.waitForSessionRootReplies({
			sourceAgentId: "agent-1",
			requestMessageId: request.messageId,
			timeoutMs: 1_000,
		});
		expect(waited).toMatchObject({ timedOut: false });
		expect(waited.replies).toEqual([
			expect.objectContaining({
				messageId: accepted.messageId,
				sourceAgentId: "agent-1",
				requestMessageId: request.messageId,
				threadId: "thread-roundtrip",
				content: "Exact evidence.",
				ackToken: expect.any(String),
				sourceReconciledAt: expect.any(String),
			}),
		]);
		const [reply] = waited.replies;
		if (!reply) throw new Error("Expected retained session-root reply.");
		expect(workerMailbox.awaitingReplies()).toEqual([]);
		expect(workerMailbox.getReplyAcknowledgementId(request.messageId)).toBeUndefined();
		expect(control.acknowledgeSessionRootReply(reply.messageId, reply.ackToken)).toBe(true);
		expect(control.listSessionRootReplies()).toEqual([]);
		expect(control.replyToWorkerAgentMessage("agent-1", "Exact evidence.", request.messageId)).toEqual(accepted);
		expect(() => control.replyToWorkerAgentMessage("agent-1", "Drifted evidence.", request.messageId)).toThrow(
			"identity conflicts",
		);
		const rootMailbox = new SessionRootMailbox({ agentDir, parentSessionId: "parent-root-roundtrip" });
		for (let index = 0; index < 160; index++) {
			const history = retainedRootReply(
				rootMailbox.enqueueReply({
					sourceAgentId: "history-worker",
					requestMessageId: `history-request-${index}`,
					content: `history ${index}`,
				}),
			);
			rootMailbox.markSourceReconciled(history.messageId);
			rootMailbox.acknowledge(history.messageId, history.ackToken);
		}
		expect(rootMailbox.getReply(accepted.messageId)).toBeUndefined();
		for (let index = 0; index < 160; index++) {
			const history = workerMailbox.enqueue({ kind: "follow_up", content: `source history ${index}` });
			workerMailbox.acknowledgeDelivered(history.messageId);
		}
		expect(workerMailbox.getMessage(request.messageId)).toBeUndefined();
		expect(control.replyToWorkerAgentMessage("agent-1", "Exact evidence.", request.messageId)).toEqual(accepted);
		expect(() => control.replyToWorkerAgentMessage("agent-1", "Drifted evidence.", request.messageId)).toThrow(
			"identity conflicts",
		);
		expect(control.listSessionRootReplies({ requestMessageId: request.messageId })).toEqual([]);
	});

	it("keeps the source request retryable when the mandatory root inbox is full", () => {
		const agentDir = root();
		const parentSessionId = "parent-root-capacity";
		const agent = registeredAgent("agent-1");
		const control = coordinator({ agentDir, parentSessionId, agents: [agent] });
		const rootMailbox = new SessionRootMailbox({ agentDir, parentSessionId });
		const retained = Array.from({ length: 64 }, (_, index) =>
			retainedRootReply(
				rootMailbox.enqueueReply({
					sourceAgentId: `retained-source-${index}`,
					requestMessageId: `retained-request-${index}`,
					content: `Retained reply ${index}`,
				}),
			),
		);
		const request = control.sendSessionRootWorkerAgentMessage("agent-1", "Return after capacity is free.", {
			expectReply: true,
			idempotencyKey: "root-capacity-request",
		});
		const workerMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "agent-1" });
		workerMailbox.acknowledgeDelivered(request.messageId);

		expect(() => control.replyToWorkerAgentMessage("agent-1", "Capacity-safe reply.", request.messageId)).toThrow(
			"mandatory reply limit",
		);
		expect(workerMailbox.awaitingReplies()).toEqual([expect.objectContaining({ messageId: request.messageId })]);
		expect(workerMailbox.getReplyAcknowledgementId(request.messageId)).toBeUndefined();

		const released = retained[0];
		if (!released) throw new Error("Expected retained capacity entry.");
		expect(rootMailbox.markSourceReconciled(released.messageId)).toBe(true);
		expect(rootMailbox.acknowledge(released.messageId, released.ackToken)).toBe(true);
		expect(control.replyToWorkerAgentMessage("agent-1", "Capacity-safe reply.", request.messageId)).toMatchObject({
			destination: "session_root",
			messageId: expect.any(String),
		});
		expect(workerMailbox.awaitingReplies()).toEqual([]);
		expect(workerMailbox.getReplyAcknowledgementId(request.messageId)).toBeUndefined();
	});

	it("reserves root reply evidence before admitting unrelated controls", () => {
		const agentDir = root();
		const parentSessionId = "parent-root-source-capacity";
		const agent = registeredAgent("agent-1");
		const control = coordinator({ agentDir, parentSessionId, agents: [agent] });
		const workerMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "agent-1" });
		const request = workerMailbox.enqueue({
			kind: "follow_up",
			content: "Return root capacity evidence.",
			senderAgentId: sessionRootAddress(parentSessionId),
			expectReply: true,
		});
		workerMailbox.acknowledgeDelivered(request.messageId);
		for (let index = 0; index < 511; index++) {
			const receipt = workerMailbox.enqueueWithReceipt({
				kind: "follow_up",
				content: `source receipt ${index}`,
				idempotencyKey: `source-receipt-${index}`,
			});
			if (receipt.status !== "retained") throw new Error("Expected a distinct source receipt.");
			workerMailbox.acknowledgeDelivered(receipt.messageId);
		}
		expect(() =>
			workerMailbox.enqueueWithReceipt({
				kind: "follow_up",
				content: "source receipt overflow",
				idempotencyKey: "source-receipt-overflow",
			}),
		).toThrow("replay evidence capacity");

		expect(control.replyToWorkerAgentMessage("agent-1", "Root capacity evidence.", request.messageId)).toMatchObject({
			destination: "session_root",
			messageId: expect.any(String),
		});
		expect(workerMailbox.awaitingReplies()).toEqual([]);
		expect(workerMailbox.getReplyAcknowledgementId(request.messageId)).toBeUndefined();
		expect(new SessionRootMailbox({ agentDir, parentSessionId }).retainedReplies()).toEqual([
			expect.objectContaining({ requestMessageId: request.messageId, sourceReconciledAt: expect.any(String) }),
		]);
	});

	it("preserves a crash-left root outbox at capacity and retries when acknowledgement frees a slot", () => {
		const agentDir = root();
		const parentSessionId = "parent-root-outbox-capacity";
		const agent = registeredAgent("agent-1");
		const control = coordinator({ agentDir, parentSessionId, agents: [agent] });
		const rootMailbox = new SessionRootMailbox({ agentDir, parentSessionId });
		const retained = Array.from({ length: 64 }, (_, index) =>
			retainedRootReply(
				rootMailbox.enqueueReply({
					sourceAgentId: `retained-source-${index}`,
					requestMessageId: `retained-request-${index}`,
					content: `Retained reply ${index}`,
				}),
			),
		);
		const released = retained[0];
		if (!released) throw new Error("Expected a retained root-capacity reply.");
		expect(rootMailbox.markSourceReconciled(released.messageId)).toBe(true);
		const request = control.sendSessionRootWorkerAgentMessage("agent-1", "Return after root capacity frees.", {
			expectReply: true,
			idempotencyKey: "root-outbox-capacity-request",
		});
		const sourceMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "agent-1" });
		sourceMailbox.acknowledgeDelivered(request.messageId);
		const replyMessageId = sessionRootReplyMessageId(parentSessionId, "agent-1", request.messageId);
		expect(
			sourceMailbox.beginReplyAcknowledgement(request.messageId, replyMessageId, "Recovered root evidence."),
		).toBe(true);

		const recovered = coordinator({ agentDir, parentSessionId, agents: [agent] });
		recovered.signalStateChanged();
		expect(rootMailbox.getReply(replyMessageId)).toBeUndefined();
		expect(sourceMailbox.listReplyAcknowledgements()).toEqual([
			expect.objectContaining({
				messageId: request.messageId,
				acknowledgementId: replyMessageId,
				replyContent: "Recovered root evidence.",
			}),
		]);

		expect(recovered.acknowledgeSessionRootReply(released.messageId, released.ackToken)).toBe(true);
		expect(rootMailbox.getReply(replyMessageId)).toEqual(
			expect.objectContaining({
				messageId: replyMessageId,
				content: "Recovered root evidence.",
				sourceReconciledAt: expect.any(String),
			}),
		);
		expect(sourceMailbox.getReplyAcknowledgementId(request.messageId)).toBeUndefined();
	});

	it("rolls back a crash-left root outbox that can never fit the encoded reply bound", () => {
		const agentDir = root();
		const parentSessionId = "parent-root-invalid-outbox";
		const agent = registeredAgent("agent-1");
		const warn = vi.fn();
		const control = coordinator({ agentDir, parentSessionId, agents: [agent], warn });
		const request = control.sendSessionRootWorkerAgentMessage("agent-1", "Return bounded evidence.", {
			expectReply: true,
			idempotencyKey: "root-invalid-outbox-request",
		});
		const sourceMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "agent-1" });
		sourceMailbox.acknowledgeDelivered(request.messageId);
		const replyMessageId = sessionRootReplyMessageId(parentSessionId, "agent-1", request.messageId);
		const invalidReply = `a${"\0".repeat(4_095)}`;
		expect(sourceMailbox.beginReplyAcknowledgement(request.messageId, replyMessageId, invalidReply)).toBe(true);

		control.signalStateChanged();

		expect(sourceMailbox.getReplyAcknowledgementId(request.messageId)).toBeUndefined();
		expect(sourceMailbox.awaitingReplies()).toEqual([expect.objectContaining({ messageId: request.messageId })]);
		expect(new SessionRootMailbox({ agentDir, parentSessionId }).retainedReplies()).toEqual([]);
		expect(warn).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("encoded byte bound"));

		expect(() => control.replyToWorkerAgentMessage("agent-1", invalidReply, request.messageId)).toThrow(
			"encoded byte bound",
		);
		expect(sourceMailbox.getReplyAcknowledgementId(request.messageId)).toBeUndefined();
		expect(sourceMailbox.awaitingReplies()).toEqual([expect.objectContaining({ messageId: request.messageId })]);
		expect(new SessionRootMailbox({ agentDir, parentSessionId }).retainedReplies()).toEqual([]);
	});

	it("keeps a durable root acknowledgement successful when its post-ack source scan fails", () => {
		const agentDir = root();
		const parentSessionId = "parent-root-post-ack-scan";
		const agent = registeredAgent("agent-1");
		const warn = vi.fn();
		const control = coordinator({ agentDir, parentSessionId, agents: [agent], warn });
		const request = control.sendSessionRootWorkerAgentMessage("agent-1", "Return ack evidence.", {
			expectReply: true,
			idempotencyKey: "root-post-ack-scan-request",
		});
		const sourceMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "agent-1" });
		sourceMailbox.acknowledgeDelivered(request.messageId);
		const accepted = control.replyToWorkerAgentMessage("agent-1", "Ack evidence.", request.messageId);
		if (accepted.destination !== "session_root") throw new Error("Expected session-root destination.");
		const rootMailbox = new SessionRootMailbox({ agentDir, parentSessionId });
		const reply = rootMailbox.getReply(accepted.messageId);
		if (!reply) throw new Error("Expected retained root reply.");
		const originalList = WorkerAgentMailbox.prototype.listReplyAcknowledgements;
		let scans = 0;
		const sourceScan = vi
			.spyOn(WorkerAgentMailbox.prototype, "listReplyAcknowledgements")
			.mockImplementation(function (this: WorkerAgentMailbox) {
				scans++;
				if (scans === 2) throw new Error("simulated post-ack source scan failure");
				return originalList.call(this);
			});

		expect(control.acknowledgeSessionRootReply(reply.messageId, reply.ackToken)).toBe(true);
		sourceScan.mockRestore();

		expect(rootMailbox.getReply(reply.messageId)).toEqual(
			expect.objectContaining({ acknowledgedAt: expect.any(String) }),
		);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("simulated post-ack source scan failure"));
	});

	it("retries a root outbox when inbox reconciliation frees a previously acknowledged slot", () => {
		const agentDir = root();
		const parentSessionId = "parent-root-outbox-reconciliation-capacity";
		const repairAgent = registeredAgent("repair-agent");
		const waitingAgent = registeredAgent("waiting-agent");
		const control = coordinator({ agentDir, parentSessionId, agents: [repairAgent, waitingAgent] });
		const repairRequest = control.sendSessionRootWorkerAgentMessage("repair-agent", "Repair this root edge.", {
			expectReply: true,
			idempotencyKey: "repair-root-capacity-request",
		});
		const repairMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "repair-agent" });
		repairMailbox.acknowledgeDelivered(repairRequest.messageId);
		const rootMailbox = new SessionRootMailbox({ agentDir, parentSessionId });
		const repairReply = retainedRootReply(
			rootMailbox.enqueueReply({
				sourceAgentId: "repair-agent",
				requestMessageId: repairRequest.messageId,
				content: "Repair evidence.",
			}),
		);
		expect(rootMailbox.acknowledge(repairReply.messageId, repairReply.ackToken)).toBe(true);
		for (let index = 1; index < 64; index++) {
			rootMailbox.enqueueReply({
				sourceAgentId: `unreconciled-source-${index}`,
				requestMessageId: `unreconciled-request-${index}`,
				content: `Unreconciled reply ${index}`,
			});
		}
		const waitingRequest = control.sendSessionRootWorkerAgentMessage(
			"waiting-agent",
			"Return after reconciliation frees capacity.",
			{ expectReply: true, idempotencyKey: "waiting-root-capacity-request" },
		);
		const waitingMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "waiting-agent" });
		waitingMailbox.acknowledgeDelivered(waitingRequest.messageId);
		const waitingReplyMessageId = sessionRootReplyMessageId(
			parentSessionId,
			"waiting-agent",
			waitingRequest.messageId,
		);
		expect(
			waitingMailbox.beginReplyAcknowledgement(waitingRequest.messageId, waitingReplyMessageId, "Waiting evidence."),
		).toBe(true);

		control.signalStateChanged();
		expect(rootMailbox.getReply(waitingReplyMessageId)).toBeUndefined();
		expect(control.listSessionRootReplies({ requestMessageId: waitingRequest.messageId })).toEqual([
			expect.objectContaining({
				messageId: waitingReplyMessageId,
				content: "Waiting evidence.",
				sourceReconciledAt: expect.any(String),
			}),
		]);
		expect(rootMailbox.getReply(repairReply.messageId)).toEqual(
			expect.objectContaining({
				acknowledgedAt: expect.any(String),
				sourceReconciledAt: expect.any(String),
			}),
		);
		expect(waitingMailbox.getReplyAcknowledgementId(waitingRequest.messageId)).toBeUndefined();
	});

	it("repairs every root reply transaction crash boundary before exposing the inbox", () => {
		for (const failurePoint of ["source_reserved", "root_mark", "source_commit"] as const) {
			const agentDir = root();
			const agent = registeredAgent("agent-1");
			const parentSessionId = `parent-root-crash-${failurePoint}`;
			const control = coordinator({ agentDir, parentSessionId, agents: [agent] });
			let reconciler = control;
			const request = control.sendSessionRootWorkerAgentMessage("agent-1", `Request ${failurePoint}`, {
				expectReply: true,
				idempotencyKey: `request-${failurePoint}`,
			});
			const workerMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "agent-1" });
			workerMailbox.acknowledgeDelivered(request.messageId);

			let accepted: ReturnType<WorkerAgentControlCoordinator["replyToWorkerAgentMessage"]>;
			if (failurePoint === "source_reserved") {
				const messageId = sessionRootReplyMessageId(parentSessionId, "agent-1", request.messageId);
				expect(workerMailbox.beginReplyAcknowledgement(request.messageId, messageId, "Recovered evidence.")).toBe(
					true,
				);
				reconciler = coordinator({ agentDir, parentSessionId, agents: [agent] });
				reconciler.signalStateChanged();
				accepted = { destination: "session_root", messageId };
			} else if (failurePoint === "root_mark") {
				const interrupted = vi
					.spyOn(SessionRootMailbox.prototype, "markSourceReconciled")
					.mockImplementationOnce(() => {
						throw new Error("simulated root mark interruption");
					});
				accepted = control.replyToWorkerAgentMessage("agent-1", "Recovered evidence.", request.messageId);
				interrupted.mockRestore();
			} else {
				const interrupted = vi
					.spyOn(WorkerAgentMailbox.prototype, "commitReplyAcknowledgement")
					.mockImplementationOnce(() => {
						throw new Error("simulated source commit interruption");
					});
				accepted = control.replyToWorkerAgentMessage("agent-1", "Recovered evidence.", request.messageId);
				interrupted.mockRestore();
			}
			if (accepted.destination !== "session_root") throw new Error("Expected session-root destination.");
			const rootMailbox = new SessionRootMailbox({ agentDir, parentSessionId });
			expect(rootMailbox.getReply(accepted.messageId)).toBeDefined();

			expect(reconciler.listSessionRootReplies()).toEqual([
				expect.objectContaining({ messageId: accepted.messageId, sourceReconciledAt: expect.any(String) }),
			]);
			expect(workerMailbox.awaitingReplies()).toEqual([]);
			expect(workerMailbox.getReplyAcknowledgementId(request.messageId)).toBeUndefined();
		}
	});

	it("retains an unmarked replied source while reconciling independent root replies", () => {
		const agentDir = root();
		const blocked = registeredAgent("blocked");
		const valid = registeredAgent("valid");
		const warn = vi.fn();
		const control = coordinator({
			agentDir,
			parentSessionId: "parent-root-fail-closed",
			agents: [blocked, valid],
			warn,
		});
		const blockedRequest = control.sendSessionRootWorkerAgentMessage("blocked", "Blocked request", {
			expectReply: true,
			idempotencyKey: "blocked-request",
		});
		const validRequest = control.sendSessionRootWorkerAgentMessage("valid", "Valid request", {
			expectReply: true,
			idempotencyKey: "valid-request",
		});
		const blockedMailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-root-fail-closed",
			agentId: "blocked",
		});
		const validMailbox = new WorkerAgentMailbox({
			agentDir,
			parentSessionId: "parent-root-fail-closed",
			agentId: "valid",
		});
		blockedMailbox.acknowledgeDelivered(blockedRequest.messageId);
		validMailbox.acknowledgeDelivered(validRequest.messageId);
		const rootMailbox = new SessionRootMailbox({
			agentDir,
			parentSessionId: "parent-root-fail-closed",
		});
		const blockedReply = retainedRootReply(
			rootMailbox.enqueueReply({
				sourceAgentId: "blocked",
				requestMessageId: blockedRequest.messageId,
				content: "Blocked evidence",
			}),
		);
		expect(
			blockedMailbox.beginReplyAcknowledgement(
				blockedRequest.messageId,
				blockedReply.messageId,
				blockedReply.content,
			),
		).toBe(true);
		expect(blockedMailbox.commitReplyAcknowledgement(blockedRequest.messageId, blockedReply.messageId)).toBe(true);
		const validReply = control.replyToWorkerAgentMessage("valid", "Valid evidence", validRequest.messageId);
		if (validReply.destination !== "session_root") throw new Error("Expected session-root destination.");

		const replies = control.listSessionRootReplies();
		control.listSessionRootReplies();
		expect(replies).toHaveLength(2);
		expect(replies[0]).toEqual(expect.objectContaining({ messageId: blockedReply.messageId }));
		expect(replies[0]).not.toHaveProperty("sourceReconciledAt");
		expect(replies[1]).toEqual(
			expect.objectContaining({ messageId: validReply.messageId, sourceReconciledAt: expect.any(String) }),
		);
		expect(control.acknowledgeSessionRootReply(blockedReply.messageId, blockedReply.ackToken)).toBe(true);
		expect(control.listSessionRootReplies({ sourceAgentId: "blocked" })).toEqual([]);
		const retainedBlockedReply = rootMailbox.getReply(blockedReply.messageId);
		expect(retainedBlockedReply).toEqual(expect.objectContaining({ acknowledgedAt: expect.any(String) }));
		expect(retainedBlockedReply).not.toHaveProperty("sourceReconciledAt");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("exact acknowledgement marker"));
	});

	it("adopts a target-only worker reply before waking it and rejects a divergent source marker", () => {
		const agentDir = root();
		const parentSessionId = "parent-worker-reply-crash";
		const requester = registeredAgent("requester");
		const responder = registeredAgent("responder", {
			parentAgentId: "requester",
			rootAgentId: "requester",
			depth: 1,
		});
		let attempt: AttemptRuntimeState | undefined;
		const prepareAgentTurn = vi.fn((args: { agentId: string; instructions: string; controlMessageId?: string }) => {
			attempt = {
				attemptId: "attempt-recovered-reply",
				taskId: "worker-recovered-reply",
				dispatch: {
					provider: "pi",
					taskId: "worker-recovered-reply",
					instructions: args.instructions,
					profileId: "explorer",
					resourcePointerIds: [],
					logicalLaneId: args.agentId,
					...(args.controlMessageId ? { controlMessageId: args.controlMessageId } : {}),
				},
				status: "queued",
				checkpointIds: [],
				createdAt: "2026-08-07T00:00:00.000Z",
				updatedAt: "2026-08-07T00:00:00.000Z",
			};
			return {
				record: { laneId: attempt.taskId, type: "worker" as const, status: "queued" as const },
				attempt,
			};
		});
		const agents = { requester, responder };
		const lifecycle = {
			getAgent: (agentId: string) => agents[agentId as keyof typeof agents],
			getLatestAgentAttempt: (agentId: string) => (agentId === "requester" ? attempt : undefined),
			getTaskRuntimeSnapshot: () => ({
				agents,
				attempts: attempt ? { [attempt.attemptId]: attempt } : {},
			}),
			getRecord: (laneId: string) =>
				attempt?.taskId === laneId ? { laneId, type: "worker" as const, status: "queued" as const } : undefined,
			prepareAgentTurn,
		} as unknown as WorkerLifecycle;
		const scheduler: Pick<WorkerDispatchScheduler, "enqueue" | "track" | "drain" | "dropQueued"> = {
			enqueue: vi.fn(),
			track: vi.fn(),
			drain: vi.fn(),
			dropQueued: vi.fn(),
		};
		const warn = vi.fn();
		const control = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId,
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "recovered" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler,
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
			warn,
		});
		const responderMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "responder" });
		const requesterMailbox = new WorkerAgentMailbox({ agentDir, parentSessionId, agentId: "requester" });
		const request = responderMailbox.enqueue({
			kind: "follow_up",
			content: "Return exact evidence.",
			senderAgentId: "requester",
			expectReply: true,
		});
		responderMailbox.acknowledgeDelivered(request.messageId);
		const reply = requesterMailbox.enqueue({
			kind: "follow_up",
			content: "Exact evidence.",
			senderAgentId: "responder",
			replyToMessageId: request.messageId,
			task: { kind: "agent_turn" },
		});
		expect(responderMailbox.awaitingReplies()).toHaveLength(1);

		control.reconcileTaskBearingMailboxTurns();
		expect(responderMailbox.awaitingReplies()).toEqual([]);
		expect(responderMailbox.getReplyAcknowledgementId(request.messageId)).toBe(reply.messageId);
		expect(prepareAgentTurn).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "requester", controlMessageId: reply.messageId }),
		);
		expect(
			control.mailboxMessagesForConversation(
				"requester",
				{ findDeliveredWorkerControlMessageIds: () => new Set([reply.messageId]) } as unknown as WorkerConversation,
				true,
			),
		).toEqual([]);
		expect(responderMailbox.getReplyAcknowledgementId(request.messageId)).toBeUndefined();

		attempt = { ...attempt!, status: "completed" };
		const divergentRequest = responderMailbox.enqueue({
			kind: "follow_up",
			content: "Return different evidence.",
			senderAgentId: "requester",
			expectReply: true,
		});
		responderMailbox.acknowledgeDelivered(divergentRequest.messageId);
		expect(
			responderMailbox.beginReplyAcknowledgement(
				divergentRequest.messageId,
				"divergent-reply-id",
				"Different evidence.",
			),
		).toBe(true);
		const divergentReply = requesterMailbox.enqueue({
			kind: "follow_up",
			content: "Different evidence.",
			senderAgentId: "responder",
			replyToMessageId: divergentRequest.messageId,
			task: { kind: "agent_turn" },
		});
		control.reconcileTaskBearingMailboxTurns();
		expect(prepareAgentTurn).toHaveBeenCalledTimes(1);
		expect(responderMailbox.getReplyAcknowledgementId(divergentRequest.messageId)).toBe("divergent-reply-id");
		expect(() =>
			control.mailboxMessagesForConversation(
				"requester",
				{
					findDeliveredWorkerControlMessageIds: () => new Set([divergentReply.messageId]),
				} as unknown as WorkerConversation,
				true,
			),
		).toThrow("identity conflicts");
		expect(requesterMailbox.pending()).toEqual([
			expect.objectContaining({ messageId: divergentReply.messageId, task: { kind: "agent_turn" } }),
		]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("identity conflicts"));
	});
});
