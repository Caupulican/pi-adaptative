import type { ExecutionState, ToolImpact } from "./types.ts";

/**
 * Secret redaction patterns.
 * R-032: Secrets, tokens, credentials, private keys, and configured sensitive patterns MUST be redacted before remote Jev calls.
 */
const SECRET_PATTERNS = [
	/apikey_[A-Za-z0-9_-]+/g,
	/sk-[A-Za-z0-9_-]{20,}/g,
	/ghp_[A-Za-z0-9]{36}/g,
	/glpat-[A-Za-z0-9_-]{20}/g,
	/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
	/-----BEGIN\s+(?:[A-Z0-9_-]+\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:[A-Z0-9_-]+\s+)?PRIVATE\s+KEY-----/g,
	/password\s*[:=]\s*["'][^"']+["']/gi,
];

export function redactSecrets(text: string): string {
	let result = text;
	for (const pattern of SECRET_PATTERNS) {
		result = result.replace(pattern, "[REDACTED_SECRET]");
	}
	return result;
}

/**
 * Wrap untrusted text from repository or external docs.
 * R-031: Repository and external text MUST be labeled untrusted in state projections.
 * R-065: Prompt-injection-like content must be quarantined.
 */
export function wrapUntrustedText(
	text: string,
	sourceKind = "repository",
): {
	trust: "repository_untrusted_text" | "external_untrusted_text";
	content: string;
} {
	const trust = sourceKind === "external_doc" ? "external_untrusted_text" : "repository_untrusted_text";
	return {
		trust,
		content: redactSecrets(text),
	};
}

/**
 * StateProjector: builds stage-specific, bounded projections from the authoritative ExecutionState.
 * R-030: State projections MUST contain only information relevant to the current question pack.
 * R-048: Final completion validation MUST use a fresh cold projection built from source evidence, diff, acceptance matrix, and verification results.
 * R-049: The worker final summary MUST NOT be the primary state for final completion validation.
 */
export class StateProjector {
	/**
	 * Intake projection: objective clarity, task kind, external blockers.
	 */
	intake(state: ExecutionState): Record<string, unknown> {
		return {
			objective: {
				request: redactSecrets(state.objective.request),
				normalized_goal: redactSecrets(state.objective.normalized_goal),
				acceptance_criteria: state.objective.acceptance_criteria.map((ac) => ({
					id: ac.id,
					text: redactSecrets(ac.text),
					required: ac.required,
				})),
				constraints: state.objective.constraints.map((c) => ({
					id: c.id,
					text: redactSecrets(c.text),
					severity: c.severity,
				})),
				non_goals: state.objective.non_goals.map((ng) => redactSecrets(ng)),
			},
			repo: {
				root: state.repo.root,
				baseline_revision: state.repo.baseline_revision,
				languages: state.repo.languages,
			},
		};
	}

	/**
	 * Preflight projection: step relevance, evidence sufficiency, unsupported assumptions, next route.
	 */
	preflight(state: ExecutionState, stepId: string): Record<string, unknown> {
		const step = state.plan.steps.find((s) => s.id === stepId) || {
			id: stepId,
			goal: "Execute current plan step",
			action_class: "inspect",
			proof_obligations: [],
		};

		// Filter fresh observations relevant to the step
		const freshObservations = state.observations
			.filter((o) => o.freshness === "fresh")
			.slice(-10)
			.map((o) => ({
				id: o.id,
				text: redactSecrets(o.text),
				source_locator: o.source.locator,
				trust: o.source.trust,
			}));

		const activeHypotheses = state.hypotheses
			.filter((h) => h.status === "candidate" || h.status === "investigating")
			.map((h) => ({
				id: h.id,
				text: redactSecrets(h.text),
				status: h.status,
				next_discriminator: h.next_discriminator,
			}));

		return {
			objective: {
				normalized_goal: redactSecrets(state.objective.normalized_goal),
				non_goals: state.objective.non_goals.map((ng) => redactSecrets(ng)),
			},
			current_step: {
				id: step.id,
				goal: redactSecrets(step.goal),
				action_class: step.action_class,
				proof_obligations: step.proof_obligations,
			},
			evidence_view: freshObservations,
			hypotheses: activeHypotheses,
		};
	}

	/**
	 * Tool-gate projection: tool relevance, semantic scope risk, prompt injection detection.
	 */
	toolGate(
		state: ExecutionState,
		toolRequest: { tool: string; intent: string; impact: ToolImpact; args?: unknown },
	): Record<string, unknown> {
		const activeStep = state.plan.steps.find((s) => s.status === "active") || {
			goal: state.objective.normalized_goal,
		};

		const untrustedText = toolRequest.args ? redactSecrets(JSON.stringify(toolRequest.args)) : "";

		return {
			current_step: {
				goal: redactSecrets(activeStep.goal),
			},
			tool_request: {
				tool: toolRequest.tool,
				intent: redactSecrets(toolRequest.intent),
				impact: toolRequest.impact,
			},
			untrusted_text: untrustedText,
		};
	}

	/**
	 * Evidence-check projection: relationship between cited evidence and claim.
	 */
	evidenceCheck(state: ExecutionState, claimId: string, evidenceId: string): Record<string, unknown> {
		const claim = state.claims.find((c) => c.id === claimId) || {
			id: claimId,
			text: "Unknown claim",
			materiality: "material",
		};
		const obs = state.observations.find((o) => o.id === evidenceId) || {
			id: evidenceId,
			text: "Unknown observation",
			source: { locator: "none", content_hash: "none", trust: "authoritative" },
		};

		return {
			claim: {
				id: claim.id,
				text: redactSecrets(claim.text),
				materiality: claim.materiality,
			},
			evidence: {
				id: obs.id,
				text: redactSecrets(obs.text),
				locator: obs.source.locator,
				content_hash: obs.source.content_hash,
				trust: obs.source.trust,
			},
		};
	}

