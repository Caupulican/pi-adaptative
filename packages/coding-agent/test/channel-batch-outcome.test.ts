import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createEmptyUsage } from "@caupulican/pi-ai";
import { expect, it } from "vitest";
import { type BatchBranchSource, readBatchOutcome } from "../src/core/channels/batch-outcome.ts";
import { type ChannelBatchRecord, DAY_MS } from "../src/core/channels/channel-journal.ts";
import { extensionSetupSessionManager } from "../src/core/extensions/factory-runtime.ts";
import { ownerSessionStorageRoots } from "../src/core/orchestration/session-bundle-lifecycle.ts";
import { ORDINARY_WORK_CONTINUATION_TYPE } from "../src/core/ordinary-work-policy.ts";
import { AUTHORITY_CONTEXT_CUSTOM_TYPE } from "../src/core/provider-request-context-controller.ts";
import { assertExtensionCustomType, isHostContextEntry, ownerChannelTurnOrigin } from "../src/core/turn-origin.ts";
import type { SessionEntry } from "../src/kernel/session/session-entries.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";
import { TOOL_FAILURE_LEDGER_TRANSIENT_KIND } from "../src/kernel/tool-failure-memory.ts";
import { commitTransientRecords, reconcileTransientRecords } from "../src/kernel/transient-records.ts";
import { VERIFICATION_OBLIGATION_TRANSIENT_KIND } from "../src/kernel/verification-obligations.ts";

const base = { parentId: null, timestamp: "2026-11-20T12:00:00Z" };
const batch: ChannelBatchRecord = {
	id: "telegram-batch",
	sessionId: "receiver",
	ownerSessionId: "owner",
	conversationKey: "phone",
	address: "owner-chat",
	eventDigests: ["event"],
	allowlisted: true,
	owner: true,
	acceptedAt: 0,
	state: "accepted",
};
const opening: SessionEntry = {
	...base,
	id: "request",
	type: "message",
	turnOrigin: ownerChannelTurnOrigin({ channel: "telegram", ref: batch.id }),
	message: { role: "user", content: "Read the count", timestamp: 1 },
};
function frame(text: string, usd: number, stopReason: AssistantMessage["stopReason"] = "stop"): SessionEntry {
	const usage = createEmptyUsage();
	usage.cost.total = usd;
	return {
		...base,
		type: "message",
		id: text,
		message: {
			role: "assistant",
			api: "openai-responses",
			provider: "fixture",
			model: "root",
			content: [{ type: "text", text }],
			usage,
			stopReason,
			timestamp: 1,
		},
	};
}
function reserved(change: Record<string, unknown> = {}): SessionEntry {
	return {
		...base,
		type: "custom_message",
		id: "continuation",
		customType: ORDINARY_WORK_CONTINUATION_TYPE,
		display: false,
		content: "Continue the original request",
		details: { sessionId: "owner", openingEntryId: opening.id, generation: 1, revision: 3, ...change },
	};
}
const first = frame("Three", 2);
const corrected = frame("Three in sample.conf", 3);
const other = frame("Another owner's private answer", 20);
const reporting = reserved({ responseMode: "answer_only", reportingRevision: true });
function read(entries: SessionEntry[], live = false, record = batch, at = 1) {
	const branch = [opening, ...entries];
	const source: BatchBranchSource = {
		getSessionManager: () => ({ getSessionId: () => "receiver", getBranch: () => [] }),
		getOwnerSessionManager: () => ({ getSessionId: () => "owner", getBranch: () => branch }),
		ownerDelivery: {
			holdsForeground: () => true,
			isAnsweringBatch: (channel, ref) => live && channel === "telegram" && ref === record.id,
		},
	};
	return readBatchOutcome(source, "telegram", record, at);
}

