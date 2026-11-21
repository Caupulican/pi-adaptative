/** Durable ordinary owner work and its compare-and-swap lease, on the shared decision-ledger connection. */
import { isProcessOwnerRecord, type ProcessOwner } from "../kernel/reliability/owner-identity.ts";
import type { SqliteDatabase } from "./context/sqlite-database.ts";
import { withSqliteTransaction } from "./context/sqlite-database.ts";
import {
	ORDINARY_ANSWER_RESERVATION,
	ORDINARY_REPORTING_RESERVATION,
	ORDINARY_WORK_MAX_CONTINUATIONS,
	type OrdinaryReportingRequirements,
	ordinaryReportingChangedAtSettlement,
} from "./ordinary-work-policy.ts";

export type OrdinaryWorkStatus = "active" | "waiting" | "owner_needed" | "unverified" | "fulfilled" | "cancelled";

export interface OrdinaryWorkRecord {
	readonly sessionId: string;
	readonly openingEntryId: string;
	readonly frontierEntryId: string;
	readonly generation: number;
	readonly revision: number;
	readonly status: OrdinaryWorkStatus;
	readonly continuationCount: number;
	readonly openedAt: number;
	readonly updatedAt: number;
	readonly reason?: string;
	readonly leaseId?: string;
	readonly leaseOwner?: ProcessOwner;
}

export interface OrdinaryWorkLease extends ProcessOwner {
	readonly id: string;
}

export const ORDINARY_WORK_LOOKUP_BATCH = 64;

