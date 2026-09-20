/**
 * Adaptive Capability Controller.
 * Resolves, synthesizes, tests, activates, and records lifecycle of capabilities.
 * Implements S1A-070..S1A-081, S1A-140..S1A-145, JEV-009..JEV-016, JEV-029..JEV-030.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionCharter } from "../autonomy/execution-charter.ts";
import { EXPERT_ROUTING_SCHEMA_VERSION, type WorkerCapabilityRequest } from "../expert-routing/contracts.ts";
import type { ExpertSelectionService } from "../expert-routing/service.ts";
import type { AdaptationProjection } from "../operator-projection/types.ts";
import type { SystemOneSteeringPlane } from "../steering/system-one-steering-plane.ts";
import { SteeringProtocolError } from "../steering/types.ts";
import type { CapabilityCatalog } from "./capability-catalog.ts";
import {
	CAPABILITY_KIND_SUPPORT,
	type CapabilityKindSupport,
	isCapabilityKindSupported,
	replanToSupportedKind,
	supportedCapabilityKinds,
} from "./capability-kind-support.ts";
import {
	capabilityArtifactPath,
	compileCapabilityProofObligations,
	compileNodeProofCommand,
} from "./capability-proof-obligations.ts";
import type { CapabilityProofRunnerPort } from "./capability-proof-runner.ts";
import { type CapabilityNeed, CapabilityResolver } from "./capability-resolution.ts";
import type {
	CapabilityGap,
	CapabilityKind,
	CapabilityLifetime,
	CapabilityRecord,
	CapabilitySpec,
	EstablishedCapability,
	PortProvenance,
} from "./types.ts";

export interface CandidateArtifact {
	readonly capabilityId: string;
	readonly kind: CapabilityKind;
	readonly code: string;
	readonly digest: string;
	readonly diff?: string;
	readonly artifactUri?: string;
	readonly changedFiles?: readonly string[];
	readonly builderEvidence?: Record<string, unknown>;
	readonly provenance?: PortProvenance;
}

export interface CandidateVerificationResult {
	readonly passed: boolean;
	readonly testCount: number;
	readonly failures: readonly string[];
}

export interface CapabilityActivator {
	activate(candidate: CandidateArtifact, spec: CapabilitySpec): Promise<{ active: boolean; projection: unknown }>;
}

/**
 * The ephemeral-script activation smoke: load the artifact and invoke its entry point once.
 * Activation means the capability ran, so the smoke calls it rather than merely importing it.
 */
export function activationSmokeSource(scriptPath: string): string {
	return [
		"const { pathToFileURL } = require('node:url');",
		`const href = pathToFileURL(${JSON.stringify(scriptPath)}).href;`,
		"import(href).then(async (loaded) => {",
		"  const entry = loaded.default ?? loaded.run;",
		"  if (typeof entry !== 'function') {",
		"    console.error('capability entry point is not callable');",
		"    process.exit(1);",
		"  }",
		"  await entry({});",
		"}, (error) => {",
		"  console.error('capability failed to load: ' + (error && error.message));",
		"  process.exit(1);",
		"}).catch((error) => {",
		"  console.error('capability invocation failed: ' + (error && error.message));",
		"  process.exit(1);",
		"});",
	].join("\n");
}

/** The capability kind a semantic adaptation-class choice selects. */
export function capabilityKindForLevel(level: string): CapabilityKind {
	switch (level) {
		case "compose":
		case "composition":
			return "composition";
		case "ephemeral_script":
			return "ephemeral_script";
		case "toolkit_script":
			return "toolkit_script";
		case "extension_or_tool":
		case "extension":
			return "extension";
		case "tool":
			return "tool";
		case "skill":
			return "skill";
		case "runtime_patch":
			return "runtime_patch";
		case "provider_adapter":
			return "provider_adapter";
		default:
			return "integration";
	}
}

export class UnsupportedCapabilityKindError extends Error {
	readonly requestedKind: CapabilityKind;
	readonly reason: string;

