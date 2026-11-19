import { sleepWithAbortError } from "../abort-signals.ts";

const CANCEL_MESSAGE = "Login cancelled";
const TIMEOUT_MESSAGE = "Device flow timed out";
const SLOW_DOWN_TIMEOUT_MESSAGE =
	"Device flow timed out after the authorization server asked to slow down. Start sign-in again.";
const MINIMUM_INTERVAL_MS = 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// RFC 8628 section 3.2: if the authorization server omits `interval`, the client must use 5 seconds.
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
// RFC 8628 section 3.5: `slow_down` means the polling interval must increase by 5 seconds.
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;

type OAuthDeviceCodeIncompletePollResult =
	| { status: "pending" }
	| { status: "slow_down"; intervalSeconds?: number }
	| { status: "failed"; message: string };

export type OAuthDeviceCodePollResult<T> = OAuthDeviceCodeIncompletePollResult | { status: "complete"; value: T };

export type OAuthDeviceCodePollOptions<T> = {
	intervalSeconds?: number;
	expiresInSeconds?: number;
	/** Sleep one interval before the first poll instead of polling immediately. */
	waitBeforeFirstPoll?: boolean;
	poll: () => Promise<OAuthDeviceCodePollResult<T>>;
	signal?: AbortSignal;
};

export async function pollOAuthDeviceCodeFlow<T>(options: OAuthDeviceCodePollOptions<T>): Promise<T> {
	const started = performance.now();
	const deadline =
		typeof options.expiresInSeconds === "number"
			? started + options.expiresInSeconds * 1000
			: Number.POSITIVE_INFINITY;
	const seconds = options.intervalSeconds;
	let intervalMs = Math.max(
		MINIMUM_INTERVAL_MS,
		Math.floor(
			(typeof seconds === "number" && Number.isFinite(seconds) ? seconds : DEFAULT_POLL_INTERVAL_SECONDS) * 1000,
		),
	);
	let nextPoll = started + (options.waitBeforeFirstPoll ? intervalMs : 0);
	let slowed = false;
	while (true) {
		if (options.signal?.aborted) throw new Error(CANCEL_MESSAGE);
		const now = performance.now();
		if (!(now < deadline)) break;
		if (now < nextPoll) {
			// Oversized timer delays wrap to 1 ms in Node. Wake in chunks and recheck elapsed time.
			const delay = Math.min(MAX_TIMER_DELAY_MS, Math.ceil(Math.min(nextPoll, deadline) - now));
			await sleepWithAbortError(delay, options.signal, () => new Error(CANCEL_MESSAGE));
			continue;
		}
		const result = await options.poll();
		if (options.signal?.aborted) throw new Error(CANCEL_MESSAGE);
		if (result.status === "complete") {
			return result.value;
		}
		if (result.status === "failed") {
			throw new Error(result.message);
		}
		if (result.status === "slow_down") {
			slowed = true;
			intervalMs += SLOW_DOWN_INTERVAL_INCREMENT_MS;
			const minimum = result.intervalSeconds;
			if (typeof minimum === "number" && Number.isFinite(minimum)) {
				intervalMs = Math.max(intervalMs, Math.ceil(minimum * 1000));
			}
		}

		nextPoll = performance.now() + intervalMs;
	}

	throw new Error(slowed ? SLOW_DOWN_TIMEOUT_MESSAGE : TIMEOUT_MESSAGE);
}
