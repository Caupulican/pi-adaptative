import type { Component } from "@caupulican/pi-tui";
import { setKeybindings } from "@caupulican/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ScopedModelsSelectorComponent } from "../../../src/modes/interactive/components/scoped-models-selector.ts";
import { type SessionFlowHost, showModelsSelector } from "../../../src/modes/interactive/session-flow-commands.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #6949 unavailable scoped models", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("shows and removes an enabled model without a catalog entry", async () => {
		const harness = await createHarness({ models: [{ id: "available", name: "Available" }] });
		harnesses.push(harness);
		const availableId = `${harness.models[0].provider}/${harness.models[0].id}`;
		const unavailableId = `${harness.models[0].provider}/unavailable`;
		const changes: Array<string[] | null> = [];
		const selector = new ScopedModelsSelectorComponent(
			{ allModels: [...harness.models], enabledModelIds: [unavailableId, availableId] },
			{
				onChange: (enabledIds) => {
					changes.push(enabledIds);
				},
				onPersist: () => undefined,
				onCancel: () => undefined,
			},
		);

		expect(stripAnsi(selector.render(100).join("\n"))).toContain(`${unavailableId} [unavailable] ✗`);
		selector.handleInput("\r");
		expect(changes).toEqual([[availableId]]);
	});

	it("passes unmatched settings entries into the selector", async () => {
		const harness = await createHarness({ models: [{ id: "available", name: "Available" }] });
		harnesses.push(harness);
		const unavailableId = `${harness.models[0].provider}/unavailable`;
		harness.settingsManager.setEnabledModels([unavailableId]);
		let component: Component | undefined;
		const host = {
			session: harness.session,
			settingsManager: harness.settingsManager,
			showStatus: vi.fn(),
			updateAvailableProviderCount: vi.fn(async () => undefined),
			ui: { requestRender: vi.fn() },
			showSelector: (factory: (done: () => void) => { component: Component }) => {
				component = factory(() => undefined).component;
			},
		} as unknown as SessionFlowHost;

		await showModelsSelector(host);

		expect(component).toBeInstanceOf(ScopedModelsSelectorComponent);
		expect(stripAnsi(component!.render(100).join("\n"))).toContain(`${unavailableId} [unavailable] ✗`);
	});
});
