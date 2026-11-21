import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";
import { OrdinaryWorkController } from "../src/core/ordinary-work-controller.ts";
import { ORDINARY_WORK_MAX_CONTINUATIONS } from "../src/core/ordinary-work-policy.ts";
import type { OwnerInputId } from "../src/core/owner-input-ledger.ts";
import { stampOwnerInput } from "../src/kernel/owner-input-stamp.ts";
import { ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

it("retains the hard continuation cap across database reopen and never reopens a fulfilled request", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-work-"));
	const databasePath = join(dir, "decisions.sqlite");
	const lease = { id: "one-executor", pid: process.pid };
	let ledger: DecisionLedgerStore | undefined;
	try {
		ledger = new DecisionLedgerStore({ databasePath });
		let record = ledger.ordinaryWork.open("session", "opening", 1);
		record = ledger.ordinaryWork.claim(record, lease, 2, "acquire")!;
		for (let count = 0; count < ORDINARY_WORK_MAX_CONTINUATIONS; count++) {
			record = ledger.ordinaryWork.beginReview(record, 3 + count)!;
			record = ledger.ordinaryWork.claim(record, lease, 4 + count, "continue")!;
			ledger.close();
			ledger = undefined;
			ledger = new DecisionLedgerStore({ databasePath });
			record = ledger.ordinaryWork.get("session", "opening")!;
			expect(record.continuationCount).toBe(count + 1);
			expect(record.generation).toBe(count + 1);
		}
		record = ledger.ordinaryWork.beginReview(record, 20)!;
		expect(ledger.ordinaryWork.claim(record, lease, 21, "continue")).toBeUndefined();
		record = ledger.ordinaryWork.checkpoint(record, { status: "fulfilled", frontierEntryId: "answer" }, 22)!;
		expect(ledger.ordinaryWork.open("session", "opening", 23)).toEqual(record);
		expect(ledger.ordinaryWork.claim(record, lease, 24, "acquire")).toBeUndefined();
	} finally {
		ledger?.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("requires the reviewing executor and lets only one stale reservation win across connections", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-work-cas-"));
	const databasePath = join(dir, "decisions.sqlite");
	const first = new DecisionLedgerStore({ databasePath });
	const second = new DecisionLedgerStore({ databasePath });
	const lease = { id: "reviewing-executor", pid: process.pid };
	try {
		const initial = first.ordinaryWork.open("session", "opening", 1);
		const owned = first.ordinaryWork.claim(initial, lease, 2, "acquire")!;
		expect(first.ordinaryWork.claim(owned, lease, 3, "continue")).toBeUndefined();
		const reviewing = first.ordinaryWork.beginReview(owned, 4)!;
		expect(first.ordinaryWork.beginReview(owned, 5)).toBeUndefined();
		expect(
			second.ordinaryWork.claim(reviewing, { id: "another-executor", pid: process.pid }, 6, "continue"),
		).toBeUndefined();
		const reserved = first.ordinaryWork.claim(reviewing, lease, 7, "continue")!;
		expect(second.ordinaryWork.claim(reviewing, lease, 8, "continue")).toBeUndefined();
		expect(second.ordinaryWork.get("session", "opening")).toEqual(reserved);
		expect(reserved.continuationCount).toBe(1);
	} finally {
		first.close();
		second.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each([
	["fulfillment", true],
	["fulfillment", false],
	["revision", true],
	["revision", false],
] as const)("checks reporting in the writer transaction for %s with currency %s", (operation, current) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-reporting-commit-"));
	const path = join(dir, "decisions.sqlite");
	const ledger = new DecisionLedgerStore({ databasePath: path });
	const peer = new DatabaseSync(path, { timeout: 0 });
	const work = ledger.ordinaryWork;
	const lease = { id: "reviewer", pid: process.pid };
	try {
		const opening = work.open("session", "opening", 1);
		const owned = work.claim(opening, lease, 2, "acquire")!;
		const reviewed = work.beginReview(owned, 3)!;
		const reporting = {
			complete: true,
			requirements: operation === "revision" ? [{ id: "label", text: "Include the label" }] : [],
			isCurrent: vi.fn(() => {
				expect(() => peer.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
				return current;
			}),
		};
		if (operation === "revision") {
			const reserved = work.claim(reviewed, lease, 4, { reporting });
			expect(Boolean(reserved)).toBe(current);
		} else {
			work.checkpoint(
				reviewed,
				{ status: "fulfilled", reason: "fulfilled", frontierEntryId: "answer", reporting },
				4,
			);
		}
		expect(reporting.isCurrent).toHaveBeenCalledOnce();
		const record = work.get("session", "opening");
		if (!current) {
			expect(record).toMatchObject({
				status: "unverified",
				reason: "reporting_changed",
				continuationCount: 0,
				generation: 0,
			});
			expect(record?.leaseId).toBeUndefined();
		} else if (operation === "revision") {
			expect(record).toMatchObject({
				status: "active",
				reason: "reporting_reply_reserved",
				continuationCount: 1,
				leaseId: lease.id,
			});
		} else {
			expect(record).toMatchObject({ status: "fulfilled", reason: "fulfilled", continuationCount: 0 });
		}
		peer.exec("BEGIN IMMEDIATE");
		peer.exec("ROLLBACK");
	} finally {
		peer.close();
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("leaves a persisted original request usable when its optional recovery database is unavailable", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-work-unavailable-"));
	try {
		const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
		const message = { role: "user", content: "Inspect the local source", timestamp: 1 } as const;
		const entryId = manager.appendMessage(message);
		const warn = vi.fn();
		const work = new OrdinaryWorkController({
			getSessionManager: () => manager,
			getStore: () => undefined,
			isEnabled: () => true,
			warn,
		});
		expect(work.noteOwnerInput({ id: "prompt:fixture" as OwnerInputId, message, entryId })).toBeUndefined();
		expect(work.enrollCurrentOwner()).toBeUndefined();
		expect(manager.getEntry(entryId)).toMatchObject({ message });
		expect(warn).toHaveBeenCalledTimes(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("does not open a recovery database for an in-memory session", () => {
	const manager = SessionManager.inMemory(ownerSessionStorageRoots(tmpdir()));
	const getStore = vi.fn();
	const work = new OrdinaryWorkController({ getSessionManager: () => manager, getStore, isEnabled: () => true });
	expect(work.current()).toBeUndefined();
	expect(work.enrollCurrentOwner()).toBeUndefined();
	expect(work.recover()).toBeUndefined();
	expect(getStore).not.toHaveBeenCalled();
});

it("preserves the opening and spent budget when Send Now replaces an in-flight review with owner steering", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-work-steer-"));
	const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
	try {
		const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
		const work = new OrdinaryWorkController({
			getSessionManager: () => manager,
			getStore: () => ledger.ordinaryWork,
			isEnabled: () => true,
		});
		const deliver = (id: OwnerInputId, content: string) => {
			const message = { role: "user", content, timestamp: Date.now() } as const;
			stampOwnerInput(message, id);
			return work.noteOwnerInput({ id, message, entryId: manager.appendMessage(message) })!;
		};
		const opening = deliver("prompt:original" as OwnerInputId, "Keep interrupted owner requests recoverable.");
		const reserved = work.reserveContinuation(work.beginReview(opening)!)!;
		const previousReview = work.beginReview(reserved)!;
		work.onAbort("send now", "transfer");
		const steered = deliver("steer:storage" as OwnerInputId, "Use SQLite for this.");
		expect(work.reserveContinuation(previousReview)).toBeUndefined();
		expect(steered.openingEntryId).toBe(opening.openingEntryId);
		expect(steered.continuationCount).toBe(1);
		expect(work.evidence(steered)?.request).toBe(
			"Keep interrupted owner requests recoverable.\n\nUse SQLite for this.",
		);
	} finally {
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