it("defers normal answers only through their own submission, then sends the corrected answer and its attributable spend", () => {
	expect(read([first], true)).toEqual({ kind: "waiting", usd: 2 });
	expect(read([first, reporting], true)).toEqual({ kind: "waiting", usd: 2 });
	expect(read([first, reporting, corrected], true)).toEqual({ kind: "waiting", usd: 5 });
	expect(read([first, reporting, corrected])).toEqual({ kind: "answered", text: "Three in sample.conf", usd: 5 });
	expect(read([first], true, batch, DAY_MS)).toEqual({ kind: "answered", text: "Three", usd: 2 });
	expect(read([first, other])).toEqual({ kind: "answered", text: "Three", usd: 2 });
});

it("marks a length-only partial and clears the marker when reserved ordinary work finishes", () => {
	const partial = frame("cut off", 1, "length");
	expect(read([partial])).toEqual({ kind: "answered", text: "cut off", truncated: true, usd: 1 });
	const tool = frame("tool call", 2, "toolUse");
	expect(read([partial, reserved(), tool, corrected])).toEqual({
		kind: "answered",
		text: "Three in sample.conf",
		usd: 6,
	});
	const next = reserved({ generation: 2, revision: 5, responseMode: "answer_only" });
	expect(read([partial, reserved(), first, next, corrected])).toEqual({
		kind: "answered",
		text: "Three in sample.conf",
		usd: 6,
	});
});

it.each([
	["other session", { sessionId: "receiver" }],
	["other opening", { openingEntryId: "foreign" }],
	["invalid generation", { generation: -1 }],
	["missing revision", { revision: undefined }],
	["unknown mode", { responseMode: "tool_capable" }],
	["reporting with tools", { reportingRevision: true }],
])("stops at a reservation with %s", (_label, details) => {
	expect(read([first, reserved(details as Record<string, unknown>), other])).toEqual({
		kind: "answered",
		text: "Three",
		usd: 2,
	});
});

it("stops at a replayed reservation before admitting another answer or spend", () => {
	expect(read([first, reporting, corrected, reporting, other])).toEqual({
		kind: "answered",
		text: "Three in sample.conf",
		usd: 5,
	});
});

it.each([
	[
		"another phone input",
		{
			...opening,
			id: "other-request",
			turnOrigin: ownerChannelTurnOrigin({ channel: "telegram", ref: "other-batch" }),
		},
	],
	[
		"a detached worker result",
		{
			...base,
			id: "job",
			type: "custom_message",
			customType: "background-worker-completion",
			details: {},
			display: true,
			content: "Worker finished",
		},
	],
	[
		"an extension input",
		{
			...base,
			id: "extension",
			type: "custom_message",
			customType: "public-update",
			display: true,
			content: "New task",
		},
	],
] as const)("preserves the earlier answer across %s, including during a correction", (_label, outside) => {
	expect(read([first, outside, reporting, other], true)).toEqual({ kind: "answered", text: "Three", usd: 2 });
	expect(read([first, reporting, outside, other], true)).toEqual({ kind: "answered", text: "Three", usd: 2 });
});

it.each(["aborted", "error", "stop"] as const)(
	"keeps the initial answer after a %s revision without a usable replacement",
	(reason) => {
		expect(read([first, reporting, frame("", 1, reason), other])).toEqual({
			kind: "answered",
			text: "Three",
			usd: 3,
		});
	},
);

it("leaves the owner batch unanswered when another input opens before any answer", () => {
	const update: SessionEntry = {
		...base,
		id: "external",
		type: "custom_message",
		customType: "extension-input",
		display: true,
		content: "Different request",
	};
	expect(read([update, other], true)).toEqual({ kind: "unanswered", reason: "mixed", usd: 0 });
});

