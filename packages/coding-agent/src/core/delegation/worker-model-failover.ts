/**
 * Where a worker runs when its model cannot take work, and which of its pinned contract's candidates an attempt resolves
 * to: the first one not exhausted, not judged unfit for the attempt (`WorkerFitRoute`) and not held off for the attempt's
 * run by its host (`ParentExecutionPolicy.runModelHold`). A worker that finds no such candidate does not move: it retries
 * on its own model, which waits for that model's usage reset.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import { classifyFailure } from "../../kernel/reliability/index.ts";
import type { WorkerProfileExecutionContract } from "../orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import type { ParentExecutionPolicy } from "./parent-execution-context.ts";
import {
	isOAuthCredentialUnusableText,
	type WorkerCredentialHealth,
	type WorkerModelMove,
	type WorkerModelMoveReason,
	workerModelMoveReason,
} from "./worker-credential-health.ts";
import type { ResolvedWorkerProfile, WorkerProfileResolver } from "./worker-profile-resolver.ts";

import type { WorkerRecoveryCoordinator, WorkerRetryScheduleResult } from "./worker-recovery-coordinator.ts";

type RetryRequest = Parameters<WorkerRecoveryCoordinator["scheduleAttemptRetry"]>[0];

export interface WorkerModelFailoverPorts {
	resolver(): Pick<WorkerProfileResolver, "resolveContract">;
	activeAttempt(laneId: string): AttemptRuntimeState | undefined;
	snapshot(): TaskRuntimeProjection;
	/** The candidates judged unfit for an attempt (`WorkerFitRoute.unfitFor`). */
	unfitFor(attemptId: string): ReadonlySet<string> | undefined;
	readonly credentialHealth: Pick<WorkerCredentialHealth, "loginExpired" | "tellLoginExpired">;
	readonly runModelHold?: ParentExecutionPolicy["runModelHold"];
	markModelExhausted?(model: Model<Api>, retryAfterMs?: number): void;
	isSubscription(model: Model<Api>): boolean;
	scheduleRetry(request: RetryRequest): WorkerRetryScheduleResult;
	warn(message: string): void;
}

export class WorkerModelFailover {
	private readonly ports: WorkerModelFailoverPorts;

	constructor(ports: WorkerModelFailoverPorts) {
		this.ports = ports;
	}

	/** A pinned contract resolved for `attempt`: past the candidates judged unfit for it and those its run is held off. */
	resolveContract(
		contract: WorkerProfileExecutionContract,
		attempt: AttemptRuntimeState | undefined,
	): ReturnType<WorkerProfileResolver["resolveContract"]> {
		const hold = this.ports.runModelHold;
		return this.ports
			.resolver()
			.resolveContract(
				contract,
				attempt ? this.ports.unfitFor(attempt.attemptId) : undefined,
				attempt && hold ? (model) => hold(attempt, this.ports.snapshot(), model) : undefined,
			);
	}

	/** A failed credential may schedule an ordered replacement. A failed completion may also retry its current
	 * model. Every replacement is only a candidate until the scheduler admits it under the next lease fence. */
	schedule(
		source: "credential" | "completion",
		model: Model<Api>,
		request: Omit<RetryRequest, "failover" | "subscription" | "provider">,
	):
		| { record: Extract<WorkerRetryScheduleResult, { scheduled: true }>["record"]; move?: WorkerModelMove }
		| undefined {
		const next = this.failOver(request.laneId, request.outcome, model);
		if (!next && source === "credential") return undefined;
		const retry = this.ports.scheduleRetry({
			...request,
			provider: model.provider,
			subscription: this.ports.isSubscription(model),
			...(next ? { failover: next.reason } : {}),
		});
		if (!retry.scheduled) return undefined;
		if (!next) return { record: retry.record };
		return {
			record: retry.record,
			move: {
				from: `${model.provider}/${model.id}`,
				to: `${next.resolved.model.provider}/${next.resolved.model.id}`,
				reason: next.reason,
			},
		};
	}

	/**
	 * A worker whose model cannot take work: out of quota, refused for the account, or its credential unusable. A
	 * model-level failure is marked exhausted where every routing decision reads it (the same registry root's billing
	 * failover writes). An expired login that cannot be refreshed is the provider's and is read live from the credential
	 * store, which already skips every model on it until the owner signs in again, so it marks nothing that would
	 * outlive the new login and tells the owner once. Returns why the worker moved and the model it resolved to, when its
	 * contract carries ordered fallbacks and its retry resolves to a different model; undefined when it did not move.
	 */
	private failOver(
		laneId: string,
		outcome: { reasonCode: string; reasonDetail?: string },
		model: Model<Api>,
	): { readonly reason: WorkerModelMoveReason; readonly resolved: ResolvedWorkerProfile } | undefined {
		if (outcome.reasonCode !== "completion_error" || !outcome.reasonDetail) return undefined;
		const classified = classifyFailure({ message: outcome.reasonDetail, provider: model.provider });
		const loginExpired = this.ports.credentialHealth.loginExpired(model.provider);
		const oauthCredentialUnusable = loginExpired || isOAuthCredentialUnusableText(outcome.reasonDetail);
		if (
			classified.reason !== "billing_or_quota" &&
			classified.reason !== "model_unsupported" &&
			classified.reason !== "auth" &&
			!oauthCredentialUnusable
		) {
			return undefined;
		}
		if (!loginExpired) this.ports.markModelExhausted?.(model, classified.retryAfterMs);
		// One resolution: unfit and held candidates are skipped, and a retry on the running model is not a move.
		const attempt = this.ports.activeAttempt(laneId);
		const contract = attempt?.dispatch.executionContract;
		const next =
			attempt && contract?.worker.profile.modelPolicy.mode === "ordered-fallback"
				? this.resolveContract(contract.worker, attempt)
				: undefined;
		const nextModel = next?.ok ? next.resolved.model : undefined;
		const moved = nextModel !== undefined && (nextModel.provider !== model.provider || nextModel.id !== model.id);
		if (loginExpired) this.ports.credentialHealth.tellLoginExpired(model, moved);
		if (!moved || !next?.ok || !nextModel) return undefined;
		const reason = workerModelMoveReason(loginExpired, classified.reason);
		this.ports.warn(
			reason === "quota_exhausted"
				? `Worker ${laneId} ran ${model.provider}/${model.id} out of quota; retrying on ${nextModel.provider}/${nextModel.id}.`
				: `Worker ${laneId} model ${model.provider}/${model.id} unavailable (${oauthCredentialUnusable ? "auth" : classified.reason}); retrying on ${nextModel.provider}/${nextModel.id}.`,
		);
		return { reason, resolved: next.resolved };
	}
}
