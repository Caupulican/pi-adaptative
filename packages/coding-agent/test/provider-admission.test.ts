import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@caupulican/pi-agent-core";
import { classifyFailure } from "@caupulican/pi-agent-core/reliability";
import { type Api, createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	describeProviderAccountKey,
	providerAccountKey,
	splitProviderAccountKey,
} from "../src/core/provider-admission/account-key.ts";
import {
	emergencyStopPath,
	engageEmergencyStop,
	isEmergencyStopEngaged,
	liftEmergencyStop,
	readEmergencyStop,
} from "../src/core/provider-admission/emergency-stop.ts";
import {
	admitProviderRequest,
	EmergencyStopError,
	type ProviderAdmissionPolicy,
	type ProviderAdmissionWaitRecord,
	withProviderAdmission,
} from "../src/core/provider-admission/gate.ts";
import {
	currentProviderLane,
	providerLaneForIsolatedLaneKind,
	runInProviderLane,
} from "../src/core/provider-admission/lane-context.ts";
import { ProviderAdmissionLedger, providerAdmissionDir } from "../src/core/provider-admission/ledger.ts";
import {
	observeProviderResult,
	ProviderLimitedError,
	ProviderLimitStore,
	providerLimitFromFailure,
	usageWindowLimit,
} from "../src/core/provider-admission/limit-state.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-provider-admission-"));
	tempDirs.push(dir);
	return dir;
}

function entryFiles(dir: string): string[] {
	return readdirSync(providerAdmissionDir(dir)).filter((name) => name.endsWith(".json"));
}

describe("ProviderAdmissionLedger", () => {
	it("counts live holds per provider and forgets released ones", () => {
		const dir = agentDir();
		const ledger = new ProviderAdmissionLedger(dir, { heartbeatMs: 60_000 });
		const a = ledger.acquire("openai-codex", "foreground");
		const b = ledger.acquire("openai-codex", "worker");
		ledger.acquire("xai", "worker");
		expect(ledger.countInflight("openai-codex")).toEqual({
			total: 2,
			byLane: { foreground: 1, worker: 1, background: 0 },
		});
		expect(ledger.countInflight("xai").total).toBe(1);
		a.release();
		a.release();
		expect(ledger.countInflight("openai-codex").total).toBe(1);
		b.release();
		expect(ledger.countInflight("openai-codex").total).toBe(0);
		expect(entryFiles(dir)).toHaveLength(1);
	});

	it("prunes entries whose owner process is dead, whose heartbeat is stale, or which are corrupt", () => {
		const dir = agentDir();
		let now = 1_000_000;
		const alive = new Set<number>([process.pid, 4242]);
		const ledger = new ProviderAdmissionLedger(dir, {
			now: () => now,
			isProcessAlive: (pid) => alive.has(pid),
			heartbeatMs: 60_000,
			staleMs: 1_000,
		});
		ledger.acquire("openai-codex", "worker");
		const stateDir = providerAdmissionDir(dir);
		const stamp = new Date(now).toISOString();
		const entry = (id: string, pid: number, heartbeatAt = stamp) =>
			JSON.stringify({ id, provider: "openai-codex", lane: "worker", pid, startedAt: stamp, heartbeatAt });
		writeFileSync(join(stateDir, "dead.json"), entry("dead", 999_999));
		writeFileSync(join(stateDir, "other-alive.json"), entry("other-alive", 4242));
		writeFileSync(join(stateDir, "stale.json"), entry("stale", 4242, new Date(now - 5_000).toISOString()));
		writeFileSync(join(stateDir, "corrupt.json"), "{not json");

		expect(ledger.countInflight("openai-codex").total).toBe(2);
		expect(entryFiles(dir).sort()).toEqual(expect.arrayContaining(["other-alive.json"]));
		expect(entryFiles(dir)).toHaveLength(2);

		// The sibling stops heartbeating: after the stale window it no longer counts.
		now += 5_000;
		expect(ledger.countInflight("openai-codex").total).toBe(0);
	});

	it("decides and registers under one lock so the last free slot is taken exactly once", () => {
		const dir = agentDir();
		const ledger = new ProviderAdmissionLedger(dir, { heartbeatMs: 60_000 });
		const first = ledger.tryAcquire("openai-codex", "worker", 1);
		expect(first.hold).toBeDefined();
		expect(first.inflight).toBe(0);
		const second = ledger.tryAcquire("openai-codex", "worker", 1);
		expect(second.hold).toBeUndefined();
		expect(second.inflight).toBe(1);
		first.hold?.release();
		expect(ledger.tryAcquire("openai-codex", "worker", 1).hold).toBeDefined();
	});
});