	constructor(requestedKind: CapabilityKind, reason: string) {
		super(
			`Capability kind '${requestedKind}' is not activatable by this runtime and no adequate supported kind replaces it: ${reason} (ACT-005)`,
		);
		this.name = "UnsupportedCapabilityKindError";
		this.requestedKind = requestedKind;
		this.reason = reason;
	}
}

/** Returns the kind to build, replanning an unsupported request or refusing it outright. */
export function resolveActivatableKind(
	requestedKind: CapabilityKind,
	matrix: Readonly<Record<CapabilityKind, CapabilityKindSupport>>,
): CapabilityKind {
	if (isCapabilityKindSupported(requestedKind, matrix)) return requestedKind;
	const replanned = replanToSupportedKind(requestedKind, matrix);
	if (!replanned) {
		throw new UnsupportedCapabilityKindError(
			requestedKind,
			matrix[requestedKind]?.reason ?? "no support record for this kind",
		);
	}
	return replanned;
}

/**
 * Digest of the artifact's bytes on disk, or null when it has none.
 *
 * The path comes from `fileURLToPath`, never from stripping the `file://` prefix: a file URL
 * percent-encodes characters that are legal in paths (`~` becomes `%7E`) and carries a leading
 * slash before a Windows drive letter, so a string strip yields a path that exists nowhere.
 */
export function computeArtifactDiskDigest(artifactUri: string): string | null {
	let filePath: string;
	try {
		filePath = artifactUri.startsWith("file:") ? fileURLToPath(artifactUri) : artifactUri;
	} catch {
		return null;
	}
	if (existsSync(filePath)) {
		const bytes = readFileSync(filePath);
		return createHash("sha256").update(bytes).digest("hex");
	}
	return null;
}

export interface ResolveOrBuildInput {
	objectiveId: string;
	taskId: string;
	need: CapabilityNeed;
	charter?: ExecutionCharter;
	evidenceRevision?: number;
	signal?: AbortSignal;
}

export interface AdaptiveCapabilityControllerDeps {
	readonly steering: SystemOneSteeringPlane;
	/** Told when a capability is being built, verified or activated, and `undefined` when synthesis ends. */
	readonly onAdaptation?: (adaptation: AdaptationProjection | undefined) => void;
	readonly catalog: CapabilityCatalog;
	readonly resolver?: CapabilityResolver;
	readonly experts?: ExpertSelectionService;
	readonly builder?: {
		build(spec: CapabilitySpec, signal?: AbortSignal, expertBinding?: unknown): Promise<CandidateArtifact>;
	};
	readonly mechanicalVerifier?: {
		verifyCandidate(candidate: CandidateArtifact, spec: CapabilitySpec): Promise<CandidateVerificationResult>;
		verifyActivation(activation: unknown, spec: CapabilitySpec): Promise<boolean>;
		runTaskSpecificProof?(spec: CapabilitySpec, signal?: AbortSignal): Promise<string>;
	};
	readonly activators?: Partial<Record<CapabilityKind, CapabilityActivator>>;
	readonly activator?: CapabilityActivator;
	readonly runtimeAdaptation?: {
		executeRuntimeModification(input: {
			objectiveId: string;
			taskId: string;
			spec: CapabilitySpec;
			diff: string;
			evidenceRevision?: number;
			signal?: AbortSignal;
		}): Promise<{ success: boolean; rolledBack: boolean; restartRequired: boolean }>;
	};
	readonly extensionRunner?: {
		reload?(path?: string): Promise<void> | void;
	};
	readonly skillVault?: {
		load?(skillName: string, mode?: string, refresh?: boolean): Promise<{ ok: boolean }> | { ok: boolean };
	};
	readonly scriptRegistry?: {
		register?(script: unknown): void;
	};
	/** Bounded execution owner for the ephemeral-script activation smoke (ACT-007). */
	readonly proofRunner?: CapabilityProofRunnerPort;
	/** Session working directory the activation smoke runs in. */
	readonly cwd?: string;
	/**
	 * Agent-owned root synthesized capability artifacts are written to and proved against.
	 * Never inside the project worktree: a synthesized artifact is runtime state, not a project
	 * source change.
	 */
	readonly capabilityArtifactRoot?: string;
	/** Live extension runtime: loads an extension by path and exposes the active registry (ACT-009). */
	readonly extensionRuntime?: {
		reload(extensionPath: string): Promise<void>;
		listActive(): readonly { name: string; path: string }[];
	};
	/** Capability-kind support matrix; defaults to the runtime's own. */
	readonly kindSupport?: Readonly<Record<CapabilityKind, CapabilityKindSupport>>;
}

