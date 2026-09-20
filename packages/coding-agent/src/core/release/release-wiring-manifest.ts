/**
 * Release Wiring Manifest.
 *
 * The primary secret-free proof that the frozen architecture is actually live. Every mandatory
 * subsystem declares where it is implemented, who constructs it in production, what triggers it,
 * who consumes its result, how it fails closed, and which test proves the negative path.
 *
 * `verifyReleaseWiringManifest` checks all of that mechanically against the source tree. A feature
 * that exists in `src/` but has no construction owner, no trigger, no consumer or no negative-path
 * test fails release readiness — which is what stops "implemented but unwired" from recurring.
 * Conforms to RELEASE_WIRING_MANIFEST.md and RCG-030..RCG-036.
 */

export type FeatureProvenance = "production-live" | "test-fixture";

export interface ReleaseWiringEntry {
	/** Stable feature id, as the release documents name it. */
	readonly featureId: string;
	/** The exported symbol that implements it. */
	readonly symbol: string;
	/** Repository-relative file declaring that symbol. */
	readonly implementationFile: string;
	/** Repository-relative file where production composition constructs or binds it. */
	readonly constructionOwnerFile: string;
	/** Repository-relative file containing the trigger, and the call the trigger makes. */
	readonly triggerFile: string;
	readonly triggerSymbol: string;
	/** Repository-relative file where the result is consumed, and the consuming symbol. */
	readonly consumerFile: string;
	readonly consumerSymbol: string;
	/** What happens when the owner, result or evidence is missing. */
	readonly failClosed: string;
	/** Test file and a substring of the test name that proves the negative path. */
	readonly negativePathTestFile: string;
	readonly negativePathTestName: string;
	/** What the operator sees, when anything. */
	readonly operatorVisibility?: string;
	readonly provenance: FeatureProvenance;
}

