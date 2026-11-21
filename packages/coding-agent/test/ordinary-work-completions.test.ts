import { expect, it } from "vitest";
import { ordinaryCompletionReports } from "../src/core/ordinary-work-completions.ts";
import type { OrdinaryWorkRecord } from "../src/core/ordinary-work-controller.ts";
import type { SessionEntry } from "../src/kernel/session/session-entries.ts";

const record: OrdinaryWorkRecord = {
	sessionId: "parent",
	openingEntryId: "opening",
	frontierEntryId: "opening",
	generation: 0,
	revision: 1,
	status: "active",
	continuationCount: 0,
	openedAt: 0,
	updatedAt: 1,
};
const stamp = { parentId: null, timestamp: "2026-11-20T12:00:00Z" };
const opening: SessionEntry = {
	...stamp,
	type: "message",
	id: "opening",
	message: { role: "user", content: "Review the two reports", timestamp: 10 },
};
function launch(id: string, toolName: string, details: unknown): SessionEntry {
	return {
		...stamp,
		id,
		type: "message",
		message: {
			role: "toolResult",
			toolName,
			toolCallId: id,
			content: [],
			isError: false,
			details,
			timestamp: 11,
		},
	};
}
function handoff(id: string, type: string, details: unknown): SessionEntry {
	return {
		...stamp,
		id,
		type: "custom_message",
		customType: type,
		content: "UNSCOPED BATCH TEXT",
		details,
		display: true,
	};
}

it("keeps only the request's records in a mixed worker delivery, including a later fan-out member", () => {
	const start = launch("dispatch", "delegate", {
		started: true,
		action: "start",
		fanout: { members: [{ laneId: "a" }, { laneId: "b" }] },
	});
	const batch = handoff("batch", "background-worker-completion", {
		records: [
			{ laneId: "b", status: "partial", claim: { summary: "own finding" } },
			{
				laneId: "a",
				status: "succeeded",
				served: { sessionId: "parent", leafId: "another-request" },
				claim: { summary: "foreign finding" },
			},
			{ laneId: "other", status: "succeeded", claim: { summary: "another lane" } },
		],
	});
	const entries = [opening, start, batch];
	const result = ordinaryCompletionReports({ entries, record });
	expect(result.fresh).toBe(true);
	expect(result.reports).toHaveLength(1);
	expect(JSON.parse(result.reports[0]!)).toEqual({
		laneId: "b",
		status: "partial",
		claim: { summary: "own finding" },
	});
	expect(
		ordinaryCompletionReports({
			entries: [...entries, { ...batch, id: "replay" }],
			record: { ...record, frontierEntryId: "batch" },
		}),
	).toEqual({ ...result, fresh: false });
	expect(ordinaryCompletionReports({ entries: [opening, batch, start], record }).reports).toEqual([]);
	expect(ordinaryCompletionReports({ entries, record: { ...record, status: "waiting" } }).reports).toEqual([]);
	expect(
		ordinaryCompletionReports({ entries, record: { ...record, status: "waiting", frontierEntryId: start.id } }).fresh,
	).toBe(true);
});

it("checks the served work of the exact worker attempt, and rejects a third-party completion", () => {
	const details = {
		records: [
			{ served: { sessionId: "parent", leafId: "opening" }, laneId: "work", attemptId: "new", status: "failed" },
		],
	};
	const event = (extra: object) => handoff("batch", "background-worker-completion", { ...details, ...extra });
	expect(ordinaryCompletionReports({ entries: [opening, event({})], record }).fresh).toBe(true);
	expect(ordinaryCompletionReports({ entries: [opening, event({ thirdParty: true })], record }).fresh).toBe(false);
});

it("binds a background tool to the detached task, tool name and call before considering its status", () => {
	const start = launch("call", "read", { sessionId: "parent", taskId: "task", status: "running" });
	const own = { toolName: "read", toolCallId: "call", taskId: "task", status: "failed" };
	const rows = [
		own,
		{ ...own, taskId: "other", status: "completed" },
		{ ...own, toolName: "write", status: "completed" },
	];
	const event = handoff("mixed", "background-tool-completion", { records: rows });
	const result = ordinaryCompletionReports({ entries: [opening, start, event], record });
	expect(result.fresh).toBe(true);
	expect(result.reports).toHaveLength(1);
	expect(JSON.parse(result.reports[0]!)).toMatchObject(own);
	expect(ordinaryCompletionReports({ entries: [opening, event], record }).fresh).toBe(false);
});
