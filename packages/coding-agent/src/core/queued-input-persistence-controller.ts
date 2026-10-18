/**
 * Queued owner-input admission, held-input warnings, durable session-entry persistence and image
 * pinning for undelivered steering/follow-up messages, and resume-time restoration notices.
 */

import type { ImageContent } from "@caupulican/pi-ai";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import type { OwnerInputEnd, OwnerInputId, OwnerInputLedger, OwnerInputOutcome } from "./owner-input-ledger.ts";
import type { PendingInputHoldReason, PendingInputQueueController } from "./pending-input-queue-controller.ts";
import { truncateWithEllipsis } from "./provider-tool-text.ts";
import { appendQueuedInputRecord, type RecordableQueuedInput, readQueuedInputRecord } from "./queued-input-record.ts";
import type { OwnerRequestClassificationOutcome } from "./session-edge-intent-controller.ts";
import type { SessionImageStore } from "./session-image-store.ts";

export interface QueuedInputPersistenceControllerDeps {
	getSessionManager(): SessionManager;
	getPendingQueue(): PendingInputQueueController;
	/** Each queued input's state and the effects its delivery has. */
	readonly ownerInputs: Pick<OwnerInputLedger, "move" | "whenDelivered" | "whenUndelivered">;
	getSessionImageStore(): SessionImageStore | undefined;
	isDisposed(): boolean;
	isStreaming(): boolean;
	/** The full classification of the owner's words, once, before they are admitted (`SessionEdgeIntentController.judgeOwnerRequest`). */
	judgeOwnerRequest(
		text: string,
		signal: AbortSignal | undefined,
		acceptedOrder: number | undefined,
	): Promise<OwnerRequestClassificationOutcome>;
	/** Delivered owner words join the owner-policy queue with that judgment (`SessionEdgeIntentController.enqueueOwnerWords`). */
	enqueueOwnerWords(
		text: string,
		acceptedOrder: number | undefined,
		judgment: OwnerRequestClassificationOutcome | undefined,
	): void;
	emitQueueUpdate(): void;
	emitWarning(message: string): void;
}

export class QueuedInputPersistenceController {
	private readonly deps: QueuedInputPersistenceControllerDeps;
	private queuedInputRecordKey: string | undefined;
	private queuedInputOmitted = 0;
	private restoredQueuedInputNotice: { head: string; tail: string } | undefined;

	constructor(deps: QueuedInputPersistenceControllerDeps) {
		this.deps = deps;
	}

	/**
	 * A queued owner input is pending from the moment it is submitted, in submission order, and is
	 * judged in full once, before it is admitted -- the same judgment a prompt queued behind a running
	 * turn receives. The judgment, its optional-tool intent included, becomes policy when the run delivers
	 * the input, in owner order, never when the input is taken back, cleared or held first: until then the
	 * intent is a staged candidate that writes nothing. A newer request supersedes only the judgment's
	 * optional-tool chain, never the input or its owner policy, which the owner-policy queue then judges
	 * alone; a cancellation (interrupt, take, clear, disposal, context change) ends it. `accepted` is the identity and
	 * owner order its words were accepted under (`PromptSubmissionController.acceptQueuedOwnerWords`), whose release when
	 * the input ends undelivered is already registered. Resolves with the input queued for delivery, or with how it ended.
	 */
	async admitQueuedOwnerInput(
		kind: "steer" | "followUp",
		text: string,
		images: ImageContent[] | undefined,
		accepted: { readonly inputId: OwnerInputId; readonly acceptedOrder: number },
	): Promise<OwnerInputOutcome> {
		const { inputId, acceptedOrder } = accepted;
		const outcome: { inputId: OwnerInputId; ended?: OwnerInputEnd } = { inputId };
		this.deps.ownerInputs.whenUndelivered(inputId, (end) => {
			outcome.ended = end;
		});
		const pendingQueue = this.deps.getPendingQueue();
		const pending = pendingQueue.register(kind, text, images, undefined, inputId);
		this.deps.emitQueueUpdate();
		let admitted = false;
		let failure: { readonly error: unknown } | undefined;
		try {
			const classified = await this.deps.judgeOwnerRequest(text, pending.signal, acceptedOrder);
			if ("cancelled" in classified && classified.cancelled) {
				if (classified.contextChanged) pendingQueue.hold(pending);
				return outcome;
			}
			// Taken back, held or cancelled while its judgment returned: it ended already.
			if (this.deps.isDisposed() || pending.signal.aborted) return outcome;
			this.deps.ownerInputs.move(inputId, "judged");
			// The owner's admitted words become policy when the run delivers them, never when they are taken back first.
			this.deps.ownerInputs.whenDelivered(inputId, () =>
				this.deps.enqueueOwnerWords(text, acceptedOrder, classified),
			);
			admitted = pendingQueue.admit(pending, {
				text: pendingQueue.prepareQueuedMessageText(text),
				images,
				ownerOriginalText: text,
			});
		} catch (error) {
			failure = { error };
			throw error;
		} finally {
			// An input that is never admitted ends here unless something already ended it (an interrupt, a take, a hold): its
			// judgment or its preparation failed, the session closed while it was judged, or its judgment was cancelled.
			if (!admitted) {
				const reason = failure
					? failure.error instanceof Error
						? failure.error.message
						: String(failure.error)
					: this.deps.isDisposed()
						? "the session closed"
						: "its judgment was cancelled";
				pendingQueue.withdraw(pending, { state: failure ? "refused" : "cancelled", reason });
			}
			this.deps.emitQueueUpdate();
		}
		return outcome;
	}

