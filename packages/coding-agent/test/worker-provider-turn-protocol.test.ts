import type { Usage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	WorkerCompletionProtocolError,
	WorkerProviderTurnProtocol,
} from "../src/core/delegation/worker-provider-turn-protocol.ts";
import type { GatewayUsageDelta, ProviderBudgetReservation } from "../src/core/orchestration/capability-gateway.ts";

function usage(overrides: Partial<Omit<Usage, "cost">> & { costTotal?: number } = {}): Usage {
	return {
		input: overrides.input ?? 0,
		output: overrides.output ?? 0,
		cacheRead: overrides.cacheRead ?? 0,
		cacheWrite: overrides.cacheWrite ?? 0,
		totalTokens: overrides.totalTokens ?? 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: overrides.costTotal ?? 0 },
	};
}

function trackedReservation(maxTokens = 64): {
	reservation: ProviderBudgetReservation;
	release: ReturnType<typeof vi.fn>;
} {
	const release = vi.fn();
	return { reservation: { maxTokens, release }, release };
}

function deferredReservation(): {
	promise: Promise<ProviderBudgetReservation>;
	resolve(reservation: ProviderBudgetReservation): void;
} {
	let resolvePromise: ((reservation: ProviderBudgetReservation) => void) | undefined;
	const promise = new Promise<ProviderBudgetReservation>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: (reservation) => {
			if (!resolvePromise) throw new Error("Deferred reservation is not initialized.");
			resolvePromise(reservation);
		},
	};
}

function createProtocol(options: {
	acquireReservation(): Promise<ProviderBudgetReservation>;
	signal?: AbortSignal;
	recordUsage?(delta: GatewayUsageDelta): void;
	onFailure?(error: unknown): void;
}): WorkerProviderTurnProtocol {
	return new WorkerProviderTurnProtocol({
		acquireReservation: options.acquireReservation,
		signal: options.signal ?? new AbortController().signal,
		onFailure: options.onFailure ?? (() => undefined),
		...(options.recordUsage ? { recordUsage: options.recordUsage } : {}),
	});
}