export class AdaptiveCapabilityController {
	readonly steering: SystemOneSteeringPlane;
	readonly catalog: CapabilityCatalog;
	readonly resolver: CapabilityResolver;
	private readonly deps: AdaptiveCapabilityControllerDeps;
	private adaptationSink?: (adaptation: AdaptationProjection | undefined) => void;

	/** Late-bound: the session that owns the operator projection binds it after the stack is built. */
	setAdaptationSink(sink: ((adaptation: AdaptationProjection | undefined) => void) | undefined): void {
		this.adaptationSink = sink;
	}

	private reportAdaptation(label: string, state: AdaptationProjection["state"] | undefined): void {
		this.adaptationSink?.(state ? { kind: "capability", label, state } : undefined);
	}
	private readonly experts?: ExpertSelectionService;
	private readonly builder?: AdaptiveCapabilityControllerDeps["builder"];
	private readonly mechanicalVerifier?: AdaptiveCapabilityControllerDeps["mechanicalVerifier"];
	private readonly activator?: CapabilityActivator;
	private readonly activators = new Map<CapabilityKind, CapabilityActivator>();
	private readonly runtimeAdaptation?: AdaptiveCapabilityControllerDeps["runtimeAdaptation"];
	/** The capability kinds this runtime can actually activate (ACT-001). */
	readonly kindSupport: Readonly<Record<CapabilityKind, CapabilityKindSupport>>;
	private readonly gaps = new Map<string, CapabilityGap>();
	private readonly records = new Map<string, CapabilityRecord>();

	constructor(deps: AdaptiveCapabilityControllerDeps) {
		this.deps = deps;
		this.adaptationSink = deps.onAdaptation;
		this.steering = deps.steering;
		this.catalog = deps.catalog;
		this.resolver = deps.resolver ?? new CapabilityResolver(this.catalog, this.steering);
		this.experts = deps.experts;
		this.builder = deps.builder;
		this.mechanicalVerifier = deps.mechanicalVerifier;
		this.activator = deps.activator;
		this.runtimeAdaptation = deps.runtimeAdaptation;
		this.kindSupport = deps.kindSupport ?? CAPABILITY_KIND_SUPPORT;

		this.registerDefaultActivators();
		if (deps.activators) {
			for (const [k, v] of Object.entries(deps.activators)) {
				if (v) this.activators.set(k as CapabilityKind, v);
			}
		}
	}

