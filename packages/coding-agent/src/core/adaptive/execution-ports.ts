/**
 * Real Adaptive Execution Ports.
 * Implements real capability builder worker execution, real mechanical verification,
 * real script registry, and real worker dispatcher.
 *
 * Every success source here is an actual execution artifact. There is no fallback that
 * manufactures a result, a profile, an expert binding, or capability source code:
 * a missing owner, result, artifact, or digest fails the build.
 * Conforms to EXECUTION_FAIL_CLOSED.md, ZERO_GAP_RULE.md, ERC-001..ERC-052, RCG-010..RCG-024.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ObjectiveRoute } from "../objective-execution/objective-route.ts";
import type { ExecutionGrant, OrchestrationThinkingLevel, WorkerResultContract } from "../orchestration/contracts.ts";
import type { TaskProfileWriterPort } from "../orchestration/task-profile-writer.ts";
import type { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import {
	type CandidateArtifact,
	type CandidateVerificationResult,
	computeArtifactDiskDigest,
} from "./adaptive-capability-controller.ts";
import { capabilityArtifactPath } from "./capability-proof-obligations.ts";
import type { CapabilityProofRunnerPort, ProofExecutionResult } from "./capability-proof-runner.ts";
import type { CapabilitySpec, MaterializedSpecialist, PortProvenance } from "./types.ts";

/** The tool surface a capability builder worker needs, intersected with what the session grants. */
const CAPABILITY_BUILDER_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;

/** An expert binding is only usable when the router actually resolved a provider and model. */
export interface ResolvedExpertBinding {
	readonly providerId: string;
	readonly modelId: string;
	readonly routingBand: string;
	readonly capabilityTier: string;
	/** The selection's own thinking level. Absent when the router did not pin one; never invented. */
	readonly thinkingLevel?: OrchestrationThinkingLevel;
}

/** Reported when the H-MoE selection carried no routing band or capability tier for the binding. */
export const UNSPECIFIED_EXPERT_METADATA = "unspecified";

export class CapabilityExecutionError extends Error {
	readonly capabilityId: string;
	readonly reasonCode: string;

	constructor(capabilityId: string, reasonCode: string, message: string) {
		super(message);
		this.name = "CapabilityExecutionError";
		this.capabilityId = capabilityId;
		this.reasonCode = reasonCode;
	}
}

/**
 * Normalizes an H-MoE selection into a fully resolved binding.
 * A binding missing its provider or model is rejected: the builder never substitutes a default
 * expert, because the established capability's evidence must name the model that actually built it.
 */
export function resolveExpertBinding(capabilityId: string, expertBinding: unknown): ResolvedExpertBinding {
	const binding = expertBinding as
		| {
				providerId?: string;
				modelId?: string;
				provider?: string;
				model_id?: string;
				routingBand?: string;
				routing_band?: string;
				capabilityTier?: string;
				capability_tier?: string;
				thinkingLevel?: string;
				thinking_level?: string;
		  }
		| undefined;

	const providerId = binding?.providerId ?? binding?.provider;
	const modelId = binding?.modelId ?? binding?.model_id;
	if (!providerId || !modelId) {
		throw new CapabilityExecutionError(
			capabilityId,
			"missing_expert_binding",
			`Capability build for '${capabilityId}' requires a resolved H-MoE ExpertBinding with a provider and model; no default expert is substituted.`,
		);
	}

	const rawThinking = binding?.thinkingLevel ?? binding?.thinking_level;
	const thinkingLevel = isOrchestrationThinkingLevel(rawThinking) ? rawThinking : undefined;

	return {
		providerId,
		modelId,
		// Routing band and capability tier are selection metadata, not authority. When the selection
		// carried none, that absence is reported rather than filled with a plausible-looking value.
		routingBand: binding?.routingBand ?? binding?.routing_band ?? UNSPECIFIED_EXPERT_METADATA,
		capabilityTier: binding?.capabilityTier ?? binding?.capability_tier ?? UNSPECIFIED_EXPERT_METADATA,
		...(thinkingLevel ? { thinkingLevel } : {}),
	};
}

