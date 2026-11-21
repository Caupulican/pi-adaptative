import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type AssistantMessage,
	createEmptyUsage,
	type Model,
	registerBuiltInApiProviders,
	streamSimple,
} from "@caupulican/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import {
	applyProviderPayloadHook,
	createAssistantMessage,
	getAnthropicCacheControl,
	providerCachePolicyFromPayload,
	recordProviderCachePolicy,
} from "../../ai/src/providers/provider-runtime.ts";
import { CacheClock } from "../src/core/cache-clock.ts";
import { CacheKnowledge } from "../src/core/context/cache-knowledge.ts";
import { CacheLaneGuard } from "../src/core/context/cache-lane-guard.ts";
import {
	CacheObservationRecorder,
	cacheLaneKey,
	messageCachePolicy,
	readCacheExpiryPolicy,
} from "../src/core/context/cache-observation-recorder.ts";
import {
	type CacheExpiryPolicy,
	cacheExpiryBounds,
	predictRetained,
	survivalCurve,
} from "../src/core/context/cache-survival.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-fixture",
	name: "Fixture",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const lane = cacheLaneKey(model.api, model.provider, model.id);
const capture = {
	accountScope: "account-a",
	cacheControlFormat: "anthropic" as const,
	supportsLongCacheRetention: true,
};
const settings = { halfLifeMs: Infinity, poolingWeight: 16, binsPerDecade: 2 };
const dirs: string[] = [];
const stores: DecisionLedgerStore[] = [];
function storeAt(databasePath: string) {
	const store = new DecisionLedgerStore({ databasePath });
	stores.push(store);
	return store;
}
function policy(overrides: Partial<CacheExpiryPolicy> = {}): CacheExpiryPolicy {
	return {
		lane,
		accountScope: "account-a",
		kind: "fixed",
		wirePolicy: "anthropic-1h",
		capturedAt: 1000,
		cacheTouched: true,
		ttlMs: 3_600_000,
		...overrides,
	};
}
function message(ttl = "1h", at = 1000): AssistantMessage {
	vi.spyOn(Date, "now").mockReturnValue(at);
	const output = createAssistantMessage(model);
	output.usage = { ...createEmptyUsage(), input: 100, cacheRead: 900 };
	recordProviderCachePolicy(
		output,
		model,
		{ model: model.id, system: [{ cache_control: { type: "ephemeral", ttl } }] },
		capture,
	);
	return output;
}
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it("resolves explicit short before global long and respects the adapter's retention capability", () => {
	vi.stubEnv("PI_CACHE_RETENTION", "long");
	const compat = { cacheControlFormat: "anthropic", supportsLongCacheRetention: true };
	expect(getAnthropicCacheControl(undefined, compat)).toEqual({ type: "ephemeral", ttl: "1h" });
	expect(getAnthropicCacheControl("short", compat)).toEqual({ type: "ephemeral" });
	expect(getAnthropicCacheControl("long", { ...compat, supportsLongCacheRetention: false })).toEqual({
		type: "ephemeral",
	});
	expect(getAnthropicCacheControl("none", compat)).toBeUndefined();
	expect(getAnthropicCacheControl("long", { ...compat, cacheControlFormat: "unknown" })).toBeUndefined();
});

it("captures the final hook-selected policy and supersedes prior attempts on invalid replacement", async () => {
	const output = message();
	expect(messageCachePolicy(output)?.ttlMs).toBe(3_600_000);
	await applyProviderPayloadHook({ model: model.id }, model, () => ({ model: model.id }), {
		message: output,
		...capture,
	});
	expect(messageCachePolicy(output)).toMatchObject({ kind: "disabled" });
	await applyProviderPayloadHook({ model: model.id }, model, () => ({ model: "a-different-model", messages: [] }), {
		message: output,
		...capture,
	});
	expect(messageCachePolicy(output)).toMatchObject({ kind: "unknown" });
	expect(messageCachePolicy(output)?.ttlMs).toBeUndefined();
});

it("requires supported uniform Anthropic controls and bounds the diagnostic walk", () => {
	const payload = (ttl: string) => ({
		model: model.id,
		messages: [{ content: [{ cache_control: { type: "ephemeral", ttl } }] }],
	});
	expect(providerCachePolicyFromPayload(model, payload("5m"), capture)).toMatchObject({
		kind: "fixed",
		ttlMs: 300000,
	});
	expect(providerCachePolicyFromPayload(model, payload("5m"), { cacheControlFormat: "unknown" })).toMatchObject({
		kind: "unknown",
	});
	expect(
		providerCachePolicyFromPayload(model, payload("1h"), { ...capture, supportsLongCacheRetention: false }),
	).toMatchObject({ kind: "unknown" });
	expect(
		providerCachePolicyFromPayload(
			model,
			{
				system: [
					{ cache_control: { type: "ephemeral", ttl: "1h" } },
					{ cache_control: { type: "ephemeral", ttl: "5m" } },
				],
			},
			capture,
		),
	).toMatchObject({ kind: "unknown" });
	expect(
		providerCachePolicyFromPayload(model, { tools: Array.from({ length: 2050 }, () => ({})) }, capture),
	).toMatchObject({ kind: "unknown" });
});

