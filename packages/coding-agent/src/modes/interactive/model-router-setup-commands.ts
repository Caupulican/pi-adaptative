/**
 * Router Setup actions hand-off (Settings → Model Router → Configure models / Calibrate / Preview
 * route / Diagnostics). The settings selector closes and hands one action string here; every
 * provider-spending step (fitness probe, tool probe, live preview) runs only from an explicit
 * operator choice made here, never by opening settings.
 */

import type { Component, SelectItem } from "@caupulican/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import {
	describeRouterCalibration,
	describeRouterCalibrationScope,
	describeRouterCalibrationSurfaces,
	formatRouterCalibrationRow,
	type RouterCalibrationRow,
} from "../../core/model-router/calibration.ts";
import { formatLiveRoutePreview, formatRoutePreview } from "../../core/model-router/route-preview.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { SelectSubmenu } from "./components/settings-selector.ts";

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
	> & { modelRegistry: ModelRegistry };
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
		isSubscription: (model) => host.session.modelRegistry.isUsingSubscription(model),
	});
}

function pickPoolModel(host: ModelRouterSetupHost, onPick: (ref: string) => void): void {
	const rows = calibrationRows(host);
	if (rows.length === 0) {
		host.showStatus("Router calibration: the candidate pool is empty. Configure models first.");
		return;
	}
	host.showSelector((done) => {
		const options: SelectItem[] = rows.map((row) => ({
			value: row.ref,
			label: row.ref,
			description: formatRouterCalibrationRow(row),
		}));
		const selector = new SelectSubmenu(
			"Calibrate One Model",
			`Runs the ${describeRouterCalibrationScope()} (provider calls), then offers a router role.`,
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
	if (rows.length === 0) {
		host.showStatus(`${title}: nothing to calibrate in the current pool.`);
		return;
	}
	const knownCost = rows
		.map(
			(row) => host.session.getStoredFitnessReports().find((entry) => entry.model === row.ref)?.report.totalCostUsd,
		)
		.filter((cost): cost is number => typeof cost === "number" && cost > 0);
	const costNote =
		knownCost.length > 0
			? `last fitness runs cost $${knownCost.reduce((sum, cost) => sum + cost, 0).toFixed(4)} across ${knownCost.length} model(s)`
			: "cost unknown until the first run (subscription-backed models may cost $0.00)";
	host.showSelector((done) => {
		const options: SelectItem[] = [
			{
				value: "run",
				label: `Run calibration on ${rows.length} model(s)`,
				description: `Provider calls: yes (${describeRouterCalibrationScope()}, per model). ${costNote}.`,
			},
			...rows.map((row) => ({
				value: `row:${row.ref}`,
				label: row.ref,
				description: formatRouterCalibrationRow(row),
			})),
			{ value: "cancel", label: "Cancel", description: "Run nothing." },
		];
		const selector = new SelectSubmenu(
			title,
			`Covers ${describeRouterCalibrationScope()}. Models run one at a time.`,
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
	let index = 0;
	for (const row of rows) {
		index += 1;
		host.showStatus(`Calibrating ${row.ref} (${index}/${rows.length}): ${describeRouterCalibrationSurfaces()}…`);
		try {
			const outcome = await host.session.runModelFitness({ model: row.ref });
			if (!outcome.started) {
				host.showWarning(`Calibration skipped for ${row.ref}: ${outcome.skipReason}`);
				continue;
			}
			host.showStatus(`Calibrating ${row.ref}: real tool execution probe…`);
			try {
				await host.session.probeToolCalling(row.ref);
			} catch (error) {
				host.showWarning(
					`Tool probe unavailable for ${row.ref}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} catch (error) {
			host.showError(`Calibration failed for ${row.ref}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const after = calibrationRows(host).filter((row) => rows.some((target) => target.ref === row.ref));
	host.showStatus(
		["Router calibration complete:", ...after.map((row) => `- ${formatRouterCalibrationRow(row)}`)].join("\n"),
	);
}

export async function handleModelRouterAction(host: ModelRouterSetupHost, action: string): Promise<void> {
	if (action === "configure-models") {
		// The Models editor owns the pool. When it closes (saved or cancelled), Router Setup comes
		// back on a freshly built pool view, so the summary, calibration rows, tier pickers and the
		// preview all describe the edited pool without a second operator round trip.
		await host.showModelsSelector();
		host.reopenModelRouterSetup();
		host.showStatus("Router pool follows the Models selection; Router Setup is showing the edited pool.");
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
		host.showStatus("Live route preview running (routing judge / H-MoE may spend)…");
		try {
			host.showStatus(formatLiveRoutePreview(await host.session.previewRouteLive(task)));
		} catch (error) {
			host.showError(`Live route preview failed: ${error instanceof Error ? error.message : String(error)}`);
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
		confirmBatchCalibration(host, "Calibrate Unprobed Models", rows, () => void runBatchCalibration(host, rows));
		return;
	}
	if (action === "calibrate-all") {
		const rows = calibrationRows(host);
		confirmBatchCalibration(host, "Recalibrate Selected Models", rows, () => void runBatchCalibration(host, rows));
		return;
	}
	host.showWarning(`Unknown router setup action: ${action}`);
}
