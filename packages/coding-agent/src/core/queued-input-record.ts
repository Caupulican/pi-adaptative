import { readFileSync, unlinkSync } from "node:fs";
import type { ImageContent } from "@caupulican/pi-ai";
import type { SessionEntry, SessionManager } from "../kernel/node.ts";
import type { SendUserMessageOrigin } from "./extensions/types.ts";
import type { SessionImageStore } from "./session-image-store.ts";
import { isMissingFileError, writeFileAtomicSync } from "./util/atomic-file.ts";
import { isPlainRecord } from "./util/value-guards.ts";

/**
 * The durable record of queued input (steering and follow-up messages not yet delivered), kept as a
 * session custom entry exactly like the human-input snapshots: each write is the complete queue as it
 * stands, and the latest entry on the active branch is the truth. A message leaves the record when it is
 * delivered, taken back to the editor or withdrawn, so a resumed session restores each exactly once.
 *
 * The prompts whose own turn is being prepared (accepted, their user entry not persisted yet) have the same record in a
 * file beside the session file (`ownTurnInputRecordPath`), never in the session: an entry written before a turn's user
 * entry would become that entry's parent and change the branch. A resumed session restores them held, and from then on
 * the session record holds them like any held queued input.
 */
export const QUEUED_INPUT_CUSTOM_TYPE = "queued_owner_input";

/** Most inputs one record holds; later inputs stay queued in memory only. */
export const MAX_RECORDED_QUEUED_INPUTS = 64;
/** Most UTF-8 text bytes one record holds across all inputs. Images are held by the session image store, not the record. */
export const MAX_RECORDED_QUEUED_TEXT_BYTES = 256 * 1024;
/**
 * Most images one record holds. Every recorded image is pinned in the session image store against its
 * pruning, so this bounds what a queue can hold there; later inputs stay queued in memory only.
 */
export const MAX_RECORDED_QUEUED_IMAGES = 32;

export type QueuedInputKind = "steer" | "followUp";

/** Who a framed third-party message came from: the metadata the owner-visible form is rebuilt from. */
export type QueuedInputOrigin = Omit<SendUserMessageOrigin, "text">;

/**
 * One queued input as submitted: its identity, kind, text and images. A message an extension framed around a third
 * party's words carries its origin, and `text` is then the third party's words as received, not the frame. `id` is the
 * input's ledger identity: the user entry that delivers the input names it too (`SessionMessageEntry.ownerInputId`).
 */
export interface RecordableQueuedInput {
	id: string;
	kind: QueuedInputKind;
	text: string;
	images?: readonly ImageContent[];
	origin?: QueuedInputOrigin;
}

interface RecordedImage {
	sequence: number;
	mimeType: string;
}

interface RecordedInput {
	/** Absent only in a record written before inputs carried their identity. */
	id?: string;
	kind: QueuedInputKind;
	text: string;
	images?: RecordedImage[];
	origin?: QueuedInputOrigin;
}

/**
 * The owner-visible form of a queued input: its text, headed by who sent it when an extension framed a third
 * party's message. The sender label is self-declared by that party, so it is flattened to one bounded line.
 */
export function ownerVisibleQueuedText(text: string, origin: QueuedInputOrigin | undefined): string {
	if (!origin) return text;
	const line = (value: string, fallback: string): string =>
		value
			.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
			.trim()
			.slice(0, 80) || fallback;
	return `Message from ${line(origin.sender, "an unnamed sender")} via ${line(origin.channel, "an extension")} [${origin.verified ? "verified" : "UNVERIFIED"}]:\n${text}`;
}

interface QueuedInputPayload {
	version: 1;
	inputs: RecordedInput[];
}

/** Preferred sequence per image object; the receiving store always validates its scope and current bytes. */
const retainedSequences = new WeakMap<ImageContent, number>();

export interface QueuedInputRecordResult {
	/** The serialized record, for change detection by the caller. */
	readonly key: string;
	/** Inputs left out of the record because the count or byte bound was reached. */
	readonly omitted: number;
}

type RecordImageStore = Pick<SessionImageStore, "retainContent" | "pin" | "unpinExcept">;

/**
 * Append the whole current queue as the latest record on the active branch, bounded in count and bytes
 * (the first inputs in submission order are kept). Returns undefined, writing nothing, when `previousKey`
 * already is the record that would be written. `alsoHeld` are the image sequences the own-turn record names: their
 * pins are its own, never released here.
 */
export function appendQueuedInputRecord(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	imageStore: RecordImageStore | undefined,
	inputs: readonly RecordableQueuedInput[],
	previousKey: string | undefined,
	alsoHeld: readonly number[] = [],
): QueuedInputRecordResult | undefined {
	return writeRecord(imageStore, inputs, previousKey, alsoHeld, (payload) =>
		sessionManager.appendCustomEntry(QUEUED_INPUT_CUSTOM_TYPE, payload),
	);
}

/** The own-turn input record of the session stored in `sessionFile`: a file beside it, never listed as a session. */
export function ownTurnInputRecordPath(sessionFile: string): string {
	return `${sessionFile}.own-turn-input.json`;
}

