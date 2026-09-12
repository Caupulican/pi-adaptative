import type { CollaborationAgent, CollaborationBackend } from "./backend.ts";
import {
	type CollaborationPendingQuestion,
	type CollaborationResultClaim,
	validateCollaborationPendingQuestion,
	validateCollaborationResultClaim,
} from "./result-claim.ts";

export interface SettlementWaitInput {
	backend: CollaborationBackend;
	target: string;
	terminalId: string;
	paneId: string;
	turnId: string;
	initialAgent: CollaborationAgent;
	timeoutMs: number;
	startTime: number;
	signal?: AbortSignal;
	readClaim?: () => CollaborationResultClaim | undefined;
	readQuestion?: () => CollaborationPendingQuestion | undefined;
	subscribeReport?: (listener: () => void) => () => void;
	isTurnActive?: () => boolean;
}

export interface SettlementResult {
	agent: CollaborationAgent;
	claim?: CollaborationResultClaim;
	question?: CollaborationPendingQuestion;
}

export interface SteeringWaitInput {
	backend: CollaborationBackend;
	target: string;
	terminalId: string;
	paneId: string;
	timeoutMs?: number;
	startTime?: number;
	signal?: AbortSignal;
}

export function getValidClaim(
	readClaim?: () => CollaborationResultClaim | undefined,
	turnId?: string,
): CollaborationResultClaim | undefined {
	let claim = readClaim?.();
	try {
		if (claim) validateCollaborationResultClaim(claim);
		if (claim?.turnId !== turnId) claim = undefined;
	} catch {
		claim = undefined;
	}
	return claim;
}

export function getValidQuestion(
	readQuestion?: () => CollaborationPendingQuestion | undefined,
	turnId?: string,
	agentStatus?: string,
): CollaborationPendingQuestion | undefined {
	let question = agentStatus === "blocked" ? readQuestion?.() : undefined;
	try {
		if (question) validateCollaborationPendingQuestion(question);
		if (question?.turnId !== turnId) question = undefined;
	} catch {
		question = undefined;
	}
	return question;
}

export interface AgentEventWaitOptions<T> {
	backend: CollaborationBackend;
	target: string;
	terminalId: string;
	paneId: string;
	timeoutMs: number;
	startTime?: number;
	signal?: AbortSignal;
	timeoutMessage?: string;
	subscribeReport?: (listener: () => void) => () => void;
	check(
		current: CollaborationAgent,
	): Promise<{ settled: boolean; value?: T } | undefined> | { settled: boolean; value?: T } | undefined;
}

/**
 * Single cohesive event-driven wait lifecycle owner.
 *
 * Enforces:
 * 1. Event-driven waiting only (no polling).
 * 2. In-flight check coalescing (no events dropped).
 * 3. Exact occupant identity fences (paneId + terminalId).
 * 4. Cancellation/abort signal propagation and timer cleanup.
 * 5. Immediate unsubscribe on late async subscription resolution after settlement.
 * 6. Prompt rejection on termination events (pane_exited, pane_closed, connection_closed).
 */
export async function waitForAgentEventCondition<T>(options: AgentEventWaitOptions<T>): Promise<T> {
	const {
		backend,
		target,
		terminalId,
		paneId,
		timeoutMs,
		startTime = Date.now(),
		signal,
		timeoutMessage = "Collaboration wait timed out.",
		subscribeReport,
		check,
	} = options;

	signal?.throwIfAborted();

	let current: CollaborationAgent;
	try {
		current = await backend.getAgent(target);
	} catch (err) {
		signal?.throwIfAborted();
		throw err;
	}
	signal?.throwIfAborted();
	if (current.terminalId !== terminalId || current.paneId !== paneId) {
		throw new Error("Collaboration pane occupant changed.");
	}
	const initialCheck = await check(current);
	signal?.throwIfAborted();
	if (initialCheck?.settled) {
		return initialCheck.value as T;
	}

	signal?.throwIfAborted();

	if (!backend.subscribeEvents && !subscribeReport) {
		throw new Error("No event sources available for event-driven waiting.");
	}

	let unsubscribeBackend: (() => void) | undefined;
	let unsubscribeReport: (() => void) | undefined;
	let settled = false;

	return new Promise<T>((resolve, reject) => {
		const cleanup = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			unsubscribeBackend?.();
			unsubscribeReport?.();
		};

		const onAbort = () => {
			cleanup();
			reject(signal?.reason ?? new Error("Aborted"));
		};

		if (signal?.aborted) {
			reject(signal.reason ?? new Error("Aborted"));
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		const remainingMs = Math.max(1, timeoutMs - (Date.now() - startTime));
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(timeoutMessage));
		}, remainingMs);

		let inFlight = false;
		let rerun = false;

		const triggerCheck = () => {
			if (settled) return;
			if (inFlight) {
				rerun = true;
				return;
			}
			inFlight = true;
			void (async () => {
				try {
					while (!settled) {
						rerun = false;
						await doCheck();
						if (!rerun || settled) break;
					}
				} finally {
					inFlight = false;
				}
			})();
		};

		const doCheck = async () => {
			if (settled) return;
			if (signal?.aborted) {
				cleanup();
				reject(signal.reason ?? new Error("Aborted"));
				return;
			}
			let current: CollaborationAgent;
			try {
				current = await backend.getAgent(target);
			} catch (err) {
				cleanup();
				reject(err);
				return;
			}

			if (current.terminalId !== terminalId || current.paneId !== paneId) {
				cleanup();
				reject(new Error("Collaboration pane occupant changed during wait."));
				return;
			}

			try {
				const res = await check(current);
				if (res?.settled && !settled) {
					cleanup();
					resolve(res.value as T);
				}
			} catch (err) {
				if (!settled) {
					cleanup();
					reject(err);
				}
			}
		};

		try {
			if (backend.subscribeEvents) {
				backend
					.subscribeEvents(
						paneId,
						(event) => {
							if (settled) return;
							if (
								event.type === "pane_exited" ||
								event.type === "pane_closed" ||
								event.type === "connection_closed"
							) {
								cleanup();
								reject(new Error(`Collaboration agent terminated unexpectedly (${event.type}).`));
								return;
							}
							if (event.type === "agent_status_changed") {
								triggerCheck();
							}
						},
						signal,
					)
					.then((unsub) => {
						if (settled) {
							unsub();
							return;
						}
						unsubscribeBackend = unsub;
						triggerCheck();
					})
					.catch((err) => {
						if (settled) return;
						cleanup();
						reject(err);
					});
			}

			if (subscribeReport) {
				unsubscribeReport = subscribeReport(() => {
					triggerCheck();
				});
			}

			triggerCheck();
		} catch (err) {
			cleanup();
			reject(err);
		}
	});
}

