import { normalize, sep } from "node:path";
import { ContinuousChatStore } from "../../../../src/core/memory/continuous-chat-store.ts";
import { getInFlightWorkUnits } from "../../../../src/core/reload-blockers.ts";
import { runtimeGenerationAdmission } from "../../../../src/core/runtime-generation-admission.ts";
import type { HarnessWorld } from "../session-fixture.ts";

export type SummaryTask = {
	readonly track: string;
	readonly level: number;
	readonly ordinal: number;
	readonly text: string;
};
type StoreMethod =
	| "projectionRevision"
	| "readMessageById"
	| "readCausalPrefix"
	| "readNode"
	| "appendNode"
	| "completeWork"
	| "claimWork"
	| "readQueue";
type StoreCall = {
	readonly id: number;
	readonly method: StoreMethod;
	readonly coordinates: unknown;
	readonly startedAt: number;
	status: string;
	settledAt?: number;
};
type OriginalMethod = (this: ContinuousChatStore, ...args: unknown[]) => Promise<unknown>;

const STORE_METHODS: readonly StoreMethod[] = [
	"projectionRevision",
	"readMessageById",
	"readCausalPrefix",
	"readNode",
	"appendNode",
	"completeWork",
	"claimWork",
	"readQueue",
];

function coordinate(value: unknown): { level?: number; ordinal?: number } | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as { level?: unknown; ordinal?: unknown };
	return {
		...(typeof candidate.level === "number" ? { level: candidate.level } : {}),
		...(typeof candidate.ordinal === "number" ? { ordinal: candidate.ordinal } : {}),
	};
}

function callCoordinates(method: StoreMethod, args: readonly unknown[]): unknown {
	switch (method) {
		case "readMessageById":
			return { messageId: args[0] };
		case "readCausalPrefix":
			return { endMessage: args[0] };
		case "readNode":
			return coordinate(args[0]);
		case "appendNode":
			return coordinate(args[0]);
		case "completeWork":
		case "claimWork":
			return coordinate(args[0]);
		default:
			return undefined;
	}
}

function resultSummary(method: StoreMethod, value: unknown): string {
	if (method === "appendNode" && typeof value === "boolean") return value ? "published" : "not-published";
	if (method === "readMessageById" || method === "readNode") return value === undefined ? "absent" : "present";
	if (method === "claimWork") {
		const point = coordinate(value);
		return point ? `claimed:${point.level ?? "?"}/${point.ordinal ?? "?"}` : "no-claim";
	}
	if (method === "readQueue" && typeof value === "object" && value !== null) {
		const queue = value as { running?: unknown; totalMessages?: unknown };
		return `queue:${String(queue.running)}:${String(queue.totalMessages)}`;
	}
	if (method === "projectionRevision" && typeof value === "number") return `revision:${value}`;
	if (method === "readCausalPrefix" && typeof value === "object" && value !== null) {
		const viewed = (value as { viewedMessages?: unknown }).viewedMessages;
		return `viewed:${String(viewed)}`;
	}
	return "settled";
}

function errorSummary(error: unknown): string {
	const name = error instanceof Error ? error.name : "Error";
	const message = error instanceof Error ? error.message : String(error);
	return `${name}: ${message}`.slice(0, 240);
}

function containsBoundedText(value: unknown, text: string, maxNodes = 96): boolean {
	let visited = 0;
	const visit = (current: unknown, depth: number): boolean => {
		if (++visited > maxNodes || depth > 5) return false;
		if (typeof current === "string") return current.includes(text);
		if (Array.isArray(current)) {
			for (let index = 0; index < current.length && index < 16; index++)
				if (visit(current[index], depth + 1)) return true;
			return false;
		}
		if (typeof current !== "object" || current === null) return false;
		const keys = Object.keys(current);
		for (let index = 0; index < keys.length && index < 16; index++) {
			const key = keys[index]!;
			if (key.includes(text) || visit((current as Record<string, unknown>)[key], depth + 1)) return true;
		}
		return false;
	};
	return visit(value, 0);
}