it("distinguishes automatic OpenAI policy from disabled/unsupported wire forms without inventing TTL", () => {
	const openai = { cacheControlFormat: "openai" as const };
	const read = (payload: unknown) => providerCachePolicyFromPayload(model, payload, openai);
	const automatic = read({ prompt_cache_options: { mode: "implicit", ttl: "30m" } });
	const disabled = read({ prompt_cache_options: { mode: "explicit" } });
	expect(automatic).toMatchObject({ kind: "automatic" });
	expect(disabled).toMatchObject({ kind: "disabled" });
	expect(automatic?.wirePolicy).not.toBe(disabled?.wirePolicy);
	expect(read({ prompt_cache_options: { mode: "implicit", ttl: "12h" } })?.wirePolicy).not.toBe(automatic?.wirePolicy);
	for (const prompt_cache_retention of ["24h", "in_memory"]) {
		expect(read({ prompt_cache_retention })).toMatchObject({ kind: "automatic" });
		expect(read({ prompt_cache_retention })?.ttlMs).toBeUndefined();
	}
	expect(read({ prompt_cache_retention: "in-memory" })).toMatchObject({ kind: "unknown" });
	expect(read({ prompt_cache_options: { mode: "surprise", ttl: "1h" } })).toMatchObject({ kind: "unknown" });
});

it("does not trust missing account, legacy timing, requested/served model drift or mismatched lane", () => {
	const output = message();
	expect(messageCachePolicy({ ...output, responseModel: "actual-other-model" })).toBeUndefined();
	expect(messageCachePolicy({ ...output, diagnostics: undefined })).toBeUndefined();
	expect(readCacheExpiryPolicy({ ...policy(), capturedAt: undefined }, lane)).toBeUndefined();
	expect(readCacheExpiryPolicy(policy(), "other-lane")).toBeUndefined();
	expect(readCacheExpiryPolicy({ ...policy(), accountScope: "" }, lane)).toBeUndefined();
});

it("preserves useful captured priors while legacy and future timing remain unknown", () => {
	const previous = { observedAt: 11000, cachePolicy: policy() };
	const forecast = (cachePolicy = previous.cachePolicy, observedAt = previous.observedAt) =>
		survivalCurve([], lane, settings, 12000, { observedAt, cachePolicy });
	expect(predictRetained(forecast(), 600000, settings.binsPerDecade)).toBe(1);
	expect(predictRetained(forecast(policy({ ttlMs: 300000 })), 600000, settings.binsPerDecade)).toBe(0);
	expect(survivalCurve([], lane, settings, 12000).priorTtlMs).toBeUndefined();
	expect(forecast(policy({ cacheTouched: false })).priorTtlMs).toBeUndefined();
	expect(forecast(policy({ kind: "unknown", ttlMs: undefined })).priorTtlMs).toBeUndefined();
	expect(forecast(policy({ capturedAt: 12000 })).priorTtlMs).toBeUndefined();
	expect(cacheExpiryBounds(previous)).toEqual({ warmUntilMs: 3590000, coldAfterMs: 3600000 });
});

it("clears prior clock state on no-touch/unknown results and schedules both conservative boundaries", () => {
	const clock = new CacheClock();
	const output = message("5m", 1000);
	clock.observe({ type: "message_end", message: output }, 11000);
	expect(clock.remainingMs(11000)).toBe(290000);
	expect(clock.nextBoundaryMs(11000)).toBe(290000);
	expect(clock.remainingMs(301000)).toBeUndefined();
	expect(clock.nextBoundaryMs(301000)).toBe(10000);
	expect(clock.remainingMs(311000)).toBe(0);
	expect(clock.nextBoundaryMs(311000)).toBeUndefined();
	expect(clock.remainingMs(10000)).toBeUndefined();
	clock.observe({ type: "message_end", message: { ...output, usage: createEmptyUsage() } }, 12000);
	expect(clock.remainingMs(12000)).toBeUndefined();
	clock.observe({ type: "message_end", message: message("5m", 20000) }, 19000);
	expect(clock.remainingMs(19000)).toBeUndefined();
});

