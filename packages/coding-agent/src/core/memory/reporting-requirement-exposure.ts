/** Narrows accepted memory to current owner-confirmed values that an admitted request actually exposed. */
import type { OrdinaryReportingRequirements } from "../ordinary-work-policy.ts";
import type { KnowledgeProjection } from "./knowledge-projection.ts";
import {
	isReportingKnowledgeKind,
	type KnowledgeRecord,
	type KnowledgeRecordSnapshot,
	type KnowledgeScope,
	type KnowledgeStorePort,
	MAX_KNOWLEDGE_PAGE_SIZE,
} from "./knowledge-record.ts";
import type { OwnerPreferenceAttestationStore } from "./owner-preference-attestations.ts";
import { ownerPreferenceAttestation } from "./owner-preference-attestations.ts";
import { ownerConfirmedKnowledge, reportingKnowledgeDigest } from "./owner-reporting-admission.ts";
import { type ParsedUserPreferenceLine, renderUserPreferenceForPrompt } from "./user-preference-metadata.ts";

export interface UserPreferenceExposure {
	preferences: readonly { preference: ParsedUserPreferenceLine; exposed: boolean }[];
	complete: boolean;
	projectKey?: string;
	isCurrent(): boolean;
}

export function projectUserPreferenceExposure(
	entries: readonly { parsed: ParsedUserPreferenceLine; section?: string }[],
	rendered: string,
	complete: boolean,
	isCurrent: () => boolean,
	projectKey?: string,
): UserPreferenceExposure {
	const lines = new Set(rendered.split("\n"));
	return {
		complete,
		projectKey,
		isCurrent,
		preferences: entries
			.filter(({ parsed }) => parsed.metadata?.basis === "explicit")
			.map(({ parsed, section }) => ({
				preference: parsed,
				exposed: lines.has(renderUserPreferenceForPrompt(parsed, section)),
			})),
	};
}

export const NO_REPORTING_REQUIREMENTS: OrdinaryReportingRequirements = {
	requirements: [],
	complete: true,
	isCurrent: () => true,
};

export const UNKNOWN_REPORTING_REQUIREMENTS: OrdinaryReportingRequirements = {
	requirements: [],
	complete: false,
	isCurrent: () => false,
};

export class ReportingRequirementExposure {
	private snapshot: OrdinaryReportingRequirements = UNKNOWN_REPORTING_REQUIREMENTS;
	private knowledge:
		| {
				projection: KnowledgeProjection;
				store: Pick<KnowledgeStorePort, "snapshot" | "list" | "revision">;
				attestations: OwnerPreferenceAttestationStore | undefined;
				scope: KnowledgeScope;
				snapshot: OrdinaryReportingRequirements;
		  }
		| undefined;
	projectKnowledge(
		exposed: boolean,
		projection: KnowledgeProjection | undefined,
		store: Pick<KnowledgeStorePort, "snapshot" | "list" | "revision"> | undefined,
		scope: KnowledgeScope,
		getAttestations?: () => OwnerPreferenceAttestationStore | undefined,
	): OrdinaryReportingRequirements {
		const cached = this.knowledge;
		this.knowledge = undefined;
		return safelyProjectReportingRequirements(exposed, () => {
			const attestations = getAttestations?.();
			if (
				cached &&
				cached.projection === projection &&
				cached.store === store &&
				cached.attestations === attestations &&
				cached.scope.project === scope.project &&
				cached.scope.role === scope.role &&
				cached.scope.audience === scope.audience &&
				cached.snapshot.isCurrent()
			) {
				this.knowledge = cached;
				return cached.snapshot;
			}
			const snapshot = knowledgeReportingRequirements(projection, store, scope, attestations);
			if (projection && store) this.knowledge = { projection, store, attestations, scope: { ...scope }, snapshot };
			return snapshot;
		});
	}

	publish(snapshot: OrdinaryReportingRequirements, requestCurrent?: () => boolean): void {
		if (this.knowledge?.snapshot !== snapshot) this.knowledge = undefined;
		this.snapshot = requestCurrent
			? { ...snapshot, isCurrent: () => requestCurrent() && snapshot.isCurrent() }
			: snapshot;
	}
	clear(): void {
		this.knowledge = undefined;
		this.snapshot = UNKNOWN_REPORTING_REQUIREMENTS;
	}
	current(): OrdinaryReportingRequirements {
		try {
			if (this.snapshot.isCurrent()) return this.snapshot;
		} catch {
			/* Closed or unavailable stores are not current evidence. */
		}
		this.clear();
		return this.snapshot;
	}
}

export function safelyProjectReportingRequirements(
	exposed: boolean,
	project: () => OrdinaryReportingRequirements,
): OrdinaryReportingRequirements {
	if (!exposed) return NO_REPORTING_REQUIREMENTS;
	try {
		return project();
	} catch {
		return UNKNOWN_REPORTING_REQUIREMENTS;
	}
}

function unavailableReportingSource(hasProof: () => boolean | undefined): OrdinaryReportingRequirements {
	const stillEmpty = () => hasProof() === false;
	return stillEmpty() ? { ...NO_REPORTING_REQUIREMENTS, isCurrent: stillEmpty } : UNKNOWN_REPORTING_REQUIREMENTS;
}