	/**
	 * Registers an activator for every kind the runtime can actually activate, and none for the
	 * kinds it cannot. An unsupported kind therefore has no activator at all, so activation fails
	 * closed at the "no activator registered" check rather than returning a metadata projection.
	 */
	private registerDefaultActivators(): void {
		this.activators.set("ephemeral_script", {
			activate: async (candidate, spec) => {
				const code = candidate.code ?? "";
				if (!code || code.trim().length === 0) {
					throw new Error("Empty code for ephemeral script (ERC-030)");
				}
				if (!candidate.artifactUri) {
					throw new Error("Ephemeral script activation requires an artifact on disk (ACT-007)");
				}
				const diskDigest = computeArtifactDiskDigest(candidate.artifactUri);
				if (!diskDigest) {
					throw new Error(`Ephemeral script artifact ${candidate.artifactUri} has no bytes on disk (ACT-007)`);
				}
				if (candidate.digest && diskDigest !== candidate.digest) {
					throw new Error(
						`Ephemeral script digest mismatch: expected ${candidate.digest}, got ${diskDigest} on disk (ERC-030)`,
					);
				}

				// ACT-007: the smoke is an actual bounded execution of the artifact. A syntax check and a
				// digest say the bytes are well-formed, not that the capability runs.
				const proofRunner = this.deps.proofRunner;
				if (!proofRunner) {
					throw new Error(
						"Ephemeral script activation requires the capability proof runner for its execution smoke (ACT-007)",
					);
				}
				const scriptPath = fileURLToPath(candidate.artifactUri);
				const smoke = await proofRunner.runProof({
					proofId: `${spec.capability_id}:activation_smoke`,
					kind: "task_specific_test",
					command: compileNodeProofCommand(activationSmokeSource(scriptPath)),
					cwd: this.deps.cwd ?? dirname(scriptPath),
				});
				if (smoke.status !== "passed") {
					throw new Error(
						`Ephemeral script activation smoke failed for '${spec.capability_id}' (exit ${smoke.exitCode}): ${smoke.outputTail.trim()} (ACT-007)`,
					);
				}

				return {
					active: true,
					projection: {
						operationId: `op-ephemeral-${spec.capability_id}`,
						capabilityId: candidate.capabilityId,
						kind: "ephemeral_script",
						scriptPath,
						lookupResult: "active_ephemeral",
						smokeEvidence: smoke.evidenceRef,
						smokeExitCode: smoke.exitCode,
						smokeOutputDigest: smoke.outputDigest,
						smokeElapsedMs: smoke.elapsedMs,
						digest: candidate.digest,
						activatedAt: new Date().toISOString(),
					},
				};
			},
		});

		this.activators.set("extension", {
			activate: async (candidate, spec) => {
				if (!candidate.artifactUri) {
					throw new Error("Extension activation requires an artifact on disk (ACT-009)");
				}
				const extensions = this.deps.extensionRuntime;
				if (!extensions) {
					throw new Error("Extension activation requires the live extension runtime (ACT-009)");
				}
				const extensionPath = fileURLToPath(candidate.artifactUri);

				// ACT-009: the real owner loads it, and the live registry is queried afterwards. A reload
				// that raises, or a registry that does not contain the extension, is not activation.
				await extensions.reload(extensionPath);
				const loaded = extensions.listActive().find((active) => active.path === extensionPath);
				if (!loaded) {
					throw new Error(
						`Extension '${spec.capability_id}' is absent from the live extension registry after reload (ACT-009)`,
					);
				}

				return {
					active: true,
					projection: {
						operationId: `op-extension-${spec.capability_id}`,
						capabilityId: candidate.capabilityId,
						kind: "extension",
						extensionId: loaded.name,
						extensionPath,
						lookupResult: "active_in_extension_runner",
						smokeEvidence: `extension_registry_lookup:${loaded.name}`,
						digest: candidate.digest,
						activatedAt: new Date().toISOString(),
					},
				};
			},
		});

		this.activators.set("runtime_patch", {
			activate: async (candidate, spec) => {
				if (!this.runtimeAdaptation) {
					throw new Error("RuntimeAdaptationCoordinator is required for runtime_patch activation (ERC-036)");
				}
				if (typeof (this.runtimeAdaptation as any).executeRuntimeModification === "function") {
					const res = await (this.runtimeAdaptation as any).executeRuntimeModification({
						objectiveId: spec.capability_id,
						taskId: `task-${spec.capability_id}`,
						spec,
						diff: candidate.diff ?? candidate.code ?? "",
					});
					if (!res.success || res.rolledBack) {
						throw new Error(
							`Runtime patch modification failed or was rolled back for '${spec.capability_id}' (ERC-036)`,
						);
					}
					return {
						active: res.success,
						projection: {
							operationId: res.transactionId ?? `op-patch-${spec.capability_id}`,
							runtimeModified: res.success,
							restartRequired: res.restartRequired,
							rolledBack: res.rolledBack,
							lookupResult: "runtime_adaptation_committed",
							// ACT-016: the evidence is the coordinator's own transaction, not a constant.
							smokeEvidence: `runtime_adaptation:${res.transactionId ?? spec.capability_id}:applied`,
							digest: candidate.digest,
							activatedAt: new Date().toISOString(),
						},
					};
				}
				if (typeof (this.runtimeAdaptation as any).stagePatch === "function") {
					const staged = await (this.runtimeAdaptation as any).stagePatch(candidate, spec);
					if (typeof (this.runtimeAdaptation as any).commitPatch === "function") {
						await (this.runtimeAdaptation as any).commitPatch(staged.patchId);
					}
					return {
						active: Boolean(staged.applied && !staged.rolledBack),
						projection: {
							operationId: staged.patchId ?? `op-patch-${spec.capability_id}`,
							runtimeModified: Boolean(staged.applied && !staged.rolledBack),
							restartRequired: false,
							rolledBack: Boolean(staged.rolledBack),
							lookupResult: "runtime_adaptation_committed",
							smokeEvidence: `runtime_adaptation:${staged.patchId ?? spec.capability_id}:committed`,
							digest: candidate.digest,
							activatedAt: new Date().toISOString(),
						},
					};
				}
				throw new Error("RuntimeAdaptationCoordinator is required for runtime_patch activation (ERC-036)");
			},
		});
	}

