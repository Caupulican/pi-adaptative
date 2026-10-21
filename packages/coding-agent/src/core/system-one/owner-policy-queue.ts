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

export interface OwnerWords<Judgment = never> {
	readonly text: string;
	/** Submission order, so a stale judgment never overwrites newer owner policy. */
	readonly acceptedOrder?: number;
	/** Originating submission cancellation; a later settle supplies its own classification lifetime. */
	readonly signal?: AbortSignal;
	/**
	 * The full classification these words already received when they were submitted (a queued owner input is judged
	 * before it is admitted). Such words are never screened: `classify` applies the judgment, in owner order, or judges
	 * the words' owner policy when the judgment holds none (a newer owner request superseded it).
	 */
	readonly judgment?: Judgment;
}

export interface OwnerPolicyQueueDeps<Judgment = never> {
	/** Classify one message in full (or apply the judgment it carries) and apply its outcome. */
	classify(words: OwnerWords<Judgment>): Promise<void>;
	/** Which of these messages may carry an instruction; undefined when the screen could not run. */
	screen(texts: readonly string[], signal?: AbortSignal): Promise<readonly boolean[] | undefined>;
	/**
	 * A settle failed (the screen or a classification threw). The words it did not reach are kept, in order, and are
	 * settled again once the cause can have cleared (`wake`: the owner's next message, or the evaluator's next success);
	 * nothing waits on them meanwhile. Reported once per settle.
	 */
	reportFailure(error: unknown): void;
	/** The screen confidently set these words aside: they carry no instruction and are not classified. */
	setAside(words: OwnerWords<Judgment>): void;
}

/** How a settle treats the queue: `backlog` screens every queued message, `latest` classifies the newest in full. */
export type OwnerPolicySettleMode = "backlog" | "latest";

/** Settles like `promise`, or as soon as `signal` aborts; a rejection of `promise` still rejects. */
function settledOrAborted(promise: Promise<void>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const onAbort = (): void => resolve();
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export class OwnerPolicyQueue<Judgment = never> {
	private pending: OwnerWords<Judgment>[] = [];
	/**
	 * Words a failed settle did not reach, oldest first. They wait for an event that can have cleared the failure (`wake`)
	 * instead of being retried by every settle: a failure that persists would otherwise be paid for at every tool batch.
	 */
	private parked: OwnerWords<Judgment>[] = [];
	private tail: Promise<void> = Promise.resolve();
	private readonly deps: OwnerPolicyQueueDeps<Judgment>;

	constructor(deps: OwnerPolicyQueueDeps<Judgment>) {
		this.deps = deps;
	}

	enqueue(words: OwnerWords<Judgment>): void {
		// The owner spoke again: words a failed settle kept are settled with these, ahead of them, in owner order.
		this.wake();
		this.pending.push(words);
	}

	/**
	 * What failed a settle can have cleared (the owner spoke again, or the evaluator answered a request): the words that
	 * settle kept are queued again, ahead of anything newer, and the next settle reads them where their outcome is read.
	 * Words are parked only when nothing newer was pending, so they are always the oldest.
	 */
	wake(): void {
		if (this.parked.length > 0) this.pending.unshift(...this.parked.splice(0));
	}

	get size(): number {
		return this.pending.length;
	}

	/**
	 * Settle what is queued. Concurrent callers wait their turn on one chain, so a second settle finds
	 * the queue already drained and returns once the first one's classification has been applied. A
	 * failed settle never rejects: its failure is reported and the words it did not reach are kept.
	 */
	settle(mode: OwnerPolicySettleMode = "latest", signal?: AbortSignal): Promise<void> {
		let settled = this.tail;
		if (this.pending.length > 0 || mode === "backlog") {
			const run = this.tail.then(() => this.drain(mode, signal));
			this.tail = run.catch(() => undefined);
			settled = run;
		}
		// The chain ahead may be a classification that outlives this caller's interrupt; the caller stops waiting for it.
		return signal ? settledOrAborted(settled, signal) : settled;
	}

	private async drain(mode: OwnerPolicySettleMode, signal?: AbortSignal): Promise<void> {
		const batch = this.pending.splice(0);
		if (batch.length === 0) return;
		const latest = mode === "latest" ? batch.pop() : undefined;
		const order = latest ? [...batch, latest] : batch;
		// Words judged at submission are applied as judged: screening them would judge them a second time.
		const screened = batch.filter((words) => words.judgment === undefined);
		let done = 0;
		try {
			const carries =
				screened.length > 0
					? await this.deps.screen(
							screened.map((words) => words.text),
							signal,
						)
					: undefined;
			for (const [index, words] of order.entries()) {
				// An unavailable screen, or one that is not sure, classifies the message in full.
				if (words !== latest && words.judgment === undefined && !(carries?.[screened.indexOf(words)] ?? true)) {
					this.deps.setAside(words);
					done = index + 1;
					continue;
				}
				// Delivered words outlive their originating turn. A later reader owns their classification;
				// an already-aborted original signal must not permanently cancel these retained instructions.
				let classificationSignal = signal;
				if (classificationSignal === undefined) {
					classificationSignal = words.signal;
					if (classificationSignal?.aborted) classificationSignal = undefined;
				}
				await this.deps.classify({ ...words, signal: classificationSignal });
				done = index + 1;
			}
		} catch (error) {
			// A failed classification loses no instruction: what was not reached is kept, ahead of anything newer, and is
			// settled again after its `wake`. Words that arrived during this settle are newer and settle as usual.
			const unreached = order.slice(done);
			if (this.pending.length > 0) this.pending.unshift(...unreached);
			else this.parked.push(...unreached);
			this.deps.reportFailure(error);
		}
	}
}