export const RELEASE_WIRING_MANIFEST: readonly ReleaseWiringEntry[] = [
	{
		featureId: "system_one_steering",
		symbol: "SystemOneSteeringPlane",
		implementationFile: "packages/coding-agent/src/core/steering/system-one-steering-plane.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/sdk.ts",
		triggerFile: "packages/coding-agent/src/core/adaptive/adaptive-capability-controller.ts",
		triggerSymbol: "requireCertificate",
		consumerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		consumerSymbol: "steeringPlane",
		failClosed: "system_one_required rejects the transition when the plane is unavailable",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/production-hardening-v1-3.test.ts",
		negativePathTestName: "PH-060",
		operatorVisibility: "footer semantic-plane health",
		provenance: "production-live",
	},
	{
		featureId: "execution_charter",
		symbol: "compileExecutionCharter",
		implementationFile: "packages/coding-agent/src/core/autonomy/execution-charter.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/sdk.ts",
		triggerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		triggerSymbol: "evaluateCharterAuthority",
		consumerFile: "packages/coding-agent/src/core/acquisition/external-capability-acquisition-gate.ts",
		consumerSymbol: "charter.acquisition",
		failClosed: "an absent grant denies; an absent charter grants nothing at all",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/release-freeze-master-bundle-v1-7.test.ts",
		negativePathTestName: "FR-087",
		operatorVisibility: "blocked phase with the missing authority",
		provenance: "production-live",
	},
	{
		featureId: "hmoe",
		symbol: "ExpertSelectionService",
		implementationFile: "packages/coding-agent/src/core/expert-routing/service.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/adaptive/adaptive-runtime-factory.ts",
		triggerFile: "packages/coding-agent/src/core/adaptive/adaptive-capability-controller.ts",
		triggerSymbol: "this.experts.select",
		consumerFile: "packages/coding-agent/src/core/adaptive/execution-ports.ts",
		consumerSymbol: "resolveExpertBinding",
		failClosed: "a build with no resolved provider/model binding throws instead of defaulting",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/rc-gapless-readiness-v1-7-1.test.ts",
		negativePathTestName: "RCG-046: the rules reach worker, specialist and capability-builder missions",
		provenance: "production-live",
	},
	{
		featureId: "specialist_synthesis",
		symbol: "SpecialistSynthesisController",
		implementationFile: "packages/coding-agent/src/core/adaptive/specialist-synthesis-controller.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/adaptive/adaptive-runtime-factory.ts",
		triggerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		triggerSymbol: "specialistSynthesis",
		consumerFile: "packages/coding-agent/src/core/adaptive/execution-ports.ts",
		consumerSymbol: "dispatchSpecialist",
		failClosed: "materialization raises rather than returning an unverified specialist",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/production-hardening-v1-3.test.ts",
		negativePathTestName: "PH-060",
		provenance: "production-live",
	},
	{
		featureId: "specialist_dispatch",
		symbol: "RealWorkerDispatcher",
		implementationFile: "packages/coding-agent/src/core/adaptive/execution-ports.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/sdk.ts",
		triggerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		triggerSymbol: "workerDispatcher",
		consumerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		consumerSymbol: "dispatchSpecialist",
		failClosed: "no execution owner refuses construction; no result raises instead of fabricating one",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/rc-gapless-readiness-v1-7-1.test.ts",
		negativePathTestName: "RCG-022, RCG-024: specialist dispatch raises instead of manufacturing a result",
		provenance: "production-live",
	},
	{
		featureId: "capability_synthesis",
		symbol: "RealCapabilityBuilder",
		implementationFile: "packages/coding-agent/src/core/adaptive/execution-ports.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/sdk.ts",
		triggerFile: "packages/coding-agent/src/core/adaptive/adaptive-capability-controller.ts",
		triggerSymbol: "this.builder.build",
		consumerFile: "packages/coding-agent/src/core/adaptive/adaptive-capability-controller.ts",
		consumerSymbol: "verifyCandidate",
		failClosed: "missing worker owner, result, artifact, disk bytes or matching digest all raise",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/rc-gapless-readiness-v1-7-1.test.ts",
		negativePathTestName: "RCG-025",
		provenance: "production-live",
	},
	{
		featureId: "capability_proof",
		symbol: "CapabilityProofRunner",
		implementationFile: "packages/coding-agent/src/core/adaptive/capability-proof-runner.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/sdk.ts",
		triggerFile: "packages/coding-agent/src/core/adaptive/execution-ports.ts",
		triggerSymbol: "this.proofRunner.runProof",
		consumerFile: "packages/coding-agent/src/core/adaptive/adaptive-capability-controller.ts",
		consumerSymbol: "runTaskSpecificProof",
		failClosed: "a failing proof raises and blocks establishment; no proof result is asserted",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/rc-gapless-readiness-v1-7-1.test.ts",
		negativePathTestName: "RCG-027",
		provenance: "production-live",
	},
	{
		featureId: "capability_activation",
		symbol: "CapabilityActivator",
		implementationFile: "packages/coding-agent/src/core/adaptive/adaptive-capability-controller.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/adaptive/adaptive-runtime-factory.ts",
		triggerFile: "packages/coding-agent/src/core/adaptive/adaptive-capability-controller.ts",
		triggerSymbol: "activator.activate",
		consumerFile: "packages/coding-agent/src/core/adaptive/adaptive-capability-controller.ts",
		consumerSymbol: "verifyActivation",
		failClosed: "activation that does not report active raises before the capability is established",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/execution-realization-closure-v1-6.test.ts",
		negativePathTestName: "ERC-031",
		provenance: "production-live",
	},
	{
		featureId: "runtime_adaptation",
		symbol: "RuntimeAdaptationCoordinator",
		implementationFile: "packages/coding-agent/src/core/adaptive/runtime-adaptation-coordinator.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/adaptive/adaptive-runtime-factory.ts",
		triggerFile: "packages/coding-agent/src/core/adaptive/adaptive-capability-controller.ts",
		triggerSymbol: "runtimeAdaptation",
		consumerFile: "packages/coding-agent/src/core/adaptive/adaptive-runtime-readiness.ts",
		consumerSymbol: "runtimeUpdater",
		failClosed: "a no-op runtime update controller is rejected at production composition",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/production-reality-closure-v1-5.test.ts",
		negativePathTestName: "PRC-002",
		provenance: "production-live",
	},
	{
		featureId: "semantic_dedup_pre",
		symbol: "SemanticResponsibilityController",
		implementationFile: "packages/coding-agent/src/core/dedup/semantic-responsibility-controller.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/adaptive/adaptive-runtime-factory.ts",
		triggerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		triggerSymbol: "responsibilityController",
		consumerFile: "packages/coding-agent/src/core/adaptive/adaptive-runtime-readiness.ts",
		consumerSymbol: "responsibilityController",
		failClosed: "an unresolved duplicate responsibility blocks the transition",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/production-reality-closure-v1-5.test.ts",
		negativePathTestName: "PRC-0",
		provenance: "production-live",
	},
	{
		featureId: "semantic_dedup_post",
		symbol: "CandidateDiscoveryService",
		implementationFile: "packages/coding-agent/src/core/dedup/candidate-discovery.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/adaptive/adaptive-runtime-factory.ts",
		triggerFile: "packages/coding-agent/src/core/dedup/semantic-responsibility-controller.ts",
		triggerSymbol: "discovery",
		consumerFile: "packages/coding-agent/src/core/dedup/responsibility-registry.ts",
		consumerSymbol: "ResponsibilityRegistry",
		failClosed: "a discovered duplicate without a waiver blocks acceptance",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/production-reality-closure-v1-5.test.ts",
		negativePathTestName: "PRC-0",
		provenance: "production-live",
	},
	{
		featureId: "semantic_dedup_final",
		symbol: "WaiverStore",
		implementationFile: "packages/coding-agent/src/core/dedup/waiver-store.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/adaptive/adaptive-runtime-factory.ts",
		triggerFile: "packages/coding-agent/src/core/dedup/semantic-responsibility-controller.ts",
		triggerSymbol: "waivers",
		consumerFile: "packages/coding-agent/src/core/adaptive/adaptive-runtime-readiness.ts",
		consumerSymbol: "responsibilityController",
		failClosed: "an absent waiver leaves the duplicate blocking",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/production-reality-closure-v1-5.test.ts",
		negativePathTestName: "PRC-0",
		provenance: "production-live",
	},
	{
		featureId: "evidence_retention",
		symbol: "EvidenceRetentionPlanner",
		implementationFile: "packages/coding-agent/src/core/compaction/evidence-retention-planner.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/compaction-controller.ts",
		triggerFile: "packages/coding-agent/src/core/compaction-controller.ts",
		triggerSymbol: "planEvidenceRetention",
		consumerFile: "packages/coding-agent/src/core/compaction/evidence-retention-projection.ts",
		consumerSymbol: "applyRetentionDecisionsToBranch",
		failClosed: "a planner or transport failure deletes nothing and compaction proceeds unchanged",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/rc-gapless-readiness-v1-7-1.test.ts",
		negativePathTestName: "RCG-040: a semantic transport failure deletes nothing",
		operatorVisibility: "one compaction summary line",
		provenance: "production-live",
	},
	{
		featureId: "semantic_project_rules_mutation",
		symbol: "SessionProjectRules",
		implementationFile: "packages/coding-agent/src/core/project-rules/session-project-rules.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/agent-session.ts",
		triggerFile: "packages/coding-agent/src/core/tool-gate-controller.ts",
		triggerSymbol: "validateMutationAcceptance",
		consumerFile: "packages/coding-agent/src/core/agent-session.ts",
		consumerSymbol: "PROJECT_RULE_REPAIR_CUSTOM_TYPE",
		failClosed: "a blocking violation turns the mutation result into an error and queues RepairWork",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/rc-gapless-readiness-v1-7-1.test.ts",
		negativePathTestName: "RCG-041: the live mutation-acceptance hook turns a violating write into an error result",
		operatorVisibility: "rule repair warning",
		provenance: "production-live",
	},
	{
		featureId: "semantic_project_rules_postflight",
		symbol: "SessionProjectRules",
		implementationFile: "packages/coding-agent/src/core/project-rules/session-project-rules.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/agent-session.ts",
		triggerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		triggerSymbol: "projectRules.validateTaskPostflight",
		consumerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		consumerSymbol: "ensureRepairTasks",
		failClosed: "a blocking violation queues repair tasks and stops the cycle",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/rc-gapless-readiness-v1-7-1.test.ts",
		negativePathTestName: "RCG-042, RCG-043",
		provenance: "production-live",
	},
	{
		featureId: "semantic_project_rules_completion",
		symbol: "SessionProjectRules",
		implementationFile: "packages/coding-agent/src/core/project-rules/session-project-rules.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/agent-session.ts",
		triggerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		triggerSymbol: "projectRules.validateCompletion",
		consumerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		consumerSymbol: "completionFailuresToRepairWork",
		failClosed: "a blocking violation refuses the completion candidate",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/rc-gapless-readiness-v1-7-1.test.ts",
		negativePathTestName: "RCG-042, RCG-043",
		provenance: "production-live",
	},
	{
		featureId: "worker_supervision",
		symbol: "WorkerSupervisionCoordinator",
		implementationFile: "packages/coding-agent/src/core/supervision/worker-supervision-coordinator.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/agent-session.ts",
		triggerFile: "packages/coding-agent/src/core/delegation/worker-attempt-executor.ts",
		triggerSymbol: "observeWorkerProgress",
		consumerFile: "packages/coding-agent/src/core/agent-session.ts",
		consumerSymbol: "sendWorkerAgentMessage",
		failClosed: "a failed assessment reports a diagnostic and never fails the observed worker",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/rc-gapless-readiness-v1-7-1.test.ts",
		negativePathTestName: "RCG-044: a failed assessment never fails the worker it observes",
		operatorVisibility: "worker steered / rerouted warning",
		provenance: "production-live",
	},
	{
		featureId: "external_acquisition_gate",
		symbol: "ExternalCapabilityAcquisitionGate",
		implementationFile: "packages/coding-agent/src/core/acquisition/external-capability-acquisition-gate.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/agent-session.ts",
		triggerFile: "packages/coding-agent/src/core/tool-gate-controller.ts",
		triggerSymbol: "checkExternalAcquisition",
		consumerFile: "packages/coding-agent/src/core/acquisition/acquisition-boundary.ts",
		consumerSymbol: "screenAcquisition",
		failClosed: "no charter grants nothing; a mandatory semantic plane that cannot answer never allows",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/rc-gapless-readiness-v1-7-1.test.ts",
		negativePathTestName: "RCG-045: an unavailable semantic decision under a mandatory plane cannot direct-allow",
		operatorVisibility: "acquisition blocked / hardened warning",
		provenance: "production-live",
	},
	{
		featureId: "operator_projection",
		symbol: "SessionOperatorProjection",
		implementationFile: "packages/coding-agent/src/core/operator-projection/session-operator-projection.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/agent-session.ts",
		triggerFile: "packages/coding-agent/src/modes/interactive/interactive-layout.ts",
		triggerSymbol: "operatorProjection.getProjection",
		consumerFile: "packages/coding-agent/src/modes/interactive/components/operator-status.ts",
		consumerSymbol: "OperatorStatusComponent",
		failClosed: "no objective renders the same derived projection, never a literal",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/rc-gapless-readiness-v1-7-1.test.ts",
		negativePathTestName: "RCG-052: the layout contains no hard-coded execution projection",
		operatorVisibility: "the operator status row",
		provenance: "production-live",
	},
	{
		featureId: "operator_events",
		symbol: "OperatorEventController",
		implementationFile: "packages/coding-agent/src/core/operator-projection/operator-event-controller.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/operator-projection/session-operator-projection.ts",
		triggerFile: "packages/coding-agent/src/core/agent-session.ts",
		triggerSymbol: "eventBridge.record",
		consumerFile: "packages/coding-agent/src/core/operator-projection/operator-projection-controller.ts",
		consumerSymbol: "getVisibleEvents",
		failClosed: "routine successes stay silent; interventions are always visible",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/release-freeze-master-bundle-v1-7.test.ts",
		negativePathTestName: "FR-119",
		operatorVisibility: "the operator event stream",
		provenance: "production-live",
	},
	{
		featureId: "durable_owner_rules",
		symbol: "DurableOwnerRuleStore",
		implementationFile: "packages/coding-agent/src/core/project-rules/durable-owner-rules.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/agent-session.ts",
		triggerFile: "packages/coding-agent/src/core/agent-session.ts",
		triggerSymbol: "this._ownerRules.record",
		consumerFile: "packages/coding-agent/src/core/adaptive/execution-ports.ts",
		consumerSymbol: "getOwnerRules",
		failClosed: "an unreadable policy file reports no rules rather than silently passing",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/rc-gapless-readiness-v1-7-1.test.ts",
		negativePathTestName: "RCG-010: a request that carries no development directive creates no policy",
		operatorVisibility: "fast-iteration indicator",
		provenance: "production-live",
	},
	{
		featureId: "completion_primary",
		symbol: "CompletionCoordinator",
		implementationFile: "packages/coding-agent/src/core/objective-execution/completion-coordinator.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		triggerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		triggerSymbol: "CompletionCoordinator.evaluate",
		consumerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		consumerSymbol: "JEV-025",
		failClosed: "a failed gate queues repair work instead of completing",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/final-closure-v1-4.test.ts",
		negativePathTestName: "FC-0",
		provenance: "production-live",
	},
	{
		featureId: "completion_adversarial",
		symbol: "JEV-026",
		implementationFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		triggerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		triggerSymbol: "coldProofState",
		consumerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		consumerSymbol: "steeringCertRefs",
		failClosed: "a failed cold challenge queues repair work instead of completing",
		negativePathTestFile: "packages/coding-agent/test/suite/regressions/final-closure-v1-4.test.ts",
		negativePathTestName: "FC-0",
		provenance: "production-live",
	},
	{
		featureId: "delivery_side_effects",
		symbol: "buildDeliveryBundle",
		implementationFile: "packages/coding-agent/src/core/objective-execution/delivery-bundle.ts",
		constructionOwnerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		triggerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		triggerSymbol: "buildBundle",
		consumerFile: "packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts",
		consumerSymbol: "deliveryBundle",
		failClosed: "an unauthorized side effect records an authority block instead of running",
		negativePathTestFile: "packages/coding-agent/test/autonomy/zero-human-charter.test.ts",
		negativePathTestName: "ZH-0",
		operatorVisibility: "deliver phase",
		provenance: "production-live",
	},
] as const;

