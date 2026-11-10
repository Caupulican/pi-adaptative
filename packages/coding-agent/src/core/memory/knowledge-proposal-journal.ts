/**
 * Candidate knowledge that waits for the owner's decision, on the canonical knowledge connection. A proposal is not
 * owner evidence: nothing here is knowledge, is retrieved, or teaches anything. It becomes a fact only when the owner's
 * own command states it (`KnowledgeAdmission.ownerCommand`, action `state`); forgetting does not touch this table.
 *
 * The table is created when the journal is constructed, if absent, and `PRAGMA user_version` does not change. A store
 * shared with an earlier version of pi stays readable there: an earlier version refuses a newer schema version and
 * loses its whole memory system, while a table it never reads costs it nothing.
 *
 * A proposal is offered once. Its id digests the project key, the kind and the normalized text, so the same proposal
 * is one row in any status, also after it was accepted or rejected. A decision erases its text and evidence and keeps
 * the id, status and times, which is all that is needed to refuse an offer of the same proposal again.
 *
 * The same connection carries one more small table, `knowledge_origin_looks`: what an origin already looked at in a
 * project, so a repeated look reads only what is new ({@link KnowledgeOriginLookJournal}). It is created the same way,
 * it changes no schema version, and what it holds is not owner evidence either.
 */
import { createHash } from "node:crypto";
import { type SqliteDatabase, withSqliteTransaction } from "../context/sqlite-database.ts";
import { hasMaskableSecretText } from "../security/secret-text.ts";
import { MAX_KNOWLEDGE_NAME_CHARS, MAX_KNOWLEDGE_TEXT_CHARS } from "./knowledge-record.ts";

export const KNOWLEDGE_PROPOSAL_SCHEMA = `CREATE TABLE IF NOT EXISTS knowledge_proposals (
 id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, origin TEXT NOT NULL,
 subject TEXT, key TEXT, text TEXT, evidence TEXT,
 offered_at TEXT NOT NULL, decided_at TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected'))
) STRICT;
CREATE INDEX IF NOT EXISTS knowledge_proposals_project ON knowledge_proposals(project,status,offered_at);`;

export const KNOWLEDGE_ORIGIN_LOOK_SCHEMA = `CREATE TABLE IF NOT EXISTS knowledge_origin_looks (
 project TEXT NOT NULL, origin TEXT NOT NULL, cursor TEXT NOT NULL, recorded_at TEXT NOT NULL,
 PRIMARY KEY(project, origin)
) STRICT;`;

export const MAX_PENDING_PROPOSALS = 20;
export const MAX_PROPOSAL_EVIDENCE = 8;
export const MAX_PROPOSAL_EVIDENCE_REF_CHARS = 80;
export const MAX_PROPOSAL_EVIDENCE_NOTE_CHARS = 200;
/** A look's cursor is opaque to this table: its meaning is the origin's, and its length is bounded here anyway. */
export const MAX_ORIGIN_LOOK_CURSOR_CHARS = 200;
const MAX_ORIGIN_CHARS = 60;

export type KnowledgeProposalStatus = "pending" | "accepted" | "rejected";

export interface KnowledgeProposalEvidence {
	/** A short reference to where the support is, such as a commit id. */
	readonly ref: string;
	readonly note: string;
}

export interface KnowledgeProposalOffer {
	/** Empty for a proposal that applies everywhere. */
	readonly project: string;
	readonly kind: string;
	/** A short label of where it came from, such as `repository-history`. */
	readonly origin: string;
	readonly subject: string;
	readonly key: string;
	readonly text: string;
	readonly evidence: readonly KnowledgeProposalEvidence[];
}

/** A pending proposal carries its content; a decided one is only its identity, status and times. */
export interface KnowledgeProposal {
	readonly id: string;
	readonly project: string;
	readonly kind: string;
	readonly origin: string;
	readonly status: KnowledgeProposalStatus;
	readonly offeredAt: string;
	readonly decidedAt?: string;
	readonly content?: Pick<KnowledgeProposalOffer, "subject" | "key" | "text" | "evidence">;
}

export type KnowledgeProposalOutcome =
	| { readonly status: "offered"; readonly id: string }
	| { readonly status: "known"; readonly id: string; readonly state: KnowledgeProposalStatus }
	| { readonly status: "full"; readonly limit: number };

