import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

it("disposes an unpublished reload candidate while the last good extension remains live", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-reload-generation-"));
	const eventBus = createEventBus();
	const events: number[] = [];
	const disposals: number[] = [];
	let generation = 0;
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		eventBus,
		settingsManager: SettingsManager.inMemory({}),
		noExtensions: true,
		noContextFiles: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		installMissingPackages: false,
		extensionFactories: [
			(pi) => {
				const current = ++generation;
				pi.events.on("fixture:reload", () => {
					events.push(current);
				});
				pi.onDispose(() => {
					disposals.push(current);
				});
			},
			() => {
				if (generation === 2) throw new Error("candidate failed");
			},
		],
	});
	try {
		await loader.reload({ failOnExtensionErrors: true });
		const accepted = loader.getExtensions();
		await expect(loader.reload({ failOnExtensionErrors: true })).rejects.toThrow("candidate failed");
		expect(loader.getExtensions()).toBe(accepted);
		eventBus.emit("fixture:reload", null);
		expect(events).toEqual([1]);
		expect(disposals).toEqual([2]);
	} finally {
		await loader.dispose();
		rmSync(root, { force: true, recursive: true });
	}
});