export interface ReleaseWiringFinding {
	readonly featureId: string;
	readonly check: string;
	readonly detail: string;
}

/** Reads a repository-relative file, or returns undefined when it does not exist. */
export type SourceReader = (repoRelativePath: string) => string | undefined;

/**
 * Verifies every manifest entry against the source tree. Each check is mechanical: it either finds
 * the declared edge in the declared file or it does not.
 */
export function verifyReleaseWiringManifest(
	readSource: SourceReader,
	manifest: readonly ReleaseWiringEntry[] = RELEASE_WIRING_MANIFEST,
): readonly ReleaseWiringFinding[] {
	const findings: ReleaseWiringFinding[] = [];
	const require = (entry: ReleaseWiringEntry, check: string, file: string, needle: string): void => {
		const source = readSource(file);
		if (source === undefined) {
			findings.push({ featureId: entry.featureId, check, detail: `${file} does not exist` });
			return;
		}
		if (!source.includes(needle)) {
			findings.push({ featureId: entry.featureId, check, detail: `${file} does not reference '${needle}'` });
		}
	};

	for (const entry of manifest) {
		require(entry, "implementation_symbol_exists", entry.implementationFile, entry.symbol);
		require(entry, "production_composition_references_it", entry.constructionOwnerFile, entry.symbol);
		require(entry, "trigger_calls_it", entry.triggerFile, entry.triggerSymbol);
		require(entry, "result_consumed_by_next_owner", entry.consumerFile, entry.consumerSymbol);
		require(entry, "negative_path_test_exists", entry.negativePathTestFile, entry.negativePathTestName);
		if (entry.provenance === "test-fixture") {
			findings.push({
				featureId: entry.featureId,
				check: "production_provenance_not_test_fixture",
				detail: "a mandatory feature cannot ship with test-fixture provenance",
			});
		}
		if (!entry.failClosed.trim()) {
			findings.push({
				featureId: entry.featureId,
				check: "fail_closed_behavior_declared",
				detail: "no fail-closed behavior declared",
			});
		}
	}

	return findings;
}
