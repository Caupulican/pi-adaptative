import { AsyncLocalStorage } from "node:async_hooks";
import { IndependentObserverSet } from "./observer-dispatch.ts";
import { type WaitStatusEvent, waitFor } from "./util/wait.ts";

export type InFlightWorkKind = "lane" | "scout" | "isolated-completion";

export interface InFlightWorkUnit {
	id: number;
	kind: InFlightWorkKind;
	label: string;
	registeredAt: number;
}

export class RuntimeGenerationAdmissionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeGenerationAdmissionError";
	}
}

export interface RuntimeWorkLease {
	assertCurrent(): void;
	/** A command may upgrade only until its submission starts preparing a provider turn. */
	beginTurnPreparation(): void;
	release(): void;
}

export interface RuntimeMutationLease {
	assertCurrent(): void;
	beginCandidateAttempt(): RuntimeCandidateAttempt;
	runCandidateConstruction<T>(runner: RuntimeCandidateRuntime, callback: () => T): T;
	runCandidateCallback<T>(runner: RuntimeCandidateRuntime, callback: () => Promise<T>): Promise<T>;
	release(): void;
}

export interface RuntimeCandidateAttempt {
	commit(): void;
	discard(): void;
}

interface CandidateAttemptRecord {
	status: "pending" | "committed" | "discarded";
}

interface RuntimeCandidateRuntime {
	assertRuntimeActive(): void;
}

const mutationHandoffMarker: unique symbol = Symbol("runtimeMutationHandoff");

/** Host-owned, one-use permission for this exact reader to cross a settled run boundary. */
export interface RuntimeMutationHandoff {
	readonly [mutationHandoffMarker]: true;
	release(): void;
}

interface WorkRecord {
	kind: string;
	label: string;
	generation: number;
	preparingTurn: boolean;
}

interface CandidateCallbackScope {
	owner: RuntimeGenerationAdmission;
	writer: RuntimeMutationLease;
	runner: RuntimeCandidateRuntime;
	active: boolean;
	parent?: CandidateCallbackScope;
	attempt: CandidateAttemptRecord;
}

// Attribution for candidate resource mutations only. Reader admission and writer upgrades never
// consult this scope. Its active bit fences descendants after the awaited callback has returned.
const candidateCallbacks = new AsyncLocalStorage<CandidateCallbackScope>();
const admissions = new Map<string, RuntimeGenerationAdmission>();
let nextWorkId = 1;

function isCandidateScopeActive(scope: CandidateCallbackScope): boolean {
	for (let current: CandidateCallbackScope | undefined = scope; current; current = current.parent) {
		if (!current.active || current.attempt.status !== "pending") return false;
	}
	return true;
}

/** Committed async descendants have ordinary runtime authority, never candidate privilege. */
function currentCandidateScope(): CandidateCallbackScope | undefined {
	const scope = candidateCallbacks.getStore();
	if (!scope) return undefined;
	if (scope.attempt.status === "committed") {
		scope.runner.assertRuntimeActive();
		return undefined;
	}
	if (!isCandidateScopeActive(scope)) {
		throw new RuntimeGenerationAdmissionError("Extension candidate callback authority expired.");
	}
	return scope;
}

/** Every invoked extension hook gets its own lifetime inside an explicitly owned candidate operation. */
export function runRuntimeCandidateHandler<T>(runner: RuntimeCandidateRuntime, callback: () => Promise<T>): Promise<T> {
	try {
		const scope = currentCandidateScope();
		if (!scope) return candidateCallbacks.exit(callback);
		if (scope.runner !== runner)
			throw new RuntimeGenerationAdmissionError(
				"Extension candidate callback authority belongs to another runtime.",
			);
		return scope.writer.runCandidateCallback(runner, callback);
	} catch (error) {
		return Promise.reject(error);
	}
}

export function runtimeGenerationAdmission(agentDir: string): RuntimeGenerationAdmission {
	let owner = admissions.get(agentDir);
	if (!owner) {
		owner = new RuntimeGenerationAdmission();
		admissions.set(agentDir, owner);
	}
	return owner;
}

