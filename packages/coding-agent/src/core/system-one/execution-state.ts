import { createHash } from "node:crypto";
import type { PolicyPackRef } from "../hooks/index.ts";
import { PolicyPackDigestMismatchError } from "./policy-pack.ts";
import type {
	AcceptanceCriterion,
	Change,
	ChangeKind,
	ChangeOwnership,
	Claim,
	ClaimMateriality,
	ClaimStatus,
	CompletionGate,
	CompletionState,
	Constraint,
	ExecutionState,
	Hypothesis,
	HypothesisStatus,
	Objective,
	Observation,
	Phase,
	Plan,
	PlanStep,
	RepoState,
	SourceRef,
	ToolEvent,
	ToolEventStatus,
	ToolImpact,
	ValidationDecision,
	VerificationKind,
	VerificationRun,
	VerificationStatus,
	WorkerTurnResult,
} from "./types.ts";

export interface StrategyFingerprint {
	step_id: string;
	action_class: string;
	tool_intent: string;
	target_hypotheses: string[];
}

export interface ExecutionStoreOptions {
	run_id: string;
	objective: {
		request: string;
		normalized_goal: string;
		acceptance_criteria: Array<{ id: string; text: string; required?: boolean }>;
		constraints?: Array<{
			id: string;
			text: string;
			severity?: "hard" | "soft";
			source?: "user" | "repo_policy" | "harness" | "security" | "derived";
		}>;
		non_goals?: string[];
	};
	repo: {
		root: string;
		baseline_revision: string;
		current_revision?: string;
		dirty_at_start?: boolean;
		allowed_paths?: string[];
		protected_paths?: string[];
		languages?: string[];
	};
	initial_plan?: PlanStep[];
}

/** Canonical goal/runtime/verification folded into the System One store. Not a second authority. */
export interface CanonicalHydration {
	request: string;
	normalized_goal: string;
	acceptance_criteria: AcceptanceCriterion[];
	constraints: Constraint[];
	non_goals: string[];
	current_revision: string;
	plan_steps: PlanStep[];
	observations: Observation[];
	verification: VerificationRun[];
}

const VALID_ACTIONS = new Set(["inspect", "retrieve", "edit", "build", "test", "verify", "replan", "report", "none"]);
const VALID_MATERIALITIES = new Set(["informational", "material", "completion_critical"]);
const VALID_HYPOTHESIS_STATUSES = new Set(["candidate", "investigating", "supported", "rejected", "superseded"]);
const VALID_IMPACTS = new Set([
	"read_only",
	"local_reversible",
	"repo_mutation",
	"external_side_effect",
	"destructive",
]);

const ALLOWED_WORKER_TURN_KEYS = new Set([
	"run_id",
	"step_id",
	"requested_action",
	"decision_summary",
	"claims",
	"hypothesis_updates",
	"requested_tools",
	"completion_candidate",
	"known_limitations",
]);

/**
 * Validate raw worker turn against normative worker_turn.schema.json (R-071, Section 30).
 * Enforces additionalProperties: false, required fields, and enum values.
 */
