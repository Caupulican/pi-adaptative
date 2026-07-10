import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import type { Model } from "@caupulican/pi-ai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { runModelFitnessProbe } from "../src/core/research/model-fitness.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/**
 * Reproduces the reported bug at the boundary where /models suggest (and the manual /fitness
 * picker) consume a probe result and decide whether to offer role adoption: a model that scored
 * 0/3 on every surface must be refused, not walked into the role selector where a reflexive
 * Enter-press lands it as judge model / router settings. `runFitnessAndAssign` is the single site
 * both flows funnel through (see interactive-mode.ts), so it is exercised directly here the same
 * way fitness-role-assignment.test.ts drives `assignFitnessRole` — via the class prototype, with a
 * minimal stand-in `this` instead of a full InteractiveMode (which needs a live TUI/session).
 */

type RunFitnessAndAssignContext = {
	session: {
		runModelFitness: (args: { model: string }) => Promise<unknown>;
		modelRegistry?: ModelRegistry;
	};
	chatContainer: { addChild: (child: unknown) => void };
	ui: { requestRender: () => void };
	showStatus: (text: string) => void;
	showError: (text: string) => void;
	showSelector: (create: (done: () => void) => { component: unknown; focus: unknown }) => void;
};

type RouterProbeSettings = {
	enabled: boolean;
	cheapModel?: string;
	mediumModel?: string;
	expensiveModel?: string;
	learningModel?: string;
	executorModel?: string;
	judgeModel?: string;
	cheapThinking?: ThinkingLevel;
	mediumThinking?: ThinkingLevel;
	expensiveThinking?: ThinkingLevel;
	executorThinking?: ThinkingLevel;
	judgeThinking?: ThinkingLevel;
};

const runFitnessAndAssign = Reflect.get(InteractiveMode.prototype, "runFitnessAndAssign") as (
	this: RunFitnessAndAssignContext & {
		settingsManager?: {
			getModelRouterSettings: () => RouterProbeSettings;
			setModelRouterSettings: (settings: RouterProbeSettings) => void;
		};
	},
	modelRef: string,
	preselectRole?: string,
) => Promise<void>;

function context(runModelFitness: (args: { model: string }) => Promise<unknown>) {
	const statuses: string[] = [];
	const errors: string[] = [];
	let selectorOpened = false;
	const ctx: RunFitnessAndAssignContext = {
		session: { runModelFitness },
		chatContainer: { addChild: vi.fn() },
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn((text: string) => statuses.push(text)),
		showError: vi.fn((text: string) => errors.push(text)),
		showSelector: vi.fn(() => {
			selectorOpened = true;
		}),
	};
	return { ctx, statuses, errors, selectorOpened: () => selectorOpened };
}

function scoutContext(runModelFitness: (args: { model: string }) => Promise<unknown>) {
	const statuses: string[] = [];
	let selectorOpened = 0;
	let scoutSettings = { enabled: false, model: "auto" };
	const ctx = {
		session: { runModelFitness },
		chatContainer: { addChild: vi.fn() },
		ui: { requestRender: vi.fn() },
		settingsManager: {
			getScoutSettings: () => ({ ...scoutSettings }),
			setScoutSettings: (settings: { enabled: boolean; model: string }) => {
				scoutSettings = settings;
			},
			getModelRouterSettings: () => ({ enabled: true }),
			setModelRouterSettings: () => {},
		},
		showStatus: vi.fn((text: string) => statuses.push(text)),
		showError: vi.fn((text: string) => statuses.push(text)),
		showSelector: vi.fn((create) => {
			selectorOpened += 1;
			const created = create(() => {});
			const list = (created.component as { selectList?: { onSelect: (item: { value: string }) => void } })
				.selectList;
			list?.onSelect({ value: "scout" });
		}),
	} as RunFitnessAndAssignContext & {
		settingsManager: {
			getScoutSettings: () => { enabled: boolean; model: string };
			setScoutSettings: (settings: { enabled: boolean; model: string }) => void;
			getModelRouterSettings: () => RouterProbeSettings;
			setModelRouterSettings: (settings: RouterProbeSettings) => void;
		};
	};
	return { ctx, statuses, selectorOpened: () => selectorOpened, getScoutSettings: () => ({ ...scoutSettings }) };
}

