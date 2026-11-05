import { SYSTEM_TIMER_PORT, type TimerPort } from "../util/timer-port.ts";

/** Source work has one fixed deadline; each consumer owns only its wait. */
interface Flight<T> {
	readonly abort: AbortController;
	readonly promise: Promise<T>;
	consumers: number;
	settled: boolean;
}

const MAX_SOURCE_FLIGHTS = 64;
const MAX_FLIGHT_CONSUMERS = 64;

export class MemoryReadFlights {
	private readonly flights = new Map<string, Flight<unknown>>();
	private readonly settling = new Set<Promise<unknown>>();
	private readonly timeoutMs: number;
	private readonly timers: TimerPort;

	constructor(timeoutMs: number, timers: TimerPort = SYSTEM_TIMER_PORT) {
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Memory read timeout must be positive.");
		this.timeoutMs = timeoutMs;
		this.timers = timers;
	}

	read<T>(
		key: string,
		work: (signal: AbortSignal, deadlineAt: number) => Promise<T>,
		signal?: AbortSignal,
		deadlineAt?: number,
		onPhysicalStart?: (flight: { done: Promise<T>; signal: AbortSignal; deadlineAt: number }) => void,
	): Promise<T> {
		signal?.throwIfAborted();
		if (deadlineAt !== undefined && (!Number.isFinite(deadlineAt) || deadlineAt <= this.timers.now()))
			return Promise.reject(new Error("Memory read deadline expired."));
		let flight = this.flights.get(key);
		if (!flight) {
			if (this.settling.size >= MAX_SOURCE_FLIGHTS)
				return Promise.reject(new Error("Memory source read capacity is exhausted."));
			const abort = new AbortController();
			const fixedDeadline = this.timers.now() + this.timeoutMs;
			const timer = this.timers.setTimeout(
				() => abort.abort(new Error("Memory source operation timed out.")),
				this.timeoutMs,
			);
			const promise = Promise.resolve().then(() => {
				abort.signal.throwIfAborted();
				return work(abort.signal, fixedDeadline);
			});
			flight = { abort, promise, consumers: 0, settled: false };
			const owned = flight;
			this.flights.set(key, owned);
			this.settling.add(promise);
			void promise
				.finally(() => {
					owned.settled = true;
					this.timers.clearTimeout(timer);
					this.settling.delete(promise);
					if (this.flights.get(key) === owned) this.flights.delete(key);
				})
				.catch(() => {});
			try {
				onPhysicalStart?.({ done: promise, signal: abort.signal, deadlineAt: fixedDeadline });
			} catch (error) {
				abort.abort(error);
				if (this.flights.get(key) === owned) this.flights.delete(key);
				return Promise.reject(error);
			}
		}
		const owned = flight;
		if (owned.consumers >= MAX_FLIGHT_CONSUMERS)
			return Promise.reject(new Error("Memory source consumer capacity is exhausted."));
		owned.consumers++;
		return new Promise<T>((resolve, reject) => {
			let done = false;
			let timer: unknown;
			const finish = (outcome: { value: T } | { error: unknown }): void => {
				if (done) return;
				done = true;
				if (timer !== undefined) this.timers.clearTimeout(timer);
				signal?.removeEventListener("abort", cancel);
				owned.abort.signal.removeEventListener("abort", sourceCancelled);
				owned.consumers--;
				if (owned.consumers === 0) {
					if (this.flights.get(key) === owned) this.flights.delete(key);
					if (!owned.settled) owned.abort.abort(new Error("Memory source has no remaining consumers."));
				}
				if ("error" in outcome) reject(outcome.error);
				else resolve(outcome.value);
			};
			const cancel = (): void => finish({ error: signal?.reason ?? new Error("Memory read cancelled.") });
			const sourceCancelled = (): void => finish({ error: owned.abort.signal.reason });
			signal?.addEventListener("abort", cancel, { once: true });
			owned.abort.signal.addEventListener("abort", sourceCancelled, { once: true });
			if (deadlineAt !== undefined) {
				timer = this.timers.setTimeout(
					() => finish({ error: new Error("Memory read deadline expired.") }),
					Math.max(0, deadlineAt - this.timers.now()),
				);
			}
			// Each key names one source operation and result type; consumers never supply the physical value.
			void owned.promise.then(
				(value) => finish({ value: value as T }),
				(error) => finish({ error }),
			);
			if (signal?.aborted) cancel();
			else if (owned.abort.signal.aborted) sourceCancelled();
		});
	}

	/** Cancels consumers immediately, but joins actual source settlement before resources are released. */
	abort(reason: unknown): Promise<void> {
		for (const flight of this.flights.values()) flight.abort.abort(reason);
		this.flights.clear();
		return Promise.allSettled([...this.settling]).then(() => undefined);
	}
}
