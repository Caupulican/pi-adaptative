import assert from "node:assert/strict";
import { test } from "node:test";
import { censusEntries, DEFAULT_GATE, evaluateGate, rateLimitRediscoveries, summarize } from "./multi-tenancy-census.mjs";

const base = 1_700_000_000_000;
const snapshot = (at) => ({ type: "request_snapshot", timestamp: new Date(at).toISOString(), requestId: `r${at}` });
const assistant = (at, ttftMs, provider = "xai") => ({
	type: "message",
	timestamp: new Date(at + ttftMs + 100).toISOString(),
	message: { role: "assistant", provider, firstTokenAt: at + ttftMs, streamEndAt: at + ttftMs + 100, usage: { output: 50 } },
});
const retry = (at, provider, errorMessage) => ({
	type: "custom",
	customType: "provider_retry",
	timestamp: new Date(at).toISOString(),
	data: { phase: "start", provider, modelId: "m", errorMessage, attempt: 1, maxAttempts: 3, delayMs: 2000 },
});
const wait = (at, reason, waitedMs, timedOut = false) => ({
	type: "custom",
	customType: "provider_admission",
	timestamp: new Date(at).toISOString(),
	data: { provider: "xai", lane: "worker", reason, waitedMs, timedOut, limit: 0, inflightAtStart: 1, inflightAtAdmission: 0 },
});

test("joins snapshots to first tokens and buckets TTFT by other in-flight requests", () => {
	const a = censusEntries([snapshot(base), assistant(base, 2_000)], "a");
	const b = censusEntries([snapshot(base + 500), assistant(base + 500, 4_000)], "b");
	const summary = summarize([a, b]);
	assert.equal(summary.requests, 2);
	const buckets = summary.providers.xai.ttftByOtherInflight;
	assert.equal(buckets["0"].n, 1);
	assert.equal(buckets["1"].n, 1);
	assert.equal(buckets["1"].p50, 4);
});

test("flags a rate limit two processes discovered within the window and passes when only one did", () => {
	const first = censusEntries([retry(base, "xai", "429 rate limit exceeded")], "session-a");
	const second = censusEntries([retry(base + 3_000, "xai", "429 Too Many Requests")], "session-b");
	const summary = summarize([first, second]);
	assert.equal(summary.retriesByAccount["xai/m"].rate_limit, 2);
	assert.equal(rateLimitRediscoveries(summary.retries, DEFAULT_GATE.rediscoveryWindowMs).length, 1);
	const verdict = evaluateGate(summary);
	assert.equal(verdict.ok, false);
	assert.match(verdict.failures[0], /1 rate-limit rediscoveries/);

	const lone = summarize([first, censusEntries([retry(base + 60_000, "xai", "429 rate limit")], "session-b")]);
	assert.equal(evaluateGate(lone).ok, true);
	const sameProcess = summarize([censusEntries([retry(base, "xai", "429"), retry(base + 1_000, "xai", "429")], "a")]);
	assert.equal(evaluateGate(sameProcess).ok, true);
});

test("sums admission waits by reason and fails the gate on a timed-out wait", () => {
	const folded = censusEntries([wait(base, "capacity", 750), wait(base + 1, "provider_limit", 4_000), wait(base + 2, "capacity", 120_000, true)], "a");
	const summary = summarize([folded]);
	assert.deepEqual(summary.waitsByReason.capacity, { n: 2, totalWaitedMs: 120_750, timedOut: 1 });
	assert.deepEqual(summary.waitsByReason.provider_limit, { n: 1, totalWaitedMs: 4_000, timedOut: 0 });
	const verdict = evaluateGate(summary);
	assert.equal(verdict.ok, false);
	assert.match(verdict.failures[0], /1 admission waits timed out/);
});
