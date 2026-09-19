/**
 * Steering decision programs and question packs for JEV-001 through JEV-045.
 * Normative reference: STEERING_DECISION_PROGRAMS.md and MANDATORY_JEV_CHECKPOINTS.md
 * Implements typed Decision Kernel integration (PH-001..PH-005, PH-011, PH-066).
 */

import type { DecisionDefinition } from "../decision/primitives.ts";
import { createDecisionProgram, type DecisionProgram } from "../decision/program.ts";
import { canonicalDigest } from "./canonical.ts";
import type { SteeringCertificateQuestionPackRef } from "./types.ts";

export type QuestionKind = "noul" | "choice" | "score";

export interface SteeringQuestionDef {
	readonly id: string;
	readonly kind: QuestionKind;
	readonly description: string;
	readonly options?: readonly string[];
}

export interface SteeringQuestionPack {
	readonly id: string;
	readonly version: string;
	readonly checkpointIds: readonly string[];
	readonly questions: readonly SteeringQuestionDef[];
}

export function computeQuestionPackDigest(pack: SteeringQuestionPack | DecisionProgram): string {
	return canonicalDigest(pack);
}

function compileCandidateFitChoices(
	rawCandidates: unknown,
	decisions: DecisionDefinition[],
	params: {
		fallback: string;
		describe: (item: Record<string, unknown>) => string;
		formatFitInstruction: (id: string) => string;
	},
): Record<string, { description: string }> {
	const list = Array.isArray(rawCandidates) ? (rawCandidates as Array<Record<string, unknown>>) : [];
	const options: Record<string, { description: string }> = {};
	if (list.length === 0) {
		options.none = { description: params.fallback };
		return options;
	}
	for (const item of list) {
		const id = String(item.id ?? "unknown");
		options[id] = { description: params.describe(item) };
		decisions.push({
			kind: "boolean",
			id: `fits::${id}`,
			instruction: params.formatFitInstruction(id),
		});
	}
	return options;
}