/** One process-local owner of runtime readers, recovery registrations and generation replacement. */
export class RuntimeGenerationAdmission {
	private generation = 0;
	private writer: RuntimeMutationLease | undefined;
	private readonly readers = new Map<RuntimeWorkLease, WorkRecord>();
	private readonly recoveredWork = new Map<number, InFlightWorkUnit>();
	private readonly mutationHandoffs = new Map<RuntimeMutationHandoff, RuntimeWorkLease>();
	private readonly listeners = new IndependentObserverSet<() => void>();
	private waitingReaders = 0;

	get isReplacing(): boolean {
		return this.writer !== undefined;
	}

	/** New readers become admissible only when the exclusive writer publishes a settled generation. */
	subscribeAvailability(listener: () => void): () => void {
		return this.listeners.subscribe(listener);
	}

	/** Validate borrowed authority at this owner; a caller-supplied assertion is not provenance. */
	assertOwnWorkCurrent(lease: RuntimeWorkLease): void {
		const record = this.readers.get(lease);
		if (!record || record.generation !== this.generation || this.writer) {
			throw new RuntimeGenerationAdmissionError(
				"Runtime reader authority is absent, expired, or belongs to another generation.",
			);
		}
	}

	tryAdmitWork(options: { kind: string; label: string }): RuntimeWorkLease | undefined {
		currentCandidateScope();
		if (this.writer) return undefined;
		const record: WorkRecord = {
			kind: options.kind,
			label: options.label,
			generation: this.generation,
			preparingTurn: false,
		};
		const lease: RuntimeWorkLease = {
			assertCurrent: () => this.assertOwnWorkCurrent(lease),
			beginTurnPreparation: () => {
				lease.assertCurrent();
				record.preparingTurn = true;
			},
			release: () => {
				if (!this.readers.delete(lease)) return;
				for (const [handoff, reader] of this.mutationHandoffs) {
					if (reader === lease) this.mutationHandoffs.delete(handoff);
				}
			},
		};
		this.readers.set(lease, record);
		return lease;
	}

	async admitWork(options: {
		kind: string;
		label: string;
		signal?: AbortSignal;
		report?: (event: WaitStatusEvent) => void;
	}): Promise<RuntimeWorkLease> {
		options.signal?.throwIfAborted();
		const candidateScope = currentCandidateScope();
		if (this.writer && candidateScope?.owner === this) {
			throw new RuntimeGenerationAdmissionError(
				"Runtime lifecycle callbacks cannot await new runtime work before their generation settles.",
			);
		}
		const immediate = this.tryAdmitWork(options);
		if (immediate) return immediate;
		// Deferred message APIs have no return channel to their extension caller. Bound retained
		// intents; the binding reports an overflow as an extension error instead of losing it silently.
		if (this.waitingReaders >= 256) {
			throw new RuntimeGenerationAdmissionError("Runtime generation admission queue is full (256 pending intents).");
		}
		this.waitingReaders++;
		try {
			const outcome = await waitFor<RuntimeWorkLease>({
				id: "runtime_generation.admission",
				wake: [
					{
						id: "runtime_generation.settled",
						subscribe: (wake) => this.subscribeAvailability(wake),
						check: () => {
							const lease = this.tryAdmitWork(options);
							return lease ? { kind: "satisfied", value: lease } : undefined;
						},
					},
				],
				signal: options.signal,
				steer: { mode: "exempt", reason: "input must wait until the runtime generation commits or rolls back" },
				bound: { kind: "watchdog", overdueMs: 60_000, holder: () => "runtime generation replacement" },
				report: options.report,
			});
			if (outcome.end.kind === "satisfied" && outcome.value) return outcome.value;
			throw new RuntimeGenerationAdmissionError(`Runtime admission ended ${outcome.end.kind}: ${options.label}`);
		} finally {
			this.waitingReaders--;
		}
	}

