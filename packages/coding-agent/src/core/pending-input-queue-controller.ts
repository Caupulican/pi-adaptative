import type { ImageContent, TextContent } from "@caupulican/pi-ai";
import type { Agent } from "../kernel/agent.ts";
import type { AgentMessage } from "../kernel/types.ts";
import type { ExtensionRunner, SendUserMessageOrigin } from "./extensions/index.ts";
import type { ForegroundInputPort, ForegroundRecoveryController } from "./foreground-recovery-controller.ts";
import type { GoalSessionController } from "./goals/goal-session-controller.ts";
import type { ExplicitGoalStartAuthority } from "./goals/natural-language-goal.ts";
import {
	type OwnerInputEnd,
	type OwnerInputId,
	type OwnerInputLedger,
	ownerInputIdOf,
	stampOwnerInput,
} from "./owner-input-ledger.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import {
	ownerVisibleQueuedText,
	type QueuedInputKind,
	type QueuedInputOrigin,
	type RecordableQueuedInput,
} from "./queued-input-record.ts";
import type { SkillVaultController } from "./skill-vault.ts";
import { type SteerDecision, type SteerWake, type WaitStatusEvent, waitFor } from "./util/wait.ts";

export interface PendingQueueSnapshot {
	steering: string[];
	followUp: string[];
	commands: string[];
}

/** One queued message as the operator submitted it: its text and any images it carried. */
export interface QueuedInput {
	text: string;
	images?: ImageContent[];
}

/**
 * The admitted form of a queued input: the text, images and owner evidence the agent receives. What its delivery decides is
 * registered with the owner-input ledger against the input's identity (`whenDelivered`), never here.
 */
export interface QueuedInputAdmission {
	text: string;
	images?: ImageContent[];
	queuedGoalAuthority?: ExplicitGoalStartAuthority;
	ownerOriginalText?: string;
}

/**
 * One accepted queued input, from the moment it was submitted. It is pending (visible, takeable)
 * while it awaits admission and after it is admitted into the agent's queue. Taking or clearing it
 * cancels whatever is still deciding its admission, so a late decision can never enqueue it.
 */
export interface PendingInputHandle {
	readonly id: number;
	/** The input's identity in the owner-input ledger. */
	readonly inputId: OwnerInputId;
	/** Aborted when the input is taken, cleared or cancelled before admission. */
	readonly signal: AbortSignal;
}

interface PendingEntry extends QueuedInput {
	readonly id: number;
	/** Its identity, minted at acceptance and stamped on the message it becomes: what delivery matches, never its text. */
	readonly inputId: OwnerInputId;
	readonly kind: QueuedInputKind;
	/** The input exactly as submitted: what recovery returns, whatever its delivered form became. */
	readonly original: QueuedInput;
	/**
	 * Set for an extension's framed third-party message: `text` is then the framed prompt the agent receives,
	 * and the owner sees, records and takes back the third party's words under this origin instead.
	 */
	readonly origin?: SendUserMessageOrigin;
	readonly abort: AbortController;
	readonly context?: PendingInputContext;
	admission?: QueuedInputAdmission;
	/** Set when handed to the agent: from here it is the agent's queued message. */
	message?: AgentMessage;
	/** A run read its message (the message started), so the transcript shows it; cleared once that echo is taken back. */
	displayed?: boolean;
	/** Its context changed before it was handed on: kept in full for recovery, never handed on. */
	held?: boolean;
}

/** Abort reason of a pending input the operator took back, cleared or cancelled before admission. */
export const PENDING_INPUT_WITHDRAWN = new Error("The pending input was withdrawn before admission.");

export interface PendingInputQueueDeps {
	readonly agent: Agent;
	readonly skillVault: SkillVaultController;
	readonly goals: GoalSessionController;
	/** Mints each queued input's identity at acceptance, owns its state, and tells this queue when an input is delivered. */
	readonly ownerInputs: OwnerInputLedger;
	/** `_extensionRunner` is assigned after construction (definite-assignment field on AgentSession),
	 * so it must be read through a thunk rather than captured by value. */
	getExtensionRunner(): ExtensionRunner;
	getPromptTemplates(): ReadonlyArray<PromptTemplate>;
	/**
	 * A queued message the operator authored (not an extension), with the operator's ORIGINAL
	 * words before skill/template expansion: owner evidence once the message is persisted.
	 */
	noteOwnerAuthoredMessage?(message: AgentMessage, originalText: string): void;
	/** The session and branch an input is accepted in; omitted, every context is current. */
	getInputContext?(): PendingInputContext;
	/** Whether an input accepted in `context` still belongs to the session's current context. */
	isInputContextCurrent?(context: PendingInputContext): boolean;
	/** An input that was not handed on is held, complete and recoverable: its context changed, or no run delivered it. */
	onInputHeld?(input: QueuedInput, reason: PendingInputHoldReason): void;
	/** An owner interrupt cancelled an input whose admission was still undecided: it is gone, and this is its one notice. */
	onInputCancelled?(input: QueuedInput): void;
	/**
	 * A run read this input's message (the transcript shows it) but never persisted it, and the input now leaves without
	 * being delivered (held or taken back): that transcript echo is taken back.
	 */
	onUndeliveredEchoWithdrawn?(message: AgentMessage): void;
	/**
	 * The set of queued inputs changed (an input arrived, was delivered, taken back or withdrawn). Each
	 * call carries the complete queue in submission order, as submitted: the durable record's content.
	 */
	onQueueChanged?(inputs: readonly RecordableQueuedInput[]): void;
}

