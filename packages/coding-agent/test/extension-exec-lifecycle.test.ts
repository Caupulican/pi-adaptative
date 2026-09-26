// @isolated: module mock replaces the extension command process boundary
// @guards src/core/extensions/factory-runtime.ts

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecOptions, ExecResult } from "../src/core/exec.ts";

const execMocks = vi.hoisted(() => ({
	execCommand: vi.fn(),
}));

vi.mock("../src/core/exec.ts", () => ({
	execCommand: execMocks.execCommand,
}));

import { createEventBus } from "../src/core/event-bus.ts";
import {
	createExtensionRuntime,
	disposeExtensionEventSubscriptions,
	loadExtensionFromFactory,
} from "../src/core/extensions/loader.ts";

function killedResult(): ExecResult {
	return {
		stdout: "",
		stderr: "",
		code: 1,
		killed: true,
		stdoutTruncated: false,
		stderrTruncated: false,
	};
}

function waitForAbort(signal: AbortSignal | undefined): Promise<ExecResult> {
	return new Promise((resolve) => {
		if (!signal) return;
		if (signal.aborted) {
			resolve(killedResult());
			return;
		}
		signal.addEventListener("abort", () => resolve(killedResult()), { once: true });
	});
}

describe("extension exec lifecycle", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("aborts an extension-owned command when its factory times out", async () => {
		let observedSignal: AbortSignal | undefined;
		execMocks.execCommand.mockImplementation(
			(_command: string, _args: string[], _cwd: string, options?: ExecOptions) => {
				observedSignal = options?.signal;
				return waitForAbort(observedSignal);
			},
		);

		await expect(
			loadExtensionFromFactory(
				async (pi) => {
					await pi.exec("long-running-command", []);
				},
				process.cwd(),
				createEventBus(),
				createExtensionRuntime(),
				"timed-out-command-extension",
				{ factoryTimeoutMs: 10 },
			),
		).rejects.toThrow("Extension factory timed out after 10ms");

		expect(observedSignal).toBeDefined();
		expect(observedSignal?.aborted).toBe(true);
	});

	it("aborts an in-flight command when the extension generation is disposed", async () => {
		let observedSignal: AbortSignal | undefined;
		execMocks.execCommand.mockImplementation(
			(_command: string, _args: string[], _cwd: string, options?: ExecOptions) => {
				observedSignal = options?.signal;
				return waitForAbort(observedSignal);
			},
		);

		const extension = await loadExtensionFromFactory(
			(pi) => {
				void pi.exec("generation-owned-command", []);
			},
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"disposed-command-extension",
		);
		expect(observedSignal?.aborted).toBe(false);

		await disposeExtensionEventSubscriptions([extension]);

		expect(observedSignal?.aborted).toBe(true);
	});

	it("preserves a caller abort signal while the generation is active", async () => {
		let observedSignal: AbortSignal | undefined;
		execMocks.execCommand.mockImplementation(
			(_command: string, _args: string[], _cwd: string, options?: ExecOptions) => {
				observedSignal = options?.signal;
				return waitForAbort(observedSignal);
			},
		);
		const caller = new AbortController();
		let execution: Promise<ExecResult> | undefined;
		const extension = await loadExtensionFromFactory(
			(pi) => {
				execution = pi.exec("caller-owned-cancellation", [], { signal: caller.signal });
			},
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"caller-signal-extension",
		);

		caller.abort();
		expect((await execution)?.killed).toBe(true);
		expect(observedSignal?.aborted).toBe(true);
		await disposeExtensionEventSubscriptions([extension]);
	});
});
