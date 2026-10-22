import { randomUUID } from "node:crypto";
import type { ImageContent } from "@caupulican/pi-ai";
import { formatDimensionNote, resizeImage } from "../utils/image-resize.ts";
import { type ArtifactStore, isMissingArtifactMarker } from "./context/context-artifacts.ts";
import { hasOnlyKeys, isPlainRecord } from "./util/value-guards.ts";

const ARTIFACT_ID = /^[0-9a-f]{1,64}$/;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_INLINE_BASE64_BYTES = 4.5 * 1024 * 1024;

/** The task retains this bounded handle; image count never expands its terminal message. */
export interface BackgroundToolImageManifest {
	artifactId: string;
	count: number;
}

export function decodeBackgroundToolImageManifest(value: unknown): BackgroundToolImageManifest | undefined {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["artifactId", "count"]) ||
		typeof value.artifactId !== "string" ||
		!ARTIFACT_ID.test(value.artifactId) ||
		typeof value.count !== "number" ||
		!Number.isSafeInteger(value.count) ||
		value.count < 1
	)
		return undefined;
	return { artifactId: value.artifactId, count: value.count };
}

function decodeImage(value: unknown): ImageContent | undefined {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["type", "data", "mimeType"]) ||
		value.type !== "image" ||
		typeof value.data !== "string" ||
		value.data.length > MAX_SOURCE_BYTES ||
		typeof value.mimeType !== "string"
	)
		return undefined;
	const compact = value.data.trim();
	const mimeType = value.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (
		!compact ||
		compact.length % 4 === 1 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) ||
		!/^image\/[a-z0-9.+-]{1,100}$/.test(mimeType)
	)
		return undefined;
	const data = Buffer.from(compact, "base64").toString("base64");
	if (data.replace(/=+$/, "") !== compact.replace(/=+$/, "")) return undefined;
	return { type: "image", data, mimeType };
}

export interface BackgroundToolImageCapture {
	manifest: BackgroundToolImageManifest;
	/** Only for a failed terminal write; published task records retain their references. */
	discard(): void;
}

/** Persist originals before publishing any retrieval promise, including every image in a large result. */
export function captureBackgroundToolImages(
	store: ArtifactStore,
	images: readonly ImageContent[],
	owner: { sessionId: string; taskId: string; toolName: string },
): BackgroundToolImageCapture {
	const holder = `background-tool-images:${owner.sessionId}:${owner.taskId}:${randomUUID()}`;
	const retained: string[] = [];
	const discard = (): void => {
		for (const id of retained) store.removeReference(id, holder);
		store.cleanup();
	};
	try {
		const imageIds = images.map((image, index) => {
			const valid = decodeImage(image);
			if (!valid) throw new Error(`Invalid background image ${index + 1}`);
			const content = JSON.stringify({ version: 1, image: valid });
			if (Buffer.byteLength(content, "utf8") > MAX_SOURCE_BYTES)
				throw new Error(`Background image ${index + 1} exceeds the storage/retrieval size limit`);
			const { ref } = store.write({
				kind: "image",
				content,
				toolName: owner.toolName,
				sessionEntryId: `${owner.taskId}:image:${index + 1}`,
				createdAtTurn: 0,
				reproducible: false,
			});
			if (!store.addReference(ref.id, holder)) throw new Error("Image artifact could not be retained");
			retained.push(ref.id);
			return ref.id;
		});
		const content = JSON.stringify({ version: 1, images: imageIds });
		if (Buffer.byteLength(content, "utf8") > MAX_MANIFEST_BYTES)
			throw new Error("Background image manifest exceeds the storage/retrieval size limit");
		const { ref } = store.write({
			kind: "tool_output",
			content,
			toolName: owner.toolName,
			sessionEntryId: `${owner.taskId}:images`,
			createdAtTurn: 0,
			reproducible: false,
		});
		if (!store.addReference(ref.id, holder)) throw new Error("Image manifest could not be retained");
		retained.push(ref.id);
		return { manifest: { artifactId: ref.id, count: imageIds.length }, discard };
	} catch (error) {
		try {
			discard();
		} catch {
			// Storage failure must not replace the originating failure or publish an unowned handle.
		}
		throw error;
	}
}

