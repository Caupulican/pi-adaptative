/**
 * Queued owner-input admission, held-input warnings, durable session-entry persistence and image
 * pinning for undelivered steering/follow-up messages, and resume-time restoration notices.
 */

import type { ImageContent } from "@caupulican/pi-ai";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import type { OwnerInputEnd, OwnerInputId, OwnerInputLedger, OwnerInputOutcome } from "./owner-input-ledger.ts";
import type {
	PendingInputHandle,
	PendingInputHoldReason,
	PendingInputQueueController,
	PendingInputRecord,
	QueuedInput,
} from "./pending-input-queue-controller.ts";
import { truncateWithEllipsis } from "./provider-tool-text.ts";
import {
	appendQueuedInputRecord,
	ownTurnInputRecordPath,
	type QueuedInputRecordOwnership,
	type QueuedInputRecordResult,
	type RecordableQueuedInput,
	type RestoredQueuedInputs,
	readOwnTurnInputRecord,
	readQueuedInputRecord,
	readQueuedInputRecordKey,
	recordedIds,
	recoverQueuedImages,
	writeOwnTurnInputRecord,
} from "./queued-input-record.ts";
import type { RuntimeMutationHandoff } from "./runtime-generation-admission.ts";
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
	/** Accept the owner's queued words, as a prompt's are, under the next owner submission order (`PromptSubmissionController`). */
	acceptQueuedOwnerWords(
		kind: "steer" | "followUp",
		text: string,
	): { readonly inputId: OwnerInputId; readonly acceptedOrder: number };
	emitQueueUpdate(): void;
	emitWarning(message: string): void;
}

/** A durable record as this process last wrote or restored it, and how many inputs its bound left out. */
interface RecordState {
	readonly key: string | undefined;
	readonly omitted: number;
	readonly ownership: QueuedInputRecordOwnership;
}

/** How each record's warnings read: what could not be recorded, and what its bound leaves out. */
const RECORD_TEXT = {
	queued: { subject: "Queued input", one: "queued message", many: "queued messages" },
	ownTurn: { subject: "A prompt being prepared", one: "prompt being prepared", many: "prompts being prepared" },
} as const;

export class QueuedInputPersistenceController implements PendingInputRecord {
	private readonly deps: QueuedInputPersistenceControllerDeps;
	/** The session's queued record (`appendQueuedInputRecord`). */
	private queuedRecord: RecordState = { key: undefined, omitted: 0, ownership: "borrowed" };
	/** Own-turn records retain their original file and image claims across session replacement. */
	private readonly ownTurnRecords = new Map<string, RecordState>();
	/** A replacement manager's clear fence does not settle a previous write to this file. */
	private readonly uncertainOwnTurnFiles = new Set<string>();
	private restoredQueuedInputNotice: { head: string; tail: string } | undefined;
	/** Why the own-turn record could not be restored on resume; reported with the restore notice. */
	private ownTurnRestoreFailure: string | undefined;

	constructor(deps: QueuedInputPersistenceControllerDeps) {
		this.deps = deps;
	}

