import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@caupulican/pi-ai";
import { expect, it, vi } from "vitest";
import { ownerOrchestrationHome } from "../src/core/agent-paths.ts";
import { refusalForSkip } from "../src/core/fleet/local-admit.ts";
import { dispatchForStorage, projectionRecordForStorage } from "../src/core/orchestration/dispatch-storage.ts";
import { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime } from "../src/core/orchestration/task-runtime.ts";
import { dispatchFromValue, projectionFromSnapshot } from "../src/core/orchestration/task-runtime-codecs.ts";
import { MAX_WORKER_BRIEF_CHARS } from "../src/core/orchestration/worker-brief-attachment.ts";
import { carriedPlansFold } from "../src/core/plan/plan-carry.ts";
import { planRecordFromValue } from "../src/core/plan/plan-codec.ts";
import { PLAN_RECORD_VERSION } from "../src/core/plan/plan-graph.ts";
import { MAX_JOB_INSTRUCTIONS_BYTES, MIN_JOB_DEADLINE_MS, parseJobFrame } from "../src/core/remote/job-protocol.ts";
import { createDelegateToolDefinition } from "../src/core/tools/delegate.ts";
import { inboxReplyPageJson } from "../src/core/tools/delegate-inbox-page.ts";
import { delegateValidationCorrection } from "../src/core/tools/delegate-rejections.ts";
import { createPlanToolDefinition } from "../src/core/tools/plan.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

it("delivers a long task alias as the original content at the dispatch limit", async () => {
	const runWorkerDelegation = vi.fn(async () => ({ started: false }));
	const tool = wrapToolDefinition(
		createDelegateToolDefinition({ caller: { kind: "session_root" }, runWorkerDelegation }),
	);
	const task = "x".repeat(MAX_WORKER_BRIEF_CHARS);
	const args = { action: "start" as const, task };
	expect(validateToolArguments(tool, { type: "toolCall", id: "brief", name: "delegate", arguments: args })).toBe(args);
	await tool.execute("brief", args);
	expect(runWorkerDelegation).toHaveBeenCalledWith(expect.objectContaining({ instructions: task }));
});

it.each([
	{ action: "start", instructions: "a".repeat(MAX_WORKER_BRIEF_CHARS + 1), expected: "Shorten the brief" },
	{
		action: "follow_up",
		agentId: "worker-1",
		message: "a".repeat(MAX_WORKER_BRIEF_CHARS + 1),
		expected: "Split the message",
	},
])("gives a usable correction for an oversized $action before any worker action", ({ expected, ...args }) => {
	const actions = ["start", "follow_up"];
	expect(delegateValidationCorrection(args, actions)).toContain(expected);
});

it("distinguishes permanent write-scope refusals from a temporary reservation conflict", () => {
	expect(refusalForSkip("write_reservation_scope_invalid")).toMatchObject({ reason: "preflight" });
	expect(refusalForSkip("write_reservation_unavailable")).toMatchObject({ reason: "ceiling" });
});

it("round-trips a long step intention with the plan that owns it and preserves historical decoding limits", () => {
	const intent = "w".repeat(2_865);
	const node = {
		id: "work",
		kind: "work",
		intent,
		inputs: [],
		after: [],
		writeScope: [],
		requirementIds: [],
		effort: "normal",
		since: 1,
	};
	const record = {
		v: PLAN_RECORD_VERSION,
		planId: "pl-12345678",
		version: 1,
		objectiveId: "obj-1",
		title: "Plan",
		nodes: [node],
		rootOwned: [],
		final: "work",
		status: "active",
		unjudged: true,
		judgments: [],
		createdAt: "2026-11-19T00:00:00Z",
		revisedAt: "2026-11-19T00:00:00Z",
	};
	expect(planRecordFromValue(record, "plan")).toEqual(record);
	expect(() => planRecordFromValue({ ...record, v: 3 }, "plan")).toThrow("2000 characters");
	expect(() => planRecordFromValue({ ...record, nodes: [{ ...node, intent: "x".repeat(4_097) }] }, "plan")).toThrow(
		"4096 characters",
	);
});

it("advertises the proof requirement on writable work steps before intake", () => {
	const tool = wrapToolDefinition(createPlanToolDefinition(() => undefined));
	const write = { id: "work", do: "Update the named file.", files: ["src/limit.ts"] };
	const validate = (step: Record<string, unknown>, action = "start") =>
		validateToolArguments(tool, {
			id: "plan",
			name: "plan",
			type: "toolCall",
			arguments: { action, title: "Update", steps: [step] },
		});
	expect(() => validate(write)).toThrow();
	// Re-stating an unchanged vintage node may be legal; intake owns the revision comparison.
	expect(validate(write, "revise")).toHaveProperty("steps");
	expect(() => validate({ ...write, req: [] })).toThrow();
	expect(validate({ ...write, req: ["R1"] })).toHaveProperty("steps");
	expect(validate({ ...write, proof: "diff" })).toHaveProperty("steps");
	expect(validate({ id: "read", do: "Read a file." })).toHaveProperty("steps");
});

