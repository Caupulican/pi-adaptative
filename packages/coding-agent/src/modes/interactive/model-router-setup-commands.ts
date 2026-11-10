/**
 * Router Setup actions hand-off (Settings → Model Router → Configure models / Calibrate / Preview
 * route / Diagnostics). The settings selector closes and hands one action string here; every
 * provider-spending step (fitness probe, tool probe, live preview) runs only from an explicit
 * operator choice made here, never by opening settings.
 */

import type { Api, Model } from "@caupulican/pi-ai/types";
import type { Component, SelectItem } from "@caupulican/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import {
	describeRouterCalibration,
	describeRouterCalibrationScope,
	describeRouterCalibrationSurfaces,
	formatRouterCalibrationRow,
	type RouterCalibrationRow,
} from "../../core/model-router/calibration.ts";
import { formatLiveRoutePreview, formatRoutePreview } from "../../core/model-router/route-preview.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { harnessLog } from "../../kernel/harness-log.ts";
import { plainLabel } from "../../presentation/plain-text.ts";
import { SelectSubmenu } from "./components/settings-selector.ts";

/** The model registry members this module uses, declared by the module itself; the composition root passes the ModelRegistry. */
export interface ModelRouterSetupCommandsModelSource {
	isUsingSubscription(model: Model<Api>): boolean;
}

type SelectorFactory = (done: () => void) => { component: Component; focus: Component };

export interface ModelRouterSetupHost {
	readonly session: Pick<
		AgentSession,
		| "runModelFitness"
		| "probeToolCalling"
		| "getRouterCandidatePool"
		| "getStoredFitnessReports"
		| "getToolProbeRecord"
		| "getModelRouterStatus"
		| "previewRoute"
		| "previewRouteLive"
	>;
	readonly modelRegistry: ModelRouterSetupCommandsModelSource;
	readonly settingsManager: SettingsManager;
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
	showSelector(create: SelectorFactory): void;
	/**
	 * The existing Models configuration UI (the router's pool source). Resolves when the operator
	 * closes that editor, so the caller can act on the edited pool.
	 */
	showModelsSelector(): Promise<void>;
	/** Reopen Router Setup on a freshly built candidate pool (after the Models editor closed). */
	reopenModelRouterSetup(): void;
	/** The existing fitness probe + role assignment flow for one model. */
	runFitnessAndAssign(modelRef: string): Promise<void>;
}

const PREVIEW_PREFIX = "preview:";
const LIVE_PREVIEW_PREFIX = "preview-live:";
const CALIBRATE_ONE_PREFIX = "calibrate:";

function calibrationRows(host: ModelRouterSetupHost): RouterCalibrationRow[] {
	const pool = host.session.getRouterCandidatePool();
	return describeRouterCalibration(pool.models, {
		fitnessReports: host.session.getStoredFitnessReports(),
		toolProbe: (model) => host.session.getToolProbeRecord(model),
		isSubscription: (model) => host.modelRegistry.isUsingSubscription(model),
	});
}

function pickPoolModel(host: ModelRouterSetupHost, onPick: (ref: string) => void): void {
	const words = interfaceText().localModels.routerSetup;
	const rows = calibrationRows(host);
	if (rows.length === 0) {
		host.showStatus(words.calibrationEmpty);
		return;
	}
	host.showSelector((done) => {
		const options: SelectItem[] = rows.map((row) => ({
			value: row.ref,
			label: row.ref,
			description: formatRouterCalibrationRow(row),
		}));
		const selector = new SelectSubmenu(
			words.calibrateOneTitle,
			words.calibrateOneDescription(describeRouterCalibrationScope()),
			options,
			rows.find((row) => row.needsCalibration)?.ref ?? rows[0].ref,
			(value) => {
				done();
				onPick(value);
			},
			() => done(),
		);
		return { component: selector, focus: selector.getSelectList() };
	});
}

