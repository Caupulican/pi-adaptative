import { readFileSync } from "node:fs";
import { isMissingFileError, withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";

/** What the chat's background summaries may spend per day when `contextPolicy.memory.history.compactionMaxUsdPerDay` is unset. */
export const DEFAULT_CONTINUOUS_CHAT_COMPACTION_MAX_USD_PER_DAY = 10;

interface SpendDay {
	day: string;
	usd: number;
}

/**
 * The summaries' spend for the current UTC day, kept in one file shared by every project and process on the account.
 * Nothing in the chat bounded how many paid replies its background work could fire; this is the bound. Reaching it
 * pauses new claims until the next day (summaries lag, exact history stays readable through `zoom`); it never fails work.
 */
export class ContinuousChatSpendMeter {
	private readonly file: string;
	private readonly maxUsdPerDay: () => number;
	private readonly now: () => number;

	constructor(file: string, maxUsdPerDay: () => number, now: () => number = Date.now) {
		this.file = file;
		this.maxUsdPerDay = maxUsdPerDay;
		this.now = now;
	}

	private today(): string {
		return new Date(this.now()).toISOString().slice(0, 10);
	}

	private read(): SpendDay {
		const day = this.today();
		try {
			const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			if (isPlainRecord(value) && value.day === day && typeof value.usd === "number" && Number.isFinite(value.usd))
				return { day, usd: Math.max(0, value.usd) };
		} catch (error) {
			if (!isMissingFileError(error) && !(error instanceof SyntaxError)) throw error;
		}
		return { day, usd: 0 };
	}

	/** The owner's words for why no summary may start now, or undefined while today's limit has room. 0 means no limit. */
	hold(): string | undefined {
		const limit = this.maxUsdPerDay();
		if (!(limit > 0)) return undefined;
		const spent = this.read().usd;
		return spent >= limit
			? `Memory summaries are paused for today: they have used $${spent.toFixed(2)} of the $${limit.toFixed(2)} daily limit. They resume tomorrow, and the full history stays readable.`
			: undefined;
	}

	/** Adds one reply's measured cost to today's total. */
	record(usd: number): void {
		if (!Number.isFinite(usd) || usd <= 0) return;
		withFileLockSync(`${this.file}.lock`, () => {
			const current = this.read();
			writeFileAtomicSync(this.file, JSON.stringify({ day: current.day, usd: current.usd + usd }));
		});
	}
}
