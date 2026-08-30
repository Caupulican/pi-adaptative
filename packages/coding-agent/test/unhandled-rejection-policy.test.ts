import { describe, expect, it } from "vitest";
import {
	registerSignalHandlers,
	reportUnhandledRejection,
	type SignalLifecycleHost,
	unregisterSignalHandlers,
} from "../src/modes/interactive/signal-lifecycle.ts";

function createHost(overrides: Partial<SignalLifecycleHost> = {}) {
	const errors: string[] = [];
	const statuses: string[] = [];
	const host = {
		isShuttingDown: false,
		signalCleanupHandlers: [] as Array<() => void>,
		shutdownRequested: false,
		runtimeHost: { dispose: async () => {} },
		ui: { terminal: { drainInput: async () => {} }, stop: () => {} },
		stop: () => {},
		formatResumeCommand: () => undefined,
		showStatus: (message: string) => statuses.push(message),
		showError: (message: string) => errors.push(message),
		shutdown: async () => {},
		unregisterSignalHandlers: () => {},
		emergencyTerminalExit: (() => {
			throw new Error("emergencyTerminalExit must not be called");
		}) as never,
		uncaughtCrash: ((error: Error) => {
			throw new Error(`uncaughtCrash must not be called: ${error.message}`);
		}) as never,
		...overrides,
	} as unknown as SignalLifecycleHost;
	return { host, errors, statuses };
}

describe("unhandled promise rejection policy", () => {
	it("reports the failure instead of ending the session", () => {
		const { host, errors } = createHost();
		reportUnhandledRejection(host, new Error("herdr socket boom"));
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("Unhandled promise rejection");
		expect(errors[0]).toContain("herdr socket boom");
	});

	it("reports a non-Error rejection reason too", () => {
		const { host, errors } = createHost();
		reportUnhandledRejection(host, "plain string reason");
		expect(errors[0]).toContain("plain string reason");
	});

	it("stays quiet once shutdown has started", () => {
		const { host, errors } = createHost({ isShuttingDown: true });
		reportUnhandledRejection(host, new Error("late rejection"));
		expect(errors).toEqual([]);
	});

	it("bounds the detail so a huge stack cannot flood the transcript", () => {
		const { host, errors } = createHost();
		const huge = new Error("boom");
		huge.stack = `boom\n${"at frame\n".repeat(5000)}`;
		reportUnhandledRejection(host, huge);
		expect(errors[0]!.length).toBeLessThan(2_200);
	});

	it("takes over the process listener so Node cannot escalate a rejection to a fatal crash", () => {
		// The registered listener is what stops Node's `--unhandled-rejections=throw` default from
		// turning an extension's floating promise into an uncaughtException, which pi treats as fatal.
		const before = process.listenerCount("unhandledRejection");
		const { host, errors } = createHost();
		registerSignalHandlers(host);
		try {
			expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
			// Drive the registered listener exactly as Node would.
			process.emit("unhandledRejection", new Error("from a floating promise"), Promise.resolve());
			expect(errors.some((message) => message.includes("from a floating promise"))).toBe(true);
		} finally {
			unregisterSignalHandlers(host);
		}
		expect(process.listenerCount("unhandledRejection")).toBe(before);
	});
});