/**
 * Write the prompts whose own turn is being prepared as the own-turn record at `path`, replacing it atomically, or remove
 * the file once none is left; bounded, returned and pinned exactly as the queued record (`appendQueuedInputRecord`), with
 * `alsoHeld` the image sequences the session's queued record names.
 */
export function writeOwnTurnInputRecord(
	path: string,
	imageStore: RecordImageStore | undefined,
	inputs: readonly RecordableQueuedInput[],
	previousKey: string | undefined,
	alsoHeld: readonly number[],
): QueuedInputRecordResult | undefined {
	return writeRecord(imageStore, inputs, previousKey, alsoHeld, (payload, key) => {
		if (payload.inputs.length > 0) {
			writeFileAtomicSync(path, key);
			return;
		}
		try {
			unlinkSync(path);
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
		}
	});
}

/** One bounded record write, through `write`; undefined, writing nothing, when it would not change `previousKey`. */
function writeRecord(
	imageStore: RecordImageStore | undefined,
	inputs: readonly RecordableQueuedInput[],
	previousKey: string | undefined,
	alsoHeld: readonly number[],
	write: (payload: QueuedInputPayload, key: string) => void,
): QueuedInputRecordResult | undefined {
	const recorded: RecordedInput[] = [];
	let textBytes = 0;
	let imageCount = 0;
	for (const input of inputs) {
		const bytes = Buffer.byteLength(input.text, "utf8");
		if (recorded.length >= MAX_RECORDED_QUEUED_INPUTS || textBytes + bytes > MAX_RECORDED_QUEUED_TEXT_BYTES) break;
		if (imageCount + (input.images?.length ?? 0) > MAX_RECORDED_QUEUED_IMAGES) break;
		imageCount += input.images?.length ?? 0;
		const images: RecordedImage[] = [];
		for (const image of input.images ?? []) {
			if (!imageStore) throw new Error("Queued input carries an image but the session has no image store");
			// Image objects can move between sessions or change after a prior snapshot. A cached
			// number is only a hint; retainContent owns current-store byte/MIME identity validation.
			const stored = imageStore.retainContent(image, retainedSequences.get(image));
			retainedSequences.set(image, stored.sequence);
			images.push({ sequence: stored.sequence, mimeType: stored.mimeType });
		}
		recorded.push({
			id: input.id,
			kind: input.kind,
			text: input.text,
			...(images.length > 0 ? { images } : {}),
			...(input.origin ? { origin: input.origin } : {}),
		});
		textBytes += bytes;
	}
	const payload: QueuedInputPayload = { version: 1, inputs: recorded };
	const key = JSON.stringify(payload);
	// Nothing queued and nothing recorded by this process: there is no record to clear.
	if (key === previousKey || (recorded.length === 0 && previousKey === undefined)) return undefined;
	// A recorded image is held against the store's pruning from before the record names it until after the
	// record stops naming it, so a record never points at an image the store may delete.
	const held = recorded.flatMap((input) => input.images?.map((image) => image.sequence) ?? []);
	if (held.length > 0) {
		if (!imageStore) throw new Error("Queued input carries an image but the session has no image store");
		imageStore.pin(held);
	}
	write(payload, key);
	if (imageStore && recordedSequences(previousKey).some((sequence) => !held.includes(sequence))) {
		imageStore.unpinExcept([...held, ...alsoHeld]);
	}
	return { key, omitted: inputs.length - recorded.length };
}

/** The inputs a serialized record names. */
function recordedInputs(key: string | undefined): RecordedInput[] {
	if (key === undefined) return [];
	const parsed: unknown = JSON.parse(key);
	if (!isPlainRecord(parsed) || !Array.isArray(parsed.inputs)) return [];
	return parsed.inputs as RecordedInput[];
}

/** The image sequences a serialized record names. */
export function recordedSequences(key: string | undefined): number[] {
	return recordedInputs(key).flatMap((input) => input.images?.map((image) => image.sequence) ?? []);
}

/** The input identities a serialized record names. */
export function recordedIds(key: string | undefined): Set<string> {
	return new Set(recordedInputs(key).flatMap((input) => (input.id === undefined ? [] : [input.id])));
}

function isRecordedInput(value: unknown): value is RecordedInput {
	if (!isPlainRecord(value)) return false;
	if ((value.kind !== "steer" && value.kind !== "followUp") || typeof value.text !== "string") return false;
	if (value.id !== undefined && typeof value.id !== "string") return false;
	if (
		value.origin !== undefined &&
		!(
			isPlainRecord(value.origin) &&
			typeof value.origin.channel === "string" &&
			typeof value.origin.sender === "string" &&
			typeof value.origin.verified === "boolean"
		)
	) {
		return false;
	}
	return (
		value.images === undefined ||
		(Array.isArray(value.images) &&
			value.images.every(
				(image) =>
					isPlainRecord(image) && Number.isSafeInteger(image.sequence) && typeof image.mimeType === "string",
			))
	);
}