export type BackgroundToolImageRead =
	| { found: true; image: ImageContent; note?: string }
	| { found: false; reason: string };

/** Read one original, with size admission before payload I/O and bounded image projection afterward. */
export async function readBackgroundToolImage(
	store: ArtifactStore,
	manifest: BackgroundToolImageManifest,
	imageIndex: number,
): Promise<BackgroundToolImageRead> {
	if (!Number.isSafeInteger(imageIndex) || imageIndex < 1 || imageIndex > manifest.count)
		return { found: false, reason: `imageIndex must be between 1 and ${manifest.count}.` };
	try {
		const manifestRef = store.readRef(manifest.artifactId);
		if (
			manifestRef?.kind !== "tool_output" ||
			!Number.isSafeInteger(manifestRef.byteLength) ||
			manifestRef.byteLength < 1 ||
			manifestRef.byteLength > MAX_MANIFEST_BYTES
		)
			return { found: false, reason: "Image manifest is unavailable or exceeds the retrieval size limit." };
		const storedManifest = store.read(manifest.artifactId, { maxBytes: MAX_MANIFEST_BYTES });
		if (isMissingArtifactMarker(storedManifest)) return { found: false, reason: "Image manifest is unavailable." };
		if (Buffer.byteLength(storedManifest.content, "utf8") > MAX_MANIFEST_BYTES)
			return { found: false, reason: "Image manifest exceeds the retrieval size limit." };
		const decoded: unknown = JSON.parse(storedManifest.content);
		if (
			!isPlainRecord(decoded) ||
			!hasOnlyKeys(decoded, ["version", "images"]) ||
			decoded.version !== 1 ||
			!Array.isArray(decoded.images) ||
			decoded.images.length !== manifest.count
		)
			return { found: false, reason: "Image manifest is corrupt." };
		const id: unknown = decoded.images[imageIndex - 1];
		if (typeof id !== "string" || !ARTIFACT_ID.test(id))
			return { found: false, reason: "Image reference is corrupt." };
		const ref = store.readRef(id);
		if (
			ref?.kind !== "image" ||
			!Number.isSafeInteger(ref.byteLength) ||
			ref.byteLength < 1 ||
			ref.byteLength > MAX_SOURCE_BYTES
		)
			return {
				found: false,
				reason: "Image is unavailable or exceeds the retrieval size limit; its stored original is unchanged.",
			};
		const record = store.read(id, { maxBytes: MAX_SOURCE_BYTES });
		if (isMissingArtifactMarker(record)) return { found: false, reason: "Image artifact is unavailable." };
		if (Buffer.byteLength(record.content, "utf8") > MAX_SOURCE_BYTES)
			return { found: false, reason: "Image exceeds the retrieval size limit; its stored original is unchanged." };
		const payload: unknown = JSON.parse(record.content);
		const image =
			isPlainRecord(payload) && hasOnlyKeys(payload, ["version", "image"]) && payload.version === 1
				? decodeImage(payload.image)
				: undefined;
		if (!image) return { found: false, reason: "Image artifact is corrupt." };
		if (image.data.length <= MAX_INLINE_BASE64_BYTES) return { found: true, image };
		const resized = await resizeImage(Buffer.from(image.data, "base64"), image.mimeType, {
			maxBytes: MAX_INLINE_BASE64_BYTES,
		});
		if (!resized)
			return { found: false, reason: "Image could not be resized for display; its stored original is unchanged." };
		return {
			found: true,
			image: { type: "image", data: resized.data, mimeType: resized.mimeType },
			note: formatDimensionNote(resized),
		};
	} catch {
		return { found: false, reason: "Image storage is inaccessible or corrupt." };
	}
}