function routerContext(
	runModelFitness: (args: { model: string }) => Promise<unknown>,
	startingModelRouter: RouterProbeSettings,
) {
	const statuses: string[] = [];
	let selectorOpened = 0;
	let thinkingSelectorOutput = "";
	let lastModelRouterSettings = { ...startingModelRouter };
	const model: Model<"openai-completions"> = {
		id: "good-model",
		name: "Good Model",
		api: "openai-completions",
		provider: "ollama",
		baseUrl: "http://127.0.0.1:11434/v1",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max", ultra: "max" },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
	const modelRegistry = {
		getAll: () => [model],
		getAvailable: () => [model],
	} as unknown as ModelRegistry;
	const ctx = {
		session: { runModelFitness, modelRegistry },
		chatContainer: { addChild: vi.fn() },
		ui: { requestRender: vi.fn() },
		settingsManager: {
			getContextCurationSettings: () => ({ enabled: false }),
			setContextCurationSettings: () => {},
			getModelRouterSettings: () => ({ ...lastModelRouterSettings }),
			setModelRouterSettings: (settings: RouterProbeSettings) => {
				lastModelRouterSettings = settings;
			},
		},
		showStatus: vi.fn((text: string) => statuses.push(text)),
		showError: vi.fn((text: string) => statuses.push(text)),
		showSelector: vi.fn((create) => {
			selectorOpened += 1;
			const created = create(() => {});
			const component = created.component as {
				selectList?: {
					onSelect: (item: { value: string }) => void;
					render: (width: number) => string[];
				};
			};
			const list = component.selectList;

			if (selectorOpened === 1) {
				if (!list?.onSelect) return;
				list.onSelect({ value: "router-cheap" });
				return;
			}
			thinkingSelectorOutput = list?.render(180).join("\n") ?? "";
			if (!list?.onSelect) return;
			list.onSelect({ value: "ultra" });
		}),
	} as RunFitnessAndAssignContext & {
		settingsManager: {
			getModelRouterSettings: () => RouterProbeSettings;
			setModelRouterSettings: (settings: RouterProbeSettings) => void;
		};
	};
	return {
		ctx,
		statuses,
		selectorOpened: () => selectorOpened,
		thinkingSelectorOutput: () => thinkingSelectorOutput,
		getModelRouterSettings: () => ({ ...lastModelRouterSettings }),
	};
}

/** A scripted completer that never returns parseable output on any surface — the all-failed case. */
const allFailingComplete = async () => ({ text: "", costUsd: 0, stopReason: "stop" });

/** A scripted completer that passes every surface — the fully-capable case. */
const allPassingComplete = async ({ systemPrompt }: { systemPrompt: string }) => {
	if (systemPrompt.includes("context curator")) return { text: '{"digest":"ok"}', costUsd: 0, stopReason: "stop" };
	if (systemPrompt.includes("grep(pattern"))
		return {
			text: '{"tool":"grep","arguments":{"pattern":"x","path":"y"}}',
			costUsd: 0,
			stopReason: "stop",
		};
	if (systemPrompt.includes("STRICT JSON only"))
		return { text: '{"queries":[{"pattern":"x"}]}', costUsd: 0, stopReason: "stop" };
	if (systemPrompt.includes("capability envelope"))
		return { text: '{"summary":"done"}', costUsd: 0, stopReason: "stop" };
	if (systemPrompt.includes("tier"))
		return {
			text: '{"tier":"medium","risk":"read-only","trivial":false,"reason":"ok"}',
			costUsd: 0,
			stopReason: "stop",
		};
	return { text: '{"findings":[{"summary":"finding","confidence":0.8}]}', costUsd: 0, stopReason: "stop" };
};

describe("runFitnessAndAssign gates adoption on the probe verdict", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("refuses adoption and never opens the role selector when every surface scored 0", async () => {
		const report = await runModelFitnessProbe({ trials: 3, now: () => 0, complete: allFailingComplete });
		const { ctx, statuses, selectorOpened } = context(async (args) => ({
			started: true,
			model: args.model,
			report,
		}));

		await runFitnessAndAssign.call(ctx, "ollama/hf.co/prism-ml/Ternary-Bonsai-8B-gguf");

		expect(selectorOpened()).toBe(false);
		expect(
			statuses.some(
				(line) =>
					line.includes("failed the fitness probe on all surfaces") &&
					line.includes("not configured") &&
					line.includes("/model to set it manually"),
			),
		).toBe(true);
	});

	it("still opens the role selector on a partial or full pass (current behavior preserved)", async () => {
		const report = await runModelFitnessProbe({ trials: 1, now: () => 0, complete: allPassingComplete });
		const { ctx, selectorOpened } = context(async (args) => ({ started: true, model: args.model, report }));

		await runFitnessAndAssign.call(ctx, "ollama/good-model");

		expect(selectorOpened()).toBe(true);
	});

	it("passes through a skipped probe unchanged (no report to gate on)", async () => {
		const { ctx, statuses, selectorOpened } = context(async () => ({
			started: false,
			skipReason: "model_unresolved_or_unauthenticated",
		}));

		await runFitnessAndAssign.call(ctx, "ollama/missing-model");

		expect(selectorOpened()).toBe(false);
		expect(statuses.some((line) => line.includes("Model fitness skipped"))).toBe(true);
	});

	it("assigns scout only when the scout_auto gate passes and skips the thinking picker", async () => {
		const report = await runModelFitnessProbe({ trials: 1, now: () => 0, complete: allPassingComplete });
		report.research = { ...report.research, succeeded: 1 };
		report.toolCall = { ...report.toolCall, succeeded: 3 };
		const { ctx, selectorOpened, getScoutSettings } = scoutContext(async (args) => ({
			started: true,
			model: args.model,
			report,
		}));

		await runFitnessAndAssign.call(ctx, "ollama/fastcontext");

		expect(selectorOpened()).toBe(1);
		expect(getScoutSettings()).toEqual({ enabled: true, model: "ollama/fastcontext" });
	});

	it("refuses scout assignment when scout_auto fails and names the lane", async () => {
		const report = await runModelFitnessProbe({ trials: 1, now: () => 0, complete: allPassingComplete });
		report.research = { ...report.research, succeeded: 0 };
		report.toolCall = { ...report.toolCall, succeeded: 3 };
		const { ctx, statuses, getScoutSettings } = scoutContext(async (args) => ({
			started: true,
			model: args.model,
			report,
		}));

		await runFitnessAndAssign.call(ctx, "ollama/fastcontext");

		expect(getScoutSettings()).toEqual({ enabled: false, model: "auto" });
		expect(statuses.some((line) => line.includes("failed research") && line.includes("docs/scout.md"))).toBe(true);
	});

	it("persists router-think profile after assigning a router role from fitness", async () => {
		const report = await runModelFitnessProbe({ trials: 1, now: () => 0, complete: allPassingComplete });
		const { ctx, selectorOpened, thinkingSelectorOutput, getModelRouterSettings } = routerContext(
			async (args) => ({
				started: true,
				model: args.model,
				report,
			}),
			{ enabled: true },
		);

		await runFitnessAndAssign.call(ctx, "ollama/good-model");

		expect(selectorOpened()).toBe(2);
		expect(thinkingSelectorOutput()).toContain("Maximum reasoning depth for the hardest problems");
		expect(thinkingSelectorOutput()).toContain("Maximum reasoning with reinforced proactive delegation");
		expect(getModelRouterSettings()).toMatchObject({
			cheapModel: "ollama/good-model",
			cheapThinking: "ultra",
		});
	});
});
