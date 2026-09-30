import { describe, expect, it } from "vitest";
import {
	SemanticVerificationObligationTracker,
	type SemanticVerificationSnapshot,
	type VerificationStoragePort,
} from "../../src/core/system-one/verification-obligations.ts";

class MemoryVerificationStorage implements VerificationStoragePort {
	private readonly records = new Map<string, SemanticVerificationSnapshot>();
	private branchKey = "session-a";
	private inheritedBranchKeys: string[] = [];
	private receiverId = "root-lane";

	getBranchKey(): string {
		return this.branchKey;
	}

	readRecords(branchKey: string): SemanticVerificationSnapshot | undefined {
		return this.records.get(branchKey);
	}

	appendRecord(branchKey: string, snapshot: SemanticVerificationSnapshot): void {
		this.records.set(branchKey, snapshot);
	}

	switchBranch(branchKey: string): void {
		this.branchKey = branchKey;
	}

	getInheritedBranchKeys(): readonly string[] {
		return this.inheritedBranchKeys;
	}

	getReceiverId(): string {
		return this.receiverId;
	}

	setInheritance(branchKeys: string[], receiverId: string): void {
		this.inheritedBranchKeys = branchKeys;
		this.receiverId = receiverId;
	}

	copySnapshot(fromBranchKey: string, toBranchKey: string): void {
		const snapshot = this.records.get(fromBranchKey);
		if (snapshot) this.records.set(toBranchKey, snapshot);
	}

	replaceSnapshot(branchKey: string, snapshot: SemanticVerificationSnapshot): void {
		this.records.set(branchKey, snapshot);
	}
}

function createTracker(storage = new MemoryVerificationStorage()) {
	let nextId = 0;
	return {
		storage,
		tracker: new SemanticVerificationObligationTracker(storage, {
			createId: () => `record-${++nextId}`,
			now: () => "2026-09-29T12:00:00.000Z",
		}),
	};
}

function openCandidate(
	tracker: SemanticVerificationObligationTracker,
	input: { receiverId?: string; candidateKind?: "repository" | "outcome"; candidateId?: string; reason?: string } = {},
) {
	return tracker.open({
		source: "peer_review",
		reason: input.reason ?? "Verify parser handles escaped separators.",
		receiverId: input.receiverId ?? "root-lane",
		candidateKind: input.candidateKind ?? "repository",
		candidateId: input.candidateId ?? "candidate-v1",
		scope: "src/parser.ts",
	});
}

function receipt(
	tracker: SemanticVerificationObligationTracker,
	input: {
		callId: string;
		receiverId?: string;
		candidateBefore?: string;
		candidateAfter?: string;
		succeeded?: boolean;
		tool?: string;
		output?: unknown;
	},
): void {
	tracker.recordReceipt({
		callId: input.callId,
		receiverId: input.receiverId ?? "root-lane",
		candidateBefore: input.candidateBefore ?? "candidate-v1",
		candidateAfter: input.candidateAfter ?? "candidate-v1",
		succeeded: input.succeeded ?? true,
		tool: input.tool ?? "bash",
		args: { command: "npm run test -- parser.test.ts" },
		output: input.output ?? "PASS parser.test.ts",
	});
}

