import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@caupulican/pi-agent-core";
import { type Api, createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	admitProviderRequest,
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
			getPolicy: () => ({ enabled: true, limits: {}, maxWaitMs: 1_000 }),
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
			{ ledger, getPolicy: () => ({ enabled: true, limits: {}, maxWaitMs: 1_000 }) },
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
