import { expect, it } from "vitest";
import {
	decodeWorkerBrief,
	encodeWorkerBrief,
	MAX_WORKER_BRIEF_ATTACHMENT_BYTES,
	MAX_WORKER_BRIEF_CHARS,
	measureWorkerBriefFields,
	workerBriefAttachmentBytes,
} from "../src/core/orchestration/worker-brief-attachment.ts";

it.each([4096, 16384])("keeps legacy inline strings through the %i-character cutoff", (limit) => {
	const text = "w".repeat(limit);
	const over = `${text}w`;
	expect(encodeWorkerBrief(text, limit)).toBe(text);
	expect(decodeWorkerBrief(text, limit)).toBe(text);
	expect(() => decodeWorkerBrief(over, limit)).toThrow();
	const attached = encodeWorkerBrief(over, limit);
	expect(typeof attached).toBe("object");
	expect(decodeWorkerBrief(JSON.parse(JSON.stringify(attached)), limit)).toBe(over);
});

it("preserves every UTF-16 code unit and charges the exact serialized size up to the maximum", () => {
	const alphabet = '\0"\\\ud800\n\udc00😀';
	for (const length of [4097, 10_048, 24_377, MAX_WORKER_BRIEF_CHARS]) {
		const text = alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);
		const stored = JSON.stringify(encodeWorkerBrief(text, 4096));
		expect(Buffer.byteLength(stored)).toBe(workerBriefAttachmentBytes(length));
		expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(MAX_WORKER_BRIEF_ATTACHMENT_BYTES);
		expect(decodeWorkerBrief(JSON.parse(stored), 4096)).toBe(text);
	}
	expect(() => encodeWorkerBrief("w".repeat(MAX_WORKER_BRIEF_CHARS + 1), 4096)).toThrow(RangeError);
});

it("refuses corrupted, noncanonical or unsupported attachments before releasing any text", () => {
	const body = encodeWorkerBrief("ww", 1);
	if (typeof body === "string") throw new Error("Expected an attachment");
	for (const change of [
		{ v: 2 },
		{ encoding: "utf8" },
		{ extra: true },
		{ bytes: 3 },
		{ bytes: 524_290 },
		{ sha256: "0".repeat(64) },
		{ data: body.data.slice(0, -2) },
		{ data: `${body.data.slice(0, -3)}B==` },
	]) {
		expect(() => decodeWorkerBrief({ ...body, ...change }, 1)).toThrow();
	}
	expect(() => decodeWorkerBrief(body, 2)).toThrow();
});

it("charges both long fields and the ordinary inline metadata in one persisted record", () => {
	const project = (encode: typeof encodeWorkerBrief) => ({
		message: encode("x".repeat(24_377), 4096),
		reply: encode("😀".repeat(10_048), 4096),
		label: encode("short\nlabel", 4096),
	});
	const { skeleton, attachmentDeltaBytes } = measureWorkerBriefFields(project);
	expect(Buffer.byteLength(JSON.stringify(skeleton)) + attachmentDeltaBytes).toBe(
		Buffer.byteLength(JSON.stringify(project(encodeWorkerBrief))),
	);
});