export function validateWorkerTurnResult(raw: unknown): WorkerTurnResult {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new TypeError("Worker turn must be a non-null object conforming to worker_turn.schema.json");
	}

	const obj = raw as Record<string, unknown>;

	for (const key of Object.keys(obj)) {
		if (!ALLOWED_WORKER_TURN_KEYS.has(key)) {
			throw new TypeError(`Worker turn contains forbidden property '${key}' (schema forbids additionalProperties)`);
		}
	}

	if (typeof obj.run_id !== "string" || !obj.run_id) {
		throw new TypeError("Worker turn must contain a valid non-empty 'run_id' string");
	}
	if (typeof obj.step_id !== "string" || !obj.step_id) {
		throw new TypeError("Worker turn must contain a valid non-empty 'step_id' string");
	}
	if (typeof obj.requested_action !== "string" || !VALID_ACTIONS.has(obj.requested_action)) {
		throw new TypeError(`Worker turn 'requested_action' must be one of: ${[...VALID_ACTIONS].join(", ")}`);
	}
	if (typeof obj.completion_candidate !== "boolean") {
		throw new TypeError("Worker turn must contain boolean 'completion_candidate'");
	}
	if (!Array.isArray(obj.claims)) {
		throw new TypeError("Worker turn 'claims' must be an array");
	}
	if (!Array.isArray(obj.hypothesis_updates)) {
		throw new TypeError("Worker turn 'hypothesis_updates' must be an array");
	}
	if (!Array.isArray(obj.requested_tools)) {
		throw new TypeError("Worker turn 'requested_tools' must be an array");
	}
	if (obj.decision_summary !== undefined && typeof obj.decision_summary !== "string") {
		throw new TypeError("Worker turn 'decision_summary' must be a string if provided");
	}
	if (obj.known_limitations !== undefined) {
		if (!Array.isArray(obj.known_limitations) || obj.known_limitations.some((x) => typeof x !== "string")) {
			throw new TypeError("Worker turn 'known_limitations' must be an array of strings if provided");
		}
	}

	for (let i = 0; i < obj.claims.length; i++) {
		const c = obj.claims[i];
		if (typeof c !== "object" || c === null || Array.isArray(c)) {
			throw new TypeError(`Claim at index ${i} must be an object`);
		}
		const cObj = c as Record<string, unknown>;
		for (const k of Object.keys(cObj)) {
			if (k !== "text" && k !== "materiality" && k !== "evidence_refs") {
				throw new TypeError(`Claim at index ${i} contains forbidden property '${k}'`);
			}
		}
		if (typeof cObj.text !== "string" || !cObj.text) {
			throw new TypeError(`Claim at index ${i} must have a non-empty 'text' string`);
		}
		if (typeof cObj.materiality !== "string" || !VALID_MATERIALITIES.has(cObj.materiality)) {
			throw new TypeError(`Claim at index ${i} has invalid materiality: ${String(cObj.materiality)}`);
		}
		if (!Array.isArray(cObj.evidence_refs) || cObj.evidence_refs.some((r) => typeof r !== "string")) {
			throw new TypeError(`Claim at index ${i} 'evidence_refs' must be an array of string IDs`);
		}
	}

	for (let i = 0; i < obj.hypothesis_updates.length; i++) {
		const h = obj.hypothesis_updates[i];
		if (typeof h !== "object" || h === null || Array.isArray(h)) {
			throw new TypeError(`Hypothesis update at index ${i} must be an object`);
		}
		const hObj = h as Record<string, unknown>;
		for (const k of Object.keys(hObj)) {
			if (k !== "hypothesis_id" && k !== "status" && k !== "evidence_refs" && k !== "next_discriminator") {
				throw new TypeError(`Hypothesis update at index ${i} contains forbidden property '${k}'`);
			}
		}
		if (typeof hObj.hypothesis_id !== "string" || !hObj.hypothesis_id) {
			throw new TypeError(`Hypothesis update at index ${i} must have a non-empty 'hypothesis_id' string`);
		}
		if (typeof hObj.status !== "string" || !VALID_HYPOTHESIS_STATUSES.has(hObj.status)) {
			throw new TypeError(`Hypothesis update at index ${i} has invalid status: ${String(hObj.status)}`);
		}
		if (
			hObj.evidence_refs !== undefined &&
			(!Array.isArray(hObj.evidence_refs) || hObj.evidence_refs.some((r) => typeof r !== "string"))
		) {
			throw new TypeError(`Hypothesis update at index ${i} 'evidence_refs' must be an array of strings`);
		}
		if (
			hObj.next_discriminator !== undefined &&
			hObj.next_discriminator !== null &&
			typeof hObj.next_discriminator !== "string"
		) {
			throw new TypeError(`Hypothesis update at index ${i} 'next_discriminator' must be string or null`);
		}
	}

	for (let i = 0; i < obj.requested_tools.length; i++) {
		const t = obj.requested_tools[i];
		if (typeof t !== "object" || t === null || Array.isArray(t)) {
			throw new TypeError(`Requested tool at index ${i} must be an object`);
		}
		const tObj = t as Record<string, unknown>;
		for (const k of Object.keys(tObj)) {
			if (k !== "tool" && k !== "intent" && k !== "impact" && k !== "arguments") {
				throw new TypeError(`Requested tool at index ${i} contains forbidden property '${k}'`);
			}
		}
		if (typeof tObj.tool !== "string" || !tObj.tool) {
			throw new TypeError(`Requested tool at index ${i} must have a non-empty 'tool' string`);
		}
		if (typeof tObj.intent !== "string" || !tObj.intent) {
			throw new TypeError(`Requested tool at index ${i} must have a non-empty 'intent' string`);
		}
		if (typeof tObj.impact !== "string" || !VALID_IMPACTS.has(tObj.impact)) {
			throw new TypeError(`Requested tool at index ${i} has invalid impact: ${String(tObj.impact)}`);
		}
		if (
			tObj.arguments !== undefined &&
			(typeof tObj.arguments !== "object" || tObj.arguments === null || Array.isArray(tObj.arguments))
		) {
			throw new TypeError(`Requested tool at index ${i} 'arguments' must be an object if provided`);
		}
	}

	return raw as WorkerTurnResult;
}

