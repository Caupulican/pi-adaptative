import { setKeybindings } from "@caupulican/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ResourceProfileSettings } from "../src/core/settings-manager.ts";
import { ProfileResourceEditorComponent } from "../src/modes/interactive/components/profile-resource-editor.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	// Ensure test isolation: keybindings are a global singleton.
	setKeybindings(new KeybindingsManager());
});

const enabledOf = (editor: ProfileResourceEditorComponent, kind: string) =>
	(editor as unknown as { enabledByKind: Map<string, Set<string>> }).enabledByKind.get(kind)!;
const isDirtyOf = (editor: ProfileResourceEditorComponent) => (editor as unknown as { isDirty: boolean }).isDirty;

describe("profile resource editor bulk toggle (enable all / clear all)", () => {
	it("app.profiles.enableAll (ctrl+t) enables every item of the current kind and marks dirty", () => {
		const editor = new ProfileResourceEditorComponent({
			profileName: "p",
			profileScope: "session",
			initialResources: {}, // kind never mentioned -> strict UAC: starts fully denied
			kinds: [
				{
					kind: "skills",
					label: "Skills",
					items: [
						{ id: "skill-a", path: "/catalog/skill-a" },
						{ id: "skill-b", path: "/catalog/skill-b" },
						{ id: "skill-c", path: "/catalog/skill-c" },
					],
				},
			],
			onSave: () => {},
			onCancel: () => {},
		});

		expect(enabledOf(editor, "skills").size).toBe(0);
		expect(isDirtyOf(editor)).toBe(false);

		editor.handleInput("\x14"); // ctrl+t

		expect([...enabledOf(editor, "skills")].sort()).toEqual(["skill-a", "skill-b", "skill-c"]);
		expect(isDirtyOf(editor)).toBe(true);
	});

	it("app.profiles.clearAll (ctrl+d) empties the current kind's enabled set and marks dirty", () => {
		const editor = new ProfileResourceEditorComponent({
			profileName: "p",
			profileScope: "session",
			initialResources: { skills: { allow: ["*"] } }, // starts fully enabled
			kinds: [
				{
					kind: "skills",
					label: "Skills",
					items: [
						{ id: "skill-a", path: "/catalog/skill-a" },
						{ id: "skill-b", path: "/catalog/skill-b" },
						{ id: "skill-c", path: "/catalog/skill-c" },
					],
				},
			],
			onSave: () => {},
			onCancel: () => {},
		});

		expect(enabledOf(editor, "skills").size).toBe(3);

		editor.handleInput("\x04"); // ctrl+d

		expect(enabledOf(editor, "skills").size).toBe(0);
		expect(isDirtyOf(editor)).toBe(true);
	});

	it("with an active search query, enableAll only enables the filtered subset", () => {
		const editor = new ProfileResourceEditorComponent({
			profileName: "p",
			profileScope: "session",
			initialResources: {},
			kinds: [
				{
					kind: "skills",
					label: "Skills",
					items: [
						{ id: "alpha-one", path: "/catalog/alpha-one" },
						{ id: "alpha-two", path: "/catalog/alpha-two" },
						{ id: "beta", path: "/catalog/beta" },
					],
				},
			],
			onSave: () => {},
			onCancel: () => {},
		});

		// Narrow the visible list to the alpha-* items only.
		editor.handleInput("alpha");
		expect(editor.getSearchInput().getValue()).toBe("alpha");

		editor.handleInput("\x14"); // ctrl+t: enableAll, filtered subset only

		const enabledSet = enabledOf(editor, "skills");
		expect([...enabledSet].sort()).toEqual(["alpha-one", "alpha-two"]);
		expect(enabledSet.has("beta")).toBe(false);
	});

	it("after enableAll + save (ctrl+s), onSave receives resources equivalent to all-enabled for that kind", () => {
		let saved: ResourceProfileSettings | undefined;
		const editor = new ProfileResourceEditorComponent({
			profileName: "p",
			profileScope: "session",
			initialResources: {},
			kinds: [
				{
					kind: "skills",
					label: "Skills",
					items: [
						{ id: "skill-a", path: "/catalog/skill-a" },
						{ id: "skill-b", path: "/catalog/skill-b" },
						{ id: "skill-c", path: "/catalog/skill-c" },
					],
				},
			],
			onSave: (resources) => {
				saved = resources;
			},
			onCancel: () => {},
		});

		editor.handleInput("\x14"); // ctrl+t: enableAll
		editor.handleInput("\x13"); // ctrl+s: app.models.save -> persistChanges

		expect(saved?.skills).toEqual({ allow: ["skill-a", "skill-b", "skill-c"] });
		expect(isDirtyOf(editor)).toBe(false);
	});
});
