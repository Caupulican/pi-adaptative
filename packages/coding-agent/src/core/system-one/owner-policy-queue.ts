/**
 * The owner's words wait here until something needs what they decide.
 *
 * Classifying an owner message (does it grant capabilities, limit delivery, override a rule, hand off
 * decisions, change model pools, forbid an optional tool) is a System One request. Making every turn
 * wait for it, including a greeting, spends the owner's time on a judgment nothing may read. Here a
 * message is queued when it arrives, and the queue is settled where its outcome is read: before the
 * first tool call is admitted, before the next turn is routed, and where a handoff decides delivery.
 * A turn that uses no tool never settles it.
 *
 * Messages left over from earlier tool-free turns are screened together in one request, one closed
 * question per message; only a message the screen does not confidently set aside is classified in
 * full, in the order the owner wrote them, because a delivery limit and its lifting are order
 * dependent. The newest message is always classified in full: it is the one the work serves.
 */

export interface OwnerWords {
	readonly text: string;
	/** Submission order, so a stale judgment never overwrites newer owner policy. */
	readonly acceptedOrder?: number;
	/** The submission's own cancellation: its classification is cancelled with it. */
	readonly signal?: AbortSignal;
}

export interface OwnerPolicyQueueDeps {
	/** Classify one message in full and apply its outcome. */
	classify(words: OwnerWords): Promise<void>;
	/** Which of these messages may carry an instruction; undefined when the screen could not run. */
	screen(texts: readonly string[], signal?: AbortSignal): Promise<readonly boolean[] | undefined>;
}

/** How a settle treats the queue: `backlog` screens every queued message, `latest` classifies the newest in full. */
export type OwnerPolicySettleMode = "backlog" | "latest";

export class OwnerPolicyQueue {
	private pending: OwnerWords[] = [];
	private tail: Promise<void> = Promise.resolve();
	private readonly deps: OwnerPolicyQueueDeps;

	constructor(deps: OwnerPolicyQueueDeps) {
		this.deps = deps;
	}

	enqueue(words: OwnerWords): void {
		this.pending.push(words);
	}

	get size(): number {
		return this.pending.length;
	}

	/**
	 * Settle what is queued. Concurrent callers wait their turn on one chain, so a second settle finds
	 * the queue already drained and returns once the first one's classification has been applied.
	 */
	settle(mode: OwnerPolicySettleMode = "latest", signal?: AbortSignal): Promise<void> {
		if (this.pending.length === 0 && mode === "latest") return this.tail;
		const run = this.tail.then(() => this.drain(mode, signal));
		this.tail = run.catch(() => undefined);
		return run;
	}

	private async drain(mode: OwnerPolicySettleMode, signal?: AbortSignal): Promise<void> {
		const batch = this.pending.splice(0);
		if (batch.length === 0) return;
		const latest = mode === "latest" ? batch.pop() : undefined;
		const order = latest ? [...batch, latest] : batch;
		let done = 0;
		try {
			const carries =
				batch.length > 0
					? await this.deps.screen(
							batch.map((words) => words.text),
							signal,
						)
					: undefined;
			for (const [index, words] of order.entries()) {
				// An unavailable screen, or one that is not sure, classifies the message in full.
				if (words !== latest && !(carries?.[index] ?? true)) {
					done = index + 1;
					continue;
				}
				await this.deps.classify(words);
				done = index + 1;
			}
		} catch (error) {
			// A failed classification loses no instruction: what was not reached waits for the next settle.
			this.pending.unshift(...order.slice(done));
			throw error;
		}
	}
}
