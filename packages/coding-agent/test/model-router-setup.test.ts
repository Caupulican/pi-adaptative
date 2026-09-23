import type { Component } from "@caupulican/pi-tui";
import { setKeybindings } from "@caupulican/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	describeRouterCalibration,
	describeRouterCalibrationScope,
	FITNESS_EVIDENCE_MAX_AGE_MS,
	formatRouterCalibrationRow,
} from "../src/core/model-router/calibration.ts";
import type { StoredFitnessReport } from "../src/core/models/fitness-store.ts";
import type { ModelFitnessReport } from "../src/core/research/model-fitness.ts";
import {
	type ModelRouterPoolView,
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import {
	handleModelRouterAction,
	type ModelRouterSetupHost,
} from "../src/modes/interactive/model-router-setup-commands.ts";
import { buildModelRouterPoolView } from "../src/modes/interactive/settings-selector-flow.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function fitnessReport(overrides: Partial<ModelFitnessReport> = {}): ModelFitnessReport {
	const lane = { succeeded: 3, total: 3, outcomes: [], meanMs: 10 };
	return {
		trials: 3,
		research: { ...lane },
		worker: { ...lane },
		search: { ...lane },
		toolCall: { ...lane },
		digest: { ...lane },
		totalCostUsd: 0.01,
		...overrides,
	};
}

const host: StoredFitnessReport["host"] = { id: "host", cpu: "fixture-cpu", cores: 4, totalMemGb: 16 };
const subModel = { provider: "sub", id: "sub-max" } as never;
const apiModel = { provider: "api", id: "api-mini" } as never;
const neverProbed = { provider: "api", id: "api-new" } as never;
const localModel = { provider: "ollama", id: "local-8b", contextWindow: 8192 } as never;

