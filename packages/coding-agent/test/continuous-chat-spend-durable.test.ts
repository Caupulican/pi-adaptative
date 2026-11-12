import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ContinuousChatAccountingBusy,
	ContinuousChatAccountingClaimWriteError,
	ContinuousChatAccountingUnresolved,
	ContinuousChatSpendMeter,
} from "../src/core/memory/continuous-chat-spend.ts";
import type { OwnerStanding } from "../src/kernel/reliability/owner-identity.ts";
import { type FaultableFs, nodeFs } from "../src/kernel/storage/faultable-fs.ts";

const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "pi-summary-spend-"));
	directories.push(dir);
	const file = join(dir, "spend.json");
	let now = Date.UTC(2026, 0, 1, 23, 59, 0);
	let standing: OwnerStanding = "alive";
	const owners = { own: () => ({ pid: 123, hostname: "test" }), judge: () => standing };
	const timers = { now: () => now, setTimeout: () => 0, clearTimeout: () => {} };
	const receipts = new Map<string, { costUsd: number; observedAtMs: number; pending: boolean }>();
	const identity = {
		sessionId: "session-a",
		sessionFile: join(dir, "session.jsonl"),
		headerTimestamp: "2026-01-01T00:00:00.000Z",
		persisted: true as const,
	};
	const journal = {
		requestRecovery: () => {},
		cancelUndispatched: (_identity: unknown, token: string) => {
			if (receipts.has(token)) throw new Error("known receipt cannot be cancelled");
		},
		read: (_identity: unknown, token: string) => {
			const receipt = receipts.get(token);
			return receipt
				? {
						kind: "known" as const,
						costUsd: receipt.costUsd,
						observedAtMs: receipt.observedAtMs,
						summarySpendPending: receipt.pending,
					}
				: { kind: "missing" as const };
		},
		acknowledge: (_identity: unknown, token: string) => {
			const receipt = receipts.get(token);
			if (receipt) receipt.pending = false;
		},
	};
	const meter = (fs?: FaultableFs) => {
		const instance = new ContinuousChatSpendMeter(file, () => 100, timers, owners, fs, journal);
		const claim = instance.claim.bind(instance);
		instance.claim = (key, identity) => {
			const token = claim(key, identity);
			instance.attempt(key, token);
			return token;
		};
		const settle = instance.settle.bind(instance);
		instance.settle = (key, token, healthy, cost, observed, physical) => {
			if (cost !== undefined && observed !== undefined)
				receipts.set(token, { costUsd: cost, observedAtMs: observed, pending: true });
			return settle(key, token, healthy, cost, observed, physical);
		};
		return instance;
	};
	return {
		file,
		meter,
		identity,
		receipts,
		journal,
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
		standing: (value: OwnerStanding) => {
			standing = value;
		},
	};
}
const key = "a".repeat(64);

