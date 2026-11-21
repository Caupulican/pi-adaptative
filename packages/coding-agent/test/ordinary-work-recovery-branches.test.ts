import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { SqliteDatabase } from "../src/core/context/sqlite-database.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";
import { OrdinaryWorkController } from "../src/core/ordinary-work-controller.ts";
import { type OwnerInputId, OwnerInputLedger } from "../src/core/owner-input-ledger.ts";
import { PLAN_UPDATE_CUSTOM_TYPE } from "../src/core/proof/proof-sheet.ts";
import { stampOwnerInput } from "../src/kernel/owner-input-stamp.ts";
import { ownProcessOwner } from "../src/kernel/reliability/owner-identity.ts";
import { ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

it("keeps rejecting a sibling frontier on repeated reads and can recover the original branch", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-branch-"));
	const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
	try {
		const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
		const work = new OrdinaryWorkController({
			getSessionManager: () => manager,
			getStore: () => ledger.ordinaryWork,
			isEnabled: () => true,
		});
		const earlier = manager.appendCustomEntry("earlier-task");
		const message = { role: "user", content: "Finish the interrupted change", timestamp: 1 } as const;
		const id = "prompt:branch" as OwnerInputId;
		stampOwnerInput(message, id);
		const opening = work.noteOwnerInput({ id, message, entryId: manager.appendMessage(message) })!;
		const frontier = manager.appendCustomEntry("original-frontier");
		expect(
			manager.getFullHistoryChainWithPayloads(frontier, opening.openingEntryId).map((entry) => entry.id),
		).toEqual([opening.openingEntryId, frontier]);
		expect(manager.getFullHistoryChainWithPayloads(earlier, opening.openingEntryId)).toEqual([]);
		const held = work.checkpoint(opening, { status: "unverified", reason: "process_interrupted" })!;
		manager.branch(opening.openingEntryId);
		manager.appendCustomEntry("sibling-frontier");
		expect(work.current()).toBeUndefined();
		expect(work.current()).toBeUndefined();
		expect(work.recover()).toBeUndefined();
		expect(work.current()).toBeUndefined();
		expect(work.claim(held)).toBeUndefined();
		manager.branch(frontier);
		expect(work.current()).toEqual(held);
		expect(work.recover()?.record).toEqual(held);
	} finally {
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each([true, false])("recovers a persisted waiting request only for a matching new completion (%s)", (matching) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-waiting-"));
	const databasePath = join(dir, "decisions.sqlite");
	let ledger = new DecisionLedgerStore({ databasePath });
	try {
		const roots = ownerSessionStorageRoots(dir);
		let manager = SessionManager.create(dir, roots);
		const controller = () =>
			new OrdinaryWorkController({
				getSessionManager: () => manager,
				getStore: () => ledger.ordinaryWork,
				isEnabled: () => true,
			});
		const work = controller();
		const message = { role: "user", content: "Finish once the worker reports back", timestamp: 1 } as const;
		const id = "prompt:waiting" as OwnerInputId;
		stampOwnerInput(message, id);
		const opening = work.noteOwnerInput({ id, message, entryId: manager.appendMessage(message) })!;
		const waiting = work.checkpoint(opening, { status: "waiting", reason: "waiting" })!;
		expect(work.recover()).toBeUndefined();
		manager.appendCustomMessageEntry(PLAN_UPDATE_CUSTOM_TYPE, "The plan producer reports completion", false, {
			kind: "settled",
			served: { sessionId: manager.getSessionId(), leafId: matching ? opening.openingEntryId : "unrelated" },
		});
		manager.flushBufferedEntries();
		const sessionFile = manager.getSessionFile()!;
		ledger.close();
		ledger = new DecisionLedgerStore({ databasePath });
		manager = SessionManager.open(sessionFile, roots);
		const restored = controller();
		const recovered = restored.recover();
		if (matching) {
			expect(recovered?.record).toEqual(waiting);
			const reviewing = restored.beginReview(recovered!.record)!;
			expect(reviewing.status).toBe("active");
			expect(reviewing.continuationCount).toBe(waiting.continuationCount);
			restored.checkpoint(reviewing, { status: "waiting", reason: "waiting" });
			expect(restored.recover()).toBeUndefined();
		} else expect(recovered).toBeUndefined();
	} finally {
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("persists process ownership and leaves a foreign executor's lease intact across reopen", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-process-"));
	const file = join(dir, "decisions.sqlite");
	let ledger = new DecisionLedgerStore({ databasePath: file });
	try {
		const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
		const opening = manager.appendMessage({ role: "user", content: "Restore my work", timestamp: 3 });
		const initial = ledger.ordinaryWork.open(manager.getSessionId(), opening, 3);
		const own = ownProcessOwner();
		const owner = {
			pid: 2147483647,
			hostname: `${own.hostname}-other`,
			machineId: own.machineId === "f".repeat(32) ? "a".repeat(32) : "f".repeat(32),
			startTime: "123",
		};
		const foreign = ledger.ordinaryWork.claim(initial, { id: "other-executor", ...owner }, 4, "acquire")!;
		ledger.close();
		ledger = new DecisionLedgerStore({ databasePath: file });
		const controller = new OrdinaryWorkController({
			getSessionManager: () => manager,
			getStore: () => ledger.ordinaryWork,
			isEnabled: () => true,
		});
		expect(controller.current()?.leaseOwner).toEqual(owner);
		expect(controller.claim(foreign)).toBeUndefined();
		controller.onAbort("rpc abort");
		expect(ledger.ordinaryWork.get(initial.sessionId, opening)).toEqual(foreign);
	} finally {
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each(["cancel", "finish", "release"] as const)("keeps the executing session in control until %s", (outcome) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-abort-"));
	const databasePath = join(dir, "decisions.sqlite");
	const writer = new DecisionLedgerStore({ databasePath });
	const reader = new DecisionLedgerStore({ databasePath });
	try {
		const roots = ownerSessionStorageRoots(dir);
		const session = SessionManager.create(dir, roots);
		const controller = (manager: SessionManager, ledger: DecisionLedgerStore) =>
			new OrdinaryWorkController({
				getSessionManager: () => manager,
				getStore: () => ledger.ordinaryWork,
				isEnabled: () => true,
			});
		const executor = controller(session, writer);
		const message = { role: "user", content: "Finish the work", timestamp: 1 } as const;
		const id = "prompt:abort-owner" as OwnerInputId;
		stampOwnerInput(message, id);
		const active = executor.noteOwnerInput({ id, message, entryId: session.appendMessage(message) })!;
		const observer = controller(SessionManager.open(session.getSessionFile()!, roots), reader);
		const stored = () => reader.ordinaryWork.get(active.sessionId, active.openingEntryId);
		expect(observer.current()).toEqual(active);
		observer.onAbort("rpc abort");
		expect(stored()).toEqual(active);
		if (outcome === "finish") {
			expect(executor.checkpoint(active, { status: "fulfilled", reason: "fulfilled" })).toBeDefined();
			observer.onAbort("rpc abort");
			expect(stored()?.status).toBe("fulfilled");
		} else {
			if (outcome === "release") executor.release();
			(outcome === "release" ? observer : executor).onAbort("rpc abort");
			expect(stored()).toMatchObject({ status: "cancelled", reason: "rpc abort", continuationCount: 0 });
		}
	} finally {
		reader.close();
		writer.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each([100, 10_000])(
	"bounds enrollment, checkpoint and cold lookup by the current task after %s older entries",
	(history) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-branch-cost-"));
		const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
		try {
			const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
			for (let index = 0; index < history; index++) manager.appendCustomEntry("earlier-history", { index });
			let branchRows = 0;
			const getBranch = manager.getBranch.bind(manager);
			vi.spyOn(manager, "getBranch").mockImplementation((...args) => {
				const branch = getBranch(...args);
				branchRows += branch.length;
				return branch;
			});
			const entryReads = vi.spyOn(manager, "getEntry");
			const payloadReads = vi.spyOn(manager, "getFullHistoryChainWithPayloads");
			const sessionRows = vi.spyOn(ledger.ordinaryWork, "forSession");
			const controller = () =>
				new OrdinaryWorkController({
					getSessionManager: () => manager,
					getStore: () => ledger.ordinaryWork,
					isEnabled: () => true,
				});
			const work = controller();
			const message = { role: "user", content: "Inspect the current source", timestamp: 1 } as const;
			const id = "prompt:bounded-history" as OwnerInputId;
			stampOwnerInput(message, id);
			const opening = work.noteOwnerInput({ id, message, entryId: manager.appendMessage(message) })!;
			expect(opening.status).toBe("active");
			expect(branchRows).toBe(1);
			branchRows = 0;
			manager.appendCustomEntry("current-result");
			const held = work.checkpoint(opening, { status: "unverified", reason: "process_interrupted" })!;
			expect(held.status).toBe("unverified");
			expect(branchRows).toBe(0);
			branchRows = 0;
			entryReads.mockClear();
			expect(controller().current()).toEqual(held);
			expect(branchRows).toBe(0);
			expect(entryReads).toHaveBeenCalledTimes(2);
			expect(sessionRows).not.toHaveBeenCalled();
			expect(payloadReads).not.toHaveBeenCalled();
		} finally {
			ledger.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

it("stops cold lookup at the latest terminal opening and rejects checkpoint frontiers outside its request", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-frontier-"));
	const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
	try {
		const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
		const earlier = manager.appendMessage({ role: "user", content: "An earlier open task", timestamp: 1 });
		ledger.ordinaryWork.open(manager.getSessionId(), earlier, 1);
		const latest = manager.appendMessage({ role: "user", content: "The current task", timestamp: 2 });
		const record = ledger.ordinaryWork.open(manager.getSessionId(), latest, 2);
		const controller = () =>
			new OrdinaryWorkController({
				getSessionManager: () => manager,
				getStore: () => ledger.ordinaryWork,
				isEnabled: () => true,
			});
		const work = controller();
		expect(work.current()).toEqual(record);
		expect(work.checkpoint(record, { status: "fulfilled", frontierEntryId: earlier })).toBeUndefined();
		const answer = manager.appendCustomEntry("answer");
		manager.branch(latest);
		manager.appendCustomEntry("sibling");
		expect(work.checkpoint(record, { status: "fulfilled", frontierEntryId: answer })).toBeUndefined();
		const terminal = work.checkpoint(record, { status: "fulfilled" })!;
		expect(terminal.status).toBe("fulfilled");
		const restored = controller();
		expect(restored.current()).toBeUndefined();
		expect(restored.readStatus()).toMatchObject({ state: "fulfilled" });
		expect(restored.recover()).toBeUndefined();
	} finally {
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each([
	[100, 1, 1],
	[10_000, 1, 1],
	[10_000, 1_000, 159],
])(
	"bounds SQLite reads across %s unenrolled owner messages and %s sibling openings",
	(history, siblings, readLimit) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-unenrolled-"));
		const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
		try {
			const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
			const root = manager.appendCustomEntry("root");
			for (let index = 0; index < siblings; index++) {
				const id = manager.appendMessage({ role: "user", content: `Sibling ${index}`, timestamp: index + 1 });
				ledger.ordinaryWork.open(manager.getSessionId(), id, index + 1);
			}
			manager.branch(root);
			for (let index = 0; index < history; index++)
				manager.appendMessage({ role: "user", content: `Older owner message ${index}`, timestamp: index + 1 });
			const database = Reflect.get(ledger, "database") as SqliteDatabase;
			const prepare = database.prepare.bind(database);
			let reads = 0;
			let returnedRows = 0;
			vi.spyOn(database, "prepare").mockImplementation((sql) => {
				const statement = prepare(sql);
				if (!/^SELECT/i.test(sql)) return statement;
				return {
					get: (...params) => {
						const row = statement.get(...params);
						reads++;
						returnedRows += row ? 1 : 0;
						return row;
					},
					all: (...params) => {
						const rows = statement.all(...params);
						reads++;
						returnedRows += rows.length;
						return rows;
					},
					run: (...params) => statement.run(...params),
				};
			});
			const fullSession = vi.spyOn(ledger.ordinaryWork, "forSession");
			const work = new OrdinaryWorkController({
				getSessionManager: () => manager,
				getStore: () => ledger.ordinaryWork,
				isEnabled: () => true,
			});
			expect(work.current()).toBeUndefined();
			expect(reads).toBeLessThanOrEqual(readLimit);
			expect(returnedRows).toBeLessThanOrEqual(65);
			expect(fullSession).not.toHaveBeenCalled();
		} finally {
			ledger.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

it("selects the newest opening within a lookup batch and still rejects a frontier before that opening", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-lookup-order-"));
	const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
	try {
		const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
		const root = manager.appendCustomEntry("root");
		for (let index = 0; index < 100; index++) {
			const id = manager.appendMessage({ role: "user", content: `Sibling ${index}`, timestamp: 1 });
			ledger.ordinaryWork.open(manager.getSessionId(), id, 1);
		}
		manager.branch(root);
		const earlier = manager.appendMessage({ role: "user", content: "Earlier open task", timestamp: 2 });
		ledger.ordinaryWork.open(manager.getSessionId(), earlier, 2);
		const latest = manager.appendMessage({ role: "user", content: "Newest task", timestamp: 3 });
		let record = ledger.ordinaryWork.open(manager.getSessionId(), latest, 3);
		for (let index = 0; index < 30; index++)
			manager.appendMessage({ role: "user", content: `Unenrolled ${index}`, timestamp: 4 });
		const controller = () =>
			new OrdinaryWorkController({
				getSessionManager: () => manager,
				getStore: () => ledger.ordinaryWork,
				isEnabled: () => true,
			});
		expect(controller().current()).toEqual(record);
		record = ledger.ordinaryWork.checkpoint(record, { status: "unverified", frontierEntryId: earlier }, 5)!;
		expect(controller().current()).toBeUndefined();
		ledger.ordinaryWork.checkpoint(record, { status: "cancelled", frontierEntryId: manager.getLeafId()! }, 6);
		const restored = controller();
		expect(restored.current()).toBeUndefined();
		expect(restored.readStatus()).toMatchObject({ state: "cancelled" });
	} finally {
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each([
	["earlier", "unverified"],
	["sibling", "unverified"],
	["earlier", "fulfilled"],
	["sibling", "fulfilled"],
	["foreign", "unverified"],
	["foreign", "fulfilled"],
] as const)("rejects an externally stored %s frontier on warm %s reads and status", (frontier, status) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-warm-frontier-"));
	const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
	try {
		const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
		const earlier = manager.appendCustomEntry("before-opening");
		const opening = manager.appendMessage({ role: "user", content: "Current task", timestamp: 1 });
		const record = ledger.ordinaryWork.open(manager.getSessionId(), opening, 1);
		const original = manager.appendCustomEntry("current-frontier");
		manager.branch(opening);
		const sibling = manager.appendCustomEntry("sibling-frontier");
		const foreign = SessionManager.inMemory(ownerSessionStorageRoots(dir)).appendCustomEntry(
			"foreign-session-frontier",
		);
		manager.branch(original);
		const controller = () =>
			new OrdinaryWorkController({
				getSessionManager: () => manager,
				getStore: () => ledger.ordinaryWork,
				isEnabled: () => true,
			});
		const work = controller();
		expect(work.current()).toEqual(record);
		expect(work.readStatus()).toMatchObject({ state: "active" });
		ledger.ordinaryWork.checkpoint(
			record,
			{ status, frontierEntryId: frontier === "earlier" ? earlier : frontier === "sibling" ? sibling : foreign },
			2,
		);
		expect(work.current()).toBeUndefined();
		expect(work.readStatus()).toEqual({ state: "none" });
		const restored = controller();
		expect(restored.current()).toBeUndefined();
		expect(restored.readStatus()).toEqual({ state: "none" });
	} finally {
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each([100, 10_000])(
	"keeps warm near-leaf work bounded after %s entries since opening",
	(tail) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-tail-"));
		const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
		try {
			const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
			const work = new OrdinaryWorkController({
				getSessionManager: () => manager,
				getStore: () => ledger.ordinaryWork,
				isEnabled: () => true,
			});
			const message = { role: "user", content: "Inspect the current source", timestamp: 1 } as const;
			const id = "prompt:bounded-tail" as OwnerInputId;
			stampOwnerInput(message, id);
			const opening = work.noteOwnerInput({ id, message, entryId: manager.appendMessage(message) })!;
			for (let index = 0; index < tail; index++) manager.appendCustomEntry("current-task-history", { index });
			const branch = vi.spyOn(manager, "getBranch");
			const points = vi.spyOn(manager, "getEntry");
			const payloads = vi.spyOn(manager, "getFullHistoryChainWithPayloads");
			let record = work.checkpoint(opening, { status: "unverified", reason: "process_interrupted" })!;
			expect(record).toBeDefined();
			expect(points).toHaveBeenCalledTimes(1);
			points.mockClear();
			expect(work.current()).toEqual(record);
			expect(points).toHaveBeenCalledTimes(1);
			const frontier = manager.appendCustomEntry("externally-checkpointed-frontier");
			record = ledger.ordinaryWork.checkpoint(record, { status: "unverified", frontierEntryId: frontier }, 2)!;
			points.mockClear();
			expect(work.current()).toEqual(record);
			expect(points).toHaveBeenCalledTimes(1);
			const nearLeaf = manager.appendCustomEntry("near-leaf-frontier");
			manager.appendCustomEntry("latest-entry");
			points.mockClear();
			record = work.checkpoint(record, { status: "unverified", frontierEntryId: nearLeaf })!;
			expect(record.frontierEntryId).toBe(nearLeaf);
			expect(points.mock.calls.length).toBeLessThanOrEqual(2);
			expect(branch).not.toHaveBeenCalled();
			expect(payloads).not.toHaveBeenCalled();
		} finally {
			ledger.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
	60_000,
);

it.each(["identity", "third-party"])("rejects a warm opening whose %s changes", (change) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-opening-identity-"));
	const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
	try {
		const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
		const work = new OrdinaryWorkController({
			getSessionManager: () => manager,
			getStore: () => ledger.ordinaryWork,
			isEnabled: () => true,
		});
		const message = { role: "user", content: "Keep the original owner identity", timestamp: 1 } as const;
		const id = "prompt:original-identity" as OwnerInputId;
		stampOwnerInput(message, id);
		const record = work.noteOwnerInput({ id, message, entryId: manager.appendMessage(message) })!;
		const opening = manager.getEntry(record.openingEntryId)!;
		if (opening.type !== "message") throw new Error("Missing opening");
		if (change === "identity") opening.ownerInputId = "prompt:replaced-identity";
		else opening.turnOrigin = { v: 1, k: "inbound-channel", channel: "fixture", ref: "fixture", thirdParty: true };
		expect(work.current()).toBeUndefined();
		expect(work.readStatus()).toEqual({ state: "none" });
		expect(work.checkpoint(record, { status: "fulfilled" })).toBeUndefined();
		expect(ledger.ordinaryWork.get(record.sessionId, record.openingEntryId)).toEqual(record);
	} finally {
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each(["unseen", "reopened"])("validates the stored %s frontier after a partial enrollment retry", (branch) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-admission-retry-"));
	const roots = ownerSessionStorageRoots(dir);
	let manager = SessionManager.create(dir, roots);
	const file = join(dir, "decisions.sqlite");
	const ledger = new DecisionLedgerStore({ databasePath: file });
	let secondLedger: DecisionLedgerStore | undefined;
	const work = new OrdinaryWorkController({
		getSessionManager: () => manager,
		getStore: () => ledger.ordinaryWork,
		isEnabled: () => true,
	});
	const inputs = new OwnerInputLedger(() => {});
	let deliveries = 0;
	inputs.onDelivered((delivery) => {
		deliveries++;
		work.noteOwnerInput(delivery);
	});
	const claims = vi.spyOn(ledger.ordinaryWork, "claim").mockImplementationOnce(() => {
		throw new Error("Claim failed after the opening insert");
	});
	const deliver = (content: string) => {
		const message = { role: "user", content, timestamp: 1 } as const;
		const id = inputs.accept("prompt");
		inputs.move(id, "judged");
		inputs.move(id, "own_turn");
		stampOwnerInput(message, id);
		const entry = manager.appendMessage(message);
		inputs.notePersisted(message, entry);
		expect(inputs.stateOf(id)).toBeUndefined();
		return entry;
	};
	try {
		const opening = deliver("Keep the original request identity");
		const initial = ledger.ordinaryWork.get(manager.getSessionId(), opening)!;
		expect(initial.frontierEntryId).toBe(opening);
		expect(initial.leaseId).toBeUndefined();
		const secondManager = SessionManager.open(manager.getSessionFile()!, roots);
		secondLedger = new DecisionLedgerStore({ databasePath: file });
		const secondWork = new OrdinaryWorkController({
			getSessionManager: () => secondManager,
			getStore: () => secondLedger!.ordinaryWork,
			isEnabled: () => true,
		});
		const claimed = secondWork.claim(secondWork.current()!)!;
		const descendant = secondManager.appendCustomEntry("other-writer-result");
		const held = secondWork.checkpoint(claimed, { status: "unverified", reason: "process_interrupted" })!;
		expect(held.frontierEntryId).toBe(descendant);
		expect(deliveries).toBe(1);
		if (branch === "reopened") {
			manager = SessionManager.open(manager.getSessionFile()!, roots);
			expect(work.current()).toEqual(held);
			const retried = work.enrollCurrentOwner()!;
			expect(retried).toMatchObject({ openingEntryId: opening, frontierEntryId: descendant, status: "active" });
			expect(retried.leaseId).toBeDefined();
			expect(work.current()).toEqual(retried);
			expect(deliveries).toBe(1);
		} else {
			expect(manager.getEntry(descendant)).toBeUndefined();
			expect(work.current()).toBeUndefined();
			expect(() => work.enrollCurrentOwner()).toThrow(
				"Ordinary owner work could not acquire its current execution lease.",
			);
			expect(claims).toHaveBeenCalledTimes(1);
			expect(work.current()).toBeUndefined();
			expect(ledger.ordinaryWork.get(initial.sessionId, opening)).toEqual(held);
			expect(deliveries).toBe(1);
			const next = deliver("Handle this new owner request");
			expect(work.current()).toMatchObject({ openingEntryId: next, frontierEntryId: next, status: "active" });
			expect(ledger.ordinaryWork.get(initial.sessionId, opening)).toEqual(held);
			expect(deliveries).toBe(2);
		}
	} finally {
		claims.mockRestore();
		secondLedger?.close();
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
