import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { AccountingOrigin } from "../cost/accounting-evidence.ts";
import {
	SystemOneReviewError,
	type SystemOneReviewPort,
	type SystemOneReviewResponseObserver,
} from "./system-one-review-port.ts";
import {
	contextSchema,
	type EvaluationInput,
	questionSchema,
	serializeEvaluation,
	TypeSafeInputError,
} from "./typesafe-contract.ts";
import type { TypeSafeEvidenceMaterializer } from "./typesafe-evidence-materializer.ts";
import {
	MAX_SYSTEM_ONE_IMAGE_BYTES,
	MAX_SYSTEM_ONE_IMAGES,
	prepareSystemOneImage,
	projectSystemOneBox,
	SYSTEM_ONE_IMAGE_REFERENCE_PATTERN,
	type SystemOneImageGeometry,
} from "./typesafe-image-preparation.ts";

const rectangleSchema = Type.Object(
	{
		left: Type.Integer({ minimum: 0 }),
		top: Type.Integer({ minimum: 0 }),
		right: Type.Integer({ minimum: 1 }),
		bottom: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);
const probabilitySchema = Type.Number({ minimum: 0, maximum: 1 });

export const visionInputSchema = Type.Object(
	{
		state: contextSchema,
		questions: Type.Record(Type.String(), questionSchema, { minProperties: 1 }),
		images: Type.Record(
			Type.String({ pattern: SYSTEM_ONE_IMAGE_REFERENCE_PATTERN }),
			Type.Object(
				{
					path: Type.String({ minLength: 1 }),
					reason: Type.String({ minLength: 1 }),
					crop: Type.Optional(rectangleSchema),
				},
				{ additionalProperties: false },
			),
			{ minProperties: 1, maxProperties: MAX_SYSTEM_ONE_IMAGES },
		),
		boxes: Type.Optional(
			Type.Record(
				Type.String(),
				Type.Object(
					{
						image: Type.String(),
						presenceQuestion: Type.String({ minLength: 1 }),
						minimumPresence: probabilitySchema,
						minimumConfidence: probabilitySchema,
					},
					{ additionalProperties: false },
				),
			),
		),
	},
	{ additionalProperties: false },
);

export type VisionInput = Static<typeof visionInputSchema>;

export interface SystemOneImageManifest {
	readonly reference: string;
	readonly canonicalPath: string;
	readonly label: string;
	readonly reason: string;
	readonly provenanceRedacted: boolean;
	readonly sourceSha256: string;
	readonly sourceBytes: number;
	readonly preparedSha256: string;
	readonly preparedBytes: number;
	readonly geometry: SystemOneImageGeometry;
}

/** Images are explicitly selected snapshots, not live UI state. All results remain advisory. */
export async function evaluateSystemOneVision(
	input: VisionInput,
	materializer: TypeSafeEvidenceMaterializer,
	reviewer: SystemOneReviewPort,
	signal?: AbortSignal,
	onResponse?: SystemOneReviewResponseObserver,
	onPrepared?: (manifest: readonly SystemOneImageManifest[]) => void,
	origin?: AccountingOrigin,
) {
	// Freeze arguments before image decoding/provider awaits; no mutation can retarget a projection.
	const snapshot: VisionInput = JSON.parse(serializeEvaluation(input));
	if (!Value.Check(visionInputSchema, snapshot)) throw new TypeSafeInputError("Invalid System One vision input");
	const redact = await materializer.createTextRedactor();
	const questions: EvaluationInput["questions"] = snapshot.questions;
	const companions = new Set<string>();
	const bindings = snapshot.boxes ?? {};
	for (const [id, binding] of Object.entries(bindings)) {
		const question = questions[id];
		const companion = questions[binding.presenceQuestion];
		if (
			question?.type !== "box" ||
			!Object.hasOwn(snapshot.images, binding.image) ||
			!companion ||
			companion.type !== "noul" ||
			companion.instructions !== null ||
			companion.criteria !== undefined ||
			companions.has(binding.presenceQuestion)
		)
			throw new TypeSafeInputError(
				"Every Box needs one declared image and a unique Noul with null instructions and no criteria",
			);
		companions.add(binding.presenceQuestion);
		const target = question.instructions;
		// The host owns both questions' target and image identity; callers define the target only once.
		questions[id] = {
			type: "box",
			instructions: {
				image: binding.image,
				target,
				instruction: "Locate exactly the target in `image`; ignore targets in other images.",
			},
		};
		questions[binding.presenceQuestion] = {
			type: "noul",
			instructions: {
				image: binding.image,
				target,
				instruction: "Is the target described by `target` visibly present in `image`?",
			},
		};
	}
	if (Object.entries(questions).some(([id, question]) => question.type === "box" && !Object.hasOwn(bindings, id)))
		throw new TypeSafeInputError("Every Box requires explicit image, presence and confidence bindings");
	const assets: NonNullable<EvaluationInput["assets"]> = {};
	const imageManifest: SystemOneImageManifest[] = [];
	let sourceBytes = 0;
	let preparedBytes = 0;
	// Acquire every source in the same synchronous task-directory context before decoder awaits.
	const sources = Object.entries(snapshot.images).map(([reference, selection]) => {
		if (redact(reference) !== reference)
			throw new TypeSafeInputError("System One image references must not contain credentials");
		signal?.throwIfAborted();
		const source = materializer.readImage(selection.path, MAX_SYSTEM_ONE_IMAGE_BYTES, signal);
		sourceBytes += source.bytes.byteLength;
		if (sourceBytes > 32 * 1024 * 1024)
			throw new TypeSafeInputError("Selected System One image sources exceed 32 MiB");
		return { reference, selection, source };
	});
	for (const { reference, selection, source } of sources) {
		const prepared = await prepareSystemOneImage(source.bytes, selection.crop, signal);
		preparedBytes += prepared.preparedBytes;
		if (preparedBytes > 24 * 1024 * 1024) throw new TypeSafeInputError("Prepared System One images exceed 24 MiB");
		assets[reference] = prepared.asset;
		imageManifest.push({
			reference,
			canonicalPath: redact(source.canonicalPath),
			label: redact(source.label),
			reason: redact(selection.reason),
			provenanceRedacted:
				redact(source.canonicalPath) !== source.canonicalPath ||
				redact(source.label) !== source.label ||
				redact(selection.reason) !== selection.reason,
			sourceSha256: prepared.sourceSha256,
			sourceBytes: source.bytes.byteLength,
			preparedSha256: prepared.preparedSha256,
			preparedBytes: prepared.preparedBytes,
			geometry: prepared.geometry,
		});
		onPrepared?.([...imageManifest]);
	}
	const result = await reviewer.evaluate({ state: snapshot.state, questions, assets }, signal, onResponse, origin);
	if (signal?.aborted)
		throw new SystemOneReviewError(
			"System One vision cancelled after response",
			result.requestSha256,
			result.request,
			result.response,
			result.transportAttempts,
			result.receipts,
		);
	const boxes = Object.fromEntries(
		Object.entries(bindings).map(([id, binding]) => {
			const answer = result.response.answers[id];
			const presence = result.response.answers[binding.presenceQuestion];
			const image = imageManifest.find((entry) => entry.reference === binding.image)!;
			const sufficient =
				answer?.type === "box" &&
				presence?.type === "noul" &&
				presence.noul >= binding.minimumPresence &&
				answer.confidence !== null &&
				answer.confidence >= binding.minimumConfidence;
			const sourceRectangle = sufficient ? projectSystemOneBox(answer.box, image.geometry) : undefined;
			return [
				id,
				{
					image: binding.image,
					preparedSha256: image.preparedSha256,
					candidate: sourceRectangle !== undefined,
					coordinateSpace: "upright_source_pixels",
					presence: presence?.type === "noul" ? presence.noul : null,
					confidence: answer?.type === "box" ? answer.confidence : null,
					minimumPresence: binding.minimumPresence,
					minimumConfidence: binding.minimumConfidence,
					...(sourceRectangle ? { sourceRectangle } : {}),
				},
			];
		}),
	);
	return {
		...result,
		kind: "system_one_vision",
		accepted: null,
		advisoryOnly: true,
		experimental: true,
		imageManifest,
		boxes,
		limitations:
			"Frozen image snapshots only. Rectangles are model candidates in upright source pixels, not desktop coordinates, action permission or completion proof.",
	};
}
