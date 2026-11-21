/** Encodes long worker instructions and mail in the durable record that owns their delivery and retention. */
import { createHash } from "node:crypto";

export const MAX_WORKER_BRIEF_CHARS = 262_144;

export type WorkerBriefAttachment = {
	v: 1;
	encoding: "utf16le-base64";
	bytes: number;
	sha256: string;
	data: string;
};

function attachmentHeader(bytes: number, sha256: string) {
	return { v: 1, encoding: "utf16le-base64", bytes, sha256 } as const;
}

const maxBytes = MAX_WORKER_BRIEF_CHARS * 2;
const emptyHeaderBytes = JSON.stringify({ ...attachmentHeader(0, "0".repeat(64)), data: "" }).length - 1;

/** Exact compact JSON size, including the envelope, without encoding or hashing the body. */
export function workerBriefAttachmentBytes(textLength: number): number {
	const bytes = textLength * 2;
	return emptyHeaderBytes + String(bytes).length + 4 * Math.ceil(bytes / 3);
}

/** Run a record's own field projection with empty strings standing in for attached bodies.
 * Add the returned delta to the skeleton's compact JSON size to obtain exact wire bytes without hashing or encoding text. */
export function measureWorkerBriefFields<T>(project: (encode: typeof encodeWorkerBrief) => T) {
	let attachmentDeltaBytes = 0;
	const skeleton = project((text, inlineLimit) => {
		if (text.length <= inlineLimit) return text;
		attachmentDeltaBytes += workerBriefAttachmentBytes(text.length) - 2;
		return "";
	});
	return { skeleton, attachmentDeltaBytes };
}

export const MAX_WORKER_BRIEF_ATTACHMENT_BYTES = workerBriefAttachmentBytes(MAX_WORKER_BRIEF_CHARS);

export function encodeWorkerBrief(text: string, inlineLimit: number): string | WorkerBriefAttachment {
	if (text.length > MAX_WORKER_BRIEF_CHARS) throw new RangeError("Worker brief exceeds the attachment limit.");
	if (text.length <= inlineLimit) return text;
	const bytes = Buffer.from(text, "utf16le");
	return {
		...attachmentHeader(bytes.length, createHash("sha256").update(bytes).digest("hex")),
		data: bytes.toString("base64"),
	};
}

/** Short briefs stay inline. Reopened attachments must pass integrity checks before their contents reach a worker. */
export function decodeWorkerBrief(value: unknown, inlineLimit: number): string {
	if (typeof value === "string" && value.length <= inlineLimit) return value;
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid stored worker brief.");
	const body = value as Partial<WorkerBriefAttachment>;
	if (
		(Object.getPrototypeOf(body) !== Object.prototype && Object.getPrototypeOf(body) !== null) ||
		Reflect.ownKeys(body).length !== 5 ||
		!Object.hasOwn(body, "v") ||
		!Object.hasOwn(body, "encoding") ||
		!Object.hasOwn(body, "bytes") ||
		!Object.hasOwn(body, "data") ||
		!Object.hasOwn(body, "sha256") ||
		body.v !== 1 ||
		body.encoding !== "utf16le-base64" ||
		typeof body.bytes !== "number" ||
		!Number.isSafeInteger(body.bytes) ||
		body.bytes % 2 !== 0 ||
		body.bytes <= inlineLimit * 2 ||
		body.bytes > maxBytes ||
		typeof body.data !== "string" ||
		body.data.length !== 4 * Math.ceil(body.bytes / 3) ||
		typeof body.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/u.test(body.sha256)
	)
		throw new Error("Invalid worker brief attachment.");
	const bytes = Buffer.from(body.data, "base64");
	if (
		bytes.length !== body.bytes ||
		bytes.toString("base64") !== body.data ||
		createHash("sha256").update(bytes).digest("hex") !== body.sha256
	)
		throw new Error("Worker brief attachment failed integrity validation.");
	return bytes.toString("utf16le");
}