it("migrates legacy rows as unknown and resumes the exact session/lane/account policy from SQLite", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-cache-policy-"));
	dirs.push(dir);
	const databasePath = join(dir, "ledger.sqlite");
	const old = new DatabaseSync(databasePath);
	old.exec(`CREATE TABLE cache_observations (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
		cwd TEXT NOT NULL, lane TEXT NOT NULL, observed_at INTEGER NOT NULL, gap_ms INTEGER, prompt_tokens INTEGER NOT NULL,
		cache_read_tokens INTEGER NOT NULL, retained REAL, prefix_intact TEXT NOT NULL, divergence_kind TEXT, lineage TEXT, holder TEXT)`);
	old.prepare(
		"INSERT INTO cache_observations (session_id,cwd,lane,observed_at,prompt_tokens,cache_read_tokens,prefix_intact) VALUES (?,?,?,?,?,?,?)",
	).run("legacy", dir, lane, 1000, 1000, 900, "true");
	old.close();
	const first = storeAt(databasePath);
	expect(first.latestCacheObservation("legacy", lane)?.cachePolicy).toBeUndefined();
	const row = {
		sessionId: "owner",
		cwd: dir,
		lane,
		observedAt: 11000,
		promptTokens: 1000,
		cacheReadTokens: 900,
		prefixIntact: "true" as const,
	};
	first.recordCacheObservation({ ...row, cachePolicy: policy() });
	first.recordCacheObservation({ ...row, cachePolicy: policy({ accountScope: "account-b" }) });
	first.close();
	stores.splice(stores.indexOf(first), 1);
	const reopened = storeAt(databasePath);
	const last = reopened.latestCacheObservation("owner", lane);
	expect(last?.cachePolicy?.accountScope).toBe("account-b");
	const recorder = new CacheObservationRecorder((sessionId, targetLane) => {
		const last = reopened.latestCacheObservation(sessionId, targetLane);
		return last
			? { respondedAt: last.observedAt, promptTokens: last.promptTokens, cachePolicy: last.cachePolicy }
			: undefined;
	});
	const same = recorder.observe({
		sessionId: "owner",
		lane,
		respondedAt: 13000,
		requestOpenedAt: 12000,
		usage: { cacheRead: 1000 },
		prefixIntact: true,
		cachePolicy: policy({ accountScope: "account-b", capturedAt: 12000 }),
	});
	expect(same).toMatchObject({ gapMs: 1000, retained: 1, measuredCachePolicy: { accountScope: "account-b" } });
	if (!same) throw Error("Missing observation");
	reopened.recordCacheObservation({ ...same, sessionId: "owner", cwd: dir });
	const knowledge = new CacheKnowledge(() => reopened, settings);
	const previous = knowledge.lastResponse("owner", lane);
	expect(knowledge.retainedAfter(lane, 600000, 14000, previous)?.retained).toBe(1);
	expect(knowledge.retainedAfter("different-lane", 600000, 14000, previous)).toBeUndefined();
	for (const changed of [
		policy(),
		policy({ accountScope: "account-b", ttlMs: 300000 }),
		policy({ kind: "unknown", ttlMs: undefined }),
	]) {
		const result = recorder.observe({
			sessionId: "owner",
			lane,
			respondedAt: 15000,
			requestOpenedAt: 14000,
			usage: { cacheRead: 1000 },
			cachePolicy: changed,
		});
		expect(result?.measuredCachePolicy).toBeUndefined();
	}
	const peerLane = cacheLaneKey(model.api, `${model.provider}-peer`, model.provider);
	reopened.recordCacheObservation({
		...row,
		lane: peerLane,
		measuredCachePolicy: policy({ lane: peerLane }),
	});
	expect(reopened.measuredCacheObservationsForProvider(model.provider, 0).map((entry) => entry.lane)).toEqual([lane]);
	expect(reopened.measuredCacheObservationsForProvider(`${model.provider}-peer`, 0)).toHaveLength(1);
	expect(reopened.measuredCacheObservationsForProvider(model.provider, same.observedAt + 1)).toHaveLength(0);
	expect(reopened.recentCacheObservations(lane, 10).some((entry) => entry.sessionId === "legacy")).toBe(true);
});