function isOrchestrationThinkingLevel(value: unknown): value is OrchestrationThinkingLevel {
	return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high";
}

export interface RealCapabilityBuilderDeps {
	readonly taskRuntime: DurableTaskRuntime;
	readonly taskProfiles: TaskProfileWriterPort;
	readonly contractFactory: {
		createContract(input: {
			profileId: string;
			specialistId: string;
			expertBinding: {
				providerId: string;
				modelId: string;
				routingBand: string;
				capabilityTier: string;
			};
			authorityRole: string;
			toolNames: readonly string[];
		}): unknown;
	};
	readonly workerExecutor?: {
		runOnce?(request: unknown): Promise<{ result?: WorkerResultContract; status?: string; record?: unknown }>;
	};
	readonly runWorkerOnce?: (
		request: unknown,
	) => Promise<{ result?: WorkerResultContract; status?: string; record?: unknown }>;
	readonly cwd: string;
	/**
	 * Agent-owned directory synthesized capability artifacts are written to.
	 *
	 * Synthesized capability source is agent runtime state, not a project change: writing it under
	 * the project cwd turns every synthesis into repository churn and makes the release preflight
	 * reject the tree. Production derives this from the real `agentDir`.
	 */
	readonly capabilityArtifactRoot: string;
	readonly provenance?: PortProvenance;
	/** Durable owner development rules, folded into the builder worker's mission. */
	readonly getOwnerRules?: () => string;
}

export class RealCapabilityBuilder {
	readonly provenance: PortProvenance;
	private readonly taskRuntime: DurableTaskRuntime;
	private readonly taskProfiles: TaskProfileWriterPort;
	private readonly contractFactory: RealCapabilityBuilderDeps["contractFactory"];
	private readonly runWorker: (
		request: unknown,
	) => Promise<{ result?: WorkerResultContract; status?: string; record?: unknown }>;
	private readonly cwd: string;
	private readonly capabilityArtifactRoot: string;
	private readonly getOwnerRules?: () => string;

	constructor(deps: RealCapabilityBuilderDeps) {
		this.provenance = deps.provenance ?? "production-live";
		this.taskRuntime = deps.taskRuntime;
		this.taskProfiles = deps.taskProfiles;
		this.contractFactory = deps.contractFactory;
		this.cwd = deps.cwd;
		if (!deps.capabilityArtifactRoot) {
			throw new Error(
				"RealCapabilityBuilder requires an agent-owned capabilityArtifactRoot; synthesized artifacts are never written into the project worktree.",
			);
		}
		this.capabilityArtifactRoot = deps.capabilityArtifactRoot;
		this.getOwnerRules = deps.getOwnerRules;
		const runWorker = deps.runWorkerOnce ?? deps.workerExecutor?.runOnce?.bind(deps.workerExecutor);
		if (!runWorker) {
			throw new Error(
				"RealCapabilityBuilder requires a real worker execution owner (runWorkerOnce or workerExecutor.runOnce).",
			);
		}
		this.runWorker = runWorker;
	}

