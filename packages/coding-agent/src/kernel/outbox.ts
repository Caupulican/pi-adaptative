/**
 * Record-before-effect: a durable claim, then the effect, then a durable settle. A claim whose effect may have happened is
 * never repeated by code; a failed effect gives its claim back only through the caller's own give-back. The call sites that
 * use this choreography are the adopters in scripts/outbox-sites.json (no `reason`). The other pinned transports declare why
 * their record comes before their effect, so the release-on-failure and unknown-outcome rules are stated here once.
 */

/** The durable steps of one outward effect. `claim` runs first and refuses by throwing. */
export interface OutboxSteps<C, T> {
	/** Durable claim. Throws to refuse (gone, or held by a live effect). `undefined` means nothing is owed: no effect runs. */
	claim(): C | undefined;
	/** The outward effect. It runs only after the claim is recorded. */
	effect(claim: C): Promise<T>;
	/** Durable settle of the effect's outcome. When it throws, the claim stands and reads as an unknown outcome. */
	settle(claim: C, value: T): void;
}

/**
 * The give-back of a failed effect. Both members are present or both absent: a give-back that can fail always has a
 * reporter. A give-back that throws is reported through `onReleaseFailed`, and the effect's error is rethrown after that
 * report.
 */
export type OutboxGiveBack<C> =
	| { readonly release?: undefined; readonly onReleaseFailed?: undefined }
	| {
			/** Durable give-back after a failed effect, so the item waits again. */
			release(claim: C, error: unknown): void;
			/** Reports a give-back that threw; the effect's error is rethrown after it. */
			onReleaseFailed(error: unknown): void;
	  };

/**
 * What one run did. `skipped`: nothing was owed, so no effect ran. `settled`: the effect ran and its outcome is recorded.
 * `settle_unrecorded`: the effect ran, and recording its outcome failed.
 */
export type OutboxRun<C, T> =
	| { readonly kind: "skipped" }
	| { readonly kind: "settled"; readonly claim: C; readonly value: T }
	| { readonly kind: "settle_unrecorded"; readonly claim: C; readonly value: T; readonly error: unknown };

/**
 * Runs claim, effect, settle in that order. A claim error propagates unchanged. An effect error gives the claim back
 * through `release` (when the caller has one) and is rethrown. A settle error is returned, not thrown, because the
 * effect already happened and the caller must report it as an unknown outcome.
 */
export async function claimThenEffect<C, T>(steps: OutboxSteps<C, T> & OutboxGiveBack<C>): Promise<OutboxRun<C, T>> {
	const claim = steps.claim();
	if (claim === undefined) return { kind: "skipped" };
	let value: T;
	try {
		value = await steps.effect(claim);
	} catch (error) {
		if (steps.release) {
			try {
				steps.release(claim, error);
			} catch (releaseError) {
				steps.onReleaseFailed(releaseError);
			}
		}
		throw error;
	}
	try {
		steps.settle(claim, value);
	} catch (error) {
		return { kind: "settle_unrecorded", claim, value, error };
	}
	return { kind: "settled", claim, value };
}
