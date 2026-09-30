import { createHash, randomUUID } from "node:crypto";

export const VERIFICATION_OBLIGATIONS_CUSTOM_TYPE = "pi_semantic_verification_obligations";

const SNAPSHOT_VERSION = 1;
const MAX_OBLIGATIONS = 32;
const MAX_RECEIPTS = 64;
const MAX_JUDGED_TOKENS = 128;
const MAX_ID_LENGTH = 128;
const MAX_SOURCE_LENGTH = 100;
const MAX_REASON_LENGTH = 4_000;
const MAX_SCOPE_LENGTH = 1_000;
const MAX_RECEIPT_TOOL_LENGTH = 100;
const MAX_RECEIPT_ARGUMENTS_LENGTH = 8_000;
const MAX_RECEIPT_OUTPUT_LENGTH = 12_000;
const MAX_REMEDIATION_RECEIPTS = 16;
const MIN_RESOLUTION_CONFIDENCE = 0.95;

export type VerificationReceiptRole = "reproduction" | "repair" | "recheck";
export type VerificationDisposition = "rejected" | "repaired";

export type SemanticVerificationObligation = {
	id: string;
	source: string;
	reason: string;
	receiverId: string;
	candidateKind: "repository" | "outcome";
	candidateId: string;
	scope: string;
	sequence: number;
	status: "active" | "resolved";
	resolution?: {
		disposition: VerificationDisposition;
		candidateId: string;
		evidenceIds: string[];
		judgmentId: string;
		resolvedAt: string;
	};
};

export type SemanticVerificationObligationView = Readonly<SemanticVerificationObligation>;

export type SemanticVerificationReceipt = {
	id: string;
	callId: string;
	receiverId: string;
	candidateBefore: string;
	candidateAfter: string;
	succeeded: boolean;
	tool: string;
	args: string;
	output: string;
	truncated: boolean;
	sequence: number;
	createdAt: string;
};

export type PreparedVerificationReceipt = SemanticVerificationReceipt & { role: VerificationReceiptRole };

export type VerificationJudgedProof = {
	obligationId: string;
	fingerprint: string;
};

export type SemanticVerificationSnapshot = {
	version: 1;
	branchKey: string;
	sequence: number;
	evidenceRevision: number;
	obligations: SemanticVerificationObligation[];
	receipts: SemanticVerificationReceipt[];
	judgedTokens: VerificationJudgedProof[];
};

export interface VerificationStoragePort {
	/** Stable session identity for the active branch family, not the mutable leaf id. */
	getBranchKey(): string;
	/** Session IDs whose custom records the host copied into this branch during an explicit fork. */
	getInheritedBranchKeys?(): readonly string[];
	/** Current receiving session identity, required when active obligations cross an authorized fork. */
	getReceiverId?(): string;
	readRecords(branchKey: string): SemanticVerificationSnapshot | undefined;
	appendRecord(branchKey: string, snapshot: SemanticVerificationSnapshot): void;
}

export interface VerificationObligationsOptions {
	createId?: () => string;
	now?: () => string;
}

export interface VerificationReceiptInput {
	callId: string;
	receiverId: string;
	candidateBefore: string;
	candidateAfter: string;
	succeeded: boolean;
	tool: string;
	args: unknown;
	output: unknown;
}

export type OpenVerificationObligationInput = {
	source: string;
	reason: string;
	receiverId: string;
	candidateKind: "repository" | "outcome";
	candidateId: string;
	scope: string;
};

export type VerificationEvidenceSelection = {
	receiptId: string;
	role: VerificationReceiptRole;
};

export type PrepareVerificationResolutionInput = {
	id: string;
	receiverId: string;
	candidateId: string;
	disposition: VerificationDisposition;
	evidence: readonly VerificationEvidenceSelection[];
};

export type VerificationResolutionRemediation = {
	requiredEvidence: {
		reproduction: "exactly one";
		repair: "none" | "one or more after reproduction, in order";
		recheck: "none" | "exactly one after the final repair";
	};
	offendingReceipts: readonly {
		receiptId: string;
		role: VerificationReceiptRole;
		tool?: string;
		truncated?: boolean;
		retainedArgsChars?: number;
		retainedOutputChars?: number;
	}[];
	nextAction: string;
};

