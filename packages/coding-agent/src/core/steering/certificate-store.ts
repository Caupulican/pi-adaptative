/**
 * Durable Steering Certificate Store.
 * Implements S1A-002, S1A-003, S1A-004, S1A-005, S1A-006, S1A-007, S1A-170.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SteeringCertificate } from "./types.ts";

export class SteeringCertificateStore {
	private readonly certificatesById = new Map<string, SteeringCertificate>();
	private readonly persistentPath?: string;

	constructor(persistentPath?: string) {
		this.persistentPath = persistentPath;
		if (this.persistentPath && existsSync(this.persistentPath)) {
			this.loadFromDisk();
		}
	}

	private loadFromDisk(): void {
		try {
			if (!this.persistentPath) return;
			const content = readFileSync(this.persistentPath, "utf8");
			const parsed = JSON.parse(content);
			if (Array.isArray(parsed)) {
				for (const item of parsed) {
					if (item && typeof item.certificate_id === "string") {
						this.certificatesById.set(item.certificate_id, item);
					}
				}
			}
		} catch {
			// Fail-safe load
		}
	}

	private saveToDisk(): void {
		if (!this.persistentPath) return;
		try {
			const dir = dirname(this.persistentPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			const all = Array.from(this.certificatesById.values());
			writeFileSync(this.persistentPath, JSON.stringify(all, null, 2), "utf8");
		} catch {
			// Fail-safe persistence
		}
	}

	async persist(cert: SteeringCertificate): Promise<SteeringCertificate> {
		this.certificatesById.set(cert.certificate_id, cert);
		this.saveToDisk();
		return cert;
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
	 * S1A-007: Stale certificate if state digest or evidence revision does not match.
	 */
	findCurrent(
		objectiveId: string,
		checkpointId: string,
		stateDigest: string,
		evidenceRevision: number,
	): SteeringCertificate | undefined {
		for (const cert of this.certificatesById.values()) {
			if (
				cert.objective_id === objectiveId &&
				cert.checkpoint_id === checkpointId &&
				cert.state_digest === stateDigest &&
				cert.evidence_revision === evidenceRevision
			) {
				return cert;
			}
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