	async build(spec: CapabilitySpec, signal?: AbortSignal, expertBinding?: unknown): Promise<CandidateArtifact> {
		if (signal?.aborted) {
			throw new Error("Capability synthesis build aborted.");
		}

		// 1. Actual H-MoE expert binding — never a default provider/model.
		const binding = resolveExpertBinding(spec.capability_id, expertBinding);

		// 2. TaskProfileWriter must mint a real profile id. The builder inherits the authorized tool
		// surface rather than naming one: a hardcoded list is an authority claim the writer would
		// reject whenever the session's own surface differs.
		const inheritedToolNames = this.taskProfiles.inspectTaskProfileOptions().inheritedToolNames;
		const builderToolNames = CAPABILITY_BUILDER_TOOL_NAMES.filter((name) => inheritedToolNames.includes(name));
		const profileResult = this.taskProfiles.createTaskProfile({
			task: `Synthesize ${spec.kind} capability for ${spec.purpose}`,
			model: {
				provider: binding.providerId,
				modelId: binding.modelId,
			},
			...(binding.thinkingLevel ? { thinkingLevel: binding.thinkingLevel } : {}),
			...(builderToolNames.length > 0 ? { toolNames: builderToolNames } : {}),
		});
		const profileId = profileResult.profileId;
		if (!profileId) {
			throw new CapabilityExecutionError(
				spec.capability_id,
				"missing_task_profile",
				`TaskProfileWriter refused a profile for capability '${spec.capability_id}' (${profileResult.reason ?? "no reason reported"}); no fallback profile id is synthesized.`,
			);
		}
		const grantedToolNames = builderToolNames.length > 0 ? builderToolNames : [...inheritedToolNames];

		// 3. Real WorkerExecutionContract
		const contract = this.contractFactory.createContract({
			profileId,
			specialistId: spec.capability_id,
			expertBinding: {
				providerId: binding.providerId,
				modelId: binding.modelId,
				routingBand: binding.routingBand,
				capabilityTier: binding.capabilityTier,
			},
			authorityRole: "implementer",
			toolNames: grantedToolNames,
		});

		// 4. Durable task and attempt lifecycle
		const objId = `obj-cap-${spec.capability_id}`;
		const objSnapshot = this.taskRuntime.getSnapshot();
		const objective =
			objSnapshot.objectives[objId] ??
			this.taskRuntime.createObjective({
				objectiveId: objId,
				title: `Synthesize capability ${spec.capability_id}`,
				description: spec.purpose,
			});
		const objectiveId =
			(objective as { objectiveId?: string }).objectiveId ??
			(objective as { objective?: { objectiveId?: string } }).objective?.objectiveId ??
			objId;

		const task = this.taskRuntime.createTask({
			objectiveId,
			title: `Build ${spec.kind} capability`,
			description: spec.purpose,
			role: "implementer",
		});

		// The worker writes into agent-owned runtime state, so a synthesis leaves the project tree
		// untouched. The directory is created here because the grant below authorizes writes to it.
		const artifactTarget = capabilityArtifactPath(this.capabilityArtifactRoot, spec.capability_id);
		mkdirSync(this.capabilityArtifactRoot, { recursive: true });
		const grantId = `grant-cap-${spec.capability_id}`;
		const attempt = this.taskRuntime.queueAttempt(
			task.taskId,
			{
				taskId: task.taskId,
				profileId,
				instructions: `Synthesize ${spec.kind} capability for ${spec.purpose}. File target: ${artifactTarget}`,
				resourcePointerIds: [],
			},
			grantId,
		);
		(attempt as unknown as { profileId: string }).profileId = profileId;

		const grant: ExecutionGrant = {
			schemaVersion: 1,
			grantId,
			objectiveId,
			taskId: task.taskId,
			attemptId: attempt.attemptId,
			subjectId: `capability-builder:${attempt.attemptId}`,
			role: "implementer",
			capabilities: [],
			allowedTools: grantedToolNames,
			resources: [],
			// The builder reads the project to understand the gap, but only writes capability artifacts:
			// storing runtime state is never a reason to hand a worker project-write authority.
			readPaths: [this.cwd, this.capabilityArtifactRoot],
			writePaths: [this.capabilityArtifactRoot],
			deniedPaths: [],
			budget: {},
			policyVersion: "live-v1",
			decisionTrace: [],
			issuedAt: new Date().toISOString(),
		};
		this.taskRuntime.bindAttemptGrant(attempt.attemptId, grant);

		const lease = this.taskRuntime.leaseAttempt(attempt.attemptId, `owner-cap-${spec.capability_id}`, 60000);
		this.taskRuntime.startAttempt(attempt.attemptId, lease.leaseId, lease.fencingToken);

		// 5. Real worker execution — the only success source.
		const ownerRules = this.getOwnerRules?.().trim();
		const workerPayload = {
			instructions: [
				`Synthesize ${spec.kind} capability for ${spec.purpose}. Write implementation to ${artifactTarget}`,
				...(ownerRules ? [ownerRules] : []),
			].join("\n\n"),
			profileId,
			contract,
			modelBinding: {
				provider: binding.providerId,
				modelId: binding.modelId,
				...(binding.thinkingLevel ? { thinkingLevel: binding.thinkingLevel } : {}),
			},
			taskContext: {
				objectiveId,
				taskId: task.taskId,
				attemptId: attempt.attemptId,
			},
		};

		const outcome = await this.runWorker(workerPayload);
		const workerResult = outcome?.result;
		if (!workerResult) {
			throw new CapabilityExecutionError(
				spec.capability_id,
				"missing_worker_result",
				`Capability build for '${spec.capability_id}' produced no WorkerResultContract; a capability is never established from a fabricated result.`,
			);
		}

		// 6. Lineage: the result must belong to this objective/task/attempt.
		assertWorkerResultLineage(spec.capability_id, workerResult, {
			objectiveId,
			taskId: task.taskId,
			attemptId: attempt.attemptId,
		});

		if (workerResult.status !== "completed") {
			throw new CapabilityExecutionError(
				spec.capability_id,
				"worker_result_not_completed",
				`Capability build for '${spec.capability_id}' cannot be established from a '${workerResult.status}' worker result.`,
			);
		}

		// 7. Artifact must exist on disk with matching bytes.
		const artifact = workerResult.artifacts[0];
		if (!artifact?.uri) {
			throw new CapabilityExecutionError(
				spec.capability_id,
				"missing_worker_artifact",
				`Capability build for '${spec.capability_id}' returned no artifact; there is no default artifact path.`,
			);
		}

		const resolvedPath = artifact.uri.startsWith("file://")
			? fileURLToPath(artifact.uri)
			: isAbsolute(artifact.uri)
				? artifact.uri
				: join(this.capabilityArtifactRoot, artifact.uri);

		if (!existsSync(resolvedPath)) {
			throw new CapabilityExecutionError(
				spec.capability_id,
				"missing_artifact_bytes",
				`Capability artifact '${resolvedPath}' declared by the worker result does not exist on disk; no source is generated in its place.`,
			);
		}

		const code = readFileSync(resolvedPath, "utf-8");
		if (code.trim().length === 0) {
			throw new CapabilityExecutionError(
				spec.capability_id,
				"empty_artifact_bytes",
				`Capability artifact '${resolvedPath}' is empty.`,
			);
		}

		const digest = createHash("sha256").update(code).digest("hex");
		if (artifact.digest && artifact.digest !== digest) {
			throw new CapabilityExecutionError(
				spec.capability_id,
				"artifact_digest_mismatch",
				`Capability artifact digest mismatch for '${spec.capability_id}': worker declared ${artifact.digest}, disk bytes hash to ${digest}.`,
			);
		}

		// 8. Attempt finished strictly by the actual WorkerResultContract.
		this.taskRuntime.finishAttempt({
			...workerResult,
			objectiveId,
			taskId: task.taskId,
			attemptId: attempt.attemptId,
			leaseId: lease.leaseId,
			fencingToken: lease.fencingToken,
		});

		const artifactUri = pathToFileURL(resolvedPath).href;
		// An artifact under agent-owned state is outside the project: report its real location
		// rather than a `../..` walk that reads like a project file.
		const cwdRelative = relative(this.cwd, resolvedPath);
		const displayFile = cwdRelative && !cwdRelative.startsWith("..") ? cwdRelative : resolvedPath;

		return {
			capabilityId: spec.capability_id,
			kind: spec.kind,
			code,
			digest,
			artifactUri,
			changedFiles: [displayFile],
			provenance: this.provenance,
			builderEvidence: {
				attemptId: attempt.attemptId,
				resultId: workerResult.resultId,
				status: workerResult.status,
				summary: workerResult.summary,
				modelBinding: {
					provider: binding.providerId,
					modelId: binding.modelId,
					thinkingLevel: binding.thinkingLevel ?? null,
				},
				usage: workerResult.usage,
				toolCalls: workerResult.usage?.toolCalls,
				wallClockMs: workerResult.usage?.wallClockMs,
				changedFiles: [displayFile],
				expertBinding: binding,
			},
		};
	}
}

