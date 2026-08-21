import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	decodeSessionLifecycleEntry,
	inspectSessionLifecycle,
	MAX_LIFECYCLE_PAYLOAD_CHARS,
	planSessionLifecycleRepair,
	type SessionEntry,
	SessionManager,
	TOOL_OUTCOME_UNKNOWN,
} from "../../src/session/session-manager.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = join(tmpdir(), `pi-lifecycle-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

function requestSnapshot(requestId = "request-1") {
	return {
		requestId,
		reason: "initial" as const,
		api: "faux",
		provider: "test",
		modelId: "model",
		effectiveConfigFingerprint: "config-sha256",
		systemFingerprint: "system-sha256",
		toolsFingerprint: "tools-sha256",
		historyFingerprint: "history-sha256",
		messageEntryIds: [],
	};
}

function appendAssistantTools(session: SessionManager, ...calls: Array<{ id: string; name: string }>): string {
	return session.appendMessage(
		fauxAssistantMessage(
			calls.map(({ id, name }) => fauxToolCall(name, {}, { id })),
			{ stopReason: "toolUse" },
		),
	);
}

function appendToolResult(session: SessionManager, callId: string, toolName = "read", isError = false): string {
	return session.appendMessage({
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text: isError ? "failed" : "ok" }],
		isError,
		errorKind: isError ? "tool_failure" : undefined,
		timestamp: Date.now(),
	});
}

