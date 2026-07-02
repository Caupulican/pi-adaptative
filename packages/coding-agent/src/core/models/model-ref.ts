/**
 * Model source normalizer (local-model-lifecycle-design.md, "one panel, three types"):
 * everything a user can paste — an ollama tag, an hf.co GGUF ref, a full HuggingFace URL, a
 * copied `ollama pull ...` install command, or an API `provider/model` name — normalizes to ONE
 * typed source. Pure string work: pasted install commands are PARSED for their reference and
 * NEVER executed as shell; unknown forms are rejected with the reason.
 */

export type ModelSource =
	| { type: "api"; ref: string }
	| { type: "local"; pullRef: string }
	| { type: "rejected"; reason: string };

const OLLAMA_TAG = /^[a-z0-9][a-z0-9._-]*(?::[A-Za-z0-9._-]+)?$/;
const HF_REF = /^hf\.co\/([\w.-]+)\/([\w.-]+)(?::([\w.-]+))?$/i;
const HF_URL = /^https?:\/\/(?:www\.)?huggingface\.co\/([\w.-]+)\/([\w.-]+)(?:\/.*)?$/i;
const SHELL_METACHARS = /[;&|`$<>(){}\\]/;

export function normalizeModelSource(rawInput: string): ModelSource {
	const input = rawInput.trim();
	if (input.length === 0) return { type: "rejected", reason: "empty input" };
	if (input.length > 500) return { type: "rejected", reason: "input too long to be a model reference" };

	// Pasted install command: extract the reference, never execute anything.
	const installCommand = /^ollama\s+(?:pull|run)\s+(.+)$/i.exec(input);
	if (installCommand) {
		const argument = installCommand[1]!.trim().split(/\s+/)[0] ?? "";
		if (SHELL_METACHARS.test(argument)) {
			return { type: "rejected", reason: "install command argument contains shell metacharacters" };
		}
		const inner = normalizeModelSource(argument);
		if (inner.type === "local") return inner;
		return { type: "rejected", reason: `could not extract a model reference from the install command` };
	}

	if (SHELL_METACHARS.test(input) || /\s/.test(input)) {
		return { type: "rejected", reason: "not a recognized model reference (contains spaces or shell characters)" };
	}

	// Full HuggingFace URL -> hf.co pull ref (org/repo; a :quant suffix must be given explicitly).
	const hfUrl = HF_URL.exec(input);
	if (hfUrl) {
		return { type: "local", pullRef: `hf.co/${hfUrl[1]}/${hfUrl[2]}` };
	}

	// hf.co/org/repo[:quant]
	const hfRef = HF_REF.exec(input);
	if (hfRef) {
		return { type: "local", pullRef: `hf.co/${hfRef[1]}/${hfRef[2]}${hfRef[3] ? `:${hfRef[3]}` : ""}` };
	}

	if (input.includes("://")) {
		return { type: "rejected", reason: "only huggingface.co URLs are recognized as local model links" };
	}

	// provider/model -> API-registered model (nothing to install; auth + selection only).
	if (input.includes("/")) {
		const [provider, ...rest] = input.split("/");
		const model = rest.join("/");
		if (provider && model && !model.includes("/")) {
			return { type: "api", ref: `${provider}/${model}` };
		}
		return { type: "rejected", reason: "expected provider/model or hf.co/org/repo[:quant]" };
	}

	// Bare ollama tag ("qwen3:1.7b", "pi-lifter:latest", "llama3").
	if (OLLAMA_TAG.test(input)) {
		return { type: "local", pullRef: input };
	}

	return { type: "rejected", reason: "not a recognized model reference" };
}
