import { getImageDimensions } from "@caupulican/pi-tui";
import { detectSupportedImageMimeType } from "../../utils/mime.ts";
import { type EvaluationInput, TypeSafeInputError } from "./typesafe-contract.ts";
import {
	MAX_SYSTEM_ONE_IMAGE_BYTES,
	SYSTEM_ONE_IMAGE_MAX_SIDE,
	SYSTEM_ONE_IMAGE_REFERENCE_PATTERN,
	SYSTEM_ONE_IMAGE_REQUEST_BYTES,
} from "./typesafe-image-preparation.ts";

/** Encode frozen bytes once, so retries or argument changes cannot alter the images being judged. */
export async function encodeSystemOneImageRequest(request: EvaluationInput & { model: string }) {
	const { assets, ...textRequest } = request;
	if (!assets || Object.keys(assets).length === 0)
		throw new TypeSafeInputError("System One Box questions require selected image assets");
	const text = JSON.stringify(textRequest);
	if (Buffer.byteLength(text) > 2 * 1024 * 1024)
		throw new TypeSafeInputError(
			"System One image request text exceeds 2 MiB; partition without truncating evidence",
		);
	const strings: string[] = [];
	const collect = (value: unknown): void => {
		if (typeof value === "string") strings.push(value);
		else if (value && typeof value === "object") for (const child of Object.values(value)) collect(child);
	};
	collect(request.state);
	for (const question of Object.values(request.questions)) {
		collect(question.instructions);
		if ("criteria" in question) collect(question.criteria);
	}
	let expandedBytes = Buffer.byteLength(text);
	let imageBytes = 0;
	const parts: Record<string, { type: "image"; part: string }> = {};
	const images: { part: string; bytes: Uint8Array<ArrayBuffer> }[] = [];
	for (const [reference, asset] of Object.entries(assets)) {
		if (!new RegExp(SYSTEM_ONE_IMAGE_REFERENCE_PATTERN).test(reference))
			throw new TypeSafeInputError("System One image references must use distinct <name> placeholders");
		const uses = strings.reduce((count, value) => count + value.split(reference).length - 1, 0);
		if (uses === 0)
			throw new TypeSafeInputError("Every System One image must be referenced in state, instructions or criteria");
		if (asset.data_base64.length > Math.ceil(MAX_SYSTEM_ONE_IMAGE_BYTES / 3) * 4)
			throw new TypeSafeInputError("System One encoded image exceeds 16 MiB");
		const bytes = Buffer.from(asset.data_base64, "base64");
		if (
			bytes.byteLength === 0 ||
			bytes.byteLength > MAX_SYSTEM_ONE_IMAGE_BYTES ||
			bytes.toString("base64") !== asset.data_base64 ||
			detectSupportedImageMimeType(bytes) !== "image/png"
		)
			throw new TypeSafeInputError("System One image asset must be a canonical base64 still PNG");
		const dimensions = getImageDimensions(asset.data_base64, "image/png");
		if (
			!dimensions ||
			dimensions.widthPx < 256 ||
			dimensions.heightPx < 256 ||
			dimensions.widthPx > SYSTEM_ONE_IMAGE_MAX_SIDE ||
			dimensions.heightPx > SYSTEM_ONE_IMAGE_MAX_SIDE ||
			dimensions.widthPx * dimensions.heightPx < 78_400
		)
			throw new TypeSafeInputError("System One prepared image violates provider dimension limits");
		imageBytes += bytes.byteLength;
		expandedBytes += uses * bytes.byteLength;
		if (imageBytes > SYSTEM_ONE_IMAGE_REQUEST_BYTES || expandedBytes > SYSTEM_ONE_IMAGE_REQUEST_BYTES)
			throw new TypeSafeInputError("System One image aggregate or expanded request exceeds 32 MiB");
		const part = `image-${images.length + 1}`;
		parts[reference] = { type: "image", part };
		images.push({ part, bytes: new Uint8Array(bytes) });
	}
	const form = new FormData();
	form.append("request", new Blob([JSON.stringify({ ...textRequest, assets: parts })], { type: "application/json" }));
	for (const image of images)
		form.append(image.part, new Blob([image.bytes], { type: "image/png" }), `${image.part}.png`);
	const encoded = new Response(form);
	const body = new Uint8Array(await encoded.arrayBuffer());
	if (body.byteLength > SYSTEM_ONE_IMAGE_REQUEST_BYTES)
		throw new TypeSafeInputError("System One multipart image request exceeds 32 MiB");
	return { body, contentType: encoded.headers.get("Content-Type")! };
}