/** Why an input was held instead of being handed on: its context changed, no run delivered it, or the session closed first. */
export type PendingInputHoldReason = "context_changed" | "undelivered" | "closed";

/** Where an input was accepted: its session and that session's branch generation. */
export interface PendingInputContext {
	readonly sessionId: string;
	/** Advanced by every branch navigation; ordinary turns and compaction leave it unchanged. */
	readonly branchGeneration: number;
}

/**
 * Owns the three "pending input" queues that fill while the agent is mid-turn -- steering,
 * follow-up, and extension-command -- plus the command/skill-command text preparation shared by
 * `prompt()` and the queued path. Extracted from AgentSession (see
 * scripts/check-coordinator-boundaries.mjs, which enforces the coordinator's line-count ceiling)
 * because this already read as one responsibility: everything here is about deciding what to do
 * with input that arrives while a turn is in flight, and delivering it once one ends.
 *
 * AgentSession still owns eventing (`_emitQueueUpdate`/`_emit`) and calls back into this
 * controller for the underlying queue mechanics; this class has no event/emit dependency.
 */
const activeControllers = new Set<PendingInputQueueController>();

function sessionControllers(sessionId: string | undefined): PendingInputQueueController[] {
	return [...activeControllers].filter((controller) => !sessionId || controller.matchesSessionId(sessionId));
}

export function subscribeSessionSteerQueued(sessionId: string | undefined, listener: () => void): () => void {
	const unsubscribes = sessionControllers(sessionId).map((controller) => controller.onSteerQueued(listener));
	return () => {
		for (const unsubscribe of unsubscribes) unsubscribe();
	};
}

/**
 * Lets every undecided steer of the session reach its admission decision, and says how that ended: `timed_out` when
 * any decision outlived its reported deadline, `aborted` when `signal` ended it, else `decided`.
 */
export async function waitForSessionSteerAdmission(
	sessionId: string | undefined,
	signal?: AbortSignal,
	report?: (event: WaitStatusEvent) => void,
): Promise<SteerDecision> {
	let decision: SteerDecision = "decided";
	for (const controller of sessionControllers(sessionId)) {
		const settled = await controller.waitForPendingSteerDecision(signal, report);
		if (settled === "aborted") return "aborted";
		if (settled === "timed_out") decision = "timed_out";
	}
	return decision;
}

/** Abort reason of a wait the owner's queued steer ended: never an abort of the waiter itself. */
export const OWNER_STEER_QUEUED = new Error("The owner queued input while the wait ran.");

/**
 * The owner's steer as a wait's built-in wake (`owner.steer`): a steer queued while the wait runs ends it, a steer
 * already queued and not yet read by the session's model ends it at once, and `settle` lets that steer's admission
 * settle so the waiter's next steering poll already reads it.
 */
export function ownerSteerWake(sessionId: string | undefined, report?: (event: WaitStatusEvent) => void): SteerWake {
	return {
		id: "owner.steer",
		subscribe: (onSteer) => subscribeSessionSteerQueued(sessionId, onSteer),
		pending: () => sessionControllers(sessionId).some((controller) => controller.hasUnreadSteer()),
		settle: (signal) => waitForSessionSteerAdmission(sessionId, signal, report),
	};
}

/**
 * The owner-steer wake for a wait that ends on an abort signal: a steer aborts the returned signal (with
 * `OWNER_STEER_QUEUED`), and `finalize` then settles that steer's admission and returns its decision. An abort of
 * `signal` itself is passed through unchanged and is never a steer: `finalize` returns `undefined` then, as it does
 * when no steer arrived.
 */
export function createSteerAwareWait(
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
	report?: (event: WaitStatusEvent) => void,
): { readonly signal: AbortSignal; readonly finalize: () => Promise<SteerDecision | undefined> } {
	const wake = ownerSteerWake(sessionId, report);
	const controller = new AbortController();
	let steered = false;
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) {
		controller.abort(signal.reason);
	} else {
		signal?.addEventListener("abort", onAbort, { once: true });
	}
	const onSteer = (): void => {
		if (controller.signal.aborted) return;
		steered = true;
		controller.abort(OWNER_STEER_QUEUED);
	};
	const unsubscribeSteer = wake.subscribe(onSteer);
	if (wake.pending()) onSteer();
	return {
		signal: controller.signal,
		finalize: async () => {
			unsubscribeSteer();
			signal?.removeEventListener("abort", onAbort);
			if (!steered || signal?.aborted) return undefined;
			return wake.settle ? wake.settle(signal) : "none";
		},
	};
}