	/** Fire-and-forget extension messages are deferred intents, never awaited candidate work. */
	deliverMessageIntent(deliver: (lease: RuntimeWorkLease) => Promise<void>): Promise<void> {
		const origin = candidateCallbacks.getStore();
		try {
			currentCandidateScope();
		} catch (error) {
			return Promise.reject(error);
		}
		return candidateCallbacks.exit(async () => {
			const options = { kind: "extension-message", label: "extension message delivery" };
			// Void extension APIs still publish ordinary queue effects in their calling stack.
			// Candidate messages and messages during replacement retain the deferred path.
			const lease = this.tryAdmitWork(options) ?? (await this.admitWork(options));
			try {
				if (origin && origin.attempt.status !== "committed") {
					throw new RuntimeGenerationAdmissionError(
						"Deferred extension message was discarded because its runtime candidate did not commit.",
					);
				}
				await deliver(lease);
			} finally {
				lease.release();
			}
		});
	}

	/** Called only by the foreground owner at a settled tool batch or its queued-command cleanup. */
	beginMutationHandoff(lease: RuntimeWorkLease): RuntimeMutationHandoff {
		this.assertOwnWorkCurrent(lease);
		const handoff: RuntimeMutationHandoff = {
			[mutationHandoffMarker]: true,
			release: () => {
				this.mutationHandoffs.delete(handoff);
			},
		};
		this.mutationHandoffs.set(handoff, lease);
		return handoff;
	}

	tryBeginMutation(options: {
		action: string;
		ownerCommandLease?: RuntimeWorkLease;
		ownerHandoff?: RuntimeMutationHandoff;
	}): RuntimeMutationLease {
		currentCandidateScope();
		if (this.writer) {
			throw new RuntimeGenerationAdmissionError(`Cannot ${options.action} during runtime generation replacement.`);
		}
		if (options.ownerCommandLease && options.ownerHandoff) {
			throw new RuntimeGenerationAdmissionError("Runtime mutation has competing owner authorities.");
		}
		const handoffReader = options.ownerHandoff ? this.mutationHandoffs.get(options.ownerHandoff) : undefined;
		if (options.ownerHandoff && (!handoffReader || !this.readers.has(handoffReader))) {
			throw new RuntimeGenerationAdmissionError("Runtime mutation handoff expired or was already used.");
		}
		const upgradingLease = options.ownerCommandLease ?? handoffReader;
		const upgrading = upgradingLease ? this.readers.get(upgradingLease) : undefined;
		if (options.ownerCommandLease && (!upgrading || upgrading.preparingTurn)) {
			throw new RuntimeGenerationAdmissionError(
				`Cannot ${options.action}: command authority is no longer upgradeable.`,
			);
		}
		const foreign = [...this.readers.values()].filter((record) => record !== upgrading);
		if (foreign.length || this.recoveredWork.size) {
			const descriptions = [
				...foreign.map((record) => `${record.kind}:${record.label}`),
				...[...this.recoveredWork.values()].map((unit) => `${unit.kind}:${unit.label}`),
			];
			throw new RuntimeGenerationAdmissionError(
				`Cannot ${options.action} while runtime work is in flight: ${descriptions.join(", ")}`,
			);
		}
		let candidate: CandidateAttemptRecord | undefined;
		const createCandidateScope = (runner: RuntimeCandidateRuntime): CandidateCallbackScope => {
			writer.assertCurrent();
			const ambient = candidateCallbacks.getStore();
			const parent = ambient?.writer === writer ? currentCandidateScope() : undefined;
			const attempt = parent?.writer === writer ? parent.attempt : candidate;
			if (attempt?.status !== "pending")
				throw new RuntimeGenerationAdmissionError("Runtime candidate is not pending.");
			return { owner: this, writer, runner, active: true, parent, attempt };
		};
		const writer: RuntimeMutationLease = {
			assertCurrent: () => {
				if (this.writer !== writer)
					throw new RuntimeGenerationAdmissionError("Runtime mutation authority expired.");
			},
			beginCandidateAttempt: () => {
				writer.assertCurrent();
				if (candidate?.status === "pending") {
					throw new RuntimeGenerationAdmissionError("The previous runtime candidate has not settled.");
				}
				const attempt: CandidateAttemptRecord = { status: "pending" };
				candidate = attempt;
				return {
					commit: () => {
						writer.assertCurrent();
						if (attempt.status !== "pending")
							throw new RuntimeGenerationAdmissionError("Runtime candidate already settled.");
						attempt.status = "committed";
					},
					discard: () => {
						if (attempt.status === "pending") attempt.status = "discarded";
					},
				};
			},
			runCandidateConstruction: (runner, callback) => {
				const scope = createCandidateScope(runner);
				try {
					return candidateCallbacks.run(scope, callback);
				} finally {
					scope.active = false;
				}
			},
			runCandidateCallback: async (runner, callback) => {
				const scope = createCandidateScope(runner);
				try {
					return await candidateCallbacks.run(scope, callback);
				} finally {
					scope.active = false;
				}
			},
			release: () => {
				if (this.writer !== writer) return;
				if (candidate?.status === "pending") candidate.status = "discarded";
				this.generation++;
				if (upgrading && upgradingLease && this.readers.get(upgradingLease) === upgrading)
					upgrading.generation = this.generation;
				this.writer = undefined;
				this.notifyAvailability();
			},
		};
		if (options.ownerHandoff) this.mutationHandoffs.delete(options.ownerHandoff);
		this.writer = writer;
		return writer;
	}