export class ExecutionStore {
	private state: ExecutionState;
	private observationCounter = 0;
	private claimCounter = 0;
	private hypothesisCounter = 0;
	private toolEventCounter = 0;
	private changeCounter = 0;
	private verificationCounter = 0;
	private decisionCounter = 0;
	private gateCounter = 0;

	/**
	 * Failed strategy fingerprints mapped to the observation count at failure time.
	 * Used for R-045 loop detection (two substantially identical failed strategies without new evidence).
	 */
	private failedStrategies: Map<string, { count: number; lastObservationCount: number }> = new Map();

	constructor(options: ExecutionStoreOptions) {
		const now = new Date().toISOString();
		const criteria: AcceptanceCriterion[] = options.objective.acceptance_criteria.map((c, idx) => ({
			id: c.id || `AC-${idx + 1}`,
			text: c.text,
			required: c.required ?? true,
			status: "unverified",
			evidence_ids: [],
			waiver_id: null,
		}));

		const constraints: Constraint[] = (options.objective.constraints ?? []).map((c, idx) => ({
			id: c.id || `C-${idx + 1}`,
			text: c.text,
			severity: c.severity ?? "hard",
			source: c.source ?? "user",
			verified: false,
		}));

		const objective: Objective = {
			request: options.objective.request,
			normalized_goal: options.objective.normalized_goal,
			acceptance_criteria: criteria,
			constraints,
			non_goals: options.objective.non_goals ?? [],
		};

		const repo: RepoState = {
			root: options.repo.root,
			baseline_revision: options.repo.baseline_revision,
			current_revision: options.repo.current_revision ?? options.repo.baseline_revision,
			dirty_at_start: options.repo.dirty_at_start ?? false,
			allowed_paths: options.repo.allowed_paths ?? [options.repo.root],
			protected_paths: options.repo.protected_paths ?? [],
			languages: options.repo.languages ?? [],
		};

		const initialPlan: Plan = {
			version: 1,
			rationale_ref: null,
			steps: options.initial_plan ?? [],
		};

		const initialCompletion: CompletionState = {
			requested: false,
			requested_at: null,
			attempt: 0,
			gates: [],
			final_summary_ref: null,
			terminal_status: "none",
		};

		this.state = {
			run_id: options.run_id,
			schema_version: "1.0",
			created_at: now,
			updated_at: now,
			phase: "init",
			objective,
			repo,
			observations: [],
			claims: [],
			hypotheses: [],
			plan: initialPlan,
			tool_events: [],
			changes: [],
			verification: [],
			decisions: [],
			risks: [],
			completion: initialCompletion,
		};
	}

	get runId(): string {
		return this.state.run_id;
	}

	get phase(): Phase {
		return this.state.phase;
	}

	/**
	 * Transition run phase.
	 * R-001 / R-002: The worker MUST NOT mark a run complete. Only the deterministic harness policy engine may transition phase to complete.
	 */
	transitionPhase(newPhase: Phase, authorizedByHarness = false): void {
		if (newPhase === "complete" && !authorizedByHarness) {
			throw new Error("Worker or unauthorized caller cannot transition phase to complete (R-001, R-002)");
		}
		this.state.phase = newPhase;
		this.state.updated_at = new Date().toISOString();
	}