describe("Router calibration evidence (F001-070..075)", () => {
	const now = new Date("2026-09-20T12:00:00Z");

	it("F001-071/073/074: states come from FitnessStore + tool probe per surface, stale never looks fresh", () => {
		const fresh: StoredFitnessReport = {
			model: "sub/sub-max",
			report: fitnessReport(),
			at: "2026-09-19T00:00:00Z",
			host,
		};
		const failedWorker: StoredFitnessReport = {
			model: "api/api-mini",
			report: fitnessReport({ worker: { succeeded: 0, total: 3, outcomes: [], meanMs: 1 } }),
			at: new Date(now.getTime() - FITNESS_EVIDENCE_MAX_AGE_MS - 1).toISOString(),
			host,
		};
		const rows = describeRouterCalibration([subModel, apiModel, neverProbed], {
			fitnessReports: [fresh, failedWorker],
			toolProbe: (model) =>
				model === subModel ? { version: 1, status: "native", probedAt: "2026-09-18T00:00:00Z" } : undefined,
			isSubscription: (model) => model === subModel,
			now,
		});
		expect(rows[0]).toMatchObject({
			ref: "sub/sub-max",
			subscription: true,
			toolProbe: "native",
			needsCalibration: false,
			surfaces: {
				router_cheap: "FIT",
				router_medium: "FIT",
				router_expensive: "FIT",
				executor: "FIT",
			},
		});
		// Old evidence: STALE on every probed surface, never FIT/UNFIT as if fresh.
		expect(rows[1].staleReason).toContain("older than 30 days");
		expect(rows[1].needsCalibration).toBe(true);
		expect(Object.values(rows[1].surfaces)).toEqual(["STALE", "STALE", "STALE", "STALE"]);
		expect(rows[2]).toMatchObject({ ref: "api/api-new", needsCalibration: true });
		expect(Object.values(rows[2].surfaces)).toEqual(["UNPROBED", "UNPROBED", "UNPROBED", "UNPROBED"]);
		const line = formatRouterCalibrationRow(rows[0]);
		expect(line).toBe(
			"sub/sub-max · subscription · cheap FIT · medium FIT · expensive FIT · executor FIT · tool native · probed 2026-09-19",
		);
		// F001-075: no universal score anywhere in the row.
		expect(line.toLowerCase()).not.toContain("score");
	});

	it("F001-074: a tool probe newer than the fitness evidence marks it stale", () => {
		const report: StoredFitnessReport = {
			model: "api/api-mini",
			report: fitnessReport(),
			at: "2026-09-10T00:00:00Z",
			host,
		};
		const [row] = describeRouterCalibration([apiModel], {
			fitnessReports: [report],
			toolProbe: () => ({ version: 1, status: "text-protocol", probedAt: "2026-09-15T00:00:00Z" }),
			isSubscription: () => false,
			now,
		});
		expect(row.staleReason).toContain("tool probe");
		expect(row.surfaces.router_medium).toBe("STALE");
	});

	it("a report that covers only part of the router surfaces still needs calibration", () => {
		// Evidence about the research/worker/digest lanes, none about the tool-call lane every
		// router surface here needs.
		const { toolCall: _toolCall, ...withoutToolCall } = fitnessReport();
		const report: StoredFitnessReport = {
			model: "api/api-mini",
			report: withoutToolCall as ModelFitnessReport,
			at: now.toISOString(),
			host,
		};
		const [row] = describeRouterCalibration([apiModel], {
			fitnessReports: [report],
			toolProbe: () => undefined,
			isSubscription: () => false,
			now,
		});
		expect(row.staleReason).toBeUndefined();
		expect(row.surfaces).toMatchObject({
			router_cheap: "UNPROBED",
			router_medium: "UNPROBED",
			router_expensive: "UNPROBED",
			executor: "UNPROBED",
		});
		expect(row.needsCalibration).toBe(true);
	});

	it("a fully probed fresh report needs no calibration", () => {
		const [row] = describeRouterCalibration([apiModel], {
			fitnessReports: [{ model: "api/api-mini", report: fitnessReport(), at: now.toISOString(), host }],
			toolProbe: () => undefined,
			isSubscription: () => false,
			now,
		});
		expect(Object.values(row.surfaces)).toEqual(["FIT", "FIT", "FIT", "FIT"]);
		expect(row.needsCalibration).toBe(false);
	});

	it("FC-045: a context window different from the probed one marks the evidence stale", () => {
		const capacity = { registeredContextWindow: 4096, servedContextWindow: 4096, outcomes: [], meanMs: 5 };
		const [row] = describeRouterCalibration([localModel], {
			fitnessReports: [
				{
					model: "ollama/local-8b",
					report: fitnessReport({ capacity }),
					at: now.toISOString(),
					host,
				},
			],
			toolProbe: () => undefined,
			isSubscription: () => false,
			now,
		});
		expect(row.staleReason).toBe("context window changed (4096 at probe time, 8192 now)");
		expect(row.needsCalibration).toBe(true);
		expect(Object.values(row.surfaces)).toEqual(["STALE", "STALE", "STALE", "STALE"]);
	});

	it("the same context window keeps the evidence fresh", () => {
		const capacity = { registeredContextWindow: 8192, servedContextWindow: 8192, outcomes: [], meanMs: 5 };
		const [row] = describeRouterCalibration([localModel], {
			fitnessReports: [
				{ model: "ollama/local-8b", report: fitnessReport({ capacity }), at: now.toISOString(), host },
			],
			toolProbe: () => undefined,
			isSubscription: () => false,
			now,
		});
		expect(row.staleReason).toBeUndefined();
		expect(row.needsCalibration).toBe(false);
	});

	it("calibration copy is derived from the canonical surface list, never a literal count", () => {
		const scope = describeRouterCalibrationScope();
		expect(scope).toBe("4 router fitness surfaces (cheap, medium, expensive, executor) + real tool execution probe");
		expect(scope).not.toContain("5");
	});

	it("an UNFIT surface is reported per surface, not as a model-wide verdict", () => {
		const report: StoredFitnessReport = {
			model: "api/api-mini",
			report: fitnessReport({ worker: { succeeded: 0, total: 3, outcomes: [], meanMs: 1 } }),
			at: now.toISOString(),
			host,
		};
		const [row] = describeRouterCalibration([apiModel], {
			fitnessReports: [report],
			toolProbe: () => undefined,
			isSubscription: () => false,
			now,
		});
		expect(row.surfaces.router_medium).toBe("UNFIT");
		expect(row.surfaces.router_cheap).toBe("FIT");
	});
});

function poolView(overrides: Partial<ModelRouterPoolView> = {}): ModelRouterPoolView {
	return {
		customized: true,
		summary: "2 selected models (Models selector)",
		refs: ["sub/sub-max", "api/api-mini"],
		subscriptionRefs: ["sub/sub-max"],
		favoriteRefs: ["api/api-mini"],
		calibration: ["sub/sub-max · subscription · cheap FIT", "api/api-mini · metered · cheap UNPROBED"],
		needsCalibration: ["api/api-mini"],
		...overrides,
	};
}