describe("System One semantic verification obligations", () => {
	it("deduplicates an open finding and restores it from branch storage", () => {
		const { storage, tracker } = createTracker();
		const first = openCandidate(tracker);
		const duplicate = openCandidate(tracker);

		expect(duplicate.id).toBe(first.id);
		expect(tracker.active()).toEqual([first]);
		expect(new SemanticVerificationObligationTracker(storage).active()).toEqual([first]);
	});

	it("keeps the finding active when the lane, candidate, proof, or Jev judgment does not match", () => {
		const { tracker } = createTracker();
		const obligation = openCandidate(tracker);
		receipt(tracker, { callId: "pass-1" });
		const pass = tracker.readReceipts().find((item) => item.callId === "pass-1")!;

		expect(
			tracker.prepareResolution({
				id: obligation.id,
				receiverId: "other-lane",
				candidateId: "candidate-v1",
				disposition: "rejected",
				evidence: [{ receiptId: pass.id, role: "reproduction" as const }],
			}).ready,
		).toBe(false);
		expect(
			tracker.prepareResolution({
				id: obligation.id,
				receiverId: "root-lane",
				candidateId: "candidate-v2",
				disposition: "rejected",
				evidence: [{ receiptId: pass.id, role: "reproduction" as const }],
			}).ready,
		).toBe(false);

		const prepared = tracker.prepareResolution({
			id: obligation.id,
			receiverId: "root-lane",
			candidateId: "candidate-v1",
			disposition: "rejected",
			evidence: [{ receiptId: pass.id, role: "reproduction" as const }],
		});
		expect(prepared.ready).toBe(true);
		if (!prepared.ready) return;
		const uncertain = tracker.resolve({
			id: obligation.id,
			receiverId: "root-lane",
			candidateId: "candidate-v1",
			disposition: "rejected",
			evidence: [{ receiptId: pass.id, role: "reproduction" as const }],
			judgment: { id: "jev-low", token: prepared.token, accepted: true, confidence: 0.94 },
		});
		expect(uncertain.resolved).toBe(false);
		expect(tracker.active()).toHaveLength(1);
	});

	it("rejects a candidate only after a same-lane passing reproduction and matching high-confidence Jev", () => {
		const { storage, tracker } = createTracker();
		const obligation = openCandidate(tracker);
		receipt(tracker, { callId: "reproduce", output: "PASS: the suspected input is handled correctly" });
		const reproduction = tracker.readReceipts().find((item) => item.callId === "reproduce")!;
		const input = {
			id: obligation.id,
			receiverId: "root-lane",
			candidateId: "candidate-v1",
			disposition: "rejected" as const,
			evidence: [{ receiptId: reproduction.id, role: "reproduction" as const }],
		};
		const prepared = tracker.prepareResolution(input);
		expect(prepared.ready).toBe(true);
		if (!prepared.ready) return;
		const resolved = tracker.resolve({
			...input,
			judgment: { id: "jev-reject", token: prepared.token, accepted: true, confidence: 0.98 },
		});

		expect(resolved.resolved).toBe(true);
		expect(tracker.active()).toEqual([]);
		expect(new SemanticVerificationObligationTracker(storage).active()).toEqual([]);
	});

	it("accepts a fresh reproduction on the current candidate while rejecting an old-candidate proof", () => {
		const { tracker } = createTracker();
		const obligation = openCandidate(tracker, { candidateId: "candidate-v1" });
		receipt(tracker, {
			callId: "old-pass",
			candidateBefore: "candidate-v1",
			candidateAfter: "candidate-v1",
		});
		const oldProof = tracker.readReceipts().find((item) => item.callId === "old-pass")!;
		const currentInput = {
			id: obligation.id,
			receiverId: "root-lane",
			candidateId: "candidate-v2",
			disposition: "rejected" as const,
			evidence: [{ receiptId: oldProof.id, role: "reproduction" as const }],
		};
		expect(tracker.prepareResolution(currentInput)).toMatchObject({ ready: false });

		receipt(tracker, {
			callId: "current-pass",
			candidateBefore: "candidate-v2",
			candidateAfter: "candidate-v2",
		});
		const currentProof = tracker.readReceipts().find((item) => item.callId === "current-pass")!;
		const input = { ...currentInput, evidence: [{ receiptId: currentProof.id, role: "reproduction" as const }] };
		const prepared = tracker.prepareResolution(input);
		expect(prepared).toMatchObject({ ready: true });
		if (!prepared.ready) return;
		expect(
			tracker.resolve({
				...input,
				judgment: { id: "jev-current-reject", token: prepared.token, accepted: true, confidence: 0.99 },
			}).resolved,
		).toBe(true);
	});

	it("repairs from a current-candidate reproduction and rechecks the resulting candidate", () => {
		const { tracker } = createTracker();
		const obligation = openCandidate(tracker, { candidateId: "candidate-v1" });
		receipt(tracker, {
			callId: "reproduce-current",
			candidateBefore: "candidate-v2",
			candidateAfter: "candidate-v2",
			output: "Confirmed on current candidate",
		});
		receipt(tracker, {
			callId: "repair-current",
			candidateBefore: "candidate-v2",
			candidateAfter: "candidate-v3",
			tool: "edit",
		});
		receipt(tracker, {
			callId: "recheck-current",
			candidateBefore: "candidate-v3",
			candidateAfter: "candidate-v3",
		});
		const receipts = tracker.readReceipts();
		const input = {
			id: obligation.id,
			receiverId: "root-lane",
			candidateId: "candidate-v3",
			disposition: "repaired" as const,
			evidence: [
				{
					receiptId: receipts.find((item) => item.callId === "reproduce-current")!.id,
					role: "reproduction" as const,
				},
				{ receiptId: receipts.find((item) => item.callId === "repair-current")!.id, role: "repair" as const },
				{ receiptId: receipts.find((item) => item.callId === "recheck-current")!.id, role: "recheck" as const },
			],
		};
		const prepared = tracker.prepareResolution(input);
		expect(prepared.ready).toBe(true);
		if (!prepared.ready) return;
		expect(
			tracker.resolve({
				...input,
				judgment: { id: "jev-current-repair", token: prepared.token, accepted: true, confidence: 0.99 },
			}).resolved,
		).toBe(true);
	});

	it("allows a real repair back to the finding's original digest and rejects a no-change repair", () => {
		const { tracker } = createTracker();
		const obligation = openCandidate(tracker, { candidateId: "candidate-v1" });
		receipt(tracker, {
			callId: "reproduce-v2",
			candidateBefore: "candidate-v2",
			candidateAfter: "candidate-v2",
		});
		receipt(tracker, {
			callId: "no-change",
			candidateBefore: "candidate-v2",
			candidateAfter: "candidate-v2",
			tool: "edit",
		});
		receipt(tracker, {
			callId: "no-change-recheck",
			candidateBefore: "candidate-v2",
			candidateAfter: "candidate-v2",
		});
		const noChangeReceipts = tracker.readReceipts();
		const noChangeInput = {
			id: obligation.id,
			receiverId: "root-lane",
			candidateId: "candidate-v2",
			disposition: "repaired" as const,
			evidence: [
				{
					receiptId: noChangeReceipts.find((item) => item.callId === "reproduce-v2")!.id,
					role: "reproduction" as const,
				},
				{ receiptId: noChangeReceipts.find((item) => item.callId === "no-change")!.id, role: "repair" as const },
				{
					receiptId: noChangeReceipts.find((item) => item.callId === "no-change-recheck")!.id,
					role: "recheck" as const,
				},
			],
		};
		expect(tracker.prepareResolution(noChangeInput)).toMatchObject({ ready: false });

		receipt(tracker, {
			callId: "repair-back-to-v1",
			candidateBefore: "candidate-v2",
			candidateAfter: "candidate-v1",
			tool: "edit",
		});
		receipt(tracker, {
			callId: "recheck-v1",
			candidateBefore: "candidate-v1",
			candidateAfter: "candidate-v1",
		});
		const receipts = tracker.readReceipts();
		const input = {
			...noChangeInput,
			candidateId: "candidate-v1",
			evidence: [
				noChangeInput.evidence[0]!,
				{ receiptId: receipts.find((item) => item.callId === "repair-back-to-v1")!.id, role: "repair" as const },
				{ receiptId: receipts.find((item) => item.callId === "recheck-v1")!.id, role: "recheck" as const },
			],
		};
		const prepared = tracker.prepareResolution(input);
		expect(prepared.ready).toBe(true);
		if (!prepared.ready) return;
		expect(
			tracker.resolve({
				...input,
				judgment: { id: "jev-repaired-to-original", token: prepared.token, accepted: true, confidence: 0.99 },
			}).resolved,
		).toBe(true);
	});

	it("continues resolving fresh findings after more than 128 successful judgments", () => {
		const { tracker } = createTracker();
		for (let index = 0; index < 132; index += 1) {
			const candidateId = `candidate-${index}`;
			const obligation = openCandidate(tracker, { candidateId });
			const callId = `success-${index}`;
			receipt(tracker, { callId, candidateBefore: candidateId, candidateAfter: candidateId });
			const proof = tracker.readReceipts().find((item) => item.callId === callId)!;
			const input = {
				id: obligation.id,
				receiverId: "root-lane",
				candidateId,
				disposition: "rejected" as const,
				evidence: [{ receiptId: proof.id, role: "reproduction" as const }],
			};
			const prepared = tracker.prepareResolution(input);
			expect(prepared.ready).toBe(true);
			if (!prepared.ready) return;
			expect(
				tracker.resolve({
					...input,
					judgment: { id: `jev-success-${index}`, token: prepared.token, accepted: true, confidence: 0.99 },
				}).resolved,
			).toBe(true);
		}
	});

	it("retains peer review reasons up to the bounded handoff size", () => {
		const { tracker } = createTracker();
		const reason = "r".repeat(3_000);
		const obligation = openCandidate(tracker, { reason });
		expect(obligation.reason).toBe(reason);
	});

	it("requires a reproduction, ordered changed-candidate repairs, and passing current-candidate recheck", () => {
		const { storage, tracker } = createTracker();
		const obligation = openCandidate(tracker);
		receipt(tracker, { callId: "reproduce", succeeded: true, output: "Confirmed mismatch in captured source" });
		receipt(tracker, {
			callId: "repair-1",
			candidateBefore: "candidate-v1",
			candidateAfter: "candidate-v2",
			tool: "edit",
			output: "Updated parser boundary handling in first repair",
		});
		receipt(tracker, {
			callId: "repair-2",
			candidateBefore: "candidate-v2",
			candidateAfter: "candidate-v3",
			tool: "edit",
			output: "Updated second parser boundary",
		});
		receipt(tracker, {
			callId: "recheck",
			candidateBefore: "candidate-v3",
			candidateAfter: "candidate-v3",
			output: "PASS parser.test.ts",
		});
		const receipts = tracker.readReceipts();
		const evidence = [
			{ receiptId: receipts.find((item) => item.callId === "reproduce")!.id, role: "reproduction" as const },
			{ receiptId: receipts.find((item) => item.callId === "repair-1")!.id, role: "repair" as const },
			{ receiptId: receipts.find((item) => item.callId === "repair-2")!.id, role: "repair" as const },
			{ receiptId: receipts.find((item) => item.callId === "recheck")!.id, role: "recheck" as const },
		];
		const input = {
			id: obligation.id,
			receiverId: "root-lane",
			candidateId: "candidate-v3",
			disposition: "repaired" as const,
			evidence,
		};
		const prepared = tracker.prepareResolution(input);
		expect(prepared.ready).toBe(true);
		if (!prepared.ready) return;
		const resolved = tracker.resolve({
			...input,
			judgment: { id: "jev-repair", token: prepared.token, accepted: true, confidence: 0.99 },
		});

		expect(resolved.resolved).toBe(true);
		expect(tracker.active()).toEqual([]);
		expect(new SemanticVerificationObligationTracker(storage).active()).toEqual([]);
	});

	it("resolves outcome obligations without requiring a repository digest change", () => {
		const { tracker } = createTracker();
		const obligation = openCandidate(tracker, { candidateKind: "outcome", candidateId: "service-state-1" });
		receipt(tracker, {
			callId: "observe",
			candidateBefore: "service-state-1",
			candidateAfter: "service-state-1",
			succeeded: false,
		});
		receipt(tracker, {
			callId: "correct",
			candidateBefore: "service-state-1",
			candidateAfter: "service-state-1",
			tool: "service_action",
		});
		receipt(tracker, { callId: "recheck", candidateBefore: "service-state-1", candidateAfter: "service-state-1" });
		const receipts = tracker.readReceipts();
		const input = {
			id: obligation.id,
			receiverId: "root-lane",
			candidateId: "service-state-1",
			disposition: "repaired" as const,
			evidence: [
				{ receiptId: receipts.find((item) => item.callId === "observe")!.id, role: "reproduction" as const },
				{ receiptId: receipts.find((item) => item.callId === "correct")!.id, role: "repair" as const },
				{ receiptId: receipts.find((item) => item.callId === "recheck")!.id, role: "recheck" as const },
			],
		};
		const prepared = tracker.prepareResolution(input);
		expect(prepared.ready).toBe(true);
		if (!prepared.ready) return;
		expect(
			tracker.resolve({
				...input,
				judgment: { id: "jev-outcome", token: prepared.token, accepted: true, confidence: 0.98 },
			}).resolved,
		).toBe(true);
	});

	it("prunes resolved history at capacity without discarding active obligations", () => {
		const { storage, tracker } = createTracker();
		for (let index = 0; index < 36; index++) {
			const candidateId = `candidate-${index}`;
			const obligation = openCandidate(tracker, { candidateId });
			const callId = `pass-${index}`;
			receipt(tracker, { callId, candidateBefore: candidateId, candidateAfter: candidateId });
			const proof = tracker.readReceipts().find((item) => item.callId === callId)!;
			const input = {
				id: obligation.id,
				receiverId: "root-lane",
				candidateId,
				disposition: "rejected" as const,
				evidence: [{ receiptId: proof.id, role: "reproduction" as const }],
			};
			const prepared = tracker.prepareResolution(input);
			expect(prepared.ready).toBe(true);
			if (!prepared.ready) return;
			expect(
				tracker.resolve({
					...input,
					judgment: { id: `jev-${index}`, token: prepared.token, accepted: true, confidence: 0.99 },
				}).resolved,
			).toBe(true);
		}
		const active = openCandidate(tracker, { candidateId: "still-active" });
		expect(tracker.active()).toEqual([active]);
		expect(new SemanticVerificationObligationTracker(storage).active()).toEqual([active]);
	});

	it("invalidates a prepared judgment after any durable branch change and prevents unchanged rerolls", () => {
		const { tracker } = createTracker();
		const obligation = openCandidate(tracker);
		receipt(tracker, { callId: "pass-1" });
		const reproduction = tracker.readReceipts().find((item) => item.callId === "pass-1")!;
		const input = {
			id: obligation.id,
			receiverId: "root-lane",
			candidateId: "candidate-v1",
			disposition: "rejected" as const,
			evidence: [{ receiptId: reproduction.id, role: "reproduction" as const }],
		};
		const prepared = tracker.prepareResolution(input);
		expect(prepared.ready).toBe(true);
		if (!prepared.ready) return;
		receipt(tracker, { callId: "new-unrelated-check" });
		const stale = tracker.resolve({
			...input,
			judgment: { id: "jev-stale", token: prepared.token, accepted: true, confidence: 0.99 },
		});
		expect(stale.resolved).toBe(false);
		const current = tracker.prepareResolution(input);
		expect(current.ready).toBe(true);
		if (!current.ready) return;
		const lowConfidence = tracker.resolve({
			...input,
			judgment: { id: "jev-low", token: current.token, accepted: true, confidence: 0.94 },
		});
		expect(lowConfidence.resolved).toBe(false);
		expect(tracker.prepareResolution(input)).toMatchObject({ ready: false, reason: "evidence_already_judged" });
	});

	it("persists receipt identity, bounds output, and refuses truncated proof", () => {
		const { storage, tracker } = createTracker();
		const obligation = openCandidate(tracker);
		receipt(tracker, { callId: "large", output: "x".repeat(20_000) });
		const loaded = new SemanticVerificationObligationTracker(storage);
		const large = loaded.readReceipts().find((item) => item.callId === "large")!;
		expect(large.output.length).toBeLessThan(20_000);
		const prepared = loaded.prepareResolution({
			id: obligation.id,
			receiverId: "root-lane",
			candidateId: "candidate-v1",
			disposition: "rejected",
			evidence: [{ receiptId: large.id, role: "reproduction" as const }],
		});
		expect(prepared).toMatchObject({
			ready: false,
			reason: "evidence_receipt_truncated",
			remediation: {
				requiredEvidence: {
					reproduction: "exactly one",
					repair: "none",
					recheck: "none",
				},
				offendingReceipts: [
					{
						receiptId: large.id,
						role: "reproduction",
						tool: "bash",
						truncated: true,
						retainedOutputChars: 12_000,
					},
				],
				nextAction: expect.stringContaining("focused check with bounded output"),
			},
		});
	});

	it("explains rejected evidence role counts and identifies only the conflicting receipt", () => {
		const { tracker } = createTracker();
		const obligation = openCandidate(tracker);
		receipt(tracker, { callId: "reproduction" });
		receipt(tracker, { callId: "extra-recheck", tool: "read", output: "bounded output" });
		const receipts = tracker.readReceipts();
		const extraRecheck = receipts.find((item) => item.callId === "extra-recheck")!;
		const prepared = tracker.prepareResolution({
			id: obligation.id,
			receiverId: "root-lane",
			candidateId: "candidate-v1",
			disposition: "rejected",
			evidence: [
				{ receiptId: receipts.find((item) => item.callId === "reproduction")!.id, role: "reproduction" },
				{ receiptId: extraRecheck.id, role: "recheck" },
			],
		});

		expect(prepared).toMatchObject({
			ready: false,
			reason: "unexpected_repair_receipts",
			remediation: {
				requiredEvidence: {
					reproduction: "exactly one",
					repair: "none",
					recheck: "none",
				},
				offendingReceipts: [{ receiptId: extraRecheck.id, role: "recheck", tool: "read", truncated: false }],
				nextAction: expect.stringContaining("keep only the single reproduction receipt"),
			},
		});
	});

	it("explains when a rejected proof has no reproduction selection", () => {
		const { tracker } = createTracker();
		const obligation = openCandidate(tracker);
		const prepared = tracker.prepareResolution({
			id: obligation.id,
			receiverId: "root-lane",
			candidateId: "candidate-v1",
			disposition: "rejected",
			evidence: [],
		});

		expect(prepared).toMatchObject({
			ready: false,
			reason: "one_reproduction_receipt_required",
			remediation: {
				requiredEvidence: { reproduction: "exactly one", repair: "none", recheck: "none" },
				offendingReceipts: [],
				nextAction: expect.stringContaining("Select exactly one reproduction receipt"),
			},
		});
	});

	it("binds prepared judgments to receipt payloads and snapshot sequence", () => {
		const { storage, tracker } = createTracker();
		const obligation = openCandidate(tracker);
		receipt(tracker, { callId: "candidate-check" });
		const proof = tracker.readReceipts().find((item) => item.callId === "candidate-check")!;
		const input = {
			id: obligation.id,
			receiverId: "root-lane",
			candidateId: "candidate-v1",
			disposition: "rejected" as const,
			evidence: [{ receiptId: proof.id, role: "reproduction" as const }],
		};
		const prepared = tracker.prepareResolution(input);
		expect(prepared.ready).toBe(true);
		if (!prepared.ready) return;
		const snapshot = storage.readRecords("session-a")!;
		storage.replaceSnapshot("session-a", {
			...snapshot,
			receipts: snapshot.receipts.map((item) =>
				item.id === proof.id ? { ...item, output: "Different host result" } : item,
			),
		});
		const stale = tracker.resolve({
			...input,
			judgment: { id: "jev-stale-payload", token: prepared.token, accepted: true, confidence: 0.99 },
		});
		expect(stale.resolved).toBe(false);
		expect(tracker.active()).toHaveLength(1);
	});

	it("records a decisive rejected resolution attempt and blocks unchanged rerolls", () => {
		const { tracker } = createTracker();
		const obligation = openCandidate(tracker);
		receipt(tracker, { callId: "pass-1" });
		const proof = tracker.readReceipts().find((item) => item.callId === "pass-1")!;
		const input = {
			id: obligation.id,
			receiverId: "root-lane",
			candidateId: "candidate-v1",
			disposition: "rejected" as const,
			evidence: [{ receiptId: proof.id, role: "reproduction" as const }],
		};
		const prepared = tracker.prepareResolution(input);
		expect(prepared.ready).toBe(true);
		if (!prepared.ready) return;
		const denied = tracker.resolve({
			...input,
			judgment: { id: "jev-denied", token: prepared.token, accepted: false, confidence: 0.98 },
		});
		expect(denied).toMatchObject({ resolved: false, reason: "judgment_did_not_accept_resolution" });
		expect(tracker.active()).toHaveLength(1);
		receipt(tracker, { callId: "unrelated-after-denial" });
		expect(tracker.prepareResolution(input)).toMatchObject({ ready: false, reason: "evidence_already_judged" });
	});

	it("fails closed on a stored sequence that claims future evidence", () => {
		const { storage, tracker } = createTracker();
		openCandidate(tracker);
		const snapshot = storage.readRecords("session-a")!;
		storage.replaceSnapshot("session-a", { ...snapshot, sequence: 0 });
		expect(() => tracker.active()).toThrow("Invalid semantic verification obligation snapshot");
	});

	it("rebinds only trusted forked obligations to the fork receiver and drops parent receipts", () => {
		const { storage, tracker } = createTracker();
		openCandidate(tracker);
		receipt(tracker, { callId: "parent-receipt" });
		storage.copySnapshot("session-a", "session-fork");
		storage.setInheritance(["session-a"], "fork-lane");
		storage.switchBranch("session-fork");

		const forked = new SemanticVerificationObligationTracker(storage);
		expect(forked.active()).toMatchObject([{ receiverId: "fork-lane", candidateId: "candidate-v1" }]);
		expect(forked.readReceipts()).toEqual([]);
		expect(storage.readRecords("session-fork")).toMatchObject({ branchKey: "session-fork" });
	});

	it("rejects inherited records from an untrusted branch", () => {
		const { storage, tracker } = createTracker();
		openCandidate(tracker);
		storage.copySnapshot("session-a", "session-stranger");
		storage.switchBranch("session-stranger");
		storage.setInheritance([], "stranger-lane");
		expect(() => new SemanticVerificationObligationTracker(storage).active()).toThrow("unauthorized branch");
	});

	it("isolates branch records by stable branch key", () => {
		const { storage, tracker } = createTracker();
		openCandidate(tracker);
		storage.switchBranch("session-b");
		expect(tracker.active()).toEqual([]);
		const branchB = openCandidate(tracker, { candidateId: "candidate-b" });
		expect(branchB.candidateId).toBe("candidate-b");
		storage.switchBranch("session-a");
		expect(tracker.active().map((item) => item.candidateId)).toEqual(["candidate-v1"]);
	});
});
