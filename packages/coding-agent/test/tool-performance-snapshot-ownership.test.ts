import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolPerformanceStore } from "../src/core/tool-selection/tool-performance-store.ts";

const key = { modelRef: "faux/model", intentClass: "read" as const, tool: "read" };
const host = { id: "fixture", cpu: "fixture", cores: 2, totalMemGb: 8 };
const selection = {
	firstTool: true,
	disposition: "abstain" as const,
	shortlist: [],
	ranked: [],
	entropy: 0,
	margin: 0,
};
type RecordWithMetadata = { sampleCount: number; extra: { payload: string } };
type FileWithMetadata = {
	hosts: {
		fixture: { stats: Record<string, RecordWithMetadata>; intentAgreement: Record<string, RecordWithMetadata> };
	};
};

describe("aggregate evidence snapshot ownership", () => {
	it.each(["batched", "direct", "read-only"] as const)(
		"preserves filtered values and caller-owned arrays across %s reads and replay",
		(mode) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-snapshot-values-"));
			const path = join(dir, "state", "tool-performance.json");
			const seed = ToolPerformanceStore.forAgentDir(dir, { fingerprint: () => host });
			const store = ToolPerformanceStore.forAgentDir(dir, {
				fingerprint: () => host,
				readOnly: mode === "read-only",
				writeBehind: mode === "batched" ? {} : undefined,
			});
			try {
				for (const modelRef of ["faux/model", "faux/other"]) {
					for (const intentClass of ["read", "search"] as const) {
						seed.recordExecution({
							key: { ...key, modelRef, intentClass },
							success: true,
							latencyMs: 3,
							at: "2026-09-17T00:00:00Z",
							selection: {
								...selection,
								shortlist: ["read", "search"],
								ranked: [{ tool: "read", utility: 0.5, probability: 1 }],
							},
						});
					}
				}
				const fixture = JSON.parse(readFileSync(path, "utf8")) as {
					hosts: {
						fixture: {
							observations: ReturnType<ToolPerformanceStore["getObservations"]>;
							stats: Record<string, ReturnType<ToolPerformanceStore["get"]>>;
							intentAgreement: Record<string, ReturnType<ToolPerformanceStore["getIntentAgreement"]>>;
						};
					};
				};
				const persisted = fixture.hosts.fixture;
				const stats = Object.values(persisted.stats);
				const agreements = Object.values(persisted.intentAgreement);
				expect(store.getStatsForModel(key.modelRef)).toEqual(stats.slice(0, 2));
				expect(store.getStatsForIntent(key.modelRef, "read")).toEqual(stats.slice(0, 1));
				expect(store.getAllIntentAgreements(key.modelRef)).toEqual(agreements.slice(0, 2));
				expect(store.getAllIntentAgreements()).toEqual(agreements);
				expect(store.getIntentAgreement(key.modelRef, "read")).toEqual(agreements[0]);
				expect(store.get(key)).toEqual(stats[0]);
				expect(store.getObservations()).toEqual(persisted.observations);
				expect(store.getObservations("absent")).toEqual([]);
				expect(store.getStatsForModel("absent")).toEqual([]);
				expect(store.getStatsForIntent("absent", "read")).toEqual([]);
				expect(store.getAllIntentAgreements("absent")).toEqual([]);
				store.recordValidation(key, "repaired");
				const logs = store.getObservations(key.modelRef);
				expect(logs).toEqual(persisted.observations.slice(0, 2));
				logs[0].ranked[0].tool = "changed";
				logs[0].shortlist.push("changed");
				logs.reverse();
				logs.pop();
				seed.recordValidation(key, "bounced");
				store.flush();
				expect(store.getObservations()).toEqual(persisted.observations);
				expect(seed.getObservations()).toEqual(persisted.observations);
				logs[0].shortlist.push("after flush");
				expect(store.getObservations()).toEqual(persisted.observations);
				expect(store.get(key).repairCount).toBe(mode === "read-only" ? 0 : 1);
				expect(store.get(key).bounceCount).toBe(1);
			} finally {
				store.close();
				seed.close();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	for (const mutate of [false, true]) {
		it.each(["observation", "ranking"] as const)(
			`isolates loaded %s metadata in returned logs (mutate=${mutate})`,
			(location) => {
				const dir = mkdtempSync(join(tmpdir(), "pi-observation-snapshot-"));
				const path = join(dir, "state", "tool-performance.json");
				const store = ToolPerformanceStore.forAgentDir(dir, { fingerprint: () => host, writeBehind: {} });
				type Metadata = { extra?: { payload: string } };
				type Log = Metadata & { ranked: Metadata[] };
				try {
					store.recordExecution({
						key,
						success: true,
						latencyMs: 1,
						selection: { ...selection, ranked: [{ tool: "read", utility: 1, probability: 1 }] },
					});
					store.flush();
					const file = JSON.parse(readFileSync(path, "utf8")) as {
						hosts: { fixture: { observations: Log[] } };
					};
					const log = file.hosts.fixture.observations[0];
					(location === "observation" ? log : log.ranked[0]).extra = { payload: "original" };
					writeFileSync(path, JSON.stringify(file));
					store.recordValidation(key, "repaired");
					const snapshot = store.getObservations(key.modelRef)[0] as Log;
					const metadata = (location === "observation" ? snapshot : snapshot.ranked[0]).extra!;
					expect(metadata.payload).toBe("original");
					if (mutate) metadata.payload = "changed";
					store.flush();
					const persisted = JSON.parse(readFileSync(path, "utf8")) as typeof file;
					const retained = persisted.hosts.fixture.observations[0];
					expect((location === "observation" ? retained : retained.ranked[0]).extra?.payload).toBe("original");
					if (mutate) metadata.payload = "after flush";
					const fresh = store.getObservations()[0] as Log;
					expect((location === "observation" ? fresh : fresh.ranked[0]).extra?.payload).toBe("original");
					expect(store.get(key).repairCount).toBe(1);
				} finally {
					store.close();
					rmSync(dir, { recursive: true, force: true });
				}
			},
		);
	}

	it.each(["execution", "validation"] as const)(
		"does not retain undeclared shared-memory fields from %s identity input",
		(operation) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-performance-identity-"));
			const store = ToolPerformanceStore.forAgentDir(dir, { fingerprint: () => host, writeBehind: {} });
			const extendedKey = { ...key, extra: { shared: new SharedArrayBuffer(1) } };
			try {
				const result = (operation === "execution"
					? store.recordExecution({ key: extendedKey, success: true, latencyMs: 1, selection })
					: store.recordValidation(extendedKey, "repaired")) as unknown as {
					extra?: { shared: SharedArrayBuffer };
				};
				if (result.extra) new Uint8Array(result.extra.shared)[0] = 9;
				expect(new Uint8Array(extendedKey.extra.shared)[0]).toBe(0);
				expect(result).not.toHaveProperty("extra");
				expect(store.get(key)).not.toHaveProperty("extra");
				expect(store.get(key)).toMatchObject({
					sampleCount: operation === "execution" ? 1 : 0,
					repairCount: operation === "validation" ? 1 : 0,
				});
			} finally {
				store.close();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	for (const mutate of [false, true]) {
		it.each(["get", "model", "intent", "agreement", "agreements", "execution-result", "validation-result"] as const)(
			`isolates %s from working-state metadata (mutate=${mutate})`,
			(method) => {
				const dir = mkdtempSync(join(tmpdir(), "pi-performance-snapshot-"));
				const path = join(dir, "state", "tool-performance.json");
				const store = ToolPerformanceStore.forAgentDir(dir, { fingerprint: () => host, writeBehind: {} });
				try {
					store.recordExecution({ key, success: true, latencyMs: 1, selection });
					store.flush();
					const field = method === "agreement" || method === "agreements" ? "intentAgreement" : "stats";
					const file = JSON.parse(readFileSync(path, "utf8")) as FileWithMetadata;
					Object.values(file.hosts.fixture[field])[0].extra = { payload: "small" };
					writeFileSync(path, JSON.stringify(file));
					const executionResult = store.recordExecution({ key, success: true, latencyMs: 1, selection });
					const outputs = {
						get: () => store.get(key),
						model: () => store.getStatsForModel(key.modelRef)[0],
						intent: () => store.getStatsForIntent(key.modelRef, "read")[0],
						agreement: () => store.getIntentAgreement(key.modelRef, "read"),
						agreements: () => store.getAllIntentAgreements()[0],
						"execution-result": () => executionResult,
						"validation-result": () => store.recordValidation(key, "repaired"),
					};
					const snapshot = outputs[method]() as unknown as RecordWithMetadata;
					expect(snapshot.extra.payload).toBe("small");
					if (mutate) snapshot.extra.payload = "x".repeat(300_000);
					store.recordValidation(key, "repaired");
					store.flush();
					const persisted = JSON.parse(readFileSync(path, "utf8")) as FileWithMetadata;
					expect(Object.values(persisted.hosts.fixture[field])[0].extra.payload.length).toBe(5);
					expect(Object.values(persisted.hosts.fixture[field])[0].extra.payload).toBe("small");
					expect(store.get(key).sampleCount).toBe(2);
					expect(store.getIntentAgreement(key.modelRef, "read").sampleCount).toBe(2);
					if (mutate) {
						// Flushing/freezing the store must not freeze an already delivered caller snapshot.
						snapshot.extra.payload = "after flush";
						expect(
							(outputs[method === "execution-result" ? "get" : method]() as unknown as RecordWithMetadata).extra
								.payload,
						).toBe("small");
					}
				} finally {
					store.close();
					rmSync(dir, { recursive: true, force: true });
				}
			},
		);
	}
});
