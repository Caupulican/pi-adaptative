/**
 * Policy pack provider and verification for external immutable validation policy packs.
 *
 * Strict Rules:
 * - R-014: Policy pack requires id/version/digest.
 * - R-015: Pack immutable for one validation transaction.
 * - R-016: Resume verifies exact pack digest/version.
 * - R-037: Private semantics remain opaque to Pi.
 */

import {
	computePolicyPackDigest,
	type PolicyPackRef,
	type ValidationPolicyPack,
	type ValidationPolicyProvider,
	validatePolicyPackStructure,
} from "../hooks/index.ts";

export class PolicyPackValidationError extends Error {
	readonly errors: readonly string[];

	constructor(message: string, errors: readonly string[] = []) {
		super(errors.length > 0 ? `${message}: ${errors.join("; ")}` : message);
		this.name = "PolicyPackValidationError";
		this.errors = errors;
	}
}

export class PolicyPackDigestMismatchError extends Error {
	readonly expectedDigest: string;
	readonly actualDigest: string;

	constructor(id: string, expectedDigest: string, actualDigest: string) {
		super(`Policy pack '${id}' digest mismatch: expected '${expectedDigest}', computed '${actualDigest}'`);
		this.name = "PolicyPackDigestMismatchError";
		this.expectedDigest = expectedDigest;
		this.actualDigest = actualDigest;
	}
}

/**
 * In-memory reference policy pack provider for external or neutral test policy packs.
 */
export class InMemoryValidationPolicyProvider implements ValidationPolicyProvider {
	private readonly packs = new Map<string, ValidationPolicyPack>();

	constructor(initialPacks: readonly ValidationPolicyPack[] = []) {
		for (const pack of initialPacks) {
			this.registerPack(pack);
		}
	}

	registerPack(pack: ValidationPolicyPack): void {
		const validation = validatePolicyPackStructure(pack);
		if (!validation.valid) {
			throw new PolicyPackValidationError(`Invalid policy pack '${pack.id}'`, validation.errors);
		}
		const computedDigest = computePolicyPackDigest(pack);
		if (pack.digest !== computedDigest) {
			throw new PolicyPackDigestMismatchError(pack.id, pack.digest, computedDigest);
		}
		const key = `${pack.id}@${pack.version}`;
		this.packs.set(key, Object.freeze(structuredClone(pack)));
		// Also index by ID for latest/default lookup
		this.packs.set(pack.id, this.packs.get(key)!);
	}

	async getPolicyPack(ref: { id: string; version?: string }): Promise<{
		ref: PolicyPackRef;
		questions: Readonly<Record<string, unknown>>;
		stages: ReadonlyArray<unknown>;
	}> {
		const key = ref.version ? `${ref.id}@${ref.version}` : ref.id;
		const found = this.packs.get(key);
		if (!found) {
			throw new Error(`Policy pack '${ref.id}' (version: ${ref.version ?? "latest"}) not found`);
		}
		return {
			ref: {
				id: found.id,
				version: found.version,
				digest: found.digest,
			},
			questions: found.questions,
			stages: found.stages,
		};
	}

	hasPack(id: string, version?: string): boolean {
		const key = version ? `${id}@${version}` : id;
		return this.packs.has(key);
	}
}

/**
 * Validate and verify an immutable policy pack loaded from any provider.
 */
export async function resolveVerifiedPolicyPack(
	provider: ValidationPolicyProvider,
	ref: PolicyPackRef,
): Promise<ValidationPolicyPack> {
	const raw = await provider.getPolicyPack(ref);
	const packCandidate: ValidationPolicyPack = {
		schema_version: "1.0",
		id: raw.ref.id,
		version: raw.ref.version,
		digest: raw.ref.digest,
		stages: raw.stages as ValidationPolicyPack["stages"],
		questions: raw.questions as ValidationPolicyPack["questions"],
	};

	const validation = validatePolicyPackStructure(packCandidate);
	if (!validation.valid) {
		throw new PolicyPackValidationError(
			`Loaded policy pack '${ref.id}' failed structural validation`,
			validation.errors,
		);
	}

	if (ref.id !== raw.ref.id || (ref.version && ref.version !== raw.ref.version)) {
		throw new Error(
			`Policy pack reference mismatch: requested ${ref.id}@${ref.version}, received ${raw.ref.id}@${raw.ref.version}`,
		);
	}

	const computedDigest = computePolicyPackDigest(packCandidate);
	if (ref.digest && ref.digest !== computedDigest) {
		throw new PolicyPackDigestMismatchError(ref.id, ref.digest, computedDigest);
	}

	return Object.freeze(packCandidate);
}
