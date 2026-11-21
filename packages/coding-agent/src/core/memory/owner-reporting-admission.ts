/** One-time semantic subtype admission for exact current owner-confirmed memory, before request composition. */

import { isDeepStrictEqual } from "node:util";
import { strictCanonicalDigest, withoutUndefinedMembers } from "../steering/canonical.ts";
import { withinPlanRequestBound } from "../system-one/plan-request-bound.ts";
import type {
	ReportingRequirementAdmission,
	ReportingRequirementClassification,
	ReportingRequirementClassifier,
} from "../system-one/reporting-requirement-admission.ts";
import { isReportingKnowledgeKind, type KnowledgeRecord, OWNER_COMMAND_SOURCE_PREFIX } from "./knowledge-record.ts";
import type { OwnerPreferenceAttestationStore } from "./owner-preference-attestations.ts";
import { ownerPreferenceAttestation } from "./owner-preference-attestations.ts";

export function ownerConfirmedKnowledge(record: KnowledgeRecord): boolean {
	return (
		isReportingKnowledgeKind(record.kind) &&
		record.basis === "explicit" &&
		record.citations.some(
			(citation) =>
				citation.sourceId.startsWith(OWNER_COMMAND_SOURCE_PREFIX) ||
				citation.sourceId.startsWith(`${citation.sessionId}/`),
		)
	);
}

export const reportingKnowledgeDigest = (record: KnowledgeRecord): string =>
	strictCanonicalDigest(withoutUndefinedMembers(record));

export async function classifyOwnerReportingRequirement(
	classify: ReportingRequirementClassifier,
	input: ReportingRequirementAdmission | string,
	deadline?: AbortSignal,
): Promise<boolean | undefined> {
	try {
		return await withinPlanRequestBound(
			(signal) => classify(typeof input === "string" ? { preference: input } : input, signal),
			{ deadline, timeoutMs: 10_000 },
		);
	} catch {
		return undefined;
	}
}

export async function resolveOwnerReportingRequirement(input: {
	digest: string;
	store: OwnerPreferenceAttestationStore | undefined;
	classify: ReportingRequirementClassifier | undefined;
	evidence: ReportingRequirementAdmission;
	deadline?: AbortSignal;
}): Promise<boolean | undefined> {
	try {
		if (!input.store || !input.classify) return undefined;
		input.evidence.assertCurrent?.();
		const previous = input.store.classification(input.digest);
		if (previous !== undefined) return previous ?? undefined;
		const lease = input.store.reserveClassification(input.digest);
		if (!lease) return undefined;
		const reporting = await classifyOwnerReportingRequirement(input.classify, input.evidence, input.deadline);
		input.evidence.assertCurrent?.();
		input.store.classify(input.digest, reporting, lease);
		return reporting;
	} catch {
		return undefined;
	}
}

export function reportingAdmissionForKnowledge(
	getStore: () => OwnerPreferenceAttestationStore | undefined,
	getClassifier: () => ReportingRequirementClassifier | undefined,
) {
	return (
		record: KnowledgeRecord,
		assessment: ReportingRequirementClassification,
		signal: AbortSignal | undefined,
		assertCurrent: () => void,
	) =>
		resolveOwnerReportingRequirement({
			digest: reportingKnowledgeDigest(record),
			store: getStore(),
			classify: getClassifier(),
			evidence: { preference: record.text, assessment, assertCurrent },
			deadline: signal,
		});
}

export class OwnerReportingAdmission {
	private readonly inFlight = new Map<string, Promise<void>>();

	async prepare(input: {
		candidates: readonly { digest: string; text: string; isCurrent?(): boolean }[];
		store: OwnerPreferenceAttestationStore | undefined;
		classify: ReportingRequirementClassifier;
		isCurrent(): boolean;
	}): Promise<void> {
		const { store } = input;
		if (!store) return;
		for (const candidate of input.candidates
			.filter((candidate) => store.classification(candidate.digest) === undefined)
			.slice(0, 4)) {
			if (!input.isCurrent() || candidate.isCurrent?.() === false) return;
			if (store.classification(candidate.digest) !== undefined) continue;
			let pending = this.inFlight.get(candidate.digest);
			if (!pending) {
				pending = (async () => {
					await resolveOwnerReportingRequirement({
						store,
						digest: candidate.digest,
						classify: input.classify,
						evidence: {
							preference: candidate.text,
							assertCurrent: () => {
								if (!input.isCurrent() || candidate.isCurrent?.() === false)
									throw new Error("The approved reporting source changed");
							},
						},
					});
				})();
				this.inFlight.set(candidate.digest, pending);
			}
			try {
				await pending;
			} finally {
				this.inFlight.delete(candidate.digest);
			}
		}
	}
}

