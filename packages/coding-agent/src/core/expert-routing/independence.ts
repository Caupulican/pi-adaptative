/**
 * Team Independence Validator.
 * Enforces strict diversity and independence constraints across team bindings.
 * Implements DIVERSITY_AND_INDEPENDENCE.md and HM11-040 through HM11-044.
 */

import type { ExpertBinding, ExpertIndependenceLevel } from "./contracts.ts";

export interface IndependenceValidationResult {
	readonly valid: boolean;
	readonly reason?: string;
}

export type ModelFamilyResolver = (modelId: string, provider: string) => string | undefined;

/**
 * Built-in heuristic model family resolver for well-known providers.
 */
export function defaultModelFamilyResolver(modelId: string, provider: string): string | undefined {
	const lower = modelId.toLowerCase();
	if (provider === "anthropic" || lower.includes("claude")) {
		if (lower.includes("opus")) return "claude-opus";
		if (lower.includes("sonnet")) return "claude-sonnet";
		if (lower.includes("haiku")) return "claude-haiku";
		return "claude";
	}
	if (provider === "openai" || lower.includes("gpt") || lower.startsWith("o1") || lower.startsWith("o3")) {
		if (lower.includes("gpt-4o")) return "gpt-4o";
		if (lower.startsWith("o1") || lower.startsWith("o3")) return "openai-reasoning";
		return "gpt";
	}
	if (provider === "google" || lower.includes("gemini")) {
		if (lower.includes("pro")) return "gemini-pro";
		if (lower.includes("flash")) return "gemini-flash";
		return "gemini";
	}
	if (provider === "deepseek" || lower.includes("deepseek")) {
		if (lower.includes("r1")) return "deepseek-reasoner";
		return "deepseek-chat";
	}
	if (provider === "meta" || lower.includes("llama")) {
		return "llama";
	}
	if (provider === "mistral" || lower.includes("mistral") || lower.includes("codestral")) {
		return "mistral";
	}
	return undefined;
}

export class TeamIndependenceValidator {
	private readonly familyResolver?: ModelFamilyResolver;

	constructor(familyResolver?: ModelFamilyResolver) {
		this.familyResolver = familyResolver;
	}

	static validate(
		bindings: readonly ExpertBinding[],
		level: ExpertIndependenceLevel,
		options?: {
			priorBindings?: readonly ExpertBinding[];
			modelFamilyResolver?: ModelFamilyResolver;
		},
	): IndependenceValidationResult {
		const instance = new TeamIndependenceValidator(options?.modelFamilyResolver);
		return instance.validate(bindings, level, options);
	}

	validate(
		bindings: readonly ExpertBinding[],
		level: ExpertIndependenceLevel,
		options?: {
			priorBindings?: readonly ExpertBinding[];
			modelFamilyResolver?: ModelFamilyResolver;
		},
	): IndependenceValidationResult {
		if (level === "none" || level === "fresh_context") {
			return { valid: true };
		}

		// 1. distinct_profile: role/thinking/model or profile_id cannot be identical within team
		if (level === "distinct_profile") {
			const profiles = new Set<string>();
			for (const b of bindings) {
				const key =
					b.profile_id ?? `${b.role ?? "worker"}:${b.thinking_level ?? "off"}:${b.provider}/${b.model_id}`;
				if (profiles.has(key)) {
					return {
						valid: false,
						reason: `Team contains duplicate expert profile '${key}' violating distinct_profile`,
					};
				}
				profiles.add(key);
			}
			return { valid: true };
		}

		// 2. distinct_model: team cannot share same model ID
		if (level === "distinct_model") {
			const models = new Set<string>();
			for (const b of bindings) {
				const modelRef = `${b.provider}/${b.model_id}`;
				if (models.has(modelRef) || models.has(b.model_id)) {
					return {
						valid: false,
						reason: `Team contains duplicate model '${modelRef}' violating distinct_model`,
					};
				}
				models.add(modelRef);
				models.add(b.model_id);
			}

			// If prior bindings provided (e.g. verifier verifying implementer)
			if (options?.priorBindings && options.priorBindings.length > 0) {
				for (const b of bindings) {
					for (const prior of options.priorBindings) {
						if (b.model_id === prior.model_id && b.provider === prior.provider) {
							return {
								valid: false,
								reason: `Binding model '${b.provider}/${b.model_id}' matches prior attempt model violating distinct_model`,
							};
						}
					}
				}
			}

			return { valid: true };
		}

		// 3. distinct_provider: team cannot share provider
		if (level === "distinct_provider") {
			const providers = new Set<string>();
			for (const b of bindings) {
				if (providers.has(b.provider)) {
					return {
						valid: false,
						reason: `Team contains duplicate provider '${b.provider}' violating distinct_provider`,
					};
				}
				providers.add(b.provider);
			}

			if (options?.priorBindings && options.priorBindings.length > 0) {
				for (const b of bindings) {
					for (const prior of options.priorBindings) {
						if (b.provider === prior.provider) {
							return {
								valid: false,
								reason: `Binding provider '${b.provider}' matches prior attempt provider violating distinct_provider`,
							};
						}
					}
				}
			}

			return { valid: true };
		}

		// 4. distinct_family: model family must be distinct and resolved
		if (level === "distinct_family") {
			const resolver = options?.modelFamilyResolver ?? this.familyResolver;
			if (!resolver) {
				// HM11-043: If family resolution is unsupported, return invalid; no silent downgrade!
				return {
					valid: false,
					reason:
						"Model family resolution is unsupported in current configuration; cannot enforce distinct_family",
				};
			}

			const families = new Set<string>();
			for (const b of bindings) {
				const family = resolver(b.model_id, b.provider);
				if (!family) {
					return {
						valid: false,
						reason: `Could not resolve model family for '${b.provider}/${b.model_id}'; distinct_family cannot be validated`,
					};
				}
				if (families.has(family)) {
					return {
						valid: false,
						reason: `Team contains duplicate model family '${family}' violating distinct_family`,
					};
				}
				families.add(family);
			}

			if (options?.priorBindings && options.priorBindings.length > 0) {
				for (const b of bindings) {
					const fam = resolver(b.model_id, b.provider);
					if (!fam) continue;
					for (const prior of options.priorBindings) {
						const priorFam = resolver(prior.model_id, prior.provider);
						if (fam === priorFam) {
							return {
								valid: false,
								reason: `Binding family '${fam}' matches prior attempt family violating distinct_family`,
							};
						}
					}
				}
			}

			return { valid: true };
		}

		return { valid: true };
	}
}