describe("admitProviderRequest", () => {
	const policy = (overrides: Partial<ProviderAdmissionPolicy> = {}): ProviderAdmissionPolicy => ({
		enabled: true,
		limits: { "openai-codex": 1 },
		maxWaitMs: 10_000,
		foregroundLimitWaitMs: 60_000,
		...overrides,
	});

	it("admits the foreground at once even when the provider is at its limit", async () => {
		const dir = agentDir();
		const ledger = new ProviderAdmissionLedger(dir, { heartbeatMs: 60_000 });
		ledger.acquire("openai-codex", "worker");
		const slept: number[] = [];
		const release = await admitProviderRequest("openai-codex", {
			ledger,
			getPolicy: () => policy(),
			getLane: () => "foreground",
			sleep: async (ms) => {
				slept.push(ms);
			},
		});
		expect(slept).toEqual([]);
		expect(ledger.countInflight("openai-codex").total).toBe(2);
		release();
		expect(ledger.countInflight("openai-codex").total).toBe(1);
	});

	it("makes a worker wait for a slot and records the wait", async () => {
		const dir = agentDir();
		let now = 0;
		const ledger = new ProviderAdmissionLedger(dir, { heartbeatMs: 60_000, now: () => now });
		const owner = ledger.acquire("openai-codex", "foreground");
		const records: ProviderAdmissionWaitRecord[] = [];
		let sleeps = 0;
		const release = await admitProviderRequest("openai-codex", {
			ledger,
			getPolicy: () => policy(),
			getLane: () => "worker",
			now: () => now,
			record: (record) => records.push(record),
			sleep: async (ms) => {
				sleeps += 1;
				now += ms;
				if (sleeps === 2) owner.release();
			},
		});
		expect(sleeps).toBe(2);
		expect(records).toEqual([
			{
				provider: "openai-codex",
				lane: "worker",
				reason: "capacity",
				limit: 1,
				inflightAtStart: 1,
				inflightAtAdmission: 0,
				waitedMs: 750,
				timedOut: false,
			},
		]);
		expect(ledger.countInflight("openai-codex").byLane.worker).toBe(1);
		release();
	});

	it("admits a worker regardless after the wait budget and marks the record timedOut", async () => {
		const dir = agentDir();
		let now = 0;
		const ledger = new ProviderAdmissionLedger(dir, { heartbeatMs: 60_000, now: () => now });
		ledger.acquire("openai-codex", "foreground");
		const records: ProviderAdmissionWaitRecord[] = [];
		const release = await admitProviderRequest("openai-codex", {
			ledger,
			getPolicy: () => policy({ maxWaitMs: 1_000 }),
			getLane: () => "background",
			now: () => now,
			record: (record) => records.push(record),
			sleep: async (ms) => {
				now += ms;
			},
		});
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ lane: "background", timedOut: true, inflightAtAdmission: 1 });
		expect(records[0]!.waitedMs).toBeGreaterThanOrEqual(1_000);
		expect(ledger.countInflight("openai-codex").total).toBe(2);
		release();
	});

	it("rejects with the abort reason while waiting and leaves no entry behind", async () => {
		const dir = agentDir();
		const ledger = new ProviderAdmissionLedger(dir, { heartbeatMs: 60_000 });
		ledger.acquire("openai-codex", "foreground");
		const controller = new AbortController();
		const reason = new Error("send now");
		await expect(
			admitProviderRequest(
				"openai-codex",
				{
					ledger,
					getPolicy: () => policy(),
					getLane: () => "worker",
					sleep: async () => {
						controller.abort(reason);
					},
				},
				controller.signal,
			),
		).rejects.toBe(reason);
		expect(ledger.countInflight("openai-codex").total).toBe(1);
	});

	it("never waits for an unbounded provider or when admission is disabled", async () => {
		const dir = agentDir();
		const ledger = new ProviderAdmissionLedger(dir, { heartbeatMs: 60_000 });
		ledger.acquire("xai", "foreground");
		ledger.acquire("xai", "foreground");
		const release = await admitProviderRequest("xai", {
			ledger,
			getPolicy: () => policy(),
			getLane: () => "worker",
			sleep: async () => {
				throw new Error("must not sleep");
			},
		});
		expect(ledger.countInflight("xai").total).toBe(3);
		release();
		const disabled = await admitProviderRequest("openai-codex", {
			ledger,
			getPolicy: () => policy({ enabled: false }),
			getLane: () => "worker",
		});
		expect(ledger.countInflight("openai-codex").total).toBe(0);
		disabled();
	});
});

