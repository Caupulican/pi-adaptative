import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform as osPlatform } from "node:os";
import { join } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnProcess, spawnProcessSync, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import type { RuntimeCommandResult, RuntimeCommandRunner } from "./local-runtime.ts";

/**
 * Managed runtime for needle (https://github.com/cactus-compute/needle), a 26M-parameter single-shot
 * function-calling model. Needle exposes no server — the only integration surface is CLI/library
 * invocation — so this module owns clone+build of a pinned commit into a contained venv, base
 * checkpoint download, and one-shot `needle run` invocation/parsing. Mirrors local-runtime.ts's
 * OllamaRuntime/TransformersRuntime and llamacpp-runtime.ts's PrismLlamaCppRuntime: injectable seams
 * for exists/fetch/run-command, pi-owned directories under agentDir (runtimes/, models/), onProgress
 * as best-effort UI feedback, and honest error taxonomies instead of silent fallbacks.
 *
 * Investigation findings (verified against a real clone + real venv + real CPU inference run, not
 * just the README):
 *
 * - `needle run` (the CLI's single-inference subcommand) takes a REQUIRED `--checkpoint` and does
 *   NOT auto-download one — unlike `needle playground`/`finetune`, which resolve a checkpoint
 *   internally. The pretrained base checkpoint (`needle.pkl`) lives on `Cactus-Compute/needle` on
 *   Hugging Face and is fetched directly by {@link NeedleRuntime.downloadWeights} (never invoked
 *   implicitly by installManaged/runFunctionCall — this module never silently starts a large
 *   download on the caller's behalf).
 * - SECURITY (owner-flagged, verified during investigation): `Cactus-Compute/needle` on Hugging Face
 *   publishes THREE weight artifacts — `needle.pkl` (52,633,098 bytes), `model.safetensors`
 *   (reported as a different param count on the HF model card, 30.4M vs the 26,315,421 a real
 *   `needle run` printed — likely not even the same checkpoint), and `needle-cq4.zip`. I grepped the
 *   ENTIRE needle package (cli.py, model/run.py, model/export.py, model/quantize.py,
 *   training/{finetune,pretrain,train}.py, utils/distributed.py, ui/server.py — every `pickle`/`.zip`
 *   hit in the repo) and confirmed every checkpoint load/save path in the codebase — including the
 *   one `needle run` uses — is `pickle.load`/`pickle.dump` on a `.pkl` file. There is NO safetensors
 *   reader anywhere in the package; `model.safetensors` is not consumed by any code this module
 *   drives. `needle-cq4.zip` ("Cactus Quantized 4-bit"?) isn't referenced by any code here either —
 *   the README states production inference runs on the separate Cactus C++ engine
 *   (cactus-compute/cactus), which very plausibly consumes its own format; that repo was not audited
 *   here. Bottom line: **this module has no choice but to fetch and deserialize `needle.pkl` via
 *   Python's `pickle` module, which executes arbitrary code by construction** — there is no
 *   safetensors alternative available in the code path we drive. Given that, {@link
 *   NeedleRuntime.downloadWeights} pins the exact sha256 ({@link NEEDLE_WEIGHTS_SHA256}) and byte
 *   count ({@link NEEDLE_WEIGHTS_BYTES}) of the file as verified on 2026-07-18 (direct `sha256sum` of
 *   a real download, cross-checked against Hugging Face's own `x-linked-etag`/`x-linked-size`
 *   headers on the resolve redirect, at repo commit `5f89b4307696d669c3df1d38ae057e6e1728b107`) and
 *   VERIFIES every download against that pin, refusing to keep any file that doesn't match — this
 *   catches a compromised/tampered/swapped artifact but does NOT make loading a pickle file safe in
 *   the abstract; the actual `pickle.load` execution happens entirely inside needle's own Python
 *   process, outside this module's control. The owner should decide whether serving this model at
 *   all is acceptable given upstream's format choice.
 * - The upstream `setup` script does more than a contained managed install can honor: it can `sudo
 *   apt-get install` a newer Python or `python3-venv`, `sudo modprobe` TPU kernel modules, toggle
 *   transparent hugepages via a root-owned sysfs write, and interactively prompts for a
 *   WANDB_API_KEY. None of that is available under containment (no writes outside the pi-owned dir,
 *   no sudo, no interactive prompts, no global installs) and none of it is required for the
 *   documented Mac/PC single-inference quickstart path. {@link NeedleRuntime.installManaged} instead
 *   replicates only the containable core: `python3 -m venv`, `pip install -e <clonedRepo>` (the
 *   script's own `pip install -e . -q`), and the CPU (or CUDA, when an NVIDIA GPU is detected) JAX
 *   backend install. TPU support and the sudo-gated OS package/kernel-module steps are intentionally
 *   NOT replicated.
 * - `needle run`'s console-script entry point (`<venv>/bin/needle`, installed by
 *   `pip install -e .` from the `[project.scripts]` table) is the only way to invoke the CLI:
 *   `needle/cli.py` has no `if __name__ == "__main__":` guard, so `python -m needle.cli` silently
 *   does nothing — the installed console script is required.
 * - A verified real stdout capture of `needle run --checkpoint <path> --query "..." --tools '[...]'`
 *   is multi-line diagnostic prose followed by the tool call:
 *   ```
 *   Loading checkpoint: <path>
 *   Downloading pretrained tokenizer from HuggingFace...   (first run only — cached after)
 *   Model parameters: 26,315,421
 *
 *   Query: <query>
 *   Tools: <tools JSON, truncated to 80 chars>...
 *
 *   <tool_call>[{"name":"get_weather","arguments":{"location":"SanFrancisco"}}]
 *   ```
 *   The `<tool_call>` marker is a literal SentencePiece user-defined-symbol token, always emitted as
 *   the first generated token per the model's own answer format. {@link NeedleRuntime}'s stdout
 *   parser locates that marker and strictly `JSON.parse`s everything after it — never guessing a
 *   result from unparseable output.
 * - Known upstream quirk (verified against a live run with a camelCase tool name): `needle run`'s CLI
 *   wrapper (`main()` in `needle/model/run.py`) streams tokens straight to stdout and never applies
 *   the tool-name restoration its own `generate()` return value receives — a tool name that wasn't
 *   already snake_case (e.g. `getWeatherNow`) is reported back snake-cased (`get_weather_now`), not
 *   in its original casing. This is a limitation of the upstream CLI, not something patched here.
 * - Pinned commit `ffb1c5144c5a16cb8ec650dbc8a6f6fd3854f8f2` was captured via a real `git clone` of
 *   the repo's default branch HEAD on 2026-07-18 (the repo's own history shows no pushes since
 *   2026-07-01, so this is not stale). A plain `git clone --depth 1` only reliably lands on a pinned
 *   commit when it still happens to be the remote's current tip; {@link NeedleRuntime.installManaged}
 *   instead fetches the exact commit SHA directly (`git fetch --depth 1 origin <sha>`), which GitHub
 *   serves for any reachable commit on a public repo, so the pin holds even after upstream moves on.
 */