	/**
	 * The one store mutation that records terminal complete.
	 * A second call with the same proof is a duplicate. A different proof or a phase that
	 * cannot finish is rejected and does not transition again.
	 */
	noteTerminalProof(
		ref: string,
	):
		| { readonly outcome: "applied" }
		| { readonly outcome: "duplicate" }
		| { readonly outcome: "rejected"; readonly reason: "conflict" | "invalid_phase" | "empty_proof" } {
		if (!ref.trim()) {
			return { outcome: "rejected", reason: "empty_proof" };
		}
		const existing = this.state.completion.final_summary_ref ?? "";
		if (this.state.phase === "complete" || this.state.completion.terminal_status === "complete") {
			if (existing === ref) return { outcome: "duplicate" };
			return { outcome: "rejected", reason: "conflict" };
		}
		if (
			this.state.phase === "aborted" ||
			this.state.phase === "blocked_external" ||
			this.state.phase === "rollback_required"
		) {
			return { outcome: "rejected", reason: "invalid_phase" };
		}
		this.state.completion.final_summary_ref = ref;
		this.state.completion.terminal_status = "complete";
		this.transitionPhase("complete", true);
		return { outcome: "applied" };
	}

	getObjective(): Readonly<Objective> {
		return this.state.objective;
	}

	hasLiveObjective(): boolean {
		return this.state.objective.request.trim().length > 0 || this.state.objective.normalized_goal.trim().length > 0;
	}

	/**
	 * Replace objective, plan, observations, and verification from canonical session truth.
	 * Tool events, decisions, claims, and completion records stay with this store.
	 */
	hydrateFromCanonical(input: CanonicalHydration): void {
		this.state.objective = {
			request: input.request,
			normalized_goal: input.normalized_goal,
			acceptance_criteria: input.acceptance_criteria,
			constraints: input.constraints,
			non_goals: input.non_goals,
		};
		this.state.plan = {
			version: this.state.plan.version,
			rationale_ref: this.state.plan.rationale_ref ?? null,
			steps: input.plan_steps,
		};
		this.state.observations = input.observations;
		this.state.verification = input.verification;
		this.state.repo.current_revision = input.current_revision;
		this.state.updated_at = new Date().toISOString();
	}

	getRepo(): Readonly<RepoState> {
		return this.state.repo;
	}

	updateRepoRevision(currentRevision: string): void {
		this.state.repo.current_revision = currentRevision;
		this.state.updated_at = new Date().toISOString();
	}

	verifyConstraint(constraintId: string): void {
		const constraint = this.state.objective.constraints.find((c) => c.id === constraintId);
		if (constraint) {
			constraint.verified = true;
		}
		this.state.updated_at = new Date().toISOString();
	}

	/**
	 * Record an observed fact with immutable locator and sha256 content hash.
	 * R-009 / R-010: Evidence MUST include an immutable locator and content hash.
	 */
	recordObservation(input: {
		text: string;
		source: Omit<SourceRef, "content_hash"> & { content_hash?: string; content?: string };
		tags?: string[];
	}): Observation {
		this.observationCounter++;
		const id = `OBS-${this.observationCounter}`;
		let contentHash = input.source.content_hash;
		if (!contentHash && input.source.content !== undefined) {
			contentHash = createHash("sha256").update(input.source.content).digest("hex");
		}
		if (!contentHash) {
			contentHash = createHash("sha256").update(input.text).digest("hex");
		}

		const source: SourceRef = {
			kind: input.source.kind,
			locator: input.source.locator,
			content_hash: contentHash,
			revision: input.source.revision ?? this.state.repo.current_revision,
			line_start: input.source.line_start ?? null,
			line_end: input.source.line_end ?? null,
			trust: input.source.trust,
		};

		const observation: Observation = {
			id,
			text: input.text,
			source,
			freshness: "fresh",
			status: "observed",
			tags: input.tags,
		};

		this.state.observations.push(observation);
		this.state.updated_at = new Date().toISOString();
		return observation;
	}

	/**
	 * Record worker claim with materiality and fresh evidence references.
	 * R-009: Every material or completion-critical claim MUST reference fresh evidence.
	 * R-012: Conversation summaries or prior assertions MUST NOT be treated as evidence.
	 */
	recordClaim(input: { text: string; materiality: ClaimMateriality; evidence_ids: string[] }): Claim {
		this.claimCounter++;
		const id = `CLM-${this.claimCounter}`;

		// Verify evidence exists and is fresh
		const freshEvidence = input.evidence_ids.filter((eid) => {
			const obs = this.state.observations.find((o) => o.id === eid);
			return obs && obs.freshness === "fresh";
		});

		let status: ClaimStatus = "proposed";
		if (input.materiality !== "informational" && freshEvidence.length === 0) {
			status = "unverified";
		}

		const claim: Claim = {
			id,
			text: input.text,
			materiality: input.materiality,
			status,
			evidence_ids: input.evidence_ids,
			decision_ids: [],
		};

		this.state.claims.push(claim);
		this.state.updated_at = new Date().toISOString();
		return claim;
	}

