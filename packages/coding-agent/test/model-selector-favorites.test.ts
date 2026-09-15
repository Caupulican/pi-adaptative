import type { Model } from "@caupulican/pi-ai";
import {
	getAmbiguousWidthMode,
	setAmbiguousWidthMode,
	setKeybindings,
	type TUI,
	visibleWidth,
} from "@caupulican/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { DynamicBorder } from "../src/modes/interactive/components/dynamic-border.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function model(id: string, provider = "fixture"): Model<"openai-responses"> {
	return {
		id,
		provider,
		name: id,
		api: "openai-responses",
		baseUrl: "http://localhost.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

async function selectorFor(models: Model<"openai-responses">[], settings = SettingsManager.inMemory(), query?: string) {
	const ready = Promise.withResolvers<void>();
	const onSelect = vi.fn();
	const registry = {
		refresh: () => {},
		getError: () => undefined,
		getAvailable: () => models,
		find: (provider: string, id: string) => models.find((item) => item.provider === provider && item.id === id),
	} satisfies Pick<ModelRegistry, "refresh" | "getError" | "getAvailable" | "find">;
	const tui = { requestRender: () => ready.resolve() } satisfies Pick<TUI, "requestRender">;
	const selector = new ModelSelectorComponent(
		tui as TUI,
		undefined,
		settings,
		registry as ModelRegistry,
		[],
		onSelect,
		() => {},
		query,
	);
	await ready.promise;
	return { selector, settings, onSelect };
}

function rows(selector: ModelSelectorComponent): string[] {
	return selector
		.render(100)
		.map(stripAnsi)
		.filter((line) => line.includes("[fixture"));
}

const originalWidthMode = getAmbiguousWidthMode();
beforeEach(() => {
	initTheme();
	setKeybindings(new KeybindingsManager());
	setAmbiguousWidthMode(false);
});
afterEach(() => {
	setAmbiguousWidthMode(originalWidthMode);
	setKeybindings(new KeybindingsManager());
});

describe("model selector favorites", () => {
	it.each([false, true])("fits shared borders to exact column widths in wide mode %s", (wide) => {
		setAmbiguousWidthMode(wide);
		const border = new DynamicBorder((text) => text);
		for (const width of [0, 1, 23, 24]) expect(visibleWidth(border.render(width)[0])).toBe(width);
	});
	it("shows tabs without a scoped list and pins provider/model pairs above nonfavorites", async () => {
		const first = model("same", "fixture-a");
		const second = model("same", "fixture-z");
		const { selector, settings } = await selectorFor([first, second]);
		expect(stripAnsi(selector.render(100).join("\n"))).toContain("Models: all | favorites");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x06");
		expect(settings.getModelFavorites()).toEqual([{ provider: second.provider, modelId: second.id }]);
		expect(rows(selector)[0]).toContain("[fixture-z]");
		selector.handleInput("\t");
		expect(rows(selector)).toHaveLength(1);
		expect(rows(selector)[0]).not.toContain("[fixture-a]");
		selector.handleInput("\x06");
		expect(settings.getModelFavorites()).toEqual([]);
		expect(rows(selector)).toEqual([]);
		expect(stripAnsi(selector.render(100).join("\n"))).toContain("No pinned models");
	});

	it("keeps favorites first even when a nonfavorite has a better fuzzy match", async () => {
		const settings = SettingsManager.inMemory({
			modelFavorites: [{ provider: "fixture", modelId: "long-target-version" }],
		});
		const { selector } = await selectorFor([model("target"), model("long-target-version")], settings, "target");
		expect(rows(selector)[0]).toContain("long-target-version");
		expect(rows(selector)[1]).toContain("target");
	});

	it("keeps the rendered selection and Enter on the same model after a filtered tab switch", async () => {
		const models = [model("alpha"), model("target-one"), model("target-two")];
		const settings = SettingsManager.inMemory({
			modelFavorites: models.map((item) => ({ provider: item.provider, modelId: item.id })),
		});
		const { selector, onSelect } = await selectorFor(models, settings, "target");
		expect(rows(selector).find((line) => line.includes("→"))).toContain("target-one");
		selector.handleInput("\t");
		expect(selector.getSearchInput().getValue()).toBe("target");
		expect(rows(selector).find((line) => line.includes("→"))).toContain("target-one");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(models[1]);
	});

	it("honors remapped actions without retaining default keys", async () => {
		setKeybindings(
			new KeybindingsManager({ "app.models.toggleFavorite": "ctrl+g", "app.models.toggleFavoritesTab": "ctrl+q" }),
		);
		const { selector, settings } = await selectorFor([model("one"), model("two")]);
		selector.handleInput("\x06");
		expect(settings.getModelFavorites()).toEqual([]);
		selector.handleInput("\t");
		expect(rows(selector)).toHaveLength(2);
		selector.handleInput("\x07");
		selector.handleInput("\x11");
		expect(rows(selector)).toHaveLength(1);
		expect(rows(selector)[0]).toContain("one");
	});

	it("does not restore unavailable models from saved favorites", async () => {
		const settings = SettingsManager.inMemory({ modelFavorites: [{ provider: "fixture", modelId: "unavailable" }] });
		const { selector } = await selectorFor([model("available")], settings);
		selector.handleInput("\t");
		expect(rows(selector)).toEqual([]);
		expect(settings.isModelFavorite("fixture", "unavailable")).toBe(true);
	});

	it("distinguishes a search miss from an empty favorites list", async () => {
		const settings = SettingsManager.inMemory({ modelFavorites: [{ provider: "fixture", modelId: "one" }] });
		const { selector } = await selectorFor([model("one")], settings, "zzzz");
		selector.handleInput("\t");
		const rendered = stripAnsi(selector.render(100).join("\n"));
		expect(rendered).toContain("No matching models");
		expect(rendered).not.toContain("No pinned models");
	});

	it.each([false, true])("aligns marker columns in wide-character mode %s and fits narrow terminals", async (wide) => {
		setAmbiguousWidthMode(wide);
		const settings = SettingsManager.inMemory({ modelFavorites: [{ provider: "fixture", modelId: "first" }] });
		const { selector } = await selectorFor([model("first"), model("second")], settings);
		const first = rows(selector).find((line) => line.includes("first"))!;
		const second = rows(selector).find((line) => line.includes("second"))!;
		expect(visibleWidth(first.slice(0, first.indexOf("first")))).toBe(
			visibleWidth(second.slice(0, second.indexOf("second"))),
		);
		for (const line of selector.render(24)) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
	});
});