/** Passive H25-only instrumentation; each wrapper returns the original store promise unchanged. */
export function observeLegacyImportStore(
	world: HarnessWorld,
	rootDir: string,
	queueDatabase: string,
	agentDir: string,
	requestStart: number,
	tasks: readonly SummaryTask[],
): { snapshot(): unknown; restore(): void } {
	const prototype = ContinuousChatStore.prototype;
	const expectedRoot = normalize(rootDir);
	const recent: StoreCall[] = [];
	const active = new Map<number, StoreCall>();
	const observerErrors: string[] = [];
	const originals = new Map<StoreMethod, PropertyDescriptor>();
	let nextCallId = 0;
	let settledCallCount = 0;
	let lastSettledAt: number | undefined;
	let restored = false;
	const note = (message: string) => {
		try {
			observerErrors.push(message.slice(0, 200));
			if (observerErrors.length > 4) observerErrors.shift();
		} catch {
			// Instrumentation must not change the observed owner.
		}
	};
	const finish = (entry: StoreCall, status: string): void => {
		try {
			entry.status = status;
			entry.settledAt = Date.now();
			settledCallCount++;
			lastSettledAt = entry.settledAt;
			active.delete(entry.id);
			if (recent.length > 48) recent.shift();
		} catch (error) {
			note(errorSummary(error));
		}
	};
	try {
		for (const method of STORE_METHODS) {
			const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
			if (!descriptor || typeof descriptor.value !== "function") throw new Error(`Missing store method ${method}`);
			originals.set(method, descriptor);
			const original = descriptor.value as OriginalMethod;
			const wrapped: OriginalMethod = function (this: ContinuousChatStore, ...args: unknown[]): Promise<unknown> {
				if (normalize(this.rootDir) !== expectedRoot) return original.apply(this, args);
				const entry: StoreCall = {
					id: ++nextCallId,
					method,
					coordinates: callCoordinates(method, args),
					startedAt: Date.now(),
					status: "pending",
				};
				try {
					recent.push(entry);
					if (recent.length > 48) recent.shift();
					if (active.size < 16) active.set(entry.id, entry);
					else note("active store-call sample reached its 16-entry cap");
				} catch (error) {
					note(errorSummary(error));
				}
				let result: Promise<unknown>;
				try {
					result = original.apply(this, args);
				} catch (error) {
					finish(entry, `threw:${errorSummary(error)}`);
					throw error;
				}
				try {
					void result
						.then(
							(value) => {
								let summary = "settled";
								try {
									summary = resultSummary(method, value);
								} catch (error) {
									note(errorSummary(error));
								}
								finish(entry, summary);
							},
							(error: unknown) => finish(entry, `rejected:${errorSummary(error)}`),
						)
						.catch((error: unknown) => note(errorSummary(error)));
				} catch (error) {
					note(errorSummary(error));
				}
				return result;
			};
			Object.defineProperty(prototype, method, { ...descriptor, value: wrapped });
		}
	} catch (error) {
		const rollbackFailures: unknown[] = [error];
		for (const [method, descriptor] of originals) {
			try {
				Object.defineProperty(prototype, method, descriptor);
			} catch (restoreError) {
				rollbackFailures.push(
					new Error(`${method} restore: ${errorSummary(restoreError)}`, { cause: restoreError }),
				);
			}
		}
		if (rollbackFailures.length > 1)
			throw new AggregateError(rollbackFailures, "H25 store witness setup and rollback failed", { cause: error });
		throw error;
	}
	return {
		snapshot: () => {
			let runningRows: Record<string, unknown>[] | undefined;
			let runningRowsFailure: string | undefined;
			try {
				runningRows = world.guard.peekSqlite(
					queueDatabase,
					"SELECT level, ordinal FROM work WHERE status='running' ORDER BY sequence LIMIT 3",
				);
			} catch (error) {
				runningRowsFailure = errorSummary(error);
			}
			const runningCoordinates =
				runningRows?.flatMap((row) =>
					typeof row.level === "number" && typeof row.ordinal === "number"
						? [{ level: row.level, ordinal: row.ordinal }]
						: [],
				) ?? [];
			const coordinateKey = (level: number, ordinal: number) => `${level}:${ordinal}`;
			const runningKeys = new Set(runningCoordinates.map((item) => coordinateKey(item.level, item.ordinal)));
			const taskByCoordinate = new Map(tasks.map((task) => [coordinateKey(task.level, task.ordinal), task]));
			const targetedRequests = new Map<string, (typeof world.provider.requests)[number]>();
			const scanLimit = 256;
			let scannedRequests = 0;
			for (
				let index = world.provider.requests.length - 1;
				index >= requestStart && scannedRequests < scanLimit && targetedRequests.size < runningKeys.size;
				index--, scannedRequests++
			) {
				const request = world.provider.requests[index]!;
				if (request.model.id !== "worker-b") continue;
				const last = request.context.messages.at(-1);
				for (const item of runningCoordinates) {
					const key = coordinateKey(item.level, item.ordinal);
					const task = taskByCoordinate.get(key);
					if (!targetedRequests.has(key) && task && containsBoundedText(last, task.text)) {
						targetedRequests.set(key, request);
					}
				}
			}
			const tailRequests: typeof world.provider.requests = [];
			for (
				let index = world.provider.requests.length - 1, inspected = 0;
				index >= requestStart && inspected < 512 && tailRequests.length < 8;
				index--, inspected++
			) {
				const request = world.provider.requests[index]!;
				if (request.model.id === "worker-b") tailRequests.push(request);
			}
			tailRequests.reverse();
			const targetedValues = [...targetedRequests.values()];
			const targetedSequences = new Set(targetedValues.map((request) => request.sequence));
			const extraTail = tailRequests
				.filter((request) => !targetedSequences.has(request.sequence))
				.slice(-Math.max(0, 8 - targetedValues.length));
			const requests = [...targetedValues, ...extraTail].sort((left, right) => left.sequence - right.sequence);
			const taskFor = (request: (typeof requests)[number]) => {
				const last = request.context.messages.at(-1);
				return tasks
					.filter((task) => containsBoundedText(last, task.text))
					.map((task) => ({
						track: task.track,
						level: task.level,
						ordinal: task.ordinal,
						pending: world.provider.getPendingStepNames(task.track).includes(task.track),
					}));
			};
			const requestSequences = new Set(requests.map((request) => request.sequence));
			const terminals = new Map<number, (typeof world.provider.terminals)[number]>();
			for (
				let index = world.provider.terminals.length - 1, inspected = 0;
				index >= 0 && inspected < 512 && terminals.size < requestSequences.size;
				index--, inspected++
			) {
				const terminal = world.provider.terminals[index]!;
				if (requestSequences.has(terminal.sequence)) terminals.set(terminal.sequence, terminal);
			}
			const terminalScan = {
				scanned: Math.min(world.provider.terminals.length, 512),
				limit: 512,
				truncated: world.provider.terminals.length > 512 && terminals.size < requestSequences.size,
			};
			const producerTerminalOf = (sequence: number) =>
				terminals.get(sequence) ??
				(terminalScan.truncated ? "not-found-in-bounded-terminal-history" : "not-emitted-at-snapshot");
			const normalizedPrefix = `${expectedRoot}${sep}`;
			const relativeStorePath = (path: string) =>
				path === expectedRoot
					? "."
					: path.startsWith(normalizedPrefix)
						? path.slice(expectedRoot.length)
						: "<outside-store>";
			const recentIo: Array<{ kind: string; path: string; destination?: string }> = [];
			for (
				let index = world.io.operations.length - 1, inspected = 0;
				index >= 0 && inspected < 512 && recentIo.length < 12;
				index--, inspected++
			) {
				const operation = world.io.operations[index]!;
				const path = normalize(operation.path);
				const destination = operation.destination === undefined ? undefined : normalize(operation.destination);
				if (path !== expectedRoot && !path.startsWith(normalizedPrefix)) continue;
				recentIo.push({
					kind: operation.kind,
					path: relativeStorePath(path).slice(0, 160),
					...(destination === undefined ? {} : { destination: relativeStorePath(destination).slice(0, 160) }),
				});
			}
			let admission: unknown;
			try {
				const units = getInFlightWorkUnits(agentDir);
				admission = {
					replacing: runtimeGenerationAdmission(agentDir).isReplacing,
					inFlightByKind: Object.fromEntries(
						(["lane", "scout", "isolated-completion"] as const).map((kind) => [
							kind,
							units.filter((unit) => unit.kind === kind).length,
						]),
					),
				};
			} catch (error) {
				admission = { unavailable: errorSummary(error) };
			}
			const admissionTimers = world.timers.armedSnapshot("provider-admission");
			const reachedLegacy: string[] = [];
			for (
				let index = world.provider.reached.length - 1, inspected = 0;
				index >= 0 && inspected < 512 && reachedLegacy.length < 8;
				index--, inspected++
			) {
				const step = world.provider.reached[index]!;
				if (step.startsWith("h25-legacy-compaction-")) reachedLegacy.push(step);
			}
			reachedLegacy.reverse();
			return {
				storeCalls: {
					total: nextCallId,
					settled: settledCallCount,
					lastSettlementAgeMs: lastSettledAt === undefined ? undefined : Math.max(0, Date.now() - lastSettledAt),
					active: [...active.values()].slice(-8).map((entry) => ({
						...entry,
						pendingAgeMs: Math.max(0, Date.now() - entry.startedAt),
					})),
					recent: recent.slice(-24).map((entry) => ({
						...entry,
						pendingAgeMs: entry.settledAt === undefined ? Math.max(0, Date.now() - entry.startedAt) : undefined,
						settledAgeMs: entry.settledAt === undefined ? undefined : Math.max(0, Date.now() - entry.settledAt),
					})),
				},
				provider: {
					...(runningRowsFailure === undefined ? {} : { runningRowsUnavailable: runningRowsFailure }),
					runningCoordinates: runningCoordinates.map((item) => {
						const key = coordinateKey(item.level, item.ordinal);
						const request = targetedRequests.get(key);
						return {
							...item,
							request:
								request === undefined
									? "not-found-in-bounded-worker-b-history"
									: {
											sequence: request.sequence,
											track: taskByCoordinate.get(key)?.track,
											producerTerminal: producerTerminalOf(request.sequence),
										},
						};
					}),
					terminalScan,
					requestScan: {
						scanned: scannedRequests,
						limit: scanLimit,
						truncated:
							targetedRequests.size < runningKeys.size &&
							world.provider.requests.length - requestStart > scanLimit,
						tailTruncated: tailRequests.length < 8 && world.provider.requests.length - requestStart > 512,
					},
					workerBRequests: requests.map((request) => ({
						sequence: request.sequence,
						messageCount: request.context.messages.length,
						tracks: taskFor(request),
						producerTerminal: producerTerminalOf(request.sequence),
					})),
					failures: world.provider.failures.slice(-6).map((failure) => failure.slice(0, 240)),
					reachedLegacy,
				},
				providerAdmission: { timerCount: admissionTimers.length, timers: admissionTimers.slice(0, 8), admission },
				io: { operationCount: world.io.operations.length, recentStoreOperations: recentIo.reverse() },
				observerErrors,
			};
		},
		restore: () => {
			if (restored) return;
			restored = true;
			const failures: string[] = [];
			for (const [method, descriptor] of originals) {
				try {
					Object.defineProperty(prototype, method, descriptor);
				} catch (error) {
					failures.push(`${method}: ${errorSummary(error)}`);
				}
			}
			if (failures.length) throw new AggregateError(failures, "H25 store witness restoration failed");
		},
	};
}
