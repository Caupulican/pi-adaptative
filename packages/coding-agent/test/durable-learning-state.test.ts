import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DURABLE_LEARNING_MEMORY_POLICY_VERSION,
	DURABLE_LEARNING_STATE_MAX_BYTES,
	DURABLE_LEARNING_STATE_MAX_HISTORY,
	type DurableLearningClaimToken,
	DurableLearningState,
	type DurableLearningVersions,
} from "../src/core/learning/durable-learning-state.ts";
import { runSignaledWorkerThreads } from "./worker-thread-fixture.ts";

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const BASE_VERSIONS: DurableLearningVersions = {
	runtimeVersion: "0.96.4",
	memoryPolicyVersion: DURABLE_LEARNING_MEMORY_POLICY_VERSION,
};

function deterministicIds(): () => string {
	let next = 1;
	return () => `00000000-0000-4000-8000-${(next++).toString(16).padStart(12, "0")}`;
}

function parseState(filePath: string): {
	schemaVersion: number;
	revision: number;
	observedRuntimeVersion: string;
	observedMemoryPolicyVersion: string;
	current: {
		transitionId: string;
		reason: string;
		claim: {
			claimId: string;
			ownerId: string;
			expiresAt: string;
		} | null;
	} | null;
	history: Array<{ transitionId: string; status: string }>;
} {
	return JSON.parse(readFileSync(filePath, "utf-8"));
}