describe("withProviderAdmission", () => {
	const model = { api: "faux", provider: "openai-codex", id: "faux-1" } as Model<Api>;

	it("holds the entry for the life of the stream and releases it when the result settles", async () => {
		const dir = agentDir();
		const ledger = new ProviderAdmissionLedger(dir, { heartbeatMs: 60_000 });
		const inner = createAssistantMessageEventStream();
		const streamFn: StreamFn = () => inner;
		const wrapped = withProviderAdmission(streamFn, {
			ledger,
			getPolicy: () => ({ enabled: true, limits: {}, maxWaitMs: 1_000, foregroundLimitWaitMs: 60_000 }),
			getLane: () => "worker",
		});
		const stream = await wrapped(model, { systemPrompt: "", messages: [], tools: [] }, {});
		expect(stream).toBe(inner);
		expect(ledger.countInflight("openai-codex").total).toBe(1);
		inner.end(fauxAssistantMessage("done"));
		await stream.result();
		await Promise.resolve();
		expect(ledger.countInflight("openai-codex").total).toBe(0);
	});

	it("releases the entry when the inner stream function throws", async () => {
		const dir = agentDir();
		const ledger = new ProviderAdmissionLedger(dir, { heartbeatMs: 60_000 });
		const wrapped = withProviderAdmission(
			() => {
				throw new Error("connect failed");
			},
			{ ledger, getPolicy: () => ({ enabled: true, limits: {}, maxWaitMs: 1_000, foregroundLimitWaitMs: 60_000 }) },
		);
		await expect(wrapped(model, { systemPrompt: "", messages: [], tools: [] }, {})).rejects.toThrow("connect failed");
		expect(ledger.countInflight("openai-codex").total).toBe(0);
	});
});

describe("provider lane context", () => {
	it("defaults to the foreground and follows async continuations inside a lane", async () => {
		expect(currentProviderLane()).toBe("foreground");
		const seen = await runInProviderLane("worker", async () => {
			await Promise.resolve();
			return currentProviderLane();
		});
		expect(seen).toBe("worker");
		expect(currentProviderLane()).toBe("foreground");
	});

	it("maps isolated lane kinds onto admission lanes", () => {
		expect(providerLaneForIsolatedLaneKind("worker")).toBe("worker");
		expect(providerLaneForIsolatedLaneKind("worker-compaction")).toBe("worker");
		expect(providerLaneForIsolatedLaneKind("reflection")).toBe("background");
		expect(providerLaneForIsolatedLaneKind(undefined)).toBe("background");
	});
});

