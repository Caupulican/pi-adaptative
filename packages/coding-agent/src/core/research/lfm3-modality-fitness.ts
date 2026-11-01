import { createHash } from "node:crypto";
import type { Lfm3MediaClient } from "../models/lfm3-media.ts";

export type Lfm3FitnessModality = "text" | "vision" | "speech" | "transcription" | "audio-understanding" | "omni";
export interface Lfm3FitnessJudgment {
	pass: boolean;
	confidence: number;
	explanation: string;
}
export interface Lfm3FitnessResult {
	modality: Lfm3FitnessModality;
	status: "pass" | "fail" | "blocked" | "unsupported";
	evidence: string;
	criterion: string;
	judgment?: Lfm3FitnessJudgment;
}
export interface Lfm3FitnessReport {
	model: string;
	results: Lfm3FitnessResult[];
}

const MODALITIES: readonly Lfm3FitnessModality[] = [
	"text",
	"vision",
	"speech",
	"transcription",
	"audio-understanding",
	"omni",
];
const PHRASE = "The red boat is beside the green bridge.";
const IMAGE = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGN4oKBAU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAKWUgD0XoiFoAAAAAElFTkSuQmCC",
	"base64",
);
const OMNI_IMAGE = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGNQUHhAU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAKU6gD3j1miXAAAAAElFTkSuQmCC",
	"base64",
);

/** Real local media requests; semantic acceptance is delegated to a remote System One owner. */
export async function runLfm3ModalityFitness(args: {
	client: Lfm3MediaClient;
	model: string;
	modalities: readonly Lfm3FitnessModality[];
	judge: (args: { criterion: string; evidence: string; signal?: AbortSignal }) => Promise<Lfm3FitnessJudgment>;
	signal?: AbortSignal;
	maxWallClockMs?: number;
}): Promise<Lfm3FitnessReport> {
	const timeout = args.maxWallClockMs ?? 120_000;
	if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error("maxWallClockMs must be a positive integer");
	const requested = new Set(args.modalities);
	const results: Lfm3FitnessResult[] = [];
	let audio: Uint8Array | undefined;
	let speechError: string | undefined;
	const bounded = () =>
		args.signal ? AbortSignal.any([args.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
	const synthesize = async (): Promise<Uint8Array> => {
		if (audio) return audio;
		if (speechError) throw new Error(speechError);
		try {
			audio = await args.client.speak({ model: args.model, input: PHRASE, signal: bounded() });
			if (audio.length > 44 + 30 * 24_000 * 2)
				throw new Error("Synthesized WAV exceeds the 30 second fitness limit");
			return audio;
		} catch (error) {
			audio = undefined;
			speechError = error instanceof Error ? error.message : String(error);
			throw error;
		}
	};
	for (const modality of MODALITIES) {
		if (!requested.has(modality)) {
			results.push({
				modality,
				status: "unsupported",
				evidence: "Not advertised by the model descriptor",
				criterion: "",
			});
			continue;
		}
		let criterion = "";
		let awaitingSpeechTranscript = false;
		try {
			let evidence: string;
			switch (modality) {
				case "text":
					criterion = "The answer identifies Paris as the capital of France.";
					evidence = await args.client.chat({
						model: args.model,
						prompt: "What is the capital of France? Answer briefly.",
						signal: bounded(),
					});
					break;
				case "vision":
					criterion = "The answer identifies the image as red or mostly red.";
					evidence = await args.client.chat({
						model: args.model,
						prompt: "What is the dominant color of this image?",
						images: [IMAGE],
						signal: bounded(),
					});
					break;
				case "speech":
				case "transcription": {
					criterion = `The transcript conveys the sentence: ${PHRASE}`;
					const clip = await synthesize();
					awaitingSpeechTranscript = modality === "speech";
					const transcript = await args.client.transcribe({ model: args.model, audio: clip, signal: bounded() });
					awaitingSpeechTranscript = false;
					evidence = `Synthesized WAV: ${clip.length} bytes, SHA-256 ${createHash("sha256").update(clip).digest("hex")}\nTranscript: ${transcript}`;
					break;
				}
				case "audio-understanding":
					criterion = "The answer identifies a red boat and a green bridge from the spoken sentence.";
					evidence = await args.client.chat({
						model: args.model,
						prompt: "Describe what the speaker says.",
						audio: await synthesize(),
						signal: bounded(),
					});
					break;
				case "omni":
					criterion =
						"The answer identifies a blue image and the spoken sentence about a red boat beside a green bridge.";
					evidence = await args.client.chat({
						model: args.model,
						prompt: "What is the image color, and what does the speaker say?",
						images: [OMNI_IMAGE],
						audio: await synthesize(),
						signal: bounded(),
					});
					break;
			}
			const judgeSignal = bounded();
			const judgment = await new Promise<Lfm3FitnessJudgment>((resolve, reject) => {
				const onAbort = () => reject(judgeSignal.reason);
				if (judgeSignal.aborted) return onAbort();
				judgeSignal.addEventListener("abort", onAbort, { once: true });
				Promise.resolve()
					.then(() => {
						judgeSignal.throwIfAborted();
						return args.judge({ criterion, evidence, signal: judgeSignal });
					})
					.then(
						(value) => {
							judgeSignal.removeEventListener("abort", onAbort);
							resolve(value);
						},
						(error: unknown) => {
							judgeSignal.removeEventListener("abort", onAbort);
							reject(error);
						},
					);
			});
			const valid =
				typeof judgment.pass === "boolean" &&
				Number.isFinite(judgment.confidence) &&
				judgment.confidence >= 0.9 &&
				judgment.confidence <= 1 &&
				typeof judgment.explanation === "string";
			results.push({ modality, status: valid && judgment.pass ? "pass" : "fail", criterion, evidence, judgment });
		} catch (error) {
			results.push({
				modality,
				status: (speechError && modality !== "speech") || awaitingSpeechTranscript ? "blocked" : "fail",
				criterion,
				evidence: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
			});
		}
	}
	return { model: args.model, results };
}
