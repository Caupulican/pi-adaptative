import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAntigravityModels } from "../../ai/src/utils/antigravity.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelSelectionController, type ModelSelectionControllerDeps } from "../src/core/model-selection-controller.ts";
import { ownerSessionStorageRoots } from "../src/core/orchestration/session-bundle-lifecycle.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/kernel/node.ts";

const catalog = parseAntigravityModels(
	Object.fromEntries(
		["Neon", "Hydrogen"].flatMap((family) =>
			[
				["XHigh", 100],
				["Low", 1],
				["High", 3],
				["Medium", 2],
			].map(([label, thinkingLevel]) => [
				`gemini-4-${family}-${label}`.toLowerCase(),
				{
					displayName: `Gemini 4 ${family} (${label})`,
					maxTokens: 1048576,
					maxOutputTokens: 262144,
					supportsThinking: true,
					thinkingLevel,
				},
			]),
		),
	),
);

function next(current: string, scoped: string[] = [], excluded?: string) {
	const model = catalog.find((candidate) => candidate.id === current)!;
	const selection = new ModelSelectionController({
		getModel: () => model,
		getThinkingLevel: () => model.defaultThinkingLevel,
		getScopedModels: () => catalog.filter((candidate) => scoped.includes(candidate.id)).map((model) => ({ model })),
		getModelRegistry: () => ({
			getAvailable: () => catalog,
			hasConfiguredAuth: (candidate: typeof model) => candidate.id !== excluded,
		}),
	} as ModelSelectionControllerDeps);
	const target = selection.nextThinkingSelection();
	return typeof target === "object" ? target.id : target;
}

describe("fixed-effort subscription selection", () => {
	it.each(["neon", "hydrogen"])("cycles all admitted %s presets in provider effort order", (family) => {
		const id = (level: string) => `gemini-4-${family}-${level}`;
		expect(["low", "medium", "high", "xhigh"].map((level) => next(id(level)))).toEqual(
			["medium", "high", "xhigh", "low"].map(id),
		);
	});

	it("skips unauthorized and out-of-scope presets without crossing model families", () => {
		const low = "gemini-4-neon-low";
		const high = "gemini-4-neon-high";
		const xhigh = "gemini-4-neon-xhigh";
		const scoped = [low, high, xhigh, "gemini-4-hydrogen-medium"];
		expect(next(low, scoped)).toBe(high);
		expect(next(high, scoped, xhigh)).toBe(low);
		expect(next(high, [high])).toBe("high");
	});
});

it.each([true, false])("applies a preset switch through the session model policy (pinned=%s)", async (pinnedModel) => {
	const root = await mkdtemp(join(tmpdir(), "pi-neon-cycle-"));
	try {
		const model = catalog.find((entry) => entry.id === "gemini-4-neon-high")!;
		const sessionManager = SessionManager.inMemory(ownerSessionStorageRoots(join(root, "agent")), root);
		const { session } = await createAgentSession({
			sessionManager,
			cwd: root,
			agentDir: join(root, "agent"),
			model,
			pinnedModel,
			systemOneEnabled: false,
			tools: [],
			scopedModels: catalog.map((model) => ({ model })),
			authStorage: AuthStorage.inMemory({ "google-antigravity": { type: "api_key", key: "fixture" } }),
		});
		try {
			const edits = sessionManager.getBranch().length;
			if (pinnedModel) {
				await expect(session.cycleThinkingLevel()).rejects.toThrow(
					/runs only on google-antigravity\/gemini-4-neon-high/,
				);
				expect(session.model?.id).toBe(model.id);
				expect(session.thinkingLevel).toBe("high");
				expect(sessionManager.getBranch()).toHaveLength(edits);
			} else {
				await expect(session.cycleThinkingLevel()).resolves.toBe("xhigh");
				expect(session.model?.id).toBe("gemini-4-neon-xhigh");
				expect(sessionManager.getBranch().slice(edits)).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ type: "model_change", modelId: "gemini-4-neon-xhigh" }),
						expect.objectContaining({ type: "thinking_level_change", thinkingLevel: "xhigh" }),
					]),
				);
			}
		} finally {
			await session.disposeAndWait();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