/**
 * How long a wait a steer ended lets that steer's admission decide before it returns anyway, reported as `timed_out`.
 * Twice the System One stage deadline (5 s, system-one/controller.ts), so one judgment lands with margin. A decision
 * that takes longer (inputs queued ahead of it are judged first, in order) still ends the wait at this bound; the
 * steer is then read at the first steering poll after its admission, as it would be with no wait at all.
 */
export const STEER_DECISION_DEADLINE_MS = 10_000;

export class PendingInputQueueController implements ForegroundInputPort {
	/** Submission order per kind; an entry admits only after every earlier entry of its kind. */
	private _steering: PendingEntry[] = [];
	private _followUp: PendingEntry[] = [];
	/**
	 * Inputs their own turn took (see `promote`). Not admitted, displayed or takeable: the turn owns them until the message
	 * stamped with their identity is persisted (`_delivered`) or the turn gives them back (`reclaim`). Still part of the
	 * durable record.
	 */
	private _owned: PendingEntry[] = [];
	/**
	 * Admitted inputs a run read (their message started) whose user entry is not persisted yet. Not displayed, takeable or
	 * held: the run has them. Still part of the durable record, so a crash before persistence loses none. They leave when
	 * they are delivered (`_delivered`) or when a routed turn drops them unpersisted (`returnUnpersisted`).
	 */
	private _awaitingPersistence: PendingEntry[] = [];
	private _queuedExtensionCommands: string[] = [];
	private _nextEntryId = 1;
	/** Set at disposal: nothing is handed to the agent afterwards. */
	private _closed = false;
	/**
	 * The foreground owner (`bindForeground`): decided input is handed to the agent's queue only while it reports a run that
	 * consumes that queue, and is otherwise left admitted for it to hand to the next run, or to deliver itself.
	 */
	private _foreground?: Pick<ForegroundRecoveryController, "hasLiveConsumer" | "noteInputWaiting">;
	private readonly _steerListeners = new Set<() => void>();
	private readonly _steerDecisionListeners = new Set<() => void>();
	private readonly deps: PendingInputQueueDeps;

	constructor(deps: PendingInputQueueDeps) {
		this.deps = deps;
		activeControllers.add(this);
		deps.ownerInputs.onDelivered(({ id }) => this._delivered(id));
	}

	/** The foreground owner hands this queue's admitted input to runs from here on (`ForegroundRecoveryController.bindInput`). */
	bindForeground(
		foreground: Pick<ForegroundRecoveryController, "hasLiveConsumer" | "noteInputWaiting" | "bindInput">,
	): void {
		this._foreground = foreground;
		foreground.bindInput(this);
	}

	matchesSessionId(sessionId: string): boolean {
		const context = this.deps.getInputContext?.();
		return !context || context.sessionId === sessionId;
	}

	onSteerQueued(listener: () => void): () => void {
		if (this._closed) return () => undefined;
		this._steerListeners.add(listener);
		return () => {
			this._steerListeners.delete(listener);
		};
	}

	/** A steer the session's model has not read yet: still deciding, or admitted and waiting for the steering poll. */
	hasUnreadSteer(): boolean {
		return !this._closed && this._steering.some((entry) => !entry.held);
	}

	/**
	 * Waits until no steer awaits its admission decision (admitted, promoted, held, withdrawn, or the queue closed),
	 * on the decision events, bounded by the reported `STEER_DECISION_DEADLINE_MS`.
	 */
	async waitForPendingSteerDecision(
		signal?: AbortSignal,
		report?: (event: WaitStatusEvent) => void,
	): Promise<SteerDecision> {
		const { end } = await waitFor<true>({
			id: "owner.steer.decision",
			wake: [
				{
					id: "steer.decision",
					subscribe: (onWake) => {
						if (this._closed) return () => undefined;
						this._steerDecisionListeners.add(onWake);
						return () => {
							this._steerDecisionListeners.delete(onWake);
						};
					},
					check: () =>
						this._closed || !this._steering.some((entry) => !entry.admission && !entry.held)
							? { kind: "satisfied", value: true }
							: undefined,
				},
			],
			signal,
			steer: { mode: "exempt", reason: "this wait is a steer's own admission decision" },
			bound: { kind: "deadline", ms: STEER_DECISION_DEADLINE_MS },
			...(report ? { report } : {}),
		});
		return end.kind === "satisfied" ? "decided" : end.kind === "timed_out" ? "timed_out" : "aborted";
	}

	private _notifySteerQueued(): void {
		for (const listener of [...this._steerListeners]) {
			listener();
		}
	}