describe("WorkerProviderTurnProtocol", () => {
	it("fails overlapping preflights and invalidates the stale acquisition", async () => {
		const deferred = deferredReservation();
		const acquired = trackedReservation();
		const failures: unknown[] = [];
		const protocol = createProtocol({
			acquireReservation: () => deferred.promise,
			onFailure: (error) => failures.push(error),
		});

		const first = protocol.requestPreflight();
		await expect(protocol.requestPreflight()).rejects.toBeInstanceOf(WorkerCompletionProtocolError);
		deferred.resolve(acquired.reservation);
		await expect(first).rejects.toThrow("resolved after its ownership fence closed");

		expect(acquired.release).toHaveBeenCalledOnce();
		expect(failures).toHaveLength(2);
	});

	it("preserves completion and compaction error identities for missing preflights", () => {
		const completion = createProtocol({ acquireReservation: async () => trackedReservation().reservation });
		const compaction = createProtocol({ acquireReservation: async () => trackedReservation().reservation });

		expect(() => completion.assertProviderOutputPreflight()).toThrow(
			/^Worker completion returned provider output without a successful authority preflight\.$/,
		);
		expect(() => compaction.assertProviderOutputPreflight("compaction")).toThrow(
			/^Worker compaction returned provider output without a successful authority preflight\.$/,
		);
	});

	it("rejects and releases a preflight that resolves after close", async () => {
		const deferred = deferredReservation();
		const acquired = trackedReservation();
		const protocol = createProtocol({ acquireReservation: () => deferred.promise });
		const preflight = protocol.requestPreflight();

		protocol.close();
		deferred.resolve(acquired.reservation);

		await expect(preflight).rejects.toThrow("resolved after its ownership fence closed");
		expect(acquired.release).toHaveBeenCalledOnce();
	});

	it("releases an acquisition rejected by an aborted signal", async () => {
		const abort = new AbortController();
		const acquired = trackedReservation();
		const protocol = createProtocol({
			acquireReservation: async () => acquired.reservation,
			signal: abort.signal,
		});
		abort.abort(new Error("cancelled provider turn"));

		await expect(protocol.requestPreflight()).rejects.toThrow("cancelled provider turn");
		expect(acquired.release).toHaveBeenCalledOnce();
	});

	it("refuses to consume a reservation before assistant usage is accounted", async () => {
		const acquired = trackedReservation();
		const protocol = createProtocol({ acquireReservation: async () => acquired.reservation });
		await protocol.requestPreflight();

		expect(() => protocol.consumeToolAssistantAndRelease()).toThrow("before its provider usage was accounted");
		expect(acquired.release).not.toHaveBeenCalled();
		protocol.close();
		expect(acquired.release).toHaveBeenCalledOnce();
	});

	it("releases an accounted tool-assistant epoch immediately", async () => {
		const acquired = trackedReservation();
		const protocol = createProtocol({ acquireReservation: async () => acquired.reservation });
		await protocol.requestPreflight();

		protocol.accountAssistantUsage(usage({ input: 3, totalTokens: 3 }));
		protocol.consumeToolAssistantAndRelease();

		expect(acquired.release).toHaveBeenCalledOnce();
		protocol.assertEverySuccessfulPreflightConsumed();
	});

	it("holds an accounted terminal reservation until idempotent close", async () => {
		const acquired = trackedReservation();
		const protocol = createProtocol({ acquireReservation: async () => acquired.reservation });
		await protocol.requestPreflight();

		protocol.accountAssistantUsage(usage({ output: 2, totalTokens: 2 }));
		protocol.consumeTerminalAssistantAndHold();
		expect(acquired.release).not.toHaveBeenCalled();
		protocol.assertEverySuccessfulPreflightConsumed();

		protocol.close();
		protocol.close();
		expect(acquired.release).toHaveBeenCalledOnce();
	});

	it("releases a terminal-held epoch only when the next preflight proves another turn", async () => {
		const first = trackedReservation(64);
		const second = trackedReservation(32);
		const reservations = [first.reservation, second.reservation];
		const protocol = createProtocol({
			acquireReservation: async () => {
				const reservation = reservations.shift();
				if (!reservation) throw new Error("Unexpected provider preflight.");
				return reservation;
			},
		});
		await protocol.requestPreflight();
		protocol.accountAssistantUsage(usage({ output: 2, totalTokens: 2 }));
		protocol.consumeTerminalAssistantAndHold();

		await expect(protocol.requestPreflight()).resolves.toEqual({ maxTokens: 32 });
		expect(first.release).toHaveBeenCalledOnce();
		expect(second.release).not.toHaveBeenCalled();

		protocol.close();
		expect(second.release).toHaveBeenCalledOnce();
	});

	it("rejects a successful preflight that returned without an accounted assistant", async () => {
		const acquired = trackedReservation();
		const failures: unknown[] = [];
		const protocol = createProtocol({
			acquireReservation: async () => acquired.reservation,
			onFailure: (error) => failures.push(error),
		});
		await protocol.requestPreflight();

		expect(() => protocol.assertEverySuccessfulPreflightConsumed()).toThrow(
			"provider preflight authority epoch that no assistant consumed",
		);
		expect(failures).toHaveLength(1);
		expect(acquired.release).not.toHaveBeenCalled();

		protocol.close();
		expect(acquired.release).toHaveBeenCalledOnce();
	});

	it("retains a usage-recording failure and releases its unconsumed epoch on close", async () => {
		const acquired = trackedReservation();
		const recordingFailure = new Error("usage ledger unavailable");
		const failures: unknown[] = [];
		const protocol = createProtocol({
			acquireReservation: async () => acquired.reservation,
			recordUsage: () => {
				throw recordingFailure;
			},
			onFailure: (error) => failures.push(error),
		});
		await protocol.requestPreflight();

		expect(() => protocol.accountAssistantUsage(usage({ totalTokens: 1 }))).toThrow(recordingFailure);
		expect(failures).toEqual([recordingFailure]);
		expect(acquired.release).not.toHaveBeenCalled();

		protocol.close();
		expect(acquired.release).toHaveBeenCalledOnce();
	});

	it("accounts only the positive unverified result delta above callback usage", async () => {
		const acquired = trackedReservation();
		const recorded: GatewayUsageDelta[] = [];
		const protocol = createProtocol({
			acquireReservation: async () => acquired.reservation,
			recordUsage: (delta) => recorded.push(delta),
		});
		await protocol.requestPreflight();
		protocol.accountAssistantUsage(
			usage({ input: 10, output: 4, cacheRead: 6, cacheWrite: 2, totalTokens: 22, costTotal: 0.25 }),
		);
		protocol.consumeTerminalAssistantAndHold();

		expect(
			protocol.accountUnverifiedResultUsageDelta(
				usage({ input: 12, output: 3, cacheRead: 9, cacheWrite: 2, totalTokens: 30, costTotal: 0.5 }),
			),
		).toBe(true);
		expect(recorded).toEqual([
			{
				inputTokens: 10,
				outputTokens: 4,
				cacheReadTokens: 6,
				cacheWriteTokens: 2,
				totalTokens: 22,
				costUsd: 0.25,
			},
			{
				inputTokens: 2,
				outputTokens: 0,
				cacheReadTokens: 3,
				cacheWriteTokens: 0,
				totalTokens: 8,
				costUsd: 0.25,
			},
		]);
		expect(protocol.accountUnverifiedResultUsageDelta(usage())).toBe(false);
	});
});