	computeDigest(data: unknown): string {
		return createHash("sha256")
			.update(JSON.stringify(data ?? null))
			.digest("hex");
	}

	async resolveOrBuild(input: ResolveOrBuildInput): Promise<EstablishedCapability> {
		try {
			return await this.resolveOrBuildUnreported(input);
		} finally {
			// Synthesis is over, one way or the other: the projection leaves ADAPT.
			this.reportAdaptation("", undefined);
		}
	}

	private async resolveOrBuildUnreported(input: ResolveOrBuildInput): Promise<EstablishedCapability> {
		if (input.signal?.aborted) {
			throw new Error("Adaptive capability resolution aborted.");
		}

		const evidenceRevision = input.evidenceRevision ?? 1;

		// 1. Wide catalog resolution
		const wide = await this.resolver.rankWide(input.need, {
			objectiveId: input.objectiveId,
			taskId: input.taskId,
			signal: input.signal,
		});

		// 2. Deep shortlist rerank / absolute fit
		const deep = await this.resolver.rerankDeep(input.need, wide, {
			objectiveId: input.objectiveId,
			taskId: input.taskId,
			signal: input.signal,
		});

		if (deep.establishedCapability) {
			return deep.establishedCapability;
		}

		// 3. Mandatory gap certificate: JEV-009
		const gapId = `GAP-${Date.now()}-${randomUUID().slice(0, 8)}`;
		const gap: CapabilityGap = {
			schema_version: "1.0",
			gap_id: gapId,
			objective_id: input.objectiveId,
			task_id: input.taskId,
			required_outcome: input.need.requiredOutcome,
			required_inputs: input.need.requiredInputs ? [...input.need.requiredInputs] : [],
			required_outputs: input.need.requiredOutputs ? [...input.need.requiredOutputs] : [],
			proof_obligations: ["isolated_mechanical_verification", "task_specific_proof"],
			existing_candidates_rejected: deep.shortlistedCandidates.map((c) => ({
				id: c.capabilityId,
				fit: deep.absoluteFits[c.capabilityId] ?? 0,
			})),
		};

		this.gaps.set(gapId, gap);

		const lineageCerts: string[] = [];

		const gapCert = await this.steering.requireCertificate("JEV-009", gap, {
			objectiveId: input.objectiveId,
			taskId: input.taskId,
			evidenceRevision,
			signal: input.signal,
		});
		lineageCerts.push(gapCert.certificate_id);

		// 4. Choose smallest adequate adaptation class: JEV-010 (S1A-072)
		const synthesisCert = await this.steering.requireCertificate(
			"JEV-010",
			{
				gap,
				// ACT-004: the choice set contains only kinds this runtime can actually activate, so a
				// semantic selection can never land on an unsupported one.
				suggestedLevels: supportedCapabilityKinds(this.kindSupport),
			},
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision,
				signal: input.signal,
			},
		);
		lineageCerts.push(synthesisCert.certificate_id);