	private _notifySteerDecision(): void {
		for (const listener of [...this._steerDecisionListeners]) {
			listener();
		}
	}

	get count(): number {
		return this._steering.length + this._followUp.length + this._queuedExtensionCommands.length;
	}

	/**
	 * Inputs a run will still deliver on its own. A held input (its context changed, no run delivered it, or
	 * it was restored after a restart) waits for the owner to take it back, so it is pending for display but
	 * never keeps the session from settling.
	 */
	get deliverableCount(): number {
		return (
			[...this._steering, ...this._followUp].filter((entry) => !entry.held).length +
			this._queuedExtensionCommands.length
		);
	}

	/** The text the owner sees for an input: the third party's words under their sender for a framed message. */
	private _ownerText(entry: PendingEntry): string {
		return entry.origin ? ownerVisibleQueuedText(entry.origin.text, entry.origin) : entry.text;
	}

	getSteering(): readonly string[] {
		return this._steering.map((entry) => this._ownerText(entry));
	}

	getFollowUp(): readonly string[] {
		return this._followUp.map((entry) => this._ownerText(entry));
	}

	getCommands(): readonly string[] {
		return this._closed ? [] : this._queuedExtensionCommands;
	}

	snapshot(): PendingQueueSnapshot {
		return {
			steering: this.getSteering() as string[],
			followUp: this.getFollowUp() as string[],
			commands: [...this.getCommands()],
		};
	}

	parseCommandName(text: string): string {
		const spaceIndex = text.indexOf(" ");
		return spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	}

