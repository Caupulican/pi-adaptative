import type { HarnessCapability } from "../capability-contract.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export interface JsonObject {
	[key: string]: JsonValue;
}

export type ModelTier = "cheap" | "medium" | "expensive" | "learning";

export type RouteRisk = "read-only" | "scoped-write" | "high-impact" | "approval-required";

export type OperationRisk = "read-only" | "scoped-write" | "high-impact" | "approval-required";

export interface RiskAssessmentInput {
	operation: string;
	toolName?: string;
	command?: string;
	paths?: readonly string[];
	capabilities?: readonly HarnessCapability[];
}

export interface RiskAssessment {
	risk: OperationRisk;
	reasonCode: string;
	reasons: readonly string[];
	requiresApproval: boolean;
}

export type PathScopeDecisionKind = "inside" | "outside" | "denied" | "missing";

export interface PathScope {
	root: string;
	allowedPaths?: readonly string[];
	deniedPaths?: readonly string[];
	followSymlinks?: boolean;
}

export interface PathScopeDecision {
	kind: PathScopeDecisionKind;
	path: string;
	resolvedPath?: string;
	matchedRule?: string;
	reasonCode: string;
}

/**
 * Who chose the exact routed model: an operator tier pin (`manual`), the router's own deterministic
 * pool ranking (`auto`), or the H-MoE expert selector (`hmoe`). Absent on decisions persisted before
 * the field existed, which read as `manual` (the only selection that existed then).
 */
export type RouteSelectionSource = "manual" | "auto" | "hmoe" | "system_one";

export interface RouteDecision {
	tier: ModelTier;
	model?: string;
	risk: RouteRisk;
	confidence: number;
	reasonCode: string;
	reasons: readonly string[];
	fallbackFrom?: ModelTier;
	createdAt?: string;
	selection?: RouteSelectionSource;
	/** The thinking level chosen with the model; the tier's configured level applies when absent. */
	thinkingLevel?: string;
}

export interface CapabilityEnvelope {
	id: string;
	profileId?: string;
	capabilities: readonly HarnessCapability[];
	allowedTools?: readonly string[];
	deniedTools?: readonly string[];
	allowedPaths?: readonly string[];
	deniedPaths?: readonly string[];
	/**
	 * Exact files exempt from `deniedPaths`: an explicit grant by whoever launched the session (the file
	 * itself, never its siblings). Other envelopes on the same tool, such as a write scope, still apply.
	 */
	exemptPaths?: readonly string[];
	maxEstimatedUsd?: number;
	createdAt?: string;
}

export type GateOutcomeKind = "allow" | "downgrade" | "escalate" | "ask-user" | "block";

export interface GateOutcome {
	outcome: GateOutcomeKind;
	gate: string;
	reasonCode: string;
	message?: string;
	reversible?: boolean;
	details?: JsonObject;
}

export interface ApprovalRequest {
	id: string;
	operation: string;
	target: string;
	reversible: boolean;
	capabilities: readonly HarnessCapability[];
	reasonCode: string;
	createdAt?: string;
}

export type EvidenceSourceKind = "workspace" | "transcript" | "automata" | "web" | "user" | "tool";

export interface EvidenceRef {
	id: string;
	kind: EvidenceSourceKind;
	title?: string;
	uri?: string;
	trusted: boolean;
	excerpt?: string;
	metadata?: JsonObject;
}

export interface Finding {
	id: string;
	summary: string;
	evidenceIds: readonly string[];
	confidence?: number;
}

export interface EvidenceBundle {
	query: string;
	sources: readonly EvidenceRef[];
	findings: readonly Finding[];
	createdAt?: string;
}

export interface WorkerRequest {
	id: string;
	instructions: string;
	route: RouteDecision;
	envelope: CapabilityEnvelope;
	evidence?: EvidenceBundle;
	maxEstimatedUsd?: number;
	createdAt?: string;
}

export type WorkerClaimStatus = "completed" | "partial" | "blocked" | "failed" | "cancelled";

/**
 * How a worker's report reached the host: `structured` is the JSON envelope in its final text,
 * `plain_text` a read-only worker's prose, `report` the arguments of the `submit_report` tool the host
 * asked for when the worker declared itself done, and `unstructured_after_request` a worker that was
 * asked for that report and answered in text anyway (its text is still parsed and stands).
 */
export type WorkerClaimOutputFormat = "structured" | "plain_text" | "report" | "unstructured_after_request";

/** A command a worker ran, as the host recorded it: what the worker later claims about it is checked against this. */
export interface WorkerCommandReceipt {
	/** The tool call id; a report cites it as the evidence for a check. */
	readonly id: string;
	readonly tool: string;
	/** The command's head, bounded and never carrying a credential. */
	readonly command: string;
	readonly isError: boolean;
	/** Absent when the tool reported none (killed, or a tool that does not run a process). */
	readonly exitCode?: number;
	readonly durationMs?: number;
	/** Where the full output was persisted, when it was. */
	readonly outputRef?: string;
}