export const NEEDLE_REPO_URL = "https://github.com/cactus-compute/needle.git";

/**
 * Pinned needle commit — captured via a real `git clone` of the repo's default-branch HEAD on
 * 2026-07-18 (`git ls-remote https://github.com/cactus-compute/needle HEAD` resolves to the same
 * SHA). Bump here (re-verify with the same command) when a newer commit is needed.
 */
export const NEEDLE_PINNED_COMMIT = "ffb1c5144c5a16cb8ec650dbc8a6f6fd3854f8f2";

const NEEDLE_HF_MODEL_REPO = "Cactus-Compute/needle";
const NEEDLE_CHECKPOINT_FILENAME = "needle.pkl";
const NEEDLE_TOOL_CALL_MARKER = "<tool_call>";

/**
 * Pinned integrity for `needle.pkl` — see the module-level SECURITY note: this is a pickle file
 * (arbitrary code execution on load by construction), so every download is verified against this
 * exact sha256+size before being kept. Captured 2026-07-18: `sha256sum` of a real download matched
 * Hugging Face's `x-linked-etag` header on the resolve redirect at repo commit
 * `5f89b4307696d669c3df1d38ae057e6e1728b107`. Bump both together (re-verify the same way) only for a
 * deliberate, reviewed upstream weights update.
 */
export const NEEDLE_WEIGHTS_SHA256 = "40a32e91d1d4197bf15ba559b74f6727c342dc8746918742fc7d8e2c1f18df40";
export const NEEDLE_WEIGHTS_BYTES = 52_633_098;

