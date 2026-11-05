/** Ordered summary-store reads. Fences start after the physical read already in flight. */
import { assertMemoryReadActive, type MemoryReadContext } from "./memory-read-context.ts";
import { MemoryReadFlights } from "./memory-read-flight.ts";
import { TRANSCRIPT_FOREGROUND_READ_MS, type TranscriptReadUnavailable } from "./transcript-memory-contracts.ts";

type Settled<T> = T | TranscriptReadUnavailable;

interface OrderedRead {
	readonly ticket: number;
	signal?: AbortSignal;
	done?: Promise<unknown>;
	predecessor?: Promise<unknown>;
}

/** One running plus one queued read; cancellation and independent consumer waits have one shared owner. */
export class TranscriptBoundedRead<T> {
	private readonly work: (ticket: number, context: MemoryReadContext) => Promise<Settled<T>>;
	private readonly reads = new MemoryReadFlights(TRANSCRIPT_FOREGROUND_READ_MS);
	private tickets = 0;
	private flight: OrderedRead | undefined;
	private followUp: OrderedRead | undefined;
	private closed = false;

	constructor(work: (ticket: number, context: MemoryReadContext) => Promise<Settled<T>>) {
		this.work = work;
	}

	join(context: MemoryReadContext = {}): Promise<Settled<T>> {
		return this.read(false, context);
	}

	fence(context: MemoryReadContext = {}): Promise<Settled<T>> {
		return this.read(true, context);
	}

	/** Abort consumers promptly, then join all physical I/O before its store can be released. */
	close(): Promise<void> {
		this.closed = true;
		return this.reads.abort(new Error("The summary store reader was closed."));
	}

	private async read(fence: boolean, context: MemoryReadContext): Promise<Settled<T>> {
		if (this.closed) return { status: "unavailable", reason: "The summary store reader was closed." };
		try {
			assertMemoryReadActive(context);
		} catch (error) {
			return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
		}
		let selected = this.flight;
		if (selected && (fence || selected.signal?.aborted)) {
			selected = this.followUp ??= { ticket: ++this.tickets, predecessor: selected.done };
		} else if (!selected) {
			selected = this.flight = { ticket: ++this.tickets };
		}
		if (selected.signal?.aborted) {
			return { status: "unavailable", reason: "The previous summary store read is still settling." };
		}
		const owned = selected;
		try {
			// Register a joining parent's physical ownership before admitting its independent wait.
			const previous = owned.done;
			if (previous)
				context.onPhysicalRead?.(
					previous.then(
						() => undefined,
						() => undefined,
					),
				);
			return await this.reads.read(
				String(owned.ticket),
				async (signal, deadlineAt, onPhysicalRead) => {
					await owned.predecessor?.catch(() => undefined);
					signal.throwIfAborted();
					if (this.followUp === owned) {
						this.followUp = undefined;
						this.flight = owned;
					}
					return this.work(owned.ticket, { signal, deadlineAt, onPhysicalRead });
				},
				context.signal,
				context.deadlineAt,
				({ done, signal }) => {
					owned.signal = signal;
					owned.done = done;
					void done
						.finally(() => {
							if (this.flight === owned) {
								this.flight = this.followUp;
								this.followUp = undefined;
							}
							if (this.followUp === owned) this.followUp = undefined;
						})
						.catch(() => {});
					if (done !== previous)
						context.onPhysicalRead?.(
							done.then(
								() => undefined,
								() => undefined,
							),
						);
				},
			);
		} catch (error) {
			if (!owned.done) {
				if (this.flight === owned) this.flight = undefined;
				if (this.followUp === owned) this.followUp = undefined;
			}
			return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
		}
	}
}
