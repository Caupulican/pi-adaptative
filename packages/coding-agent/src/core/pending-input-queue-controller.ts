import type { Agent } from "@caupulican/pi-agent-core/agent";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import type { ImageContent, TextContent } from "@caupulican/pi-ai";
import type { ExtensionRunner, SendUserMessageOrigin } from "./extensions/index.ts";
import type { GoalSessionController } from "./goals/goal-session-controller.ts";
import type { ExplicitGoalStartAuthority } from "./goals/natural-language-goal.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import {
	ownerVisibleQueuedText,
	type QueuedInputKind,
	type QueuedInputOrigin,
	type RecordableQueuedInput,
} from "./queued-input-record.ts";
import type { SkillVaultController } from "./skill-vault.ts";

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

/** The admitted form of a queued input: the text, images and owner evidence the agent receives. */
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
	/** Aborted when the input is taken, cleared or cancelled before admission. */
	readonly signal: AbortSignal;
}

interface PendingEntry extends QueuedInput {
	readonly id: number;
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
	/** Its context changed before it was handed on: kept in full for recovery, never handed on. */
	held?: boolean;
}

/** Abort reason of a pending input the operator took back, cleared or cancelled before admission. */
export const PENDING_INPUT_WITHDRAWN = new Error("The pending input was withdrawn before admission.");

export interface PendingInputQueueDeps {
	readonly agent: Agent;
	readonly skillVault: SkillVaultController;
	readonly goals: GoalSessionController;
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
	/**
	 * The set of queued inputs changed (an input arrived, was delivered, taken back or withdrawn). Each
	 * call carries the complete queue in submission order, as submitted: the durable record's content.
	 */
	onQueueChanged?(inputs: readonly RecordableQueuedInput[]): void;
}

/** Why an input was held instead of being handed on. */
export type PendingInputHoldReason = "context_changed" | "undelivered";

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
export class PendingInputQueueController {
	/** Submission order per kind; an entry admits only after every earlier entry of its kind. */
	private _steering: PendingEntry[] = [];
	private _followUp: PendingEntry[] = [];
	private _queuedExtensionCommands: string[] = [];
	private _nextEntryId = 1;
	/** Set at disposal: nothing is handed to the agent afterwards. */
	private _closed = false;
	private readonly deps: PendingInputQueueDeps;

	constructor(deps: PendingInputQueueDeps) {
		this.deps = deps;
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
		return this._queuedExtensionCommands;
	}

