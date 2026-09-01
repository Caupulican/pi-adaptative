import type { StopReason } from "@caupulican/pi-ai";
import { isInterruptedAssistantStopReason, type PromptOptions } from "./agent-session-contracts.ts";
import { REFLECTION_TURN_TRIGGER_CUSTOM_TYPE } from "./reflection-controller.ts";

export interface ReflectionTurnLifecycleDeps {
	/** Submit the reflection prompt as an ordinary session prompt -- same history, same tools. */
	prompt(text: string, options: PromptOptions): Promise<void>;
	/** Claim the due cue and return its prompt, or undefined when no turn has been bought. */
	beginDueReflectionTurn(): string | undefined;
	/** Release the claim taken by {@link beginDueReflectionTurn}. Always called, even on failure. */
	endReflectionTurn(): void;
	/** Abort the agent's current run, which is what unwinds a detached reflection turn. */
	abortAgent(): void;
	/** Stop reason of the last assistant message, including aborted ones. */
	getLastAssistantStopReason(): StopReason | undefined;
	isDisposed(): boolean;
	warn(message: string): void;
}

/** The one detached reflection turn, paired with the controller that can cancel it wherever it is. */
interface InFlightReflectionTurn {
	readonly promise: Promise<void>;
	readonly cancel: AbortController;
}

/**
 * Owns the lifetime of the ONE extra end-of-work provider turn that reflection may buy: starting it,
 * tracking the detached promise, settling it on demand, and preempting it when real work arrives.
 * Extracted from AgentSession (see scripts/check-coordinator-boundaries.mjs, which enforces the
 * coordinator's line-count ceiling) because this is one responsibility end to end -- every method
 * here exists to keep that detached turn OWNED rather than abandoned.
 *
 * AgentSession keeps the policy inputs (whether a cue is due, how a prompt is submitted, when the
 * session is disposed) and passes them in; this class holds no session state of its own beyond the
 * in-flight turn.
 *
 * Cancellation is the reason it owns a per-turn `AbortController` rather than calling `abortAgent()`
 * and hoping. A detached reflection turn spends most of its life BEFORE the provider run -- extension
 * `input` handlers, cross-session recall, the route judge -- and an agent-level abort is an edge that
 * only reaches a run already in flight, so in that window it is a silent no-op. The controller's signal
 * rides along in the submission's `PromptOptions` and is read again just before the run starts, which
 * makes cancellation level-triggered: it lands wherever the turn happens to be.
 */
export class ReflectionTurnLifecycle {
	/**
	 * The one in-flight end-of-work reflection turn, or undefined when none is running.
	 *
	 * Held so the turn's lifetime is OWNED rather than abandoned. It is deliberately not awaited by
	 * `prompt()` (reflection must never sit on the user's critical path), and detached-but-untracked
	 * is exactly how work escapes a session and keeps writing to the agent dir after the turn that
	 * spawned it returned -- so the promise lives here, `AgentSession.dispose()` settles it before
	 * memory shutdown, and {@link settle} gives a caller a deterministic barrier instead of a timer.
	 *
	 * Its per-turn `AbortController` is held alongside the promise rather than in a second field: the
	 * two are one fact -- this turn, and the handle that cancels it -- and splitting them is how a
	 * cancel ends up firing at a turn that already finished.
	 */
	private _inFlight: InFlightReflectionTurn | undefined;
	private readonly deps: ReflectionTurnLifecycleDeps;

	constructor(deps: ReflectionTurnLifecycleDeps) {
		this.deps = deps;
	}

	/** True while a detached reflection turn is running. */
	get inFlight(): boolean {
		return this._inFlight !== undefined;
	}

