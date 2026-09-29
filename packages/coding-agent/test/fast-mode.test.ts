import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import { getModel, type ModelServiceTier } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { getFastModeStatus, resolveFastModeServiceTier, setFastMode, toggleFastMode } from "../src/core/fast-mode.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { handleFastModeCommand } from "../src/modes/interactive/fast-mode-command.ts";

function createFastModeHarness(provider: "openai-codex" | "xai" | "anthropic") {
	const model =
		provider === "openai-codex"
			? getModel("openai-codex", "gpt-5.6-sol")
			: provider === "xai"
				? getModel("xai", "grok-4.6")
				: getModel("anthropic", "claude-sonnet-4-5");
	let thinkingLevel: ThinkingLevel = "high";
	const preferences = new Map<string, boolean | "ultrafast">();
	const settingsManager = {
		getFastModeEnabled: (providerId: string) => preferences.get(providerId),
		getFastModePreference: (providerId: string) => preferences.get(providerId),
		setFastModePreference: vi.fn((providerId: string, preference: boolean | "ultrafast") => {
			preferences.set(providerId, preference);
		}),
		setFastModeEnabled: vi.fn((providerId: string, enabled: boolean) => {
			preferences.set(providerId, enabled);
		}),
	};
	const session = {
		model,
		get thinkingLevel(): ThinkingLevel {
			return thinkingLevel;
		},
		setThinkingLevel: vi.fn((level: ThinkingLevel) => {
			thinkingLevel = level;
		}),
		settingsManager,
	};
	return { model, preferences, session, settingsManager };
}

describe("provider-owned fast mode", () => {
	it("stores independent provider preferences", () => {
		const settings = SettingsManager.inMemory({ fastMode: { "openai-codex": true } });

		expect(settings.getFastModeEnabled("openai-codex")).toBe(true);
		expect(settings.getFastModeEnabled("xai")).toBeUndefined();
		settings.setFastModeEnabled("xai", false);
		expect(settings.getGlobalSettings().fastMode).toEqual({ "openai-codex": true, xai: false });
	});

	it("uses Codex priority/default service tiers without changing reasoning effort", () => {
		const harness = createFastModeHarness("openai-codex");

		expect(getFastModeStatus(harness.session)).toMatchObject({
			available: true,
			enabled: false,
			kind: "service-tier",
		});
		expect(setFastMode(harness.session, true)).toMatchObject({ changed: true, enabled: true });
		expect(resolveFastModeServiceTier(harness.model, harness.preferences.get("openai-codex"))).toBe("priority");
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.session.setThinkingLevel).not.toHaveBeenCalled();

		expect(toggleFastMode(harness.session)).toMatchObject({ changed: true, enabled: false });
		expect(resolveFastModeServiceTier(harness.model, harness.preferences.get("openai-codex"))).toBe("default");
	});

	it("uses Grok priority/default service tiers without changing reasoning effort", () => {
		const harness = createFastModeHarness("xai");

		expect(setFastMode(harness.session, true)).toMatchObject({ changed: true, enabled: true });
		expect(resolveFastModeServiceTier(harness.model, harness.preferences.get("xai"))).toBe("priority");
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.session.setThinkingLevel).not.toHaveBeenCalled();

		expect(toggleFastMode(harness.session)).toMatchObject({ changed: true, enabled: false });
		expect(harness.session.thinkingLevel).toBe("high");
		expect(resolveFastModeServiceTier(harness.model, harness.preferences.get("xai"))).toBe("default");
	});

	it("rejects unsupported providers without mutating preferences or thinking", () => {
		const harness = createFastModeHarness("anthropic");

		expect(toggleFastMode(harness.session)).toMatchObject({ available: false, changed: false });
		expect(harness.settingsManager.setFastModeEnabled).not.toHaveBeenCalled();
		expect(harness.session.setThinkingLevel).not.toHaveBeenCalled();
	});
});

describe("interactive /fast command", () => {
	it("is discoverable and reports the provider-specific behavior", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "fast")).toBe(true);
		const harness = createFastModeHarness("xai");
		const showStatus = vi.fn();

		handleFastModeCommand({ session: harness.session, showStatus }, "/fast on");
		expect(showStatus).toHaveBeenLastCalledWith("Fast mode on: Grok requests priority processing.");
		handleFastModeCommand({ session: harness.session, showStatus }, "/fast status");
		expect(showStatus).toHaveBeenLastCalledWith("Fast mode is on: Grok requests priority processing.");
	});

	it("reports Grok default processing while fast mode is off", () => {
		const harness = createFastModeHarness("xai");
		const showStatus = vi.fn();
		harness.session.setThinkingLevel("xhigh");

		handleFastModeCommand({ session: harness.session, showStatus }, "/fast status");

		expect(showStatus).toHaveBeenCalledWith("Fast mode is off: Grok requests default processing.");
	});

	it("reports the supported fast-mode command arguments", () => {
		const harness = createFastModeHarness("openai-codex");
		const showStatus = vi.fn();

		handleFastModeCommand({ session: harness.session, showStatus }, "/fast maybe");
		expect(showStatus).toHaveBeenCalledWith("Usage: /fast [on|off|priority|ultrafast|status]");
		expect(harness.settingsManager.setFastModeEnabled).not.toHaveBeenCalled();
	});

	it("selects advertised Ultrafast without changing model or reasoning", () => {
		const harness = createFastModeHarness("openai-codex");
		const tiers: ModelServiceTier[] = [
			{ id: "priority", name: "Fast", description: "Priority processing" },
			{ id: "ultrafast", name: "Ultrafast", description: "Lower latency" },
		];
		const session = { ...harness.session, getFastModeServiceTiers: () => tiers };
		const showStatus = vi.fn();
		handleFastModeCommand({ session, showStatus }, "/fast ultrafast");
		expect(harness.preferences.get("openai-codex")).toBe("ultrafast");
		expect(resolveFastModeServiceTier(harness.model, "ultrafast", tiers)).toBe("ultrafast");
		expect(showStatus).toHaveBeenLastCalledWith(
			"Fast mode on: Codex requests ultrafast processing. Cost uses base rates; Ultrafast pricing is unavailable.",
		);
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.session.setThinkingLevel).not.toHaveBeenCalled();
		handleFastModeCommand({ session, showStatus }, "/fast off");
		expect(harness.preferences.get("openai-codex")).toBe(false);
		handleFastModeCommand({ session, showStatus }, "/fast priority");
		expect(harness.preferences.get("openai-codex")).toBe(true);
	});

	it.each(["openai-codex", "xai", "anthropic"] as const)("refuses unadvertised Ultrafast on %s", (provider) => {
		const harness = createFastModeHarness(provider);
		const showStatus = vi.fn();
		handleFastModeCommand({ session: harness.session, showStatus }, "/fast ultrafast");
		expect(harness.preferences.size).toBe(0);
		expect(showStatus.mock.lastCall?.[0]).toContain("unavailable");
		expect(harness.session.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("does not carry an Ultrafast selection onto a model whose catalog omits it", () => {
		const harness = createFastModeHarness("openai-codex");
		harness.preferences.set("openai-codex", "ultrafast");
		const session = { ...harness.session, getFastModeServiceTiers: () => [] };
		expect(getFastModeStatus(session)).toMatchObject({
			enabled: false,
			reason: expect.stringContaining("ultrafast"),
		});
		expect(resolveFastModeServiceTier(harness.model, "ultrafast", [])).toBeUndefined();
		expect(resolveFastModeServiceTier(harness.model, true, [])).toBeUndefined();
		expect(resolveFastModeServiceTier(harness.model, false, [])).toBe("default");
	});
});
