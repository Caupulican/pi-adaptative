import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { collectSettingsDiagnostics } from "../src/main.ts";

/**
 * Startup and runtime creation each build a SettingsManager over the same files; both record the
 * same diagnostics. The operator reads each one once, under the first context that produced it.
 */
describe("settings diagnostics across the startup and runtime managers", () => {
	it("reports a diagnostic once even when a second manager records it again", () => {
		const legacy = { retry: { stall: { connectMs: 300_000, activeIdleMs: 300_000, quietIdleMs: 900_000 } } };
		const startup = SettingsManager.inMemory(legacy);
		const runtime = SettingsManager.inMemory(legacy);

		const first = collectSettingsDiagnostics(startup, "startup session lookup");
		const second = collectSettingsDiagnostics(runtime, "runtime creation");

		expect(first.filter((d) => d.message.includes("retry.stall"))).toHaveLength(1);
		expect(first[0]?.message).toMatch(/^\(startup session lookup, global settings\)/);
		expect(second.filter((d) => d.message.includes("retry.stall"))).toEqual([]);
	});
});