		const chosenLevelStr =
			input.need.kind ??
			(synthesisCert.answers.adaptation_class as { choice?: string })?.choice ??
			"ephemeral_script";
		const requestedKind = capabilityKindForLevel(chosenLevelStr);

		// ACT-005: a stale spec or an explicit need naming an unsupported kind is replanned onto the
		// lowest adequate supported kind, or blocked. It is never activated as requested.
		const kind = resolveActivatableKind(requestedKind, this.kindSupport);

		const capabilityId = `cap_${kind}_${Date.now()}`;
		// The builder is what a capability is built by, so its absence is still reported first
		// (PH-060, PH-061); the spec below already depends on where that builder will write.
		if (!this.builder) {
			throw new Error("Capability synthesis requires a configured builder (PH-061)");
		}
		// The proof obligations must name the exact file the builder's worker is told to write.
		// Without a configured agent-owned root there is no such path, so synthesis fails rather
		// than falling back to the project worktree.
		const artifactRoot = this.deps.capabilityArtifactRoot;
		if (!artifactRoot) {
			throw new Error(
				"Capability synthesis requires an agent-owned capability artifact root; synthesized artifacts are never written into the project worktree.",
			);
		}
		const spec: CapabilitySpec = {
			schema_version: "1.0",
			capability_id: capabilityId,
			version: "1.0",
			kind,
			lifetime: kind === "ephemeral_script" ? "one_shot" : "session",
			purpose: input.need.requiredOutcome,
			interface: {
				inputs: input.need.requiredInputs ?? [],
				outputs: input.need.requiredOutputs ?? [],
			},
			side_effects: ["local_read_write"],
			denied_behavior: ["bypass_security_isolation", "elevate_root_authority"],
			// Real, runnable obligations against the artifact the builder will write. A placeholder
			// test identifier here can only ever be asserted downstream, never executed.
			proof: compileCapabilityProofObligations(kind, capabilityArtifactPath(artifactRoot, capabilityId)),
			activation: { method: "dynamic_load" },
			rollback: { method: "unload_and_discard" },
		};

		// JEV-011: CapabilitySpec completeness
		const specCert = await this.steering.requireCertificate("JEV-011", spec, {
			objectiveId: input.objectiveId,
			taskId: input.taskId,
			evidenceRevision,
			signal: input.signal,
		});
		lineageCerts.push(specCert.certificate_id);

