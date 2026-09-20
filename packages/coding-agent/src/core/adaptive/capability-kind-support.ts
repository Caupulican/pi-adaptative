/**
 * Capability-kind activation truth.
 *
 * Every `CapabilityKind` is either backed by a real production owner that can accept, activate,
 * look up and smoke a candidate — or it is explicitly unavailable and excluded from adaptive
 * selection. There is no third state, and no kind is ever established from metadata alone.
 *
 * A kind is marked available only when an owner that already exists in this runtime can do all of
 * it. Where no such owner exists, the kind is unsupported and says why; the release strategy is to
 * exclude it, not to invent a runtime so the matrix can claim support.
 * Conforms to ACTIVATION_TRUTH.md and ACT-001..ACT-018.
 */

import { CAPABILITY_LEVELS, type CapabilityKind } from "./types.ts";

export type CapabilityActivationMode = "real_owner" | "registry_backed" | "ephemeral_exec" | "unsupported";

export interface CapabilityKindSupport {
	readonly kind: CapabilityKind;
	readonly available: boolean;
	/** The production owner that performs activation and lookup, or null when unavailable. */
	readonly owner: string | null;
	readonly activationMode: CapabilityActivationMode;
	/** Why an unavailable kind has no owner, or how an available one is verified. */
	readonly reason: string;
}

/**
 * The matrix. Each entry states what the runtime can actually do today.
 *
 * Available kinds name the owner that performs the activation and the lookup that confirms it.
 * Unavailable kinds name the owner that would be required and why the current runtime is not it.
 */
export const CAPABILITY_KIND_SUPPORT: Readonly<Record<CapabilityKind, CapabilityKindSupport>> = {
	ephemeral_script: {
		kind: "ephemeral_script",
		available: true,
		owner: "CapabilityProofRunner",
		activationMode: "ephemeral_exec",
		reason:
			"The artifact is executed in a bounded child process; activation evidence is its real exit status and output digest, not a syntax check.",
	},
	extension: {
		kind: "extension",
		available: true,
		owner: "ResourceLoader.loadSingleExtension + ExtensionRunner.activeExtensions",
		activationMode: "real_owner",
		reason:
			"The extension runtime loads the artifact by path and the live extension registry is queried afterwards to confirm it is present.",
	},
	runtime_patch: {
		kind: "runtime_patch",
		available: true,
		owner: "RuntimeAdaptationCoordinator",
		activationMode: "real_owner",
		reason:
			"Runtime modification runs through the real snapshot/apply/verify/commit lifecycle and reports whether it was rolled back.",
	},
	toolkit_script: {
		kind: "toolkit_script",
		available: false,
		owner: null,
		activationMode: "unsupported",
		reason:
			"run_toolkit_script resolves scripts from settings.toolkit.scripts; the adaptive script registry is an isolated in-memory map nothing executes from, so a registration there is not activation.",
	},
	skill: {
		kind: "skill",
		available: false,
		owner: null,
		activationMode: "unsupported",
		reason:
			"SkillVault loads by name from discovered skill sources; a synthesized artifact is not discoverable, so a load cannot be performed against it.",
	},
	tool: {
		kind: "tool",
		available: false,
		owner: null,
		activationMode: "unsupported",
		reason: "There is no live dynamic tool registry that admits a synthesized tool into the active tool surface.",
	},
	composition: {
		kind: "composition",
		available: false,
		owner: null,
		activationMode: "unsupported",
		reason:
			"Child capabilities can be resolved from the catalog, but there is no executable composed path to run, so composition cannot be smoked.",
	},
	integration: {
		kind: "integration",
		available: false,
		owner: null,
		activationMode: "unsupported",
		reason: "There is no integration registry or health owner that can mount and verify an integration.",
	},
	provider_adapter: {
		kind: "provider_adapter",
		available: false,
		owner: null,
		activationMode: "unsupported",
		reason:
			"ModelRegistry resolves configured providers; it does not mount a synthesized provider adapter, so adapter health cannot be verified.",
	},
} as const;

/** Kinds adaptive selection may choose from. */
export function supportedCapabilityKinds(
	matrix: Readonly<Record<CapabilityKind, CapabilityKindSupport>> = CAPABILITY_KIND_SUPPORT,
): readonly CapabilityKind[] {
	return (Object.keys(matrix) as CapabilityKind[]).filter((kind) => matrix[kind].available);
}

export function isCapabilityKindSupported(
	kind: CapabilityKind,
	matrix: Readonly<Record<CapabilityKind, CapabilityKindSupport>> = CAPABILITY_KIND_SUPPORT,
): boolean {
	return matrix[kind]?.available === true;
}

export function capabilityKindSupport(
	kind: CapabilityKind,
	matrix: Readonly<Record<CapabilityKind, CapabilityKindSupport>> = CAPABILITY_KIND_SUPPORT,
): CapabilityKindSupport | undefined {
	return matrix[kind];
}

/**
 * Each kind's rank on the capability escalation ladder (see `CAPABILITY_LEVELS`). Replanning may
 * move sideways or up this ladder, never down: a replan must not quietly weaken what the capability
 * has to do.
 */
const KIND_RANK: Readonly<Record<CapabilityKind, number>> = {
	composition: rankOfLevel("compose"),
	ephemeral_script: rankOfLevel("ephemeral_script"),
	toolkit_script: rankOfLevel("toolkit_script"),
	extension: rankOfLevel("extension_or_tool"),
	tool: rankOfLevel("extension_or_tool"),
	skill: rankOfLevel("skill"),
	integration: rankOfLevel("integration_or_adapter"),
	provider_adapter: rankOfLevel("integration_or_adapter"),
	runtime_patch: rankOfLevel("runtime_patch"),
};

