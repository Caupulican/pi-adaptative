/** Reuses exact historical owner admission evidence; never promotes editable note labels by themselves. */
import type { LearningAuditRecord } from "../learning/learning-audit.ts";
import { locateOwnerQuote, type OwnerEvidenceEntry } from "../learning/owner-evidence-ledger.ts";
import { type OwnerPreferenceAttestationStore, ownerPreferenceAttestation } from "./owner-preference-attestations.ts";
import type { ParsedUserPreferenceLine } from "./user-preference-metadata.ts";

export function migrateOwnerPreferenceProofs(input: {
	preferences: readonly ParsedUserPreferenceLine[];
	audits: readonly LearningAuditRecord[];
	originals: readonly OwnerEvidenceEntry[];
	store: OwnerPreferenceAttestationStore;
}): void {
	for (const preference of input.preferences) {
		const metadata = preference.metadata;
		const proof = metadata && ownerPreferenceAttestation(preference.text, metadata);
		if (!metadata || !proof || input.store.confirms(preference)) continue;
		const audit = input.audits.find(
			(record) =>
				record.action === "apply" &&
				record.reasonCode === "explicit_owner_preference" &&
				record.proposalId === `user-pref-${metadata.id}-r${metadata.revision}` &&
				record.rollback?.target === preference.text,
		);
		if (!audit) continue;
		if (audit.ownerPreference) {
			if (audit.ownerPreference.digest === proof.digest) input.store.observe(audit);
			continue;
		}
		// Old receipts omitted scope. Only an exact original owner statement naming that scope can restore it.
		if (metadata.scope.kind !== "global") continue;
		const statement = `Remember globally: ${preference.text}`;
		const sources = metadata.sources.map((id) => input.originals.find((source) => source.sourceId === id));
		if (
			sources.some((source) => !source) ||
			!sources.some((source) => {
				if (!source || source.createdAt !== proof.evidenceAt) return false;
				const quote = locateOwnerQuote(source, statement);
				return quote.found && !quote.shown;
			})
		)
			continue;
		input.store.observe({ ...audit, ownerPreference: proof });
	}
}

export function createOwnerPreferenceProofMigration(source: {
	audits(): readonly LearningAuditRecord[];
	originals(): readonly OwnerEvidenceEntry[];
}) {
	return (
		preferences: readonly ParsedUserPreferenceLine[],
		store: OwnerPreferenceAttestationStore | undefined,
	): void => {
		if (store && preferences.length)
			migrateOwnerPreferenceProofs({ preferences, store, audits: source.audits(), originals: source.originals() });
	};
}