/**
 * Wait for an agent to become ready after a steering interrupt (Esc).
 *
 * Uses the single cohesive event-wait lifecycle owner with steering readiness predicates:
 * - Native blocked question boundary: settles immediately
 * - Settled in idle or done + interactiveReady
 * - Fenced to exact occupant identity
 * - Rejects on unexpected occupant termination
 */
export async function waitForSteeringSettlement(input: SteeringWaitInput): Promise<CollaborationAgent> {
	const { backend, target, terminalId, paneId, timeoutMs = 10000, startTime = Date.now(), signal } = input;
	signal?.throwIfAborted();
	if (!backend.subscribeEvents) {
		throw new Error("Backend does not support event-driven steering notification; refusing to steer.");
	}
	return waitForAgentEventCondition<CollaborationAgent>({
		backend,
		target,
		terminalId,
		paneId,
		timeoutMs,
		startTime,
		signal,
		timeoutMessage: "Timed out waiting for agent to settle after steering interrupt.",
		check(current) {
			if (current.status === "blocked" && !current.launchPending) {
				return { settled: true, value: current };
			}
			if (
				(current.status === "idle" || current.status === "done") &&
				current.interactiveReady &&
				!current.launchPending
			) {
				return { settled: true, value: current };
			}
			return { settled: false };
		},
	});
}

/**
 * Wait for turn settlement across transient idle or report-before-stop.
 *
 * Uses the single cohesive event-wait lifecycle owner with final-report settlement predicates:
 * 1. Native blocked occupant settles immediately at blocked/question boundary.
 * 2. Authenticated report AND matching settled occupant are required for completion.
 * 3. Superseded turns reject immediately without lingering.
 */
export async function waitForTurnSettlement(input: SettlementWaitInput): Promise<SettlementResult> {
	const {
		backend,
		target,
		terminalId,
		paneId,
		turnId,
		initialAgent,
		timeoutMs,
		startTime,
		signal,
		readClaim,
		readQuestion,
		subscribeReport,
		isTurnActive,
	} = input;

	signal?.throwIfAborted();
	if (initialAgent.terminalId !== terminalId) {
		throw new Error("Collaboration pane occupant changed.");
	}

	let claim = getValidClaim(readClaim, turnId);
	let question = getValidQuestion(readQuestion, turnId, initialAgent.status);

	if (initialAgent.status === "blocked" && !initialAgent.launchPending) {
		return { agent: initialAgent, claim, question };
	}

	const hasEventSources = Boolean(backend.subscribeEvents || subscribeReport);
	if (!hasEventSources) {
		if (initialAgent.status === "working") {
			throw new Error("Collaboration agent has not stopped working.");
		}
		return { agent: initialAgent, claim, question };
	}

	return waitForAgentEventCondition<SettlementResult>({
		backend,
		target,
		terminalId,
		paneId,
		timeoutMs,
		startTime,
		signal,
		timeoutMessage: `Collaboration turn timed out (${Math.round(timeoutMs / 1000)}s) waiting for authenticated final report.`,
		subscribeReport,
		check(current) {
			if (isTurnActive && !isTurnActive()) {
				throw new Error("Collaboration turn superseded.");
			}
			claim = getValidClaim(readClaim, turnId);
			if (current.status === "blocked" && !current.launchPending) {
				question = getValidQuestion(readQuestion, turnId, "blocked");
				return { settled: true, value: { agent: current, claim, question } };
			}
			if (claim && ["idle", "done"].includes(current.status) && !current.launchPending) {
				return { settled: true, value: { agent: current, claim, question: undefined } };
			}
			return { settled: false };
		},
	});
}
