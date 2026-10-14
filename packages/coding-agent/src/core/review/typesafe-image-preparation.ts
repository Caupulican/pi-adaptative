import { createHash } from "node:crypto";
import { getImageDimensions } from "@caupulican/pi-tui";
import { applyExifOrientation } from "../../utils/exif-orientation.ts";
import { detectSupportedImageMimeType } from "../../utils/mime.ts";
import { loadPhoton, type PhotonImageType } from "../../utils/photon.ts";

export const MAX_SYSTEM_ONE_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_SYSTEM_ONE_IMAGES = 8;
export const SYSTEM_ONE_IMAGE_REFERENCE_PATTERN = "^<[A-Za-z][A-Za-z0-9_-]{0,63}>$";
export const SYSTEM_ONE_IMAGE_MAX_SIDE = 1568;
export const SYSTEM_ONE_IMAGE_REQUEST_BYTES = 32 * 1024 * 1024;

export interface ImageRectangle {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

export interface SystemOneImageGeometry {
	readonly original: { width: number; height: number };
	readonly upright: { width: number; height: number };
	readonly crop: ImageRectangle;
	readonly resized: { width: number; height: number };
	readonly prepared: { width: number; height: number };
	readonly padding: { left: number; top: number };
}

/** One frozen, metadata-free image; geometry is in EXIF-upright source pixels, never desktop coordinates. */
export async function prepareSystemOneImage(bytes: Uint8Array, crop?: ImageRectangle, signal?: AbortSignal) {
	signal?.throwIfAborted();
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_SYSTEM_ONE_IMAGE_BYTES)
		throw new Error("System One image must contain between 1 byte and 16 MiB");
	const mime = detectSupportedImageMimeType(bytes);
	if (mime !== "image/png" && mime !== "image/jpeg")
		throw new Error("System One images must be still PNG or JPEG files");
	const dimensions = getImageDimensions(Buffer.from(bytes).toString("base64"), mime);
	if (
		!dimensions ||
		dimensions.widthPx < 1 ||
		dimensions.heightPx < 1 ||
		dimensions.widthPx * dimensions.heightPx > 40_000_000
	)
		throw new Error("System One image dimensions are invalid or exceed 40 million source pixels");
	const photon = await loadPhoton();
	signal?.throwIfAborted();
	if (!photon) throw new Error("System One image preparation is unavailable: Photon could not be loaded");
	const owned = new Set<PhotonImageType>();
	const own = (image: PhotonImageType): PhotonImageType => {
		owned.add(image);
		return image;
	};
	try {
		const decoded = own(photon.PhotonImage.new_from_byteslice(bytes));
		if (decoded.get_width() !== dimensions.widthPx || decoded.get_height() !== dimensions.heightPx)
			throw new Error("System One decoded image dimensions disagree with its header");
		const upright = own(applyExifOrientation(photon, decoded, bytes));
		const width = upright.get_width();
		const height = upright.get_height();
		const region = crop ?? { left: 0, top: 0, right: width, bottom: height };
		if (
			Object.values(region).some((edge) => !Number.isSafeInteger(edge)) ||
			region.left < 0 ||
			region.top < 0 ||
			region.right > width ||
			region.bottom > height ||
			region.left >= region.right ||
			region.top >= region.bottom
		)
			throw new Error("System One image crop must be a nonempty rectangle within the upright source");
		const cropped = crop ? own(photon.crop(upright, region.left, region.top, region.right, region.bottom)) : upright;
		const scale = Math.min(1, SYSTEM_ONE_IMAGE_MAX_SIDE / Math.max(cropped.get_width(), cropped.get_height()));
		const resizedWidth = Math.max(1, Math.round(cropped.get_width() * scale));
		const resizedHeight = Math.max(1, Math.round(cropped.get_height() * scale));
		const resized =
			scale < 1 ? own(photon.resize(cropped, resizedWidth, resizedHeight, photon.SamplingFilter.Lanczos3)) : cropped;
		const preparedWidth = Math.max(280, resizedWidth);
		const preparedHeight = Math.max(280, resizedHeight);
		const left = Math.floor((preparedWidth - resizedWidth) / 2);
		const top = Math.floor((preparedHeight - resizedHeight) / 2);
		const pixels = new Uint8Array(preparedWidth * preparedHeight * 4);
		const sourcePixels = resized.get_raw_pixels();
		for (let row = 0; row < resizedHeight; row++)
			pixels.set(
				sourcePixels.subarray(row * resizedWidth * 4, (row + 1) * resizedWidth * 4),
				((row + top) * preparedWidth + left) * 4,
			);
		const prepared = own(new photon.PhotonImage(pixels, preparedWidth, preparedHeight));
		const encoded = Buffer.from(prepared.get_bytes());
		if (encoded.byteLength > MAX_SYSTEM_ONE_IMAGE_BYTES) throw new Error("Prepared System One image exceeds 16 MiB");
		signal?.throwIfAborted();
		const geometry: SystemOneImageGeometry = {
			original: { width: dimensions.widthPx, height: dimensions.heightPx },
			upright: { width, height },
			crop: region,
			resized: { width: resizedWidth, height: resizedHeight },
			prepared: { width: preparedWidth, height: preparedHeight },
			padding: { left, top },
		};
		return {
			asset: { type: "image" as const, format: "png" as const, data_base64: encoded.toString("base64") },
			geometry,
			sourceSha256: createHash("sha256").update(bytes).digest("hex"),
			preparedSha256: createHash("sha256").update(encoded).digest("hex"),
			preparedBytes: encoded.byteLength,
		};
	} catch (error) {
		if (signal?.aborted) throw error;
		if (error instanceof Error && error.message.startsWith("System One")) throw error;
		throw new Error("System One image could not be decoded or prepared");
	} finally {
		for (const image of owned) image.free();
	}
}

/** Undo canvas padding, resizing and crop; reject rectangles wholly outside the image content. */
export function projectSystemOneBox(box: ImageRectangle, geometry: SystemOneImageGeometry): ImageRectangle | undefined {
	const { prepared, padding, resized, crop } = geometry;
	const left = Math.max(0, box.left * prepared.width - padding.left);
	const top = Math.max(0, box.top * prepared.height - padding.top);
	const right = Math.min(resized.width, box.right * prepared.width - padding.left);
	const bottom = Math.min(resized.height, box.bottom * prepared.height - padding.top);
	if (left >= right || top >= bottom) return undefined;
	return {
		left: crop.left + (left * (crop.right - crop.left)) / resized.width,
		top: crop.top + (top * (crop.bottom - crop.top)) / resized.height,
		right: crop.left + (right * (crop.right - crop.left)) / resized.width,
		bottom: crop.top + (bottom * (crop.bottom - crop.top)) / resized.height,
	};
}
