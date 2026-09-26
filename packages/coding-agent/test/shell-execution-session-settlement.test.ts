// @isolated: module mocks replace process-owning shell lifecycle boundaries

import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycleMocks = vi.hoisted(() => ({
	disposePersistentShellSession: vi.fn(),
	disposeShellSessionLanes: vi.fn(),
	disposeWindowsShellEngineSession: vi.fn(),
	disposeWindowsShellState: vi.fn(),
}));

vi.mock("../src/core/tools/shell-lane-pool.ts", () => ({
	disposeShellSessionLanes: lifecycleMocks.disposeShellSessionLanes,
}));

vi.mock("../src/core/tools/shell-session.ts", () => ({
	disposePersistentShellSession: lifecycleMocks.disposePersistentShellSession,
}));

vi.mock("../src/core/tools/windows-shell-engine.ts", () => ({
	disposeWindowsShellEngineSession: lifecycleMocks.disposeWindowsShellEngineSession,
}));

vi.mock("../src/core/tools/windows-shell-state.ts", () => ({
	disposeWindowsShellState: lifecycleMocks.disposeWindowsShellState,
}));

import { disposeShellExecutionSessionAndWait } from "../src/core/tools/shell-execution-session.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("shell execution session settlement", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		lifecycleMocks.disposePersistentShellSession.mockResolvedValue(undefined);
		lifecycleMocks.disposeShellSessionLanes.mockResolvedValue(undefined);
		lifecycleMocks.disposeWindowsShellEngineSession.mockResolvedValue(undefined);
	});

	it("waits for every independent terminal when one disposer rejects", async () => {
		const pendingPersistentShell = deferred();
		const engineFailure = new Error("engine disposal failed");
		lifecycleMocks.disposeWindowsShellEngineSession.mockRejectedValueOnce(engineFailure);
		lifecycleMocks.disposePersistentShellSession.mockReturnValueOnce(pendingPersistentShell.promise);

		let settled = false;
		const outcome = disposeShellExecutionSessionAndWait("settlement-after-failure", 1_000).then(
			() => undefined,
			(error: unknown) => {
				settled = true;
				return error;
			},
		);
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(settled).toBe(false);
		pendingPersistentShell.resolve();
		expect(await outcome).toBe(engineFailure);
	});

	it("resolves after all independent terminals succeed", async () => {
		await expect(disposeShellExecutionSessionAndWait("successful-settlement", 1_000)).resolves.toBeUndefined();
		expect(lifecycleMocks.disposeWindowsShellState).toHaveBeenCalledWith("successful-settlement");
		expect(lifecycleMocks.disposeWindowsShellEngineSession).toHaveBeenCalledWith("successful-settlement");
		expect(lifecycleMocks.disposePersistentShellSession).toHaveBeenCalledWith("successful-settlement");
		expect(lifecycleMocks.disposeShellSessionLanes).toHaveBeenCalledWith("successful-settlement");
	});
});