function makeConfig(overrides: Partial<SettingsConfig> = {}): SettingsConfig {
	return {
		autoCompact: true,
		costGuard: { enabled: false, maxTurnUsd: 0, action: "warn" },
		showImages: false,
		imageWidthCells: 60,
		autoResizeImages: true,
		blockImages: false,
		enableSkillCommands: true,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		transport: "auto",
		httpIdleTimeoutMs: 300000,
		thinkingLevel: "medium",
		availableThinkingLevels: ["off", "medium", "high"],
		currentTheme: "dark",
		availableThemes: ["dark"],
		hideThinkingBlock: false,
		projectContextFiles: "off",
		collapseChangelog: false,
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		showHardwareCursor: false,
		editorPaddingX: 0,
		autocompleteMaxVisible: 5,
		quietStartup: false,
		clearOnShrink: false,
		showTerminalProgress: false,
		warnings: {},
		selfModification: { enabled: false },
		autonomy: { mode: "off", maxStallTurns: 20 },
		researchLane: {},
		workerDelegation: {},
		contextCuration: {},
		learningPolicy: {},
		modelCapability: {},
		modelRouter: {
			enabled: true,
			selectionMode: "hybrid",
			poolPreference: "subscription-first",
			mediumModel: "api/api-mini",
		},
		modelRouterPool: poolView(),
		autoLearn: {},
		contextPolicyEnforcement: {},
		contextMemoryRetrieval: {},
		currentModelPattern: "sub/sub-max",
		autoLearnModelOptions: [
			{ value: "api/outsider", label: "api/outsider", description: "API · API key" },
			{ value: "sub/sub-max", label: "sub/sub-max", description: "Sub · subscription" },
			{ value: "api/api-mini", label: "api/api-mini", description: "API · API key" },
		],
		...overrides,
	};
}

function makeCallbacks(overrides: Partial<SettingsCallbacks> = {}): SettingsCallbacks {
	const noop = () => vi.fn();
	return {
		onAutoCompactChange: noop(),
		onCostGuardChange: noop(),
		onShowImagesChange: noop(),
		onImageWidthCellsChange: noop(),
		onAutoResizeImagesChange: noop(),
		onBlockImagesChange: noop(),
		onEnableSkillCommandsChange: noop(),
		onSteeringModeChange: noop(),
		onFollowUpModeChange: noop(),
		onTransportChange: noop(),
		onHttpIdleTimeoutMsChange: noop(),
		onThinkingLevelChange: noop(),
		onThemeChange: noop(),
		onHideThinkingBlockChange: noop(),
		onProjectContextFilesChange: noop(),
		onCollapseChangelogChange: noop(),
		onDoubleEscapeActionChange: noop(),
		onTreeFilterModeChange: noop(),
		onShowHardwareCursorChange: noop(),
		onEditorPaddingXChange: noop(),
		onAutocompleteMaxVisibleChange: noop(),
		onQuietStartupChange: noop(),
		onClearOnShrinkChange: noop(),
		onShowTerminalProgressChange: noop(),
		onWarningsChange: noop(),
		onSelfModificationChange: noop(),
		onAutonomyChange: noop(),
		onResearchLaneChange: noop(),
		onWorkerDelegationChange: noop(),
		onContextCurationChange: noop(),
		onLearningPolicyChange: noop(),
		onModelCapabilityChange: noop(),
		onModelRouterChange: noop(),
		onAutoLearnChange: noop(),
		onContextPolicyEnforcementChange: noop(),
		onContextMemoryRetrievalChange: noop(),
		onCancel: noop(),
		...overrides,
	};
}

const DOWN = "\x1b[B";