export function initializeOrdinaryWorkSchema(database: SqliteDatabase): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS ordinary_work (
			session_id TEXT NOT NULL,
			opening_entry_id TEXT NOT NULL,
			frontier_entry_id TEXT NOT NULL,
			generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
			revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
			status TEXT NOT NULL CHECK (status IN ('active', 'waiting', 'owner_needed', 'unverified', 'fulfilled', 'cancelled')),
			continuation_count INTEGER NOT NULL DEFAULT 0 CHECK (continuation_count BETWEEN 0 AND ${ORDINARY_WORK_MAX_CONTINUATIONS}),
			opened_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			reason TEXT,
			lease_id TEXT,
			lease_pid INTEGER,
			lease_start_time TEXT,
			lease_hostname TEXT,
			lease_machine_id TEXT,
			PRIMARY KEY (session_id, opening_entry_id),
			CHECK ((lease_id IS NULL) = (lease_pid IS NULL))
		);
	`);
	const columns = new Set(
		database
			.prepare("PRAGMA table_info(ordinary_work)")
			.all()
			.map((column) => column.name),
	);
	for (const column of ["lease_start_time", "lease_hostname", "lease_machine_id"]) {
		if (!columns.has(column)) database.exec(`ALTER TABLE ordinary_work ADD COLUMN ${column} TEXT`);
	}
}

function decodedRecord(row: Record<string, unknown>): OrdinaryWorkRecord {
	const integers = ["generation", "revision", "continuation_count", "opened_at", "updated_at"];
	const owner = {
		pid: row.lease_pid,
		...(row.lease_start_time === null ? {} : { startTime: row.lease_start_time }),
		...(row.lease_hostname === null ? {} : { hostname: row.lease_hostname }),
		...(row.lease_machine_id === null ? {} : { machineId: row.lease_machine_id }),
	};
	const leaseOwner = isProcessOwnerRecord(owner) ? owner : undefined;
	if (
		integers.some((key) => !Number.isSafeInteger(row[key]) || (row[key] as number) < 0) ||
		typeof row.session_id !== "string" ||
		typeof row.opening_entry_id !== "string" ||
		typeof row.frontier_entry_id !== "string" ||
		!["active", "waiting", "owner_needed", "unverified", "fulfilled", "cancelled"].includes(String(row.status)) ||
		(row.reason !== null && typeof row.reason !== "string") ||
		(row.lease_id !== null && typeof row.lease_id !== "string") ||
		(row.lease_pid !== null && !leaseOwner) ||
		(row.lease_id === null) !== (row.lease_pid === null)
	)
		throw new Error("Ordinary work contains an invalid durable record.");
	return {
		sessionId: row.session_id,
		openingEntryId: row.opening_entry_id,
		frontierEntryId: row.frontier_entry_id,
		generation: row.generation as number,
		revision: row.revision as number,
		status: row.status as OrdinaryWorkStatus,
		continuationCount: row.continuation_count as number,
		openedAt: row.opened_at as number,
		updatedAt: row.updated_at as number,
		...(typeof row.reason === "string" ? { reason: row.reason } : {}),
		...(typeof row.lease_id === "string" ? { leaseId: row.lease_id, leaseOwner } : {}),
	};
}

export function ordinaryWorkIsTerminal(record: Pick<OrdinaryWorkRecord, "status">): boolean {
	return record.status === "fulfilled" || record.status === "cancelled";
}

export class OrdinaryWorkStore {
	private readonly database: SqliteDatabase;
	constructor(database: SqliteDatabase) {
		this.database = database;
	}

	get(sessionId: string, openingEntryId: string): OrdinaryWorkRecord | undefined {
		const row = this.database
			.prepare("SELECT * FROM ordinary_work WHERE session_id = ? AND opening_entry_id = ?")
			.get(sessionId, openingEntryId);
		return row ? decodedRecord(row) : undefined;
	}

	forSession(sessionId: string): OrdinaryWorkRecord[] {
		return this.database
			.prepare("SELECT * FROM ordinary_work WHERE session_id = ?")
			.all(sessionId)
			.map(decodedRecord);
	}

	openingCandidates(sessionId: string): string[] {
		return this.database
			.prepare(
				`SELECT opening_entry_id FROM ordinary_work WHERE session_id = ? LIMIT ${ORDINARY_WORK_LOOKUP_BATCH + 1}`,
			)
			.all(sessionId)
			.map((row) => String(row.opening_entry_id));
	}

	forOpenings(sessionId: string, openingEntryIds: readonly string[]): OrdinaryWorkRecord[] {
		if (!openingEntryIds.length) return [];
		if (openingEntryIds.length > ORDINARY_WORK_LOOKUP_BATCH) throw new RangeError("Too many ordinary work openings");
		return this.database
			.prepare(
				`SELECT * FROM ordinary_work WHERE session_id = ? AND opening_entry_id IN (${openingEntryIds.map(() => "?").join(",")})`,
			)
			.all(sessionId, ...openingEntryIds)
			.map(decodedRecord);
	}

	open(sessionId: string, openingEntryId: string, now: number): OrdinaryWorkRecord {
		this.database
			.prepare(`INSERT OR IGNORE INTO ordinary_work
				(session_id, opening_entry_id, frontier_entry_id, status, opened_at, updated_at)
				VALUES (?, ?, ?, 'active', ?, ?)`)
			.run(sessionId, openingEntryId, openingEntryId, now, now);
		return this.get(sessionId, openingEntryId)!;
	}

	claim(
		expected: OrdinaryWorkRecord,
		lease: OrdinaryWorkLease,
		now: number,
		kind: "acquire" | "continue" | "answer_only" | { readonly reporting: OrdinaryReportingRequirements },
	): OrdinaryWorkRecord | undefined {
		const continuation = kind !== "acquire";
		return withSqliteTransaction(
			this.database,
			() => {
				const reporting = typeof kind === "object";
				const changed =
					reporting && ordinaryReportingChangedAtSettlement(ORDINARY_REPORTING_RESERVATION, kind.reporting);
				const reservation = reporting
					? ORDINARY_REPORTING_RESERVATION
					: kind === "answer_only"
						? ORDINARY_ANSWER_RESERVATION
						: null;
				const nextLease = changed ? undefined : lease;
				const spend = Number(continuation && !changed);
				const row = this.database
					.prepare(`UPDATE ordinary_work SET
					lease_id = ?, lease_pid = ?, lease_start_time = ?, lease_hostname = ?, lease_machine_id = ?,
					updated_at = ?, revision = revision + 1,
					generation = generation + ?, continuation_count = continuation_count + ?, status = ?, reason = ?
					WHERE session_id = ? AND opening_entry_id = ? AND revision = ? AND generation = ?
					AND status NOT IN ('fulfilled', 'cancelled') AND lease_id IS ?
					AND continuation_count + ? <= ?
					AND (? = 0 OR (status = 'active' AND reason = 'stop_review_in_progress' AND lease_id = ? AND lease_pid = ?))
					RETURNING *`)
					.get(
						nextLease?.id ?? null,
						nextLease?.pid ?? null,
						nextLease?.startTime ?? null,
						nextLease?.hostname ?? null,
						nextLease?.machineId ?? null,
						now,
						spend,
						spend,
						changed ? "unverified" : "active",
						changed ? "reporting_changed" : reservation,
						expected.sessionId,
						expected.openingEntryId,
						expected.revision,
						expected.generation,
						expected.leaseId ?? null,
						spend,
						ORDINARY_WORK_MAX_CONTINUATIONS,
						continuation ? 1 : 0,
						lease.id,
						lease.pid,
					);
				return row && !changed ? decodedRecord(row) : undefined;
			},
			"Ordinary work claim",
		);
	}

	checkpoint(
		expected: OrdinaryWorkRecord,
		input: {
			readonly status: OrdinaryWorkStatus;
			readonly frontierEntryId: string;
			readonly reason?: string;
			readonly reporting?: OrdinaryReportingRequirements;
		},
		now: number,
	): OrdinaryWorkRecord | undefined {
		return withSqliteTransaction(
			this.database,
			() => {
				const changed = ordinaryReportingChangedAtSettlement(input.status, input.reporting);
				const row = this.database
					.prepare(`UPDATE ordinary_work SET status = ?, frontier_entry_id = ?, reason = ?,
					updated_at = ?, revision = revision + 1, lease_id = NULL, lease_pid = NULL,
					lease_start_time = NULL, lease_hostname = NULL, lease_machine_id = NULL
					WHERE session_id = ? AND opening_entry_id = ? AND revision = ? AND generation = ?
					AND status NOT IN ('fulfilled', 'cancelled') AND lease_id IS ? RETURNING *`)
					.get(
						changed ? "unverified" : input.status,
						input.frontierEntryId,
						changed ? "reporting_changed" : (input.reason?.slice(0, 512) ?? null),
						now,
						expected.sessionId,
						expected.openingEntryId,
						expected.revision,
						expected.generation,
						expected.leaseId ?? null,
					);
				return row ? decodedRecord(row) : undefined;
			},
			"Ordinary work checkpoint",
		);
	}

	addOwnerInput(expected: OrdinaryWorkRecord, entryId: string, now: number): OrdinaryWorkRecord | undefined {
		const row = this.database
			.prepare(`UPDATE ordinary_work SET frontier_entry_id = ?,
			generation = generation + 1, revision = revision + 1, updated_at = ?, reason = NULL
			WHERE session_id = ? AND opening_entry_id = ? AND revision = ? AND generation = ?
			AND status = 'active' AND lease_id IS ? RETURNING *`)
			.get(
				entryId,
				now,
				expected.sessionId,
				expected.openingEntryId,
				expected.revision,
				expected.generation,
				expected.leaseId ?? null,
			);
		return row ? decodedRecord(row) : undefined;
	}

	beginReview(expected: OrdinaryWorkRecord, now: number): OrdinaryWorkRecord | undefined {
		const row = this.database
			.prepare(`UPDATE ordinary_work SET reason = 'stop_review_in_progress',
			revision = revision + 1, updated_at = ? WHERE session_id = ? AND opening_entry_id = ?
			AND revision = ? AND generation = ? AND lease_id IS ?
			AND status = 'active' AND (reason IS NULL OR reason != 'stop_review_in_progress') RETURNING *`)
			.get(
				now,
				expected.sessionId,
				expected.openingEntryId,
				expected.revision,
				expected.generation,
				expected.leaseId ?? null,
			);
		return row ? decodedRecord(row) : undefined;
	}
}