describe("ProviderLimitStore", () => {
	it("records the later reset, expires on read, clears only matching reasons and lists live limits", () => {
		const dir = agentDir();
		let now = 1_000_000;
		const store = new ProviderLimitStore(dir, { now: () => now, pid: 4242, sessionId: "s1" });
		expect(store.read("openai-codex")).toBeUndefined();
		const first = store.record("openai-codex", {
			limitedUntil: now + 30_000,
			reason: "rate_limit",
			detail: "429 slow down",
		});
		expect(first).toMatchObject({ provider: "openai-codex", reason: "rate_limit", pid: 4242, sessionId: "s1" });
		// An earlier reset never shortens a live record; a later one replaces it.
		expect(store.record("openai-codex", { limitedUntil: now + 10_000, reason: "overloaded" }).limitedUntil).toBe(
			now + 30_000,
		);
		expect(store.record("openai-codex", { limitedUntil: now + 90_000, reason: "usage_window" }).reason).toBe(
			"usage_window",
		);
		expect(store.clear("openai-codex", ["rate_limit", "overloaded"])).toBe(false);
		expect(store.list().map((r) => r.provider)).toEqual(["openai-codex"]);
		expect(store.clear("openai-codex")).toBe(true);
		store.record("xai", { limitedUntil: now + 5_000, reason: "rate_limit" });
		now += 5_001;
		expect(store.read("xai")).toBeUndefined();
		expect(store.list()).toEqual([]);
	});

	it("derives a limit only from a rate limit or overload with a known reset", () => {
		const now = 5_000;
		expect(providerLimitFromFailure("xai", "429 Too Many Requests; retry after 12 seconds", now)).toMatchObject({
			reason: "rate_limit",
			limitedUntil: now + 12_000,
		});
		// A bare overload publishes nothing on its own; the retry policy's chosen delay does.
		expect(providerLimitFromFailure("xai", "Provider overloaded", now)).toBeUndefined();
		expect(providerLimitFromFailure("xai", "Provider overloaded", now, 2_000)).toMatchObject({
			reason: "overloaded",
			limitedUntil: now + 2_000,
		});
		expect(providerLimitFromFailure("xai", "Connection error. [fetch failed]", now, 2_000)).toBeUndefined();
	});
	it("turns a fully used Codex window into a usage_window limit and persists the snapshots", () => {
		const dir = agentDir();
		const now = 1_700_000_000_000;
		const store = new ProviderLimitStore(dir, { now: () => now });
		const rateLimits = [
			{
				limitId: "codex",
				limitName: "codex",
				primary: { usedPercent: 100, windowMinutes: 300, resetsAt: Math.floor(now / 1000) + 3_600 },
				secondary: { usedPercent: 40, windowMinutes: 10_080 },
			},
		];
		expect(usageWindowLimit(rateLimits, now)).toMatchObject({ limitedUntil: now + 3_600_000 });
		expect(usageWindowLimit([{ limitId: "codex", primary: { usedPercent: 99 } }], now)).toBeUndefined();
		observeProviderResult(
			store,
			{
				...fauxAssistantMessage("ok"),
				provider: "openai-codex",
				diagnostics: [{ type: "openai_codex_subscription_rate_limits", timestamp: now, details: { rateLimits } }],
			},
			now,
		);
		expect(store.read("openai-codex")).toMatchObject({ reason: "usage_window", limitedUntil: now + 3_600_000 });
		expect(store.readUsage("openai-codex")?.rateLimits).toEqual(rateLimits);
	});

	it("records a limit from a rate-limited result that states its reset and clears it on the next success", () => {
		const dir = agentDir();
		const now = 10_000;
		const store = new ProviderLimitStore(dir, { now: () => now });
		const failed = (errorMessage: string) => ({
			...fauxAssistantMessage(""),
			provider: "xai",
			stopReason: "error" as const,
			errorMessage,
		});
		observeProviderResult(store, failed("429 rate limit exceeded"), now);
		expect(store.read("xai")).toBeUndefined();
		observeProviderResult(store, failed("429 rate limit; retry after 45 seconds"), now);
		expect(store.read("xai")).toMatchObject({ reason: "rate_limit", limitedUntil: now + 45_000 });
		observeProviderResult(store, { ...fauxAssistantMessage("served"), provider: "xai" }, now);
		expect(store.read("xai")).toBeUndefined();
	});
});

