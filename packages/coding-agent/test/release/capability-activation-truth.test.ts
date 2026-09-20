/**
 * Capability activation truth (ACT-001..ACT-018).
 *
 * Every capability kind is either backed by a real owner that can activate, look up and smoke a
 * candidate, or explicitly unavailable and excluded from selection. These tests assert both halves:
 * the supported kinds really execute their owner, and the unsupported ones cannot be reached.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { AdaptiveRuntimeReadiness } from "../../src/core/adaptive/adaptive-runtime-readiness.ts";
import { CapabilityCatalog } from "../../src/core/adaptive/capability-catalog.ts";
import { verifyCapabilityKindActivationTruth } from "../../src/core/adaptive/capability-kind-support.ts";
import {
	AdaptiveCapabilityController,
	CAPABILITY_KIND_SUPPORT,
	type CapabilityKindSupport,
	CapabilityProofRunner,
	capabilityKindForLevel,
	findBrokenAdvertisedKinds,
	isCapabilityKindSupported,
	replanToSupportedKind,
	resolveActivatableKind,
	supportedCapabilityKinds,
	UnsupportedCapabilityKindError,
} from "../../src/core/adaptive/index.ts";
import type { CapabilityKind } from "../../src/core/adaptive/types.ts";
import { RELEASE_WIRING_MANIFEST } from "../../src/core/release/release-wiring-manifest.ts";

const ALL_KINDS: readonly CapabilityKind[] = [
	"composition",
	"ephemeral_script",
	"toolkit_script",
	"tool",
	"skill",
	"extension",
	"integration",
	"provider_adapter",
	"runtime_patch",
];

function writeArtifact(body: string): { path: string; uri: string; digest: string } {
	const directory = mkdtempSync(join(tmpdir(), "pi-activation-"));
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "capability.mjs");
	writeFileSync(path, body, "utf-8");
	return { path, uri: pathToFileURL(path).href, digest: createHash("sha256").update(body).digest("hex") };
}

function controllerWith(overrides: Record<string, unknown> = {}): AdaptiveCapabilityController {
	return new AdaptiveCapabilityController({
		steering: {} as never,
		catalog: new CapabilityCatalog(),
		proofRunner: new CapabilityProofRunner(),
		...overrides,
	} as never);
}

/** The activator the controller registered for a kind, or undefined when the kind is unsupported. */
function activatorFor(controller: AdaptiveCapabilityController, kind: CapabilityKind): unknown {
	return (controller as unknown as { activators: Map<CapabilityKind, unknown> }).activators.get(kind);
}

