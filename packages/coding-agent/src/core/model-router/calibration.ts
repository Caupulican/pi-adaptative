import type { Api, Model } from "@caupulican/pi-ai";
import type { ModelToolProbe } from "../models/adaptation-store.ts";
import type { StoredFitnessReport } from "../models/fitness-store.ts";
import { evaluateSurfaceFitness, type FitnessGatedSurface } from "./fitness-gate.ts";

/**
 * Router calibration is a READ of existing evidence — the host-keyed FitnessStore reports written by
 * `runModelFitness` and the persisted `/toolprobe` verdicts — projected per router surface. There
 * is no second benchmark store and no universal intelligence score: each surface answers only
 * "did this model pass the lanes this surface needs".
 */
export type RouterCalibrationState = "FIT" | "UNFIT" | "UNPROBED" | "STALE";

export const ROUTER_CALIBRATION_SURFACES: readonly FitnessGatedSurface[] = [
	"router_cheap",
	"router_medium",
	"router_expensive",
	"executor",
];

/** Evidence older than this is shown STALE rather than silently fresh. */
export const FITNESS_EVIDENCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface RouterCalibrationRow {
	readonly ref: string;
	readonly subscription: boolean;
	/** When the fitness report was recorded on this host; absent when never probed. */
	readonly fitnessAt?: string;
	readonly toolProbe?: ModelToolProbe["status"];
	readonly toolProbedAt?: string;
	readonly surfaces: Readonly<Record<FitnessGatedSurface, RouterCalibrationState>>;
	/** Why fresh-looking evidence is reported STALE, when it is. */
	readonly staleReason?: string;
	/**
	 * Needs a probe. Derived from the surface map this row already carries: true when the model has
	 * no report, when its evidence is stale, or when ANY router surface is UNPROBED or STALE. A
	 * model whose report covers only part of the router surfaces is offered for calibration, never
	 * silently skipped because a report exists.
	 */
	readonly needsCalibration: boolean;
}

export interface RouterCalibrationDeps {
	fitnessReports: readonly StoredFitnessReport[];
	toolProbe(model: Model<Api>): ModelToolProbe | undefined;
	isSubscription(model: Model<Api>): boolean;
	now?: Date;
}

function staleReasonFor(
	model: Model<Api>,
	report: StoredFitnessReport | undefined,
	probe: ModelToolProbe | undefined,
	now: Date,
): string | undefined {
	if (!report) return undefined;
	const at = Date.parse(report.at);
	if (!Number.isFinite(at)) return "fitness evidence has no valid timestamp";
	if (now.getTime() - at > FITNESS_EVIDENCE_MAX_AGE_MS) return `fitness evidence is older than 30 days (${report.at})`;
	if (probe && Number.isFinite(Date.parse(probe.probedAt)) && Date.parse(probe.probedAt) > at) {
		return `tool probe (${probe.probedAt}) is newer than the fitness evidence (${report.at})`;
	}
	// The capacity lane records the context window the model was REGISTERED with when it was
	// probed. A model re-registered with a different window is a different machine for lane
	// purposes, so the measured evidence no longer describes it.
	const registeredThen = report.report.capacity?.registeredContextWindow;
	if (registeredThen !== undefined && registeredThen > 0 && model.contextWindow !== registeredThen) {
		return `context window changed (${registeredThen} at probe time, ${model.contextWindow} now)`;
	}
	return undefined;
}

export function describeRouterCalibration(
	models: readonly Model<Api>[],
	deps: RouterCalibrationDeps,
): RouterCalibrationRow[] {
	const now = deps.now ?? new Date();
	return models.map((model) => {
		const ref = `${model.provider}/${model.id}`;
		const report = deps.fitnessReports.find((entry) => entry.model === ref);
		const probe = deps.toolProbe(model);
		const staleReason = staleReasonFor(model, report, probe, now);
		const surfaces = {} as Record<FitnessGatedSurface, RouterCalibrationState>;
		for (const surface of ROUTER_CALIBRATION_SURFACES) {
			const verdict = evaluateSurfaceFitness(surface, report?.report);
			const probed = verdict.fit ? verdict.probed : verdict.reason !== "unprobed";
			surfaces[surface] = !probed ? "UNPROBED" : staleReason ? "STALE" : verdict.fit ? "FIT" : "UNFIT";
		}
		const needsCalibration =
			!report ||
			staleReason !== undefined ||
			ROUTER_CALIBRATION_SURFACES.some(
				(surface) => surfaces[surface] === "UNPROBED" || surfaces[surface] === "STALE",
			);
		return {
			ref,
			subscription: deps.isSubscription(model),
			...(report ? { fitnessAt: report.at } : {}),
			...(probe ? { toolProbe: probe.status, toolProbedAt: probe.probedAt } : {}),
			surfaces,
			...(staleReason ? { staleReason } : {}),
			needsCalibration,
		};
	});
}

const SURFACE_SHORT: Record<FitnessGatedSurface, string> = {
	router_cheap: "cheap",
	router_medium: "medium",
	router_expensive: "expensive",
	executor: "executor",
	compaction: "compaction",
	curation: "curation",
	scout_auto: "scout",
};

/**
 * What one calibration run covers, in operator wording, derived from the canonical surface list so
 * the count and the names can never drift from `ROUTER_CALIBRATION_SURFACES`. The real tool
 * execution probe is named separately: it is not a fitness surface.
 */
export function describeRouterCalibrationScope(): string {
	const names = ROUTER_CALIBRATION_SURFACES.map((surface) => SURFACE_SHORT[surface]).join(", ");
	return `${ROUTER_CALIBRATION_SURFACES.length} router fitness surfaces (${names}) + real tool execution probe`;
}

/** The fitness surfaces alone, for copy that names the probe separately. */
export function describeRouterCalibrationSurfaces(): string {
	return `${ROUTER_CALIBRATION_SURFACES.length} router fitness surfaces (${ROUTER_CALIBRATION_SURFACES.map(
		(surface) => SURFACE_SHORT[surface],
	).join(", ")})`;
}

export function formatRouterCalibrationRow(row: RouterCalibrationRow): string {
	const surfaces = ROUTER_CALIBRATION_SURFACES.map(
		(surface) => `${SURFACE_SHORT[surface]} ${row.surfaces[surface]}`,
	).join(" · ");
	const tool = row.toolProbe ? `tool ${row.toolProbe}` : "tool unprobed";
	const at = row.fitnessAt ? `probed ${row.fitnessAt.slice(0, 10)}` : "never probed";
	return `${row.ref} · ${row.subscription ? "subscription" : "metered"} · ${surfaces} · ${tool} · ${at}`;
}
