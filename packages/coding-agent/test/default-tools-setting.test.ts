import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("defaultTools setting (P1d)", () => {
	it("defaults to undefined", () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getDefaultTools()).toBeUndefined();
	});

	it("gets and sets global defaultTools", () => {
		const settings = SettingsManager.inMemory();
		settings.setDefaultTools(["read", "bash"]);
		expect(settings.getDefaultTools()).toEqual(["read", "bash"]);

		settings.setDefaultTools(undefined);
		expect(settings.getDefaultTools()).toBeUndefined();
	});

	it("is global-only and returns global defaultTools", () => {
		const settings = SettingsManager.inMemory({
			defaultTools: ["read", "edit"],
		});
		expect(settings.getDefaultTools()).toEqual(["read", "edit"]);
	});
});