	/** Nested lifecycle reload must fail before coalescing could return its own outstanding promise. */
	assertExternalMutationRequest(): void {
		const scope = currentCandidateScope();
		if (scope?.owner === this) {
			throw new RuntimeGenerationAdmissionError(
				"Runtime lifecycle callbacks cannot request a nested runtime replacement.",
			);
		}
	}

	/** Captured extension APIs may modify resources only in their exact active candidate callback. */
	assertResourceMutation(runner: object): void {
		const scope = currentCandidateScope();
		if (scope?.owner === this) {
			if (!isCandidateScopeActive(scope) || scope.runner !== runner || this.writer !== scope.writer) {
				throw new RuntimeGenerationAdmissionError("Extension candidate resource mutation authority expired.");
			}
			return;
		}
		if (this.writer) {
			throw new RuntimeGenerationAdmissionError(
				"Extension resources are being replaced by another runtime generation.",
			);
		}
	}

	/** Async resource changes retain ordinary read ownership or their exact candidate capability. */
	beginResourceMutation(runner: object): Pick<RuntimeWorkLease, "assertCurrent" | "release"> {
		this.assertResourceMutation(runner);
		const scope = currentCandidateScope();
		if (scope?.owner === this) {
			return {
				assertCurrent: () => {
					if (!isCandidateScopeActive(scope) || scope.runner !== runner || this.writer !== scope.writer) {
						throw new RuntimeGenerationAdmissionError("Extension candidate resource mutation authority expired.");
					}
				},
				release: () => {},
			};
		}
		const lease = this.tryAdmitWork({ kind: "resource", label: "extension resource change" });
		if (!lease) throw new RuntimeGenerationAdmissionError("Runtime generation is being replaced.");
		return lease;
	}

	/** Existing durable/terminal ownership is adopted synchronously; this is not new-work admission. */
	registerRecoveredWork(kind: InFlightWorkKind, label: string): () => void {
		const id = nextWorkId++;
		this.recoveredWork.set(id, { id, kind, label, registeredAt: Date.now() });
		return () => {
			this.recoveredWork.delete(id);
		};
	}

	getInFlightWorkUnits(): InFlightWorkUnit[] {
		return [...this.recoveredWork.values()];
	}

	private notifyAvailability(): void {
		// Publication belongs to the host, not to whichever lifecycle descendant initiated reload.
		candidateCallbacks.exit(() =>
			this.listeners.notify(
				(listener) => listener(),
				(error) =>
					process.emitWarning(error instanceof Error ? error : "Runtime availability observer failed.", {
						code: "PI_RUNTIME_AVAILABILITY_OBSERVER_FAILED",
					}),
			),
		);
	}
}

export function registerInFlightWork(agentDir: string, kind: InFlightWorkKind, label: string): () => void {
	return runtimeGenerationAdmission(agentDir).registerRecoveredWork(kind, label);
}

export function getInFlightWorkUnits(agentDir: string): InFlightWorkUnit[] {
	return runtimeGenerationAdmission(agentDir).getInFlightWorkUnits();
}

export function resetInFlightWorkRegistryForTests(): void {
	admissions.clear();
}