const NEEDLE_COMMAND_TIMEOUT_MS = 10 * 60_000;
const NEEDLE_KILL_GRACE_MS = 2_000;

const NEEDLE_SMOKE_QUERY = "What's the weather in San Francisco?";
const NEEDLE_SMOKE_TOOLS = [
	{
		name: "get_weather",
		description: "Get current weather for a city.",
		parameters: { location: { type: "string", description: "City name.", required: true } },
	},
];

export interface NeedleDetectResult {
	installed: boolean;
	installDir?: string;
	commit?: string;
	pythonAvailable: boolean;
	checkpointPresent: boolean;
}

export interface NeedleFunctionCallRequest {
	query: string;
	/** A JSON-serializable tool schema value (never a pre-stringified JSON string) — serialized
	 * exactly once by {@link NeedleRuntime.runFunctionCall}, never by the caller. */
	tools: unknown;
}

export interface NeedleFunctionCall {
	name: string;
	arguments: Record<string, unknown>;
}

export type NeedleFunctionCallResult =
	| { ok: true; call: NeedleFunctionCall }
	| { ok: false; error: string; rawOutput: string };

export interface NeedleSmokeTestResult {
	ok: boolean;
	latencyMs: number;
	call?: NeedleFunctionCall;
	error?: string;
}

export interface NeedleWeightsDownloadResult {
	ok: boolean;
	path?: string;
	skipped?: boolean;
	error?: string;
}

interface NeedleWeightsIntegrity {
	sha256: string;
	bytes: number;
}

export interface NeedleRuntimeDeps {
	existsFn?: (path: string) => boolean;
	fetchFn?: typeof fetch;
	/** Runs git/pip/python commands. Injectable so installManaged/runFunctionCall's orchestration is
	 * testable without a real clone/venv/inference. Defaults to a real spawn-and-collect-output
	 * runner (installs can run long; a single inference call is comparatively quick but still shells
	 * out to a real interpreter). */
	runCommand?: RuntimeCommandRunner;
	/** Whether a named command exists on PATH (git, python3, nvidia-smi). */
	hasCommand?: (command: string) => boolean;
	hasNvidiaGpu?: () => boolean;
	platform?: () => string;
	/** Expected weights sha256+size. Defaults to {@link NEEDLE_WEIGHTS_SHA256}/{@link
	 * NEEDLE_WEIGHTS_BYTES} — the real pinned values. Overridable ONLY so tests can exercise the full
	 * download+verify path with small synthetic content instead of the real 52MB pickle; this is a
	 * constructor-level seam for a trusted caller, the same trust boundary every other injectable dep
	 * in this class already relies on (fetchFn/runCommand could equally be used to bypass anything).
	 */
	weightsIntegrity?: NeedleWeightsIntegrity;
}

interface NeedleInstallMetadata {
	commit: string;
	entryCommand: string;
}

function tailLines(value: string | undefined, count = 3): string {
	return value?.trim().split("\n").slice(-count).join("\n") || "unknown error";
}

/** Pass bytes through unchanged while feeding them into a running hash — lets a single `pipeline()`
 * call both write the download to disk and compute its sha256 in one streaming pass. */
function hashingPassThrough(hash: ReturnType<typeof createHash>): Transform {
	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			callback(null, chunk);
		},
	});
}

async function defaultRunCommand(
	command: string,
	args: string[],
	options: { env?: NodeJS.ProcessEnv; onOutput?: (chunk: string) => void } = {},
): Promise<RuntimeCommandResult> {
	try {
		const proc = spawnProcess(command, args, {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			env: options.env ? { ...process.env, ...options.env } : process.env,
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.setEncoding("utf8");
		proc.stderr.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => {
			stdout = `${stdout}${chunk}`.slice(-1024 * 1024);
			options.onOutput?.(chunk);
		});
		proc.stderr.on("data", (chunk: string) => {
			stderr = `${stderr}${chunk}`.slice(-1024 * 1024);
			options.onOutput?.(chunk);
		});
		const terminal = await waitForChildProcessWithTermination(proc, {
			timeoutMs: NEEDLE_COMMAND_TIMEOUT_MS,
			killGraceMs: NEEDLE_KILL_GRACE_MS,
		});
		const timedOut = terminal.reason === "timeout";
		return {
			ok: terminal.code === 0,
			stdout,
			stderr,
			code: terminal.code,
			...(terminal.code === 0
				? {}
				: {
						error: timedOut
							? `${command} timed out after ${NEEDLE_COMMAND_TIMEOUT_MS}ms`
							: stderr.trim() || stdout.trim() || `exit code ${terminal.code ?? "unknown"}`,
					}),
		};
	} catch (error) {
		return { ok: false, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) };
	}
}

