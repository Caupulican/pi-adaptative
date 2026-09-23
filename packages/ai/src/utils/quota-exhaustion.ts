/**
 * Provider error text that says an account has run out of quota, usage, credit or balance: the request
 * will fail the same way until the limit window resets or the account is topped up, so retrying it is
 * futile and the host should move the work to another model. The one definition shared by the provider
 * retry loops (a terminal limit is never retried) and the host failure classifier (`billing_or_quota`).
 *
 * OpenRouter reports an API key that reached its spending cap as `Key limit exceeded`.
 *
 * HTTP 402 Payment Required is matched only in the shapes providers print a status in ("(402)",
 * "status 402", "402 Payment Required"), never a bare number, so a token count cannot read as a quota.
 */
export const QUOTA_EXHAUSTED_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|usage.?limit(?:s)?\s*(?:(?:has|have)\s+been\s+)?(?:reached|exceeded|hit)|usage_limit_reached|hit your (?:\S+ )?usage limit|balance (?:is |has been )?exhausted|key limit exceeded|payment.?required|\(402\)|(?:status|HTTP|error|code)\s*:?\s*402\b/i;

export function isQuotaExhaustedMessage(text: string): boolean {
	return QUOTA_EXHAUSTED_PATTERN.test(text);
}
