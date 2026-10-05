import type { UsageCredit } from "../types.ts";
import { isRecord } from "../utils/value-guards.ts";

/** One decoder for the Credits proto used by account tiers and inference envelopes. */
export function parseAntigravityCredits(
	value: unknown,
	createError: (message: string) => Error = (message) => new Error(message),
): UsageCredit[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 200) throw createError("Invalid Antigravity credit list");
	const amount = (raw: unknown): number => {
		if (raw === undefined) return 0;
		const numeric = typeof raw === "string" && /^\d{1,16}$/.test(raw) ? Number(raw) : raw;
		if (typeof numeric !== "number" || !Number.isSafeInteger(numeric) || numeric < 0)
			throw createError("Invalid Antigravity credit amount");
		return numeric;
	};
	return value.map((entry) => {
		if (!isRecord(entry)) throw createError("Invalid Antigravity credits");
		if (entry.creditType !== undefined && (typeof entry.creditType !== "string" || entry.creditType.length > 4096))
			throw createError("Invalid Antigravity credit type");
		return {
			type: entry.creditType || "credits",
			amount: amount(entry.creditAmount),
			minimum: amount(entry.minimumCreditAmountForUsage),
		};
	});
}