	updateClaimStatus(claimId: string, status: ClaimStatus, decisionId?: string): void {
		const claim = this.state.claims.find((c) => c.id === claimId);
		if (!claim) {
			throw new Error(`Claim not found: ${claimId}`);
		}
		claim.status = status;
		if (decisionId && !claim.decision_ids?.includes(decisionId)) {
			claim.decision_ids = [...(claim.decision_ids ?? []), decisionId];
		}
		this.state.updated_at = new Date().toISOString();
	}

	/**
	 * Record or update a competing causal/design hypothesis.
	 * R-016: Bug hunts MUST preserve competing hypotheses until evidence rejects or supports them.
	 */
	recordHypothesis(input: {
		text: string;
		supporting_evidence?: string[];
		contradicting_evidence?: string[];
		next_discriminator?: string | null;
		parent_hypothesis_id?: string | null;
	}): Hypothesis {
		this.hypothesisCounter++;
		const id = `HYP-${this.hypothesisCounter}`;
		const hypothesis: Hypothesis = {
			id,
			text: input.text,
			status: "candidate",
			supporting_evidence: input.supporting_evidence ?? [],
			contradicting_evidence: input.contradicting_evidence ?? [],
			next_discriminator: input.next_discriminator ?? null,
			parent_hypothesis_id: input.parent_hypothesis_id ?? null,
		};
		this.state.hypotheses.push(hypothesis);
		this.state.updated_at = new Date().toISOString();
		return hypothesis;
	}

	updateHypothesis(
		hypothesisId: string,
		update: {
			status?: HypothesisStatus;
			supporting_evidence?: string[];
			contradicting_evidence?: string[];
			next_discriminator?: string | null;
		},
	): void {
		const hyp = this.state.hypotheses.find((h) => h.id === hypothesisId);
		if (!hyp) {
			throw new Error(`Hypothesis not found: ${hypothesisId}`);
		}
		if (update.status) hyp.status = update.status;
		if (update.supporting_evidence) {
			hyp.supporting_evidence = Array.from(new Set([...hyp.supporting_evidence, ...update.supporting_evidence]));
		}
		if (update.contradicting_evidence) {
			hyp.contradicting_evidence = Array.from(
				new Set([...hyp.contradicting_evidence, ...update.contradicting_evidence]),
			);
		}
		if (update.next_discriminator !== undefined) {
			hyp.next_discriminator = update.next_discriminator;
		}
		this.state.updated_at = new Date().toISOString();
	}

	/**
	 * Record requested tool execution and persist hashes.
	 * R-041: Every tool action MUST persist intent, impact class, status, input hash, output hash, produced observation refs.
	 */
	recordToolEvent(input: {
		tool: string;
		intent: string;
		impact: ToolImpact;
		status: ToolEvent["status"];
		input_payload?: unknown;
		output_payload?: unknown;
		observation_ids?: string[];
		call_id?: string;
		reason?: string;
	}): ToolEvent {
		this.toolEventCounter++;
		const id = `TE-${this.toolEventCounter}`;
		const input_hash =
			input.input_payload !== undefined
				? createHash("sha256").update(JSON.stringify(input.input_payload)).digest("hex")
				: null;
		const output_hash =
			input.output_payload !== undefined
				? createHash("sha256").update(JSON.stringify(input.output_payload)).digest("hex")
				: null;

		const event: ToolEvent = {
			id,
			tool: input.tool,
			intent: input.intent,
			impact: input.impact,
			status: input.status,
			timestamp: new Date().toISOString(),
			input_hash,
			output_hash,
			observation_ids: input.observation_ids ?? [],
			...(input.call_id ? { call_id: input.call_id } : {}),
			...(input.reason ? { reason: input.reason } : {}),
		};

		this.state.tool_events.push(event);
		this.state.updated_at = new Date().toISOString();
		return event;
	}