	/** A held queued input is kept in full in the pending queue, never sent elsewhere. */
	noteHeldQueuedInput(text: string, reason: PendingInputHoldReason): void {
		const preview = truncateWithEllipsis(text, 200);
		const disposed = reason === "closed" || this.deps.isDisposed();
		const why =
			reason === "context_changed"
				? "the session context changed before it was admitted"
				: disposed
					? "the session closed before it could be delivered"
					: "its turn ended before it could be delivered";
		// A closing session has no editor left to restore it to: the text is the record.
		const advice = disposed
			? "It is kept in full in the pending queue"
			: "It is kept in full in the pending queue; restore it to the editor to send it again";
		this.deps.emitWarning(`A queued message was not delivered because ${why}. ${advice}: ${preview}`);
	}

	/** An interrupt cancelled a queued input before its admission was decided: nothing keeps it, so its full text is the notice. */
	noteCancelledQueuedInput(text: string): void {
		this.deps.emitWarning(`An interrupt cancelled a queued message before it was admitted; it was not sent: ${text}`);
	}

	/**
	 * Keep the queue of undelivered steering and follow-up input in the session file, the same session-entry
	 * mechanism the human-input snapshots use, so a resumed session restores exactly what was still queued.
	 * A failed write is reported, never swallowed: the queue itself is unaffected.
	 */
	recordQueuedInput(inputs: readonly RecordableQueuedInput[]): void {
		const sessionManager = this.deps.getSessionManager();
		if (this.deps.isDisposed() || !sessionManager.isPersisted()) return;
		try {
			const written = appendQueuedInputRecord(
				sessionManager,
				this.deps.getSessionImageStore(),
				inputs,
				this.queuedInputRecordKey,
			);
			if (!written) return;
			this.queuedInputRecordKey = written.key;
			if (written.omitted > 0 && this.queuedInputOmitted === 0) {
				this.deps.emitWarning(
					`${written.omitted} queued message${written.omitted > 1 ? "s" : ""} beyond the durable record's bound will not survive a restart.`,
				);
			}
			this.queuedInputOmitted = written.omitted;
		} catch (error) {
			this.deps.emitWarning(
				`Queued input could not be recorded for restart recovery: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * A resumed session restores the queue its predecessor still held, as held pending input: visible in the
	 * queue display and takeable into the editor, never delivered on its own. The record already holds exactly
	 * these inputs, so nothing is written until the queue next changes.
	 */
	restoreRecordedQueuedInput(): void {
		const sessionManager = this.deps.getSessionManager();
		if (!sessionManager.isPersisted()) return;
		const restored = readQueuedInputRecord(sessionManager, this.deps.getSessionImageStore());
		if (!restored) return;
		this.deps.getPendingQueue().restore(restored.inputs);
		this.queuedInputRecordKey = restored.key;
		const fromPeers = restored.inputs.filter((input) => input.origin).length;
		this.restoredQueuedInputNotice = {
			head:
				`Restored ${restored.inputs.length} queued message${restored.inputs.length > 1 ? "s" : ""} from the previous run` +
				`${fromPeers > 0 ? ` (${fromPeers} from other senders, shown under who sent them)` : ""}`,
			tail:
				`${restored.missingImages > 0 ? ` (${restored.missingImages} attached image${restored.missingImages > 1 ? "s were" : " was"} no longer available)` : ""}` +
				`${restored.pinError ? `; its images could not be held against pruning: ${restored.pinError}` : ""}.`,
		};
	}

	/**
	 * The one-time notice for input restored on resume. `editor` (the interactive default) tells the user to take
	 * the held input back into the editor; `headless` is for hosts with no editor, where the input stays held.
	 */
	takeRestoredQueuedInputNotice(surface: "editor" | "headless" = "editor"): string | undefined {
		const notice = this.restoredQueuedInputNotice;
		this.restoredQueuedInputNotice = undefined;
		if (!notice) return undefined;
		return surface === "editor"
			? `${notice.head}; take them back into the editor to send them again${notice.tail}`
			: `${notice.head}; they are held, not delivered, and stay held for the next interactive session on this session (RPC: pendingMessageCount in get_state counts them, clear_queue drops them)${notice.tail}`;
	}

	/** Surface held restored input as a session warning for hosts with no editor (print, JSON, RPC), so it is never silent. */
	announceRestoredQueuedInput(): void {
		const notice = this.takeRestoredQueuedInputNotice("headless");
		if (notice) this.deps.emitWarning(notice);
	}

	async drainQueuedExtensionCommands(): Promise<void> {
		const pendingQueue = this.deps.getPendingQueue();
		while (pendingQueue.getCommands().length > 0 && !this.deps.isStreaming()) {
			const commandText = pendingQueue.shiftCommand()!;
			this.deps.emitQueueUpdate();
			await pendingQueue.tryExecuteExtensionCommand(commandText);
		}
	}
}
