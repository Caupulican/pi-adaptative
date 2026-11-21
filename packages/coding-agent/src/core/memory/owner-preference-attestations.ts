/** Durable proof of owner admission, separate from editable USER.md metadata and prompt guidance. */
import { createHash, randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../context/sqlite-database.ts";
import type { LearningAuditRecord } from "../learning/learning-audit.ts";
import {
	isValidOwnerSourceId,
	MAX_USER_PREFERENCE_SOURCES,
	type ParsedUserPreferenceLine,
	type UserPreferenceMetadata,
} from "./user-preference-metadata.ts";

const REPORTING_ADMISSION_POLICY_VERSION = 2;

export interface OwnerPreferenceAttestation {
	id: string;
	revision: number;
	scope: string;
	digest: string;
	evidenceAt: string;
	removed: boolean;
	reporting?: boolean | null;
}

export function ownerPreferenceAttestation(
	text: string,
	metadata: UserPreferenceMetadata,
	removed = false,
): OwnerPreferenceAttestation | undefined {
	if (metadata.basis !== "explicit" || !metadata.evidenceAt || !metadata.sources.length) return undefined;
	const scope = metadata.scope.kind === "global" ? "global" : `project=${metadata.scope.projectKey}`;
	return {
		id: metadata.id,
		revision: metadata.revision,
		scope,
		evidenceAt: metadata.evidenceAt,
		removed,
		digest: createHash("sha256")
			.update(
				JSON.stringify([
					text,
					metadata.id,
					metadata.revision,
					scope,
					metadata.evidenceAt,
					metadata.sources.filter(isValidOwnerSourceId).slice(0, MAX_USER_PREFERENCE_SOURCES),
					removed,
				]),
			)
			.digest("hex"),
	};
}

export function isOwnerPreferenceAttestation(value: unknown): value is OwnerPreferenceAttestation {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		/^[a-f0-9]{8}$/.test(record.id) &&
		Number.isSafeInteger(record.revision) &&
		(record.revision as number) > 0 &&
		typeof record.scope === "string" &&
		/^(global|project=[a-f0-9]{8,64})$/.test(record.scope) &&
		typeof record.digest === "string" &&
		/^[a-f0-9]{64}$/.test(record.digest) &&
		typeof record.evidenceAt === "string" &&
		Number.isFinite(Date.parse(record.evidenceAt)) &&
		typeof record.removed === "boolean" &&
		(record.reporting === undefined || record.reporting === null || typeof record.reporting === "boolean")
	);
}

export function initializeOwnerPreferenceAttestations(database: SqliteDatabase): void {
	database.exec(`CREATE TABLE IF NOT EXISTS owner_preference_attestations (
		id TEXT NOT NULL, scope TEXT NOT NULL, revision INTEGER NOT NULL,
		digest TEXT NOT NULL, evidence_at TEXT NOT NULL, removed INTEGER NOT NULL,
		PRIMARY KEY (id, scope)
	); CREATE TABLE IF NOT EXISTS owner_reporting_classifications (digest TEXT PRIMARY KEY, reporting INTEGER, policy_version INTEGER NOT NULL DEFAULT ${REPORTING_ADMISSION_POLICY_VERSION}, lease_id TEXT)`);
	const columns = new Set(
		database
			.prepare("PRAGMA table_info(owner_reporting_classifications)")
			.all()
			.map((row) => row.name),
	);
	if (!columns.has("policy_version"))
		database.exec("ALTER TABLE owner_reporting_classifications ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 1");
	if (!columns.has("lease_id")) database.exec("ALTER TABLE owner_reporting_classifications ADD COLUMN lease_id TEXT");
	database.exec(
		"CREATE INDEX IF NOT EXISTS owner_reporting_positive ON owner_reporting_classifications(digest) WHERE reporting=1",
	);
}

export class OwnerPreferenceAttestationStore {
	private readonly database: SqliteDatabase;
	constructor(database: SqliteDatabase) {
		this.database = database;
	}

	/** Only terminal successful admission receipts can install or revoke a proof. Older replays cannot restore it. */
	observe(receipt: LearningAuditRecord): void {
		const proof = receipt.ownerPreference;
		if (receipt.action !== "apply" || receipt.reasonCode !== "explicit_owner_preference" || !proof) return;
		if (!isOwnerPreferenceAttestation(proof)) throw new Error("Invalid owner preference admission proof");
		this.database
			.prepare(`INSERT INTO owner_preference_attestations
			(id,scope,revision,digest,evidence_at,removed) VALUES (?,?,?,?,?,?)
			ON CONFLICT(id,scope) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,
			evidence_at=excluded.evidence_at,removed=excluded.removed
			WHERE excluded.evidence_at > owner_preference_attestations.evidence_at`)
			.run(proof.id, proof.scope, proof.revision, proof.digest, proof.evidenceAt, Number(proof.removed));
		if (proof.reporting !== undefined) this.classify(proof.digest, proof.reporting ?? undefined);
	}

