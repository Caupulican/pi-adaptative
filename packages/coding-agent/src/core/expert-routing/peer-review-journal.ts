import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { peerFindingsSchema } from "./peer-review-contract.ts";

const CUSTOM_TYPE = "pi_root_peer_reviews";
const MAX_REVIEWS = 32;
const scopeSchema = Type.Object({
	sessionId: Type.String(),
	objectiveId: Type.Optional(Type.String()),
	contractDigest: Type.String(),
	semanticEnabled: Type.Boolean(),
	candidateId: Type.String(),
	candidateKind: Type.Union([Type.Literal("repository"), Type.Literal("snapshot")]),
	sourceRevision: Type.Optional(Type.String()),
});
export type PeerReviewScope = Static<typeof scopeSchema>;

const receiptSchema = Type.Object({
	key: Type.String(),
	scope: scopeSchema,
	stage: Type.Union([Type.Literal("plan"), Type.Literal("delivery")]),
	outcome: Type.Union([Type.Literal("pending"), Type.Literal("reviewed"), Type.Literal("unavailable")]),
	verdict: Type.Optional(
		Type.Union([Type.Literal("no_findings"), Type.Literal("findings"), Type.Literal("insufficient_evidence")]),
	),
	peer: Type.String(),
	summary: Type.String({ maxLength: 2000 }),
	limitations: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 16 }),
	findings: peerFindingsSchema,
	acknowledgement: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
	acknowledgedCandidateId: Type.Optional(Type.String()),
	verificationRecorded: Type.Optional(Type.Boolean()),
	settled: Type.Optional(Type.Boolean()),
	attemptDisposition: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
	disposedCandidateId: Type.Optional(Type.String()),
});
export type PeerReviewReceipt = Static<typeof receiptSchema>;
const journalSchema = Type.Object({
	version: Type.Literal(1),
	sessionId: Type.String(),
	reviews: Type.Array(receiptSchema, { maxItems: MAX_REVIEWS }),
});

export function peerReviewDigest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Branch-owned, bounded receipts. A pending record survives a crash without pretending review completed. */
export class PeerReviewJournal {
	private readonly manager: () => SessionManager;

	constructor(manager: () => SessionManager) {
		this.manager = manager;
	}

	read(): readonly PeerReviewReceipt[] {
		const manager = this.manager();
		const entry = manager.getLatestCustomEntryOnBranch(CUSTOM_TYPE);
		if (!entry) return [];
		if (!Value.Check(journalSchema, entry.data)) throw new Error("Root peer review journal is malformed.");
		if (entry.data.sessionId !== manager.getSessionId()) {
			if (manager.getSessionLineageIds().includes(entry.data.sessionId)) return [];
			throw new Error("Root peer review journal belongs to another session.");
		}
		return entry.data.reviews;
	}

	record(receipt: PeerReviewReceipt): void {
		const manager = this.manager();
		if (receipt.scope.sessionId !== manager.getSessionId()) throw new Error("Peer review session changed.");
		if (!Value.Check(receiptSchema, receipt)) throw new Error("Invalid root peer review receipt.");
		const reviews = this.read().filter((previous) => previous.key !== receipt.key);
		if (reviews.length >= MAX_REVIEWS) {
			const reusable = reviews.findIndex(
				(previous) =>
					previous.scope.sessionId !== receipt.scope.sessionId ||
					previous.scope.objectiveId !== receipt.scope.objectiveId ||
					previous.settled ||
					previous.acknowledgement ||
					(previous.outcome === "reviewed" &&
						previous.verdict === "no_findings" &&
						previous.limitations.length === 0),
			);
			if (reusable < 0)
				throw new Error(
					"Advisor receipt capacity reached; resolve reviewed findings or use peer dispose_attempt for a non-running failed attempt before adding another.",
				);
			reviews.splice(reusable, 1);
		}
		reviews.push(receipt);
		manager.appendCustomEntry(CUSTOM_TYPE, {
			version: 1,
			sessionId: manager.getSessionId(),
			reviews,
		});
	}
}
