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

function agyVariant(family: string, level: "low" | "medium" | "high") {
	const id = `${family}-${level}`;
	return {
		...model(id, "google-antigravity"),
		name: `${family.replace("gemini-", "Gemini ").replace("-flash", " Flash")} (${level[0]!.toUpperCase()}${level.slice(1)})`,
		reasoning: true,
		defaultThinkingLevel: level,
		thinkingBudgets: { [level]: level === "high" ? 8192 : level === "medium" ? 2048 : 1024 },
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
	it("groups advertised Gemini efforts and selects the exact variant", async () => {
		const low = agyVariant("gemini-3.8-flash", "low");
		const medium = agyVariant("gemini-3.8-flash", "medium");
		const high = agyVariant("gemini-3.8-flash", "high");
		const { selector, onSelect } = await selectorFor(
			[high, low, medium],
			SettingsManager.inMemory(),
			"Gemini 3.8 Flash",
		);
		const text = stripAnsi(selector.render(100).join("\n"));
		expect(text.match(/\[google-antigravity\]/g)).toHaveLength(1);
		expect(text).toContain("Gemini 3.8 Flash");
		expect(text).toContain("medium");
		selector.handleInput("\x1b[D");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(low);
	});
	it("groups a Gemini effort whose catalog ID differs from the displayed family", async () => {
		const low = { ...agyVariant("gemini-3.1-pro", "low"), name: "Gemini 3.1 Pro (Low)" };
		const high = { ...agyVariant("gemini-3.1-pro", "high"), id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" };
		const { selector, onSelect } = await selectorFor([high, low], SettingsManager.inMemory(), "Gemini 3.1 Pro");
		const text = stripAnsi(selector.render(100).join("\n"));
		expect(text.match(/\[google-antigravity\]/g)).toHaveLength(1);
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(high);
	});
	it("shows catalog names for individual Antigravity models", async () => {
		const claude = { ...model("claude-sonnet-4-6", "google-antigravity"), name: "Claude Sonnet 4.6" };
		const flash = agyVariant("gemini-3.8-flash", "low");
		const { selector, onSelect } = await selectorFor([claude, flash]);
		const rendered = stripAnsi(selector.render(100).join("\n"));
		expect(rendered).toContain("Claude Sonnet 4.6 [google-antigravity]");
		expect(rendered).toContain("Gemini 3.8 Flash (Low) [google-antigravity]");
		expect(rendered).not.toContain("claude-sonnet-4-6 [google-antigravity]");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(claude);
	});
	it("keeps the favorites tab limited to pinned Gemini efforts", async () => {
		const low = agyVariant("gemini-3.8-flash", "low");
		const high = agyVariant("gemini-3.8-flash", "high");
		const settings = SettingsManager.inMemory({
			modelFavorites: [{ provider: "google-antigravity", modelId: low.id }],
		});
		const { selector, onSelect } = await selectorFor([low, high], settings);
		selector.handleInput("\t");
		selector.handleInput("\x1b[C");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(low);
	});
	it("uses the remapped effort key instead of the default arrow", async () => {
		setKeybindings(new KeybindingsManager({ "app.models.effortHigher": "ctrl+g" }));
		const medium = agyVariant("gemini-3.8-flash", "medium");
		const high = agyVariant("gemini-3.8-flash", "high");
		const { selector, onSelect } = await selectorFor([medium, high]);
		selector.handleInput("\x1b[C");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenLastCalledWith(medium);
		selector.handleInput("\x07");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenLastCalledWith(high);
	});
	it("retains a chosen effort when switching between favorites and all models", async () => {
		const low = agyVariant("gemini-3.8-flash", "low");
		const high = agyVariant("gemini-3.8-flash", "high");
		const settings = SettingsManager.inMemory({
			modelFavorites: [
				{ provider: "google-antigravity", modelId: low.id },
				{ provider: "google-antigravity", modelId: high.id },
			],
		});
		const { selector, onSelect } = await selectorFor([low, high], settings);
		selector.handleInput("\t");
		selector.handleInput("\x1b[D");
		selector.handleInput("\t");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(low);
	});
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