	reserveClassification(digest: string): string | undefined {
		if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid owner reporting identity");
		const lease = randomUUID();
		this.database
			.prepare(`INSERT INTO owner_reporting_classifications (digest,reporting,policy_version,lease_id)
			VALUES (?,NULL,${REPORTING_ADMISSION_POLICY_VERSION},?) ON CONFLICT(digest) DO UPDATE SET policy_version=${REPORTING_ADMISSION_POLICY_VERSION},lease_id=excluded.lease_id
			WHERE owner_reporting_classifications.reporting IS NULL AND owner_reporting_classifications.policy_version<${REPORTING_ADMISSION_POLICY_VERSION}`)
			.run(digest, lease);
		return this.database.prepare("SELECT lease_id FROM owner_reporting_classifications WHERE digest=?").get(digest)
			?.lease_id === lease
			? lease
			: undefined;
	}

	classify(digest: string, reporting: boolean | undefined, lease?: string): void {
		if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid owner reporting identity");
		if (lease)
			this.database
				.prepare(
					"UPDATE owner_reporting_classifications SET reporting=?,lease_id=NULL WHERE digest=? AND lease_id=? AND reporting IS NULL",
				)
				.run(reporting === undefined ? null : Number(reporting), digest, lease);
		else
			this.database
				.prepare(
					`INSERT OR IGNORE INTO owner_reporting_classifications (digest,reporting,policy_version) VALUES (?,?,${REPORTING_ADMISSION_POLICY_VERSION})`,
				)
				.run(digest, reporting === undefined ? null : Number(reporting));
	}

	classification(digest: string): boolean | null | undefined {
		const row = this.database
			.prepare("SELECT reporting,policy_version FROM owner_reporting_classifications WHERE digest=?")
			.get(digest);
		if (!row || (row.reporting === null && Number(row.policy_version) < REPORTING_ADMISSION_POLICY_VERSION))
			return undefined;
		return row.reporting === null ? null : row.reporting === 1;
	}

	hasReportingPreferences(projectKey?: string): boolean {
		return (
			this.database
				.prepare(`SELECT 1 AS found FROM owner_preference_attestations AS p
			JOIN owner_reporting_classifications AS c ON c.digest=p.digest
			WHERE p.removed=0 AND c.reporting=1 AND (p.scope='global' OR p.scope=?) LIMIT 1`)
				.get(`project=${projectKey ?? ""}`) !== undefined
		);
	}

	hasPositiveClassification(): boolean {
		return (
			this.database.prepare("SELECT 1 FROM owner_reporting_classifications WHERE reporting=1 LIMIT 1").get() !==
			undefined
		);
	}

	captureReportingProofs(candidates: { user: OwnerPreferenceAttestation[] } | { knowledge: string[] }) {
		const user = "user" in candidates;
		const identities = user ? candidates.user : candidates.knowledge;
		const confirmed = new Set<string>();
		if (identities.length === 0) return { confirmed, isCurrent: () => true };
		const statement = this.database.prepare(
			user
				? `SELECT DISTINCT c.digest FROM json_each(?) AS e CROSS JOIN owner_preference_attestations AS p
					ON p.id=json_extract(e.value,'$.id') AND p.scope=json_extract(e.value,'$.scope')
					AND p.revision=json_extract(e.value,'$.revision') AND p.digest=json_extract(e.value,'$.digest') AND p.removed=0
					CROSS JOIN owner_reporting_classifications AS c ON c.digest=p.digest AND c.reporting=1`
				: `SELECT DISTINCT c.digest FROM json_each(?) AS e CROSS JOIN owner_reporting_classifications AS c ON c.digest=e.value AND c.reporting=1`,
		);
		const encoded = JSON.stringify(identities);
		for (const row of statement.all(encoded)) confirmed.add(String(row.digest));
		return {
			confirmed,
			isCurrent: () => {
				const rows = statement.all(encoded);
				return rows.length === confirmed.size && rows.every((row) => confirmed.has(String(row.digest)));
			},
		};
	}

	confirms(preference: ParsedUserPreferenceLine): boolean {
		const proof = preference.metadata && ownerPreferenceAttestation(preference.text, preference.metadata);
		if (!proof) return false;
		const row = this.database
			.prepare("SELECT digest,revision,removed FROM owner_preference_attestations WHERE id=? AND scope=?")
			.get(proof.id, proof.scope);
		return row?.digest === proof.digest && row.revision === proof.revision && row.removed === 0;
	}
}