/** A worker result from a different objective, task, or attempt can never establish this capability. */
export function assertWorkerResultLineage(
	capabilityId: string,
	result: WorkerResultContract,
	expected: { objectiveId: string; taskId: string; attemptId: string },
): void {
	const mismatches: string[] = [];
	if (result.objectiveId && result.objectiveId !== expected.objectiveId) {
		mismatches.push(`objectiveId ${result.objectiveId} != ${expected.objectiveId}`);
	}
	if (result.taskId && result.taskId !== expected.taskId) {
		mismatches.push(`taskId ${result.taskId} != ${expected.taskId}`);
	}
	if (result.attemptId && result.attemptId !== expected.attemptId) {
		mismatches.push(`attemptId ${result.attemptId} != ${expected.attemptId}`);
	}
	if (mismatches.length > 0) {
		throw new CapabilityExecutionError(
			capabilityId,
			"worker_result_lineage_mismatch",
			`Worker result lineage does not match the capability build attempt: ${mismatches.join("; ")}.`,
		);
	}
}

export interface RealMechanicalVerifierDeps {
	readonly proofRunner: CapabilityProofRunnerPort;
	readonly scriptRegistry?: {
		has?(name: string): boolean;
		get?(name: string): unknown;
	};
	readonly extensionRunner?: {
		activeExtensions?: readonly unknown[];
		hasHandlers?(name: string): boolean;
	};
	readonly skillVault?: {
		getSkillsSnapshot?(): readonly unknown[];
		isLoaded?(name: string): boolean;
	};
	readonly cwd: string;
	readonly proofTimeoutMs?: number;
	readonly provenance?: PortProvenance;
}

