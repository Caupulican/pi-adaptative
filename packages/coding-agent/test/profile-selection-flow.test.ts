import { describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProfileMenuController } from "../src/modes/interactive/profile-menu-controller.ts";
import { createTestResourceLoader } from "./utilities.ts";

const prototype = ProfileMenuController.prototype as unknown as {
	getProfileResourceKinds(this: unknown): Promise<Array<{ kind: string; items: unknown[] }>>;
	applyProfile(this: unknown, profileName: string): Promise<void>;
};

describe("getProfileResourceKinds", () => {
	it("builds the editor universe without crashing (regression: TDZ ReferenceError killed pi)", async () => {
		const context = {
			session: {
				resourceLoader: createTestResourceLoader(),
				getAllTools: () => [{ name: "ext_tool" }],
			},
		};
		const kinds = await prototype.getProfileResourceKinds.call(context);
		const byKind = new Map(kinds.map((kind) => [kind.kind, kind]));
		expect(byKind.has("tools")).toBe(true);
		expect(byKind.has("skills")).toBe(true);
		expect(byKind.has("prompts")).toBe(true);
		expect(byKind.has("agents")).toBe(true);
		// registered (extension) tools are part of the grantable universe
		expect((byKind.get("tools")!.items as Array<{ id: string }>).some((item) => item.id === "ext_tool")).toBe(true);
	});
});

describe("profile selection persistence", () => {
	function context(settingsManager: SettingsManager) {
		return {
			settingsManager,
			session: {
				sessionManager: { appendCustomEntry: vi.fn() },
				setModel: vi.fn(async () => {}),
				setThinkingLevel: vi.fn(),
			},
			ui: {
				handleReloadCommand: vi.fn(async () => {}),
				footerDataProvider: { setExtensionStatus: vi.fn() },
				invalidateFooter: vi.fn(),
				updateEditorBorderColor: vi.fn(),
				showStatus: vi.fn(),
				showError: vi.fn(),
				showWarning: vi.fn(),
			},
		};
	}

	it("a selected profile survives a fresh session (persisted to global settings)", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: { scout: { tools: { allow: ["read"] } } },
		});
		await prototype.applyProfile.call(context(settingsManager), "scout");
		// Regression: selection was runtime-only, so every new pi session started profileless.
		expect(settingsManager.getGlobalSettings().activeResourceProfiles).toEqual(["scout"]);
		expect(settingsManager.getActiveResourceProfileNames()).toEqual(["scout"]);
	});

	it("clearing the profile also persists (the old selection must not resurrect on restart)", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: { scout: { tools: { allow: ["read"] } } },
			activeResourceProfiles: ["scout"],
		});
		await prototype.applyProfile.call(context(settingsManager), "none");
		expect(settingsManager.getGlobalSettings().activeResourceProfiles).toBeUndefined();
	});
});
