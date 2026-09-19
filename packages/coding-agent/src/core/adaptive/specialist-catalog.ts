/**
 * Specialist Catalog.
 * Registry of known specialists, pre-authored roles, and dynamically synthesized specialists.
 * Implements S1A-180, S1A-181, S1A-196.
 */

import type { SpecialistCognitiveRequirements, SpecialistLifetime, SpecialistRecord, SpecialistSpec } from "./types.ts";

export interface SpecialistCatalogEntry {
	readonly specialistId: string;
	readonly specialties: readonly string[];
	readonly authorityRole: string;
	readonly purpose: string;
	readonly cognitiveRequirements: SpecialistCognitiveRequirements;
	readonly lifetime: SpecialistLifetime;
	readonly verifiedOutcomeCount: number;
	readonly spec?: SpecialistSpec;
	readonly record?: SpecialistRecord;
}

export class SpecialistCatalog {
	private readonly entries = new Map<string, SpecialistCatalogEntry>();
	private catalogRevision = 1;

	constructor() {
		this.seedStandardRoles();
	}

	private seedStandardRoles(): void {
		const standards: SpecialistCatalogEntry[] = [
			{
				specialistId: "generic_implementer",
				specialties: ["code_implementation", "bug_fix"],
				authorityRole: "implementer",
				purpose: "General software implementation and code editing",
				cognitiveRequirements: {
					reasoning: "medium",
					vision: false,
					long_context: true,
					tool_calling: true,
				},
				lifetime: "global",
				verifiedOutcomeCount: 10,
			},
			{
				specialistId: "generic_verifier",
				specialties: ["verification", "test_execution", "review"],
				authorityRole: "verifier",
				purpose: "Independent verification and automated test execution",
				cognitiveRequirements: {
					reasoning: "medium",
					vision: false,
					long_context: false,
					tool_calling: true,
				},
				lifetime: "global",
				verifiedOutcomeCount: 10,
			},
			{
				specialistId: "generic_explorer",
				specialties: ["repo_exploration", "codebase_search"],
				authorityRole: "explorer",
				purpose: "Read-only exploration and evidence gathering",
				cognitiveRequirements: {
					reasoning: "low",
					vision: false,
					long_context: true,
					tool_calling: true,
				},
				lifetime: "global",
				verifiedOutcomeCount: 10,
			},
		];

		for (const entry of standards) {
			this.entries.set(entry.specialistId, entry);
		}
	}

	revision(): number {
		return this.catalogRevision;
	}

	listAll(): readonly SpecialistCatalogEntry[] {
		return Array.from(this.entries.values());
	}

	get(specialistId: string): SpecialistCatalogEntry | undefined {
		return this.entries.get(specialistId);
	}

	searchBySpecialties(specialties: readonly string[]): readonly SpecialistCatalogEntry[] {
		const targetSet = new Set(specialties.map((s) => s.toLowerCase()));
		return this.listAll().filter((entry) => entry.specialties.some((s) => targetSet.has(s.toLowerCase())));
	}

	registerSpecialist(spec: SpecialistSpec, record?: SpecialistRecord): void {
		const entry: SpecialistCatalogEntry = {
			specialistId: spec.specialist_id,
			specialties: [...spec.specialties],
			authorityRole: spec.authority_role,
			purpose: spec.purpose,
			cognitiveRequirements: spec.cognitive_requirements,
			lifetime: spec.lifetime,
			verifiedOutcomeCount: record?.success_count ?? 1,
			spec,
			record,
		};
		this.entries.set(spec.specialist_id, entry);
		this.catalogRevision += 1;
	}

	compactSummary(): readonly Record<string, unknown>[] {
		return this.listAll().map((entry) => ({
			id: entry.specialistId,
			role: entry.authorityRole,
			specialties: entry.specialties,
			purpose: entry.purpose,
			vision: entry.cognitiveRequirements.vision,
			lifetime: entry.lifetime,
		}));
	}
}
