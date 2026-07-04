import { describe, expect, it, vi } from "vitest";
import { runModelFitnessProbe } from "../src/core/research/model-fitness.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

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
	session: { runModelFitness: (args: { model: string }) => Promise<unknown> };
	chatContainer: { addChild: (child: unknown) => void };
	ui: { requestRender: () => void };
	showStatus: (text: string) => void;
	showError: (text: string) => void;
	showSelector: (create: (done: () => void) => { component: unknown; focus: unknown }) => void;
};

const runFitnessAndAssign = Reflect.get(InteractiveMode.prototype, "runFitnessAndAssign") as (
	this: RunFitnessAndAssignContext,
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

/** A scripted completer that never returns parseable output on any surface — the all-failed case. */
const allFailingComplete = async () => ({ text: "not json", costUsd: 0, stopReason: "stop" });

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
});