it("does not reclassify legacy or differently scoped hit observations using the current policy", () => {
	const current = policy({ kind: "automatic", ttlMs: undefined, wirePolicy: "automatic" });
	const row = {
		lane,
		observedAt: 11000,
		gapMs: 1000,
		retained: 1,
		promptTokens: 1000,
		cacheReadTokens: 1000,
		prefixIntact: "true" as const,
	};
	const rows = [
		row,
		{ ...row, measuredCachePolicy: { ...current, accountScope: "other-account" } },
		{ ...row, measuredCachePolicy: { ...current, wirePolicy: "different-policy" } },
		{ ...row, measuredCachePolicy: { ...current, lane: "mismatched-lane" } },
	];
	const curve = survivalCurve(rows, lane, settings, 12000, { observedAt: 11000, cachePolicy: current });
	expect(curve.laneObservations).toBe(0);
	expect(predictRetained(curve, 1000, settings.binsPerDecade)).toBeUndefined();
	const measured = survivalCurve([...rows, { ...row, measuredCachePolicy: current }], lane, settings, 12000, {
		observedAt: 11000,
		cachePolicy: current,
	});
	expect(measured.laneObservations).toBe(1);
	expect(predictRetained(measured, 1000, settings.binsPerDecade)).toBe(1);
});

it("retains request-local account policy from public streamSimple through native SSE into SQLite", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-cache-public-entry-"));
	dirs.push(dir);
	const ledger = storeAt(join(dir, "ledger.sqlite"));
	const guard = new CacheLaneGuard({
		getSessionId: () => "owner",
		getCwd: () => dir,
		getDecisionLedger: () => ledger,
	});
	registerBuiltInApiProviders();
	const bodies: Record<string, unknown>[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			bodies.push(body);
			const chunk = {
				id: "offline-cache-receipt",
				object: "chat.completion.chunk",
				created: 1,
				model: body.model,
				choices: [{ index: 0, delta: { role: "assistant", content: "Read complete." }, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1000,
					completion_tokens: 1,
					total_tokens: 1001,
					prompt_tokens_details: { cached_tokens: 900 },
				},
			};
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		}),
	);
	for (const [id, expectedKind, ttlMs, contradictory] of [
		["anthropic/claude-fixture", "fixed", 3600000, false],
		["anthropic/claude-fixture", "fixed", 3600000, false],
		["openai/gpt-fixture", "automatic", undefined, false],
		["router/automatic", "unknown", undefined, false],
		["openai/gpt-fixture-contradictory", "unknown", undefined, true],
		["~openai/gpt-fixture", "automatic", undefined, false],
		["~openai/gpt-fixture-contradictory", "unknown", undefined, true],
	] as const) {
		const routed: Model<"openai-completions"> = {
			...model,
			id,
			provider: "openrouter",
			api: "openai-completions",
			...(contradictory ? { compat: { cacheControlFormat: "anthropic" as const } } : {}),
		};
		const result = await streamSimple(
			routed,
			{
				systemPrompt: "Read the provided context.",
				messages: [{ role: "user", content: "Read and answer.", timestamp: 1 }],
			},
			{
				apiKey: "offline-fixture-key",
				providerAccountKey: "request-account",
				cacheRetention: "long",
				transport: "sse",
				maxRetries: 0,
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage.cacheRead).toBe(900);
		expect(messageCachePolicy(result)).toMatchObject({ accountScope: "request-account", kind: expectedKind });
		expect(messageCachePolicy(result)?.ttlMs).toBe(ttlMs);
		guard.observeResponse(result, {
			sessionId: "owner",
			snapshot: undefined,
			openedAt: undefined,
			lineage: "root",
			holder: "owner",
		});
		expect(
			ledger.latestCacheObservation("owner", cacheLaneKey(routed.api, routed.provider, routed.id))?.cachePolicy,
		).toMatchObject({ accountScope: "request-account", kind: expectedKind });
	}
	expect(
		ledger
			.recentCacheObservations(cacheLaneKey("openai-completions", "openrouter", "anthropic/claude-fixture"), 10)
			.some((row) => row.measuredCachePolicy?.accountScope === "request-account"),
	).toBe(true);
	expect(bodies).toHaveLength(7);
	expect(JSON.stringify(bodies.at(-1))).toContain("cache_control");
	for (const body of bodies) {
		expect(body).not.toHaveProperty("providerAccountKey");
		expect(JSON.stringify(body)).not.toContain("request-account");
	}
});

it("treats explicit per-block hook breakpoints as distinct from disabled OpenAI caching", () => {
	const capture = { cacheControlFormat: "openai" as const };
	const disabled = providerCachePolicyFromPayload(model, { prompt_cache_options: { mode: "explicit" } }, capture);
	for (const field of ["messages", "input"]) {
		const payload = {
			prompt_cache_options: { mode: "explicit" },
			[field]: [{ role: "user", content: [{ type: "text", text: "Context", prompt_cache_breakpoint: true }] }],
		};
		const policy = providerCachePolicyFromPayload(model, payload, capture);
		expect(policy?.kind).toBe("unknown");
		expect(policy?.ttlMs).toBeUndefined();
		expect(policy?.wirePolicy).not.toBe(disabled?.wirePolicy);
	}
});