/** Confirmation before any batch run: models, surfaces, whether provider calls happen, known cost. */
function confirmBatchCalibration(
	host: ModelRouterSetupHost,
	title: string,
	rows: RouterCalibrationRow[],
	onConfirm: () => void,
): void {
	const words = interfaceText().localModels.routerSetup;
	if (rows.length === 0) {
		host.showStatus(words.batchNothing(title));
		return;
	}
	const knownCost = rows
		.map(
			(row) => host.session.getStoredFitnessReports().find((entry) => entry.model === row.ref)?.report.totalCostUsd,
		)
		.filter((cost): cost is number => typeof cost === "number" && cost > 0);
	const costNote =
		knownCost.length > 0
			? words.batchCostKnown(knownCost.reduce((sum, cost) => sum + cost, 0).toFixed(4), knownCost.length)
			: words.batchCostUnknown;
	host.showSelector((done) => {
		const options: SelectItem[] = [
			{
				value: "run",
				label: words.runOnModels(rows.length),
				description: words.providerCalls(describeRouterCalibrationScope(), costNote),
			},
			...rows.map((row) => ({
				value: `row:${row.ref}`,
				label: row.ref,
				description: formatRouterCalibrationRow(row),
			})),
			{ value: "cancel", label: words.cancelLabel, description: words.cancelDescription },
		];
		const selector = new SelectSubmenu(
			title,
			words.covers(describeRouterCalibrationScope()),
			options,
			"run",
			(value) => {
				done();
				if (value === "run") onConfirm();
				else if (value !== "cancel")
					host.showStatus(formatRouterCalibrationRow(rows.find((row) => `row:${row.ref}` === value)!));
			},
			() => done(),
		);
		return { component: selector, focus: selector.getSelectList() };
	});
}

async function runBatchCalibration(host: ModelRouterSetupHost, rows: RouterCalibrationRow[]): Promise<void> {
	const words = interfaceText().localModels.routerSetup;
	let index = 0;
	for (const row of rows) {
		index += 1;
		host.showStatus(
			words.calibrating({
				modelRef: row.ref,
				index,
				total: rows.length,
				surfaces: describeRouterCalibrationSurfaces(),
			}),
		);
		try {
			const outcome = await host.session.runModelFitness({ model: row.ref });
			if (!outcome.started) {
				harnessLog.debug("ui", "router calibration skipped", { ref: row.ref, skipReason: outcome.skipReason });
				host.showWarning(words.calibrationSkipped(row.ref, plainLabel(outcome.skipReason)));
				continue;
			}
			host.showStatus(words.toolProbeOn(row.ref));
			try {
				await host.session.probeToolCalling(row.ref);
			} catch (error) {
				host.showWarning(
					words.toolProbeUnavailable(row.ref, error instanceof Error ? error.message : String(error)),
				);
			}
		} catch (error) {
			host.showError(words.failed(row.ref, error instanceof Error ? error.message : String(error)));
		}
	}
	const after = calibrationRows(host).filter((row) => rows.some((target) => target.ref === row.ref));
	host.showStatus([words.complete, ...after.map((row) => `- ${formatRouterCalibrationRow(row)}`)].join("\n"));
}

export async function handleModelRouterAction(host: ModelRouterSetupHost, action: string): Promise<void> {
	const words = interfaceText().localModels.routerSetup;
	if (action === "configure-models") {
		// The Models editor owns the pool. When it closes (saved or cancelled), Router Setup comes
		// back on a freshly built pool view, so the summary, calibration rows, tier pickers and the
		// preview all describe the edited pool without a second operator round trip.
		await host.showModelsSelector();
		host.reopenModelRouterSetup();
		host.showStatus(words.poolFollowsModels);
		return;
	}
	if (action === "diagnostics") {
		host.showStatus(host.session.getModelRouterStatus());
		return;
	}
	if (action.startsWith(PREVIEW_PREFIX)) {
		const task = action.slice(PREVIEW_PREFIX.length).trim();
		if (!task) return;
		host.showStatus(formatRoutePreview(host.session.previewRoute(task)));
		return;
	}
	if (action.startsWith(LIVE_PREVIEW_PREFIX)) {
		const task = action.slice(LIVE_PREVIEW_PREFIX.length).trim();
		if (!task) return;
		host.showStatus(words.livePreviewRunning);
		try {
			host.showStatus(formatLiveRoutePreview(await host.session.previewRouteLive(task)));
		} catch (error) {
			host.showError(words.livePreviewFailed(error instanceof Error ? error.message : String(error)));
		}
		return;
	}
	if (action.startsWith(CALIBRATE_ONE_PREFIX)) {
		const ref = action.slice(CALIBRATE_ONE_PREFIX.length).trim();
		if (ref) await host.runFitnessAndAssign(ref);
		return;
	}
	if (action === "calibrate-one") {
		pickPoolModel(host, (ref) => void host.runFitnessAndAssign(ref));
		return;
	}
	if (action === "calibrate-unprobed") {
		const rows = calibrationRows(host).filter((row) => row.needsCalibration);
		confirmBatchCalibration(host, words.calibrateUnprobedTitle, rows, () => void runBatchCalibration(host, rows));
		return;
	}
	if (action === "calibrate-all") {
		const rows = calibrationRows(host);
		confirmBatchCalibration(host, words.calibrateAllTitle, rows, () => void runBatchCalibration(host, rows));
		return;
	}
	host.showWarning(words.unknownAction(action));
}
