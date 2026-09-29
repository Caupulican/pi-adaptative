import { describe, expect, it, vi } from "vitest";
import type { FastModePreference } from "../src/core/fast-mode.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

describe("fast-mode preference persistence", () => {
	it("persists Ultrafast and boolean transitions without losing provider identity", async () => {
		const storage = new InMemorySettingsStorage();
		const manager = SettingsManager.fromStorage(storage);
		manager.setFastModePreference("openai-codex", "ultrafast");
		manager.setFastModePreference("xai", false);
		expect(manager.getFastModePreference("openai-codex")).toBe("ultrafast");
		expect(manager.getFastModeEnabled("openai-codex")).toBe(true);
		expect(manager.getFastModeEnabled("xai")).toBe(false);
		await manager.flush();
		const reopened = SettingsManager.fromStorage(storage);
		expect(reopened.getFastModePreference("openai-codex")).toBe("ultrafast");
		expect(reopened.getFastModePreference("xai")).toBe(false);
		expect(reopened.getFastModePreference("missing")).toBeUndefined();
		reopened.setFastModeEnabled("openai-codex", false);
		await reopened.flush();
		expect(SettingsManager.fromStorage(storage).getFastModePreference("openai-codex")).toBe(false);
	});

	it("merges independently modified provider preferences across concurrent managers", async () => {
		const storage = new InMemorySettingsStorage();
		const first = SettingsManager.fromStorage(storage);
		const second = SettingsManager.fromStorage(storage);
		first.setFastModePreference("openai-codex", "ultrafast");
		second.setFastModePreference("xai", true);
		await Promise.all([first.flush(), second.flush()]);
		const reopened = SettingsManager.fromStorage(storage);
		expect(reopened.getFastModePreference("openai-codex")).toBe("ultrafast");
		expect(reopened.getFastModePreference("xai")).toBe(true);
	});

	it("keeps scoped preference precedence and ignores malformed stored modes", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ fastMode: { codex: "ultrafast", xai: true, invalid: "fast", number: 1, object: {} } }),
		);
		storage.withLock("project", () => JSON.stringify({ fastMode: { codex: false } }));
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getFastModePreference("codex")).toBe(false);
		expect(manager.getFastModePreference("xai")).toBe(true);
		for (const provider of ["invalid", "number", "object", "missing"]) {
			expect(manager.getFastModePreference(provider)).toBeUndefined();
			expect(manager.getFastModeEnabled(provider)).toBeUndefined();
		}
	});

	it("rejects malformed runtime preferences without replacing a valid value", async () => {
		const manager = SettingsManager.inMemory();
		manager.setFastModePreference("codex", "ultrafast");
		for (const invalid of [undefined, null, 0, 1, "fast", "ULTRAFAST", {}, []]) {
			expect(() => manager.setFastModePreference("codex", invalid as FastModePreference)).toThrow(
				"Invalid fast-mode preference",
			);
			expect(manager.getFastModePreference("codex")).toBe("ultrafast");
		}
		await manager.flush();
	});

	it("rejects reserved provider keys for both preference entry points", () => {
		const manager = SettingsManager.inMemory();
		for (const provider of ["", "__proto__", "constructor", "prototype"]) {
			expect(() => manager.setFastModePreference(provider, "ultrafast")).toThrow("Invalid fast-mode provider");
			expect(() => manager.setFastModeEnabled(provider, true)).toThrow("Invalid fast-mode provider");
		}
		expect(manager.settings.fastMode).toBeUndefined();
	});

	it("routes boolean writes through the canonical preference setter", async () => {
		const manager = SettingsManager.inMemory();
		const canonical = vi.spyOn(manager, "setFastModePreference");
		manager.setFastModeEnabled("codex", true);
		expect(canonical).toHaveBeenCalledExactlyOnceWith("codex", true);
		expect(manager.getFastModePreference("codex")).toBe(true);
		await manager.flush();
	});
});
