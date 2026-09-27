import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("SettingsManager change listener isolation", () => {
	it("defers listeners added during a transition until the next settings generation", () => {
		const settingsManager = SettingsManager.inMemory();
		const calls: string[] = [];
		let lateListenerRegistered = false;

		settingsManager.subscribeChanges(() => {
			calls.push("first");
			if (!lateListenerRegistered) {
				lateListenerRegistered = true;
				settingsManager.subscribeChanges(() => calls.push("late"));
			}
		});
		settingsManager.subscribeChanges(() => calls.push("existing"));

		settingsManager.setTheme("light");
		expect(calls).toEqual(["first", "existing"]);

		settingsManager.setTheme("dark");
		expect(calls).toEqual(["first", "existing", "first", "existing", "late"]);
	});

	it("finishes the current transition generation before applying listener removal", () => {
		const settingsManager = SettingsManager.inMemory();
		const calls: string[] = [];
		let unsubscribeRemoved = () => {};

		settingsManager.subscribeChanges(() => {
			calls.push("first");
			unsubscribeRemoved();
		});
		unsubscribeRemoved = settingsManager.subscribeChanges(() => calls.push("removed"));

		settingsManager.setTheme("light");
		expect(calls).toEqual(["first", "removed"]);

		settingsManager.setTheme("dark");
		expect(calls).toEqual(["first", "removed", "first"]);
	});

	it("bounds recursively registered listeners to later settings generations", () => {
		const settingsManager = SettingsManager.inMemory();
		const calls: number[] = [];
		let nextId = 1;
		const register = () => {
			const id = nextId++;
			settingsManager.subscribeChanges(() => {
				calls.push(id);
				if (id < 4) register();
			});
		};
		register();

		settingsManager.setTheme("light");
		expect(calls).toEqual([1]);
	});

	it("observes an asynchronous listener failure without skipping later listeners", async () => {
		const settingsManager = SettingsManager.inMemory();
		const calls: string[] = [];

		settingsManager.subscribeChanges(() => Promise.reject(new Error("listener failed")));
		settingsManager.subscribeChanges(() => calls.push("later"));

		settingsManager.setTheme("light");
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(calls).toEqual(["later"]);
	});

	it("contains a synchronous listener failure and keeps notifying the captured generation", () => {
		const settingsManager = SettingsManager.inMemory();
		const calls: string[] = [];

		settingsManager.subscribeChanges(() => {
			throw new Error("listener failed");
		});
		settingsManager.subscribeChanges(() => calls.push("later"));

		expect(() => settingsManager.setTheme("light")).not.toThrow();
		expect(calls).toEqual(["later"]);
	});
});