/** The owner-specific adapters supply already scope-filtered values; the classifier sees each exact value alone. */
export async function prepareOwnerReportingMemory(input: {
	admission: OwnerReportingAdmission;
	user?: import("./reporting-requirement-exposure.ts").UserPreferenceExposure;
	knowledge?: readonly KnowledgeRecord[];
	store: OwnerPreferenceAttestationStore | undefined;
	classify: ReportingRequirementClassifier;
	isCurrent(): boolean;
}): Promise<void> {
	const candidates: { digest: string; text: string; isCurrent?(): boolean }[] = [];
	for (const { preference, exposed } of input.user?.preferences ?? []) {
		if (!exposed) continue;
		if (input.store?.confirms(preference) && preference.metadata) {
			const proof = ownerPreferenceAttestation(preference.text, preference.metadata);
			if (proof)
				candidates.push({
					digest: proof.digest,
					text: preference.text,
					isCurrent: () => input.user?.isCurrent() === true && input.store?.confirms(preference) === true,
				});
		}
	}
	for (const record of input.knowledge ?? []) {
		if (ownerConfirmedKnowledge(record))
			candidates.push({ digest: reportingKnowledgeDigest(record), text: record.text });
	}
	await input.admission.prepare({ ...input, candidates });
}

/** Subtype availability never blocks the already-authorized preference transaction. */
export async function prepareOwnerPreferenceAttestation(input: {
	text: string;
	metadata: import("./user-preference-metadata.ts").UserPreferenceMetadata;
	removed: boolean;
	classify?: ReportingRequirementClassifier;
	guard?(): string | undefined;
	store?: OwnerPreferenceAttestationStore;
	signal?: AbortSignal;
}) {
	const proof = ownerPreferenceAttestation(input.text, input.metadata, input.removed);
	if (proof && !input.removed && input.classify && input.store) {
		const reporting = await resolveOwnerReportingRequirement({
			digest: proof.digest,
			store: input.store,
			classify: input.classify,
			evidence: {
				preference: input.text,
				assertCurrent: () => {
					const reason = input.guard?.();
					if (reason) throw new Error(reason);
				},
			},
			deadline: input.signal,
		});
		if (reporting !== undefined) proof.reporting = reporting;
		else
			try {
				if (input.store.classification(proof.digest) === null) proof.reporting = null;
			} catch {
				/* No durable admission proof is invented for unavailable storage. */
			}
	}
	return proof;
}

/** Binds first-verification admission to the same scoped whole-record/whole-line views used for the current request. */
export async function prepareReportingMemoryRequest(input: {
	admission: OwnerReportingAdmission;
	context: {
		reader: import("./knowledge-projection.ts").KnowledgeProjectionReader | undefined;
		scope: import("./knowledge-record.ts").KnowledgeScope;
		settings: { enabled: boolean; includeInPrompt: boolean };
		isCurrent(): boolean;
	};
	store: OwnerPreferenceAttestationStore | undefined;
	knowledge?: Pick<import("./knowledge-record.ts").KnowledgeStorePort, "snapshot" | "get">;
	classify: ReportingRequirementClassifier | undefined;
	user(): import("./reporting-requirement-exposure.ts").UserPreferenceExposure | undefined;
	budget(): import("../context/memory-prompt-budget.ts").MemoryPromptBudget;
	withheld(): boolean;
	migrate?(preferences: readonly import("./user-preference-metadata.ts").ParsedUserPreferenceLine[]): void;
}): Promise<void> {
	const { context } = input;
	if (!input.classify || input.withheld() || !context.settings.enabled || !context.settings.includeInPrompt) return;
	try {
		const budget = input.budget(),
			user = input.user();
		const projection = context.reader?.preview(context.scope, budget);
		const references = new Set(projection?.references.map((reference) => `${reference.id}:${reference.revision}`));
		const knowledge = input.knowledge
			?.snapshot(context.scope, new Date().toISOString())
			.records.filter((record) => references.has(`${record.id}:${record.revision}`));
		input.migrate?.(user?.preferences.map(({ preference }) => preference) ?? []);
		await prepareOwnerReportingMemory({
			admission: input.admission,
			user,
			knowledge,
			store: input.store,
			classify: input.classify,
			isCurrent: () =>
				context.isCurrent() &&
				!input.withheld() &&
				isDeepStrictEqual(budget, input.budget()) &&
				(projection?.isCurrent() ?? true),
		});
	} catch {
		/* Admission eligibility never prevents the original owner request. */
	}
}