it("delivers a recovered revision only when the next transport retries its exact failed frame", () => {
	const error = frame("connection lost", 1, "error");
	const again = frame("connection reset", 2, "error");
	const retry = (id: string, failed?: string): SessionEntry => ({
		...base,
		id,
		type: "request_snapshot",
		requestId: id,
		reason: "resume",
		api: "openai-responses",
		provider: "fixture",
		modelId: "root",
		effectiveConfigFingerprint: "config",
		systemFingerprint: "system",
		toolsFingerprint: "tools",
		historyFingerprint: "history",
		messageEntryIds: [],
		retryOfAssistantEntryId: failed,
	});
	const pending = [first, reporting, error];
	const linked = retry("retried", error.id);
	expect(read(pending, true)).toEqual({ kind: "waiting", usd: 3 });
	expect(read([...pending, linked, corrected])).toEqual({ kind: "answered", text: "Three in sample.conf", usd: 6 });
	expect(read([...pending, linked, again, retry("retried-again", again.id), corrected])).toEqual({
		kind: "answered",
		text: "Three in sample.conf",
		usd: 8,
	});
	const original = { kind: "answered", text: "Three", usd: 3 };
	expect(read([...pending, retry("unlinked"), other])).toEqual(original);
	expect(read([...pending, retry("wrong", "other-failure"), other])).toEqual(original);
	expect(read([...pending, linked, retry("another-request"), other])).toEqual(original);
	const foreign = {
		...opening,
		id: "foreign",
		turnOrigin: ownerChannelTurnOrigin({ channel: "telegram", ref: "different" }),
	};
	expect(read([...pending, linked, foreign, other])).toEqual(original);
	expect(
		read([
			...pending,
			linked,
			{
				...opening,
				turnOrigin: { v: 1, k: "inbound-channel", channel: "telegram", ref: batch.id, thirdParty: true },
			},
			other,
		]),
	).toEqual(original);
	expect(read([...pending, linked, again, linked, other])).toEqual({ ...original, usd: 5 });
});

it.each([TOOL_FAILURE_LEDGER_TRANSIENT_KIND, VERIFICATION_OBLIGATION_TRANSIENT_KIND, AUTHORITY_CONTEXT_CUSTOM_TYPE])(
	"carries a committed %s through the original turn and its reserved revision",
	async (kind) => {
		const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()));
		const records = reconcileTransientRecords(
			[],
			[{ kind, content: "Current context", clearedText: "cleared" }],
			[],
		).records;
		await commitTransientRecords({ systemPrompt: "", messages: [], tools: [] }, records, (pending) => {
			for (const message of pending) {
				if (message.role !== "custom") throw new Error("Expected a planner record");
				manager.appendMessageBatch([{ kind: "custom", message }]);
			}
		});
		const row = manager.getLeafEntry()!;
		expect(row).toMatchObject({ type: "custom_message", customType: kind, origin: "local" });
		expect(isHostContextEntry(row)).toBe(true);
		expect(read([row, first, reporting, row, corrected])).toEqual({
			kind: "answered",
			text: "Three in sample.conf",
			usd: 5,
		});
		expect(() => assertExtensionCustomType(kind)).toThrow(/reserved/);
		const msg = records[0];
		if (msg?.role !== "custom") throw new Error("Expected a custom message");
		const setup = extensionSetupSessionManager(manager);
		expect(() => setup.appendMessageBatch([{ kind: "custom", message: structuredClone(msg) }])).toThrow(/reserved/);
		for (const method of ["appendMessageBatchWithReceipt", "appendMessageBatchAwaitable"] as const) {
			expect(() => setup[method]([[{ kind: "custom", message: structuredClone(msg) }]], () => [])).toThrow(
				/reserved by the host/,
			);
		}
		expect(() =>
			Reflect.apply(setup.appendMessageBatch, setup, [
				[{ kind: "message", message: structuredClone(msg), origin: "local" }],
			]),
		).toThrow(/reserved/);
		const unproven = { ...row, origin: undefined };
		expect(isHostContextEntry(unproven)).toBe(kind === AUTHORITY_CONTEXT_CUSTOM_TYPE);
		if (kind !== AUTHORITY_CONTEXT_CUSTOM_TYPE) {
			expect(read([first, reporting, unproven, other])).toEqual({ kind: "answered", text: "Three", usd: 2 });
		}
	},
);

