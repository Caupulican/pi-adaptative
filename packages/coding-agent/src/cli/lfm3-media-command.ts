import { randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "../config.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import { ModelRegistry } from "../core/model-registry.ts";
import { derivedLocalModelRef } from "../core/models/context-sizing.ts";
import { Lfm3MediaClient } from "../core/models/lfm3-media.ts";
import { LFM3_MODELS } from "../core/models/lfm3-models.ts";
import { OllamaRuntime } from "../core/models/local-runtime.ts";
import { matchesInstalledLocalModel } from "../core/models/model-ref.ts";
import { readBoundedFile } from "../kernel/storage/bounded-file.ts";

const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
type MediaCommand = "describe" | "transcribe" | "speak" | "ask";

/** Install and runtime configuration remain separate user actions; this command only uses installed models. */
export async function runLfm3MediaCli(command: MediaCommand, args: string[]): Promise<void> {
	const allowed: Record<MediaCommand, readonly string[]> = {
		describe: ["model", "image", "prompt"],
		transcribe: ["model", "input"],
		speak: ["model", "text", "output"],
		ask: ["model", "image", "audio", "prompt"],
	};
	const values = new Map<string, string>();
	for (let i = 0; i < args.length; i++) {
		const name = args[i];
		if (!name?.startsWith("--") || !allowed[command].includes(name.slice(2)))
			throw new Error(`Unknown argument: ${name}`);
		const key = name.slice(2);
		const value = args[++i];
		if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
		if (values.has(key)) throw new Error(`${name} may be specified only once`);
		values.set(key, value);
	}
	const required = (name: string): string => {
		const value = values.get(name);
		if (!value?.trim()) throw new Error(`--${name} is required`);
		return value;
	};
	const id = values.get("model") ?? (command === "describe" ? "vision" : command === "ask" ? "omni" : "audio");
	const descriptor = LFM3_MODELS.find((model) => model.id === id);
	if (!descriptor) throw new Error(`Unknown LFM3 model: ${id}`);
	if (command === "describe" && !descriptor.modalities.includes("image"))
		throw new Error(`${id} has no image capability`);
	if (command === "transcribe" && !descriptor.modalities.includes("audio"))
		throw new Error(`${id} has no audio capability`);
	if (command === "speak" && !descriptor.modalities.includes("speech"))
		throw new Error(`${id} has no speech capability`);
	if (command === "ask" && values.has("image") && !descriptor.modalities.includes("image"))
		throw new Error(`${id} has no image capability`);
	if (command === "ask" && values.has("audio") && !descriptor.modalities.includes("audio"))
		throw new Error(`${id} has no audio capability`);
	const imagePath = command === "describe" ? required("image") : values.get("image");
	const audioPath = command === "transcribe" ? required("input") : values.get("audio");
	const text = command === "speak" ? required("text") : undefined;
	const output = command === "speak" ? resolve(required("output")) : undefined;
	const prompt = command === "ask" ? required("prompt") : (values.get("prompt") ?? "Describe this image.");
	const agentDir = getAgentDir();
	const runtime = new OllamaRuntime({ agentDir });
	const controller = new AbortController();
	const abort = () => controller.abort(new Error("LFM3 media command interrupted"));
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	try {
		const image = imagePath ? await readBoundedFile(resolve(imagePath), MAX_MEDIA_BYTES, "Image") : undefined;
		const audio = audioPath
			? await readBoundedFile(resolve(audioPath), MAX_MEDIA_BYTES - (image?.length ?? 0), "Audio")
			: undefined;
		controller.signal.throwIfAborted();
		const status = await runtime.detect();
		if (status.serverUp)
			throw new Error(
				"An Ollama server is already running and its ownership cannot be established; stop it before using this command.",
			);
		if (status.binarySource !== "pi-owned")
			throw new Error("Pi-managed Ollama is not installed; run pi lfm3 setup first.");
		const started = await runtime.start({ retainForOperation: true });
		controller.signal.throwIfAborted();
		if (!started.started) throw new Error(`Ollama start: ${started.reason}`);
		const installed = await runtime.list();
		controller.signal.throwIfAborted();
		const auth = AuthStorage.create(join(agentDir, "auth.json"));
		const registry = ModelRegistry.create(auth, join(agentDir, "models.json"));
		const prefix = derivedLocalModelRef(descriptor.sourceRef, "");
		const candidates = registry
			.getAll()
			.filter(
				(model) =>
					model.provider === "ollama" &&
					(model.id === descriptor.sourceRef || model.id.startsWith(prefix)) &&
					installed.some((entry) => matchesInstalledLocalModel(model.id, entry.name)),
			);
		if (candidates.length !== 1)
			throw new Error(
				candidates.length
					? `Multiple installed registrations match ${id}; remove the ambiguity in models.json.`
					: `No installed registration for ${id}; run pi lfm3 setup --model ${id} first.`,
			);
		const model = candidates[0]!.id;
		const client = new Lfm3MediaClient({ baseUrl: runtime.baseUrl });
		const inferenceSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
		if (command === "speak") {
			const wav = await client.speak({ model, input: text!, signal: inferenceSignal });
			controller.signal.throwIfAborted();
			const temp = join(dirname(output!), `.pi-lfm3-${randomUUID()}.tmp`);
			const file = await open(temp, "wx", 0o600);
			try {
				try {
					await file.writeFile(wav);
				} finally {
					await file.close();
				}
				controller.signal.throwIfAborted();
				await link(temp, output!);
			} finally {
				await unlink(temp);
			}
			process.stdout.write(`${output}\n`);
		} else if (command === "transcribe") {
			process.stdout.write(
				`${await client.transcribe({ model, audio: audio!, filename: basename(audioPath!), signal: inferenceSignal })}\n`,
			);
		} else {
			process.stdout.write(
				`${await client.chat({ model, prompt, images: image ? [image] : undefined, audio, signal: inferenceSignal })}\n`,
			);
		}
	} finally {
		process.removeListener("SIGINT", abort);
		process.removeListener("SIGTERM", abort);
		await runtime.stopAndWait();
	}
}