function normalized(text: string): string {
	return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function knowledgeProposalId(project: string, kind: string, text: string): string {
	return createHash("sha256")
		.update(JSON.stringify([project, kind, normalized(text)]))
		.digest("hex");
}

function requireText(value: unknown, max: number, what: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
		throw new TypeError(`Invalid proposal ${what}`);
	if (hasMaskableSecretText(value)) throw new TypeError(`A proposal ${what} must not contain secrets`);
	return value;
}

function validated(offer: KnowledgeProposalOffer): KnowledgeProposalOffer {
	if (
		typeof offer.project !== "string" ||
		offer.project.length > MAX_KNOWLEDGE_NAME_CHARS ||
		offer.project.includes("\0")
	)
		throw new TypeError("Invalid proposal project");
	if (!Array.isArray(offer.evidence) || offer.evidence.length > MAX_PROPOSAL_EVIDENCE)
		throw new TypeError(`A proposal carries at most ${MAX_PROPOSAL_EVIDENCE} evidence entries`);
	return {
		project: offer.project,
		kind: requireText(offer.kind, MAX_KNOWLEDGE_NAME_CHARS, "kind"),
		origin: requireText(offer.origin, MAX_ORIGIN_CHARS, "origin"),
		subject: requireText(offer.subject, MAX_KNOWLEDGE_NAME_CHARS, "subject"),
		key: requireText(offer.key, MAX_KNOWLEDGE_NAME_CHARS, "key"),
		text: requireText(offer.text, MAX_KNOWLEDGE_TEXT_CHARS, "text"),
		evidence: offer.evidence.map((entry) => ({
			ref: requireText(entry.ref, MAX_PROPOSAL_EVIDENCE_REF_CHARS, "evidence reference"),
			note: requireText(entry.note, MAX_PROPOSAL_EVIDENCE_NOTE_CHARS, "evidence description"),
		})),
	};
}

function isStatus(value: unknown): value is KnowledgeProposalStatus {
	return value === "pending" || value === "accepted" || value === "rejected";
}

function decode(row: Record<string, unknown>): KnowledgeProposal {
	const { id, project, kind, origin, status, offered_at: offeredAt, decided_at: decidedAt } = row;
	if (
		typeof id !== "string" ||
		typeof project !== "string" ||
		typeof kind !== "string" ||
		typeof origin !== "string" ||
		typeof offeredAt !== "string" ||
		!isStatus(status)
	)
		throw new Error("Invalid knowledge proposal row");
	const base = {
		id,
		project,
		kind,
		origin,
		status,
		offeredAt,
		...(typeof decidedAt === "string" ? { decidedAt } : {}),
	};
	if (status !== "pending") return base;
	if (typeof row.subject !== "string" || typeof row.key !== "string" || typeof row.text !== "string")
		throw new Error("A pending knowledge proposal has no content");
	const evidence: unknown = JSON.parse(String(row.evidence));
	if (!Array.isArray(evidence) || evidence.length > MAX_PROPOSAL_EVIDENCE)
		throw new Error("Invalid knowledge proposal evidence");
	return { ...base, content: { subject: row.subject, key: row.key, text: row.text, evidence } };
}

export class KnowledgeProposalJournal {
	private readonly db: SqliteDatabase;
	private readonly now: () => number;

	constructor(db: SqliteDatabase, now: () => number = Date.now) {
		this.db = db;
		this.now = now;
		db.exec(KNOWLEDGE_PROPOSAL_SCHEMA);
	}

	/** Offers a proposal once: a known one, in any status, is not offered again, and a project's pending list is bounded. */
	offer(input: KnowledgeProposalOffer): KnowledgeProposalOutcome {
		const offer = validated(input);
		const id = knowledgeProposalId(offer.project, offer.kind, offer.text);
		return withSqliteTransaction(
			this.db,
			(): KnowledgeProposalOutcome => {
				const known = this.db.prepare("SELECT status FROM knowledge_proposals WHERE id=?").get(id)?.status;
				if (isStatus(known)) return { status: "known", id, state: known };
				const pending = this.db
					.prepare("SELECT count(*) AS n FROM knowledge_proposals WHERE project=? AND status='pending'")
					.get(offer.project)?.n;
				if (typeof pending !== "number" || pending >= MAX_PENDING_PROPOSALS)
					return { status: "full", limit: MAX_PENDING_PROPOSALS };
				this.db
					.prepare(
						"INSERT INTO knowledge_proposals(id,project,kind,origin,subject,key,text,evidence,offered_at,status) VALUES(?,?,?,?,?,?,?,?,?,'pending')",
					)
					.run(
						id,
						offer.project,
						offer.kind,
						offer.origin,
						offer.subject,
						offer.key,
						offer.text,
						JSON.stringify(offer.evidence),
						new Date(this.now()).toISOString(),
					);
				return { status: "offered", id };
			},
			"Knowledge proposal offer",
		);
	}

	/** Pending proposals of this project and global, oldest first. */
	listPending(project: string, limit = MAX_PENDING_PROPOSALS): KnowledgeProposal[] {
		return this.db
			.prepare(
				"SELECT * FROM knowledge_proposals WHERE status='pending' AND project IN('',?) ORDER BY offered_at,id LIMIT ?",
			)
			.all(project, Math.min(Math.max(1, Math.trunc(limit)), MAX_PENDING_PROPOSALS * 2))
			.map(decode);
	}

	/** Proposals of this project or global, in any status, whose id starts with `prefix`; two at most, so ambiguity shows. */
	resolve(project: string, prefix: string): KnowledgeProposal[] {
		if (!/^[a-f0-9]{8,64}$/.test(prefix)) throw new TypeError("Invalid proposal identity prefix");
		// Hex identities sort below "g", so this range is exactly the identities that start with the prefix.
		return this.db
			.prepare("SELECT * FROM knowledge_proposals WHERE id>=? AND id<? AND project IN('',?) ORDER BY id LIMIT 2")
			.all(prefix, `${prefix}g`, project)
			.map(decode);
	}

	/** Records the owner's decision on a pending proposal and erases its text and evidence. False: it was not pending. */
	decide(id: string, status: "accepted" | "rejected"): boolean {
		if (status !== "accepted" && status !== "rejected") throw new TypeError("Invalid proposal decision");
		return withSqliteTransaction(
			this.db,
			() => {
				if (this.db.prepare("SELECT status FROM knowledge_proposals WHERE id=?").get(id)?.status !== "pending")
					return false;
				this.db
					.prepare(
						"UPDATE knowledge_proposals SET status=?,decided_at=?,subject=NULL,key=NULL,text=NULL,evidence=NULL WHERE id=?",
					)
					.run(status, new Date(this.now()).toISOString(), id);
				return true;
			},
			"Knowledge proposal decision",
		);
	}
}

/** What one origin already looked at in one project: its own opaque cursor and when it recorded it. */
export interface KnowledgeOriginLook {
	/** Opaque text this table never interprets: for a repository origin, the head commit that was read. */
	readonly cursor: string;
	/** When the look was recorded, ISO 8601. */
	readonly recordedAt: string;
}

/** A project key of a look: any bounded text, empty for a global look, exactly as a proposal's project. */
function lookProject(project: unknown): string {
	if (typeof project !== "string" || project.length > MAX_KNOWLEDGE_NAME_CHARS || project.includes("\0"))
		throw new TypeError("Invalid origin look project");
	return project;
}

/** A bounded, non-empty, secret-free text field of a look; nothing here interprets its content. */
function lookText(value: unknown, max: number, what: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
		throw new TypeError(`Invalid origin look ${what}`);
	if (hasMaskableSecretText(value)) throw new TypeError(`An origin look ${what} must not contain secrets`);
	return value;
}

/**
 * What an origin already looked at, per project key and origin label, so a repeated look reads only what is new since
 * the cursor it recorded. One row per project and origin: recording replaces the previous look.
 */
export class KnowledgeOriginLookJournal {
	private readonly db: SqliteDatabase;
	private readonly now: () => number;

	constructor(db: SqliteDatabase, now: () => number = Date.now) {
		this.db = db;
		this.now = now;
		db.exec(KNOWLEDGE_ORIGIN_LOOK_SCHEMA);
	}

	/** The last look this origin recorded in this project, or undefined when it never looked. */
	last(project: string, origin: string): KnowledgeOriginLook | undefined {
		const row = this.db
			.prepare("SELECT cursor,recorded_at FROM knowledge_origin_looks WHERE project=? AND origin=?")
			.get(lookProject(project), lookText(origin, MAX_ORIGIN_CHARS, "origin"));
		if (row === undefined) return undefined;
		if (typeof row.cursor !== "string" || typeof row.recorded_at !== "string")
			throw new Error("Invalid origin look row");
		return { cursor: row.cursor, recordedAt: row.recorded_at };
	}

	/** Records a look, replacing this project's previous one for this origin. */
	record(project: string, origin: string, cursor: string): KnowledgeOriginLook {
		const look = {
			cursor: lookText(cursor, MAX_ORIGIN_LOOK_CURSOR_CHARS, "cursor"),
			recordedAt: new Date(this.now()).toISOString(),
		};
		this.db
			.prepare("INSERT OR REPLACE INTO knowledge_origin_looks(project,origin,cursor,recorded_at) VALUES(?,?,?,?)")
			.run(lookProject(project), lookText(origin, MAX_ORIGIN_CHARS, "origin"), look.cursor, look.recordedAt);
		return look;
	}
}
