import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import type { ImageContent } from "@caupulican/pi-ai";
import type { SessionEntry, SessionManager } from "../kernel/node.ts";
import type { SendUserMessageOrigin } from "./extensions/types.ts";
import { isImagePinClaimId, type SessionImageStore } from "./session-image-store.ts";
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
	preservedImages?: PreservedQueuedImages;
}

interface RecordedImage {
	sequence: number;
	mimeType: string;
	/** Exact filename; absent only in older records. */
	name?: string;
}

/** Exact storage references retained when image bytes are temporarily unreadable during restore. */
export interface PreservedQueuedImages {
	readonly images: readonly RecordedImage[];
	readonly pinClaim?: string;
}

/** Resolve every preserved image before its queue owner releases the durable input. */
export function recoverQueuedImages(
	imageStore: Pick<SessionImageStore, "read"> | undefined,
	preserved: PreservedQueuedImages,
): ImageContent[] {
	return preserved.images.map((image) => {
		const restored = readRecordedImage(imageStore, image, preserved.pinClaim);
		if (!restored) throw new Error(`Queued image ${image.sequence} is unavailable.`);
		return restored.content;
	});
}

function readRecordedImage(
	imageStore: Pick<SessionImageStore, "read"> | undefined,
	image: RecordedImage,
	pinClaim: string | undefined,
): { content: ImageContent; name: string } | undefined {
	const stored = imageStore?.read(image.sequence, pinClaim, image.name);
	if (!stored) return undefined;
	const content: ImageContent = {
		type: "image",
		data: Buffer.from(stored.bytes).toString("base64"),
		mimeType: stored.mimeType,
	};
	retainedSequences.set(content, image.sequence);
	return { content, name: basename(stored.path) };
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
	pinClaim?: string;
}

/** Preferred sequence per image object; the receiving store always validates its scope and current bytes. */
const retainedSequences = new WeakMap<ImageContent, number>();

export interface QueuedInputRecordResult {
	/** The serialized record, for change detection by the caller. */
	readonly key: string;
	/** Inputs left out of the record because the count or byte bound was reached. */
	readonly omitted: number;
	/** Publication succeeded, but obsolete claim cleanup remains pending until expiry. */
	readonly cleanupError?: string;
}

/** History may share a claim with another branch; only this owner's publication may be released. */
export type QueuedInputRecordOwnership = "borrowed" | "owned";

interface RecordPublicationOptions {
	/** An unresolved main-history write still owns these input records and their image claims. */
	readonly preserveIds?: ReadonlySet<string>;
	/** Preparation can invoke image adapters; publication must still belong to its original record. */
	readonly assertCurrent?: () => void;
}

type RecordImageStore = Pick<
	SessionImageStore,
	"retainPinnedContent" | "retainPinnedReference" | "pin" | "sealPinClaim" | "releasePinClaim"
>;

/**
 * Append the whole current queue as the latest record on the active branch, bounded in count and bytes
 * (the first inputs in submission order are kept). Returns undefined, writing nothing, when `previousKey`
 * already describes an owned record. Borrowed history is always replaced without releasing its claim.
 * Every publication owns an independent image pin claim.
 */
export function appendQueuedInputRecord(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	imageStore: RecordImageStore | undefined,
	inputs: readonly RecordableQueuedInput[],
	previousKey: string | undefined,
	previousOwnership: QueuedInputRecordOwnership,
	options: RecordPublicationOptions = {},
): QueuedInputRecordResult | undefined {
	return writeRecord(
		imageStore,
		inputs,
		previousKey,
		(payload) => sessionManager.appendCustomEntry(QUEUED_INPUT_CUSTOM_TYPE, payload),
		previousOwnership,
		options,
	);
}

/** The own-turn input record of the session stored in `sessionFile`: a file beside it, never listed as a session. */
export function ownTurnInputRecordPath(sessionFile: string): string {
	return `${sessionFile}.own-turn-input.json`;
}

/**
 * Write the prompts whose own turn is being prepared as the own-turn record at `path`, replacing it atomically, or remove
 * the file once none is left; bounded, returned and pinned exactly as the queued record (`appendQueuedInputRecord`).
 */
export function writeOwnTurnInputRecord(
	path: string,
	imageStore: RecordImageStore | undefined,
	inputs: readonly RecordableQueuedInput[],
	previousKey: string | undefined,
	options: RecordPublicationOptions = {},
): QueuedInputRecordResult | undefined {
	return writeRecord(
		imageStore,
		inputs,
		previousKey,
		(payload, key) => {
			if (payload.inputs.length > 0) {
				writeFileAtomicSync(path, key);
				return;
			}
			try {
				unlinkSync(path);
			} catch (error) {
				if (!isMissingFileError(error)) throw error;
			}
		},
		"owned",
		options,
	);
}