describe("Capability activation truth", () => {
	describe("Support matrix (ACT-001..ACT-006)", () => {
		it("ACT-001: every capability kind has an explicit support record", () => {
			for (const kind of ALL_KINDS) {
				const support: CapabilityKindSupport | undefined = CAPABILITY_KIND_SUPPORT[kind];
				expect(support, `${kind} has no support record`).toBeDefined();
				expect(support?.kind).toBe(kind);
				expect(support?.reason.length).toBeGreaterThan(0);
			}
			expect(Object.keys(CAPABILITY_KIND_SUPPORT).sort()).toEqual([...ALL_KINDS].sort());
		});

		it("ACT-002: an available kind always names an owner, and no advertisement is broken", () => {
			for (const support of Object.values(CAPABILITY_KIND_SUPPORT)) {
				if (support.available) {
					expect(support.owner, `${support.kind} is available with no owner`).toBeTruthy();
					expect(support.activationMode).not.toBe("unsupported");
				} else {
					expect(support.owner).toBeNull();
					expect(support.activationMode).toBe("unsupported");
				}
			}
			expect(findBrokenAdvertisedKinds()).toEqual([]);
		});

		it("ACT-003: an unsupported kind has no activator at all, so nothing can establish it", () => {
			const controller = controllerWith();
			for (const kind of ALL_KINDS) {
				const activator = activatorFor(controller, kind);
				if (isCapabilityKindSupported(kind)) {
					expect(activator, `${kind} is available but has no activator`).toBeDefined();
				} else {
					expect(activator, `${kind} is unsupported but still has an activator`).toBeUndefined();
				}
			}
		});

		it("ACT-004: the semantic selection set contains only supported kinds", () => {
			const supported = supportedCapabilityKinds();
			expect(supported.length).toBeGreaterThan(0);
			for (const kind of supported) expect(isCapabilityKindSupported(kind)).toBe(true);
			for (const kind of ALL_KINDS) {
				if (!isCapabilityKindSupported(kind)) expect(supported).not.toContain(kind);
			}
			expect(capabilityKindForLevel("extension_or_tool")).toBe("extension");
			expect(capabilityKindForLevel("compose")).toBe("composition");
		});

		it("ACT-005: a spec naming an unsupported kind replans upward or blocks, never downgrades", () => {
			// Replanning lands on a supported kind at least as capable as the request.
			expect(resolveActivatableKind("toolkit_script", CAPABILITY_KIND_SUPPORT)).toBe("extension");
			expect(resolveActivatableKind("composition", CAPABILITY_KIND_SUPPORT)).toBe("ephemeral_script");
			expect(resolveActivatableKind("tool", CAPABILITY_KIND_SUPPORT)).toBe("extension");

			// Nothing adequate is available, so the stale spec blocks rather than being satisfied.
			for (const blocked of ["skill", "integration", "provider_adapter"] as const) {
				expect(() => resolveActivatableKind(blocked, CAPABILITY_KIND_SUPPORT)).toThrow(
					UnsupportedCapabilityKindError,
				);
			}

			// A runtime patch is never an automatic replan target: it is the most invasive adaptation.
			for (const kind of ALL_KINDS) {
				if (kind === "runtime_patch") continue;
				expect(replanToSupportedKind(kind)).not.toBe("runtime_patch");
			}
		});

		it("ACT-006: an unavailable optional kind is not a fault, but an advertised one with no owner is", () => {
			const healthy = new AdaptiveRuntimeReadiness({ kindSupport: CAPABILITY_KIND_SUPPORT });
			expect(healthy.getStatus().issues.filter((issue) => issue.includes("ACT-002"))).toEqual([]);
			expect(healthy.getCapabilityKindSupport()).toHaveLength(ALL_KINDS.length);

			const broken = {
				...CAPABILITY_KIND_SUPPORT,
				integration: {
					kind: "integration" as const,
					available: true,
					owner: null,
					activationMode: "unsupported" as const,
					reason: "advertised without an owner",
				},
			};
			const readiness = new AdaptiveRuntimeReadiness({ kindSupport: broken });
			expect(readiness.getStatus().issues.join("\n")).toContain(
				"advertised as available but has no activation owner",
			);
			expect(findBrokenAdvertisedKinds(broken)).toHaveLength(1);
		});
	});

	describe("Release readiness (ACT-017, ACT-018)", () => {
		it("ACT-017: the release manifest carries a per-kind activation entry for every kind", () => {
			const activationEntries = RELEASE_WIRING_MANIFEST.filter((entry) =>
				entry.featureId.startsWith("capability_activation_"),
			);
			expect(activationEntries.map((entry) => entry.featureId).sort()).toEqual(
				[...ALL_KINDS].map((kind) => `capability_activation_${kind}`).sort(),
			);
			// A generic entry would hide which kinds are actually activatable.
			expect(RELEASE_WIRING_MANIFEST.some((entry) => entry.featureId === "capability_activation")).toBe(false);
			for (const entry of activationEntries) {
				expect(entry.failClosed.length).toBeGreaterThan(0);
				expect(entry.negativePathTestName.length).toBeGreaterThan(0);
			}
		});

		it("ACT-018: release readiness rejects a kind advertised as available with no owner", () => {
			// The mechanical gate must reject this, not just the runtime readiness controller: a matrix
			// edited to advertise support it does not have would otherwise ship.
			expect(verifyCapabilityKindActivationTruth(CAPABILITY_KIND_SUPPORT)).toEqual([]);

			const advertisedWithoutOwner = {
				...CAPABILITY_KIND_SUPPORT,
				tool: {
					kind: "tool" as const,
					available: true,
					owner: null,
					activationMode: "real_owner" as const,
					reason: "advertised without an owner",
				},
			};
			const findings = verifyCapabilityKindActivationTruth(advertisedWithoutOwner);
			expect(findings).toHaveLength(1);
			expect(findings[0]?.check).toBe("advertised_kind_has_owner");

			const metadataMode = {
				...CAPABILITY_KIND_SUPPORT,
				skill: {
					kind: "skill" as const,
					available: true,
					owner: "SkillVault",
					activationMode: "unsupported" as const,
					reason: "available but with no activation mode",
				},
			};
			expect(verifyCapabilityKindActivationTruth(metadataMode).map((finding) => finding.check)).toContain(
				"advertised_kind_has_activation_mode",
			);

			const unavailableWithOwner = {
				...CAPABILITY_KIND_SUPPORT,
				integration: {
					kind: "integration" as const,
					available: false,
					owner: "SomeOwner",
					activationMode: "unsupported" as const,
					reason: "unavailable but still naming an owner",
				},
			};
			expect(verifyCapabilityKindActivationTruth(unavailableWithOwner).map((finding) => finding.check)).toContain(
				"unavailable_kind_names_no_owner",
			);
		});
	});

	describe("Owner-backed activation (ACT-007..ACT-016)", () => {
		it("ACT-007: ephemeral_script activation executes the artifact and fails on a broken one", async () => {
			const controller = controllerWith({ cwd: tmpdir() });
			const activator = activatorFor(controller, "ephemeral_script") as {
				activate(candidate: unknown, spec: unknown): Promise<{ active: boolean; projection: never }>;
			};
			const spec = { capability_id: "cap_act", kind: "ephemeral_script" } as never;

			const good = writeArtifact("export default async function run() { return 1; }\n");
			const activation = await activator.activate(
				{
					capabilityId: "cap_act",
					kind: "ephemeral_script",
					code: "x",
					digest: good.digest,
					artifactUri: good.uri,
				},
				spec,
			);
			expect(activation.active).toBe(true);
			// The evidence is the real execution, not a syntax claim.
			const projection = activation.projection as unknown as Record<string, unknown>;
			expect(projection.smokeExitCode).toBe(0);
			expect(String(projection.smokeEvidence)).toContain("proof:");
			expect(projection.smokeOutputDigest).toMatch(/^[0-9a-f]{64}$/);

			// An artifact that parses but throws when invoked is not activated.
			const throwing = writeArtifact("export default async function run() { throw new Error('boom'); }\n");
			await expect(
				activator.activate(
					{
						capabilityId: "cap_act",
						kind: "ephemeral_script",
						code: "x",
						digest: throwing.digest,
						artifactUri: throwing.uri,
					},
					spec,
				),
			).rejects.toThrow(/activation smoke failed/);

			// No artifact on disk is not activation either.
			await expect(
				activator.activate({ capabilityId: "cap_act", kind: "ephemeral_script", code: "x", digest: "d" }, spec),
			).rejects.toThrow(/requires an artifact on disk/);
		});

		it("ACT-009: extension activation reloads through the owner and looks the result up", async () => {
			const artifact = writeArtifact("export default {};\n");
			const reloaded: string[] = [];
			const controller = controllerWith({
				extensionRuntime: {
					reload: async (path: string) => {
						reloaded.push(path);
					},
					listActive: () => [{ name: "capability.mjs", path: artifact.path }],
				},
			});
			const activator = activatorFor(controller, "extension") as {
				activate(candidate: unknown, spec: unknown): Promise<{ active: boolean; projection: never }>;
			};
			const candidate = {
				capabilityId: "cap_ext",
				kind: "extension",
				code: "x",
				digest: artifact.digest,
				artifactUri: artifact.uri,
			};

			const activation = await activator.activate(candidate, { capability_id: "cap_ext" } as never);
			expect(activation.active).toBe(true);
			expect(reloaded).toEqual([artifact.path]);

			// A registry that does not contain it after reload is not activation.
			const absent = controllerWith({
				extensionRuntime: { reload: async () => {}, listActive: () => [] },
			});
			const absentActivator = activatorFor(absent, "extension") as {
				activate(candidate: unknown, spec: unknown): Promise<unknown>;
			};
			await expect(absentActivator.activate(candidate, { capability_id: "cap_ext" } as never)).rejects.toThrow(
				/absent from the live extension registry/,
			);
		});

		it("ACT-015: runtime_patch stays backed by the real runtime adaptation lifecycle", async () => {
			const controller = controllerWith({
				runtimeAdaptation: {
					executeRuntimeModification: async () => ({ success: true, rolledBack: false, restartRequired: false }),
				},
			});
			const activator = activatorFor(controller, "runtime_patch") as {
				activate(candidate: unknown, spec: unknown): Promise<{ active: boolean }>;
			};
			const spec = { capability_id: "cap_patch", kind: "runtime_patch" } as never;
			expect((await activator.activate({ capabilityId: "cap_patch", diff: "--- a\n" }, spec)).active).toBe(true);

			const rolledBack = controllerWith({
				runtimeAdaptation: {
					executeRuntimeModification: async () => ({ success: false, rolledBack: true, restartRequired: false }),
				},
			});
			const rolledBackActivator = activatorFor(rolledBack, "runtime_patch") as {
				activate(candidate: unknown, spec: unknown): Promise<unknown>;
			};
			await expect(rolledBackActivator.activate({ capabilityId: "cap_patch", diff: "d" }, spec)).rejects.toThrow(
				/failed or was rolled back/,
			);

			// Without the coordinator there is no owner, so activation cannot claim success.
			const unowned = activatorFor(controllerWith(), "runtime_patch") as {
				activate(candidate: unknown, spec: unknown): Promise<unknown>;
			};
			await expect(unowned.activate({ capabilityId: "cap_patch" }, spec)).rejects.toThrow(
				/RuntimeAdaptationCoordinator is required/,
			);
		});

		it("ACT-016: activation evidence is produced by the owner, never asserted metadata", async () => {
			const controller = controllerWith({ cwd: tmpdir() });
			const activator = activatorFor(controller, "ephemeral_script") as {
				activate(candidate: unknown, spec: unknown): Promise<{ projection: Record<string, unknown> }>;
			};
			const artifact = writeArtifact("export default async function run() { return 7; }\n");
			const { projection } = await activator.activate(
				{
					capabilityId: "cap_evidence",
					kind: "ephemeral_script",
					code: "x",
					digest: artifact.digest,
					artifactUri: artifact.uri,
				},
				{ capability_id: "cap_evidence", kind: "ephemeral_script" } as never,
			);

			// The old metadata claims are gone: nothing reports runnable/registered/wired on trust.
			for (const claim of ["runnable", "registered", "wired", "adapterMounted", "syntaxValid"]) {
				expect(projection[claim], `${claim} must not be asserted`).toBeUndefined();
			}
			expect(typeof projection.smokeElapsedMs).toBe("number");
		});
	});
});