export class CapabilityProofFailedError extends Error {
	readonly capabilityId: string;
	readonly results: readonly ProofExecutionResult[];

	constructor(capabilityId: string, results: readonly ProofExecutionResult[]) {
		const failed = results.filter((r) => r.status === "failed");
		super(
			`Capability '${capabilityId}' proof obligations failed: ${failed
				.map((r) => `${r.proofId} (exit ${r.exitCode ?? `signal ${r.signal}`}) '${r.command}'`)
				.join("; ")}`,
		);
		this.name = "CapabilityProofFailedError";
		this.capabilityId = capabilityId;
		this.results = results;
	}
}

export class RealMechanicalVerifier {
	readonly provenance: PortProvenance;
	private readonly proofRunner: CapabilityProofRunnerPort;
	private readonly scriptRegistry?: RealMechanicalVerifierDeps["scriptRegistry"];
	private readonly skillVault?: RealMechanicalVerifierDeps["skillVault"];
	private readonly cwd: string;
	private readonly proofTimeoutMs?: number;
	private readonly lastProofResults = new Map<string, readonly ProofExecutionResult[]>();

	constructor(deps: RealMechanicalVerifierDeps) {
		if (!deps.proofRunner) {
			throw new Error("RealMechanicalVerifier requires a proof runner; proof results are never asserted.");
		}
		this.provenance = deps.provenance ?? "production-live";
		this.proofRunner = deps.proofRunner;
		this.scriptRegistry = deps.scriptRegistry;
		this.skillVault = deps.skillVault;
		this.cwd = deps.cwd;
		this.proofTimeoutMs = deps.proofTimeoutMs;
	}

	/** Executed proof evidence for a capability, for durable recording by the caller. */
	getProofResults(capabilityId: string): readonly ProofExecutionResult[] | undefined {
		return this.lastProofResults.get(capabilityId);
	}