export type WorkerReportRequirementStatus = "met" | "partial" | "not_met" | "not_applicable";

/** What a worker reports against one requirement id of its task, and what it cites as proof. */
export interface WorkerReportRequirement {
	readonly id: string;
	readonly status: WorkerReportRequirementStatus;
	/** Receipt ids, changed file paths or finding ids. */
	readonly evidence: readonly string[];
	readonly note?: string;
}

export interface WorkerReportCheck {
	readonly command: string;
	readonly receiptId?: string;
	readonly result: "passed" | "failed" | "not_run";
	readonly note?: string;
}

export interface WorkerReportChange {
	readonly file: string;
	readonly what: string;
	/** Requirement ids this change serves. */
	readonly serves?: readonly string[];
}

/** The structured sections of a submitted report beyond the envelope fields every claim already carries. */
export interface WorkerSubmittedReport {
	readonly requirements: readonly WorkerReportRequirement[];
	readonly checks: readonly WorkerReportCheck[];
	readonly changes: readonly WorkerReportChange[];
	readonly assumptions: readonly string[];
	readonly regressions: readonly string[];
	readonly remaining: readonly string[];
}

/**
 * The host's judgment of a worker's claim. `accepted`: the stated claims are shown by the receipts.
 * `needs_more`: named proof is missing (one follow-up turn is allowed). `rejected`: a stated claim is
 * contradicted. `blocked`: the worker reported a blocker. `unverified`: nothing was checked (a report
 * that never took the structured form). The verdict is advice to the root, which owns the worker's
 * lifecycle; it never closes, cancels or retires anything.
 */
export type WorkerHostVerdictKind = "accepted" | "needs_more" | "rejected" | "blocked" | "unverified";

export interface WorkerHostVerdict {
	readonly verdict: WorkerHostVerdictKind;
	/** Requirement ids the worker reported met and the host's checks left standing. */
	readonly coveredRequirementIds: readonly string[];
	/** The proof a `needs_more` or `rejected` verdict names. */
	readonly missing: readonly string[];
	readonly reasonCodes: readonly string[];
	readonly judgedBy: "code" | "system_one";
	readonly at: string;
}

export interface WorkerClaimVerificationDecision {
	subjectTaskId: string;
	verdict: "accepted" | "rejected";
	reasonCodes: readonly string[];
}

/** Untrusted worker-authored report. Only host adjudication can turn this into a durable result. */
export interface WorkerClaim {
	requestId: string;
	/** Host-stamped durable attempt identity for replay-safe claim persistence. */
	terminalAttemptId?: string;
	status: WorkerClaimStatus;
	summary: string;
	outputFormat?: WorkerClaimOutputFormat;
	evidence?: EvidenceBundle;
	changedFiles: readonly string[];
	blockers?: readonly string[];
	/** Findings the worker could not settle (System One left them below the gate, or the evidence ran out).
	 * Reported honestly instead of rounded up; the parent reviews them and they reach the owner. */
	inconclusive?: readonly string[];
	/** Inconclusive findings System One settled on the ladder, with the verdict and who reached it. */
	systemOneSettled?: readonly string[];
	/** The owner's follow-up document the still-open findings were written to under a handoff. */
	ownerFollowUp?: string;
	usageReportId?: string;
	createdAt?: string;
	/** Stamped at persistence time when validateWorkerClaim's gate flagged this claim
	 * "ask-user"/"parent_review_required" (mutated files or blockers on an otherwise-completed run).
	 * Undefined when not computable because an externally managed lane had no WorkerRequest —
	 * distinct from `false`, which means the gate explicitly cleared it. */
	parentReviewRequired?: boolean;
	/** ISO 8601 timestamp set once the parent explicitly acknowledges an unreviewed mutation via
	 * delegate's "review" action. Presence means reviewed; absence keeps the notice sticky.
	 * The ack is durable — re-derived from the latest persisted snapshot, not session-local state. */
	parentReviewedAt?: string;
	/** Typed semantic verdict emitted only by a verifier-profile worker. */
	verification?: WorkerClaimVerificationDecision;
	/** Commands the worker ran, recorded by the host (bounded; the most recent are kept). */
	commandReceipts?: readonly WorkerCommandReceipt[];
	/** The structured sections of a report submitted through `submit_report`. */
	report?: WorkerSubmittedReport;
	/** The host's judgment of this claim against the receipts. */
	hostVerdict?: WorkerHostVerdict;
}

export type LearningDecisionKind = "no-op" | "proposal" | "apply";

export interface LearningDecision {
	kind: LearningDecisionKind;
	reasonCode: string;
	confidence: number;
	summary: string;
	requiresApproval: boolean;
	createdAt?: string;
}