	/** Update the matching tool event's terminal status after execution. */
	updateToolEvent(
		match: { id?: string; call_id?: string },
		patch: { status: ToolEventStatus; output_payload?: unknown; reason?: string; observation_ids?: string[] },
	): ToolEvent | undefined {
		const event = [...this.state.tool_events].reverse().find((candidate) => {
			if (match.id && candidate.id === match.id) return true;
			if (match.call_id && candidate.call_id === match.call_id) return true;
			return false;
		});
		if (!event) return undefined;
		event.status = patch.status;
		event.timestamp = new Date().toISOString();
		if (patch.reason !== undefined) event.reason = patch.reason;
		if (patch.observation_ids) event.observation_ids = patch.observation_ids;
		if (patch.output_payload !== undefined) {
			event.output_hash = createHash("sha256").update(JSON.stringify(patch.output_payload)).digest("hex");
		}
		this.state.updated_at = new Date().toISOString();
		return event;
	}

	/**
	 * Record repository mutation or file change.
	 * R-011: Repository mutations MUST invalidate dependent observations and claim support when source hashes change.
	 * R-043: Worker MUST NOT overwrite pre-existing user changes.
	 * R-044: Automatic rollback may only revert worker-owned mutations.
	 */
	recordChange(input: {
		path: string;
		kind: ChangeKind;
		ownership: ChangeOwnership;
		diff_content?: string;
		diff_hash?: string | null;
		related_claim_ids?: string[];
		related_step_ids?: string[];
	}): Change {
		this.changeCounter++;
		const id = `CHG-${this.changeCounter}`;
		let diff_hash = input.diff_hash ?? null;
		if (!diff_hash && input.diff_content) {
			diff_hash = createHash("sha256").update(input.diff_content).digest("hex");
		}

		const change: Change = {
			id,
			path: input.path,
			kind: input.kind,
			status: "applied",
			ownership: input.ownership,
			diff_hash,
			related_claim_ids: input.related_claim_ids ?? [],
			related_step_ids: input.related_step_ids ?? [],
		};

		this.state.changes.push(change);

		// Invalidate dependent observations pointing to this changed path (R-011)
		this.invalidateStaleObservationsForPath(input.path);

		this.state.updated_at = new Date().toISOString();
		return change;
	}

	/**
	 * Invalidate observations associated with a modified file path.
	 * R-011 / R-047 / R-062: Mark observations stale and cascade to claims.
	 */
	invalidateStaleObservationsForPath(filePath: string): void {
		const invalidatedObsIds = new Set<string>();
		for (const obs of this.state.observations) {
			if (obs.source.kind === "file" || obs.source.kind === "symbol") {
				if (obs.source.locator.includes(filePath) || filePath.includes(obs.source.locator)) {
					obs.freshness = "stale";
					invalidatedObsIds.add(obs.id);
				}
			}
		}

		// Invalidate verification runs covering this file (R-074)
		for (const v of this.state.verification) {
			if (v.status === "passed") {
				// Code change after verification invalidates the verification (R-074)
				v.status = "inconclusive";
			}
		}

		// Re-evaluate claims relying on invalidated observations (R-054, R-072)
		for (const claim of this.state.claims) {
			const hasInvalid = claim.evidence_ids.some((id) => invalidatedObsIds.has(id));
			if (hasInvalid && claim.status === "supported") {
				claim.status = "partially_supported";
			}
		}
	}

	/**
	 * Record a verification run (test, compile, lint, static analysis).
	 * R-052 / R-053 / R-074: Verification artifacts MUST be tied to exact revision/diff.
	 */
	recordVerification(input: {
		kind: VerificationKind;
		status: VerificationStatus;
		command?: string | null;
		artifact_ref?: string | null;
		covers_acceptance_ids?: string[];
		observation_ids?: string[];
	}): VerificationRun {
		this.verificationCounter++;
		const id = `VR-${this.verificationCounter}`;
		const run: VerificationRun = {
			id,
			kind: input.kind,
			status: input.status,
			timestamp: new Date().toISOString(),
			command: input.command ?? null,
			artifact_ref: input.artifact_ref ?? null,
			covers_acceptance_ids: input.covers_acceptance_ids ?? [],
			observation_ids: input.observation_ids ?? [],
		};

		this.state.verification.push(run);

		// If verification passed, update acceptance criterion status if linked
		if (input.status === "passed" && input.covers_acceptance_ids) {
			for (const acId of input.covers_acceptance_ids) {
				const criterion = this.state.objective.acceptance_criteria.find((c) => c.id === acId);
				if (criterion) {
					criterion.status = "satisfied";
					if (!criterion.evidence_ids.includes(id)) {
						criterion.evidence_ids.push(id);
					}
				}
			}
		}

		this.state.updated_at = new Date().toISOString();
		return run;
	}