describe("durable continuous-chat accounting", () => {
	it("fences other owners, reparks a dead owner, and admits exactly one recovery after cooldown", () => {
		const h = setup();
		const first = h.meter();
		const other = h.meter();
		const old = first.claim(key, h.identity);
		expect(other.accountingWait(key)).toBeGreaterThan(0);
		expect(() => other.claim(key, h.identity)).toThrow(ContinuousChatAccountingBusy);
		h.standing("unknown");
		expect(() => other.accountingWait(key)).toThrow(ContinuousChatAccountingUnresolved);
		expect(() => other.claim("b".repeat(64), h.identity)).toThrow(ContinuousChatAccountingUnresolved);
		h.standing("foreign");
		expect(() => other.accountingWait(key)).toThrow(ContinuousChatAccountingUnresolved);
		h.standing("dead");
		expect(() => other.accountingWait(key)).toThrow(ContinuousChatAccountingUnresolved);
		h.advance(120_000);
		expect(() => other.claim("b".repeat(64), h.identity)).toThrow(ContinuousChatAccountingUnresolved);
		h.receipts.set(old, { costUsd: 0.25, observedAtMs: h.now(), pending: true });
		expect(other.accountingWait(key)).toBe(120_000);
		h.advance(120_000);
		h.standing("alive");
		const recovery = other.claim(key, h.identity);
		first.settle(key, old, true, 99, h.now());
		expect(() => first.claim(key, h.identity)).toThrow(ContinuousChatAccountingBusy);
		other.settle(key, recovery, true, 2, h.now());
		expect(first.accountingWait(key)).toBe(0);
		expect(JSON.parse(readFileSync(h.file, "utf8")).usd).toBe(2.25);
	});
	it("reparks a dead reservation that never reached physical admission", () => {
		const h = setup();
		const meter = new ContinuousChatSpendMeter(
			h.file,
			() => 100,
			{ now: h.now, setTimeout: () => 0, clearTimeout: () => {} },
			{ own: () => ({ pid: 123, hostname: "test" }), judge: () => "dead" },
			undefined,
			h.journal,
		);
		const token = meter.claim(key, h.identity);
		expect(meter.accountingWait(key)).toBe(120_000);
		expect(() => meter.attempt(key, token)).toThrow();
		expect(JSON.parse(readFileSync(h.file, "utf8")).usd).toBe(0);
	});

	it("keeps a dead reservation fenced until journal cancellation succeeds", () => {
		const h = setup();
		let refuse = true;
		const journal = {
			...h.journal,
			cancelUndispatched: () => {
				if (refuse) throw new Error("journal unavailable");
			},
		};
		const timers = { now: h.now, setTimeout: () => 0, clearTimeout: () => {} };
		const owners = { own: () => ({ pid: 123, hostname: "test" }), judge: () => "dead" as const };
		const meter = new ContinuousChatSpendMeter(h.file, () => 100, timers, owners, undefined, journal);
		const token = meter.claim(key, h.identity);
		expect(() => meter.accountingWait(key)).toThrow("journal unavailable");
		expect(JSON.parse(readFileSync(h.file, "utf8")).circuits[key]).toMatchObject({ status: "reserved", token });
		refuse = false;
		expect(meter.accountingWait(key)).toBe(120_000);
	});

	it("keeps an ambiguously stamped but undispatched token until journal cancellation succeeds", () => {
		const h = setup();
		let refuse = true;
		const journal = {
			...h.journal,
			cancelUndispatched: () => {
				if (refuse) throw new Error("journal unavailable");
			},
		};
		const timers = { now: h.now, setTimeout: () => 0, clearTimeout: () => {} };
		const meter = new ContinuousChatSpendMeter(h.file, () => 100, timers, undefined, undefined, journal);
		const token = meter.claim(key, h.identity);
		meter.attempt(key, token);
		expect(() => meter.settle(key, token, false, undefined, undefined, false)).toThrow("journal unavailable");
		expect(JSON.parse(readFileSync(h.file, "utf8")).circuits[key]).toMatchObject({ status: "flight", token });
		refuse = false;
		meter.settle(key, token, false, undefined, undefined, false);
		expect(meter.accountingWait(key)).toBe(120_000);
	});

	it("counts a live owner's retained receipt before another key's cap decision", () => {
		const h = setup();
		const first = h.meter();
		const token = first.claim(key, h.identity);
		h.receipts.set(token, { costUsd: 100, observedAtMs: h.now(), pending: true });
		expect(() => h.meter().claim("b".repeat(64), h.identity)).toThrow(ContinuousChatAccountingBusy);
		expect(JSON.parse(readFileSync(h.file, "utf8")).usd).toBe(100);
		first.settle(key, token, true, 100, h.now());
		expect(JSON.parse(readFileSync(h.file, "utf8")).usd).toBe(100);
	});

	it("retains held claims at midnight and counts physical cost only once", () => {
		const h = setup();
		const meter = h.meter();
		const token = meter.claim(key, h.identity);
		meter.settle(key, token, false, 3, h.now());
		h.advance(60_000);
		expect(meter.accountingWait(key)).toBeGreaterThan(0);
		h.advance(60_000);
		const recovery = h.meter().claim(key, h.identity);
		meter.settle(key, recovery, true, 4, h.now());
		meter.settle(key, recovery, true, 4, h.now());
		const state = JSON.parse(readFileSync(h.file, "utf8"));
		expect(state.usd).toBe(4);
		expect(state.archivedMeasuredUsd).toBe(3);
		expect(state.circuits[key].status).toBe("settled");
	});
	it("keeps a claim fenced while state is unreadable and accepts settlement after recovery", () => {
		const h = setup();
		const first = h.meter();
		const other = h.meter();
		const token = first.claim(key, h.identity);
		const saved = `${h.file}.saved`;
		renameSync(h.file, saved);
		mkdirSync(h.file);
		expect(() => first.settle(key, token, true, 2, h.now())).toThrow();
		rmSync(h.file, { recursive: true });
		renameSync(saved, h.file);
		expect(() => other.claim(key, h.identity)).toThrow(ContinuousChatAccountingBusy);
		first.settle(key, token, true, 2, h.now());
		// The other admission already recovered the retained receipt conservatively.
		expect(other.accountingWait(key)).toBe(120_000);
		expect(JSON.parse(readFileSync(h.file, "utf8")).usd).toBe(2);
	});

	it("counts once when replacement commits but reports an error before acknowledgment", () => {
		const h = setup();
		let failAfterRename = false;
		const fs: FaultableFs = {
			...nodeFs,
			renameSync: (from, to) => {
				nodeFs.renameSync(from, to);
				if (failAfterRename) {
					failAfterRename = false;
					throw new Error("ambiguous replacement");
				}
			},
		};
		const meter = h.meter(fs);
		const token = meter.claim(key, h.identity);
		failAfterRename = true;
		expect(() => meter.settle(key, token, true, 2, h.now())).toThrow("ambiguous replacement");
		meter.settle(key, token, true, 2, h.now());
		expect(JSON.parse(readFileSync(h.file, "utf8")).usd).toBe(2);
	});

	it("recovers after semantic acknowledgment succeeds but meter cleanup fails", () => {
		const h = setup();
		let failCleanup = false;
		const fs: FaultableFs = {
			...nodeFs,
			renameSync: (from, to) => {
				if (failCleanup) {
					failCleanup = false;
					throw new Error("cleanup write unavailable");
				}
				nodeFs.renameSync(from, to);
			},
		};
		const journal = {
			...h.journal,
			acknowledge: (identity: unknown, token: string) => {
				h.journal.acknowledge(identity, token);
				failCleanup = true;
			},
		};
		const meter = new ContinuousChatSpendMeter(
			h.file,
			() => 100,
			{ now: h.now, setTimeout: () => 0, clearTimeout: () => {} },
			undefined,
			fs,
			journal,
		);
		const token = meter.claim(key, h.identity);
		meter.attempt(key, token);
		h.receipts.set(token, { costUsd: 2, observedAtMs: h.now(), pending: true });
		expect(() => meter.settle(key, token, true, 2, h.now())).toThrow("cleanup write unavailable");
		expect(JSON.parse(readFileSync(h.file, "utf8")).usd).toBe(2);
		expect(h.meter().accountingWait(key)).toBe(0);
		const recovered = JSON.parse(readFileSync(h.file, "utf8"));
		expect(recovered.usd).toBe(2);
		expect(recovered.circuits[key].pendingAck).toBeUndefined();
	});

	it("retains the attempted token when an admission replacement commits before reporting failure", () => {
		const h = setup();
		let failAfterRename = true;
		const fs: FaultableFs = {
			...nodeFs,
			renameSync: (from, to) => {
				nodeFs.renameSync(from, to);
				if (failAfterRename) {
					failAfterRename = false;
					throw new Error("ambiguous claim");
				}
			},
		};
		const meter = h.meter(fs);
		let error: unknown;
		try {
			meter.claim(key, h.identity);
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(ContinuousChatAccountingClaimWriteError);
		meter.settle(key, (error as ContinuousChatAccountingClaimWriteError).token, false, undefined, undefined, false);
		expect(h.meter().accountingWait(key)).toBeGreaterThan(0);
	});
	it("migrates legacy spend on the next write and rejects corrupt evidence", () => {
		const h = setup();
		writeFileSync(h.file, JSON.stringify({ day: "2026-01-01", usd: 5 }));
		const meter = h.meter();
		const token = meter.claim(key, h.identity);
		meter.settle(key, token, true, 1, h.now());
		const migrated = JSON.parse(readFileSync(h.file, "utf8"));
		expect(migrated).toMatchObject({ schemaVersion: 3, usd: 6, archivedMeasuredUsd: 0 });
		writeFileSync(h.file, "{broken");
		expect(() => meter.claim(key, h.identity)).toThrow();
		expect(readFileSync(h.file, "utf8")).toBe("{broken");
		writeFileSync(h.file, JSON.stringify({ schemaVersion: 4, day: "2026-01-01", usd: 0, circuits: {} }));
		const unknownVersion = readFileSync(h.file, "utf8");
		expect(() => meter.claim(key, h.identity)).toThrow();
		expect(readFileSync(h.file, "utf8")).toBe(unknownVersion);
	});

	it("migrates schema 1 and rejects malformed schema 2 without replacing evidence", () => {
		const h = setup();
		writeFileSync(h.file, JSON.stringify({ schemaVersion: 1, day: "2026-01-01", usd: 5, circuits: {} }));
		const meter = h.meter();
		const token = meter.claim(key, h.identity);
		meter.settle(key, token, true, 1, h.now());
		expect(JSON.parse(readFileSync(h.file, "utf8"))).toMatchObject({
			schemaVersion: 3,
			usd: 6,
			archivedMeasuredUsd: 0,
		});
		const invalidStates = [
			{ schemaVersion: 2, day: "2026-01-01", usd: 1, circuits: {} },
			{ schemaVersion: 2, day: "2026-01-01", usd: 1, archivedMeasuredUsd: -1, circuits: {} },
			{ schemaVersion: 2, day: "2026-01-01", usd: 1, archivedMeasuredUsd: 0, circuits: {}, extra: true },
			{ day: "2026-01-01", usd: 1, extra: true },
			{ schemaVersion: 1, day: "2026-01-01", usd: 1, circuits: {}, extra: true },
			{
				schemaVersion: 2,
				day: "2026-01-01",
				usd: 1,
				archivedMeasuredUsd: 0,
				circuits: {
					[key]: { status: "settled", token: "-".repeat(36) },
				},
			},
		];
		for (const invalid of invalidStates) {
			const evidence = JSON.stringify(invalid);
			writeFileSync(h.file, evidence);
			expect(() => meter.claim(key, h.identity)).toThrow();
			expect(readFileSync(h.file, "utf8")).toBe(evidence);
		}
	});

	it("refuses backward clock movement without erasing or re-dating recorded spend", () => {
		const h = setup();
		const meter = h.meter();
		const first = meter.claim(key, h.identity);
		meter.settle(key, first, true, 3, h.now());
		h.advance(60_000);
		const second = meter.claim(key, h.identity);
		meter.settle(key, second, true, 4, h.now());
		const before = readFileSync(h.file, "utf8");
		h.advance(-60_000);
		expect(() => meter.claim("b".repeat(64), h.identity)).toThrow("clock moved before");
		expect(readFileSync(h.file, "utf8")).toBe(before);
		h.advance(60_000);
		expect(meter.accountingWait(key)).toBe(0);
	});

	it("keeps the physical claim until an observation timestamp ahead of the clock becomes current", () => {
		const h = setup();
		const meter = h.meter();
		const token = meter.claim(key, h.identity);
		const before = readFileSync(h.file, "utf8");
		const observedAt = h.now() + 1000;
		expect(() => meter.settle(key, token, true, 1, observedAt)).toThrow(
			"clock moved before the response observation",
		);
		expect(readFileSync(h.file, "utf8")).toBe(before);
		h.advance(1000);
		meter.settle(key, token, true, 1, observedAt);
		expect(JSON.parse(readFileSync(h.file, "utf8")).usd).toBe(1);
	});

	it("rechecks the daily spend limit while claiming a different identity", () => {
		const h = setup();
		const meter = h.meter();
		const token = meter.claim(key, h.identity);
		meter.settle(key, token, true, 100, h.now());
		expect(() => h.meter().claim("b".repeat(64), h.identity)).toThrow(ContinuousChatAccountingBusy);
	});

	it("prunes only expired holds when circuit capacity is exhausted", () => {
		const h = setup();
		const until = Date.UTC(2026, 0, 2, 0, 1, 0);
		const circuits = Object.fromEntries(
			Array.from({ length: 256 }, (_, index) => [
				index.toString(16).padStart(64, "0"),
				{ status: "held", token: "11111111-1111-1111-1111-111111111111", until },
			]),
		);
		writeFileSync(
			h.file,
			JSON.stringify({ schemaVersion: 2, day: "2026-01-01", usd: 1, archivedMeasuredUsd: 3, circuits }),
		);
		expect(() => h.meter().claim(key, h.identity)).toThrow("full of active or held requests");
		h.advance(120_000);
		expect(h.meter().claim(key, h.identity)).toEqual(expect.any(String));
		expect(JSON.parse(readFileSync(h.file, "utf8"))).toMatchObject({ usd: 1, archivedMeasuredUsd: 3 });
	});
});