export function compileDecisionProgramForCheckpoint(checkpointId: string, state: unknown): DecisionProgram {
	const decisions: DecisionDefinition[] = [];
	const s = (state ?? {}) as Record<string, unknown>;

	switch (checkpointId) {
		case "JEV-001":
		case "JEV-002":
		case "JEV-003": {
			decisions.push(
				{ kind: "boolean", id: "objective_coherent", instruction: "Is the objective clear and coherent?" },
				{
					kind: "boolean",
					id: "acceptance_complete",
					instruction: "Are all requested behaviors covered in acceptance criteria?",
				},
				{
					kind: "score",
					id: "ambiguity_severity",
					instruction: "How severe is remaining ambiguity (0=none, 3=fatal)?",
					levels: [
						{ value: 0, description: "No ambiguity" },
						{ value: 1, description: "Minor ambiguity" },
						{ value: 2, description: "Significant ambiguity" },
						{ value: 3, description: "Fatal ambiguity" },
					],
				},
				{ kind: "boolean", id: "missing_information", instruction: "Is critical information missing?" },
				{
					kind: "choice",
					id: "requested_delivery_class",
					instruction: "Target deliverable class",
					options: {
						code_fix: { description: "Bug fix or correction" },
						new_feature: { description: "New functional capability" },
						refactor: { description: "Structural refactoring" },
						investigation: { description: "Investigation or audit" },
						release: { description: "Release or packaging" },
						full_system: { description: "Full system synthesis" },
					},
				},
				{
					kind: "boolean",
					id: "capability_sensitive",
					instruction: "Does this require special tools or capabilities?",
				},
			);
			if (checkpointId === "JEV-003") {
				decisions.push({
					kind: "boolean",
					id: "grounding_sufficient",
					instruction: "Is repository and domain grounding sufficient?",
				});
			}
			break;
		}

		case "JEV-004":
		case "JEV-005":
		case "JEV-006":
		case "JEV-024": {
			decisions.push(
				{
					kind: "boolean",
					id: "work_remaining",
					instruction: "Is there material work remaining to reach completion?",
				},
				{
					kind: "choice",
					id: "missing_work_class",
					instruction: "Class of remaining work",
					options: {
						investigate: { description: "Inspect codebase, trace root cause" },
						implement: { description: "Author or edit code" },
						deterministic_verify: { description: "Run tests or checks" },
						independent_review: { description: "Adversarial review" },
						replan: { description: "Strategy change needed" },
						resolve_capability: { description: "Synthesize missing capability or specialist" },
						completion_candidate: { description: "Candidate ready for finalization" },
					},
				},
				{
					kind: "boolean",
					id: "evidence_sufficient",
					instruction: "Is fresh evidence sufficient for the next transition?",
				},
				{
					kind: "score",
					id: "semantic_progress",
					instruction: "Semantic progress score (0=none, 3=significant)",
					levels: [
						{ value: 0, description: "No progress" },
						{ value: 1, description: "Minor progress" },
						{ value: 2, description: "Good progress" },
						{ value: 3, description: "Significant progress" },
					],
				},
				{
					kind: "boolean",
					id: "strategy_repetition",
					instruction: "Is the current failed strategy repeating without fresh evidence?",
				},
				{ kind: "boolean", id: "context_stale", instruction: "Has the working context drifted or become stale?" },
				{
					kind: "boolean",
					id: "independent_worker_required",
					instruction: "Is an independent worker or verifier required?",
				},
				{
					kind: "boolean",
					id: "capability_escalation_required",
					instruction: "Does the task need capability escalation?",
				},
				{ kind: "boolean", id: "capability_gap_suspected", instruction: "Is a missing capability gap suspected?" },
				{
					kind: "boolean",
					id: "completion_plausible",
					instruction: "Is the objective plausibly complete on current proof?",
				},
			);
			break;
		}

		case "JEV-007": {
			// Capability wide resolution: candidate Choice over actual roster ids + needs_capability
			const rosterList = Array.isArray(s.roster) ? (s.roster as Array<Record<string, unknown>>) : [];
			const options: Record<string, { description: string }> = {};
			if (rosterList.length > 0) {
				for (const item of rosterList) {
					const id = String(item.id ?? item.capabilityId ?? "unknown");
					options[id] = { description: String(item.purpose ?? item.name ?? id) };
				}
			} else {
				options.none = { description: "No existing capability in roster" };
			}
			options.new_capability = { description: "Synthesize new capability" };

			decisions.push(
				{ kind: "boolean", id: "needs_capability", instruction: "Is a capability required to satisfy the need?" },
				{
					kind: "choice",
					id: "which_candidate",
					instruction: "Which catalog capability is most relevant?",
					options,
				},
			);
			break;
		}

		case "JEV-008": {
			// Capability deep resolution: Choice over shortlist + fits::<id> boolean per candidate + gap_remains
			const options = compileCandidateFitChoices(s.candidates, decisions, {
				fallback: "No shortlisted candidate fits",
				describe: (item) => String(item.purpose ?? item.kind ?? item.id ?? "unknown"),
				formatFitInstruction: (id) => `Does candidate '${id}' fulfill the required capability need?`,
			});

			decisions.push(
				{
					kind: "choice",
					id: "which_candidate",
					instruction: "Best fitting shortlisted capability candidate",
					options,
				},
				{
					kind: "boolean",
					id: "gap_remains",
					instruction: "Does a capability gap remain after evaluating shortlisted candidates?",
				},
			);
			break;
		}

		case "JEV-009": {
			decisions.push(
				{ kind: "boolean", id: "gap_confirmed", instruction: "Is the capability gap confirmed?" },
				{
					kind: "boolean",
					id: "adaptation_needed",
					instruction: "Is autonomous synthesis of this capability justified?",
				},
				{
					kind: "choice",
					id: "min_adaptation_tier",
					instruction: "Minimum required adaptation tier",
					options: {
						standard: { description: "Standard tool or script" },
						advanced: { description: "Advanced extension or adapter" },
						critical: { description: "Core runtime modification" },
					},
				},
			);
			break;
		}

		case "JEV-010": {
			decisions.push(
				{
					kind: "choice",
					id: "adaptation_class",
					instruction: "Choose smallest adequate adaptation class",
					options: {
						ephemeral_script: { description: "Task-scoped single-use script" },
						toolkit_script: { description: "Reusable repository toolkit script" },
						extension_or_tool: { description: "Live registered extension tool" },
						skill: { description: "Model skill or procedural guideline" },
						integration_or_adapter: { description: "External integration adapter" },
						runtime_patch: { description: "Runtime modification with supervisor rollback" },
						compose: { description: "Composition of existing capabilities" },
					},
				},
				{ kind: "boolean", id: "risk_acceptable", instruction: "Are side-effects and risk bounded?" },
			);
			break;
		}

		case "JEV-011": {
			decisions.push(
				{ kind: "boolean", id: "spec_complete", instruction: "Is CapabilitySpec completely defined?" },
				{ kind: "boolean", id: "interface_sound", instruction: "Are inputs and outputs bounded and typed?" },
				{
					kind: "boolean",
					id: "side_effects_bounded",
					instruction: "Are denied behaviors and side effects explicit?",
				},
				{
					kind: "boolean",
					id: "test_strategy_viable",
					instruction: "Are isolated and task-specific tests specified?",
				},
			);
			break;
		}

		case "JEV-012": {
			// PH-066: JEV-012 capability synthesis plan validation
			decisions.push(
				{ kind: "boolean", id: "plan_viable", instruction: "Is the capability builder plan viable and bounded?" },
				{
					kind: "boolean",
					id: "architecture_fit",
					instruction: "Does the proposed implementation fit architectural boundaries?",
				},
				{
					kind: "boolean",
					id: "builder_profile_sound",
					instruction: "Is the builder attempt configuration safe and sound?",
				},
			);
			break;
		}

		case "JEV-013": {
			decisions.push(
				{
					kind: "boolean",
					id: "spec_fulfilled",
					instruction: "Did candidate pass mechanical verification against spec?",
				},
				{ kind: "boolean", id: "tests_valid", instruction: "Are deterministic candidate tests passing?" },
				{ kind: "boolean", id: "safety_satisfied", instruction: "Are safety boundaries and invariants intact?" },
			);
			break;
		}

		case "JEV-014": {
			decisions.push(
				{ kind: "boolean", id: "scope_bounded", instruction: "Is runtime modification scope strictly bounded?" },
				{ kind: "boolean", id: "rollback_safe", instruction: "Is pre-mutation rollback snapshot verified?" },
				{ kind: "boolean", id: "invariants_preserved", instruction: "Are core supervisor invariants preserved?" },
			);
			break;
		}

		case "JEV-015": {
			decisions.push(
				{ kind: "boolean", id: "activation_succeeded", instruction: "Did capability activate cleanly in runtime?" },
				{ kind: "boolean", id: "runtime_healthy", instruction: "Did runtime smoke verification pass?" },
				{
					kind: "boolean",
					id: "capability_available",
					instruction: "Is the newly activated capability discoverable and usable?",
				},
			);
			break;
		}

		case "JEV-016": {
			decisions.push(
				{
					kind: "boolean",
					id: "task_proof_passed",
					instruction: "Did task-specific proof pass with actual evidence?",
				},
				{ kind: "boolean", id: "regression_absent", instruction: "Are side-effects and regressions absent?" },
				{
					kind: "boolean",
					id: "commit_approved",
					instruction: "Is candidate capability approved for persistent catalog commit?",
				},
			);
			break;
		}

		case "JEV-017": {
			decisions.push(
				{
					kind: "boolean",
					id: "claim_supported",
					instruction: "Is the worker claim supported by produced evidence?",
				},
				{
					kind: "boolean",
					id: "evidence_sufficient",
					instruction: "Is evidence complete for worker turn finalization?",
				},
			);
			break;
		}

		case "JEV-018": {
			decisions.push(
				{
					kind: "boolean",
					id: "patch_matches_requirements",
					instruction: "Does code mutation match objective requirements?",
				},
				{
					kind: "boolean",
					id: "side_effects_acceptable",
					instruction: "Are all side effects within authorized envelope?",
				},
			);
			break;
		}

		case "JEV-019": {
			decisions.push(
				{ kind: "boolean", id: "bug_reproduced", instruction: "Was the defect reproduced before fix?" },
				{ kind: "boolean", id: "fix_verified", instruction: "Is fix verified by targeted regression test?" },
				{ kind: "boolean", id: "causal_link_proven", instruction: "Is causal link between change and fix proven?" },
			);
			break;
		}

		case "JEV-020": {
			decisions.push(
				{
					kind: "boolean",
					id: "boundaries_respected",
					instruction: "Are coordinator and module boundaries respected?",
				},
				{ kind: "boolean", id: "invariants_held", instruction: "Are architectural doctrine invariants preserved?" },
			);
			break;
		}

		case "JEV-021": {
			decisions.push(
				{
					kind: "boolean",
					id: "test_coverage_sufficient",
					instruction: "Is regression coverage adequate for changed code?",
				},
				{
					kind: "boolean",
					id: "negative_tests_present",
					instruction: "Are negative tests and abuse boundaries tested?",
				},
			);
			break;
		}

		case "JEV-022": {
			decisions.push(
				{
					kind: "boolean",
					id: "checks_relevant",
					instruction: "Are verification checks directly relevant to requirements?",
				},
				{
					kind: "boolean",
					id: "criteria_covered",
					instruction: "Are all acceptance criteria covered by verification?",
				},
			);
			break;
		}

		case "JEV-023": {
			decisions.push(
				{
					kind: "boolean",
					id: "repairs_sufficient",
					instruction: "Are repair tasks sufficient to clear failed gates?",
				},
				{
					kind: "boolean",
					id: "root_cause_addressed",
					instruction: "Is root cause addressed rather than symptomatic patch?",
				},
			);
			break;
		}

		case "JEV-025": {
			decisions.push(
				{
					kind: "boolean",
					id: "acceptance_satisfied",
					instruction: "Are all objective acceptance criteria proven satisfied?",
				},
				{
					kind: "boolean",
					id: "requirements_complete",
					instruction: "Are all requested deliverables fully present?",
				},
				{
					kind: "boolean",
					id: "verification_conclusive",
					instruction: "Is verification evidence deterministic and fresh?",
				},
			);
			break;
		}

		case "JEV-026": {
			// Cold adversarial challenge
			decisions.push(
				{
					kind: "boolean",
					id: "unhandled_edge_cases",
					instruction: "Are unhandled edge cases or defects present?",
				},
				{
					kind: "boolean",
					id: "hidden_regressions",
					instruction: "Are hidden regressions or broken invariants suspected?",
				},
				{
					kind: "boolean",
					id: "assumption_violations",
					instruction: "Does delivery rely on unverified assumptions?",
				},
				{
					kind: "boolean",
					id: "adversarial_approved",
					instruction: "Does the implementation pass adversarial challenge?",
				},
			);
			break;
		}

		case "JEV-027": {
			decisions.push(
				{
					kind: "boolean",
					id: "delivery_bundle_truthful",
					instruction: "Does DeliveryBundle accurately describe delivered artifacts?",
				},
				{
					kind: "boolean",
					id: "artifacts_verified",
					instruction: "Are delivered artifacts verified against working tree?",
				},
				{
					kind: "boolean",
					id: "limitations_disclosed",
					instruction: "Are known limitations and caveats disclosed?",
				},
			);
			break;
		}

		case "JEV-028": {
			decisions.push(
				{ kind: "boolean", id: "release_ready", instruction: "Is the objective ready for release action?" },
				{
					kind: "boolean",
					id: "package_healthy",
					instruction: "Are package and artifacts healthy for publication/deployment?",
				},
				{
					kind: "boolean",
					id: "deploy_safe",
					instruction: "Is deployment to target environment authorized and safe?",
				},
			);
			break;
		}

		case "JEV-029":
		case "JEV-030": {
			decisions.push(
				{
					kind: "boolean",
					id: "demotion_recommended",
					instruction: "Should this capability be demoted or retired?",
				},
				{
					kind: "boolean",
					id: "reuse_frequency_low",
					instruction: "Has capability usage fallen below retention threshold?",
				},
			);
			break;
		}

		case "JEV-031": {
			decisions.push(
				{
					kind: "boolean",
					id: "specialist_needed",
					instruction: "Is a specialized agent/model profile needed for this task?",
				},
				{ kind: "boolean", id: "existing_fit_insufficient", instruction: "Are existing specialists insufficient?" },
				{
					kind: "choice",
					id: "specialization_type",
					instruction: "Primary specialist competency required",
					options: {
						domain_expert: { description: "Domain knowledge expert" },
						verifier: { description: "Independent verifier" },
						architect: { description: "System architect" },
						coder: { description: "Implementation specialist" },
						investigator: { description: "Defect investigator" },
					},
				},
			);
			break;
		}

		case "JEV-032": {
			// Specialist deep fit: choice best_candidate + fits::<id> per candidate + new_specialist_required
			const options = compileCandidateFitChoices(s.candidates, decisions, {
				fallback: "No existing specialist candidate",
				describe: (item) => String(item.role ?? item.specialties ?? item.id ?? "unknown"),
				formatFitInstruction: (id) => `Does specialist candidate '${id}' fulfill the task need?`,
			});

			decisions.push(
				{ kind: "choice", id: "best_candidate", instruction: "Best fitting specialist candidate", options },
				{
					kind: "boolean",
					id: "new_specialist_required",
					instruction: "Is synthesis of a new specialist required?",
				},
			);
			break;
		}

		case "JEV-033": {
			decisions.push(
				{ kind: "boolean", id: "spec_complete", instruction: "Is SpecialistSpec completely specified?" },
				{ kind: "boolean", id: "role_bounded", instruction: "Is the authority role bounded and compliant?" },
				{ kind: "boolean", id: "tools_skills_sufficient", instruction: "Are required tools and skills adequate?" },
			);
			break;
		}

		case "JEV-034": {
			decisions.push(
				{
					kind: "boolean",
					id: "dependencies_resolved",
					instruction: "Are all specialist dependencies (tools, capabilities, skills) resolved?",
				},
				{ kind: "boolean", id: "capabilities_ready", instruction: "Are required capabilities active and usable?" },
				{
					kind: "boolean",
					id: "tools_available",
					instruction: "Are declared tools available in worker environment?",
				},
			);
			break;
		}

		case "JEV-035": {
			decisions.push(
				{
					kind: "boolean",
					id: "contract_sound",
					instruction: "Is the WorkerExecutionContract complete and valid?",
				},
				{
					kind: "boolean",
					id: "authority_bounded",
					instruction: "Does worker authority stay within its profile ceiling?",
				},
				{
					kind: "boolean",
					id: "within_charter",
					instruction: "Is worker execution contract within parent execution charter?",
				},
			);
			break;
		}

		case "JEV-036": {
			decisions.push(
				{
					kind: "boolean",
					id: "mission_fulfilled",
					instruction: "Did the specialist fulfill its assigned mission?",
				},
				{ kind: "boolean", id: "proof_satisfied", instruction: "Were proof obligations satisfied with evidence?" },
				{ kind: "boolean", id: "errors_cleared", instruction: "Were any execution errors resolved?" },
			);
			break;
		}

		case "JEV-037": {
			decisions.push(
				{
					kind: "boolean",
					id: "quality_acceptable",
					instruction: "Is specialist execution outcome of high quality?",
				},
				{ kind: "boolean", id: "reusability_high", instruction: "Is this specialist worth retaining in catalog?" },
			);
			break;
		}

		case "JEV-038":
		case "JEV-039": {
			decisions.push(
				{
					kind: "choice",
					id: "lifecycle_choice",
					instruction: "Recommended specialist retention lifecycle",
					options: {
						retain_one_task: { description: "Discard after single task" },
						retain_session: { description: "Retain across active session" },
						promote_project: { description: "Promote to project-level specialist" },
						demote_ephemeral: { description: "Demote to ephemeral" },
						retire: { description: "Retire specialist permanently" },
					},
				},
				{
					kind: "boolean",
					id: "performance_adequate",
					instruction: "Has specialist delivered verified positive outcomes?",
				},
			);
			break;
		}

		case "JEV-040": {
			decisions.push(
				{
					kind: "choice",
					id: "lowest_adequate_adaptation",
					instruction: "Select lowest adequate adaptation tier",
					options: {
						strategy: { description: "Adjust plan, prompt, or parameters without changing tools" },
						expert_reroute: { description: "Switch routing band or model within existing fleet" },
						specialist: { description: "Synthesize specialized worker role and profile" },
						capability: { description: "Synthesize new tool, script, skill, or adapter" },
						runtime: { description: "Modify core runtime code with rollback protection" },
					},
				},
				{
					kind: "choice",
					id: "specialist_domain",
					instruction: "Target specialist domain if specialist adaptation is chosen",
					options: {
						ui_ux: { description: "User interface and visual design specialist" },
						architecture: { description: "System architecture specialist" },
						performance: { description: "Performance and optimization specialist" },
						security: { description: "Security and isolation specialist" },
						general_coder: { description: "General implementation coder" },
					},
					allowUnlistedChoice: true,
				},
			);
			break;
		}

		case "JEV-041": {
			const candidatesList = Array.isArray(s.candidates) ? (s.candidates as Array<Record<string, unknown>>) : [];
			if (candidatesList.length > 0) {
				for (const item of candidatesList) {
					const id = String(item.id ?? "unknown");
					decisions.push({
						kind: "boolean",
						id: `competes::${id}`,
						instruction: `Does proposed responsibility compete with or duplicate existing responsibility '${id}'?`,
					});
				}
			}
			decisions.push(
				{
					kind: "boolean",
					id: "unique_responsibility",
					instruction: "Is proposed responsibility unique and non-competing?",
				},
				{
					kind: "boolean",
					id: "competing_existing_detected",
					instruction: "Is there an existing semantic owner for this responsibility?",
				},
			);
			break;
		}

		case "JEV-042": {
			decisions.push(
				{
					kind: "choice",
					id: "recommended_disposition",
					instruction: "Recommended responsibility disposition",
					options: {
						unique: { description: "Register as unique new responsibility" },
						reuse_existing: { description: "Reuse existing responsibility implementation" },
						extend_existing: { description: "Extend existing implementation without duplicating" },
						extract_shared: { description: "Extract shared implementation into single owner" },
						separate_required: { description: "Keep intentionally separate with explicit waiver" },
						insufficient_evidence: { description: "Insufficient evidence; more retrieval required" },
					},
				},
				{
					kind: "boolean",
					id: "same_responsibility",
					instruction: "Is this identical in intent to an existing responsibility?",
				},
			);
			break;
		}

		case "JEV-043": {
			decisions.push(
				{
					kind: "boolean",
					id: "mutations_conform_to_disposition",
					instruction: "Do file mutations conform to granted responsibility disposition?",
				},
				{
					kind: "boolean",
					id: "no_unauthorized_duplication",
					instruction: "Is the mutated code free of unauthorized semantic duplication?",
				},
				{
					kind: "boolean",
					id: "duplicate_responsibility_introduced",
					instruction: "Did this mutation introduce an unauthorized duplicate responsibility?",
				},
				{
					kind: "boolean",
					id: "intentional_waiver_applies",
					instruction: "Does an approved intentional duplication waiver apply to this mutation?",
				},
			);
			break;
		}

		case "JEV-044": {
			decisions.push(
				{
					kind: "boolean",
					id: "no_hidden_duplicates",
					instruction: "Did the final semantic dedup sweep prove zero hidden duplicates?",
				},
				{
					kind: "boolean",
					id: "single_semantic_owner",
					instruction: "Does every implemented responsibility have exactly one owner?",
				},
				{
					kind: "boolean",
					id: "unintentional_duplicate_remaining",
					instruction: "Are there unintentional duplicate responsibilities remaining?",
				},
			);
			break;
		}

		case "JEV-045": {
			decisions.push(
				{
					kind: "boolean",
					id: "waiver_valid",
					instruction: "Is the intentional duplication waiver valid for this responsibility?",
				},
				{
					kind: "boolean",
					id: "architectural_rationale_sound",
					instruction: "Is the architectural justification for duplication sound?",
				},
			);
			break;
		}

		default: {
			// Generic fallback program for unrecognized checkpoint
			decisions.push({ kind: "boolean", id: "approved", instruction: `Approve checkpoint ${checkpointId}` });
			break;
		}
	}

	return createDecisionProgram({
		id: `pi:steering:program:${checkpointId}:1.0`,
		version: "1.0.0",
		decisions,
	});
}