describe("Router Setup settings screen (F001-060..065)", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	function openRouter(selector: SettingsSelectorComponent): void {
		selector.getSettingsList().handleInput("model router");
		selector.getSettingsList().handleInput("\r");
	}

	/**
	 * Presses DOWN until the cursor row (the settings list marks it with "→ ", see
	 * `getSettingsListTheme` in theme.ts) contains `label`, bounded so a menu-shape change fails
	 * loudly instead of silently landing on the wrong row (a hardcoded press count used to do that
	 * whenever a row was added/removed above the target).
	 */
	function pressDownUntilCursorRowContains(selector: SettingsSelectorComponent, label: string, maxPresses = 30): void {
		for (let attempt = 0; attempt <= maxPresses; attempt++) {
			const output = stripAnsi(selector.render(200).join("\n"));
			const cursorLine = output.split("\n").find((line) => line.includes("→ "));
			if (cursorLine?.includes(label)) return;
			if (attempt === maxPresses) {
				throw new Error(`cursor never reached a row containing "${label}" within ${maxPresses} DOWN presses`);
			}
			selector.getSettingsList().handleInput(DOWN);
		}
	}

	it("F001-063/064/065: shows selection mode, candidate pool summary and pool preference", () => {
		const selector = new SettingsSelectorComponent(makeConfig(), makeCallbacks());
		openRouter(selector);
		const output = stripAnsi(selector.render(200).join("\n"));
		expect(output).toContain("Selection mode");
		expect(output).toContain("hybrid");
		expect(output).toContain("Candidate pool");
		expect(output).toContain("2 selected models (Models selector)");
		expect(output).toContain("Pool preference");
		expect(output).toContain("subscription-first");
		// HYBRID: an unpinned tier reads AUTO, the pinned tier keeps its model.
		expect(output).toContain("Cheap model");
		expect(output).toMatch(/Cheap model\s+AUTO/);
		expect(output).toMatch(/Medium model\s+api\/api-mini/);
	});

	it("F001-062: tier pickers show (AUTO), favorites first, then the pool, then outside-pool entries marked", () => {
		const selector = new SettingsSelectorComponent(makeConfig(), makeCallbacks());
		openRouter(selector);
		for (let index = 0; index < 5; index++) selector.getSettingsList().handleInput(DOWN);
		selector.getSettingsList().handleInput("\r");
		const output = stripAnsi(selector.render(200).join("\n"));
		expect(output).toContain("Cheap / Research Model");
		expect(output).toContain("(AUTO)");
		const auto = output.indexOf("(AUTO)");
		const favorite = output.indexOf("api/api-mini");
		const poolEntry = output.indexOf("sub/sub-max");
		const outsiderEntry = output.indexOf("api/outsider");
		expect(auto).toBeLessThan(favorite);
		expect(favorite).toBeLessThan(poolEntry);
		expect(poolEntry).toBeLessThan(outsiderEntry);
		expect(output).toContain("outside pool");
	});

	it("persists a selection-mode change and a pool-preference change", () => {
		const onModelRouterChange = vi.fn();
		const selector = new SettingsSelectorComponent(makeConfig(), makeCallbacks({ onModelRouterChange }));
		openRouter(selector);
		selector.getSettingsList().handleInput(DOWN);
		selector.getSettingsList().handleInput(DOWN);
		selector.getSettingsList().handleInput("\r"); // hybrid -> manual (cycles)
		expect(onModelRouterChange).toHaveBeenLastCalledWith(
			expect.objectContaining({ selectionMode: "manual" }),
			"global",
		);
		selector.getSettingsList().handleInput(DOWN);
		selector.getSettingsList().handleInput(DOWN);
		selector.getSettingsList().handleInput("\r"); // subscription-first -> balanced
		expect(onModelRouterChange).toHaveBeenLastCalledWith(
			expect.objectContaining({ poolPreference: "balanced" }),
			"global",
		);
	});

	it("F001-061: Configure models hands off to the existing Models UI through the action callback", () => {
		const onModelRouterAction = vi.fn();
		const selector = new SettingsSelectorComponent(makeConfig(), makeCallbacks({ onModelRouterAction }));
		openRouter(selector);
		for (let index = 0; index < 3; index++) selector.getSettingsList().handleInput(DOWN);
		selector.getSettingsList().handleInput("\r"); // Candidate pool submenu
		const output = stripAnsi(selector.render(200).join("\n"));
		expect(output).toContain("Configure models");
		expect(output).toContain("sub/sub-max");
		selector.getSettingsList().handleInput("\r");
		expect(onModelRouterAction).toHaveBeenCalledWith("configure-models");
	});

	it("FC-032/033: an initial item opens Router Setup directly on the pool it was built with", () => {
		const selector = new SettingsSelectorComponent(
			makeConfig({
				initialItemId: "model-router",
				modelRouterPool: poolView({
					summary: "1 selected model (Models config)",
					refs: ["api/api-mini"],
					subscriptionRefs: [],
					favoriteRefs: [],
					calibration: ["api/api-mini · metered · cheap UNPROBED"],
					needsCalibration: ["api/api-mini"],
				}),
			}),
			makeCallbacks(),
		);
		const output = stripAnsi(selector.render(200).join("\n"));
		expect(output).toContain("Model Router");
		// The reopened submenu reads the pool view it was built with, not the one from a prior open.
		expect(output).toMatch(/Candidate pool\s+1 selected model \(Models config\)/);
	});

	it("F001-070: opening the Calibrate menu runs nothing; only a chosen action leaves the screen", () => {
		const onModelRouterAction = vi.fn();
		const selector = new SettingsSelectorComponent(makeConfig(), makeCallbacks({ onModelRouterAction }));
		openRouter(selector);
		pressDownUntilCursorRowContains(selector, "Calibrate");
		selector.getSettingsList().handleInput("\r");
		const output = stripAnsi(selector.render(200).join("\n"));
		expect(output).toContain("Router Calibration");
		expect(output).toContain("Calibrate one model");
		expect(output).toContain("Calibrate unprobed (1)");
		expect(output).toContain("Recalibrate selected (2)");
		expect(onModelRouterAction).not.toHaveBeenCalled();
		selector.getSettingsList().handleInput(DOWN);
		selector.getSettingsList().handleInput("\r");
		expect(onModelRouterAction).toHaveBeenCalledWith("calibrate-unprobed");
	});
});