	prepareInputForTake(input: QueuedInput): QueuedInput | undefined {
		if (!input.preservedImages) return input;
		try {
			return {
				text: input.text,
				images: recoverQueuedImages(this.deps.getSessionImageStore(), input.preservedImages),
			};
		} catch (error) {
			this.deps.emitWarning(
				`A message stays queued because its images could not be recovered: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	}

	/** History on the selected branch is borrowed. Its claim can still protect another parked branch. */
	beginBranch(): void {
		this.queuedRecord = {
			key: readQueuedInputRecordKey(this.deps.getSessionManager()),
			omitted: 0,
			ownership: "borrowed",
		};
	}

	/** Keep owner input that cannot be submitted yet as held, recorded pending input (`PendingInputQueueController.keep`). */
	keepQueuedInput(
		kind: "steer" | "followUp",
		text: string,
		images: ImageContent[] | undefined,
		existing: PendingInputHandle | undefined,
	): PendingInputHandle {
		const kept = this.deps.getPendingQueue().keep(kind, text, images, existing);
		this.deps.emitQueueUpdate();
		return kept;
	}

	/**
	 * A queued owner input is pending from the moment it is submitted, in submission order, and is
	 * judged in full once, before it is admitted -- the same judgment a prompt queued behind a running
	 * turn receives. The judgment, its optional-tool intent included, becomes policy when the run delivers
	 * the input, in owner order, never when the input is taken back, cleared or held first: until then the
	 * intent is a staged candidate that writes nothing. A newer request supersedes only the judgment's
	 * optional-tool chain, never the input or its owner policy, which the owner-policy queue then judges
	 * alone; a cancellation (interrupt, take, clear, disposal, context change) ends it. Its words are accepted first
	 * (`acceptQueuedOwnerWords`), with their release when the input ends undelivered registered. Resolves with the input
	 * queued for delivery, or with how it ended.
	 */
	async admitQueuedOwnerInput(
		kind: "steer" | "followUp",
		text: string,
		images: ImageContent[] | undefined,
	): Promise<OwnerInputOutcome> {
		const { inputId, acceptedOrder } = this.deps.acceptQueuedOwnerWords(kind, text);
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
		this.writeRecord("queued", (previousKey, imageStore, ownership, assertCurrent) =>
			appendQueuedInputRecord(sessionManager, imageStore, inputs, previousKey, ownership, { assertCurrent }),
		);
	}

	/**
	 * Keep the prompts whose own turn is being prepared (accepted, their user entry not persisted yet) in the own-turn record
	 * beside the session file, including before its first user entry. An unresolved history write cannot remove or truncate
	 * its previous recovery record. A failed write is reported; its previous record and image claim remain owned.
	 */
	recordOwnTurnInput(inputs: readonly RecordableQueuedInput[]): void {
		const sessionManager = this.deps.getSessionManager();
		const sessionFile = sessionManager.getSessionFile();
		if (this.deps.isDisposed() || !sessionManager.isPersisted() || sessionFile === undefined) return;
		const path = ownTurnInputRecordPath(sessionFile);
		if (sessionManager.isPersistenceStateUncertain()) this.uncertainOwnTurnFiles.add(sessionFile);
		const protectedAtStart = this.uncertainOwnTurnFiles.has(sessionFile);
		this.writeRecord(
			"ownTurn",
			(previousKey, imageStore, _ownership, assertCurrent) =>
				writeOwnTurnInputRecord(path, imageStore, inputs, previousKey, {
					assertCurrent: () => {
						if (sessionManager.isPersistenceStateUncertain()) this.uncertainOwnTurnFiles.add(sessionFile);
						assertCurrent();
						if (!protectedAtStart && this.uncertainOwnTurnFiles.has(sessionFile))
							throw new Error("Session write became uncertain while preparing its recovery record.");
					},
					...(protectedAtStart ? { preserveIds: recordedIds(previousKey) } : {}),
				}),
			sessionFile,
		);
	}

	keepsQueuedInput(inputId: OwnerInputId): boolean {
		return this.queuedRecord.ownership === "owned" && recordedIds(this.queuedRecord.key).has(inputId);
	}

	/** Retain the original file's recovery data even after navigation clears the manager's write fence. */
	noteUncertainHistory(sessionFile: string | undefined): void {
		if (sessionFile !== undefined) this.uncertainOwnTurnFiles.add(sessionFile);
	}

	keepsOwnTurnInput(inputId: OwnerInputId): boolean {
		const sessionFile = this.deps.getSessionManager().getSessionFile();
		return sessionFile !== undefined && recordedIds(this.ownTurnRecords.get(sessionFile)?.key).has(inputId);
	}

	/** One write of `record`: the record it wrote is kept, its bound reported once when first reached, a failure every time. */
	private writeRecord(
		record: "queued" | "ownTurn",
		write: (
			previousKey: string | undefined,
			imageStore: SessionImageStore | undefined,
			ownership: QueuedInputRecordOwnership,
			assertCurrent: () => void,
		) => QueuedInputRecordResult | undefined,
		sessionFile?: string,
	): void {
		const previousState = record === "queued" ? this.queuedRecord : this.ownTurnRecords.get(sessionFile!);
		const state: RecordState = previousState ?? { key: undefined, omitted: 0, ownership: "owned" };
		const sessionManager = this.deps.getSessionManager();
		const assertBranch = sessionManager.captureBranchContext();
		const assertCurrent = (): void => {
			if (this.deps.isDisposed() || this.deps.getSessionManager() !== sessionManager)
				throw new Error("Input recovery context changed during publication.");
			assertBranch();
			const current = record === "queued" ? this.queuedRecord : this.ownTurnRecords.get(sessionFile!);
			if (current !== previousState) throw new Error("Input recovery record changed during publication.");
		};
		const { subject, one, many } = RECORD_TEXT[record];
		try {
			const written = write(state.key, this.deps.getSessionImageStore(), state.ownership, assertCurrent);
			if (!written) return;
			// Publication is already committed. Diagnostics or obsolete-claim cleanup cannot leave this key stale.
			const published: RecordState = { key: written.key, omitted: written.omitted, ownership: "owned" };
			if (record === "queued") {
				try {
					assertCurrent();
					this.queuedRecord = published;
				} catch {
					this.deps.emitWarning("Queued input was recorded in its original context; the active record changed.");
				}
			} else if (this.ownTurnRecords.get(sessionFile!) === previousState) {
				if (recordedIds(written.key).size > 0) this.ownTurnRecords.set(sessionFile!, published);
				else this.ownTurnRecords.delete(sessionFile!);
			}
			if (written.omitted > 0 && state.omitted === 0) {
				this.deps.emitWarning(
					`${written.omitted} ${written.omitted > 1 ? many : one} beyond the durable record's bound will not survive a restart.`,
				);
			}
			if (written.cleanupError)
				this.deps.emitWarning(
					`${subject} was recorded, but an obsolete image claim could not be released: ${written.cleanupError}`,
				);
		} catch (error) {
			this.deps.emitWarning(
				`${subject} could not be recorded for restart recovery: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * A resumed session restores the queue its predecessor still held, as held pending input: visible in the
	 * queue display and takeable into the editor, never delivered on its own. An input the record names that was
	 * delivered (`RestoredQueuedInputs.delivered`) is not restored, and the record is rewritten once without it.
	 * Otherwise the record already holds exactly these inputs, and nothing is written until the queue next changes.
	 * The prompts the own-turn record names that were not delivered are restored the same way, after the queue: the queued
	 * record is rewritten once to name them, and the own-turn record is removed once it does.
	 */
	restoreRecordedQueuedInput(): void {
		const sessionManager = this.deps.getSessionManager();
		if (!sessionManager.isPersisted()) return;
		const sessionFile = sessionManager.getSessionFile();
		const assertCertain = (): void => {
			if (!sessionManager.isPersistenceStateUncertain()) return;
			if (sessionFile !== undefined) this.uncertainOwnTurnFiles.add(sessionFile);
			throw new Error("Unresolved session history cannot restore input as undelivered.");
		};
		assertCertain();
		const assertCurrent = sessionManager.captureBranchContext();
		const imageStore = this.deps.getSessionImageStore();
		const queued = readQueuedInputRecord(sessionManager, imageStore);
		const ownTurn = this.readOwnTurnRecord(recordedIds(queued?.key));
		assertCertain();
		if (this.deps.isDisposed() || this.deps.getSessionManager() !== sessionManager)
			throw new Error("Input recovery context changed during restoration.");
		assertCurrent();
		if (!queued && !ownTurn) return;
		// The records as written are what a rewrite replaces: change detection starts from them.
		this.queuedRecord = { key: queued?.key, omitted: 0, ownership: "borrowed" };
		if (sessionFile !== undefined && this.ownTurnRestoreFailure === undefined) {
			this.uncertainOwnTurnFiles.delete(sessionFile);
			if (ownTurn) this.ownTurnRecords.set(sessionFile, { key: ownTurn.key, omitted: 0, ownership: "owned" });
			else this.ownTurnRecords.delete(sessionFile);
		}
		const inputs = [...(queued?.inputs ?? []), ...(ownTurn?.inputs ?? [])];
		this.deps.getPendingQueue().restore(inputs, (queued?.delivered ?? 0) > 0 || ownTurn !== undefined);
		if (ownTurn) {
			const named = recordedIds(this.queuedRecord.key);
			if (ownTurn.inputs.every((input) => input.id !== undefined && named.has(input.id)))
				this.recordOwnTurnInput([]);
		}
		if (inputs.length === 0) return;
		const fromPeers = inputs.filter((input) => input.origin).length;
		const missingImages = (queued?.missingImages ?? 0) + (ownTurn?.missingImages ?? 0);
		const pinError = [queued?.pinError, ownTurn?.pinError].filter((error) => error !== undefined).join("; ");
		const imageReadError = [queued?.imageReadError, ownTurn?.imageReadError]
			.filter((error) => error !== undefined)
			.join("; ");
		const queuedCount = queued?.inputs.length ?? 0;
		const preparing = ownTurn?.inputs.length ?? 0;
		const restored = [
			...(queuedCount > 0 ? [`${queuedCount} queued message${queuedCount > 1 ? "s" : ""}`] : []),
			...(preparing > 0 ? [`${preparing} prompt${preparing > 1 ? "s that were" : " that was"} being prepared`] : []),
		].join(" and ");
		this.restoredQueuedInputNotice = {
			head:
				`Restored ${restored} from the previous run` +
				`${fromPeers > 0 ? ` (${fromPeers} from other senders, shown under who sent them)` : ""}`,
			tail:
				`${missingImages > 0 ? ` (${missingImages} attached image${missingImages > 1 ? "s were" : " was"} no longer available)` : ""}` +
				`${pinError ? `; its images could not be held against pruning: ${pinError}` : ""}` +
				`${imageReadError ? `; image storage could not be read: ${imageReadError}` : ""}.`,
		};
	}

	/** The own-turn record of the resumed session; a record that cannot be read is reported with the restore notice. */
	private readOwnTurnRecord(namedElsewhere: ReadonlySet<string>): RestoredQueuedInputs | undefined {
		const sessionManager = this.deps.getSessionManager();
		const sessionFile = sessionManager.getSessionFile();
		if (sessionFile === undefined) return undefined;
		const path = ownTurnInputRecordPath(sessionFile);
		this.ownTurnRestoreFailure = undefined;
		try {
			return readOwnTurnInputRecord(path, sessionManager, this.deps.getSessionImageStore(), namedElsewhere);
		} catch (error) {
			this.ownTurnRestoreFailure = `The prompts the previous run was preparing could not be restored from ${path}: ${error instanceof Error ? error.message : String(error)}.`;
			return undefined;
		}
	}

	/**
	 * The one-time notice for input restored on resume. `editor` (the interactive default) tells the user to take
	 * the held input back into the editor; `headless` is for hosts with no editor, where the input stays held.
	 */
	takeRestoredQueuedInputNotice(surface: "editor" | "headless" = "editor"): string | undefined {
		const notice = this.restoredQueuedInputNotice;
		const failure = this.ownTurnRestoreFailure;
		this.restoredQueuedInputNotice = undefined;
		this.ownTurnRestoreFailure = undefined;
		if (!notice) return failure;
		const restored =
			surface === "editor"
				? `${notice.head}; take them back into the editor to send them again${notice.tail}`
				: `${notice.head}; they are held, not delivered, and stay held for the next interactive session on this session (RPC: pendingMessageCount in get_state counts them, clear_queue drops them)${notice.tail}`;
		return failure ? `${restored} ${failure}` : restored;
	}

	/** Surface held restored input as a session warning for hosts with no editor (print, JSON, RPC), so it is never silent. */
	announceRestoredQueuedInput(): void {
		const notice = this.takeRestoredQueuedInputNotice("headless");
		if (notice) this.deps.emitWarning(notice);
	}

	async drainQueuedExtensionCommands(beginRuntimeHandoff?: () => RuntimeMutationHandoff): Promise<void> {
		const pendingQueue = this.deps.getPendingQueue();
		while (pendingQueue.getCommands().length > 0 && !this.deps.isStreaming()) {
			const commandText = pendingQueue.shiftCommand()!;
			this.deps.emitQueueUpdate();
			await pendingQueue.tryExecuteExtensionCommand(commandText, undefined, beginRuntimeHandoff);
		}
	}
}