it("treats an extension planner contribution and a peer between answers as outside inputs", () => {
	const injection: SessionEntry = {
		...base,
		type: "custom_message",
		id: "extension",
		customType: "outside-extension",
		content: "private",
		display: false,
		origin: "local",
		details: { superseding: true },
	};
	const peer: SessionEntry = {
		...opening,
		id: "peer",
		turnOrigin: {
			v: 1,
			k: "inbound-channel",
			thirdParty: true,
			channel: "third-party",
			verified: true,
			ref: "peer-message",
		},
	};
	for (const outside of [peer, injection]) {
		expect(read([outside, other])).toEqual({ kind: "unanswered", reason: "mixed", usd: 0 });
		expect(read([first, reporting, outside, other])).toEqual({ kind: "answered", text: "Three", usd: 2 });
	}
});

it("does not treat a legacy raw custom message as a host-persisted reservation", () => {
	const raw: SessionEntry = {
		...base,
		type: "message",
		id: "raw",
		message: {
			role: "custom",
			customType: ORDINARY_WORK_CONTINUATION_TYPE,
			content: "Continue",
			display: false,
			details: { sessionId: "owner", openingEntryId: opening.id, generation: 1, revision: 3 },
			timestamp: 1,
		},
	};
	expect(read([first, raw, other])).toEqual({ kind: "answered", text: "Three", usd: 2 });
});

it("keeps a real planner pointer and its cleared record in the same request after reopen", async ({
	onTestFinished,
}) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-batch-context-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	const roots = ownerSessionStorageRoots(dir);
	const manager = SessionManager.create(dir, roots);
	const kind = TOOL_FAILURE_LEDGER_TRANSIENT_KIND;
	const slot = {
		kind,
		content: "A failed tool request",
		clearedText: "cleared",
		trailing: true,
		header: "Tool notes",
	};
	const full = reconcileTransientRecords([], [slot], []).records;
	const history = [...full, { role: "user" as const, content: "Continue", timestamp: 1 }];
	const pointer = reconcileTransientRecords(history, [slot], history).records;
	const cleared = reconcileTransientRecords(
		[...history, ...pointer],
		[{ ...slot, content: undefined }],
		[...history, ...pointer],
	).records;
	expect(pointer).toMatchObject([{ role: "custom", details: { pointer: true } }]);
	expect(cleared).toMatchObject([{ role: "custom", details: { superseding: true } }]);
	await commitTransientRecords({ systemPrompt: "", messages: [] }, [...pointer, ...cleared], (pending) => {
		for (const message of pending) {
			if (message.role !== "custom") throw new Error("Expected a planner record");
			manager.appendMessageBatch([{ kind: "custom", message }]);
		}
	});
	manager.flushBufferedEntries();
	const entries = SessionManager.open(manager.getSessionFile()!, roots).getBranch();
	expect(entries).toHaveLength(2);
	expect(entries.every(isHostContextEntry)).toBe(true);
	expect(read([first, reporting, ...entries, corrected])).toEqual({
		kind: "answered",
		text: "Three in sample.conf",
		usd: 5,
	});
});

it("never treats a raw nested custom message as a proven host context entry", () => {
	const raw: SessionEntry = {
		...base,
		type: "message",
		id: "raw",
		origin: "local",
		message: {
			role: "custom",
			customType: AUTHORITY_CONTEXT_CUSTOM_TYPE,
			content: "Lookalike",
			details: { superseding: true },
			display: false,
			timestamp: 1,
		},
	};
	expect(isHostContextEntry(raw)).toBe(false);
	expect(read([first, reporting, raw, other])).toEqual({ kind: "answered", text: "Three", usd: 2 });
});
