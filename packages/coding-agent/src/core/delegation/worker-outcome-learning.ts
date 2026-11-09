import type { Api, Model } from "@caupulican/pi-ai";
import { FitnessStore } from "../models/fitness-store.ts";
import {
	type OutcomeLedgerPolicy,
	OutcomeLedgerStore,
	type OutcomeRankQuery,
	outcomeTaskClass,
	outcomeToolSurface,
} from "../models/outcome-ledger-store.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import type { ResolvedWorkerOutcomeSettings } from "../settings/worker-outcome-settings.ts";
import type { Outcome } from "./worker-outcome-contract.ts";

/** Pseudo-observations a stored fitness score contributes to a new key's prior. */
const FITNESS_PRIOR_WEIGHT = 2;

/**
 * Teaches model choice from outcomes: records model-attributed and successful attempts into the outcome ledger, and
 * orders the resolver's routed candidates by that evidence. Provider, environment, harness, owner, task, open-fit and
 * cancelled outcomes never move a model's evidence; neither does any System One answer.
 */
export class WorkerOutcomeLearning {
	private readonly agentDir: string;
	private readonly sessionId: string;
	private readonly settings: () => ResolvedWorkerOutcomeSettings;
	private readonly now: () => number;
	private ledgerStore: OutcomeLedgerStore | undefined;

	constructor(options: {
		agentDir: string;
		sessionId: string;
		settings: () => ResolvedWorkerOutcomeSettings;
		now?: () => number;
	}) {
		this.agentDir = options.agentDir;
		this.sessionId = options.sessionId;
		this.settings = options.settings;
		this.now = options.now ?? Date.now;
	}

	private ledger(): OutcomeLedgerStore {
		this.ledgerStore ??= OutcomeLedgerStore.forAgentDir(this.agentDir);
		return this.ledgerStore;
	}

	private policy(): OutcomeLedgerPolicy | undefined {
		const learning = this.settings().learning;
		return learning.enabled ? learning : undefined;
	}

	/** A new key's prior: the model's stored worker fitness score as at most two observations, else one each way. */
	private prior(modelRef: string): { alpha: number; beta: number } {
		const worker = FitnessStore.forAgentDir(this.agentDir)
			.getForHost()
			.find((entry) => entry.model === modelRef)?.report.worker;
		if (!worker || worker.total <= 0) return { alpha: 1, beta: 1 };
		const weight = Math.min(FITNESS_PRIOR_WEIGHT, worker.total);
		const rate = Math.min(1, Math.max(0, worker.succeeded / worker.total));
		const alpha = weight * rate;
		const beta = weight * (1 - rate);
		return alpha + beta > 0 ? { alpha, beta } : { alpha: 1, beta: 1 };
	}

	/** The resolver's ranking port: the same candidates, ordered by evidence for the worker's role and write class. */
	rankRoutedModels(models: readonly Model<Api>[], query: OutcomeRankQuery): Model<Api>[] {
		const policy = this.policy();
		if (!policy) return [...models];
		return this.ledger().rank(
			models,
			(model) => `${model.provider}/${model.id}`,
			query,
			(modelRef) => this.prior(modelRef),
			policy,
			this.now(),
		);
	}

	/** Record the outcome's last attempt when the outcome is settled enough to say something about the model. */
	observe(outcome: Outcome, snapshot: TaskRuntimeProjection): void {
		const policy = this.policy();
		if (!policy || outcome.scope !== "lane") return;
		// More host facts are on the way: the settled re-projection is the one that counts.
		if (outcome.nextAction.kind === "host_check" || outcome.blocker === "verification_pending") return;
		const counts =
			outcome.status === "succeeded" || (outcome.status !== "cancelled" && outcome.attribution === "model");
		if (!counts) return;
		const last = outcome.attempts.at(-1);
		const attempt = last ? snapshot.attempts[last.attemptId] : undefined;
		const contract = attempt?.dispatch.executionContract?.worker;
		if (!last || !contract || last.modelRef === "unknown") return;
		const required = outcome.coverage.required.length;
		const coverage =
			outcome.status === "succeeded"
				? 1
				: outcome.blocker === "evidence_contradicts_claim" || required === 0
					? 0
					: outcome.coverage.covered.length / required;
		const write = contract.authority.writePaths.length > 0 && contract.profile.readOnly !== true;
		this.ledger().observe(
			{
				modelRef: last.modelRef,
				taskClass: outcomeTaskClass(contract.profile.role, write, required),
				toolSurface: outcomeToolSurface(contract.authority.capabilities),
				attemptId: last.attemptId,
				sessionId: this.sessionId,
				coverage,
				prior: this.prior(last.modelRef),
			},
			policy,
			this.now(),
		);
	}
}
