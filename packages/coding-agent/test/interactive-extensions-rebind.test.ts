import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type RebindHarness = {
	unsubscribe?: () => void;
	unsubscribeExtensionsChanged?: () => void;
	runtimeHost: { session: { onExtensionsChanged(callback: () => void): () => void } };
	applyRuntimeSettings(): void;
	bindCurrentSessionExtensions(): Promise<void>;
	subscribeToAgent(): void;
	updateAvailableProviderCount(): Promise<void>;
	updateEditorBorderColor(): void;
	updateTerminalTitle(): void;
	refreshUIAfterExtensionsChanged(): Promise<void>;
	rebindCurrentSession(): Promise<void>;
};

function createModeHarness(): { mode: RebindHarness; fireExtensionsChanged: () => void } {
	let listener: (() => void) | undefined;
	const mode = Object.create(InteractiveMode.prototype) as RebindHarness;
	mode.unsubscribe = vi.fn();
	mode.unsubscribeExtensionsChanged = vi.fn();
	mode.runtimeHost = {
		session: {
			onExtensionsChanged: (callback: () => void) => {
				listener = callback;
				return vi.fn();
			},
		},
	};
	mode.applyRuntimeSettings = vi.fn();
	mode.bindCurrentSessionExtensions = vi.fn(async () => {});
	mode.subscribeToAgent = vi.fn();
	mode.updateAvailableProviderCount = vi.fn(async () => {});
	mode.updateEditorBorderColor = vi.fn();
	mode.updateTerminalTitle = vi.fn();
	mode.refreshUIAfterExtensionsChanged = vi.fn(async () => {});
	return {
		mode,
		fireExtensionsChanged: () => listener?.(),
	};
}

describe("InteractiveMode extension-change rebinding", () => {
	it("re-subscribes the extension-change listener when the current session is rebound", async () => {
		const { mode, fireExtensionsChanged } = createModeHarness();
		const oldUnsubscribe = mode.unsubscribeExtensionsChanged;

		await mode.rebindCurrentSession();
		fireExtensionsChanged();

		expect(oldUnsubscribe).toHaveBeenCalledOnce();
		expect(mode.refreshUIAfterExtensionsChanged).toHaveBeenCalledOnce();
	});
});