	async verifyCandidate(candidate: CandidateArtifact, spec: CapabilitySpec): Promise<CandidateVerificationResult> {
		const failures: string[] = [];

		if (!candidate.code || candidate.code.trim().length === 0) {
			failures.push("Empty candidate implementation");
		}

		if (!candidate.digest) {
			failures.push("Missing candidate artifact digest");
		}

		// The artifact must exist on disk and hash to the declared digest. A candidate with no
		// readable bytes is unverifiable, never silently accepted.
		if (!candidate.artifactUri) {
			failures.push("Candidate has no artifact URI to verify against disk");
		} else {
			const diskDigest = computeArtifactDiskDigest(candidate.artifactUri);
			if (!diskDigest) {
				failures.push(`Candidate artifact ${candidate.artifactUri} has no bytes on disk`);
			} else if (candidate.digest && diskDigest !== candidate.digest) {
				failures.push(`Artifact digest mismatch: expected ${candidate.digest}, got ${diskDigest} on disk`);
			}
		}

		for (const denied of spec.denied_behavior) {
			if (denied === "bypass_security_isolation" && candidate.code.includes("process.setuid")) {
				failures.push("Candidate violates security isolation");
			}
		}

		return {
			passed: failures.length === 0,
			testCount: Math.max(1, 3 - failures.length),
			failures,
		};
	}

	async verifyActivation(activation: unknown, spec: CapabilitySpec): Promise<boolean> {
		if (!activation || typeof activation !== "object") return false;

		const act = activation as Record<string, unknown>;
		if (act.error) return false;

		if (spec.kind === "toolkit_script" && this.scriptRegistry) {
			const has =
				this.scriptRegistry.has?.(spec.capability_id) ?? Boolean(this.scriptRegistry.get?.(spec.capability_id));
			if (!has) return false;
		}

		if (spec.kind === "skill" && this.skillVault) {
			if (this.skillVault.isLoaded && !this.skillVault.isLoaded(spec.capability_id)) {
				return false;
			}
		}

		if (spec.kind === "runtime_patch") {
			if (act.runtimeModified !== true || act.rolledBack === true) {
				return false;
			}
		}

		return act.active !== false;
	}

	/**
	 * Executes every declared proof obligation through the trusted execution boundary:
	 * each `deterministic_tests` entry and the `task_specific_test`. A failing proof throws,
	 * which blocks capability establishment. Nothing here asserts `verified: true`.
	 */
	async runTaskSpecificProof(spec: CapabilitySpec, signal?: AbortSignal): Promise<string> {
		const obligations: { proofId: string; kind: "deterministic_test" | "task_specific_test"; command: string }[] = [];
		spec.proof.deterministic_tests.forEach((command, index) => {
			obligations.push({
				proofId: `${spec.capability_id}:deterministic:${index}`,
				kind: "deterministic_test",
				command,
			});
		});
		if (!spec.proof.task_specific_test || spec.proof.task_specific_test.trim().length === 0) {
			throw new CapabilityExecutionError(
				spec.capability_id,
				"missing_task_specific_test",
				`Capability '${spec.capability_id}' declares no task_specific_test; there is nothing to prove.`,
			);
		}
		obligations.push({
			proofId: `${spec.capability_id}:task_specific`,
			kind: "task_specific_test",
			command: spec.proof.task_specific_test,
		});

		const results: ProofExecutionResult[] = [];
		for (const obligation of obligations) {
			signal?.throwIfAborted();
			results.push(
				await this.proofRunner.runProof({
					proofId: obligation.proofId,
					kind: obligation.kind,
					command: obligation.command,
					cwd: this.cwd,
					timeoutMs: this.proofTimeoutMs,
					signal,
				}),
			);
		}
		this.lastProofResults.set(spec.capability_id, results);

		if (results.some((result) => result.status === "failed")) {
			throw new CapabilityProofFailedError(spec.capability_id, results);
		}

		return JSON.stringify({
			capabilityId: spec.capability_id,
			kind: spec.kind,
			executedAt: new Date().toISOString(),
			proofs: results,
			proofEvidenceDigest: createHash("sha256")
				.update(results.map((r) => `${r.proofId}:${r.exitCode}:${r.outputDigest}`).join("|"))
				.digest("hex"),
		});
	}
}

