import type * as PhotonModule from "@silvia-odwyer/photon-node";
import type { PhotonImageType } from "./photon.ts";

type Photon = Pick<typeof PhotonModule, "PhotonImage" | "fliph" | "flipv">;

function readOrientationFromTiff(bytes: Uint8Array, tiffStart: number): number {
	if (tiffStart + 8 > bytes.length) return 1;

	const byteOrder = (bytes[tiffStart] << 8) | bytes[tiffStart + 1];
	if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return 1;
	const le = byteOrder === 0x4949;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const read16 = (pos: number): number => view.getUint16(pos, le);
	const read32 = (pos: number): number => view.getUint32(pos, le);
	if (read16(tiffStart + 2) !== 42) return 1;

	const ifdOffset = read32(tiffStart + 4);
	const ifdStart = tiffStart + ifdOffset;
	if (ifdOffset < 8 || ifdStart + 2 > bytes.length) return 1;

	const entryCount = read16(ifdStart);
	for (let i = 0; i < entryCount; i++) {
		const entryPos = ifdStart + 2 + i * 12;
		if (entryPos + 12 > bytes.length) return 1;

		if (read16(entryPos) === 0x0112) {
			if (read16(entryPos + 2) !== 3 || read32(entryPos + 4) !== 1) return 1;
			const value = read16(entryPos + 8);
			return value >= 1 && value <= 8 ? value : 1;
		}
	}

	return 1;
}

function findJpegTiffData(bytes: Uint8Array): Uint8Array | undefined {
	let offset = 2;
	while (offset < bytes.length - 1) {
		if (bytes[offset] !== 0xff) return undefined;
		const marker = bytes[offset + 1];
		if (marker === 0xff) {
			offset++;
			continue;
		}

		if (marker === 0xda || marker === 0xd9) return undefined;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			offset += 2;
			continue;
		}
		if (offset + 4 > bytes.length) return undefined;
		const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
		if (length < 2 || offset + 2 + length > bytes.length) return undefined;
		const segmentStart = offset + 4;
		if (marker === 0xe1 && length >= 8 && hasExifHeader(bytes, segmentStart))
			return bytes.subarray(segmentStart + 6, offset + 2 + length);
		offset += 2 + length;
	}

	return undefined;
}

/** PNG and WebP chunks use different length order/alignment, but share one bounded TIFF extraction path. */
function findChunkTiffData(bytes: Uint8Array, format: "png" | "webp"): Uint8Array | undefined {
	const png = format === "png";
	let offset = png ? 8 : 12;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	while (offset + 8 <= bytes.length) {
		const typeStart = offset + (png ? 4 : 0);
		const chunkId = String.fromCharCode(...bytes.subarray(typeStart, typeStart + 4));
		const chunkSize = view.getUint32(offset + (png ? 0 : 4), !png);
		const dataStart = offset + 8;
		const dataEnd = dataStart + chunkSize;
		if (dataEnd + (png ? 4 : chunkSize % 2) > bytes.length) return undefined;
		if (chunkId === (png ? "eXIf" : "EXIF")) {
			// Some WebP files have "Exif\0\0" prefix before the TIFF header
			const tiffStart = !png && chunkSize >= 6 && hasExifHeader(bytes, dataStart) ? dataStart + 6 : dataStart;
			return bytes.subarray(tiffStart, dataEnd);
		}
		offset = dataEnd + (png ? 4 : chunkSize % 2);
	}
	return undefined;
}

function hasExifHeader(bytes: Uint8Array, offset: number): boolean {
	return (
		bytes[offset] === 0x45 &&
		bytes[offset + 1] === 0x78 &&
		bytes[offset + 2] === 0x69 &&
		bytes[offset + 3] === 0x66 &&
		bytes[offset + 4] === 0x00 &&
		bytes[offset + 5] === 0x00
	);
}

function getExifOrientation(bytes: Uint8Array): number {
	let tiff: Uint8Array | undefined;

	// JPEG: starts with FF D8
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		tiff = findJpegTiffData(bytes);
	} else if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		tiff = findChunkTiffData(bytes, "png");
	}
	// WebP: starts with RIFF....WEBP
	else if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		tiff = findChunkTiffData(bytes, "webp");
	}

	return tiff ? readOrientationFromTiff(tiff, 0) : 1;
}

type DstIndexFn = (x: number, y: number, w: number, h: number) => number;

function rotate90(photon: Photon, image: PhotonImageType, dstIndex: DstIndexFn): PhotonImageType {
	const w = image.get_width();
	const h = image.get_height();
	const src = image.get_raw_pixels();
	const dst = new Uint8Array(src.length);

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const srcIdx = (y * w + x) * 4;
			const dstIdx = dstIndex(x, y, w, h) * 4;
			dst[dstIdx] = src[srcIdx];
			dst[dstIdx + 1] = src[srcIdx + 1];
			dst[dstIdx + 2] = src[srcIdx + 2];
			dst[dstIdx + 3] = src[srcIdx + 3];
		}
	}

	return new photon.PhotonImage(dst, h, w);
}

// Flip orientations mutate in-place. Rotations return a new image (caller must free the old one if different).
export function applyExifOrientation(
	photon: Photon,
	image: PhotonImageType,
	originalBytes: Uint8Array,
): PhotonImageType {
	const orientation = getExifOrientation(originalBytes);
	if (orientation === 1) return image;

	switch (orientation) {
		case 2:
			photon.fliph(image);
			return image;
		case 3:
			photon.fliph(image);
			photon.flipv(image);
			return image;
		case 4:
			photon.flipv(image);
			return image;
		case 5: {
			const rotated = rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));
			photon.fliph(rotated);
			return rotated;
		}
		case 6:
			return rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));
		case 7: {
			const rotated = rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);
			photon.fliph(rotated);
			return rotated;
		}
		case 8:
			return rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);
		default:
			return image;
	}
}