/** Publish a bounded snapshot, skipping only unchanged owned records; borrowed history always gets a fresh record. */
function writeRecord(
	imageStore: RecordImageStore | undefined,
	inputs: readonly RecordableQueuedInput[],
	previousKey: string | undefined,
	write: (payload: QueuedInputPayload, key: string) => void,
	previousOwnership: QueuedInputRecordOwnership,
	options: RecordPublicationOptions,
): QueuedInputRecordResult | undefined {
	assertPreservedInputIds(inputs, options.preserveIds, "An unresolved input's recovery record cannot be removed.");
	const recorded: RecordedInput[] = [];
	const claimId = randomUUID();
	let hasPins = false;
	let publicationStarted = false;
	let textBytes = 0;
	let imageCount = 0;
	try {
		for (const input of inputs) {
			const bytes = Buffer.byteLength(input.text, "utf8");
			if (recorded.length >= MAX_RECORDED_QUEUED_INPUTS || textBytes + bytes > MAX_RECORDED_QUEUED_TEXT_BYTES) break;
			const count = input.preservedImages?.images.length ?? input.images?.length ?? 0;
			if (imageCount + count > MAX_RECORDED_QUEUED_IMAGES) break;
			imageCount += count;
			const images: RecordedImage[] = [];
			for (const image of input.preservedImages ? [] : (input.images ?? [])) {
				if (!imageStore) throw new Error("Queued input carries an image but the session has no image store");
				hasPins = true;
				const stored = imageStore.retainPinnedContent(claimId, image, retainedSequences.get(image));
				retainedSequences.set(image, stored.sequence);
				images.push({ sequence: stored.sequence, mimeType: stored.mimeType, name: basename(stored.path) });
			}
			for (const image of input.preservedImages?.images ?? []) {
				if (!imageStore) throw new Error("Restored image references require the session image store.");
				hasPins = true;
				const reference = imageStore.retainPinnedReference(
					claimId,
					image.sequence,
					image.mimeType,
					image.name,
					input.preservedImages?.pinClaim,
				);
				// Legacy identities are resolved once, before publication can retire the source claim.
				// These are private restoration copies, never the session's historical entry objects.
				image.name = reference.name;
				images.push(reference);
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
		assertPreservedInputIds(
			recorded,
			options.preserveIds,
			"An unresolved input exceeds the recovery record's bounds.",
		);
		const previous = previousKey === undefined ? undefined : recordedPayloadOf(JSON.parse(previousKey));
		const payload: QueuedInputPayload = { version: 1, inputs: recorded };
		const unchanged =
			previous !== undefined && JSON.stringify(payload) === JSON.stringify({ version: 1, inputs: previous.inputs });
		const held = recorded.flatMap((input) => input.images?.map((image) => image.sequence) ?? []);
		if (
			previousOwnership === "owned" &&
			((recorded.length === 0 && previousKey === undefined) ||
				(unchanged &&
					(held.length === 0 ||
						(previous.pinClaim !== undefined && imageStore?.pin(held, previous.pinClaim).length === 0))))
		) {
			if (hasPins) {
				hasPins = false;
				imageStore!.releasePinClaim(claimId);
			}
			return undefined;
		}
		if (hasPins) {
			imageStore!.sealPinClaim(claimId);
			payload.pinClaim = claimId;
		}
		const key = JSON.stringify(payload);
		options.assertCurrent?.();
		// After entering publication, an error may still leave the record durable. Keep its claim.
		publicationStarted = true;
		write(payload, key);
		let cleanupError: string | undefined;
		try {
			options.assertCurrent?.();
		} catch (error) {
			// The record is committed. A changed context retains the previous claim too;
			// it cannot turn this publication into a failed preparation or lose its key.
			cleanupError = error instanceof Error ? error.message : String(error);
		}
		if (cleanupError === undefined && previousOwnership === "owned" && imageStore && previous?.pinClaim) {
			try {
				imageStore.releasePinClaim(previous.pinClaim);
			} catch (error) {
				cleanupError = error instanceof Error ? error.message : String(error);
			}
		}
		return { key, omitted: inputs.length - recorded.length, ...(cleanupError ? { cleanupError } : {}) };
	} catch (error) {
		if (hasPins && !publicationStarted) {
			try {
				imageStore!.releasePinClaim(claimId);
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Queued image preparation and claim cleanup failed.");
			}
		}
		throw error;
	}
}

/** Validate protection with memory bounded by the existing record, even when the live queue is larger. */
function assertPreservedInputIds(
	inputs: readonly { id?: string }[],
	preserveIds: ReadonlySet<string> | undefined,
	message: string,
): void {
	if (!preserveIds?.size) return;
	const missing = new Set(preserveIds);
	for (const input of inputs) {
		if (input.id !== undefined) missing.delete(input.id);
		if (missing.size === 0) return;
	}
	throw new Error(message);
}

/** The inputs a serialized record names. */
function recordedInputs(key: string | undefined): RecordedInput[] {
	if (key === undefined) return [];
	const parsed: unknown = JSON.parse(key);
	return recordedPayloadOf(parsed)?.inputs ?? [];
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
					isPlainRecord(image) &&
					Number.isSafeInteger(image.sequence) &&
					typeof image.mimeType === "string" &&
					(image.name === undefined || typeof image.name === "string"),
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
		preservedImages?: PreservedQueuedImages;
	}>;
	/**
	 * Inputs the record names whose user entry is on the branch (in the session, for the own-turn record): delivered, by a
	 * process that stopped after persisting that entry and before rewriting the record. They are not among `inputs`; their
	 * images are neither read nor held.
	 */
	delivered: number;
	/** Images the restored inputs name that the image store no longer holds. */
	missingImages: number;
	/** A store read failed; text is still restored and the durable reference is left intact. */
	imageReadError?: string;
	/** Why the restored images could not be pinned in the image store again; undefined when they were. */
	pinError?: string;
	/** The record as written, to seed change detection. */
	key: string;
}

/** The selected branch's raw queue baseline, without reading images or filtering delivered input. */
export function readQueuedInputRecordKey(
	sessionManager: Pick<SessionManager, "getLatestCustomEntryOnBranch">,
): string | undefined {
	const payload = recordedPayloadOf(sessionManager.getLatestCustomEntryOnBranch(QUEUED_INPUT_CUSTOM_TYPE)?.data);
	return payload === undefined ? undefined : JSON.stringify(payload);
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
	const payload = recordedPayloadOf(sessionManager.getLatestCustomEntryOnBranch(QUEUED_INPUT_CUSTOM_TYPE)?.data);
	if (payload === undefined || payload.inputs.length === 0) return undefined;
	return restoreRecordedInputs(payload, payload.inputs, deliveredInputIds(sessionManager.getBranch()), imageStore);
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
	const payload = recordedPayloadOf(JSON.parse(text));
	if (payload === undefined) throw new Error(`${path} is not an own-turn input record`);
	const restorable = payload.inputs.filter((input) => input.id === undefined || !namedElsewhere.has(input.id));
	return restoreRecordedInputs(payload, restorable, deliveredInputIds(sessionManager.getEntries()), imageStore);
}

/** The inputs of a record's payload; undefined when `data` is no record. */
function recordedPayloadOf(data: unknown): QueuedInputPayload | undefined {
	if (!isPlainRecord(data) || data.version !== 1 || !Array.isArray(data.inputs)) return undefined;
	if (!data.inputs.every(isRecordedInput) || (data.pinClaim !== undefined && !isImagePinClaimId(data.pinClaim)))
		return undefined;
	return { version: 1, inputs: data.inputs, ...(data.pinClaim === undefined ? {} : { pinClaim: data.pinClaim }) };
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
	payload: QueuedInputPayload,
	restorable: readonly RecordedInput[],
	deliveredIds: ReadonlySet<string>,
	imageStore: Pick<SessionImageStore, "read" | "pin"> | undefined,
): RestoredQueuedInputs {
	const undelivered = restorable.filter((input) => input.id === undefined || !deliveredIds.has(input.id));
	let missingImages = 0;
	let imageReadError: string | undefined;
	let pinError: string | undefined;
	const held = undelivered.flatMap((input) => input.images?.map((image) => image.sequence) ?? []);
	if (imageStore && held.length > 0) {
		try {
			const refused = imageStore.pin(held, payload.pinClaim);
			if (refused.length > 0) pinError = `${refused.length} recorded image(s) could not be protected from pruning.`;
		} catch (error) {
			pinError = error instanceof Error ? error.message : String(error);
		}
	}
	const inputs = undelivered.map((input) => {
		const images: ImageContent[] = [];
		const preserved: RecordedImage[] = [];
		let readFailed = false;
		for (const image of input.images ?? []) {
			let restored: ReturnType<typeof readRecordedImage>;
			try {
				restored = readRecordedImage(imageStore, image, payload.pinClaim);
			} catch (error) {
				imageReadError ??= error instanceof Error ? error.message : String(error);
				readFailed = true;
				preserved.push({ ...image });
				continue;
			}
			if (!restored) {
				missingImages++;
				continue;
			}
			images.push(restored.content);
			preserved.push({ ...image, name: restored.name });
		}
		return {
			...(input.id === undefined ? {} : { id: input.id }),
			kind: input.kind,
			text: input.text,
			...(images.length > 0 ? { images } : {}),
			...(input.origin ? { origin: input.origin } : {}),
			...(readFailed
				? { preservedImages: { images: preserved, ...(payload.pinClaim ? { pinClaim: payload.pinClaim } : {}) } }
				: {}),
		};
	});
	return {
		inputs,
		delivered: restorable.length - undelivered.length,
		missingImages,
		...(imageReadError ? { imageReadError } : {}),
		...(pinError ? { pinError } : {}),
		key: JSON.stringify(payload),
	};
}