function entry<T extends SessionEntry>(entry: T): T {
	return entry;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session lifecycle ledger", () => {
	it("loads a v3 session, migrates it to v4, and excludes lifecycle records from context", () => {
		const dir = makeTempDir();
		const file = join(dir, "legacy.jsonl");
		writeFileSync(
			file,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "legacy",
					timestamp: "2025-01-01T00:00:00.000Z",
					cwd: dir,
				}),
				JSON.stringify({
					type: "message",
					id: "user-1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01.000Z",
					message: { role: "user", content: "keep me", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);

		const session = SessionManager.open(file, dir, dir);
		expect(session.getHeader()?.version).toBe(4);
		expect(session.buildSessionContext().messages).toEqual([{ role: "user", content: "keep me", timestamp: 1 }]);
	});

	it("rejects malformed, secret-sized, non-canonical, and negative-zero lifecycle fields", () => {
		const base = {
			type: "request_snapshot",
			id: "entry-1",
			parentId: null,
			timestamp: "2025-01-01T00:00:00.000Z",
			...requestSnapshot(),
		};
		expect(() => decodeSessionLifecycleEntry({ ...base, toolCallIds: [] })).toThrow(/unknown field/);
		expect(() => decodeSessionLifecycleEntry({ ...base, systemFingerprint: "x".repeat(4 * 1024 + 1) })).toThrow(
			/characters/,
		);
		expect(() =>
			decodeSessionLifecycleEntry({
				type: "compaction_end",
				id: "end-large",
				parentId: null,
				timestamp: "2025-01-01T00:00:00.000Z",
				compactionId: "compact-large",
				outcome: "failure",
				error: "x".repeat(MAX_LIFECYCLE_PAYLOAD_CHARS),
			}),
		).toThrow(/serialized record exceeds/);
		expect(() => decodeSessionLifecycleEntry({ ...base, timestamp: "2025-01-01T00:00:00Z" })).toThrow(
			/canonical ISO/,
		);
		expect(() => decodeSessionLifecycleEntry({ ...base, timestamp: "2025-01-01T02:00:00.000+02:00" })).toThrow(
			/canonical ISO/,
		);
		expect(() =>
			decodeSessionLifecycleEntry({ ...base, messageEntryIds: Array.from({ length: 257 }, () => "entry") }),
		).toThrow(/identifiers/);
		expect(() => decodeSessionLifecycleEntry({ ...base, reason: "secret-token" })).toThrow(
			/initial, resume, or change/,
		);
		expect(() =>
			decodeSessionLifecycleEntry({
				type: "compaction_start",
				id: "start-1",
				parentId: null,
				timestamp: "2025-01-01T00:00:00.000Z",
				compactionId: "provider:compaction|1",
				firstKeptEntryId: "entry-1",
				tokensBefore: -0,
			}),
		).toThrow(/-0/);
		expect(() =>
			decodeSessionLifecycleEntry({
				type: "compaction_end",
				id: "end-1",
				parentId: null,
				timestamp: "2025-01-01T00:00:00.000Z",
				compactionId: "compaction-1",
				outcome: "success",
			}),
		).toThrow(/compactionEntryId/);
		expect(() =>
			decodeSessionLifecycleEntry({
				type: "foreground_tool_terminal",
				id: "terminal-1",
				parentId: null,
				timestamp: "2025-01-01T00:00:00.000Z",
				requestId: "request-1",
				assistantMessageEntryId: "assistant-1",
				callId: "call-1",
				toolName: "read",
				outcome: "success",
			}),
		).toThrow(/resultMessageEntryId/);
	});

	it("accepts provider identifiers containing colon and pipe and keeps model order", () => {
		const session = SessionManager.inMemory();
		session.appendRequestSnapshot(requestSnapshot("provider:req|1"));
		const assistantMessageEntryId = appendAssistantTools(
			session,
			{ id: "provider:call|1", name: "read" },
			{ id: "provider:call|2", name: "write" },
		);
		const startEntryId = session.appendForegroundToolStart(
			"provider:req|1",
			assistantMessageEntryId,
			"provider:call|2",
			"write",
		);
		const inspection = inspectSessionLifecycle(session.getEntries());
		expect(inspection.assistantToolCalls.map((call) => call.callId)).toEqual(["provider:call|1", "provider:call|2"]);
		expect(inspection.unknownToolOutcomes[0]).toMatchObject({
			requestId: "provider:req|1",
			assistantMessageEntryId,
			callId: "provider:call|2",
			startEntryId,
		});
	});

	it("scans a batched assistant tool wave once before direct lifecycle validation", () => {
		const session = SessionManager.inMemory();
		session.appendRequestSnapshot(requestSnapshot());
		const calls = Array.from({ length: 64 }, (_, index) => ({ id: `wave-call-${index}`, name: "read" }));
		const assistant = fauxAssistantMessage(
			calls.map(({ id, name }) => fauxToolCall(name, {}, { id })),
			{ stopReason: "toolUse" },
		);
		const content = assistant.content;
		let contentReads = 0;
		Object.defineProperty(assistant, "content", {
			configurable: true,
			enumerable: true,
			get: () => {
				contentReads += 1;
				return content;
			},
		});
		const assistantMessageEntryId = session.appendMessage(assistant);
		session.appendForegroundToolStarts(
			calls.map(({ id, name }) => ({
				requestId: "request-1",
				assistantMessageEntryId,
				callId: id,
				toolName: name,
			})),
		);
		expect(contentReads).toBe(1);
	});

	it("uses composite request/assistant/call identity when call ids are reused across requests", () => {
		const session = SessionManager.inMemory();
		session.appendRequestSnapshot(requestSnapshot("request-1"));
		const firstAssistantId = appendAssistantTools(session, { id: "shared-call", name: "read" });
		const firstResultId = appendToolResult(session, "shared-call");
		session.appendRequestSnapshot(requestSnapshot("request-2"));
		const secondAssistantId = appendAssistantTools(session, { id: "shared-call", name: "read" });
		const secondResultId = appendToolResult(session, "shared-call");

		const inspection = inspectSessionLifecycle(session.getEntries());
		expect(inspection.assistantToolCalls.map((call) => call.assistantMessageEntryId)).toEqual([
			firstAssistantId,
			secondAssistantId,
		]);
		expect(inspection.toolResults.map((result) => [result.requestId, result.resultMessageEntryId])).toEqual([
			["request-1", firstResultId],
			["request-2", secondResultId],
		]);
		expect(inspection.toolsByIdentity).toHaveProperty("size", 2);
		expect(inspection.balanced).toBe(true);
	});

	it("treats a canonical result without a start as immediate balanced completion", () => {
		const session = SessionManager.inMemory();
		session.appendRequestSnapshot(requestSnapshot());
		appendAssistantTools(session, { id: "call-immediate", name: "read" });
		appendToolResult(session, "call-immediate");

		const inspection = inspectSessionLifecycle(session.getEntries());
		expect(inspection.terminalPromotions).toEqual([]);
		expect(inspection.unstartedTools).toEqual([]);
		expect(inspection.balanced).toBe(true);
		expect(planSessionLifecycleRepair(session.getEntries())).toEqual({
			refused: false,
			refusalReasons: [],
			toolClosers: [],
			terminalPromotions: [],
			compactionClosers: [],
		});
	});

	it("promotes a canonical result only when a durable start exists", () => {
		const session = SessionManager.inMemory();
		session.appendRequestSnapshot(requestSnapshot());
		const assistantMessageEntryId = appendAssistantTools(session, { id: "call-promote", name: "read" });
		session.appendForegroundToolStart("request-1", assistantMessageEntryId, "call-promote", "read");
		const resultMessageEntryId = appendToolResult(session, "call-promote");

		const inspection = inspectSessionLifecycle(session.getEntries());
		expect(inspection.terminalPromotions).toEqual([
			{
				requestId: "request-1",
				assistantMessageEntryId,
				toolName: "read",
				callId: "call-promote",
				resultMessageEntryId,
				outcome: "success",
			},
		]);
		expect(planSessionLifecycleRepair(session.getEntries()).refused).toBe(false);
	});

	it("classifies a started call without a result or terminal as outcome unknown", () => {
		const session = SessionManager.inMemory();
		session.appendRequestSnapshot(requestSnapshot());
		const assistantMessageEntryId = appendAssistantTools(session, { id: "call-unknown", name: "write" });
		const startEntryId = session.appendForegroundToolStart(
			"request-1",
			assistantMessageEntryId,
			"call-unknown",
			"write",
		);
		const inspection = inspectSessionLifecycle(session.getEntries());
		expect(inspection.unknownToolOutcomes).toMatchObject([
			{ requestId: "request-1", assistantMessageEntryId, toolName: "write", callId: "call-unknown", startEntryId },
		]);
		expect(planSessionLifecycleRepair(session.getEntries()).toolClosers).toEqual([
			{
				requestId: "request-1",
				assistantMessageEntryId,
				toolName: "write",
				callId: "call-unknown",
				code: TOOL_OUTCOME_UNKNOWN,
				sourceEntryId: startEntryId,
			},
		]);
	});

	it("maps a legacy assistant call without a request snapshot to outcome unknown, never not-started", () => {
		const session = SessionManager.inMemory();
		const assistantMessageEntryId = appendAssistantTools(session, { id: "legacy-call", name: "read" });
		const inspection = inspectSessionLifecycle(session.getEntries());
		expect(inspection.unstartedTools).toMatchObject([{ assistantMessageEntryId, callId: "legacy-call" }]);
		expect(planSessionLifecycleRepair(session.getEntries()).toolClosers).toEqual([
			{
				assistantMessageEntryId,
				toolName: "read",
				callId: "legacy-call",
				code: TOOL_OUTCOME_UNKNOWN,
			},
		]);
	});

	it("refuses duplicate, mismatched, and out-of-order lifecycle repairs", () => {
		const session = SessionManager.inMemory();
		session.appendRequestSnapshot(requestSnapshot());
		const assistantMessageEntryId = appendAssistantTools(session, { id: "call-duplicate", name: "read" });
		const startEntryId = session.appendForegroundToolStart(
			"request-1",
			assistantMessageEntryId,
			"call-duplicate",
			"read",
		);
		const starts = session.getEntries();
		const start = starts.find((candidate) => candidate.id === startEntryId);
		if (!start || start.type !== "foreground_tool_start") throw new Error("start fixture missing");
		const duplicate = entry({ ...start, id: "duplicate-start", parentId: start.id });
		const duplicateInspection = inspectSessionLifecycle([...starts, duplicate]);
		expect(duplicateInspection.duplicateToolStarts).toHaveLength(1);
		expect(planSessionLifecycleRepair([...starts, duplicate]).refused).toBe(true);
		expect(() => session.appendRequestSnapshot(requestSnapshot())).toThrow(/duplicate request snapshot/i);

		const duplicateTerminalSession = SessionManager.inMemory();
		duplicateTerminalSession.appendRequestSnapshot(requestSnapshot());
		const duplicateTerminalAssistantId = appendAssistantTools(duplicateTerminalSession, {
			id: "call-duplicate-terminal",
			name: "read",
		});
		duplicateTerminalSession.appendForegroundToolStart(
			"request-1",
			duplicateTerminalAssistantId,
			"call-duplicate-terminal",
			"read",
		);
		const duplicateTerminalResultId = appendToolResult(duplicateTerminalSession, "call-duplicate-terminal");
		duplicateTerminalSession.appendForegroundToolTerminal(
			"request-1",
			duplicateTerminalAssistantId,
			"call-duplicate-terminal",
			"read",
			"success",
			{ resultMessageEntryId: duplicateTerminalResultId },
		);
		expect(() =>
			duplicateTerminalSession.appendForegroundToolTerminal(
				"request-1",
				duplicateTerminalAssistantId,
				"call-duplicate-terminal",
				"read",
				"success",
				{ resultMessageEntryId: duplicateTerminalResultId },
			),
		).toThrow(/duplicate foreground tool terminal/i);

		const duplicateCompactionSession = SessionManager.inMemory();
		const duplicateCompactionUserId = duplicateCompactionSession.appendMessage({
			role: "user",
			content: "compact",
			timestamp: 1,
		});
		duplicateCompactionSession.appendCompactionStart("duplicate-compaction", duplicateCompactionUserId, 1);
		expect(() =>
			duplicateCompactionSession.appendCompactionStart("duplicate-compaction", duplicateCompactionUserId, 1),
		).toThrow(/duplicate compaction start/i);
		const duplicateCompactionEntry = duplicateCompactionSession.appendCompaction(
			"summary",
			duplicateCompactionUserId,
			1,
		);
		duplicateCompactionSession.appendCompactionEnd("duplicate-compaction", "success", {
			compactionEntryId: duplicateCompactionEntry,
		});
		expect(() =>
			duplicateCompactionSession.appendCompactionEnd("duplicate-compaction", "success", {
				compactionEntryId: duplicateCompactionEntry,
			}),
		).toThrow(/duplicate compaction end/i);

		const duplicateResultSession = SessionManager.inMemory();
		duplicateResultSession.appendRequestSnapshot(requestSnapshot());
		appendAssistantTools(duplicateResultSession, { id: "call-duplicate-result", name: "read" });
		appendToolResult(duplicateResultSession, "call-duplicate-result");
		appendToolResult(duplicateResultSession, "call-duplicate-result");
		const duplicateResultInspection = inspectSessionLifecycle(duplicateResultSession.getEntries());
		expect(duplicateResultInspection.duplicateToolResults).toHaveLength(1);
		expect(planSessionLifecycleRepair(duplicateResultSession.getEntries()).refused).toBe(true);

		const outOfOrderSession = SessionManager.inMemory();
		outOfOrderSession.appendRequestSnapshot(requestSnapshot());
		const outOfOrderAssistantId = appendAssistantTools(outOfOrderSession, { id: "call-out-of-order", name: "read" });
		const outOfOrderResultId = appendToolResult(outOfOrderSession, "call-out-of-order");
		const terminalId = "terminal-out-of-order";
		const outOfOrderTerminal = entry({
			type: "foreground_tool_terminal",
			id: terminalId,
			parentId: outOfOrderResultId,
			timestamp: "2025-01-01T00:00:02.000Z",
			requestId: "request-1",
			assistantMessageEntryId: outOfOrderAssistantId,
			callId: "call-out-of-order",
			toolName: "read",
			outcome: "success",
			resultMessageEntryId: outOfOrderResultId,
		});
		const outOfOrderStart = entry({
			type: "foreground_tool_start",
			id: "start-out-of-order",
			parentId: terminalId,
			timestamp: "2025-01-01T00:00:03.000Z",
			requestId: "request-1",
			assistantMessageEntryId: outOfOrderAssistantId,
			callId: "call-out-of-order",
			toolName: "read",
		});
		expect(
			inspectSessionLifecycle([...outOfOrderSession.getEntries(), outOfOrderTerminal, outOfOrderStart])
				.outOfOrderToolEntries,
		).toContain(terminalId);
		const malformedTerminal = {
			type: "foreground_tool_terminal",
			id: "bad-terminal",
			parentId: startEntryId,
			timestamp: "2025-01-01T00:00:00.000Z",
			requestId: "request-1",
			assistantMessageEntryId,
			callId: "call-duplicate",
			toolName: "wrong-tool",
			outcome: "success",
		} as unknown as SessionEntry;
		const mismatchInspection = inspectSessionLifecycle([...session.getEntries(), malformedTerminal]);
		expect(mismatchInspection.mismatchedToolEntries).toContain("bad-terminal");
		expect(mismatchInspection.refusalReasons.length).toBeGreaterThan(0);
	});

	it("keeps lifecycle inspection branch-scoped and repair planning idempotent", () => {
		const session = SessionManager.inMemory();
		const requestEntryId = session.appendRequestSnapshot(requestSnapshot());
		appendAssistantTools(session, { id: "call-a", name: "read" });
		session.branch(requestEntryId);
		const branchAssistantId = appendAssistantTools(session, { id: "call-b", name: "read" });
		appendToolResult(session, "call-b");
		const activeEntries = session.getEntries();
		const activeInspection = inspectSessionLifecycle(activeEntries, session.getLeafId());
		expect(activeInspection.assistantToolCalls.map((call) => call.callId)).toEqual(["call-b"]);
		const plan = planSessionLifecycleRepair(activeEntries, session.getLeafId());
		expect(plan).toEqual(planSessionLifecycleRepair(activeEntries, session.getLeafId()));
		expect(plan.refused).toBe(false);
		expect(activeInspection.assistantToolCalls[0]?.assistantMessageEntryId).toBe(branchAssistantId);
	});

	it("represents successful, failed, cancelled, and orphaned compactions with strict references", () => {
		const session = SessionManager.inMemory();
		const userEntryId = session.appendMessage({ role: "user", content: "compact me", timestamp: Date.now() });
		const successStart = session.appendCompactionStart("compaction-success", userEntryId, 10);
		const successEntry = session.appendCompaction("summary", userEntryId, 11);
		session.appendCompactionEnd("compaction-success", "success", { compactionEntryId: successEntry });
		session.appendCompactionStart("compaction-failed", userEntryId, 20);
		session.appendCompactionEnd("compaction-failed", "failure", { error: "provider failed" });
		session.appendCompactionStart("compaction-cancelled", userEntryId, 30);
		session.appendCompactionEnd("compaction-cancelled", "cancelled");
		const orphanStart = session.appendCompactionStart("compaction-orphan", userEntryId, 40);
		const inspection = inspectSessionLifecycle(session.getEntries());
		expect(inspection.orphanedCompactions.map((candidate) => candidate.id)).toEqual([orphanStart]);
		expect(planSessionLifecycleRepair(session.getEntries()).compactionClosers).toEqual([
			{ compactionId: "compaction-orphan", sourceEntryId: orphanStart, outcome: "interrupted" },
		]);
		expect(successStart).toBeTruthy();
		expect(() => session.appendCompactionStart("bad", "missing-entry", 0)).toThrow(/earlier active-branch/);
	});

	it("permits retry-adjusted compaction metadata and rejects bad references and terminal contradictions", () => {
		const entries: SessionEntry[] = [
			entry({
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: "2025-01-01T00:00:00.000Z",
				message: { role: "user", content: "x", timestamp: 1 },
			}),
			entry({
				type: "compaction_start",
				id: "compact-start",
				parentId: "user-1",
				timestamp: "2025-01-01T00:00:01.000Z",
				compactionId: "compact",
				firstKeptEntryId: "user-1",
				tokensBefore: 10,
			}),
			entry({
				type: "compaction",
				id: "compact-summary",
				parentId: "compact-start",
				timestamp: "2025-01-01T00:00:02.000Z",
				summary: "x",
				firstKeptEntryId: "user-1",
				tokensBefore: 11,
			}),
			entry({
				type: "compaction_end",
				id: "compact-end",
				parentId: "compact-summary",
				timestamp: "2025-01-01T00:00:03.000Z",
				compactionId: "compact",
				outcome: "success",
				compactionEntryId: "compact-summary",
			}),
		];
		const compactionInspection = inspectSessionLifecycle(entries);
		expect(compactionInspection.invalidCompactionReferences).toEqual([]);
		expect(planSessionLifecycleRepair(entries).refused).toBe(false);
		const badReference = entries.map((candidate) =>
			candidate.id === "compact-end"
				? {
						...candidate,
						compactionEntryId: "user-1",
					}
				: candidate,
		);
		expect(inspectSessionLifecycle(badReference).invalidCompactionReferences).toEqual(["compact"]);
		expect(planSessionLifecycleRepair(badReference).refused).toBe(true);

		const session = SessionManager.inMemory();
		session.appendRequestSnapshot(requestSnapshot());
		const assistantId = appendAssistantTools(session, { id: "contradictory", name: "read" });
		session.appendForegroundToolStart("request-1", assistantId, "contradictory", "read");
		const resultId = appendToolResult(session, "contradictory");
		expect(() =>
			session.appendForegroundToolTerminal("request-1", assistantId, "contradictory", "read", "error", {
				resultMessageEntryId: resultId,
				errorKind: "tool_failure",
			}),
		).toThrow(/contradict/);
	});

	it("force-flushes lifecycle records before any assistant and reopens them", () => {
		const dir = makeTempDir();
		const session = SessionManager.create(dir, dir, dir);
		const snapshotId = session.appendRequestSnapshot(requestSnapshot());
		const file = session.getSessionFile();
		expect(file && existsSync(file)).toBe(true);
		const lines = readFileSync(file!, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1]!).id).toBe(snapshotId);
		const reopened = SessionManager.open(file!, dir, dir);
		expect(reopened.getEntries().map((candidate) => candidate.type)).toEqual(["request_snapshot"]);
		expect(reopened.buildSessionContext().messages).toEqual([]);
	});

	it("prevalidates the complete start batch and publishes neither partial memory nor disk state", () => {
		const dir = makeTempDir();
		const session = SessionManager.create(dir, dir, dir);
		session.appendRequestSnapshot(requestSnapshot());
		const assistantId = appendAssistantTools(session, { id: "batch-valid", name: "read" });
		const file = session.getSessionFile()!;
		const beforeEntries = session.getEntries();
		const beforeBytes = readFileSync(file, "utf8");
		expect(() =>
			session.appendForegroundToolStarts([
				{ requestId: "request-1", assistantMessageEntryId: assistantId, callId: "batch-valid", toolName: "read" },
				{ requestId: "request-1", assistantMessageEntryId: assistantId, callId: "missing", toolName: "read" },
			]),
		).toThrow(/exactly one assistant tool call/);
		expect(session.getEntries()).toEqual(beforeEntries);
		expect(readFileSync(file, "utf8")).toBe(beforeBytes);
	});

	it("atomically appends mixed canonical and custom messages in source order", () => {
		const dir = makeTempDir();
		const session = SessionManager.create(dir, dir, dir);
		session.appendMessage({ role: "user", content: "root", timestamp: 1 });
		session.appendMessage(fauxAssistantMessage([{ type: "text", text: "ready" }], { stopReason: "stop" }));
		const file = session.getSessionFile();
		if (!file) throw new Error("Expected a persisted session file.");
		const beforeBytes = readFileSync(file, "utf8");
		const ids = session.appendMessageBatch([
			{ kind: "message", message: { role: "user", content: "buffered", timestamp: 2 } },
			{
				kind: "custom",
				message: {
					role: "custom",
					customType: "router",
					content: "buffered custom",
					display: false,
					timestamp: 3,
				},
			},
		]);
		expect(ids).toHaveLength(2);
		expect(
			session
				.getEntries()
				.slice(-2)
				.map((candidate) => candidate.type),
		).toEqual(["message", "custom_message"]);
		expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(
			beforeBytes.split("\n").filter(Boolean).length + 2,
		);
		expect(() =>
			session.appendMessageBatch(
				Array.from({ length: 257 }, () => ({
					kind: "message" as const,
					message: { role: "user" as const, content: "too many", timestamp: 4 },
				})),
			),
		).toThrow(/more than 256 entries/);

		const beforeEntries = session.getEntries();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() =>
			session.appendMessageBatch([
				{ kind: "message", message: { role: "user", content: "would-be-first", timestamp: 4 } },
				{
					kind: "custom",
					message: {
						role: "custom",
						customType: "invalid",
						content: "would fail encoding",
						display: false,
						details: circular,
						timestamp: 5,
					},
				},
			]),
		).toThrow();
		expect(session.getEntries()).toEqual(beforeEntries);
		expect(readFileSync(file, "utf8")).not.toContain("would-be-first");
	});
});