describe("admission against a recorded provider limit", () => {
	const policy: ProviderAdmissionPolicy = {
		enabled: true,
		limits: {},
		maxWaitMs: 10_000,
		foregroundLimitWaitMs: 60_000,
	};

	it("waits out a short limit in every lane and records the wait", async () => {
		const dir = agentDir();
		let now = 0;
		const ledger = new ProviderAdmissionLedger(dir, { heartbeatMs: 60_000, now: () => now });
		const limits = new ProviderLimitStore(dir, { now: () => now, pid: 99 });
		limits.record("xai", { limitedUntil: 4_000, reason: "rate_limit" });
		const records: ProviderAdmissionWaitRecord[] = [];
		const slept: number[] = [];
		const release = await admitProviderRequest("xai", {
			ledger,
			limits,
			getPolicy: () => policy,
			getLane: () => "worker",
			now: () => now,
			record: (record) => records.push(record),
			sleep: async (ms) => {
				slept.push(ms);
				now += ms;
			},
		});
		expect(slept).toEqual([4_000]);
		expect(records).toEqual([
			expect.objectContaining({
				reason: "provider_limit",
				lane: "worker",
				waitedMs: 4_000,
				timedOut: false,
				limitedUntil: 4_000,
			}),
		]);
		expect(ledger.countInflight("xai").total).toBe(1);
		release();
	});

	it("refuses without sending when the limit outlasts the lane's budget, in a form the classifier reads as a rate limit", async () => {
		const dir = agentDir();
		const ledger = new ProviderAdmissionLedger(dir, { heartbeatMs: 60_000, now: () => 0 });
		const limits = new ProviderLimitStore(dir, { now: () => 0, pid: 7 });
		limits.record("openai-codex", {
			limitedUntil: 3_600_000,
			reason: "usage_window",
			detail: "codex primary window 100% used",
		});
		const records: ProviderAdmissionWaitRecord[] = [];
		let thrown: unknown;
		try {
			await admitProviderRequest("openai-codex", {
				ledger,
				limits,
				getPolicy: () => policy,
				getLane: () => "foreground",
				now: () => 0,
				record: (record) => records.push(record),
				sleep: async () => {
					throw new Error("must not sleep");
				},
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ProviderLimitedError);
		const message = (thrown as Error).message;
		const classified = classifyFailure({ message, provider: "openai-codex" });
		expect(classified.reason).toBe("rate_limit");
		expect(classified.retryAfterMs).toBe(3_600_000);
		expect(message).toContain("recorded by pid 7");
		expect(records).toEqual([expect.objectContaining({ reason: "provider_limit", timedOut: true, waitedMs: 0 })]);
		expect(ledger.countInflight("openai-codex").total).toBe(0);
	});
});

describe("emergency stop", () => {
	it("engages, reads, lifts, and counts an unreadable sentinel as engaged", () => {
		const dir = agentDir();
		expect(isEmergencyStopEngaged(dir)).toBe(false);
		expect(readEmergencyStop(dir)).toMatchObject({ engaged: false, path: emergencyStopPath(dir) });
		const engaged = engageEmergencyStop(dir, "account hammered", () => 1_700_000_000_000);
		expect(engaged).toMatchObject({
			engaged: true,
			reason: "account hammered",
			engagedAt: "2023-11-14T22:13:20.000Z",
		});
		expect(readEmergencyStop(dir)).toMatchObject({ engaged: true, reason: "account hammered" });
		writeFileSync(emergencyStopPath(dir), "");
		expect(readEmergencyStop(dir)).toMatchObject({ engaged: true });
		expect(liftEmergencyStop(dir)).toBe(true);
		expect(liftEmergencyStop(dir)).toBe(false);
		expect(isEmergencyStopEngaged(dir)).toBe(false);
	});

	it("holds worker and background lanes while engaged, never the foreground, and refuses after the wait budget", async () => {
		const dir = agentDir();
		let now = 0;
		let engaged = true;
		const ledger = new ProviderAdmissionLedger(dir, { heartbeatMs: 60_000, now: () => now });
		const policy: ProviderAdmissionPolicy = {
			enabled: true,
			limits: {},
			maxWaitMs: 5_000,
			foregroundLimitWaitMs: 60_000,
		};
		const records: ProviderAdmissionWaitRecord[] = [];
		const deps = (lane: "foreground" | "worker") => ({
			ledger,
			getPolicy: () => policy,
			getLane: () => lane,
			isEmergencyStopEngaged: () => engaged,
			now: () => now,
			record: (record: ProviderAdmissionWaitRecord) => records.push(record),
			sleep: async (ms: number) => {
				now += ms;
				if (now >= 4_000) engaged = false;
			},
		});
		(await admitProviderRequest("xai", deps("foreground")))();
		expect(records).toEqual([]);
		(await admitProviderRequest("xai", deps("worker")))();
		expect(records).toEqual([expect.objectContaining({ reason: "emergency_stop", lane: "worker", timedOut: false })]);
		expect(records[0]!.waitedMs).toBeGreaterThanOrEqual(4_000);

		engaged = true;
		now = 0;
		const stuck = {
			...deps("worker"),
			sleep: async (ms: number) => {
				now += ms;
			},
		};
		await expect(admitProviderRequest("xai", stuck)).rejects.toBeInstanceOf(EmergencyStopError);
		expect(ledger.countInflight("xai").total).toBe(0);
	});
});

describe("provider account keys", () => {
	it("derives a non-secret identity from each credential shape and keys per account", () => {
		expect(providerAccountKey("xai", undefined)).toBe("xai");
		expect(
			providerAccountKey("openai-codex", {
				type: "oauth",
				access: "a.b.c",
				refresh: "r",
				expires: 1,
				accountId: "acct-1",
			} as never),
		).toBe("openai-codex#acct-1");
		const payload = Buffer.from(JSON.stringify({ sub: "user-77" })).toString("base64url");
		expect(
			providerAccountKey("xai", { type: "oauth", access: `h.${payload}.s`, refresh: "r", expires: 1 } as never),
		).toBe("xai#user-77");
		const keyed = providerAccountKey("openrouter", { type: "api_key", key: "sk-secret-value" });
		expect(keyed).toMatch(/^openrouter#[0-9a-f]{12}$/);
		expect(keyed).not.toContain("secret");
		expect(splitProviderAccountKey("openai-codex#acct-1")).toEqual({
			key: "openai-codex#acct-1",
			provider: "openai-codex",
			account: "acct-1",
		});
		expect(describeProviderAccountKey("openai-codex#9dcc3287-3098-4604")).toBe("openai-codex (account 9dcc3287…)");
		expect(describeProviderAccountKey("xai")).toBe("xai");
	});

	it("counts and limits per account, not per provider", async () => {
		const dir = agentDir();
		const ledger = new ProviderAdmissionLedger(dir, { heartbeatMs: 60_000 });
		const limits = new ProviderLimitStore(dir, { now: () => 0 });
		const accounts: Record<string, string> = { "openai-codex": "openai-codex#acct-A" };
		const policy: ProviderAdmissionPolicy = {
			enabled: true,
			limits: { "openai-codex": 1 },
			maxWaitMs: 1_000,
			foregroundLimitWaitMs: 60_000,
		};
		ledger.acquire("openai-codex#acct-B", "worker");
		limits.record("openai-codex#acct-B", { limitedUntil: 3_600_000, reason: "usage_window" });
		// Account A is neither at its cap nor limited even though account B on the same provider is both.
		const release = await admitProviderRequest("openai-codex", {
			ledger,
			limits,
			getPolicy: () => policy,
			getLane: () => "worker",
			getAccountKey: (provider) => accounts[provider] ?? provider,
			now: () => 0,
			sleep: async () => {
				throw new Error("must not wait");
			},
		});
		expect(ledger.countInflight("openai-codex#acct-A").total).toBe(1);
		expect(
			ledger
				.listInflight()
				.map((entry) => [entry.provider, entry.account, entry.lane])
				.sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
		).toEqual([
			["openai-codex", "acct-A", "worker"],
			["openai-codex", "acct-B", "worker"],
		]);
		release();
	});
});