function rankOfLevel(levelId: string): number {
	return CAPABILITY_LEVELS.find((level) => level.id === levelId)?.rank ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Kinds a replan may land on.
 *
 * `runtime_patch` is deliberately excluded. It is the most invasive adaptation the runtime has, and
 * escalating into it merely because a lesser kind is unsupported would turn an absent skill or
 * integration into a live modification of the harness itself. A runtime patch is chosen on its own
 * merits or not at all; everything else blocks instead.
 */
const REPLAN_EXCLUDED_KINDS: ReadonlySet<CapabilityKind> = new Set<CapabilityKind>(["runtime_patch"]);

/**
 * Replans a spec that targets an unsupported kind onto the lowest adequate supported kind.
 *
 * "Adequate" means at least as capable as the requested level, so replanning never silently
 * downgrades. When nothing at or above that level is an eligible replan target the result is
 * undefined and the caller blocks: a stale spec is never quietly satisfied.
 */
export function replanToSupportedKind(
	kind: CapabilityKind,
	matrix: Readonly<Record<CapabilityKind, CapabilityKindSupport>> = CAPABILITY_KIND_SUPPORT,
): CapabilityKind | undefined {
	if (isCapabilityKindSupported(kind, matrix)) return kind;
	const requestedRank = KIND_RANK[kind];
	if (requestedRank === undefined) return undefined;
	const candidates = supportedCapabilityKinds(matrix)
		.filter((candidate) => !REPLAN_EXCLUDED_KINDS.has(candidate) && KIND_RANK[candidate] >= requestedRank)
		.sort((left, right) => KIND_RANK[left] - KIND_RANK[right]);
	return candidates[0];
}

/** An advertised-available kind whose owner is missing is a broken advertisement, not an absence. */
export function findBrokenAdvertisedKinds(
	matrix: Readonly<Record<CapabilityKind, CapabilityKindSupport>> = CAPABILITY_KIND_SUPPORT,
): readonly CapabilityKindSupport[] {
	return Object.values(matrix).filter(
		(support) =>
			support.available &&
			(!support.owner || support.owner.length === 0 || support.activationMode === "unsupported"),
	);
}

export interface CapabilityKindActivationFinding {
	readonly kind: CapabilityKind;
	readonly check: string;
	readonly detail: string;
}

/**
 * Mechanical activation-truth check for the release gate.
 *
 * The runtime's readiness controller refuses to start on a broken advertisement, but that only
 * protects a running session. This is the release-time equivalent: a matrix edited to advertise
 * support the runtime does not have must fail the gate before it ships.
 */
export function verifyCapabilityKindActivationTruth(
	matrix: Readonly<Record<CapabilityKind, CapabilityKindSupport>> = CAPABILITY_KIND_SUPPORT,
): readonly CapabilityKindActivationFinding[] {
	const findings: CapabilityKindActivationFinding[] = [];
	for (const support of Object.values(matrix)) {
		if (support.available) {
			if (!support.owner) {
				findings.push({
					kind: support.kind,
					check: "advertised_kind_has_owner",
					detail: "advertised as available with no activation owner",
				});
			}
			if (support.activationMode === "unsupported") {
				findings.push({
					kind: support.kind,
					check: "advertised_kind_has_activation_mode",
					detail: "advertised as available with an unsupported activation mode",
				});
			}
		} else {
			if (support.owner) {
				findings.push({
					kind: support.kind,
					check: "unavailable_kind_names_no_owner",
					detail: "unavailable but still naming an owner, which reads as support it does not have",
				});
			}
			if (support.activationMode !== "unsupported") {
				findings.push({
					kind: support.kind,
					check: "unavailable_kind_has_unsupported_mode",
					detail: `unavailable but declaring activation mode '${support.activationMode}'`,
				});
			}
		}
		if (!support.reason.trim()) {
			findings.push({ kind: support.kind, check: "kind_states_a_reason", detail: "no reason recorded" });
		}
	}
	return findings;
}

/**
 * Session facts that decide whether a conditionally-supported kind is actually available here.
 *
 * Support is not purely static: `extension` activation loads the synthesized artifact from a
 * project path, and `ResourceLoader.loadSingleExtension` refuses project paths when project
 * instructions are disabled — which is the default. Advertising it unconditionally would claim
 * support the session does not have.
 */
export interface CapabilityKindSupportContext {
	/** `settings.projectContextFiles === "on-demand"`. Defaults to false, matching the product default. */
	readonly projectInstructionsEnabled?: boolean;
}

/**
 * Resolves the matrix against a live session, downgrading any kind whose precondition this session
 * does not meet. The downgrade states the precondition, so an operator can see it is a
 * configuration limit rather than a missing owner.
 */
export function resolveCapabilityKindSupport(
	context: CapabilityKindSupportContext = {},
	matrix: Readonly<Record<CapabilityKind, CapabilityKindSupport>> = CAPABILITY_KIND_SUPPORT,
): Readonly<Record<CapabilityKind, CapabilityKindSupport>> {
	if (context.projectInstructionsEnabled === true) return matrix;
	const extension = matrix.extension;
	if (!extension?.available) return matrix;
	return {
		...matrix,
		extension: {
			kind: "extension",
			available: false,
			owner: null,
			activationMode: "unsupported",
			reason:
				"Extension activation loads the synthesized artifact from a project path, and the resource loader refuses project instruction paths while projectContextFiles is off. Enable project context files to make this kind available.",
		},
	};
}
