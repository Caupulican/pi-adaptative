import { beforeAll, describe, expect, it } from "vitest";
import type { ResourceProfileSettings } from "../src/core/settings-manager.ts";
import { ProfileResourceEditorComponent } from "../src/modes/interactive/components/profile-resource-editor.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const alphaPath = "/home/test/.pi/agent/extensions/alpha/index.ts";
const betaPath = "/home/test/.pi/agent/extensions/beta/index.ts";

describe("profile resource editor extension identity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders folder labels while retaining collision-safe selection ids", () => {
		const editor = new ProfileResourceEditorComponent({
			profileName: "test",
			profileScope: "global",
			initialResources: { extensions: { allow: ["index.ts"] } },
			kinds: [
				{
					kind: "extensions",
					label: "Extensions",
					items: [
						{ id: alphaPath, label: "alpha", path: alphaPath },
						{ id: betaPath, label: "beta", path: betaPath },
					],
				},
			],
			onSave: () => {},
			onCancel: () => {},
			cwd: "/workspace/project",
		});

		const output = editor.render(120).join("\n");
		expect(output).toContain("alpha");
		expect(output).toContain("beta");
	});

	it("migrates a shared index.ts pattern and toggles only the selected extension", () => {
		let saved: ResourceProfileSettings | undefined;
		const editor = new ProfileResourceEditorComponent({
			profileName: "test",
			profileScope: "global",
			initialResources: { extensions: { allow: ["index.ts"] } },
			kinds: [
				{
					kind: "extensions",
					label: "Extensions",
					items: [
						{ id: alphaPath, label: "alpha", path: alphaPath },
						{ id: betaPath, label: "beta", path: betaPath },
					],
				},
			],
			onSave: (resources) => {
				saved = resources;
			},
			onCancel: () => {},
			cwd: "/workspace/project",
		});

		// Both concrete entries inherit the legacy basename grant. Toggle only alpha off.
		editor.handleInput("\n");
		(editor as unknown as { persistChanges(): void }).persistChanges();

		expect(saved).toEqual({ extensions: { allow: [betaPath] } });
	});
});