export class NeedleRuntime {
	private readonly _agentDir: string;
	private readonly _exists: (path: string) => boolean;
	private readonly _fetch: typeof fetch;
	private readonly _runCommand: RuntimeCommandRunner;
	private readonly _hasCommand: (command: string) => boolean;
	private readonly _hasNvidiaGpu: () => boolean;
	private readonly _platform: () => string;
	private readonly _weightsIntegrity: NeedleWeightsIntegrity;

	constructor(args: { agentDir: string; deps?: NeedleRuntimeDeps }) {
		this._agentDir = args.agentDir;
		this._exists = args.deps?.existsFn ?? existsSync;
		this._fetch = args.deps?.fetchFn ?? fetch;
		this._runCommand = args.deps?.runCommand ?? defaultRunCommand;
		this._hasCommand =
			args.deps?.hasCommand ??
			((command) =>
				spawnProcessSync(command, ["--version"], { encoding: "utf8", timeout: 5_000 }).error === undefined);
		this._hasNvidiaGpu = args.deps?.hasNvidiaGpu ?? (() => this._hasCommand("nvidia-smi"));
		this._platform = args.deps?.platform ?? osPlatform;
		this._weightsIntegrity = args.deps?.weightsIntegrity ?? {
			sha256: NEEDLE_WEIGHTS_SHA256,
			bytes: NEEDLE_WEIGHTS_BYTES,
		};
	}

	runtimeDir(): string {
		return join(this._agentDir, "runtimes", "needle");
	}

	modelsDir(): string {
		return join(this._agentDir, "models", "needle");
	}

	checkpointPath(): string {
		return join(this.modelsDir(), NEEDLE_CHECKPOINT_FILENAME);
	}

	private _srcDir(): string {
		return join(this.runtimeDir(), "src");
	}

	private _venvDir(): string {
		return join(this.runtimeDir(), "venv");
	}

	private _pythonPath(): string {
		return this._platform() === "win32"
			? join(this._venvDir(), "Scripts", "python.exe")
			: join(this._venvDir(), "bin", "python");
	}

	/** The installed `needle` console script (from `[project.scripts]`, written by `pip install -e`)
	 * — the only invokable entry point, since `needle/cli.py` has no `__main__` guard. */
	private _entryPath(): string {
		return this._platform() === "win32"
			? join(this._venvDir(), "Scripts", "needle.exe")
			: join(this._venvDir(), "bin", "needle");
	}

	private _manifestPath(): string {
		return join(this.runtimeDir(), "install.json");
	}

	private _readManifest(): NeedleInstallMetadata | undefined {
		try {
			const parsed = JSON.parse(readFileSync(this._manifestPath(), "utf8")) as {
				commit?: unknown;
				entryCommand?: unknown;
			};
			return typeof parsed.commit === "string" && typeof parsed.entryCommand === "string"
				? { commit: parsed.commit, entryCommand: parsed.entryCommand }
				: undefined;
		} catch {
			return undefined;
		}
	}

	private _writeManifest(metadata: NeedleInstallMetadata): void {
		writeFileSync(this._manifestPath(), JSON.stringify(metadata, null, "\t"));
	}

	async detect(): Promise<NeedleDetectResult> {
		const installed = this._exists(this._entryPath());
		return {
			installed,
			installDir: installed ? this.runtimeDir() : undefined,
			commit: this._readManifest()?.commit,
			pythonAvailable: this._hasCommand("python3"),
			checkpointPresent: this._exists(this.checkpointPath()),
		};
	}