	/**
	 * Record an immutable validation decision from Jev + policy engine.
	 * R-040: Every Jev decision MUST persist stage, model, catalog version, question hash, state hash, raw typed answers, policy result.
	 */
	recordDecision(decision: Omit<ValidationDecision, "id" | "timestamp">): ValidationDecision {
		this.decisionCounter++;
		const id = `DEC-${this.decisionCounter}`;
		const record: ValidationDecision = {
			id,
			...decision,
			timestamp: new Date().toISOString(),
		};
		this.state.decisions.push(record);
		this.state.updated_at = new Date().toISOString();
		return record;
	}

	/**
	 * Record completion gate status.
	 */
	recordCompletionGate(gate: Omit<CompletionGate, "id">): CompletionGate {
		this.gateCounter++;
		const id = `GATE-${this.gateCounter}`;
		const record: CompletionGate = {
			id,
			...gate,
		};
		this.state.completion.gates.push(record);
		this.state.updated_at = new Date().toISOString();
		return record;
	}

	/**
	 * Apply a worker turn result to the execution state.
	 * R-001: Worker emits completion_candidate=true; cannot mark complete itself.
	 * R-045: Track failed strategy fingerprints to prevent loops without new evidence.
	 * R-071: Validates turn against worker_turn.schema.json before applying.
	 */
	applyWorkerTurn(rawTurn: unknown): {
		isCompletionCandidate: boolean;
		loopDetected: boolean;
		failedStrategyCount: number;
	} {
		const turn = validateWorkerTurnResult(rawTurn);
		// Update claims
		for (const claimInput of turn.claims) {
			this.recordClaim({
				text: claimInput.text,
				materiality: claimInput.materiality,
				evidence_ids: claimInput.evidence_refs,
			});
		}

		// Update hypotheses
		for (const hypUpdate of turn.hypothesis_updates) {
			const existing = this.state.hypotheses.find((h) => h.id === hypUpdate.hypothesis_id);
			if (existing) {
				this.updateHypothesis(hypUpdate.hypothesis_id, {
					status: hypUpdate.status,
					supporting_evidence: hypUpdate.evidence_refs,
					next_discriminator: hypUpdate.next_discriminator,
				});
			} else {
				this.recordHypothesis({
					text: `Hypothesis ${hypUpdate.hypothesis_id}`,
					supporting_evidence: hypUpdate.evidence_refs,
					next_discriminator: hypUpdate.next_discriminator,
				});
			}
		}

		// Strategy fingerprinting for R-045 loop detection
		let loopDetected = false;
		let failedStrategyCount = 0;
		if (turn.requested_action !== "none" && turn.step_id) {
			const fp: StrategyFingerprint = {
				step_id: turn.step_id,
				action_class: turn.requested_action,
				tool_intent: turn.requested_tools
					.map((t) => `${t.tool}:${t.intent}`)
					.sort()
					.join(";"),
				target_hypotheses: turn.hypothesis_updates.map((h) => h.hypothesis_id).sort(),
			};
			const key = JSON.stringify(fp);
			const currentObsCount = this.state.observations.length;
			const existing = this.failedStrategies.get(key);
			if (existing) {
				// Same strategy attempted. Check if new evidence was observed since last failure.
				if (currentObsCount <= existing.lastObservationCount) {
					existing.count++;
					failedStrategyCount = existing.count;
					if (existing.count >= 2) {
						loopDetected = true;
					}
				} else {
					// New evidence was gained, reset count
					existing.count = 1;
					existing.lastObservationCount = currentObsCount;
					failedStrategyCount = 1;
				}
			} else {
				this.failedStrategies.set(key, { count: 1, lastObservationCount: currentObsCount });
				failedStrategyCount = 1;
			}
		}

		// Completion candidate handling (R-001: worker emits completion_candidate=true)
		const isCompletionCandidate = Boolean(turn.completion_candidate);
		if (isCompletionCandidate) {
			this.state.completion.requested = true;
			this.state.completion.requested_at = new Date().toISOString();
			this.state.completion.attempt++;
			this.state.phase = "completion_candidate";
		}

		this.state.updated_at = new Date().toISOString();
		return { isCompletionCandidate, loopDetected, failedStrategyCount };
	}

