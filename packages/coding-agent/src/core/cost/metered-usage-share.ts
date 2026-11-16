/**
 * The one reading of how much of a session's recorded spend is metered (API) spend, the spend every dollar ceiling counts
 * (`isMeteredSpend`, `receiptCountsAgainstDollars`): a bot's spend windows and charges (`BotSessionSpend`) and a root's
 * cost guard (`SessionAnalytics.getSpawnedMeteredUsd`) read each share of the session's cumulative usage through it, so
 * no ceiling counts a subscription's spend, which its plan's usage windows hold.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import { workerUsageReportIdPrefix } from "../delegation/worker-usage-receipt-delivery.ts";
import { isMeteredSpend } from "../orchestration/risk-budget.ts";
import {
	type AttemptRuntimeState,
	attemptModelBinding,
	type TaskRuntimeProjection,
} from "../orchestration/task-runtime-state.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { receiptCountsAgainstDollars, type SpendBilling } from "./request-spend-budget.ts";
import { isUsage, type MeteredUsageShare } from "./session-usage.ts";
import { spawnedReportModel } from "./usage-records.ts";

/** What a session's metered reading reads besides its records. */
export interface MeteredShareSources {
	/** The billing of the models its records name: the session's model registry. */
	readonly billing: SpendBilling;
	/** The session whose records are read: its workers' usage report ids start with its id (`workerUsageReportIdPrefix`). */
	readonly sessionId: string;
	/** The session's delegation projection, which holds its worker attempts; undefined before it is built. */
	readonly snapshot: TaskRuntimeProjection | undefined;
	/** The model the session's own spend that names none was made on (a bot's pinned model, a root's current one). */
	readonly ownModel: Model<Api> | undefined;
}

/** The model an attempt runs on (else the one its contract binds); undefined when `billing` does not know it. */
export function attemptModel(attempt: AttemptRuntimeState, billing: SpendBilling): Model<Api> | undefined {
	const binding = attemptModelBinding(attempt);
	return binding && billing.find(binding.provider, binding.modelId);
}

/** The attempt a worker's usage report id names (`workerUsageReportIdPrefix`), among `attempts` keyed by that prefix. */
function attemptOfReport(
	attempts: ReadonlyMap<string, AttemptRuntimeState>,
	reportId: string,
): AttemptRuntimeState | undefined {
	for (let at = reportId.indexOf(":"); at >= 0; at = reportId.indexOf(":", at + 1)) {
		const attempt = attempts.get(reportId.slice(0, at + 1));
		if (attempt) return attempt;
	}
	return undefined;
}

/**
 * How much of each share of the session's recorded spend is metered (`isMeteredSpend`): a response by the model it
 * names, a summary by the models its components name (what names none, the session's own model); a spawned report by the
 * metered part it fixed when it was recorded (`meteredUsd`: a bot's charge, a worker receipt whose model is not known),
 * else by its components, else by the model it ran on (`ranOn`, a worker receipt's), else by the model it names; only one
 * that names none (an earlier build's worker receipt whose attempt named no model) by the model its attempt runs on
 * (`attemptModel`); a System One report by the model it names; what names none, or a model `billing` does not know (a
 * report an earlier build wrote without its metered part included), as metered spend, which is never laxer. Each share
 * is read over the sources as they are now: a reader that must not read a share again under later models and billing
 * fixes it once (`sharesPastEntry`, `SessionAnalytics.getSpawnedMeteredUsd`).
 */
export function meteredUsageShare(sources: MeteredShareSources): MeteredUsageShare {
	const { billing, sessionId } = sources;
	const attempts = new Map<string, AttemptRuntimeState>();
	for (const attempt of Object.values(sources.snapshot?.attempts ?? {}))
		attempts.set(workerUsageReportIdPrefix(sessionId, attempt.attemptId), attempt);
	const own = isMeteredSpend(sources.ownModel, billing);
	const named = (spend: { readonly provider?: string; readonly model?: string }, otherwise: boolean): boolean =>
		spend.provider !== undefined && spend.model !== undefined
			? receiptCountsAgainstDollars({ provider: spend.provider, model: spend.model }, billing)
			: otherwise;
	// The parts of `usd` its recorded components show spent on a subscription (each whole: naming its model, its usage a
	// usage record) are not metered; the rest is, so a component that does not read is never laxer.
	const lessSubscription = (usd: number, components: unknown): number => {
		if (!Array.isArray(components)) return usd;
		let subscription = 0;
		for (const part of components)
			if (
				isPlainRecord(part) &&
				typeof part.provider === "string" &&
				typeof part.model === "string" &&
				isUsage(part.usage) &&
				!named({ provider: part.provider, model: part.model }, true)
			)
				subscription += part.usage.cost.total;
		return Math.max(0, usd - subscription);
	};
	return (usage, share) => {
		if (share.kind === "semantic") return named(share.report, true) ? usage.cost.total : 0;
		if (share.kind === "direct") {
			const { entry } = share;
			if (entry.type === "message")
				return named(entry.message.role === "assistant" ? entry.message : {}, own) ? usage.cost.total : 0;
			if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usageComponents !== undefined)
				return lessSubscription(usage.cost.total, entry.usageComponents);
			return own ? usage.cost.total : 0;
		}
		if (share.kind !== "spawned") return usage.cost.total;
		const { report } = share;
		// A report that fixed its metered part (a bot's charge) counts it, at most the part of it counted here.
		if (typeof report.meteredUsd === "number") return Math.min(usage.cost.total, Math.max(0, report.meteredUsd));
		if (report.usageComponents) return lessSubscription(usage.cost.total, report.usageComponents);
		const ranOn = spawnedReportModel(report);
		if (ranOn.provider !== undefined && ranOn.model !== undefined) return named(ranOn, true) ? usage.cost.total : 0;
		const attempt = report.reportId === undefined ? undefined : attemptOfReport(attempts, report.reportId);
		return !attempt || isMeteredSpend(attemptModel(attempt, billing), billing) ? usage.cost.total : 0;
	};
}