	/**
	 * Clone the pinned needle commit and build a contained, pi-owned runtime (consent-gated by the
	 * caller, same contract as OllamaRuntime#installManaged / PrismLlamaCppRuntime#installManaged —
	 * this method only does the mechanical clone+build+verify and reports the outcome honestly). See
	 * the module docstring for exactly which upstream `setup` steps are and are not replicated under
	 * containment.
	 */
	async installManaged(onProgress?: (status: string) => void): Promise<{ ok: boolean; error?: string }> {
		if (!this._hasCommand("git")) {
			return {
				ok: false,
				error: `git-missing: git is required to clone needle (${NEEDLE_REPO_URL}). Install git (e.g. \`apt-get install git\`, \`brew install git\`) and try again.`,
			};
		}
		if (!this._hasCommand("python3")) {
			return {
				ok: false,
				error: "python-missing: python3 (>=3.11) is required to run needle. Install Python 3.11+ (e.g. `apt-get install python3 python3-venv`, `brew install python@3.12`) and try again.",
			};
		}

		mkdirSync(this.runtimeDir(), { recursive: true });
		const srcDir = this._srcDir();
		if (this._exists(srcDir)) rmSync(srcDir, { recursive: true, force: true });

		onProgress?.(`Cloning ${NEEDLE_REPO_URL}…`);
		const cloned = await this._cloneAtPinnedCommit(srcDir);
		if (!cloned.ok) return cloned;

		onProgress?.(`Creating isolated Python venv at ${this._venvDir()}…`);
		const venv = await this._runCommand("python3", ["-m", "venv", this._venvDir()]);
		if (!venv.ok) return { ok: false, error: `setup-fail: ${tailLines(venv.error ?? venv.stderr)}` };
		if (!this._exists(this._pythonPath())) {
			return { ok: false, error: `setup-fail: venv created but ${this._pythonPath()} was not found` };
		}

		onProgress?.("Upgrading pip inside the pi-managed venv…");
		const pipUpgrade = await this._runCommand(this._pythonPath(), ["-m", "pip", "install", "--upgrade", "pip"]);
		if (!pipUpgrade.ok) {
			return { ok: false, error: `setup-fail: ${tailLines(pipUpgrade.error ?? pipUpgrade.stderr)}` };
		}

		onProgress?.("Installing needle (editable) into the pi-managed venv…");
		const install = await this._runCommand(this._pythonPath(), ["-m", "pip", "install", "-e", srcDir]);
		if (!install.ok) return { ok: false, error: `setup-fail: ${tailLines(install.error ?? install.stderr)}` };

		const cudaAvailable = this._hasNvidiaGpu();
		onProgress?.(cudaAvailable ? "Installing JAX (CUDA 12 backend)…" : "Installing JAX (CPU backend)…");
		const jaxArgs = cudaAvailable ? ["jax[cuda12]"] : ["jax"];
		const jax = await this._runCommand(this._pythonPath(), ["-m", "pip", "install", "-U", ...jaxArgs]);
		if (!jax.ok) return { ok: false, error: `setup-fail: ${tailLines(jax.error ?? jax.stderr)}` };

		onProgress?.("Verifying the needle install…");
		const verify = await this._runCommand(this._pythonPath(), ["-c", "import jax, needle; print(needle.__file__)"]);
		if (!verify.ok) return { ok: false, error: `verify-fail: ${tailLines(verify.error ?? verify.stderr)}` };

		const entryCommand = this._entryPath();
		if (!this._exists(entryCommand)) {
			return { ok: false, error: `verify-fail: install reported success but ${entryCommand} was not found` };
		}

		this._writeManifest({ commit: NEEDLE_PINNED_COMMIT, entryCommand });
		onProgress?.("needle installed.");
		return { ok: true };
	}

	/**
	 * A plain `git clone --depth 1` only lands on {@link NEEDLE_PINNED_COMMIT} when it still happens
	 * to be the remote's current default-branch tip. Fetching the exact SHA directly instead (verified
	 * against the real repo) pins reliably even after upstream moves on: GitHub serves any reachable
	 * commit for a public repo via `git fetch <sha>`, not just refs.
	 */
	private async _cloneAtPinnedCommit(srcDir: string): Promise<{ ok: boolean; error?: string }> {
		const init = await this._runCommand("git", ["init", "-q", srcDir]);
		if (!init.ok) return { ok: false, error: `clone-fail: ${tailLines(init.error ?? init.stderr)}` };
		const remote = await this._runCommand("git", ["-C", srcDir, "remote", "add", "origin", NEEDLE_REPO_URL]);
		if (!remote.ok) return { ok: false, error: `clone-fail: ${tailLines(remote.error ?? remote.stderr)}` };
		const fetched = await this._runCommand("git", [
			"-C",
			srcDir,
			"fetch",
			"--depth",
			"1",
			"origin",
			NEEDLE_PINNED_COMMIT,
		]);
		if (!fetched.ok) return { ok: false, error: `clone-fail: ${tailLines(fetched.error ?? fetched.stderr)}` };
		const checkout = await this._runCommand("git", ["-C", srcDir, "checkout", "-q", "FETCH_HEAD"]);
		if (!checkout.ok) return { ok: false, error: `clone-fail: ${tailLines(checkout.error ?? checkout.stderr)}` };
		return { ok: true };
	}