	/**
	 * Bind an immutable policy pack to this session/run (R-014, R-015).
	 * Once bound, the pack cannot be changed mid-transaction.
	 */
	bindPolicyPack(pack: PolicyPackRef): void {
		if (this.state.policy_pack) {
			if (
				this.state.policy_pack.id !== pack.id ||
				this.state.policy_pack.version !== pack.version ||
				this.state.policy_pack.digest !== pack.digest
			) {
				throw new Error(
					`Cannot rebind policy pack: session already bound to '${this.state.policy_pack.id}@${this.state.policy_pack.version}' (${this.state.policy_pack.digest}), cannot mutate to '${pack.id}@${pack.version}' (${pack.digest})`,
				);
			}
			return;
		}
		this.state.policy_pack = Object.freeze({ ...pack });
		this.state.updated_at = new Date().toISOString();
	}

	/**
	 * Revalidate repository revision and verify exact policy pack digest upon session resume (R-016, R-062).
	 */
	revalidateOnResume(
		currentRevision: string,
		activePack?: PolicyPackRef,
	): {
		invalidatedObservations: number;
		invalidatedClaims: number;
		revisionChanged: boolean;
		policyPackVerified: boolean;
		policyPackMismatch?: string;
	} {
		const revisionChanged = this.state.repo.current_revision !== currentRevision;
		let invalidatedObservations = 0;
		let invalidatedClaims = 0;
		let policyPackVerified = true;
		let policyPackMismatch: string | undefined;

		if (this.state.policy_pack) {
			if (!activePack) {
				policyPackVerified = false;
				policyPackMismatch = `Persisted session requires policy pack '${this.state.policy_pack.id}@${this.state.policy_pack.version}' (digest: ${this.state.policy_pack.digest}), but no active policy pack was supplied on resume.`;
				this.state.phase = "blocked_external";
			} else if (
				activePack.id !== this.state.policy_pack.id ||
				activePack.version !== this.state.policy_pack.version ||
				activePack.digest !== this.state.policy_pack.digest
			) {
				policyPackVerified = false;
				policyPackMismatch = `Policy pack mismatch on resume: expected '${this.state.policy_pack.id}@${this.state.policy_pack.version}' (${this.state.policy_pack.digest}), received '${activePack.id}@${activePack.version}' (${activePack.digest})`;
				this.state.phase = "blocked_external";
				throw new PolicyPackDigestMismatchError(
					this.state.policy_pack.id,
					activePack.digest,
					this.state.policy_pack.digest,
				);
			}
		} else if (activePack) {
			this.state.policy_pack = Object.freeze({ ...activePack });
		}

		if (revisionChanged) {
			const invalidatedObsIds = new Set<string>();
			for (const obs of this.state.observations) {
				if (obs.source.kind === "file" && obs.freshness === "fresh") {
					obs.freshness = "invalidated";
					invalidatedObsIds.add(obs.id);
					invalidatedObservations++;
				}
			}

			for (const claim of this.state.claims) {
				if (claim.status === "supported" || claim.status === "partially_supported") {
					const hasInvalidatedEvidence = claim.evidence_ids.some((id) => invalidatedObsIds.has(id));
					if (hasInvalidatedEvidence) {
						claim.status = "unverified";
						invalidatedClaims++;
					}
				}
			}

			this.state.repo.current_revision = currentRevision;
			this.state.updated_at = new Date().toISOString();
		}

		return {
			invalidatedObservations,
			invalidatedClaims,
			revisionChanged,
			policyPackVerified,
			policyPackMismatch,
		};
	}

	/**
	 * Compute deterministic SHA-256 hash of current state.
	 */
	computeStateHash(): string {
		const clone = this.snapshot();
		// Omit non-deterministic timestamps for state hash calculation
		const normalized = {
			run_id: clone.run_id,
			phase: clone.phase,
			objective: clone.objective,
			repo: clone.repo,
			observations: clone.observations,
			claims: clone.claims,
			hypotheses: clone.hypotheses,
			plan: clone.plan,
			changes: clone.changes,
			verification: clone.verification,
			risks: clone.risks,
			completion: {
				requested: clone.completion.requested,
				attempt: clone.completion.attempt,
				gates: clone.completion.gates,
				terminal_status: clone.completion.terminal_status,
			},
		};
		return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
	}

	snapshot(): ExecutionState {
		return structuredClone(this.state);
	}
}
