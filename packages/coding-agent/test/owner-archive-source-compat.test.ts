import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
	getOwnerEvidenceSnapshots,
	OWNER_EVIDENCE_CUSTOM_TYPE,
	OwnerEvidenceLedger,
} from "../src/core/learning/owner-evidence-ledger.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";
import { OrdinaryWorkController } from "../src/core/ordinary-work-controller.ts";
import { isCompatibleOwnerSourceEntry } from "../src/core/owner-input-ledger.ts";
import { ownerOriginKind } from "../src/core/turn-origin.ts";
import { type OwnerInputId, stampOwnerInput } from "../src/kernel/owner-input-stamp.ts";
import { ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import type { SessionEntry } from "../src/kernel/session/session-entries.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";
import { stampTurnOrigin, type TurnOriginRecord } from "../src/kernel/turn-origin-stamp.ts";

const sourceKinds: [string, TurnOriginRecord | undefined, string | undefined, boolean][] = [
	["legacy", undefined, undefined, true],
	["typed", undefined, "prompt:fixture", true],
	[
		"owner-channel",
		{
			v: 1,
			k: "owner-channel",
			channel: "fixture",
			verified: true,
			ref: "batch",
		},
		"channel:fixture",
		true,
	],
	["worker-result", { v: 1, k: "worker-result" }, "prompt:forged", false],
	["peer", { v: 1, k: "peer-agent", thirdParty: true }, "prompt:forged", false],
	["host", { v: 1, k: "harness" }, "prompt:forged", false],
	["extension-ID", undefined, "extension:fixture", false],
	["unverified-channel-ID", undefined, "channel:fixture", false],
];
function add(manager: SessionManager, text: string, origin?: TurnOriginRecord, id?: string) {
	const message = { role: "user" as const, content: text, timestamp: 1 };
	if (origin) stampTurnOrigin(message, origin);
	if (id) stampOwnerInput(message, id as OwnerInputId);
	return manager.appendMessage(message);
}
function mark(manager: SessionManager, entryId: string, text: string) {
	const record = {
		sessionId: manager.getSessionId(),
		sourceId: `${manager.getSessionId()}/${entryId}`,
		entryId,
		text,
		digest: createHash("sha256").update(text).digest("hex").slice(0, 16),
		chars: text.length,
		createdAt: "2026-11-21T00:00:00.000Z",
	};
	manager.appendCustomEntry(OWNER_EVIDENCE_CUSTOM_TYPE, {
		version: 1,
		evidence: record,
	});
	return record;
}

it.each(sourceKinds)(
	"validates archived owner evidence from actual %s source across reopen",
	(_name, origin, id, valid) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-owner-custody-"));
		try {
			const roots = ownerSessionStorageRoots(dir);
			let manager = SessionManager.create(dir, roots);
			const entryId = add(manager, "Synthetic original owner words", origin, id);
			mark(manager, entryId, "Synthetic original owner words");
			manager.flushBufferedEntries();
			const file = manager.getSessionFile()!;
			manager = SessionManager.open(file, roots);
			const before = readFileSync(file);
			const ledger = new OwnerEvidenceLedger({
				getSessionManager: () => manager,
				warn: () => {},
			});
			expect(ledger.readSources()).toHaveLength(valid ? 1 : 0);
			expect(getOwnerEvidenceSnapshots(manager.getBranch())).toHaveLength(valid ? 1 : 0);
			expect(getOwnerEvidenceSnapshots(manager.getCustomEntriesOnBranch([OWNER_EVIDENCE_CUSTOM_TYPE]))).toHaveLength(
				1,
			);
			expect(readFileSync(file)).toEqual(before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

it("rejects malformed or internally contradictory origin fields while preserving raw snapshot decoding", () => {
	const entry = {
		type: "message",
		id: "source",
		parentId: null,
		timestamp: "2026-11-21T00:00:00.000Z",
		message: { role: "user", content: "Synthetic", timestamp: 1 },
		turnOrigin: { v: 1, k: "owner-channel" },
	} as SessionEntry;
	expect(isCompatibleOwnerSourceEntry(entry)).toBe(false);
	expect(ownerOriginKind(entry, 0, 1)).toBeUndefined();
	const contradictory = {
		...entry,
		turnOrigin: { v: 1, k: "owner-typed", thirdParty: true },
	} as SessionEntry;
	expect(isCompatibleOwnerSourceEntry(contradictory)).toBe(false);
	expect(ownerOriginKind(contradictory, 0, 1)).toBeUndefined();
});

it.each(["legacy", "typed", "owner-channel"])(
	"skips invalid historical ordinary openings and finds nearest genuine %s owner without a branch scan",
	(kind) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-archive-"));
		const databasePath = join(dir, "decisions.sqlite");
		let db = new DecisionLedgerStore({ databasePath });
		try {
			const roots = ownerSessionStorageRoots(dir);
			let manager = SessionManager.create(dir, roots);
			const first = add(manager, "Older genuine task");
			db.ordinaryWork.open(manager.getSessionId(), first, 1);
			const shape = sourceKinds.find((x) => x[0] === kind)!;
			const real = add(manager, "Nearest genuine task", shape[1], shape[2]);
			const expected = db.ordinaryWork.open(manager.getSessionId(), real, 2);
			const fake = add(manager, "Not an owner request", { v: 1, k: "worker-result" }, "prompt:forged");
			db.ordinaryWork.open(manager.getSessionId(), fake, 3);
			manager.flushBufferedEntries();
			const file = manager.getSessionFile()!;
			db.close();
			db = new DecisionLedgerStore({ databasePath });
			manager = SessionManager.open(file, roots);
			const before = readFileSync(file);
			const branch = vi.spyOn(manager, "getBranch").mockImplementation(() => {
				throw new Error("No full branch scan allowed");
			});
			const work = new OrdinaryWorkController({
				getSessionManager: () => manager,
				getStore: () => db.ordinaryWork,
				isEnabled: () => true,
			});
			expect(work.current()).toEqual(expected);
			expect(work.current()).toEqual(expected);
			expect(branch).not.toHaveBeenCalled();
			branch.mockRestore();
			const evidence = work.evidence(expected)!;
			expect(evidence.request).toContain("Nearest genuine task");
			expect(evidence.request).not.toContain("Not an owner request");
			expect(readFileSync(file)).toEqual(before);
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

it("does not select a branch containing only an invalid archival ordinary opening", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-invalid-ordinary-"));
	const db = new DecisionLedgerStore({
		databasePath: join(dir, "decisions.sqlite"),
	});
	try {
		const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
		const id = add(manager, "Not owner", { v: 1, k: "harness" }, "prompt:forged");
		db.ordinaryWork.open(manager.getSessionId(), id, 1);
		manager.flushBufferedEntries();
		const work = new OrdinaryWorkController({
			getSessionManager: () => manager,
			getStore: () => db.ordinaryWork,
			isEnabled: () => true,
		});
		expect(work.current()).toBeUndefined();
		expect(work.current()).toBeUndefined();
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("rejects contradictory persisted source metadata at delivered-ID enrollment", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-owner-delivery-"));
	const db = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
	try {
		const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
		const message = { role: "user" as const, content: "Not owner", timestamp: 1 };
		stampOwnerInput(message, "prompt:forged" as OwnerInputId);
		stampTurnOrigin(message, { v: 1, k: "worker-result" });
		const entryId = manager.appendMessage(message);
		manager.flushBufferedEntries();
		const work = new OrdinaryWorkController({
			getSessionManager: () => manager,
			getStore: () => db.ordinaryWork,
			isEnabled: () => true,
		});
		expect(work.noteOwnerInput({ id: "prompt:forged" as OwnerInputId, message, entryId })).toBeUndefined();
		expect(db.ordinaryWork.forSession(manager.getSessionId())).toHaveLength(0);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