describe("Router Setup actions (F001-070..072, F001-080..082)", () => {
	function makeHost(overrides: Partial<ModelRouterSetupHost> = {}): ModelRouterSetupHost & {
		statuses: string[];
		selectors: Array<{ component: Component; focus: Component }>;
	} {
		const statuses: string[] = [];
		const selectors: Array<{ component: Component; focus: Component }> = [];
		const reports: StoredFitnessReport[] = [
			{ model: "sub/sub-max", report: fitnessReport(), at: new Date().toISOString(), host },
		];
		const base: ModelRouterSetupHost = {
			session: {
				runModelFitness: vi.fn(async ({ model }) => ({ started: true as const, model, report: fitnessReport() })),
				probeToolCalling: vi.fn(async () => ({ results: [], table: "" })),
				getRouterCandidatePool: () => ({ customized: true, models: [subModel, apiModel] }),
				getStoredFitnessReports: () => reports,
				getToolProbeRecord: () => undefined,
				getModelRouterStatus: () => "Status: enabled\nSelection mode: HYBRID",
				previewRoute: vi.fn(() => ({
					intent: "modify",
					baselineTier: "medium",
					risk: "scoped-write",
					reasonCode: "normal_implementation",
					selectionMode: "hybrid",
					poolPreference: "subscription-first",
					pool: { customized: true, count: 2 },
					subscriptionCandidates: 1,
					eligibleCandidates: 2,
					chosenModel: "sub/sub-max",
					selection: "auto",
					candidates: [],
				})),
				previewRouteLive: vi.fn(async () => ({
					tier: "medium",
					risk: "scoped-write",
					reasonCode: "normal_implementation",
					chosenModel: "sub/sub-max",
					selection: "hmoe",
					poolPreference: "subscription-first",
					fitness: "fit",
					reasons: ["H-MoE selected sub/sub-max"],
				})),
				modelRegistry: { isUsingSubscription: (model: unknown) => model === subModel },
			} as unknown as ModelRouterSetupHost["session"],
			settingsManager: {} as ModelRouterSetupHost["settingsManager"],
			showStatus: (message) => statuses.push(message),
			showWarning: (message) => statuses.push(`WARN ${message}`),
			showError: (message) => statuses.push(`ERR ${message}`),
			showSelector: (create) => selectors.push(create(() => {})),
			showModelsSelector: vi.fn(async () => {}),
			reopenModelRouterSetup: vi.fn(() => {}),
			runFitnessAndAssign: vi.fn(async () => {}),
			...overrides,
		};
		return { ...base, statuses, selectors };
	}

	it("F001-080/082: preview:<task> is deterministic — previewRoute only, never the live path", async () => {
		const h = makeHost();
		await handleModelRouterAction(h, "preview:Implement the settings submenu");
		expect(h.session.previewRoute).toHaveBeenCalledWith("Implement the settings submenu");
		expect(h.session.previewRouteLive).not.toHaveBeenCalled();
		expect(h.statuses.at(-1)).toContain("Would choose: sub/sub-max");
		expect(h.statuses.at(-1)).toContain("no provider call was made");
	});

	it("F001-081/083: preview-live:<task> is the explicit live path and reports tier/model/source/preference/fitness", async () => {
		const h = makeHost();
		await handleModelRouterAction(h, "preview-live:Implement the settings submenu");
		expect(h.session.previewRouteLive).toHaveBeenCalledWith("Implement the settings submenu");
		const text = h.statuses.at(-1) ?? "";
		expect(text).toContain("Chosen tier: medium");
		expect(text).toContain("Chosen model: sub/sub-max");
		expect(text).toContain("Source: router/H-MoE");
		expect(text).toContain("Preference: subscription-first");
		expect(text).toContain("Fitness: fit");
	});

	it("F001-070/072: batch calibration shows a confirmation and runs nothing until confirmed", async () => {
		const h = makeHost();
		await handleModelRouterAction(h, "calibrate-unprobed");
		expect(h.session.runModelFitness).not.toHaveBeenCalled();
		expect(h.selectors).toHaveLength(1);
		const rendered = stripAnsi(h.selectors[0].component.render(200).join("\n"));
		expect(rendered).toContain("Calibrate Unprobed Models");
		expect(rendered).toContain("Run calibration on 1 model(s)");
		expect(rendered).toContain("Provider calls: yes");
		expect(rendered).toContain("api/api-mini");
		expect(rendered).not.toContain("sub/sub-max ·");
	});

	it("F001-071: a confirmed batch reuses runModelFitness then the tool probe, per model", async () => {
		const h = makeHost();
		await handleModelRouterAction(h, "calibrate-all");
		const selector = h.selectors[0].component as { handleInput(data: string): void };
		selector.handleInput("\r"); // "run" is preselected
		await vi.waitFor(() => expect(h.session.runModelFitness).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(h.session.probeToolCalling).toHaveBeenCalledTimes(2));
		expect(h.session.runModelFitness).toHaveBeenCalledWith({ model: "sub/sub-max" });
		expect(h.session.probeToolCalling).toHaveBeenCalledWith("api/api-mini");
		await vi.waitFor(() => expect(h.statuses.at(-1)).toContain("Router calibration complete"));
	});

	it("calibrate:<ref> and Configure models reuse the existing flows", async () => {
		const h = makeHost();
		await handleModelRouterAction(h, "calibrate:sub/sub-max");
		expect(h.runFitnessAndAssign).toHaveBeenCalledWith("sub/sub-max");
		await handleModelRouterAction(h, "configure-models");
		expect(h.showModelsSelector).toHaveBeenCalledTimes(1);
		await handleModelRouterAction(h, "diagnostics");
		expect(h.statuses.at(-1)).toContain("Selection mode: HYBRID");
	});

	it("Configure models reopens Router Setup once the editor closed; nothing asks the operator to reopen", async () => {
		const order: string[] = [];
		const h = makeHost({
			showModelsSelector: vi.fn(async () => {
				order.push("models-editor");
			}),
			reopenModelRouterSetup: vi.fn(() => {
				order.push("router-setup");
			}),
		});
		await handleModelRouterAction(h, "configure-models");
		expect(order).toEqual(["models-editor", "router-setup"]);
		expect(h.statuses.at(-1)?.toLowerCase()).not.toContain("reopen");
		expect(h.statuses.at(-1)).toContain("Router Setup is showing the edited pool");
	});

	it("the batch confirmation describes the canonical surfaces, not a hardcoded count", async () => {
		const h = makeHost();
		await handleModelRouterAction(h, "calibrate-all");
		const rendered = stripAnsi(h.selectors[0].component.render(200).join("\n"));
		expect(rendered).toContain("4 router fitness surfaces");
		expect(rendered).not.toContain("5 fitness surfaces");
	});
});

describe("buildModelRouterPoolView (F001-070)", () => {
	it("reads live pool, favorites and evidence without running a probe", () => {
		const runModelFitness = vi.fn();
		const view = buildModelRouterPoolView({
			session: {
				getRouterCandidatePool: () => ({ customized: false, source: "all_enabled", models: [subModel, apiModel] }),
				getStoredFitnessReports: () => [],
				getToolProbeRecord: () => undefined,
				modelRegistry: { isUsingSubscription: (model: unknown) => model === subModel },
				runModelFitness,
			} as never,
			settingsManager: { getModelFavorites: () => [{ provider: "api", modelId: "api-mini" }] } as never,
		});
		expect(runModelFitness).not.toHaveBeenCalled();
		expect(view).toMatchObject({
			customized: false,
			summary: "all enabled models (2)",
			refs: ["sub/sub-max", "api/api-mini"],
			subscriptionRefs: ["sub/sub-max"],
			favoriteRefs: ["api/api-mini"],
			needsCalibration: ["sub/sub-max", "api/api-mini"],
		});
		expect(view.calibration[1]).toContain("never probed");
	});
});
