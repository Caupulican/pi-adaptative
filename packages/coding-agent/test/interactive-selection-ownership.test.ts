import type { Component } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { isProcessAlive } from "../src/core/process-liveness.ts";
import { ExtensionInputComponent } from "../src/modes/interactive/components/extension-input.ts";
import { SelectSubmenu } from "../src/modes/interactive/components/settings-selector.ts";
import {
	confirmExternalResourceTrust,
	promptForTextInput,
} from "../src/modes/interactive/interactive-selection-prompts.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

interface SelectorMount {
	component: Component;
	focus: Component;
	onSuperseded?: () => void;
}

function captureSelectionHost() {
	let mounted: SelectorMount | undefined;
	const done = vi.fn();
	return {
		host: {
			tui: {} as never,
			showSelector: (create: (done: () => void) => SelectorMount) => {
				mounted = create(done);
			},
		},
		done,
		getMounted: () => {
			if (!mounted) throw new Error("selector was not mounted");
			return mounted;
		},
	};
}

function getExtensionInput(component: Component): ExtensionInputComponent {
	expect(component).toBeInstanceOf(ExtensionInputComponent);
	if (!(component instanceof ExtensionInputComponent)) throw new Error("expected an ExtensionInputComponent");
	return component;
}

function getSelectSubmenu(component: Component): SelectSubmenu {
	expect(component).toBeInstanceOf(SelectSubmenu);
	if (!(component instanceof SelectSubmenu)) throw new Error("expected a SelectSubmenu");
	return component;
}

describe("interactive selection ownership", () => {
	beforeAll(() => initTheme("dark"));

	it("returns trust only after an explicit affirmative selection", async () => {
		const harness = captureSelectionHost();
		const result = confirmExternalResourceTrust(harness.host, {
			title: "Trust source?",
			description: "This source can execute code.",
			acceptDescription: "Trust and continue.",
			rejectDescription: "Keep it untrusted.",
		});
		const mounted = harness.getMounted();
		const selector = getSelectSubmenu(mounted.component);
		expect(mounted.focus).toBe(selector.getSelectList());

		selector.getSelectList().handleInput("\x1b[A");
		selector.getSelectList().handleInput("\r");

		await expect(result).resolves.toBe(true);
		expect(harness.done).toHaveBeenCalledOnce();
	});

	it("settles trust denial when superseded and ignores a late selection", async () => {
		const harness = captureSelectionHost();
		const result = confirmExternalResourceTrust(harness.host, {
			title: "Trust source?",
			description: "This source can execute code.",
			acceptDescription: "Trust and continue.",
			rejectDescription: "Keep it untrusted.",
		});
		const mounted = harness.getMounted();

		mounted.onSuperseded?.();
		getSelectSubmenu(mounted.component).getSelectList().handleInput("\r");

		await expect(result).resolves.toBe(false);
		expect(harness.done).not.toHaveBeenCalled();
	});

	it("owns text submission and supersession settlement", async () => {
		const submittedHarness = captureSelectionHost();
		const submitted = promptForTextInput(submittedHarness.host, "Create Profile", "Enter name");
		const submittedMount = submittedHarness.getMounted();
		const input = getExtensionInput(submittedMount.component);
		expect(submittedMount.focus).toBe(input);
		input.handleInput("reviewer");
		input.handleInput("\n");
		await expect(submitted).resolves.toBe("reviewer");
		expect(submittedHarness.done).toHaveBeenCalledOnce();

		const supersededHarness = captureSelectionHost();
		const superseded = promptForTextInput(supersededHarness.host, "Add Root", "Enter path");
		const supersededMount = supersededHarness.getMounted();
		const supersededInput = getExtensionInput(supersededMount.component);
		supersededMount.onSuperseded?.();
		supersededInput.handleInput("ignored");
		supersededInput.handleInput("\n");
		await expect(superseded).resolves.toBeUndefined();
		expect(supersededHarness.done).not.toHaveBeenCalled();
	});

	it("closes text input exactly once on keyboard cancellation", async () => {
		const harness = captureSelectionHost();
		const result = promptForTextInput(harness.host, "Add Root", "Enter path");

		getExtensionInput(harness.getMounted().component).handleInput("\x1b");

		await expect(result).resolves.toBeUndefined();
		expect(harness.done).toHaveBeenCalledOnce();
	});

	it("treats EPERM as live while rejecting invalid and missing processes", () => {
		const probe = vi.fn<(pid: number, signal: 0) => boolean>(() => true);
		expect(isProcessAlive(undefined, probe)).toBe(false);
		expect(isProcessAlive(0, probe)).toBe(false);
		expect(probe).not.toHaveBeenCalled();
		expect(isProcessAlive(42, probe)).toBe(true);

		probe.mockImplementationOnce(() => {
			throw Object.assign(new Error("permission denied"), { code: "EPERM" });
		});
		expect(isProcessAlive(43, probe)).toBe(true);

		probe.mockImplementationOnce(() => {
			throw Object.assign(new Error("missing"), { code: "ESRCH" });
		});
		expect(isProcessAlive(44, probe)).toBe(false);
	});
});