	/**
	 * Postflight projection: step accomplishment, claim support, scope violation, next status.
	 */
	postflight(state: ExecutionState, stepId: string): Record<string, unknown> {
		const step = state.plan.steps.find((s) => s.id === stepId) || {
			id: stepId,
			goal: "Current step",
		};
		const lastToolEvent = state.tool_events.at(-1);
		const recentObservations = state.observations
			.filter((o) => o.freshness === "fresh")
			.slice(-5)
			.map((o) => ({ id: o.id, text: redactSecrets(o.text) }));

		const workerClaims = state.claims.slice(-5).map((c) => ({
			id: c.id,
			text: redactSecrets(c.text),
			materiality: c.materiality,
			evidence_ids: c.evidence_ids,
		}));

		const diffSummary = state.changes.slice(-5).map((ch) => ({
			path: ch.path,
			kind: ch.kind,
			ownership: ch.ownership,
		}));

		return {
			current_step: {
				id: step.id,
				goal: redactSecrets(step.goal),
			},
			last_action: lastToolEvent
				? {
						tool: lastToolEvent.tool,
						intent: redactSecrets(lastToolEvent.intent),
						status: lastToolEvent.status,
					}
				: "none",
			new_evidence: recentObservations,
			worker_claims: workerClaims,
			diff_view: diffSummary,
		};
	}

	/**
	 * Drift-loop projection: goal drift, repeated strategy, stale context, semantic progress.
	 */
	driftCheck(state: ExecutionState): Record<string, unknown> {
		const recentActions = state.tool_events.slice(-8).map((te) => ({
			tool: te.tool,
			intent: redactSecrets(te.intent),
			status: te.status,
		}));

		return {
			objective: {
				normalized_goal: redactSecrets(state.objective.normalized_goal),
				acceptance_criteria: state.objective.acceptance_criteria.map((ac) => ({
					id: ac.id,
					status: ac.status,
				})),
			},
			recent_action_sequence: recentActions,
			stale_observations_count: state.observations.filter((o) => o.freshness === "stale").length,
		};
	}

	/**
	 * Duplicate logic projection: candidate existing vs proposed logic semantic responsibility.
	 */
	duplicateLogic(candidateExisting: string, proposedLogic: string): Record<string, unknown> {
		return {
			candidate_existing_logic: wrapUntrustedText(candidateExisting),
			proposed_logic: redactSecrets(proposedLogic),
		};
	}

	/**
	 * Patch review projection: addresses need, masks symptom only, architecture fit, regression surface.
	 */
	patchReview(state: ExecutionState, changeIds: string[]): Record<string, unknown> {
		const changes = state.changes.filter((c) => changeIds.includes(c.id));
		const activeStep = state.plan.steps.find((s) => s.status === "active") || {
			goal: state.objective.normalized_goal,
		};

		return {
			current_step: {
				goal: redactSecrets(activeStep.goal),
			},
			diff_view: changes.map((c) => ({
				path: c.path,
				kind: c.kind,
				diff_hash: c.diff_hash,
			})),
			architecture_context: {
				allowed_paths: state.repo.allowed_paths,
				protected_paths: state.repo.protected_paths,
			},
		};
	}

	/**
	 * Cold completion projection: built cold from authoritative state.
	 * R-048: Built cold from source evidence, diff, acceptance matrix, and verification results.
	 * R-049: The worker final summary MUST NOT be the primary state.
	 */
	completion(state: ExecutionState): Record<string, unknown> {
		const acceptanceMatrix = state.objective.acceptance_criteria.map((ac) => ({
			id: ac.id,
			text: redactSecrets(ac.text),
			required: ac.required,
			status: ac.status,
			evidence_ids: ac.evidence_ids,
			waiver_id: ac.waiver_id,
		}));

		const claimMatrix = state.claims
			.filter((c) => c.materiality !== "informational")
			.map((c) => ({
				id: c.id,
				text: redactSecrets(c.text),
				materiality: c.materiality,
				status: c.status,
				evidence_ids: c.evidence_ids,
			}));

		const verificationMatrix = state.verification.map((v) => ({
			id: v.id,
			kind: v.kind,
			status: v.status,
			command: v.command,
			covers_acceptance_ids: v.covers_acceptance_ids,
		}));

		const changesManifest = state.changes.map((c) => ({
			id: c.id,
			path: c.path,
			kind: c.kind,
			ownership: c.ownership,
			diff_hash: c.diff_hash,
		}));

		const hypotheses = state.hypotheses.map((h) => ({
			id: h.id,
			text: redactSecrets(h.text),
			status: h.status,
			supporting_evidence: h.supporting_evidence,
			contradicting_evidence: h.contradicting_evidence,
		}));

		const openRisks = state.risks
			.filter((r) => r.status === "open")
			.map((r) => ({
				id: r.id,
				text: redactSecrets(r.text),
				severity: r.severity,
			}));

		return {
			objective: {
				normalized_goal: redactSecrets(state.objective.normalized_goal),
				non_goals: state.objective.non_goals.map((ng) => redactSecrets(ng)),
			},
			acceptance_matrix: acceptanceMatrix,
			claim_matrix: claimMatrix,
			verification_matrix: verificationMatrix,
			final_diff: changesManifest,
			hypotheses,
			open_risks: openRisks,
		};
	}

	/**
	 * Independent completion challenge projection.
	 * R-058: Second completion_challenge pack runs after primary completion pack.
	 */
	completionChallenge(state: ExecutionState): Record<string, unknown> {
		return this.completion(state);
	}
}