		// PH-066: JEV-012 capability synthesis plan validation
		const planCert = await this.steering.requireCertificate(
			"JEV-012",
			{
				gap,
				spec,
				builderProfile: {
					kind,
					lifetime: spec.lifetime,
					purpose: spec.purpose,
				},
			},
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision,
				signal: input.signal,
			},
		);
		lineageCerts.push(planCert.certificate_id);

		// 5. Build candidate (PH-060: no dummy builder; PH-061: builder mandatory, asserted above).
		// RCG-018: the builder's model binding must be the H-MoE selection's own binding. Without a
		// selector there is no binding to equal, so the build fails instead of picking a model.
		if (!this.experts) {
			throw new Error(
				"Capability synthesis requires an expert selection service so the builder's model binding is the actual H-MoE binding (RCG-018)",
			);
		}
		let expertBinding: unknown;
		{
			const workerCapRequest: WorkerCapabilityRequest = {
				schema_version: EXPERT_ROUTING_SCHEMA_VERSION,
				request_id: `cap-build-${spec.capability_id}-${Date.now()}`,
				objective_id: input.objectiveId,
				task_id: input.taskId,
				work_class: "implement",
				worker_role: "capability_engineer",
				consequence: "medium",
				required_capabilities: [spec.kind],
			};
			const selection = await this.experts.select(workerCapRequest, { signal: input.signal });
			expertBinding = (selection as any)?.bindings?.[0] ?? (selection as any)?.primary ?? selection;
		}
		this.reportAdaptation(capabilityId, "building");
		const candidate = await this.builder.build(spec, input.signal, expertBinding);
		if (!candidate?.digest) {
			throw new Error("Builder produced an invalid candidate artifact without a digest");
		}

		// 6. Deterministic candidate checks (PH-063: mechanical verifier mandatory)
		if (!this.mechanicalVerifier) {
			throw new Error("Capability synthesis requires a mechanical verifier (PH-063)");
		}
		this.reportAdaptation(capabilityId, "verifying");
		const verification = await this.mechanicalVerifier.verifyCandidate(candidate, spec);
		if (!verification.passed) {
			throw new Error(
				`Mechanical candidate verification failed for ${capabilityId}: ${verification.failures?.join(", ") ?? "unspecified failure"}`,
			);
		}

		// 7. Semantic pre-activation: JEV-013
		const jev013Cert = await this.steering.requireCertificate(
			"JEV-013",
			{
				spec,
				candidateDigest: candidate.digest,
				candidateKind: candidate.kind,
				mechanicalPassed: true,
				testCount: verification.testCount,
			},
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision,
				signal: input.signal,
			},
		);
		lineageCerts.push(jev013Cert.certificate_id);

		// If runtime patch: JEV-014 runtime scope
		if (candidate.kind === "runtime_patch") {
			const jev014Cert = await this.steering.requireCertificate(
				"JEV-014",
				{
					spec,
					diff: candidate.diff ?? "",
				},
				{
					objectiveId: input.objectiveId,
					taskId: input.taskId,
					evidenceRevision,
					signal: input.signal,
				},
			);
			lineageCerts.push(jev014Cert.certificate_id);
		}

		// 8. Activation (PH-065: activator mandatory; PH-073: runtime patch uses RuntimeUpdateController/RuntimeAdaptation)
		const activator = this.activators.get(candidate.kind) ?? this.activator;
		if (!activator) {
			throw new Error(`No activator registered for capability kind '${candidate.kind}' (PH-065)`);
		}
		const activationRes = await activator.activate(candidate, spec);
		if (!activationRes.active) {
			throw new Error(`Activation failed for capability '${capabilityId}'`);
		}
		this.reportAdaptation(capabilityId, "active");

		// 9. Runtime smoke + post-activation availability: JEV-015
		const smokePassed = await this.mechanicalVerifier.verifyActivation(activationRes.projection, spec);
		if (!smokePassed) {
			throw new Error(`Mechanical activation verification failed for capability '${capabilityId}'`);
		}
		const jev015Cert = await this.steering.requireCertificate(
			"JEV-015",
			{
				spec,
				activation: activationRes.projection,
				smokePassed: true,
				ownerOperationId:
					(activationRes.projection as Record<string, unknown>)?.operationId ?? `op-${spec.capability_id}`,
				lookupResult: (activationRes.projection as Record<string, unknown>)?.lookupResult ?? "active_verified",
				smokeEvidence: (activationRes.projection as Record<string, unknown>)?.smokeEvidence ?? "smoke_passed",
				artifactDigest: candidate.digest,
			},
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision,
				signal: input.signal,
			},
		);
		lineageCerts.push(jev015Cert.certificate_id);

		// 10. Task-specific proof: JEV-016 (PH-064: mandatory task-specific proof)
		if (!this.mechanicalVerifier.runTaskSpecificProof) {
			throw new Error("Capability synthesis requires a task-specific proof runner (PH-064)");
		}
		const taskProof = await this.mechanicalVerifier.runTaskSpecificProof(spec, input.signal);
		if (!taskProof) {
			throw new Error(`Task-specific proof failed for capability '${capabilityId}' (PH-064)`);
		}
		const jev016Cert = await this.steering.requireCertificate(
			"JEV-016",
			{
				gap,
				spec,
				taskProof,
			},
			{
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				evidenceRevision,
				signal: input.signal,
			},
		);
		lineageCerts.push(jev016Cert.certificate_id);

		// 11. Establish capability (PH-072: full certificate lineage stored)
		const record: CapabilityRecord = {
			schema_version: "1.0",
			capability_id: capabilityId,
			version: spec.version,
			kind: spec.kind,
			state: kind === "ephemeral_script" ? "active_ephemeral" : "active_session",
			artifact_uri: candidate.artifactUri ?? null,
			artifact_digest: candidate.digest,
			certificate_refs: lineageCerts,
			usage_count: 1,
			success_count: 1,
			created_at: new Date().toISOString(),
		};

		this.records.set(capabilityId, record);
		this.catalog.registerCapability(spec, record);

		return {
			capabilityId,
			kind,
			lifetime: spec.lifetime,
			spec,
			record,
			isExisting: false,
			active: activationRes.active,
			activationProof: activationRes.projection as Record<string, unknown> | undefined,
			activation: {
				active: activationRes.active,
				method: kind === "runtime_patch" ? "runtime_adaptation_patch" : `${kind}_activation`,
				projection: activationRes.projection as Record<string, unknown> | undefined,
			},
		};
	}

	/**
	 * Evaluates retention for a synthesized capability.
	 * S1A-142: JEV-029 capability retention.
	 */
	async evaluateRetention(
		capability: EstablishedCapability,
		options: { objectiveId: string; taskId: string; evidenceRevision?: number },
	): Promise<CapabilityLifetime | "discard"> {
		const cert = await this.steering.requireCertificate(
			"JEV-029",
			{
				capability: capability.spec,
				record: capability.record,
			},
			{
				objectiveId: options.objectiveId,
				taskId: options.taskId,
				evidenceRevision: options.evidenceRevision ?? 1,
			},
		);

		const actionChoice = (cert.answers.lifecycle_action as { choice?: string })?.choice;
		if (!actionChoice) {
			throw new SteeringProtocolError("Missing lifecycle_action answer for JEV-029 capability retention", "JEV-029");
		}

		if (actionChoice === "project" || actionChoice === "global") {
			// S1A-143: JEV-030 capability promotion
			await this.steering.requireCertificate(
				"JEV-030",
				{
					capability: capability.spec,
					targetScope: actionChoice,
				},
				{
					objectiveId: options.objectiveId,
					taskId: options.taskId,
					evidenceRevision: options.evidenceRevision ?? 1,
				},
			);

			// S1A-145: Promoted capability enters catalog
			const updatedSpec: CapabilitySpec = {
				...capability.spec,
				lifetime: actionChoice,
			};
			const updatedRecord: CapabilityRecord = {
				...capability.record,
				state: actionChoice === "global" ? "active_global" : "active_project",
				updated_at: new Date().toISOString(),
			};
			this.catalog.registerCapability(updatedSpec, updatedRecord);
			return actionChoice;
		}

		if (actionChoice === "session" || actionChoice === "discard") {
			if (actionChoice === "discard") {
				// S1A-144: One-shot discard
				const discardedRecord: CapabilityRecord = {
					...capability.record,
					state: "discarded",
					updated_at: new Date().toISOString(),
				};
				this.records.set(capability.capabilityId, discardedRecord);
				return "discard";
			}
			return "session";
		}

		return "one_shot";
	}
}