it("retains a long dispatch across journal replay, compaction and restart without needing a worker file grant", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-worker-brief-"));
	try {
		const open = () =>
			new OrchestrationEventStore({ orchestrationHome: ownerOrchestrationHome(dir), sessionId: "parent" });
		const store = open();
		const runtime = new DurableTaskRuntime({ store });
		const { objectiveId } = runtime.createObjective({ title: "Work", description: "Prepare one worker" });
		const taskId = "long-task";
		const instructions = `${"\0📌".repeat(8_200)} exact trailing requirement. `;
		const { attempt } = runtime.prepareTaskAttempt(
			{ taskId, objectiveId, title: "Work", description: "Retain instructions", role: "implementer" },
			{ taskId, profileId: "reader", instructions, resourcePointerIds: [] },
		);
		const read = () =>
			new DurableTaskRuntime({ store: open() }).getSnapshot().attempts[attempt.attemptId]?.dispatch.instructions;
		expect(read()).toBe(instructions);
		const queued = store.readAfter(0).find((event) => event.type === "task.attempt_prepared");
		expect(queued?.payload.dispatch).toMatchObject({ instructions: { v: 1, encoding: "utf16le-base64" } });
		const state = runtime.getSnapshot();
		store.compactIfNeeded(state.lastOrdinal, carriedPlansFold(state), undefined, true);
		expect(store.readProjectionSnapshot()?.projection.attempts).toMatchObject({
			[attempt.attemptId]: { dispatch: { instructions: { v: 1, encoding: "utf16le-base64" } } },
		});
		expect(read()).toBe(instructions);
		const snapshot = store.readProjectionSnapshot()!;
		const corrupted = structuredClone(snapshot.projection);
		const attempts = corrupted.attempts as Record<string, { dispatch: { instructions: { sha256: string } } }>;
		attempts[attempt.attemptId]!.dispatch.instructions.sha256 = "0".repeat(64);
		expect(() => projectionFromSnapshot(corrupted, snapshot.throughOrdinal)).toThrow(
			"Worker brief attachment failed integrity validation",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("delivers every code unit of an escaped long root reply through bounded pages before acknowledging", () => {
	const content = '\u0000📌\\"'.repeat(10_000);
	const reply = {
		messageId: "reply-4",
		sourceAgentId: "worker-2",
		requestMessageId: "request-4",
		content,
		createdAt: "2026-11-19T00:00:00Z",
		ackToken: "final-page-token",
	};
	let cursor = 0;
	let received = "";
	while (cursor < content.length) {
		const json = inboxReplyPageJson([reply], cursor, 16 * 1024, (replies, omittedCount) => ({
			replies,
			omittedCount,
		}));
		expect(Buffer.byteLength(json)).toBeLessThanOrEqual(16 * 1024);
		const page = JSON.parse(json).replies[0];
		received += page.content;
		if (!page.next) {
			expect(page.ackToken).toBe(reply.ackToken);
			break;
		}
		expect(page.ackToken).toBeUndefined();
		expect(page.next).toMatchObject({ action: "inbox", messageId: reply.messageId });
		expect(page.next.cursor).toBeGreaterThan(cursor);
		cursor = page.next.cursor;
	}
	expect(received).toBe(content);
});

it("retains the full last task of a pruned specialist in its own agent record", () => {
	const instructions = "original task ".repeat(1_800);
	const dispatch = { taskId: "task-1", profileId: "reader", resourcePointerIds: [], instructions };
	const agent = { prunedTurns: { count: 1, last: { taskId: dispatch.taskId, attemptId: "attempt-1", dispatch } } };
	const stored = projectionRecordForStorage("agents", agent);
	const restored = JSON.parse(JSON.stringify(stored)).prunedTurns.last.dispatch;
	expect(restored.instructions).toMatchObject({ v: 1, encoding: "utf16le-base64" });
	expect(dispatchFromValue(restored, "last dispatch").instructions).toBe(instructions);
	expect(agent.prunedTurns.last.dispatch.instructions).toBe(instructions);
});

it("keeps legacy linked-job admission byte bounded and rejects local attachments as network instructions", () => {
	const parse = (instructions: unknown) =>
		parseJobFrame({
			t: "job.offer",
			offer: {
				v: 1,
				jobId: "offer-1",
				kind: "task",
				label: "Read",
				instructions,
				envelope: { writes: false },
				deadlineMs: MIN_JOB_DEADLINE_MS,
				hops: ["parent"],
			},
		});
	expect(parse("a".repeat(MAX_JOB_INSTRUCTIONS_BYTES))).toBeDefined();
	expect(parse("é".repeat(MAX_JOB_INSTRUCTIONS_BYTES / 2 + 1))).toBeUndefined();
	const dispatch = { taskId: "task-1", profileId: "reader", resourcePointerIds: [], instructions: "z".repeat(24_377) };
	expect(parse(dispatchForStorage(dispatch).instructions)).toBeUndefined();
});
