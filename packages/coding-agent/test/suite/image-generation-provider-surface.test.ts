import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "./harness.ts";

afterEach(() => vi.unstubAllEnvs());

describe("subscription image tool session surface", () => {
	it("restores the requested image tool only when the actual session switches back to ChatGPT", async () => {
		const harness = await createHarness({
			fauxProvider: { provider: "openai-codex", api: "faux-images-surface" },
			initialActiveToolNames: ["read", "image_generate"],
			settings: { modelCapability: { mode: "full" } },
		});
		const original = harness.getModel();
		const foreign = { ...original, provider: "image-surface-other", id: "foreign" };
		harness.authStorage.setRuntimeApiKey(foreign.provider, "faux-key");
		harness.session.modelRegistry.registerProvider(foreign.provider, {
			api: foreign.api,
			baseUrl: foreign.baseUrl,
			apiKey: "faux-key",
			models: [foreign],
		});
		try {
			expect(harness.session.getToolDefinition("image_generate")).toBeDefined();
			for (const model of [original, foreign, original, foreign, original]) {
				await harness.session.setModel(model);
				const expected = model.provider === "openai-codex";
				expect(harness.session.getActiveToolNames().includes("image_generate")).toBe(expected);
				harness.setResponses([
					(context, _options, _state, selected) => {
						expect(selected.provider).toBe(model.provider);
						expect(context.tools?.some((tool) => tool.name === "image_generate")).toBe(expected);
						return fauxAssistantMessage("Surface verified; no image request.");
					},
				]);
				await harness.session.prompt("State your current tool availability.");
				expect(harness.getPendingResponseCount()).toBe(0);
			}
		} finally {
			await harness.cleanup();
		}
	});

	it("removes subscription images during a full-capability foreign routed turn and restores the root surface", async () => {
		const harness = await createHarness({
			fauxProvider: { provider: "openai-codex", api: "faux-images-route" },
			initialActiveToolNames: ["read", "image_generate"],
			settings: { modelCapability: { mode: "full" } },
		});
		const root = harness.getModel();
		const foreign = { ...root, provider: "image-route-other", id: "foreign" };
		harness.authStorage.setRuntimeApiKey(foreign.provider, "faux-key");
		harness.session.modelRegistry.registerProvider(foreign.provider, {
			api: foreign.api,
			baseUrl: foreign.baseUrl,
			apiKey: "faux-key",
			models: [foreign],
		});
		harness.settingsManager.setModelRouterSettings({
			enabled: true,
			cheapModel: `${foreign.provider}/${foreign.id}`,
			expensiveModel: `${root.provider}/${root.id}`,
		});
		try {
			expect(harness.session.getActiveToolNames()).toContain("image_generate");
			harness.setResponses([
				(context, _options, _state, selected) => {
					expect(selected.provider).toBe(foreign.provider);
					expect(context.tools?.map((tool) => tool.name)).not.toContain("image_generate");
					expect(context.tools?.map((tool) => tool.name)).toContain("read");
					return fauxAssistantMessage("Read-only explanation.");
				},
			]);
			await harness.session.prompt("Explain this concept without making any changes.");
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(harness.session.model?.provider).toBe(root.provider);
			expect(harness.session.getActiveToolNames()).toContain("image_generate");
		} finally {
			await harness.cleanup();
		}
	});

	it("never registers or advertises image generation in a native worker even when explicitly requested", async () => {
		vi.stubEnv("PI_SESSION_ROLE", "worker");
		const harness = await createHarness({
			fauxProvider: { provider: "openai-codex", api: "faux-images-worker" },
			initialActiveToolNames: ["read", "image_generate"],
			allowedToolNames: ["read", "image_generate"],
			settings: { modelCapability: { mode: "full" } },
		});
		try {
			expect(harness.session.getToolDefinition("image_generate")).toBeUndefined();
			harness.session.setActiveToolsByName(["read", "image_generate"]);
			expect(harness.session.getActiveToolNames()).not.toContain("image_generate");
			expect(harness.session.getActiveToolNames()).toContain("read");
		} finally {
			await harness.cleanup();
		}
	});
});