export interface RestoredQueuedInputs {
	inputs: Array<{
		id?: string;
		kind: QueuedInputKind;
		text: string;
		images?: ImageContent[];
		origin?: QueuedInputOrigin;
	}>;
	/**
	 * Inputs the record names whose user entry is on the branch (in the session, for the own-turn record): delivered, by a
	 * process that stopped after persisting that entry and before rewriting the record. They are not among `inputs`; their
	 * images are neither read nor held.
	 */
	delivered: number;
	/** Images the restored inputs name that the image store no longer holds. */
	missingImages: number;
	/** Why the restored images could not be pinned in the image store again; undefined when they were. */
	pinError?: string;
	/** The record as written, to seed change detection. */
	key: string;
}

/**
 * The queued input recorded on the active branch and not yet delivered on it, in submission order; undefined when none
 * is recorded. An input is delivered on the branch when a user entry there names its identity
 * (`SessionMessageEntry.ownerInputId`).
 */
export function readQueuedInputRecord(
	sessionManager: Pick<SessionManager, "getLatestCustomEntryOnBranch" | "getBranch">,
	imageStore: Pick<SessionImageStore, "read" | "pin"> | undefined,
): RestoredQueuedInputs | undefined {
	const recorded = recordedInputsOf(sessionManager.getLatestCustomEntryOnBranch(QUEUED_INPUT_CUSTOM_TYPE)?.data);
	if (recorded === undefined || recorded.length === 0) return undefined;
	return restoreRecordedInputs(recorded, recorded, deliveredInputIds(sessionManager.getBranch()), imageStore);
}

/**
 * The own-turn record at `path` (`writeOwnTurnInputRecord`): the prompts it names that are not delivered, in submission
 * order; undefined when there is no such file. The file is no branch's content, so a prompt is delivered when any entry of
 * the session names its identity. A prompt in `namedElsewhere` (the identities the session's queued record names) is
 * restored from that record, never from here as well. A file that is not a record throws.
 */
export function readOwnTurnInputRecord(
	path: string,
	sessionManager: Pick<SessionManager, "getEntries">,
	imageStore: Pick<SessionImageStore, "read" | "pin"> | undefined,
	namedElsewhere: ReadonlySet<string>,
): RestoredQueuedInputs | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
	const recorded = recordedInputsOf(JSON.parse(text));
	if (recorded === undefined) throw new Error(`${path} is not an own-turn input record`);
	const restorable = recorded.filter((input) => input.id === undefined || !namedElsewhere.has(input.id));
	return restoreRecordedInputs(recorded, restorable, deliveredInputIds(sessionManager.getEntries()), imageStore);
}

/** The inputs of a record's payload; undefined when `data` is no record. */
function recordedInputsOf(data: unknown): RecordedInput[] | undefined {
	if (!isPlainRecord(data) || data.version !== 1 || !Array.isArray(data.inputs)) return undefined;
	return data.inputs.every(isRecordedInput) ? data.inputs : undefined;
}

/** The input identities the user entries among `entries` deliver (`SessionMessageEntry.ownerInputId`). */
function deliveredInputIds(entries: readonly SessionEntry[]): Set<string> {
	const deliveredIds = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.ownerInputId !== undefined) deliveredIds.add(entry.ownerInputId);
	}
	return deliveredIds;
}

/**
 * The `restorable` inputs of the record `recorded` that `deliveredIds` does not deliver, their images read back and pinned
 * again; the key is the whole record as written.
 */
function restoreRecordedInputs(
	recorded: readonly RecordedInput[],
	restorable: readonly RecordedInput[],
	deliveredIds: ReadonlySet<string>,
	imageStore: Pick<SessionImageStore, "read" | "pin"> | undefined,
): RestoredQueuedInputs {
	const undelivered = restorable.filter((input) => input.id === undefined || !deliveredIds.has(input.id));
	let missingImages = 0;
	const inputs = undelivered.map((input) => {
		const images: ImageContent[] = [];
		for (const image of input.images ?? []) {
			const stored = imageStore?.read(image.sequence);
			if (!stored) {
				missingImages++;
				continue;
			}
			const content: ImageContent = {
				type: "image",
				data: Buffer.from(stored.bytes).toString("base64"),
				mimeType: stored.mimeType,
			};
			retainedSequences.set(content, image.sequence);
			images.push(content);
		}
		return {
			...(input.id === undefined ? {} : { id: input.id }),
			kind: input.kind,
			text: input.text,
			...(images.length > 0 ? { images } : {}),
			...(input.origin ? { origin: input.origin } : {}),
		};
	});
	// The record is live again in this process: refresh the pins it holds (and establish them for a record
	// written before images were pinned) so the images outlive the restored queue's time before delivery.
	let pinError: string | undefined;
	const held = undelivered.flatMap((input) => input.images?.map((image) => image.sequence) ?? []);
	if (imageStore && held.length > 0) {
		try {
			imageStore.pin(held);
		} catch (error) {
			pinError = error instanceof Error ? error.message : String(error);
		}
	}
	return {
		inputs,
		delivered: restorable.length - undelivered.length,
		missingImages,
		...(pinError ? { pinError } : {}),
		key: JSON.stringify({ version: 1, inputs: recorded }),
	};
}