	snapshot(): PendingQueueSnapshot {
		return {
			steering: this.getSteering() as string[],
			followUp: this.getFollowUp() as string[],
			commands: [...this._queuedExtensionCommands],
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
		text: string,
		images: ImageContent[] | undefined,
		queuedGoalAuthority: ExplicitGoalStartAuthority | undefined,
		ownerOriginalText: string | undefined,
	): AgentMessage {
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }, ...(images ?? [])];
		const message: AgentMessage = { role: "user", content, timestamp: Date.now() };
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
	 */
	register(
		kind: "steer" | "followUp",
		text: string,
		images?: ImageContent[],
		origin?: SendUserMessageOrigin,
	): PendingInputHandle {
		const context = this.deps.getInputContext?.();
		const entry: PendingEntry = {
			id: this._nextEntryId++,
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
		return { id: entry.id, signal: entry.abort.signal };
	}

	/**
	 * Re-create inputs recorded by an earlier process as held pending inputs, in their recorded order:
	 * visible, takeable and editable, never handed to the agent on their own. No change is reported; the
	 * record they came from is already the durable truth.
	 */
	restore(
		inputs: ReadonlyArray<{
			kind: QueuedInputKind;
			text: string;
			images?: ImageContent[];
			origin?: QueuedInputOrigin;
		}>,
	): void {
		const context = this.deps.getInputContext?.();
		for (const input of inputs) {
			const abort = new AbortController();
			abort.abort(PENDING_INPUT_WITHDRAWN);
			const entry: PendingEntry = {
				id: this._nextEntryId++,
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
	}

	/** Report the complete queue, as submitted and in submission order, to the durable record. */
	private _changed(): void {
		if (!this.deps.onQueueChanged) return;
		const entries = [...this._steering, ...this._followUp].sort((left, right) => left.id - right.id);
		this.deps.onQueueChanged(
			entries.map((entry) => ({
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
		this._admitInOrder();
		return true;
	}

	/**
	 * The input runs as its own turn instead of joining the queue: ownership moves to that turn. Its
	 * signal is NOT aborted -- the turn is valid. False when the input is no longer pending here (taken,
	 * cleared, withdrawn, held, or the queue closed); the caller must not run it then.
	 */
	promote(handle: PendingInputHandle): boolean {
		const entry = this._findEntry(handle.id);
		if (!entry || entry.admission || entry.held || this._closed) return false;
		if (!this._contextCurrent(entry)) {
			this._hold(entry, "context_changed");
			return false;
		}
		this._removeEntry(entry);
		this._admitInOrder();
		this._changed();
		return true;
	}

	/** Keep an input whose context changed: complete, pending and recoverable, never handed on. */
	hold(handle: PendingInputHandle): void {
		const entry = this._findEntry(handle.id);
		if (entry && !entry.message && !entry.held) this._hold(entry, "context_changed");
		this._admitInOrder();
	}

	/** Drop a registered input that will not be admitted (cancelled, handled, or run as its own turn). A
	 * decided or held input is never withdrawn: it keeps its place in the queue. */
	withdraw(handle: PendingInputHandle): boolean {
		const entry = this._findEntry(handle.id);
		if (!entry || entry.admission || entry.held) return false;
		this._removeEntry(entry);
		entry.abort.abort(PENDING_INPUT_WITHDRAWN);
		this._admitInOrder();
		this._changed();
		return true;
	}

	/** Cancel every input whose admission is still undecided; decided and held inputs keep their place. */
	cancelAwaiting(): void {
		let removed = false;
		for (const entry of [...this._steering, ...this._followUp]) {
			if (entry.admission || entry.held) continue;
			this._removeEntry(entry);
			entry.abort.abort(PENDING_INPUT_WITHDRAWN);
			removed = true;
		}
		this._admitInOrder();
		if (removed) this._changed();
	}

	/**
	 * The session is disposed: every input not yet handed to the agent is cancelled and dropped, and
	 * nothing is handed on afterwards. Input the agent already holds is the agent's to discard.
	 */
	close(): void {
		this._closed = true;
		for (const entry of [...this._steering, ...this._followUp]) {
			if (entry.message) continue;
			this._removeEntry(entry);
			entry.abort.abort(PENDING_INPUT_WITHDRAWN);
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
			if (entry.message) {
				if (!this.deps.agent.withdrawQueuedMessage(entry.message)) continue;
				entry.message = undefined;
				entry.text = entry.original.text;
				entry.images = entry.original.images;
			}
			this._hold(entry, "context_changed");
		}
		this._admitInOrder();
	}

	/**
	 * Input admitted to the agent's queue that no further round will deliver (its run ended without a
	 * consumer): that exact message is withdrawn from the agent's queue and the input is held, complete,
	 * in the pending queue. Every other queued message keeps its place.
	 */
	holdUndelivered(): void {
		for (const entry of [...this._steering, ...this._followUp]) {
			if (entry.held || !entry.message) continue;
			if (!this.deps.agent.withdrawQueuedMessage(entry.message)) continue;
			entry.message = undefined;
			entry.text = entry.original.text;
			entry.images = entry.original.images;
			this._hold(entry, "undelivered");
		}
	}

	private _contextCurrent(entry: PendingEntry): boolean {
		return !entry.context || (this.deps.isInputContextCurrent?.(entry.context) ?? true);
	}

	private _hold(entry: PendingEntry, reason: PendingInputHoldReason): void {
		entry.held = true;
		entry.abort.abort(PENDING_INPUT_WITHDRAWN);
		this.deps.onInputHeld?.(
			entry.origin
				? { ...entry.original, text: ownerVisibleQueuedText(entry.origin.text, entry.origin) }
				: { ...entry.original },
			reason,
		);
	}

	private _findEntry(id: number): PendingEntry | undefined {
		return this._steering.find((entry) => entry.id === id) ?? this._followUp.find((entry) => entry.id === id);
	}

	private _removeEntry(entry: PendingEntry): void {
		this._steering = this._steering.filter((candidate) => candidate !== entry);
		this._followUp = this._followUp.filter((candidate) => candidate !== entry);
	}

	/** Enqueue each kind's decided inputs up to the first one still awaiting its decision. */
	private _admitInOrder(): void {
		if (this._closed) return;
		for (const [entries, enqueue] of [
			[this._steering, (message: AgentMessage) => this.deps.agent.steer(message)],
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
					admission.text,
					admission.images,
					admission.queuedGoalAuthority,
					admission.ownerOriginalText,
				);
				enqueue(entry.message);
			}
		}
	}

	/** Queue an extension command to execute after the current agent run. */
	queueExtensionCommand(text: string): void {
		this._queuedExtensionCommands.push(text);
	}

	/** Pop the next queued extension command, if any. Caller is responsible for the isStreaming gate. */
	shiftCommand(): string | undefined {
		return this._queuedExtensionCommands.shift();
	}

	/**
	 * Remove a delivered message from whichever queue currently holds it (steering checked first,
	 * matching prior behavior). Returns which queue it was removed from, or undefined if it was not
	 * queued -- callers use that to decide whether a queue_update event is warranted.
	 */
	removeIfPending(messageText: string, message?: AgentMessage): "steering" | "followUp" | undefined {
		// Only an admitted input can be delivered; the exact queued message wins over equal text.
		for (const [entries, queue] of [
			[this._steering, "steering"],
			[this._followUp, "followUp"],
		] as const) {
			const exact = message ? entries.findIndex((entry) => entry.message === message) : -1;
			if (exact !== -1) {
				entries.splice(exact, 1);
				this._changed();
				return queue;
			}
		}
		for (const [entries, queue] of [
			[this._steering, "steering"],
			[this._followUp, "followUp"],
		] as const) {
			const index = entries.findIndex((entry) => entry.message !== undefined && entry.text === messageText);
			if (index !== -1) {
				entries.splice(index, 1);
				this._changed();
				return queue;
			}
		}
		return undefined;
	}

	/**
	 * Take every queued steering and follow-up message, images included, out of both this
	 * controller and the agent's mirrored queues. Extension commands stay queued: they execute
	 * against the session, not as prompt text.
	 */
	takeMessages(): { steering: QueuedInput[]; followUp: QueuedInput[] } {
		const taken = { steering: this._takeEntries(this._steering), followUp: this._takeEntries(this._followUp) };
		this._steering = [];
		this._followUp = [];
		this.deps.agent.clearAllQueues();
		this._changed();
		return taken;
	}

	/** Take every queued input with its images, and every queued extension command, emptying all queues. */
	takeAll(): { steering: QueuedInput[]; followUp: QueuedInput[]; commands: string[] } {
		const commands = this._queuedExtensionCommands;
		this._queuedExtensionCommands = [];
		return { ...this.takeMessages(), commands };
	}

	/** Clear all three queues (including the agent's own mirrored queues) and return what was cleared. */
	clear(): PendingQueueSnapshot {
		const result = this.snapshot();
		this._takeEntries(this._steering);
		this._takeEntries(this._followUp);
		this._steering = [];
		this._followUp = [];
		this._queuedExtensionCommands = [];
		this.deps.agent.clearAllQueues();
		this._changed();
		return result;
	}

	/** The inputs as submitted; anything still deciding an input's admission is cancelled. */
	private _takeEntries(entries: readonly PendingEntry[]): QueuedInput[] {
		return entries.map((entry) => {
			if (!entry.message) entry.abort.abort(PENDING_INPUT_WITHDRAWN);
			const input = entry.message ? { text: entry.text, images: entry.images } : { ...entry.original };
			// A framed third-party message returns as what the owner saw, never as the extension's frame.
			return entry.origin ? { ...input, text: this._ownerText(entry) } : input;
		});
	}
}
