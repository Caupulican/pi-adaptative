import { join } from "node:path";
import { expect, it } from "vitest";
import { parseAntigravityModels } from "../../ai/src/utils/antigravity.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { NativeProviderRegistry } from "../src/core/collaboration/native-provider.ts";
import { normalizeNativeProviderSelection } from "../src/core/collaboration/native-selection.ts";
import { resolveWorkerAuthority } from "../src/core/delegation/worker-authority-resolver.ts";
import { buildWorkerUserPromptParts } from "../src/core/delegation/worker-runner.ts";
import { ScriptedProvider } from "./fixtures/harness/scripted-provider.ts";

it("selects an admitted preset in the same Flash family for a deep assignment", () => {
	const catalog = Object.fromEntries(
		["Low", "High"].map((effort, index) => [
			`gemini-test-${effort.toLowerCase()}`,
			{
				displayName: `Gemini Test (${effort})`,
				maxTokens: 100000,
				maxOutputTokens: 8000,
				supportsThinking: true,
				thinkingLevel: index === 0 ? 1 : 3,
			},
		]),
	);
	const flash = parseAntigravityModels(catalog);
	const root = new ScriptedProvider().model("root", 100000);
	const models = [root, ...flash];
	const input = {
		foregroundModel: root,
		modelRegistry: {
			authStorage: AuthStorage.inMemory(),
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			getAvailable: () => models,
			isModelInProviderScope: () => true,
			hasConfiguredAuth: () => true,
		},
		modelUnusableCause: () => undefined,
		accountRouting: {
			account: "other" as const,
			routeProviders: flash.map((model) => `${model.provider}/${model.id}`),
		},
	};
	const ordinary = resolveWorkerAuthority(input);
	const deep = resolveWorkerAuthority({ ...input, authority: { thinkingLevel: "high" } });
	expect(ordinary).toMatchObject({
		ok: true,
		shipment: { modelBinding: { modelId: "gemini-test-low", thinkingLevel: "low" } },
	});
	expect(deep).toMatchObject({
		ok: true,
		shipment: { modelBinding: { modelId: "gemini-test-high", thinkingLevel: "high" } },
	});
	const unavailable = resolveWorkerAuthority({
		...input,
		isModelLimited: (model) => model.id === "gemini-test-high",
		authority: { thinkingLevel: "high" },
	});
	expect(unavailable).toMatchObject({ ok: true, shipment: { modelBinding: { modelId: "gemini-test-low" } } });
});

it("routes a bare Gemini account to Hydrogen at the requested effort and keeps an explicit Flash route", () => {
	const models = parseAntigravityModels(
		Object.fromEntries(
			[
				"gemini-3.8-flash-high",
				...["low", "medium", "high", "xhigh"].map((level) => `gemini-4-hydrogen-${level}`),
			].map((id) => [
				id,
				{
					displayName: id,
					maxTokens: 100000,
					maxOutputTokens: 8000,
					supportsThinking: true,
					thinkingLevel: id.endsWith("-xhigh") ? 100 : id.endsWith("-high") ? 3 : id.endsWith("-medium") ? 2 : 1,
				},
			]),
		),
	);
	const root = new ScriptedProvider().model("root");
	const input = {
		foregroundModel: root,
		modelRegistry: {
			authStorage: AuthStorage.inMemory(),
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			getAvailable: () =>
				models.map((model) => ({
					...model,
					cost: { ...model.cost, output: model.id.endsWith("-xhigh") ? 10 : 1 },
				})),
			isModelInProviderScope: () => true,
			hasConfiguredAuth: () => true,
		},
		modelUnusableCause: () => undefined,
		accountRouting: { account: "other" as const, routeProviders: ["google-antigravity"] },
		authority: { thinkingLevel: "xhigh" as const },
	};
	expect(resolveWorkerAuthority(input)).toMatchObject({
		ok: true,
		shipment: { modelBinding: { modelId: "gemini-4-hydrogen-xhigh", thinkingLevel: "xhigh" } },
	});
	expect(resolveWorkerAuthority({ ...input, isModelLimited: (model) => model.id.endsWith("-xhigh") })).toMatchObject({
		ok: true,
		shipment: { modelBinding: { modelId: "gemini-4-hydrogen-high", thinkingLevel: "high" } },
	});
	expect(
		resolveWorkerAuthority({
			...input,
			accountRouting: { account: "other", routeProviders: ["google-antigravity/gemini-3.8-flash-high"] },
		}),
	).toMatchObject({ ok: true, shipment: { modelBinding: { modelId: "gemini-3.8-flash-high" } } });
});

it("binds native Agy workers to the authenticated catalog at launch", async () => {
	const registry = new NativeProviderRegistry(async (_executable, args) => ({
		code: 0,
		reason: "exited",
		stderr: "",
		stdout: args.includes("models")
			? [
					"gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
					"gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)",
					"gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)",
				].join("\n")
			: "",
	}));
	const tier = normalizeNativeProviderSelection("agy", ["--effort", "high"], { modelTier: "workhorse" });
	const result = await registry.inspect("agy", tier.selection);
	expect(result.status).toBe("ready");
	expect(result.launchArgs).toEqual(expect.arrayContaining(["--model", "gemini-4-hydrogen-high"]));
	expect((await registry.inspect("agy", { model: "gemini-3.8-flash-high" })).status).toBe("ready");
	expect(await registry.inspect("agy", { modelTier: "workhorse", effort: "low" })).toMatchObject({
		status: "model-unavailable",
		authenticated: true,
		launchArgs: [],
	});
	expect(() =>
		normalizeNativeProviderSelection("agy", ["--model", "gemini-3.8-flash-high"], {
			modelTier: "workhorse",
		}),
	).toThrow();
});

it("names the granted edit targets without adding them to the worker's task body", () => {
	const cwd = process.cwd();
	const instructions = "Fix the adapter.";
	const { prompt, body } = buildWorkerUserPromptParts(
		{
			id: "worker",
			instructions,
			route: { tier: "cheap", reasonCode: "fixture", reasons: [], confidence: 1, risk: "scoped-write" },
			envelope: { id: "grant", capabilities: ["filesystem.write"], allowedPaths: [join(cwd, "adapter.ts")] },
		},
		{ cwd, reportTool: true },
	);
	expect(prompt.slice(body.from, body.to)).toBe(instructions);
	expect(prompt).toContain('Write grant (change only what the task requests): ["adapter.ts"]');
});