	/**
	 * Download the pretrained base weights (`needle.pkl`). `needle run` takes an explicit
	 * `--checkpoint` and does NOT auto-download one (unlike `needle playground`/`finetune`) — see the
	 * module docstring. Never called implicitly by installManaged/runFunctionCall; the caller decides
	 * when to pull weights.
	 *
	 * `needle.pkl` is a pickle file — arbitrary code execution on load by construction (see the
	 * module-level SECURITY note) — so every download is verified against the pinned sha256+size
	 * ({@link NEEDLE_WEIGHTS_SHA256}/{@link NEEDLE_WEIGHTS_BYTES}, overridable only via the
	 * `weightsIntegrity` test seam) computed in the same streaming pass that writes the file, with the
	 * partial/mismatched file deleted on ANY failure — this never leaves an unverified or wrong pickle
	 * sitting where {@link runFunctionCall} would load it.
	 */
	async downloadWeights(onProgress?: (status: string) => void): Promise<NeedleWeightsDownloadResult> {
		const destPath = this.checkpointPath();
		const url = `https://huggingface.co/${NEEDLE_HF_MODEL_REPO}/resolve/main/${NEEDLE_CHECKPOINT_FILENAME}`;
		mkdirSync(this.modelsDir(), { recursive: true });

		if (this._exists(destPath) && this._fileSizeBytes(destPath) === this._weightsIntegrity.bytes) {
			onProgress?.(
				`${NEEDLE_CHECKPOINT_FILENAME} already downloaded (${this._weightsIntegrity.bytes} bytes) — skipping.`,
			);
			return { ok: true, path: destPath, skipped: true };
		}

		onProgress?.(`Downloading ${NEEDLE_CHECKPOINT_FILENAME} from ${NEEDLE_HF_MODEL_REPO}…`);
		let response: Response;
		try {
			response = await this._fetch(url);
		} catch (error) {
			return { ok: false, error: `download-fail: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!response.ok || !response.body) {
			return { ok: false, error: `download-fail: HTTP ${response.status}` };
		}

		const hash = createHash("sha256");
		try {
			await pipeline(response.body as unknown as Readable, hashingPassThrough(hash), createWriteStream(destPath));
		} catch (error) {
			this._cleanupPartial(destPath);
			return { ok: false, error: `download-fail: ${error instanceof Error ? error.message : String(error)}` };
		}

		const actualBytes = this._fileSizeBytes(destPath);
		const actualSha256 = hash.digest("hex");
		if (actualBytes !== this._weightsIntegrity.bytes || actualSha256 !== this._weightsIntegrity.sha256) {
			this._cleanupPartial(destPath);
			return {
				ok: false,
				error: `integrity-fail: downloaded ${NEEDLE_CHECKPOINT_FILENAME} does not match the pinned checksum — expected sha256 ${this._weightsIntegrity.sha256} (${this._weightsIntegrity.bytes} bytes), got ${actualSha256} (${actualBytes ?? 0} bytes). Refusing to keep a pickle file that failed integrity verification.`,
			};
		}

		onProgress?.(`${NEEDLE_CHECKPOINT_FILENAME} downloaded and verified (sha256 ${actualSha256}).`);
		return { ok: true, path: destPath };
	}

	private _fileSizeBytes(path: string): number | undefined {
		try {
			return statSync(path).size;
		} catch {
			return undefined;
		}
	}

	private _cleanupPartial(path: string): void {
		try {
			rmSync(path, { force: true });
		} catch {
			// best-effort cleanup
		}
	}

	/**
	 * Run one single-shot inference through `needle run --checkpoint ... --query ... --tools ...`
	 * inside the contained venv's installed console script. Argv is passed as an array to the
	 * injected `runCommand` seam — never a shell string — so query/tools text containing quotes,
	 * spaces, or other shell-hostile characters is passed through literally (verified against a real
	 * invocation; see the module docstring). `tools` is serialized with `JSON.stringify` exactly once.
	 */
	async runFunctionCall(
		request: NeedleFunctionCallRequest,
		options?: { checkpointPath?: string },
	): Promise<NeedleFunctionCallResult> {
		const entryCommand = this._entryPath();
		if (!this._exists(entryCommand)) {
			return { ok: false, error: "not-installed: run installManaged() first", rawOutput: "" };
		}
		const checkpointPath = options?.checkpointPath ?? this.checkpointPath();
		if (!this._exists(checkpointPath)) {
			return {
				ok: false,
				error: `checkpoint-missing: no checkpoint at ${checkpointPath} — run downloadWeights() first`,
				rawOutput: "",
			};
		}

		const argv = [
			"run",
			"--checkpoint",
			checkpointPath,
			"--query",
			request.query,
			"--tools",
			JSON.stringify(request.tools),
		];
		const result = await this._runCommand(entryCommand, argv);
		const rawOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");
		if (!result.ok) {
			return { ok: false, error: `run-fail: ${tailLines(result.error ?? result.stderr)}`, rawOutput };
		}
		return this._parseFunctionCall(result.stdout, rawOutput);
	}

	/**
	 * Strictly parse a real `needle run` stdout capture:
	 * ```
	 * Loading checkpoint: <path>
	 * Model parameters: <n>
	 *
	 * Query: <query>
	 * Tools: <tools, truncated to 80 chars>...
	 *
	 * <tool_call>[{"name":"...","arguments":{...}}]
	 * ```
	 * (diagnostic lines above the marker vary — e.g. a one-time "Downloading pretrained tokenizer..."
	 * line on a cold cache — so parsing locates the `<tool_call>` marker rather than assuming a fixed
	 * line count/position). Unparseable output is always an error carrying the raw text, never a
	 * guessed result.
	 */
	private _parseFunctionCall(stdout: string, rawOutput: string): NeedleFunctionCallResult {
		const markerIndex = stdout.indexOf(NEEDLE_TOOL_CALL_MARKER);
		if (markerIndex < 0) {
			return { ok: false, error: `unparseable-output: no ${NEEDLE_TOOL_CALL_MARKER} marker in stdout`, rawOutput };
		}
		const jsonText = stdout.slice(markerIndex + NEEDLE_TOOL_CALL_MARKER.length).trim();
		let parsed: unknown;
		try {
			parsed = JSON.parse(jsonText);
		} catch (error) {
			return {
				ok: false,
				error: `unparseable-output: ${error instanceof Error ? error.message : String(error)}`,
				rawOutput,
			};
		}
		if (!Array.isArray(parsed) || parsed.length === 0) {
			return { ok: false, error: "unparseable-output: expected a non-empty tool-call array", rawOutput };
		}
		const first = parsed[0] as { name?: unknown; arguments?: unknown };
		if (
			typeof first !== "object" ||
			first === null ||
			typeof first.name !== "string" ||
			typeof first.arguments !== "object" ||
			first.arguments === null
		) {
			return { ok: false, error: "unparseable-output: tool call missing name/arguments", rawOutput };
		}
		return { ok: true, call: { name: first.name, arguments: first.arguments as Record<string, unknown> } };
	}

	/** Canned get_weather query/tool through {@link runFunctionCall}; the wiring task uses this as the
	 * post-install verification step. */
	async smokeTest(onProgress?: (status: string) => void): Promise<NeedleSmokeTestResult> {
		onProgress?.("Running needle smoke test…");
		const startedAt = Date.now();
		const result = await this.runFunctionCall({ query: NEEDLE_SMOKE_QUERY, tools: NEEDLE_SMOKE_TOOLS });
		const latencyMs = Date.now() - startedAt;
		if (!result.ok) {
			onProgress?.(`Smoke test failed: ${result.error}`);
			return { ok: false, latencyMs, error: result.error };
		}
		onProgress?.(`Smoke test ok (${latencyMs}ms): ${result.call.name}`);
		return { ok: true, latencyMs, call: result.call };
	}

	/**
	 * No-op: every needle invocation here is a single-shot `runCommand` call that spawns, waits for
	 * exit, and returns — there is no persistent/detached child process this runtime owns between
	 * calls for dispose() to track or kill (contrast OllamaRuntime/PrismLlamaCppRuntime's long-lived
	 * `serve()` child).
	 */
	dispose(): void {}
}