export const STEERING_QUESTION_PACKS: Record<string, SteeringQuestionPack> = {
	objective_intake: {
		id: "pi:steering:pack:objective_intake:1.0",
		version: "1.0",
		checkpointIds: ["JEV-001", "JEV-002", "JEV-003"],
		questions: [
			{ id: "objective_coherent", kind: "noul", description: "Is the objective clear and coherent?" },
			{
				id: "acceptance_complete",
				kind: "noul",
				description: "Are all requested behaviors covered in acceptance criteria?",
			},
			{
				id: "ambiguity_severity",
				kind: "score",
				description: "How severe is remaining ambiguity (0=none, 3=fatal)?",
			},
			{ id: "missing_information", kind: "noul", description: "Is critical information missing?" },
			{
				id: "requested_delivery_class",
				kind: "choice",
				description: "Target deliverable class",
				options: ["code_fix", "new_feature", "refactor", "investigation", "release", "full_system"],
			},
			{ id: "capability_sensitive", kind: "noul", description: "Does this require special tools or capabilities?" },
		],
	},
	objective_route: {
		id: "pi:steering:pack:objective_route:1.0",
		version: "1.0",
		checkpointIds: ["JEV-004", "JEV-005", "JEV-006", "JEV-024"],
		questions: [
			{ id: "work_remaining", kind: "noul", description: "Is there material work remaining to reach completion?" },
			{
				id: "missing_work_class",
				kind: "choice",
				description: "Class of remaining work",
				options: [
					"investigate",
					"implement",
					"deterministic_verify",
					"independent_review",
					"replan",
					"resolve_capability",
					"completion_candidate",
				],
			},
			{
				id: "evidence_sufficient",
				kind: "noul",
				description: "Is fresh evidence sufficient for the next transition?",
			},
			{
				id: "semantic_progress",
				kind: "score",
				description: "Semantic progress score (0=none, 1=minor, 2=good, 3=significant)",
			},
			{
				id: "strategy_repetition",
				kind: "noul",
				description: "Is the current failed strategy repeating without fresh evidence?",
			},
			{ id: "context_stale", kind: "noul", description: "Has the working context drifted or become stale?" },
			{
				id: "independent_worker_required",
				kind: "noul",
				description: "Is an independent worker or verifier required?",
			},
			{
				id: "capability_escalation_required",
				kind: "noul",
				description: "Does the task need capability escalation?",
			},
			{ id: "capability_gap_suspected", kind: "noul", description: "Is a missing capability gap suspected?" },
			{
				id: "completion_plausible",
				kind: "noul",
				description: "Is the objective plausibly complete on current proof?",
			},
		],
	},
};

export function findPackForCheckpoint(checkpointId: string): SteeringQuestionPack | undefined {
	for (const pack of Object.values(STEERING_QUESTION_PACKS)) {
		if (pack.checkpointIds.includes(checkpointId)) {
			return pack;
		}
	}
	// Fallback synthesized pack
	return {
		id: `pi:steering:pack:${checkpointId}:1.0`,
		version: "1.0",
		checkpointIds: [checkpointId],
		questions: [{ id: "approved", kind: "noul", description: `Approval for checkpoint ${checkpointId}` }],
	};
}

export function getQuestionPackRef(
	packOrProgram: SteeringQuestionPack | DecisionProgram,
): SteeringCertificateQuestionPackRef {
	return {
		id: packOrProgram.id,
		version: packOrProgram.version,
		digest: canonicalDigest(packOrProgram),
	};
}
