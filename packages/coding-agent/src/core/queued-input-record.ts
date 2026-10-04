import type { ImageContent } from "@caupulican/pi-ai";
import type { SessionManager } from "../kernel/node.ts";
import type { SendUserMessageOrigin } from "./extensions/types.ts";
import type { SessionImageStore } from "./session-image-store.ts";
import { isPlainRecord } from "./util/value-guards.ts";

/**
 * The durable record of queued input (steering and follow-up messages not yet delivered), kept as a
 * session custom entry exactly like the human-input snapshots: each write is the complete queue as it
 * stands, and the latest entry on the active branch is the truth. A message leaves the record when it is
 * delivered, taken back to the editor or withdrawn, so a resumed session restores each exactly once.
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
 * One queued input as submitted: its kind, text and images. A message an extension framed around a third
 * party's words carries its origin, and `text` is then the third party's words as received, not the frame.
 */
export interface RecordableQueuedInput {
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

/** Stored image sequence per image object, so an image already retained is not written again per snapshot. */
const retainedSequences = new WeakMap<ImageContent, number>();

export interface QueuedInputRecordResult {
	/** The serialized record, for change detection by the caller. */
	readonly key: string;
	/** Inputs left out of the record because the count or byte bound was reached. */
	readonly omitted: number;
}

/**
 * Append the whole current queue as the latest record on the active branch, bounded in count and bytes
 * (the first inputs in submission order are kept). Returns undefined, writing nothing, when `previousKey`
 * already is the record that would be written.
 */
export function appendQueuedInputRecord(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	imageStore: Pick<SessionImageStore, "retainContent" | "pin" | "unpinExcept"> | undefined,
	inputs: readonly RecordableQueuedInput[],
	previousKey: string | undefined,
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
			let sequence = retainedSequences.get(image);
			let mimeType = image.mimeType;
			if (sequence === undefined) {
				if (!imageStore) throw new Error("Queued input carries an image but the session has no image store");
				const stored = imageStore.retainContent(image);
				sequence = stored.sequence;
				mimeType = stored.mimeType;
				retainedSequences.set(image, sequence);
			}
			images.push({ sequence, mimeType });
		}
		recorded.push({
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
	sessionManager.appendCustomEntry(QUEUED_INPUT_CUSTOM_TYPE, payload);
	if (imageStore && recordedSequences(previousKey).some((sequence) => !held.includes(sequence))) {
		imageStore.unpinExcept(held);
	}
	return { key, omitted: inputs.length - recorded.length };
}

/** The image sequences a serialized record names. */
function recordedSequences(key: string | undefined): number[] {
	if (key === undefined) return [];
	const parsed: unknown = JSON.parse(key);
	if (!isPlainRecord(parsed) || !Array.isArray(parsed.inputs)) return [];
	return (parsed.inputs as RecordedInput[]).flatMap((input) => input.images?.map((image) => image.sequence) ?? []);
}

function isRecordedInput(value: unknown): value is RecordedInput {
	if (!isPlainRecord(value)) return false;
	if ((value.kind !== "steer" && value.kind !== "followUp") || typeof value.text !== "string") return false;
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
	inputs: Array<{ kind: QueuedInputKind; text: string; images?: ImageContent[]; origin?: QueuedInputOrigin }>;
	/** Images the record names that the image store no longer holds. */
	missingImages: number;
	/** Why the restored images could not be pinned in the image store again; undefined when they were. */
	pinError?: string;
	/** The record as written, to seed change detection. */
	key: string;
}

/** The queued input recorded on the active branch, in submission order; undefined when none is recorded. */
export function readQueuedInputRecord(
	sessionManager: Pick<SessionManager, "getLatestCustomEntryOnBranch">,
	imageStore: Pick<SessionImageStore, "read" | "pin"> | undefined,
): RestoredQueuedInputs | undefined {
	const data = sessionManager.getLatestCustomEntryOnBranch(QUEUED_INPUT_CUSTOM_TYPE)?.data;
	if (
		!isPlainRecord(data) ||
		data.version !== 1 ||
		!Array.isArray(data.inputs) ||
		!data.inputs.every(isRecordedInput)
	) {
		return undefined;
	}
	const recorded = data.inputs as RecordedInput[];
	if (recorded.length === 0) return undefined;
	let missingImages = 0;
	const inputs = recorded.map((input) => {
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
			kind: input.kind,
			text: input.text,
			...(images.length > 0 ? { images } : {}),
			...(input.origin ? { origin: input.origin } : {}),
		};
	});
	// The record is live again in this process: refresh the pins it holds (and establish them for a record
	// written before images were pinned) so the images outlive the restored queue's time before delivery.
	let pinError: string | undefined;
	const held = recorded.flatMap((input) => input.images?.map((image) => image.sequence) ?? []);
	if (imageStore && held.length > 0) {
		try {
			imageStore.pin(held);
		} catch (error) {
			pinError = error instanceof Error ? error.message : String(error);
		}
	}
	return {
		inputs,
		missingImages,
		...(pinError ? { pinError } : {}),
		key: JSON.stringify({ version: 1, inputs: recorded }),
	};
}