export type PreparedVerificationResolution =
	| {
			ready: true;
			obligation: SemanticVerificationObligationView;
			receipts: readonly PreparedVerificationReceipt[];
			token: string;
	  }
	| { ready: false; reason: string; remediation: VerificationResolutionRemediation };

export type ResolveVerificationInput = PrepareVerificationResolutionInput & {
	judgment: {
		id: string;
		token: string;
		/** True only when Jev accepts the requested disposition for this exact prepared evidence. */
		accepted: boolean;
		confidence: number;
	};
};

export type ResolveVerificationResult = { resolved: boolean; reason?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedText(value: unknown, maxLength: number, allowEmpty = false): value is string {
	return (
		typeof value === "string" &&
		value.length <= maxLength &&
		(allowEmpty || value.trim().length > 0) &&
		!/\p{Cc}/u.test(value)
	);
}

function isBoundedReason(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= MAX_REASON_LENGTH &&
		value.trim().length > 0 &&
		![...value].some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d;
		})
	);
}

function isSequence(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeSnapshot(candidate: unknown, branchKey: string): SemanticVerificationSnapshot {
	if (candidate === undefined) {
		return {
			version: SNAPSHOT_VERSION,
			branchKey,
			sequence: 0,
			evidenceRevision: 0,
			obligations: [],
			receipts: [],
			judgedTokens: [],
		};
	}
	if (
		!isRecord(candidate) ||
		candidate.version !== SNAPSHOT_VERSION ||
		candidate.branchKey !== branchKey ||
		!isSequence(candidate.sequence) ||
		!isSequence(candidate.evidenceRevision) ||
		candidate.evidenceRevision > candidate.sequence ||
		!Array.isArray(candidate.obligations) ||
		candidate.obligations.length > MAX_OBLIGATIONS ||
		!Array.isArray(candidate.receipts) ||
		candidate.receipts.length > MAX_RECEIPTS ||
		!Array.isArray(candidate.judgedTokens) ||
		candidate.judgedTokens.length > MAX_JUDGED_TOKENS
	) {
		throw new Error("Invalid semantic verification obligation snapshot; refusing to replace durable state.");
	}
	const sequence = candidate.sequence;
	const evidenceRevision = candidate.evidenceRevision;
	const obligations = candidate.obligations.map(readObligation);
	const receipts = candidate.receipts.map(readReceipt);
	const judgedTokens = candidate.judgedTokens.map(readJudgedProof);
	if (
		obligations.some((item) => item === undefined) ||
		receipts.some((item) => item === undefined) ||
		judgedTokens.some((token) => token === undefined) ||
		new Set(obligations.map((item) => item!.id)).size !== obligations.length ||
		new Set(receipts.map((item) => item!.id)).size !== receipts.length ||
		new Set(receipts.map((item) => item!.callId)).size !== receipts.length ||
		new Set(judgedTokens.map((item) => (item ? `${item.obligationId}:${item.fingerprint}` : ""))).size !==
			judgedTokens.length ||
		obligations.some((item) => item!.sequence > sequence) ||
		receipts.some((item) => item!.sequence > sequence) ||
		judgedTokens.some(
			(item) =>
				item !== undefined &&
				!obligations.some((obligation) => obligation?.id === item.obligationId && obligation.status === "active"),
		)
	) {
		throw new Error("Malformed semantic verification obligation records; refusing to replace durable state.");
	}
	return {
		version: SNAPSHOT_VERSION,
		branchKey,
		sequence,
		evidenceRevision,
		obligations: obligations as SemanticVerificationObligation[],
		receipts: receipts as SemanticVerificationReceipt[],
		judgedTokens: judgedTokens as VerificationJudgedProof[],
	};
}

function readJudgedProof(candidate: unknown): VerificationJudgedProof | undefined {
	if (!isRecord(candidate)) return undefined;
	if (!isBoundedText(candidate.obligationId, MAX_ID_LENGTH)) return undefined;
	if (typeof candidate.fingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(candidate.fingerprint)) return undefined;
	return { obligationId: candidate.obligationId, fingerprint: candidate.fingerprint };
}

function readObligation(candidate: unknown): SemanticVerificationObligation | undefined {
	if (!isRecord(candidate)) return undefined;
	const { id, source, reason, receiverId, candidateKind, candidateId, scope, sequence, status, resolution } =
		candidate;
	if (
		!isBoundedText(id, MAX_ID_LENGTH) ||
		!isBoundedText(source, MAX_SOURCE_LENGTH) ||
		!isBoundedReason(reason) ||
		!isBoundedText(receiverId, MAX_ID_LENGTH) ||
		(candidateKind !== "repository" && candidateKind !== "outcome") ||
		!isBoundedText(candidateId, MAX_ID_LENGTH) ||
		!isBoundedText(scope, MAX_SCOPE_LENGTH) ||
		!isSequence(sequence) ||
		(status !== "active" && status !== "resolved")
	) {
		return undefined;
	}
	if (status === "active") {
		if (resolution !== undefined) return undefined;
		return { id, source, reason, receiverId, candidateKind, candidateId, scope, sequence, status };
	}
	if (!isRecord(resolution)) return undefined;
	const { disposition, candidateId: resolvedCandidateId, evidenceIds, judgmentId, resolvedAt } = resolution;
	if (
		(disposition !== "rejected" && disposition !== "repaired") ||
		!isBoundedText(resolvedCandidateId, MAX_ID_LENGTH) ||
		!Array.isArray(evidenceIds) ||
		evidenceIds.length < 1 ||
		evidenceIds.length > MAX_RECEIPTS ||
		!evidenceIds.every((value) => isBoundedText(value, MAX_ID_LENGTH)) ||
		new Set(evidenceIds).size !== evidenceIds.length ||
		!isBoundedText(judgmentId, MAX_ID_LENGTH) ||
		!isBoundedText(resolvedAt, 100)
	) {
		return undefined;
	}
	return {
		id,
		source,
		reason,
		receiverId,
		candidateKind,
		candidateId,
		scope,
		sequence,
		status,
		resolution: {
			disposition,
			candidateId: resolvedCandidateId,
			evidenceIds: [...evidenceIds],
			judgmentId,
			resolvedAt,
		},
	};
}

function readReceipt(candidate: unknown): SemanticVerificationReceipt | undefined {
	if (!isRecord(candidate)) return undefined;
	const {
		id,
		callId,
		receiverId,
		candidateBefore,
		candidateAfter,
		succeeded,
		tool,
		args,
		output,
		truncated,
		sequence,
		createdAt,
	} = candidate;
	if (
		!isBoundedText(id, MAX_ID_LENGTH) ||
		!isBoundedText(callId, MAX_ID_LENGTH) ||
		!isBoundedText(receiverId, MAX_ID_LENGTH) ||
		!isBoundedText(candidateBefore, MAX_ID_LENGTH) ||
		!isBoundedText(candidateAfter, MAX_ID_LENGTH) ||
		typeof succeeded !== "boolean" ||
		!isBoundedText(tool, MAX_RECEIPT_TOOL_LENGTH) ||
		!isBoundedText(args, MAX_RECEIPT_ARGUMENTS_LENGTH, true) ||
		!isBoundedText(output, MAX_RECEIPT_OUTPUT_LENGTH, true) ||
		typeof truncated !== "boolean" ||
		!isSequence(sequence) ||
		!isBoundedText(createdAt, 100)
	) {
		return undefined;
	}
	return {
		id,
		callId,
		receiverId,
		candidateBefore,
		candidateAfter,
		succeeded,
		tool,
		args,
		output,
		truncated,
		sequence,
		createdAt,
	};
}

function safeBoundedJson(value: unknown, maxLength: number): { text: string; truncated: boolean } {
	let serialized: string;
	try {
		serialized = JSON.stringify(value) ?? "undefined";
	} catch {
		return { text: "[unserializable host value]", truncated: true };
	}
	if (serialized.length <= maxLength) return { text: serialized, truncated: false };
	return { text: `${serialized.slice(0, maxLength - 1)}…`, truncated: true };
}

function resolutionProofFingerprint(
	branchKey: string,
	snapshot: SemanticVerificationSnapshot,
	input: PrepareVerificationResolutionInput,
	receipts: readonly PreparedVerificationReceipt[],
): string {
	const fingerprint = JSON.stringify({
		branchKey,
		obligation: snapshot.obligations.find((item) => item.id === input.id),
		receiverId: input.receiverId,
		candidateId: input.candidateId,
		disposition: input.disposition,
		evidence: canonicalEvidenceSelections(input),
		receipts: receipts.map(
			({ id, sequence, role, candidateBefore, candidateAfter, succeeded, tool, args, output, truncated }) => ({
				id,
				sequence,
				role,
				candidateBefore,
				candidateAfter,
				succeeded,
				tool,
				args,
				output,
				truncated,
			}),
		),
	});
	return createHash("sha256").update(fingerprint).digest("hex");
}

function resolutionToken(branchKey: string, snapshot: SemanticVerificationSnapshot, proofFingerprint: string): string {
	const fence = JSON.stringify({ branchKey, sequence: snapshot.sequence, proofFingerprint });
	return createHash("sha256").update(fence).digest("hex");
}

function cloneObligation(obligation: SemanticVerificationObligation): SemanticVerificationObligationView {
	return {
		...obligation,
		...(obligation.resolution
			? { resolution: { ...obligation.resolution, evidenceIds: [...obligation.resolution.evidenceIds] } }
			: {}),
	};
}

function canonicalEvidenceSelections(input: PrepareVerificationResolutionInput): VerificationEvidenceSelection[] {
	const roleOrder: Record<VerificationReceiptRole, number> = { reproduction: 0, repair: 1, recheck: 2 };
	return [...input.evidence].sort((left, right) => roleOrder[left.role] - roleOrder[right.role]);
}

function resolutionRemediation(
	input: PrepareVerificationResolutionInput,
	reason: string,
	selections: readonly VerificationEvidenceSelection[],
	receipts: readonly SemanticVerificationReceipt[],
): VerificationResolutionRemediation {
	const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
	const offendingReceipts = selections.slice(0, MAX_REMEDIATION_RECEIPTS).map(({ receiptId, role }) => {
		const receipt = receiptById.get(receiptId);
		return {
			receiptId,
			role,
			...(receipt
				? {
						tool: receipt.tool,
						truncated: receipt.truncated,
						retainedArgsChars: receipt.args.length,
						retainedOutputChars: receipt.output.length,
					}
				: {}),
		};
	});
	const repaired = input.disposition === "repaired";
	const nextAction =
		reason === "evidence_receipt_truncated"
			? "Rerun a focused check with bounded output in this receiving lane, then select its new untruncated receipt ID."
			: reason === "unexpected_repair_receipts"
				? "For rejected, keep only the single reproduction receipt; remove repair and recheck selections."
				: reason === "one_reproduction_receipt_required"
					? "Select exactly one reproduction receipt from this receiving lane."
					: reason === "repair_chain_and_one_recheck_required"
						? "For repaired, select one reproduction, each ordered repair, and one recheck after the final repair."
						: reason === "evidence_receipt_missing"
							? "Read peer obligations for current receipt IDs, then select evidence recorded in this receiving lane."
							: "Correct the listed evidence selection or collect fresh same-lane evidence, then retry resolution.";
	return {
		requiredEvidence: {
			reproduction: "exactly one",
			repair: repaired ? "one or more after reproduction, in order" : "none",
			recheck: repaired ? "exactly one after the final repair" : "none",
		},
		offendingReceipts,
		nextAction,
	};
}

/**
 * Session-backed owner of explicit semantic verification obligations. This is separate from the
 * deterministic failed-command ledger: candidates are semantic claims, and close only through
 * lane-bound host receipts plus a matching, decisive Jev judgment.
 */
export class SemanticVerificationObligationTracker {
	private readonly storage: VerificationStoragePort;
	private readonly createId: () => string;
	private readonly now: () => string;
	private lastBranchKey: string | undefined;
	private branchGeneration = 0;

	constructor(storage: VerificationStoragePort, options: VerificationObligationsOptions = {}) {
		this.storage = storage;
		this.createId = options.createId ?? randomUUID;
		this.now = options.now ?? (() => new Date().toISOString());
	}

	private load(): { branchKey: string; snapshot: SemanticVerificationSnapshot } {
		const branchKey = this.storage.getBranchKey();
		if (!isBoundedText(branchKey, MAX_ID_LENGTH)) throw new Error("Invalid verification obligation branch key.");
		if (this.lastBranchKey !== branchKey) {
			this.lastBranchKey = branchKey;
			this.branchGeneration++;
		}
		const stored = this.storage.readRecords(branchKey);
		if (stored && stored.branchKey !== branchKey) {
			const inheritedBranchKeys = this.storage.getInheritedBranchKeys?.() ?? [];
			if (!inheritedBranchKeys.includes(stored.branchKey)) {
				throw new Error("Verification obligation snapshot belongs to an unauthorized branch.");
			}
			const inherited = normalizeSnapshot(stored, stored.branchKey);
			const receiverId = this.storage.getReceiverId?.();
			if (!isBoundedText(receiverId, MAX_ID_LENGTH)) {
				throw new Error("Cannot rebind inherited verification obligations without a receiving session identity.");
			}
			const rebound = normalizeSnapshot(
				{
					...inherited,
					branchKey,
					sequence: inherited.sequence + 1,
					evidenceRevision: inherited.evidenceRevision + 1,
					obligations: inherited.obligations.map((item) =>
						item.status === "active" ? { ...item, receiverId } : item,
					),
					receipts: [],
					judgedTokens: [],
				},
				branchKey,
			);
			if (this.storage.getBranchKey() !== branchKey)
				throw new Error("Verification obligation branch changed during fork rebind.");
			this.storage.appendRecord(branchKey, rebound);
			return { branchKey, snapshot: rebound };
		}
		return { branchKey, snapshot: normalizeSnapshot(stored, branchKey) };
	}

	private save(
		branchKey: string,
		snapshot: SemanticVerificationSnapshot,
		evidenceChanged: boolean,
	): SemanticVerificationSnapshot {
		if (this.storage.getBranchKey() !== branchKey)
			throw new Error("Verification obligation branch changed during write.");
		const next: SemanticVerificationSnapshot = {
			...snapshot,
			sequence: snapshot.sequence + 1,
			evidenceRevision: snapshot.evidenceRevision + (evidenceChanged ? 1 : 0),
			obligations: snapshot.obligations.map((item) => ({
				...item,
				...(item.resolution
					? { resolution: { ...item.resolution, evidenceIds: [...item.resolution.evidenceIds] } }
					: {}),
			})),
			receipts: snapshot.receipts.map((item) => ({ ...item })),
			judgedTokens: snapshot.judgedTokens.map((item) => ({ ...item })),
		};
		this.storage.appendRecord(branchKey, next);
		return next;
	}

	open(input: OpenVerificationObligationInput): SemanticVerificationObligationView {
		if (
			!isBoundedText(input.source, MAX_SOURCE_LENGTH) ||
			!isBoundedReason(input.reason) ||
			!isBoundedText(input.receiverId, MAX_ID_LENGTH) ||
			(input.candidateKind !== "repository" && input.candidateKind !== "outcome") ||
			!isBoundedText(input.candidateId, MAX_ID_LENGTH) ||
			!isBoundedText(input.scope, MAX_SCOPE_LENGTH)
		) {
			throw new Error(
				"Semantic verification obligations require bounded source, reason, receiver, candidate and scope.",
			);
		}
		const { branchKey, snapshot } = this.load();
		const duplicate = snapshot.obligations.find(
			(item) =>
				item.status === "active" &&
				item.source === input.source &&
				item.reason === input.reason &&
				item.receiverId === input.receiverId &&
				item.candidateKind === input.candidateKind &&
				item.candidateId === input.candidateId &&
				item.scope === input.scope,
		);
		if (duplicate) return cloneObligation(duplicate);
		if (snapshot.obligations.filter((item) => item.status === "active").length >= MAX_OBLIGATIONS)
			throw new Error("Semantic verification obligation capacity reached; existing obligations remain active.");
		const retainedObligations = [...snapshot.obligations];
		while (retainedObligations.length >= MAX_OBLIGATIONS) {
			const resolvedIndex = retainedObligations.findIndex((item) => item.status === "resolved");
			if (resolvedIndex < 0)
				throw new Error("Semantic verification obligation capacity reached; active obligations were retained.");
			retainedObligations.splice(resolvedIndex, 1);
		}
		const obligation: SemanticVerificationObligation = {
			id: this.createId(),
			source: input.source,
			reason: input.reason,
			receiverId: input.receiverId,
			candidateKind: input.candidateKind,
			candidateId: input.candidateId,
			scope: input.scope,
			sequence: snapshot.sequence + 1,
			status: "active",
		};
		if (!isBoundedText(obligation.id, MAX_ID_LENGTH)) throw new Error("Invalid verification obligation id.");
		const retainedIds = new Set(retainedObligations.map((item) => item.id));
		const next = this.save(
			branchKey,
			{
				...snapshot,
				obligations: [...retainedObligations, obligation],
				judgedTokens: snapshot.judgedTokens.filter((item) => retainedIds.has(item.obligationId)),
			},
			true,
		);
		return cloneObligation(next.obligations.find((item) => item.id === obligation.id)!);
	}

	active(): readonly SemanticVerificationObligationView[] {
		return this.load()
			.snapshot.obligations.filter((item) => item.status === "active")
			.map(cloneObligation);
	}

	peek(id?: string): SemanticVerificationObligationView | undefined {
		const obligations = this.load().snapshot.obligations;
		const obligation =
			id === undefined
				? obligations.find((item) => item.status === "active")
				: obligations.find((item) => item.id === id);
		return obligation ? cloneObligation(obligation) : undefined;
	}

	readReceipts(): readonly SemanticVerificationReceipt[] {
		return this.load().snapshot.receipts.map((item) => ({ ...item }));
	}

	recordReceipt(input: VerificationReceiptInput): void {
		if (
			!isBoundedText(input.callId, MAX_ID_LENGTH) ||
			!isBoundedText(input.receiverId, MAX_ID_LENGTH) ||
			!isBoundedText(input.candidateBefore, MAX_ID_LENGTH) ||
			!isBoundedText(input.candidateAfter, MAX_ID_LENGTH) ||
			typeof input.succeeded !== "boolean" ||
			!isBoundedText(input.tool, MAX_RECEIPT_TOOL_LENGTH)
		) {
			throw new Error("Invalid host verification receipt identity.");
		}
		const { branchKey, snapshot } = this.load();
		if (snapshot.receipts.some((item) => item.callId === input.callId))
			throw new Error("Duplicate verification receipt call id.");
		const args = safeBoundedJson(input.args, MAX_RECEIPT_ARGUMENTS_LENGTH);
		const output = safeBoundedJson(input.output, MAX_RECEIPT_OUTPUT_LENGTH);
		const receipt: SemanticVerificationReceipt = {
			id: this.createId(),
			callId: input.callId,
			receiverId: input.receiverId,
			candidateBefore: input.candidateBefore,
			candidateAfter: input.candidateAfter,
			succeeded: input.succeeded,
			tool: input.tool,
			args: args.text,
			output: output.text,
			truncated: args.truncated || output.truncated,
			sequence: snapshot.sequence + 1,
			createdAt: this.now(),
		};
		if (!isBoundedText(receipt.id, MAX_ID_LENGTH) || !isBoundedText(receipt.createdAt, 100))
			throw new Error("Invalid verification receipt id or timestamp.");
		const receipts = [...snapshot.receipts, receipt];
		if (receipts.length > MAX_RECEIPTS) receipts.splice(0, receipts.length - MAX_RECEIPTS);
		this.save(branchKey, { ...snapshot, receipts }, true);
	}

	prepareResolution(input: PrepareVerificationResolutionInput): PreparedVerificationResolution {
		const { branchKey, snapshot } = this.load();
		const unresolved = (
			reason: string,
			selections: readonly VerificationEvidenceSelection[] = input.evidence,
		): PreparedVerificationResolution => ({
			ready: false,
			reason,
			remediation: resolutionRemediation(input, reason, selections, snapshot.receipts),
		});
		const obligation = snapshot.obligations.find((item) => item.id === input.id);
		if (obligation?.status !== "active") return unresolved("obligation_not_active");
		if (input.receiverId !== obligation.receiverId) return unresolved("receiving_lane_mismatch");
		if (!isBoundedText(input.candidateId, MAX_ID_LENGTH)) return unresolved("candidate_identity_missing");
		if (input.disposition !== "rejected" && input.disposition !== "repaired")
			return unresolved("unknown_disposition");

		const roles = canonicalEvidenceSelections(input);
		if (roles.some((item) => item.role !== "reproduction" && item.role !== "repair" && item.role !== "recheck"))
			return unresolved("unknown_evidence_role", roles);
		if (new Set(roles.map((item) => item.receiptId)).size !== roles.length)
			return unresolved("duplicate_evidence_receipt", roles);
		const reproductionSelections = roles.filter((item) => item.role === "reproduction");
		const repairSelections = roles.filter((item) => item.role === "repair");
		const recheckSelections = roles.filter((item) => item.role === "recheck");
		if (reproductionSelections.length !== 1) return unresolved("one_reproduction_receipt_required", roles);
		if (input.disposition === "repaired" && (repairSelections.length === 0 || recheckSelections.length !== 1))
			return unresolved("repair_chain_and_one_recheck_required", roles);
		if (input.disposition === "rejected" && (repairSelections.length !== 0 || recheckSelections.length !== 0))
			return unresolved("unexpected_repair_receipts", [...repairSelections, ...recheckSelections]);

		const selected: PreparedVerificationReceipt[] = [];
		for (const { role, receiptId } of roles) {
			const record = snapshot.receipts.find((item) => item.id === receiptId);
			if (!record) return unresolved("evidence_receipt_missing", [{ receiptId, role }]);
			if (record.sequence <= obligation.sequence)
				return unresolved("evidence_predates_obligation", [{ receiptId, role }]);
			if (record.receiverId !== obligation.receiverId)
				return unresolved("evidence_receiving_lane_mismatch", [{ receiptId, role }]);
			if (record.truncated) return unresolved("evidence_receipt_truncated", [{ receiptId, role }]);
			selected.push({ ...record, role });
		}
		selected.sort((left, right) => left.sequence - right.sequence);
		if (selected.some((item, index) => index > 0 && item.sequence <= selected[index - 1].sequence))
			return unresolved("evidence_order_invalid", roles);
		const reproduction = selected.find((item) => item.role === "reproduction");
		if (!reproduction || reproduction.candidateBefore !== reproduction.candidateAfter)
			return unresolved(
				"reproduction_candidate_mismatch",
				roles.filter((item) => item.role === "reproduction"),
			);
		if (input.disposition === "rejected") {
			if (reproduction.candidateAfter !== input.candidateId || !reproduction.succeeded) {
				return unresolved("candidate_rejection_requires_passing_current_reproduction", reproductionSelections);
			}
		} else {
			const repairs = selected.filter((item) => item.role === "repair");
			const recheck = selected.find((item) => item.role === "recheck");
			if (repairs.length === 0 || !recheck) return unresolved("repair_chain_and_one_recheck_required", roles);
			let expectedBefore = reproduction.candidateAfter;
			for (const repair of repairs) {
				if (
					repair.sequence <= reproduction.sequence ||
					repair.candidateBefore !== expectedBefore ||
					!repair.succeeded ||
					(obligation.candidateKind === "repository" && repair.candidateAfter === expectedBefore)
				) {
					return unresolved(
						"repair_receipt_does_not_span_candidate",
						roles.filter((item) => item.role === "repair"),
					);
				}
				expectedBefore = repair.candidateAfter;
			}
			const finalRepair = repairs.at(-1)!;
			if (
				finalRepair.candidateAfter !== input.candidateId ||
				(input.candidateId === reproduction.candidateAfter && obligation.candidateKind === "repository")
			)
				return unresolved(
					"repair_chain_does_not_reach_current_candidate",
					roles.filter((item) => item.role === "repair"),
				);
			if (recheck.sequence <= finalRepair.sequence)
				return unresolved("repair_proof_order_invalid", recheckSelections);
			if (
				recheck.candidateBefore !== input.candidateId ||
				recheck.candidateAfter !== input.candidateId ||
				!recheck.succeeded
			) {
				return unresolved("recheck_does_not_pass_on_current_candidate", recheckSelections);
			}
		}
		const proofFingerprint = resolutionProofFingerprint(branchKey, snapshot, input, selected);
		if (snapshot.judgedTokens.some((item) => item.obligationId === input.id && item.fingerprint === proofFingerprint))
			return unresolved("evidence_already_judged", roles);
		const token = resolutionToken(branchKey, snapshot, proofFingerprint);
		return {
			ready: true,
			obligation: cloneObligation(obligation),
			receipts: selected,
			token: `${this.branchGeneration}.${token}`,
		};
	}

	resolve(input: ResolveVerificationInput): ResolveVerificationResult {
		const { branchKey, snapshot } = this.load();
		const prepared = this.prepareResolution(input);
		if (!prepared.ready) return { resolved: false, reason: prepared.reason };
		const expectedToken = `${this.branchGeneration}.${prepared.token.slice(prepared.token.indexOf(".") + 1)}`;
		if (input.judgment.token !== expectedToken) return { resolved: false, reason: "prepared_resolution_stale" };
		if (
			!isBoundedText(input.judgment.id, MAX_ID_LENGTH) ||
			typeof input.judgment.accepted !== "boolean" ||
			typeof input.judgment.confidence !== "number" ||
			!Number.isFinite(input.judgment.confidence) ||
			input.judgment.confidence < 0 ||
			input.judgment.confidence > 1
		) {
			return { resolved: false, reason: "invalid_judgment" };
		}
		const selected = prepared.receipts;
		const proofFingerprint = resolutionProofFingerprint(branchKey, snapshot, input, selected);
		if (input.judgment.confidence < MIN_RESOLUTION_CONFIDENCE || !input.judgment.accepted) {
			if (snapshot.judgedTokens.length >= MAX_JUDGED_TOKENS)
				return { resolved: false, reason: "judgment_history_capacity_reached" };
			this.save(
				branchKey,
				{
					...snapshot,
					judgedTokens: [...snapshot.judgedTokens, { obligationId: input.id, fingerprint: proofFingerprint }],
				},
				false,
			);
			if (input.judgment.confidence < MIN_RESOLUTION_CONFIDENCE)
				return { resolved: false, reason: "judgment_confidence_below_threshold" };
			return { resolved: false, reason: "judgment_did_not_accept_resolution" };
		}
		const obligation = snapshot.obligations.find((item) => item.id === input.id);
		if (obligation?.status !== "active") return { resolved: false, reason: "obligation_not_active" };
		const evidenceIds = canonicalEvidenceSelections(input).map((item) => item.receiptId);
		const updatedObligations = snapshot.obligations.map((item) =>
			item.id === input.id
				? {
						...item,
						status: "resolved" as const,
						resolution: {
							disposition: input.disposition,
							candidateId: input.candidateId,
							evidenceIds,
							judgmentId: input.judgment.id,
							resolvedAt: this.now(),
						},
					}
				: item,
		);
		this.save(
			branchKey,
			{
				...snapshot,
				obligations: updatedObligations,
				judgedTokens: snapshot.judgedTokens.filter((item) => item.obligationId !== input.id),
			},
			true,
		);
		return { resolved: true };
	}
}