	/**
	 * Start the ONE extra provider turn a completed unit of work may buy on reflection, and take
	 * ownership of its lifetime. Returns immediately; the turn runs detached from the caller.
	 *
	 * The turn is bought only by evidence (see `ReflectionController.beginDueReflectionTurn`), so a run
	 * with nothing durable to record costs exactly zero extra calls. It is a real turn on this session's
	 * own history and tools -- that is what lets the model actually write to memory or promote a skill --
	 * started from the caller's prompt tail rather than at `agent_end` because a turn cannot start while
	 * the run that ended is still holding the foreground submission lease.
	 *
	 * Never starts from an internal-context turn, which is what bounds the whole mechanism to one extra
	 * turn: the reflection turn is itself internal, so its completion cannot buy another.
	 */
	startDueTurn(options?: PromptOptions): void {
		if (options?.internalContextType || this.deps.isDisposed()) return;
		// An aborted run is the user asking for LESS work, not more; reflection waits for a turn that
		// actually finished. The cue stays due and merges with whatever the next completed turn adds.
		if (isInterruptedAssistantStopReason(this.deps.getLastAssistantStopReason())) return;
		const reflectionPrompt = this.deps.beginDueReflectionTurn();
		if (!reflectionPrompt) return;
		// One controller per turn, never reused: cancelling turn N must be unable to touch turn N+1.
		const cancel = new AbortController();
		const run = (async () => {
			try {
				await this.deps.prompt(reflectionPrompt, {
					expandPromptTemplates: false,
					processSlashCommands: false,
					autoContinueGoal: false,
					internalContextType: REFLECTION_TURN_TRIGGER_CUSTOM_TYPE,
					signal: cancel.signal,
				});
			} catch (error) {
				// Reported, not swallowed: a reflection turn that cannot run (no model, auth revoked
				// mid-run, provider outage) is a real failure worth surfacing, but it must not fail the
				// user's own completed turn -- that turn's work already succeeded.
				//
				// A cancelled turn is not one of those. Preemption and disposal are this class deciding the
				// turn should stop; warning about them would report the mechanism working as a fault, and
				// the user would see "Reflection turn failed" for having typed a second prompt.
				if (!cancel.signal.aborted) {
					this.deps.warn(`Reflection turn failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			} finally {
				// In a `finally` so a throw anywhere above cannot wedge the controller's in-flight claim on.
				this.deps.endReflectionTurn();
			}
		})();
		// Assigned before any `await` above can yield, so a caller that has just awaited `prompt()` always
		// observes the turn it started. The IIFE swallows its own failures, so `run` never rejects.
		const turn: InFlightReflectionTurn = { promise: run, cancel };
		this._inFlight = turn;
		void run.then(() => {
			if (this._inFlight === turn) this._inFlight = undefined;
		});
	}

	/**
	 * Cancel the in-flight reflection turn without waiting for it to unwind. For disposal, which aborts
	 * everything first and settles afterwards.
	 *
	 * Distinct from {@link preemptFor}, which cancels AND waits because the caller is about to take the
	 * foreground. Nothing here is a barrier: pair it with {@link settle} when one is needed.
	 */
	abort(): void {
		this._inFlight?.cancel.abort();
	}

	/**
	 * Await the detached end-of-work reflection turn, if one is running.
	 *
	 * The deterministic alternative to sleeping a tick and hoping. `prompt()` returns as soon as the
	 * user's own work is done, with the reflection turn already tracked here, so
	 * `await prompt(...); await settleReflectionTurn()` is race-free -- unlike a timer, which only
	 * happens to be long enough until the machine is slower. Loops because settling one turn is the
	 * moment another could legally start; it cannot spin, since a reflection turn never buys another.
	 */
	async settle(): Promise<void> {
		while (this._inFlight) await this._inFlight.promise;
	}

	/**
	 * Make room for an arriving submission. Real work cancels the reflection turn; internal work waits
	 * for it; the reflection turn's own submission does neither.
	 *
	 * Detaching the reflection turn is what makes this necessary. The session is genuinely busy while it
	 * runs, so without this a prompt arriving in that window -- a user typing straight after reading
	 * their answer -- is rejected with `AgentBusyError`, having done nothing wrong. Queuing it as
	 * steering would be worse: the user would wait out a turn they cannot see. So the reflection turn
	 * yields.
	 *
	 * It yields only to a REAL prompt. An internally generated submission -- a goal continuation, a lane
	 * follow-up -- is the session's own autonomous work with nobody waiting on a screen, and cancelling
	 * a bought reflection turn for it silently destroys the turn: `startDueTurn` refuses to start from an
	 * internal tail, so the cue it abandoned has no next completed turn to merge into and may never be
	 * delivered at all. Internal work waits instead; the reflection turn is one turn long.
	 *
	 * This does NOT put reflection on a user's critical path. The prompt that BOUGHT the turn never waits
	 * for it. Only a prompt that arrives inside the window pays, and only for a cancellation -- normally
	 * nothing at all, since nothing is in flight. Cancellation is level-triggered through the submission
	 * signal, so it lands whether the turn is mid-provider-call or still in its own preflight; without
	 * that, `abortAgent()` alone reaches nothing before the run starts and this wait would be the whole
	 * length of the reflection turn. `abortAgent()` still runs alongside it, since a run already in
	 * flight is unwound by its own abort controller rather than by the next signal read.
	 */
	async preemptFor(options?: PromptOptions): Promise<void> {
		const turn = this._inFlight;
		if (!turn) return;
		// The reflection turn's own submission must never preempt itself.
		if (options?.internalContextType === REFLECTION_TURN_TRIGGER_CUSTOM_TYPE) return;
		if (options?.internalContextType) {
			await this.settle();
			return;
		}
		turn.cancel.abort();
		this.deps.abortAgent();
		await this.settle();
	}
}
