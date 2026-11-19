import { join } from "node:path";
import { expect, it } from "vitest";
import { parseAntigravityModels } from "../../ai/src/utils/antigravity.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
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