export function userReportingRequirements(
	exposure: UserPreferenceExposure | undefined,
	store: OwnerPreferenceAttestationStore | undefined,
	projectKey?: string,
): OrdinaryReportingRequirements {
	if (!exposure)
		return unavailableReportingSource(() =>
			projectKey ? store?.hasReportingPreferences(projectKey) : store?.hasPositiveClassification(),
		);
	if (!store && (!exposure.complete || exposure.preferences.length > 0)) return UNKNOWN_REPORTING_REQUIREMENTS;
	const candidates = exposure.preferences.flatMap((entry) => {
		const metadata = entry.preference.metadata;
		const proof = metadata && ownerPreferenceAttestation(entry.preference.text, metadata);
		return proof ? [{ entry, proof }] : [];
	});
	const proofs = store?.captureReportingProofs({ user: candidates.map(({ proof }) => proof) });
	const confirmed = candidates.filter(({ proof }) => proofs?.confirmed.has(proof.digest)).map(({ entry }) => entry);
	const accounted = () => exposure.complete || store?.hasReportingPreferences(exposure.projectKey) === false;
	return {
		requirements: confirmed
			.filter(({ exposed }) => exposed)
			.map(({ preference }) => ({
				id: `user:${preference.metadata!.id}:${preference.metadata!.revision}`,
				text: preference.text,
			})),
		complete: confirmed.every(({ exposed }) => exposed) && accounted(),
		isCurrent: () => exposure.isCurrent() && (proofs?.isCurrent() ?? true) && accounted(),
	};
}

export function knowledgeReportingRequirements(
	projection: KnowledgeProjection | undefined,
	store: Pick<KnowledgeStorePort, "snapshot" | "list" | "revision"> | undefined,
	scope: KnowledgeScope,
	attestations?: OwnerPreferenceAttestationStore,
): OrdinaryReportingRequirements {
	const hasAnyProof = () => attestations?.hasPositiveClassification();
	if (!store) return unavailableReportingSource(hasAnyProof);
	const at = new Date().toISOString();
	let snapshot: KnowledgeRecordSnapshot;
	try {
		snapshot = store.snapshot(scope, at);
	} catch {
		return unavailableReportingSource(hasAnyProof);
	}
	const { revision, refreshAt } = snapshot;
	const current = () => {
		const now = new Date().toISOString();
		return (
			store.revision() === revision &&
			now >= at &&
			(refreshAt === undefined || now < refreshAt) &&
			(projection?.isCurrent() ?? true)
		);
	};
	const capture = (): OrdinaryReportingRequirements => {
		const exposed = new Set(projection?.references.map((reference) => `${reference.id}:${reference.revision}`));
		const candidates: { digest: string; requirement?: OrdinaryReportingRequirements["requirements"][number] }[] = [];
		const collect = (record: KnowledgeRecord) => {
			if (
				!ownerConfirmedKnowledge(record) ||
				record.validFrom > at ||
				(record.validUntil !== undefined && record.validUntil <= at)
			)
				return;
			candidates.push({
				digest: reportingKnowledgeDigest(record),
				...(exposed.has(`${record.id}:${record.revision}`)
					? { requirement: { id: `knowledge:${record.id}:${record.revision}`, text: record.text } }
					: {}),
			});
		};
		try {
			const overflow = snapshot.possiblyMore.filter(isReportingKnowledgeKind);
			for (const record of snapshot.records) if (!overflow.includes(record.kind)) collect(record);
			for (const kind of overflow) {
				let after: string | undefined;
				for (;;) {
					const page = store.list(scope, { kind, after, limit: MAX_KNOWLEDGE_PAGE_SIZE });
					if (store.revision() !== revision) return UNKNOWN_REPORTING_REQUIREMENTS;
					for (const record of page) collect(record);
					if (page.length < MAX_KNOWLEDGE_PAGE_SIZE) break;
					after = page[page.length - 1]!.id;
				}
			}
			if (!current()) return UNKNOWN_REPORTING_REQUIREMENTS;
			if (!attestations && candidates.length > 0) return UNKNOWN_REPORTING_REQUIREMENTS;
			const proofs = attestations?.captureReportingProofs({ knowledge: candidates.map(({ digest }) => digest) });
			const confirmed = candidates.filter(({ digest }) => proofs?.confirmed.has(digest));
			return {
				requirements: confirmed.flatMap(({ requirement }) => (requirement ? [requirement] : [])),
				complete: confirmed.every(({ requirement }) => requirement !== undefined),
				isCurrent: () => current() && (proofs?.isCurrent() ?? true),
			};
		} catch {
			return UNKNOWN_REPORTING_REQUIREMENTS;
		}
	};
	if (hasAnyProof() === false) {
		let resolved: OrdinaryReportingRequirements | undefined;
		return {
			...NO_REPORTING_REQUIREMENTS,
			isCurrent: () => {
				if (!current()) return false;
				if (hasAnyProof() === false) return true;
				resolved ??= capture();
				return resolved.complete && resolved.requirements.length === 0 && resolved.isCurrent();
			},
		};
	}
	return capture();
}