describe("DurableLearningState", () => {
	let agentDir: string;
	let filePath: string;
	let nowMs: number;

	beforeEach(() => {
		agentDir = join(tmpdir(), `pi-durable-learning-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		filePath = join(agentDir, "state", "durable-learning-state.json");
		nowMs = Date.UTC(2026, 7, 24, 0, 0, 0);
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
	});

	function createStore(options: { leaseMs?: number } = {}): DurableLearningState {
		return DurableLearningState.forAgentDir(agentDir, {
			now: () => new Date(nowMs),
			randomId: deterministicIds(),
			leaseMs: options.leaseMs ?? 60_000,
		});
	}

	it("creates one first-observation transition and persists the claim before synchronous cue attachment", () => {
		const store = createStore();
		let token: DurableLearningClaimToken | undefined;
		const result = store.reconcileClaimAndAttach(BASE_VERSIONS, OWNER_A, (currentToken, metadata) => {
			expect(existsSync(filePath)).toBe(true);
			expect(parseState(filePath).current?.claim?.claimId).toBe(currentToken.claimId);
			expect(metadata).toEqual({
				reason: "first-observation",
				previousRuntimeVersion: null,
				runtimeVersion: "0.96.4",
				previousMemoryPolicyVersion: null,
				memoryPolicyVersion: DURABLE_LEARNING_MEMORY_POLICY_VERSION,
			});
			token = currentToken;
			return "attached";
		});

		expect(result.status).toBe("attached");
		expect(token).toMatchObject({ ownerId: OWNER_A, runtimeVersion: "0.96.4" });
		expect(parseState(filePath)).toMatchObject({
			schemaVersion: 1,
			revision: 1,
			observedRuntimeVersion: "0.96.4",
			current: { reason: "first-observation", claim: { ownerId: OWNER_A } },
			history: [],
		});
	});

	it("preserves every token field on same-owner renewal, rejects a live different owner, and revokes on expiry takeover", () => {
		const store = createStore({ leaseMs: 1_000 });
		let first: DurableLearningClaimToken | undefined;
		store.reconcileClaimAndAttach(BASE_VERSIONS, OWNER_A, (token) => {
			first = token;
			return "attached";
		});
		if (!first) throw new Error("Expected first claim");
		const firstExpiry = parseState(filePath).current?.claim?.expiresAt;

		nowMs += 500;
		let renewed: DurableLearningClaimToken | undefined;
		const renewal = store.reconcileClaimAndAttach(BASE_VERSIONS, OWNER_A, (token) => {
			renewed = token;
			return "coalesced";
		});
		expect(renewal.status).toBe("coalesced");
		expect(renewed).toEqual(first);
		expect(parseState(filePath).current?.claim?.expiresAt).not.toBe(firstExpiry);

		let differentOwnerAttached = false;
		const busy = store.reconcileClaimAndAttach(BASE_VERSIONS, OWNER_B, () => {
			differentOwnerAttached = true;
			return "attached";
		});
		expect(busy.status).toBe("busy");
		expect(differentOwnerAttached).toBe(false);

		nowMs += 1_001;
		let takeover: DurableLearningClaimToken | undefined;
		const taken = store.reconcileClaimAndAttach(BASE_VERSIONS, OWNER_B, (token) => {
			takeover = token;
			return "replaced-stale";
		});
		expect(taken.status).toBe("replaced-stale");
		expect(takeover?.claimId).not.toBe(first.claimId);
		expect(store.renewClaim(first)).toBe(false);
		expect(store.completeReview(first)).toBe(false);
	});

	it("releases and completes only the exact current token", () => {
		const store = createStore();
		let stale: DurableLearningClaimToken | undefined;
		store.reconcileClaimAndAttach(BASE_VERSIONS, OWNER_A, (token) => {
			stale = token;
			return "attached";
		});
		if (!stale) throw new Error("Expected stale claim");
		expect(store.releaseClaim(stale)).toBe(true);
		expect(store.releaseClaim(stale)).toBe(false);

		let exact: DurableLearningClaimToken | undefined;
		store.reconcileClaimAndAttach(BASE_VERSIONS, OWNER_B, (token) => {
			exact = token;
			return "replaced-stale";
		});
		if (!exact) throw new Error("Expected replacement claim");
		expect(store.completeReview(stale)).toBe(false);
		expect(store.completeReview({ ...exact, ownerId: OWNER_A })).toBe(false);
		expect(store.completeReview(exact)).toBe(true);
		expect(store.completeReview(exact)).toBe(false);
		expect(parseState(filePath)).toMatchObject({
			current: null,
			history: [{ transitionId: exact.transitionId, status: "reviewed" }],
		});
	});

	it("atomically supersedes an older pending transition and rejects its completion", () => {
		const store = createStore();
		let oldToken: DurableLearningClaimToken | undefined;
		store.reconcileClaimAndAttach(BASE_VERSIONS, OWNER_A, (token) => {
			oldToken = token;
			return "attached";
		});
		if (!oldToken) throw new Error("Expected old token");

		const moved = { ...BASE_VERSIONS, runtimeVersion: "0.96.5" };
		let currentToken: DurableLearningClaimToken | undefined;
		const result = store.reconcileClaimAndAttach(moved, OWNER_A, (token, metadata) => {
			currentToken = token;
			expect(metadata).toMatchObject({
				reason: "runtime-change",
				previousRuntimeVersion: "0.96.4",
				runtimeVersion: "0.96.5",
			});
			return "replaced-stale";
		});
		expect(result.status).toBe("replaced-stale");
		expect(currentToken?.transitionId).not.toBe(oldToken.transitionId);
		expect(store.completeReview(oldToken)).toBe(false);
		expect(parseState(filePath)).toMatchObject({
			observedRuntimeVersion: "0.96.5",
			current: { transitionId: currentToken?.transitionId, claim: { ownerId: OWNER_A } },
			history: [{ transitionId: oldToken.transitionId, status: "superseded" }],
		});
	});

	it("releases the exact claim when cue attachment is disabled, fails, or throws", () => {
		for (const outcome of ["disabled", "failed"] as const) {
			const directory = join(agentDir, outcome);
			mkdirSync(directory, { recursive: true });
			const store = DurableLearningState.forAgentDir(directory, {
				now: () => new Date(nowMs),
				randomId: deterministicIds(),
				leaseMs: 60_000,
			});
			const result = store.reconcileClaimAndAttach(BASE_VERSIONS, OWNER_A, () => outcome);
			expect(result.status).toBe(outcome);
			expect(parseState(join(directory, "state", "durable-learning-state.json")).current?.claim).toBeNull();
		}

		const throwingDir = join(agentDir, "throwing");
		mkdirSync(throwingDir, { recursive: true });
		const throwing = DurableLearningState.forAgentDir(throwingDir, {
			now: () => new Date(nowMs),
			randomId: deterministicIds(),
		});
		const result = throwing.reconcileClaimAndAttach(BASE_VERSIONS, OWNER_A, () => {
			throw new Error("session append failed");
		});
		expect(result.status).toBe("failed");
		expect(parseState(join(throwingDir, "state", "durable-learning-state.json")).current?.claim).toBeNull();
	});

	it("recovers malformed supported state without touching semantic memory", () => {
		mkdirSync(join(agentDir, "state"), { recursive: true });
		writeFileSync(filePath, "{ not valid json ]", "utf-8");
		const semanticPath = join(agentDir, "MEMORY.md");
		writeFileSync(semanticPath, "semantic sentinel\n", "utf-8");
		const store = createStore();
		let reason: string | undefined;
		const result = store.reconcileClaimAndAttach(BASE_VERSIONS, OWNER_A, (_token, metadata) => {
			reason = metadata.reason;
			return "attached";
		});

		expect(result.status).toBe("attached");
		expect(result.warningCode).toBe("recovered-corrupt-state");
		expect(reason).toBe("recovered-corrupt-state");
		expect(readFileSync(semanticPath, "utf-8")).toBe("semantic sentinel\n");
		expect(parseState(filePath).current?.reason).toBe("recovered-corrupt-state");
	});

	it.each([
		["newer schema", JSON.stringify({ schemaVersion: 2, opaque: true })],
		[
			"unknown v1 key",
			JSON.stringify({
				schemaVersion: 1,
				revision: 1,
				observedRuntimeVersion: "0.96.4",
				observedMemoryPolicyVersion: "1",
				current: null,
				history: [],
				unexpected: true,
			}),
		],
		["oversize state", "x".repeat(DURABLE_LEARNING_STATE_MAX_BYTES + 1)],
	] as const)("preserves exact bytes and declines claims for %s", (_label, bytes) => {
		mkdirSync(join(agentDir, "state"), { recursive: true });
		writeFileSync(filePath, bytes, "utf-8");
		let attached = false;
		const result = createStore().reconcileClaimAndAttach(BASE_VERSIONS, OWNER_A, () => {
			attached = true;
			return "attached";
		});
		expect(result.status).toBe("unsupported");
		expect(attached).toBe(false);
		expect(readFileSync(filePath, "utf-8")).toBe(bytes);
	});

	it("does no state I/O when required version metadata is invalid", () => {
		const store = createStore();
		for (const versions of [
			{ ...BASE_VERSIONS, runtimeVersion: "" },
			{ ...BASE_VERSIONS, memoryPolicyVersion: "" },
			{ ...BASE_VERSIONS, runtimeVersion: "x".repeat(129) },
		]) {
			const result = store.reconcileClaimAndAttach(versions, OWNER_A, () => "attached");
			expect(result.status).toBe("invalid-version");
		}
		expect(existsSync(filePath)).toBe(false);
	});

	it("fails safely before cue attachment when the state lock or atomic writer is unavailable", () => {
		let lockAttached = false;
		const lockFault = new DurableLearningState(filePath, {
			withLock: <T>(_path: string, _fn: () => T): T => {
				throw new Error("lock unavailable");
			},
		});
		expect(
			lockFault.reconcileClaimAndAttach(BASE_VERSIONS, OWNER_A, () => {
				lockAttached = true;
				return "attached";
			}),
		).toMatchObject({ status: "unavailable", warningCode: "state-unavailable" });
		expect(lockAttached).toBe(false);
		expect(existsSync(filePath)).toBe(false);

		const writerDirectory = join(agentDir, "writer-fault");
		const writerPath = join(writerDirectory, "state", "durable-learning-state.json");
		let writerAttached = false;
		const writerFault = new DurableLearningState(writerPath, {
			writeState: () => {
				throw new Error("atomic rename unavailable");
			},
		});
		expect(
			writerFault.reconcileClaimAndAttach(BASE_VERSIONS, OWNER_A, () => {
				writerAttached = true;
				return "attached";
			}),
		).toMatchObject({ status: "unavailable", warningCode: "state-unavailable" });
		expect(writerAttached).toBe(false);
		expect(existsSync(writerPath)).toBe(false);
	});

	it("stays inert after an exact version review and classifies policy-only transitions", () => {
		const store = createStore();
		let first: DurableLearningClaimToken | undefined;
		store.reconcileClaimAndAttach(BASE_VERSIONS, OWNER_A, (token) => {
			first = token;
			return "attached";
		});
		if (!first) throw new Error("Expected initial claim");
		expect(store.completeReview(first)).toBe(true);
		let repeatedAttached = false;
		expect(
			store.reconcileClaimAndAttach(BASE_VERSIONS, OWNER_A, () => {
				repeatedAttached = true;
				return "attached";
			}),
		).toEqual({ status: "unchanged" });
		expect(repeatedAttached).toBe(false);

		const policyChanged = { ...BASE_VERSIONS, memoryPolicyVersion: "2" };
		let reason: string | undefined;
		expect(
			store.reconcileClaimAndAttach(policyChanged, OWNER_A, (_token, metadata) => {
				reason = metadata.reason;
				return "attached";
			}),
		).toEqual({ status: "attached" });
		expect(reason).toBe("memory-policy-change");
	});

	it("bounds resolved transition history and total file size", () => {
		const store = createStore();
		for (let index = 0; index < DURABLE_LEARNING_STATE_MAX_HISTORY + 9; index += 1) {
			const versions = { ...BASE_VERSIONS, runtimeVersion: `0.96.${index + 4}` };
			let token: DurableLearningClaimToken | undefined;
			store.reconcileClaimAndAttach(versions, OWNER_A, (current) => {
				token = current;
				return index === 0 ? "attached" : "replaced-stale";
			});
			if (!token) throw new Error("Expected bounded-history claim");
			expect(store.completeReview(token)).toBe(true);
		}
		const state = parseState(filePath);
		expect(state.current).toBeNull();
		expect(state.history).toHaveLength(DURABLE_LEARNING_STATE_MAX_HISTORY);
		expect(statSync(filePath).size).toBeLessThanOrEqual(DURABLE_LEARNING_STATE_MAX_BYTES);
	});

	it("serializes two real OS-thread roots so only one live claim exists", async () => {
		const modulePath = new URL("../src/core/learning/durable-learning-state.ts", import.meta.url).pathname;
		const workerPath = join(agentDir, "claim-worker.mjs");
		writeFileSync(
			workerPath,
			`import { writeFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { DurableLearningState } from ${JSON.stringify(modulePath)};
const store = DurableLearningState.forAgentDir(workerData.agentDir);
const result = store.reconcileClaimAndAttach(workerData.versions, workerData.ownerId, () => "attached");
writeFileSync(workerData.resultPath, result.status, "utf-8");
parentPort.postMessage({ done: true });
`,
			"utf-8",
		);
		const resultPaths = [join(agentDir, "worker-a.txt"), join(agentDir, "worker-b.txt")];
		await runSignaledWorkerThreads(workerPath, [
			{ agentDir, versions: BASE_VERSIONS, ownerId: OWNER_A, resultPath: resultPaths[0] },
			{ agentDir, versions: BASE_VERSIONS, ownerId: OWNER_B, resultPath: resultPaths[1] },
		]);
		const statuses = resultPaths.map((path) => readFileSync(path, "utf-8")).sort();
		expect(statuses).toEqual(["attached", "busy"]);
		expect(parseState(filePath).current?.claim?.ownerId).toMatch(/^1111|^2222/);
	});
});
