import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createEmptyUsage } from "@caupulican/pi-ai";
import { expect, it, vi } from "vitest";
import type { SessionAutonomyStatus } from "../src/core/autonomy-status/autonomy-status.ts";
import { formatSessionAutonomyStatus } from "../src/core/autonomy-status/format.ts";
import {
	type OrdinaryWorkStatusSnapshot,
	ordinaryWorkStatusSnapshot,
} from "../src/core/autonomy-status/ordinary-work.ts";
import {
	type ChannelBatchRecord,
	type ChannelDraftRecord,
	ChannelJournal,
} from "../src/core/channels/channel-journal.ts";
import { readOwnerControlStatus } from "../src/core/channels/owner-control.ts";
import { interfaceLanguage, setInterfaceLanguage } from "../src/core/language/interface-text.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";
import { OrdinaryWorkController } from "../src/core/ordinary-work-controller.ts";
import { reviewOrdinaryWork } from "../src/core/ordinary-work-settlement.ts";
import type { OwnerInputId } from "../src/core/owner-input-ledger.ts";
import { ownerChannelTurnOrigin } from "../src/core/turn-origin.ts";
import { stampOwnerInput } from "../src/kernel/owner-input-stamp.ts";
import { ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";
import { stampTurnOrigin } from "../src/kernel/turn-origin-stamp.ts";

function statusWith(ordinaryWork: OrdinaryWorkStatusSnapshot): SessionAutonomyStatus {
	const unavailable = { status: "unavailable", reason: "not loaded" } as const;
	return {
		v: 1,
		at: "2026-11-20T00:00:00.000Z",
		sessionId: "fixture",
		ordinaryWork: { status: "available", value: ordinaryWork },
		goalContinuation: unavailable,
		plans: unavailable,
		review: unavailable,
		sessionSave: unavailable,
		routines: unavailable,
		awayDaemon: unavailable,
		hostEvents: unavailable,
		actAhead: unavailable,
		proactiveReview: unavailable,
		channels: unavailable,
		outwardDrafts: unavailable,
		harnessNotices: unavailable,
		knowledgeCollection: unavailable,
		authority: unavailable,
		systemOne: unavailable,
		machines: unavailable,
		runs: unavailable,
	};
}

it("does not open or initialize storage just to report unavailable, disabled or ephemeral work", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-status-empty-"));
	try {
		const roots = ownerSessionStorageRoots(dir);
		const manager = SessionManager.create(dir, roots);
		const getStore = vi.fn();
		const peekStore = vi.fn(() => undefined);
		const options = { getSessionManager: () => manager, getStore, peekStore, isEnabled: () => true };
		const untouched = new OrdinaryWorkController(options);
		untouched.release();
		expect(untouched.readStatus()).toEqual({
			state: "unavailable",
			reason: "storage_not_loaded",
		});
		expect(new OrdinaryWorkController({ ...options, isEnabled: () => false }).readStatus()).toEqual({
			state: "disabled",
		});
		expect(
			new OrdinaryWorkController({
				...options,
				getSessionManager: () => SessionManager.inMemory(roots),
			}).readStatus(),
		).toEqual({ state: "ephemeral" });
		expect(getStore).not.toHaveBeenCalled();
		expect(peekStore).toHaveBeenCalledTimes(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("reports a held branch's reason and spent limit without leaking its request, reopening or changing the row", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-status-held-"));
	const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
	try {
		const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
		const getStore = vi.fn(() => ledger.ordinaryWork);
		const work = new OrdinaryWorkController({ getSessionManager: () => manager, getStore, isEnabled: () => true });
		const id = "prompt:status" as OwnerInputId;
		const message = { role: "user", content: "private request apikey_do_not_display", timestamp: 1 } as const;
		stampOwnerInput(message, id);
		const opening = work.noteOwnerInput({ id, message, entryId: manager.appendMessage(message) })!;
		const reserved = work.reserveContinuation(work.beginReview(opening)!)!;
		const frontier = manager.appendCustomEntry("held-frontier");
		const held = work.checkpoint(reserved, { status: "unverified", reason: "reviewer_invalid_response" })!;
		expect(ordinaryWorkStatusSnapshot({ ...held, reason: "system_bound: apikey_do_not_display" })).toMatchObject({
			reason: "system_bound",
		});
		expect(ordinaryWorkStatusSnapshot({ ...held, reason: "apikey_do_not_display" })).toMatchObject({
			reason: "unverified",
		});
		const getStoreCalls = getStore.mock.calls.length;
		const snapshot = work.readStatus();
		expect(snapshot).toEqual({
			state: "unverified",
			reason: "reviewer_invalid_response",
			continuationsUsed: 1,
			continuationLimit: 3,
		});
		expect(work.readStatus()).toEqual(snapshot);
		expect(getStore).toHaveBeenCalledTimes(getStoreCalls);
		expect(ledger.ordinaryWork.get(manager.getSessionId(), opening.openingEntryId)).toEqual(held);
		expect(JSON.stringify(snapshot)).not.toContain("private");
		expect(JSON.stringify(snapshot)).not.toContain("apikey");
		const language = interfaceLanguage();
		try {
			setInterfaceLanguage("en");
			expect(formatSessionAutonomyStatus(statusWith(snapshot))).toContain(
				"The independent reviewer returned an invalid decision.",
			);
			expect(formatSessionAutonomyStatus(statusWith(snapshot))).toContain("1/3 spent");
			setInterfaceLanguage("pt-BR");
			expect(formatSessionAutonomyStatus(statusWith(snapshot))).toContain(
				"O revisor independente retornou uma decisão inválida.",
			);
		} finally {
			setInterfaceLanguage(language);
		}
		manager.branch(opening.openingEntryId);
		manager.appendCustomEntry("sibling-frontier");
		expect(work.readStatus()).toEqual({ state: "none" });
		expect(work.readStatus()).toEqual({ state: "none" });
		manager.branch(frontier);
		expect(work.readStatus()).toEqual(snapshot);
		const terminal = work.checkpoint(held, { status: "fulfilled", reason: "fulfilled" })!;
		expect(work.current()).toBeUndefined();
		expect(work.readStatus()).toEqual({
			state: "fulfilled",
			reason: "fulfilled",
			continuationsUsed: 1,
			continuationLimit: 3,
		});
		expect(ledger.ordinaryWork.get(manager.getSessionId(), opening.openingEntryId)).toEqual(terminal);
	} finally {
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each([
	["unverified", "reviewer_no_eligible_model"],
	["unverified", "judge_unavailable"],
	["waiting", "waiting"],
] as const)(
	"preserves %s / %s after reopen and distinguishes an unreadable store from an empty session",
	(status, reason) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-status-reopen-"));
		const databasePath = join(dir, "decisions.sqlite");
		let ledger = new DecisionLedgerStore({ databasePath });
		try {
			const roots = ownerSessionStorageRoots(dir);
			let manager = SessionManager.create(dir, roots);
			const getStore = vi.fn(() => ledger.ordinaryWork);
			const controller = () =>
				new OrdinaryWorkController({
					getSessionManager: () => manager,
					getStore,
					peekStore: () => ledger.ordinaryWork,
					isEnabled: () => true,
				});
			const work = controller();
			const id = "prompt:status-reopen" as OwnerInputId;
			const message = { role: "user", content: "Owner request that remains owed", timestamp: 1 } as const;
			stampOwnerInput(message, id);
			const opening = work.noteOwnerInput({ id, message, entryId: manager.appendMessage(message) })!;
			const held = work.checkpoint(opening, { status, reason })!;
			manager.flushBufferedEntries();
			const sessionFile = manager.getSessionFile()!;
			ledger.close();
			ledger = new DecisionLedgerStore({ databasePath });
			manager = SessionManager.open(sessionFile, roots);
			const restored = controller();
			getStore.mockClear();
			const snapshot = restored.readStatus();
			expect(snapshot).toMatchObject({ state: status, reason, continuationsUsed: 0, continuationLimit: 3 });
			expect(getStore).not.toHaveBeenCalled();
			expect(restored.current()).toEqual(held);
			const get = vi.spyOn(ledger.ordinaryWork, "get").mockImplementation(() => {
				throw new Error("private unreadable database cause");
			});
			expect(restored.readStatus()).toEqual({ state: "unavailable", reason: "storage_unavailable" });
			get.mockRestore();
			expect(restored.readStatus()).toEqual(snapshot);
			expect(ledger.ordinaryWork.get(held.sessionId, held.openingEntryId)).toEqual(held);
			manager = SessionManager.create(dir, roots);
			const empty = controller();
			expect(empty.current()).toBeUndefined();
			expect(empty.readStatus()).toEqual({ state: "none" });
			expect(ledger.ordinaryWork.get(held.sessionId, held.openingEntryId)).toEqual(held);
		} finally {
			ledger.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

it.each([
	["stop", "The recorded answer.", "unverified", "answer_recorded_unverified"],
	["aborted", "", "unverified", "unverified"],
	["length", "A partial answer", "unverified", "unverified"],
	["stop", "   ", "unverified", "unverified"],
	["stop", "The recorded answer.", "held", "held"],
	["stop", "The recorded answer.", "reviewer_unavailable", "reviewer_unavailable"],
	["stop", "The revised answer.", "reporting_review_invalid", "reporting_review_invalid"],
	["stop", "The recorded answer.", "reporting_override_unverified", "reporting_override_unverified"],
	["stop", "The recorded answer.", "fulfilled", "fulfilled"],
] as const)(
	"reports %s / %s / %s without widening settlement authority",
	async (stopReason, text, judgment, reason) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-answer-status-"));
		const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
		const language = interfaceLanguage();
		try {
			const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
			const work = new OrdinaryWorkController({
				getSessionManager: () => manager,
				getStore: () => ledger.ordinaryWork,
				isEnabled: () => true,
			});
			const id = "prompt:answer-status" as OwnerInputId;
			const owner = { role: "user", content: "Read and report the answer.", timestamp: 1 } as const;
			stampOwnerInput(owner, id);
			const opening = work.noteOwnerInput({ id, message: owner, entryId: manager.appendMessage(owner) })!;
			const answer: AssistantMessage = {
				role: "assistant",
				api: "openai-completions",
				provider: "fixture",
				model: "fixture",
				content: text ? [{ type: "text", text }] : [],
				stopReason,
				usage: createEmptyUsage(),
				timestamp: 2,
			};
			manager.appendMessage(answer);
			const decide = vi.fn(async () => judgment);
			expect(
				await reviewOrdinaryWork(
					work,
					{ decideOrdinaryWorkStop: decide },
					{
						expected: opening,
						signal: new AbortController().signal,
						mayDispatch: () => true,
						warn: () => {},
					},
				),
			).toBeUndefined();
			expect(decide).toHaveBeenCalledTimes(1);
			const snapshot = work.readStatus();
			expect(snapshot).toMatchObject({
				state: judgment === "fulfilled" ? "fulfilled" : "unverified",
				reason,
				continuationsUsed: 0,
				continuationLimit: 3,
			});
			const stored = ledger.ordinaryWork.get(manager.getSessionId(), opening.openingEntryId);
			expect(work.recover()).toBeUndefined();
			expect(work.readStatus()).toEqual(snapshot);
			expect(ledger.ordinaryWork.get(manager.getSessionId(), opening.openingEntryId)).toEqual(stored);
			if (reason === "answer_recorded_unverified") {
				setInterfaceLanguage("en");
				expect(formatSessionAutonomyStatus(statusWith(snapshot))).toContain(
					"An answer is recorded; the available evidence has not verified that it fulfills the request.",
				);
				setInterfaceLanguage("pt-BR");
				expect(formatSessionAutonomyStatus(statusWith(snapshot))).toContain(
					"Uma resposta foi registrada; as evidências disponíveis ainda não confirmaram que ela atende ao pedido.",
				);
				if (!stored) throw Error("Missing stored request");
				expect(ordinaryWorkStatusSnapshot({ ...stored, reason: "unverified" })).toMatchObject({
					reason: "unverified",
				});
			}
		} finally {
			setInterfaceLanguage(language);
			ledger.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

it("scopes the current terminal row to its canonical opening and never falls back to an earlier request", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-chat-status-branch-"));
	const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
	try {
		const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
		const work = new OrdinaryWorkController({
			getSessionManager: () => manager,
			getStore: () => ledger.ordinaryWork,
			isEnabled: () => true,
		});
		const open = (ref: string) => {
			const id = `channel:${ref}` as OwnerInputId;
			const message = { role: "user", content: "private task", timestamp: 1 } as const;
			stampTurnOrigin(message, ownerChannelTurnOrigin({ channel: "telegram", ref }));
			stampOwnerInput(message, id);
			return work.noteOwnerInput({ id, message, entryId: manager.appendMessage(message) })!;
		};
		const first = open("first");
		const done = work.checkpoint(first, { status: "fulfilled", reason: "fulfilled" })!;
		const readFirst = () =>
			work.readStatus(
				(sessionId, origin) =>
					sessionId === manager.getSessionId() && origin?.k === "owner-channel" && origin.ref === "first",
			);
		expect(readFirst().state).toBe("fulfilled");
		const second = open("second");
		expect(work.readStatus().state).toBe("active");
		expect(readFirst()).toEqual({ state: "none" });
		manager.branch(first.openingEntryId);
		expect(readFirst().state).toBe("fulfilled");
		manager.branch(second.openingEntryId);
		expect(readFirst()).toEqual({ state: "none" });
		expect(ledger.ordinaryWork.get(first.sessionId, first.openingEntryId)).toEqual(done);
	} finally {
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("attributes ordinary status to exactly one retained owner batch and recipient across host sessions", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-chat-status-binding-"));
	try {
		const journal = new ChannelJournal(dir, "telegram");
		const event = { address: "address", conversationKey: "chat" };
		const row: ChannelBatchRecord = {
			...event,
			id: "opening",
			sessionId: "receiver",
			ownerSessionId: "phone",
			owner: true,
			senderDigest: "sender",
			allowlisted: true,
			acceptedAt: Date.now(),
			state: "replied",
			eventDigests: ["event"],
		};
		journal.update(row.acceptedAt, (state) => state.batches.push(row));
		const restored = new ChannelJournal(dir, "telegram").read().result.batches;
		expect(restored).toEqual([row]);
		const control = (sessionId: string) => ({
			drafts: () => [],
			waiting: () => ({ sessionId, cwd: "", work: { busy: false, phase: "idle" }, calls: [] }),
			ordinaryWork: (
				channel: string,
				owns: (sessionId: string, ref: string) => boolean,
			): OrdinaryWorkStatusSnapshot =>
				channel === "telegram" && owns(sessionId, "opening")
					? { state: "fulfilled", reason: "fulfilled", continuationsUsed: 0, continuationLimit: 3 }
					: { state: "none" },
		});
		const status = (
			batches: readonly ChannelBatchRecord[],
			drafts: readonly ChannelDraftRecord[],
			session = "phone",
		) =>
			readOwnerControlStatus(
				{ ownerControl: () => control(session) },
				"telegram",
				{ batches, drafts },
				event,
				"sender",
			);
		const read = (batches: readonly ChannelBatchRecord[], session = "phone") =>
			status(batches, [], session).ordinaryWork?.state;
		expect(read(restored)).toBe("fulfilled");
		expect(read(restored, "receiver")).toBe("none");
		const singleSession = { ...row, ownerSessionId: undefined };
		expect(read([singleSession], "receiver")).toBe("fulfilled");
		expect(read([singleSession])).toBe("none");
		expect(read([])).toBe("none");
		expect(read([row, { ...row, senderDigest: "different" }])).toBe("none");
		for (const change of [
			{ id: "other" },
			{ senderDigest: "other" },
			{ address: "other" },
			{ conversationKey: "other" },
			{ allowlisted: false },
			{ owner: undefined },
		]) {
			expect(read([{ ...row, ...change }])).toBe("none");
		}
		const drafted: ChannelBatchRecord = { ...row, state: "drafted" };
		const draft: ChannelDraftRecord = {
			...event,
			id: "private-draft-id",
			batchId: row.id,
			reason: "private transport detail",
			text: "private owner answer",
			createdAt: row.acceptedAt,
			state: "pending",
		};
		for (const state of ["pending", "sending", "sent", "dismissed"] as const) {
			const facts = status([drafted], [{ ...draft, state }]);
			expect(facts.hasUnconfirmedReply).toBe(state === "pending" || state === "sending");
			expect(JSON.stringify(facts)).not.toContain("private");
		}
		expect(status([drafted], [draft], "other-project-session").hasUnconfirmedReply).toBe(false);
		expect(status([drafted, drafted], [draft]).hasUnconfirmedReply).toBe(false);
		for (const duplicates of [
			[{ ...drafted, owner: undefined }, drafted],
			[drafted, { ...drafted, owner: undefined }, drafted],
		]) {
			expect(status(duplicates, [draft]).hasUnconfirmedReply).toBe(false);
		}
		let batchReads = 0;
		const manyBatches = Array.from({ length: 256 }, (_, index) => ({
			...drafted,
			get id() {
				batchReads++;
				return `other-batch-${index}`;
			},
		}));
		const openDrafts = Array.from({ length: 128 }, (_, index) => ({ ...draft, batchId: `missing-${index}` }));
		expect(status(manyBatches, openDrafts).hasUnconfirmedReply).toBe(false);
		expect(batchReads).toBeLessThanOrEqual(manyBatches.length);
		expect(status([], [draft]).hasUnconfirmedReply).toBe(false);
		for (const change of [
			{ state: "replied" as const },
			{ senderDigest: "other" },
			{ address: "other" },
			{ conversationKey: "other" },
			{ owner: undefined },
			{ allowlisted: false },
		]) {
			expect(status([{ ...drafted, ...change }], [draft]).hasUnconfirmedReply).toBe(false);
		}
		for (const change of [{ batchId: "different" }, { address: "other" }, { conversationKey: "other" }]) {
			expect(status([drafted], [{ ...draft, ...change }]).hasUnconfirmedReply).toBe(false);
		}
		const unreadable = readOwnerControlStatus(
			{},
			"telegram",
			{ batches: [drafted], drafts: [draft] },
			event,
			"sender",
		);
		expect(unreadable.hasUnconfirmedReply).toBe(false);
		const faults = readOwnerControlStatus(
			{
				ownerControl: () => ({
					...control("phone"),
					ordinaryWork() {
						throw Error("private fault");
					},
				}),
			},
			"telegram",
			{ batches: restored, drafts: [] },
			event,
			"sender",
		);
		expect(faults.ordinaryWork).toBeUndefined();
		expect(faults.calls?.sessionId).toBe("phone");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