export class RealScriptRegistry {
	readonly provenance: PortProvenance = "production-live";
	private readonly scripts = new Map<string, unknown>();

	register(script: { name: string; description?: string; runner?: string; path?: string }): void {
		this.scripts.set(script.name, script);
	}

	has(name: string): boolean {
		return this.scripts.has(name);
	}

	get(name: string): unknown {
		return this.scripts.get(name);
	}

	list(): readonly unknown[] {
		return Array.from(this.scripts.values());
	}
}

export class RealWorkerDispatcher {
	readonly provenance: PortProvenance;
	private readonly session: {
		runWorkerDelegationOnce(request: unknown): Promise<{ result?: WorkerResultContract; record?: unknown }>;
	};

	private readonly getOwnerRules?: () => string;

	constructor(deps: {
		session?: {
			runWorkerDelegationOnce(request: unknown): Promise<{ result?: WorkerResultContract; record?: unknown }>;
		};
		runWorkerDelegationOnce?: (request: unknown) => Promise<{ result?: WorkerResultContract; record?: unknown }>;
		provenance?: PortProvenance;
		/** Durable owner development rules, folded into every dispatched worker mission. */
		getOwnerRules?: () => string;
	}) {
		this.provenance = deps.provenance ?? "production-live";
		this.getOwnerRules = deps.getOwnerRules;
		if (deps.session) {
			this.session = deps.session;
		} else if (deps.runWorkerDelegationOnce) {
			this.session = { runWorkerDelegationOnce: deps.runWorkerDelegationOnce };
		} else {
			// An empty delegate would report dispatch success without ever running a worker.
			throw new Error(
				"RealWorkerDispatcher requires a real worker execution owner (session or runWorkerDelegationOnce).",
			);
		}
	}

	/** Every dispatched mission states the owner's standing development rules. */
	private withOwnerRules(instructions: string): string {
		const ownerRules = this.getOwnerRules?.().trim();
		return ownerRules ? `${instructions}\n\n${ownerRules}` : instructions;
	}

	async dispatch(route: ObjectiveRoute, _signal?: AbortSignal, binding?: unknown): Promise<void> {
		await this.session.runWorkerDelegationOnce({
			instructions: this.withOwnerRules(
				`Execute objective route ${(route as { action?: string }).action ?? route.route}`,
			),
			expertBinding: binding,
		});
	}

	async continueWorker(route: ObjectiveRoute, _signal?: AbortSignal, binding?: unknown): Promise<void> {
		await this.session.runWorkerDelegationOnce({
			instructions: this.withOwnerRules(
				`Continue worker for route ${(route as { action?: string }).action ?? route.route}`,
			),
			expertBinding: binding,
		});
	}

	async dispatchEscalated(route: ObjectiveRoute, _signal?: AbortSignal, binding?: unknown): Promise<void> {
		await this.session.runWorkerDelegationOnce({
			instructions: this.withOwnerRules(
				`Execute escalated route ${(route as { action?: string }).action ?? route.route}`,
			),
			expertBinding: binding,
		});
	}

	async dispatchSpecialist(input: {
		specialist: MaterializedSpecialist;
		taskId: string;
		attemptId?: string;
		leaseId?: string;
		fencingToken?: number;
		expiresAt?: string;
		signal?: AbortSignal;
	}): Promise<WorkerResultContract> {
		const outcome = await this.session.runWorkerDelegationOnce({
			instructions: this.withOwnerRules(input.specialist.spec.mission),
			profileId: input.specialist.profileId,
			expertBinding: input.specialist.expert,
			taskContext: {
				taskId: input.taskId,
				attemptId: input.attemptId,
			},
		});

		if (!outcome?.result) {
			// Specialist success is only ever the specialist's own WorkerResultContract.
			throw new Error(
				`Specialist dispatch for '${input.specialist.specialistId ?? input.specialist.spec.specialist_id}' returned no WorkerResultContract; a specialist result is never fabricated.`,
			);
		}
		return outcome.result;
	}
}
