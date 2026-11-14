/**
 * Durable Steering Certificate Store.
 * Implements S1A-002..S1A-007, S1A-170, PH-020..PH-028.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { isWorkerSession } from "../session-role.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { canonicalJson } from "./canonical.ts";
import type { CertificateLookupQuery, SteeringCertificate } from "./types.ts";

export class SteeringCertificateStoreError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, { cause });
		this.name = "SteeringCertificateStoreError";
	}
}

export function isValidCertificateRecord(item: unknown): item is SteeringCertificate {
	if (!item || typeof item !== "object") return false;
	const c = item as Record<string, unknown>;
	return (
		typeof c.certificate_id === "string" &&
		typeof c.objective_id === "string" &&
		typeof c.checkpoint_id === "string" &&
		typeof c.state_digest === "string" &&
		typeof c.evidence_revision === "number" &&
		c.answers !== null &&
		typeof c.answers === "object" &&
		typeof c.directive === "string" &&
		c.policy !== null &&
		typeof c.policy === "object" &&
		c.question_pack !== null &&
		typeof c.question_pack === "object" &&
		c.engine !== null &&
		typeof c.engine === "object"
	);
}

/**
 * Certificates retained per store. The file lives per agent directory across sessions and is
 * rewritten whole on every persist, so an unbounded map grows every session for the life of the
 * install and each persist costs the whole history. A certificate is a cache of a judgment: an
 * evicted one is re-evaluated, never assumed, so eviction is fail-closed.
 */
export const MAX_RETAINED_CERTIFICATES = 512;

export class SteeringCertificateStore {
	private readonly certificatesById = new Map<string, SteeringCertificate>();
	readonly persistentPath?: string;
	/** Zero-footprint: a worker session reads the shared store but never rewrites it. */
	private readonly readOnly: boolean;

	constructor(persistentPath?: string, options?: { readOnly?: boolean }) {
		this.persistentPath = persistentPath;
		this.readOnly = options?.readOnly ?? isWorkerSession();
		if (this.persistentPath && existsSync(this.persistentPath)) {
			this.loadFromDisk();
		}
	}

	hasDurableBackend(): boolean {
		return Boolean(this.persistentPath);
	}

	private loadFromDisk(): void {
		if (!this.persistentPath) return;
		try {
			for (const item of this.readDisk(this.persistentPath)) this.certificatesById.set(item.certificate_id, item);
			this.evictBeyondBound();
		} catch (err) {
			throw new SteeringCertificateStoreError(`Failed to load certificates from ${this.persistentPath}`, err);
		}
	}

	private readDisk(path: string): SteeringCertificate[] {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return Array.isArray(parsed) ? parsed.filter(isValidCertificateRecord) : [];
	}

	/**
	 * Rewrites the file under its lock from what it holds now plus this store's certificates: every session (a root, a
	 * bot's session, another process) keeps its own store on the one file, so a rewrite from this store alone would drop
	 * what the others persisted since it loaded. A file that does not parse is replaced (a certificate is a cache: a lost
	 * one is evaluated again).
	 */
	private saveToDisk(): void {
		const path = this.persistentPath;
		if (!path || this.readOnly) return;
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		try {
			withFileLockSync(path, () => {
				let onDisk: SteeringCertificate[] = [];
				try {
					if (existsSync(path)) onDisk = this.readDisk(path);
				} catch {
					onDisk = [];
				}
				const merged = new Map(onDisk.map((cert) => [cert.certificate_id, cert] as const));
				for (const [id, cert] of this.certificatesById) merged.set(id, cert);
				this.certificatesById.clear();
				for (const [id, cert] of merged) this.certificatesById.set(id, cert);
				this.evictBeyondBound();
				writeFileAtomicSync(path, canonicalJson(Array.from(this.certificatesById.values())));
			});
		} catch (err) {
			throw new SteeringCertificateStoreError(`Failed atomic persistence of steering certificates to ${path}`, err);
		}
	}

	async persist(cert: SteeringCertificate): Promise<SteeringCertificate> {
		if (!isValidCertificateRecord(cert)) {
			const certId = (cert as unknown as Record<string, unknown>)?.certificate_id ?? "unknown";
			throw new SteeringCertificateStoreError(`Cannot persist invalid certificate: ${certId}`);
		}
		this.certificatesById.set(cert.certificate_id, cert);
		this.evictBeyondBound();
		this.saveToDisk();
		return cert;
	}

	/** Oldest first (Map insertion order); a re-persisted id keeps its original position. */
	private evictBeyondBound(): void {
		while (this.certificatesById.size > MAX_RETAINED_CERTIFICATES) {
			const oldest = this.certificatesById.keys().next().value;
			if (oldest === undefined) return;
			this.certificatesById.delete(oldest);
		}
	}

	get(certificateId: string): SteeringCertificate | undefined {
		return this.certificatesById.get(certificateId);
	}

	listForObjective(objectiveId: string): readonly SteeringCertificate[] {
		const results: SteeringCertificate[] = [];
		for (const cert of this.certificatesById.values()) {
			if (cert.objective_id === objectiveId) {
				results.push(cert);
			}
		}
		return results;
	}

	/**
	 * Finds current valid certificate for an objective, checkpoint, stateDigest, and evidenceRevision.
	 * S1A-007, PH-024..PH-028: Binds state digest, evidence revision, policy digest, program digest, and exact model.
	 */
	findCurrent(
		queryOrObjectiveId: CertificateLookupQuery | string,
		checkpointId?: string,
		stateDigest?: string,
		evidenceRevision?: number,
		options?: {
			policyDigest?: string;
			programDigest?: string;
			provider?: string;
			model?: string;
		},
	): SteeringCertificate | undefined {
		let query: CertificateLookupQuery;
		if (typeof queryOrObjectiveId === "object") {
			query = queryOrObjectiveId;
		} else {
			query = {
				objectiveId: queryOrObjectiveId,
				checkpointId: checkpointId ?? "",
				stateDigest: stateDigest ?? "",
				evidenceRevision: evidenceRevision ?? 0,
				policyDigest: options?.policyDigest,
				programDigest: options?.programDigest,
				provider: options?.provider,
				model: options?.model,
			};
		}

		for (const cert of this.certificatesById.values()) {
			if (cert.objective_id !== query.objectiveId) continue;
			if (cert.checkpoint_id !== query.checkpointId) continue;
			if (cert.state_digest !== query.stateDigest) continue;
			if (cert.evidence_revision !== query.evidenceRevision) continue;

			if (query.policyDigest && cert.policy.digest !== query.policyDigest) {
				continue;
			}
			if (query.programDigest && cert.question_pack.digest !== query.programDigest) {
				continue;
			}
			if (query.provider && cert.engine.provider !== query.provider) {
				continue;
			}
			if (query.model && cert.engine.model !== query.model) {
				continue;
			}

			return cert;
		}
		return undefined;
	}

	/**
	 * Asserts whether a certificate is valid and fresh for the given state and revision.
	 */
	isValid(cert: SteeringCertificate, currentStateDigest: string, currentEvidenceRevision: number): boolean {
		return cert.state_digest === currentStateDigest && cert.evidence_revision === currentEvidenceRevision;
	}

	/**
	 * Returns all certificates matching a checkpoint ID for an objective.
	 */
	findByCheckpoint(objectiveId: string, checkpointId: string): readonly SteeringCertificate[] {
		return this.listForObjective(objectiveId).filter((c) => c.checkpoint_id === checkpointId);
	}

	clear(): void {
		this.certificatesById.clear();
	}
}