	/** Route explicit /skill:name through the same host-owned vault as model tool calls. */
	expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const result = this.deps.skillVault.load(skillName, "user");
		if (!result.ok) {
			this.deps.getExtensionRunner().emitError({
				extensionPath: "<skill-vault>",
				event: "skill_load",
				error: result.message,
			});
			return text;
		}
		return args || `Use loaded skill ${JSON.stringify(skillName)} for this request.`;
	}

	/** Throw an error if the text is an extension command. */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this.deps.getExtensionRunner().getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/** Reject extension commands, then expand a queued message through the shared skill/template path. */
	prepareQueuedMessageText(text: string): string {
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}
		return expandPromptTemplate(this.expandSkillCommand(text), [...this.deps.getPromptTemplates()]);
	}

	/** Try to execute an extension command. Returns true if command was found and executed. */
	async tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = this.parseCommandName(text);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const runner = this.deps.getExtensionRunner();
		const command = runner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = runner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			runner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	private _createQueuedUserMessage(
		inputId: OwnerInputId,
		text: string,
		images: ImageContent[] | undefined,
		queuedGoalAuthority: ExplicitGoalStartAuthority | undefined,
		ownerOriginalText: string | undefined,
	): AgentMessage {
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }, ...(images ?? [])];
		const message: AgentMessage = { role: "user", content, timestamp: Date.now() };
		stampOwnerInput(message, inputId);
		if (queuedGoalAuthority) this.deps.goals.queueOwnerChatGoal(message, text, queuedGoalAuthority);
		if (ownerOriginalText !== undefined) this.deps.noteOwnerAuthoredMessage?.(message, ownerOriginalText);
		return message;
	}

	/** Queue a steering message (already expanded, no extension command check). */
	queueSteer(
		text: string,
		images?: ImageContent[],
		queuedGoalAuthority?: ExplicitGoalStartAuthority,
		ownerOriginalText?: string,
	): void {
		this.admit(this.register("steer", text, images), { text, images, queuedGoalAuthority, ownerOriginalText });
	}

	/** Queue a follow-up message (already expanded, no extension command check). */
	queueFollowUp(
		text: string,
		images?: ImageContent[],
		queuedGoalAuthority?: ExplicitGoalStartAuthority,
		ownerOriginalText?: string,
	): void {
		this.admit(this.register("followUp", text, images), { text, images, queuedGoalAuthority, ownerOriginalText });
	}

	/**
	 * Accept a queued input now, as submitted, before anything decides its admission. It is pending
	 * from here: counted, projected, takeable and clearable. Its place in its kind's order is fixed.
	 * `inputId` is the identity its submission was accepted under; a queued input accepted here is minted one now.
	 */
	register(
		kind: "steer" | "followUp",
		text: string,
		images?: ImageContent[],
		origin?: SendUserMessageOrigin,
		inputId?: OwnerInputId,
	): PendingInputHandle {
		const context = this.deps.getInputContext?.();
		const entry: PendingEntry = {
			id: this._nextEntryId++,
			inputId: inputId ?? this.deps.ownerInputs.accept(origin ? "extension" : kind),
			kind,
			text,
			images,
			original: { text, ...(images ? { images } : {}) },
			...(origin ? { origin } : {}),
			abort: new AbortController(),
			...(context ? { context } : {}),
		};
		(kind === "steer" ? this._steering : this._followUp).push(entry);
		this._changed();
		if (kind === "steer") this._notifySteerQueued();
		return { id: entry.id, inputId: entry.inputId, signal: entry.abort.signal };
	}

	/**
	 * Re-create inputs recorded by an earlier process as held pending inputs, in their recorded order and under their
	 * recorded identities: visible, takeable and editable, never handed to the agent on their own. The record they came
	 * from is the durable truth, so no change is reported unless `recordChanged`: the caller left out inputs the record
	 * still named, and the record is written once, now, without them.
	 */
	restore(
		inputs: ReadonlyArray<{
			id?: string;
			kind: QueuedInputKind;
			text: string;
			images?: ImageContent[];
			origin?: QueuedInputOrigin;
		}>,
		recordChanged = false,
	): void {
		const context = this.deps.getInputContext?.();
		for (const input of inputs) {
			const abort = new AbortController();
			abort.abort(PENDING_INPUT_WITHDRAWN);
			const entry: PendingEntry = {
				id: this._nextEntryId++,
				// Open again, held, under the identity it was accepted with; re-sending it later is a new input.
				inputId: this.deps.ownerInputs.restoreHeld(input.origin ? "extension" : input.kind, input.id),
				kind: input.kind,
				text: input.text,
				images: input.images,
				original: { text: input.text, ...(input.images ? { images: input.images } : {}) },
				...(input.origin ? { origin: { ...input.origin, text: input.text } } : {}),
				abort,
				held: true,
				...(context ? { context } : {}),
			};
			(input.kind === "steer" ? this._steering : this._followUp).push(entry);
		}
		if (recordChanged) this._changed();
	}

	/**
	 * Report the complete undelivered queue, as submitted and in submission order, to the durable record. An input leaves
	 * it only when it is delivered (its user entry persisted), taken back or withdrawn: one a run read but did not persist
	 * yet is still named.
	 */
	private _changed(): void {
		if (!this.deps.onQueueChanged) return;
		const entries = [...this._steering, ...this._followUp, ...this._owned, ...this._awaitingPersistence].sort(
			(left, right) => left.id - right.id,
		);
		this.deps.onQueueChanged(
			entries.map((entry) => ({
				id: entry.inputId,
				kind: entry.kind,
				text: entry.origin ? entry.origin.text : entry.original.text,
				...(entry.original.images ? { images: entry.original.images } : {}),
				...(entry.origin
					? {
							origin: {
								channel: entry.origin.channel,
								sender: entry.origin.sender,
								verified: entry.origin.verified,
							},
						}
					: {}),
			})),
		);
	}

	/**
	 * Admit a registered input into the agent's queue, after every earlier input of its kind. Returns
	 * false when the input is no longer pending (taken, cleared or withdrawn): it is never enqueued.
	 */
	admit(handle: PendingInputHandle, admission: QueuedInputAdmission): boolean {
		const entry = this._findEntry(handle.id);
		if (!entry || entry.admission || entry.held || this._closed) return false;
		entry.admission = admission;
		this.deps.ownerInputs.move(entry.inputId, "pending");
		this._admitInOrder();
		if (entry.kind === "steer") this._notifySteerDecision();
		return true;
	}

	/**
	 * The input runs as its own turn instead of joining the queue: ownership moves to that turn. Its
	 * signal is NOT aborted -- the turn is valid. False when the input is no longer pending here (taken,
	 * cleared, withdrawn, held, or the queue closed); the caller must not run it then. Until its message is
	 * persisted the input stays owned in the durable record, so a turn that never delivers it can give it back.
	 */
	promote(handle: PendingInputHandle): boolean {
		const entry = this._findEntry(handle.id);
		if (!entry || entry.admission || entry.held || this._closed) return false;
		if (!this._contextCurrent(entry)) {
			this._hold(entry, "context_changed");
			if (entry.kind === "steer") this._notifySteerDecision();
			return false;
		}
		this._removeEntry(entry);
		this._owned.push(entry);
		this.deps.ownerInputs.move(entry.inputId, "own_turn");
		this._admitInOrder();
		this._changed();
		if (entry.kind === "steer") this._notifySteerDecision();
		return true;
	}

	/**
	 * The delivered event (the ledger's): the user entry of this input is persisted. A run read it, or its own turn sent it;
	 * either way it leaves the durable record now. What its delivery decides runs in the ledger. No other point delivers.
	 */
	private _delivered(inputId: OwnerInputId): void {
		for (const entries of [this._awaitingPersistence, this._owned]) {
			const index = entries.findIndex((entry) => entry.inputId === inputId);
			if (index === -1) continue;
			entries.splice(index, 1);
			this._changed();
			return;
		}
	}

	/**
	 * The turn that took this input ended without delivering it (cancelled, closed, failed before its run): the
	 * input returns to the pending queue as held input, complete and visible, at its submission position. False
	 * when no turn owns it, which includes an input that was delivered.
	 */
	reclaim(handle: PendingInputHandle): boolean {
		const entry = this._owned.find((candidate) => candidate.id === handle.id);
		if (entry === undefined) return false;
		this._returnOwned(entry, "undelivered");
		return true;
	}

	/** An input its own turn took returns to the pending queue at its submission position, held for `reason`. */
	private _returnOwned(entry: PendingEntry, reason: PendingInputHoldReason): void {
		this._owned = this._owned.filter((candidate) => candidate !== entry);
		if (!this._closed) {
			const entries = entry.kind === "steer" ? this._steering : this._followUp;
			entries.push(entry);
			entries.sort((left, right) => left.id - right.id);
		}
		this._hold(entry, reason);
		this._changed();
		if (entry.kind === "steer") this._notifySteerDecision();
	}

	/** Keep an input whose context changed: complete, pending and recoverable, never handed on. */
	hold(handle: PendingInputHandle): void {
		const entry = this._findEntry(handle.id);
		if (entry && !entry.message && !entry.held) this._hold(entry, "context_changed");
		this._admitInOrder();
		if (entry?.kind === "steer") this._notifySteerDecision();
	}

	/** Drop a registered input that will not be admitted (cancelled, handled, refused), ending it as `end` says. A
	 * decided or held input is never withdrawn: it keeps its place in the queue. */
	withdraw(handle: PendingInputHandle, end: OwnerInputEnd): boolean {
		const entry = this._findEntry(handle.id);
		if (!entry || entry.admission || entry.held) return false;
		this._removeEntry(entry);
		entry.abort.abort(PENDING_INPUT_WITHDRAWN);
		this.deps.ownerInputs.end(entry.inputId, end);
		this._admitInOrder();
		this._changed();
		if (entry.kind === "steer") this._notifySteerDecision();
		return true;
	}

	/**
	 * An owner interrupt: every input whose admission is still undecided is cancelled, each with its one notice carrying its
	 * full text (nothing keeps it after this). Decided and held inputs keep their place.
	 */
	cancelAwaiting(): void {
		let removed = false;
		for (const entry of [...this._steering, ...this._followUp]) {
			if (entry.admission || entry.held) continue;
			this._removeEntry(entry);
			entry.abort.abort(PENDING_INPUT_WITHDRAWN);
			this.deps.ownerInputs.end(entry.inputId, { state: "cancelled", reason: "interrupted" });
			this.deps.onInputCancelled?.(this._ownerVisibleOriginal(entry));
			removed = true;
		}
		this._admitInOrder();
		if (removed) {
			this._changed();
			this._notifySteerDecision();
		}
	}

	/**
	 * The session is disposed: every input not yet handed to the agent is held (whatever still decides its admission is
	 * cancelled), complete and visible, and nothing is handed on afterwards. The durable record is not rewritten, so a
	 * resumed session restores them held. Input the agent already holds is held by the run that ends with the session.
	 */
	close(): void {
		this._closed = true;
		activeControllers.delete(this);
		this._steerListeners.clear();
		this._notifySteerDecision();
		this._steerDecisionListeners.clear();
		for (const entry of [...this._steering, ...this._followUp]) {
			if (!entry.message && !entry.held) this._hold(entry, "closed");
		}
	}

	/**
	 * The session's context changed (a branch navigation): every input accepted in the old context and
	 * not yet consumed is held, complete, including one already handed to the agent -- that exact
	 * message is withdrawn from the agent's queue, every other queued message keeps its place. Input a
	 * run already consumed belongs to that run's history and is left alone.
	 */
	reconcileContext(): void {
		for (const entry of [...this._steering, ...this._followUp]) {
			if (entry.held || this._contextCurrent(entry)) continue;
			if (entry.message && !this._takeBackFromAgent(entry)) continue;
			this._hold(entry, "context_changed");
		}
		// An input its own turn took and has not delivered is held too. Its turn's preparation and its run refuse a navigation
		// (`ForegroundRecoveryController.beginHistoryRewrite`), so this is a turn past its run that never persisted it.
		for (const entry of [...this._owned]) {
			if (!this._contextCurrent(entry)) this._returnOwned(entry, "context_changed");
		}
		this._admitInOrder();
		this._notifySteerDecision();
	}

	/**
	 * Input admitted to the agent's queue that no further round will deliver (its run ended without a
	 * consumer): that exact message is withdrawn from the agent's queue and the input is held, complete,
	 * in the pending queue. Every other queued message keeps its place.
	 */
	holdUndelivered(): void {
		for (const entry of [...this._steering, ...this._followUp]) {
			if (entry.held || !entry.message || !this._takeBackFromAgent(entry)) continue;
			this._hold(entry, "undelivered");
		}
	}

	/** Withdraws the entry's exact message from the agent's queue and returns the input to its submitted form; false when the agent no longer holds it. */
	private _takeBackFromAgent(entry: PendingEntry): boolean {
		if (!entry.message || !this.deps.agent.withdrawQueuedMessage(entry.message)) return false;
		this._retractEcho(entry);
		entry.message = undefined;
		entry.text = entry.original.text;
		entry.images = entry.original.images;
		return true;
	}

	private _contextCurrent(entry: PendingEntry): boolean {
		return !entry.context || (this.deps.isInputContextCurrent?.(entry.context) ?? true);
	}

	/** An input whose message the transcript shows (a run read it, then dropped it unpersisted) leaves undelivered. */
	private _retractEcho(entry: PendingEntry): void {
		if (!entry.displayed || !entry.message) return;
		entry.displayed = false;
		this.deps.onUndeliveredEchoWithdrawn?.(entry.message);
	}

	/** The input as submitted, a framed third-party message shown as the owner sees it. */
	private _ownerVisibleOriginal(entry: PendingEntry): QueuedInput {
		return entry.origin
			? { ...entry.original, text: ownerVisibleQueuedText(entry.origin.text, entry.origin) }
			: { ...entry.original };
	}

	/** Keep the input for its owner: what decides its admission is cancelled, it ends held in the ledger, and its one notice is given. */
	private _hold(entry: PendingEntry, reason: PendingInputHoldReason): void {
		entry.held = true;
		entry.abort.abort(PENDING_INPUT_WITHDRAWN);
		this.deps.ownerInputs.end(entry.inputId, { state: "held", reason });
		this.deps.onInputHeld?.(this._ownerVisibleOriginal(entry), reason);
	}

	private _findEntry(id: number): PendingEntry | undefined {
		return this._steering.find((entry) => entry.id === id) ?? this._followUp.find((entry) => entry.id === id);
	}

	private _removeEntry(entry: PendingEntry): void {
		this._steering = this._steering.filter((candidate) => candidate !== entry);
		this._followUp = this._followUp.filter((candidate) => candidate !== entry);
	}

	/**
	 * Each kind's decided inputs, up to the first one still awaiting its decision, go to the agent's queue while a run
	 * consumes it. With none, they wait admitted, and the foreground owner hands them to the next run that consumes, or
	 * starts a delivery run for them once the foreground is idle: no admitted input waits on a queue no run reads.
	 */
	private _admitInOrder(): void {
		if (this._closed) return;
		if (this._foreground && !this._foreground.hasLiveConsumer) {
			this._foreground.noteInputWaiting();
			return;
		}
		this.handOff();
	}

	/** Whether a decided input waits to be handed: the next input of its kind, every earlier one handed or held. */
	hasHandableInput(): boolean {
		if (this._closed) return false;
		for (const entries of [this._steering, this._followUp]) {
			const next = entries.find((entry) => !entry.message && !entry.held);
			if (next?.admission) return true;
		}
		return false;
	}

	/** Enqueue each kind's decided inputs up to the first one still awaiting its decision: a run consumes the agent's queue. */
	handOff(): void {
		if (this._closed) return;
		for (const [entries, enqueue] of [
			[
				this._steering,
				(message: AgentMessage) => {
					this.deps.agent.steer(message);
					this._notifySteerQueued();
				},
			],
			[this._followUp, (message: AgentMessage) => this.deps.agent.followUp(message)],
		] as const) {
			for (const entry of entries) {
				if (entry.message || entry.held) continue;
				const admission = entry.admission;
				if (!admission) break;
				// The handoff to the agent is the delivery point: the input's context is checked here.
				if (!this._contextCurrent(entry)) {
					this._hold(entry, "context_changed");
					continue;
				}
				entry.text = admission.text;
				entry.images = admission.images;
				entry.message = this._createQueuedUserMessage(
					entry.inputId,
					admission.text,
					admission.images,
					admission.queuedGoalAuthority,
					admission.ownerOriginalText,
				);
				this.deps.ownerInputs.move(entry.inputId, "handed");
				enqueue(entry.message);
			}
		}
	}

	/** The delivery run the foreground owner started for waiting input ended: a goal one of its inputs started ends with it. */
	deliveryRunEnded(): void {
		this.deps.goals.endQueuedOwnerChatGoalExecution();
	}

	/** Queue an extension command to execute after the current agent run. */
	queueExtensionCommand(text: string): void {
		this._queuedExtensionCommands.push(text);
	}

	/** Pop the next queued extension command, if any. Caller is responsible for the isStreaming gate. */
	shiftCommand(): string | undefined {
		return this._closed ? undefined : this._queuedExtensionCommands.shift();
	}

	/**
	 * A user message started: a run read it. The admitted input whose identity it carries (its stamp, never its text: a
	 * same-text prompt or a host halt message reads no queued input) leaves the pending queue, so it is no longer displayed,
	 * taken back or held, and waits for its user entry to be persisted, which delivers it. It stays in the durable record
	 * until then; the record's content is unchanged by this move, so nothing is written. Returns whether the queue changed.
	 */
	noteRead(message: AgentMessage): boolean {
		const inputId = ownerInputIdOf(message);
		if (inputId === undefined) return false;
		// Only an input handed to the agent can be read; its identity is the whole match.
		const entry = [...this._steering, ...this._followUp].find(
			(candidate) => candidate.inputId === inputId && candidate.message !== undefined,
		);
		if (!entry) return false;
		this._removeEntry(entry);
		entry.displayed = true;
		this._awaitingPersistence.push(entry);
		return true;
	}

	/**
	 * A routed turn dropped messages it never persisted (an escalation or a throw). Each input among them that a run read
	 * returns to its queue at its submission position, still admitted, and to the agent's queue in submission order ahead of
	 * every later input of its kind, so the next run (the escalation's retry) reads it again; with no run left it is held as
	 * undelivered, like any input no round delivered. Returns whether the queue changed.
	 */
	returnUnpersisted(messages: readonly AgentMessage[]): boolean {
		if (this._closed) return false;
		const dropped = new Set(messages.flatMap((message) => ownerInputIdOf(message) ?? []));
		const returned = this._awaitingPersistence.filter((entry) => dropped.has(entry.inputId));
		if (returned.length === 0) return false;
		this._awaitingPersistence = this._awaitingPersistence.filter((entry) => !dropped.has(entry.inputId));
		for (const kind of ["steer", "followUp"] as const) {
			const back = returned.filter((entry) => entry.kind === kind);
			if (back.length === 0) continue;
			const entries = kind === "steer" ? this._steering : this._followUp;
			entries.push(...back);
			entries.sort((left, right) => left.id - right.id);
			// The agent's queue is rebuilt for this kind in submission order: every later input still queued there is taken out
			// and handed back after the returned ones. Messages that are not pending input (host turns) keep their place.
			const handed = entries.flatMap((entry) => (entry.message !== undefined && !entry.held ? [entry.message] : []));
			for (const message of handed) this.deps.agent.withdrawQueuedMessage(message);
			for (const message of handed) {
				if (kind === "steer") this.deps.agent.steer(message);
				else this.deps.agent.followUp(message);
			}
			if (kind === "steer") this._notifySteerQueued();
		}
		return true;
	}

	/**
	 * Take every queued steering and follow-up message, images included, out of both this
	 * controller and the agent's queue, by identity: a host turn queued on the agent is not an input and keeps its place.
	 * Extension commands stay queued: they execute against the session, not as prompt text.
	 */
	takeMessages(): { steering: QueuedInput[]; followUp: QueuedInput[] } {
		const taken = {
			steering: this._takeEntries("steer", "taken back"),
			followUp: this._takeEntries("followUp", "taken back"),
		};
		this._changed();
		// A steer taken back while its admission was undecided ends that decision: its waiter wakes now, not at the deadline.
		this._notifySteerDecision();
		return taken;
	}

	/** Take every queued input with its images, and every queued extension command, emptying all queues. */
	takeAll(): { steering: QueuedInput[]; followUp: QueuedInput[]; commands: string[] } {
		const commands = this._queuedExtensionCommands;
		this._queuedExtensionCommands = [];
		return { ...this.takeMessages(), commands };
	}

	/** Clear all three queues (each input's exact message withdrawn from the agent's queue) and return what was cleared. */
	clear(): PendingQueueSnapshot {
		const result = {
			steering: this._takeEntries("steer", "cleared").map((input) => input.text),
			followUp: this._takeEntries("followUp", "cleared").map((input) => input.text),
			commands: [...this.getCommands()],
		};
		this._queuedExtensionCommands = [];
		this._changed();
		this._notifySteerDecision();
		return result;
	}

	/**
	 * Take one kind's inputs back as the owner sees them (an admitted one in its delivered form), each withdrawn by identity:
	 * anything still deciding its admission is cancelled, and a handed input's exact message leaves the agent's queue. A
	 * handed input the agent no longer holds is a run's already and stays to be delivered: it is not taken.
	 */
	private _takeEntries(kind: "steer" | "followUp", reason: string): QueuedInput[] {
		const taken: QueuedInput[] = [];
		for (const entry of kind === "steer" ? [...this._steering] : [...this._followUp]) {
			const delivered = entry.message ? { text: entry.text, images: entry.images } : { ...entry.original };
			// A framed third-party message returns as what the owner saw, never as the extension's frame.
			const input = entry.origin ? { ...delivered, text: this._ownerText(entry) } : delivered;
			if (entry.message && !this._takeBackFromAgent(entry)) continue;
			entry.abort.abort(PENDING_INPUT_WITHDRAWN);
			this._removeEntry(entry);
			this.deps.ownerInputs.end(entry.inputId, { state: "withdrawn", reason });
			taken.push(input);
		}
		return taken;
	}
}
