import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, arch as osArch, platform as osPlatform } from "node:os";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import * as nodeZlib from "node:zlib";
import { spawnProcess, spawnProcessSync, waitForChildProcess } from "../../utils/child-process.ts";

/**
 * `spawnProcess(..., { stdio: ["pipe", "pipe", "pipe"] })` always yields a non-null `stdin` at
 * runtime, but child-process.ts's typed overload only narrows `.stdin` to non-null for the
 * capture-only (`StdioNull, StdioPipe, StdioPipe`) shape, so the generic overload's `Writable |
 * null` leaks through here. This makes the true invariant explicit and fails loudly (instead of
 * silently misbehaving) if it's ever violated by a future stdio change.
 */
function requireStdin(proc: ChildProcess, label: string): Writable {
	if (!proc.stdin) throw new Error(`${label}: no stdin pipe`);
	return proc.stdin;
}

/**
 * Local model runtime manager (local-model-lifecycle-design.md): Ollama first, interface kept
 * runtime-agnostic. Pi SPAWNS the serve process itself with OWNED model storage
 * (`OLLAMA_MODELS=<agentDir>/models/ollama`) so every downloaded weight lives inside pi's tree —
 * per-model disk accounting is trivial and full cleanup is one directory. If a system server is
 * already running, pi uses it instead of double-installing, with the honest tradeoff surfaced:
 * storage then lives in the system daemon's dir and removal control is limited to `ollama rm`.
 *
 * Hard boundaries (design "Hard boundaries"): lifecycle actions are USER commands only — this
 * module is never exposed as a model-invokable tool; install is GUIDE MODE (exact manual steps,
 * never `curl | sh`); removal is explicit, disclosed, and never automatic.
 */

export interface LocalRuntimeStatus {
	binaryPath?: string;
	binarySource?: "system" | "user" | "pi-owned";
	serverUp: boolean;
	serverUrl: string;
	/** True when the responding server is a child process pi spawned (owned storage applies). */
	managedByPi: boolean;
	/** Owned weights directory (only meaningful for pi-managed serves). */
	ownedModelsDir: string;
}

export interface InstalledLocalModel {
	name: string;
	sizeBytes: number;
}

/** Pinned ollama release for the managed installer below. Bump here when needed — one constant. */
export const OLLAMA_PINNED_VERSION = "0.31.1";

export type OllamaAssetKind = "tar-zst" | "tar-gz" | "zip";

export interface OllamaReleaseAsset {
	name: string;
	kind: OllamaAssetKind;
}

/**
 * Maps a platform/arch pair (node's `os.platform()`/`os.arch()`) to the exact ollama release asset
 * name for {@link OLLAMA_PINNED_VERSION} — verified against the real ollama/ollama GitHub release
 * and its own install.sh, not guessed: darwin ships a CLI `.tgz` (the `.app`/`.dmg`/`Ollama-*.zip`
 * assets are the separate GUI-app installer, not what we want), linux ships `.tar.zst` per arch,
 * windows ships `.zip` per arch. Pure and exported so it's independently testable and reusable
 * (e.g. by a future doctor-driven managed install) without touching OllamaRuntime.
 */
export function resolveOllamaAsset(plat: string, architecture: string): OllamaReleaseAsset | undefined {
	if (plat === "darwin") {
		// Universal binary — one asset for both arm64 and x64.
		return { name: "ollama-darwin.tgz", kind: "tar-gz" };
	}
	if (plat === "linux") {
		const archName = architecture === "arm64" ? "arm64" : "amd64";
		return { name: `ollama-linux-${archName}.tar.zst`, kind: "tar-zst" };
	}
	if (plat === "win32") {
		const archName = architecture === "arm64" ? "arm64" : "amd64";
		return { name: `ollama-windows-${archName}.zip`, kind: "zip" };
	}
	return undefined;
}

export interface LocalRuntimeDeps {
	fetchFn?: typeof fetch;
	spawnFn?: (
		command: string,
		args: string[],
		options: { env: NodeJS.ProcessEnv },
	) => Pick<ChildProcess, "pid" | "kill" | "unref" | "on">;
	existsFn?: (path: string) => boolean;
	envPath?: string;
	homeDir?: string;
	sleepFn?: (ms: number) => Promise<void>;
	/** os.platform()/os.arch() equivalents — injectable so asset resolution is testable per platform. */
	platform?: () => string;
	arch?: () => string;
	/** Node's built-in zstd decompress transform, when THIS runtime's node:zlib has it — undefined
	 * forces the system-zstd fallback. Injectable so tests can force either path deterministically
	 * instead of depending on whatever Node happens to be running the test. */
	createZstdDecompress?: () => NodeJS.ReadWriteStream;
	/** Whether a named command exists on PATH (e.g. system `zstd`), for the extraction fallback. */
	hasCommand?: (command: string) => boolean;
	/** Runs the extraction step for a downloaded archive. Injectable so installManaged's
	 * download->extract->verify orchestration is testable without a real tar/zstd/unzip pipeline;
	 * defaults to the real spawn-based extractor. */
	extractArchive?: (
		input: NodeJS.ReadableStream,
		destDir: string,
		kind: OllamaAssetKind,
	) => Promise<{ ok: boolean; error?: string }>;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const HEALTH_TIMEOUT_MS = 2_000;
const START_POLL_ATTEMPTS = 20;
const START_POLL_INTERVAL_MS = 500;

export class OllamaRuntime {
	private readonly _agentDir: string;
	private readonly _baseUrl: string;
	private readonly _fetch: typeof fetch;
	private readonly _spawn: NonNullable<LocalRuntimeDeps["spawnFn"]>;
	private readonly _exists: (path: string) => boolean;
	private readonly _envPath: string;
	private readonly _homeDir: string;
	private readonly _sleep: (ms: number) => Promise<void>;
	private readonly _platform: () => string;
	private readonly _arch: () => string;
	private readonly _createZstdDecompress: (() => NodeJS.ReadWriteStream) | undefined;
	private readonly _hasCommand: (command: string) => boolean;
	private readonly _extractArchiveOverride: LocalRuntimeDeps["extractArchive"] | undefined;
	private _child: Pick<ChildProcess, "pid" | "kill" | "unref" | "on"> | undefined;

	constructor(args: { agentDir: string; baseUrl?: string; deps?: LocalRuntimeDeps }) {
		this._agentDir = args.agentDir;
		this._baseUrl = (args.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
		this._fetch = args.deps?.fetchFn ?? fetch;
		this._spawn = args.deps?.spawnFn ?? ((command, argv, options) => spawn(command, argv, options));
		this._exists = args.deps?.existsFn ?? existsSync;
		this._envPath = args.deps?.envPath ?? process.env.PATH ?? "";
		this._homeDir = args.deps?.homeDir ?? homedir();
		this._sleep = args.deps?.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this._platform = args.deps?.platform ?? osPlatform;
		this._arch = args.deps?.arch ?? osArch;
		// Feature-detect (not version-sniff): recent Node added zstd natively to node:zlib. Verified
		// present on this repo's minimum supported Node (>=22.19.0); still detected at runtime rather
		// than assumed, so an older/different Node correctly falls through to the system-zstd path.
		// `"createZstdDecompress" in deps` (rather than `??`) so a test can force the fallback path by
		// passing the key as explicitly undefined, distinct from omitting it (real auto-detection).
		this._createZstdDecompress =
			args.deps && "createZstdDecompress" in args.deps
				? args.deps.createZstdDecompress
				: typeof nodeZlib.createZstdDecompress === "function"
					? () => nodeZlib.createZstdDecompress()
					: undefined;
		this._hasCommand =
			args.deps?.hasCommand ??
			((command) => spawnProcessSync(command, ["--version"], { encoding: "utf8" }).error === undefined);
		this._extractArchiveOverride = args.deps?.extractArchive;
	}

	get baseUrl(): string {
		return this._baseUrl;
	}

	ownedModelsDir(): string {
		return join(this._agentDir, "models", "ollama");
	}

	private _findBinary(): { path: string; source: "system" | "user" | "pi-owned" } | undefined {
		const piOwned = join(this._agentDir, "runtimes", "ollama", "bin", "ollama");
		if (this._exists(piOwned)) return { path: piOwned, source: "pi-owned" };
		const userLevel = join(this._homeDir, ".local", "share", "ollama-dist", "bin", "ollama");
		if (this._exists(userLevel)) return { path: userLevel, source: "user" };
		for (const dir of this._envPath.split(delimiter)) {
			if (!dir) continue;
			const candidate = join(dir, "ollama");
			if (this._exists(candidate)) return { path: candidate, source: "system" };
		}
		return undefined;
	}

	private async _serverUp(): Promise<boolean> {
		try {
			const response = await this._fetch(`${this._baseUrl}/api/tags`, {
				signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	async detect(): Promise<LocalRuntimeStatus> {
		const binary = this._findBinary();
		const serverUp = await this._serverUp();
		return {
			binaryPath: binary?.path,
			binarySource: binary?.source,
			serverUp,
			serverUrl: this._baseUrl,
			managedByPi: this._child !== undefined && serverUp,
			ownedModelsDir: this.ownedModelsDir(),
		};
	}

	/**
	 * Manual-steps fallback text — shown when the managed install below wasn't offered (headless),
	 * was declined, or itself failed. #31 reversed the stance for ollama specifically: pi CAN install
	 * it for you now (consent-gated, a controlled download into pi's own runtimes dir, never
	 * `curl | sh`) — these steps are the alternative for when that path isn't taken.
	 */
	installGuide(): string[] {
		return [
			"Ollama is not installed. Pi can install it for you now (asks first, never curl|sh) — or follow these manual steps yourself:",
			"  1. Download the pinned release archive for your platform:",
			"     https://github.com/ollama/ollama/releases (asset: ollama-linux-amd64.tar.zst or your platform)",
			`  2. Extract it to ${join(this._homeDir, ".local", "share", "ollama-dist")}`,
			"  3. Re-run your /models command - pi detects the binary automatically.",
			"Alternatively install system-wide from https://ollama.com/download and pi will use the system server.",
		];
	}

	/** Which decompressor to use for a `.tar.zst` asset — native (this Node's own zlib) is always
	 * preferred when available, even if a system `zstd` ALSO exists, since it needs no external
	 * dependency at all. Verified per-runtime by feature detection (see the constructor), not by
	 * guessing from a Node version number. */
	private _chooseZstdStrategy(): { kind: "native" } | { kind: "system" } | { kind: "unavailable" } {
		if (this._createZstdDecompress) return { kind: "native" };
		if (this._hasCommand("zstd")) return { kind: "system" };
		return { kind: "unavailable" };
	}

	/**
	 * Managed install (#31): a consent-gated, controlled download of the pinned ollama release into
	 * pi's OWN runtimes dir (`<agentDir>/runtimes/ollama/`) — never `curl | sh`, never a second
	 * server instance, and distinct from {@link start}'s owned MODEL storage (this is the binary
	 * itself). Callers (the router's consent flow, and later a doctor-driven install) own the
	 * consent/UI; this method only does the mechanical download+extract+verify and reports the
	 * outcome honestly. `onProgress` is best-effort UI feedback, not a completion signal.
	 */
	async installManaged(onProgress?: (status: string) => void): Promise<{ ok: boolean; error?: string }> {
		const asset = resolveOllamaAsset(this._platform(), this._arch());
		if (!asset) return { ok: false, error: "unsupported-platform" };

		onProgress?.(`Downloading ${asset.name}…`);
		const downloadUrl = `https://github.com/ollama/ollama/releases/download/v${OLLAMA_PINNED_VERSION}/${asset.name}`;
		let response: Response;
		try {
			response = await this._fetch(downloadUrl);
		} catch (error) {
			return { ok: false, error: `download-fail: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!response.ok || !response.body) {
			return { ok: false, error: `download-fail: HTTP ${response.status}` };
		}

		const destDir = join(this._agentDir, "runtimes", "ollama");
		mkdirSync(destDir, { recursive: true });

		onProgress?.(`Extracting ${asset.name}…`);
		const extract = this._extractArchiveOverride ?? ((input, dest, kind) => this._extractArchive(input, dest, kind));
		const extracted = await extract(response.body as unknown as NodeJS.ReadableStream, destDir, asset.kind);
		if (!extracted.ok) return extracted;

		const binaryName = this._platform() === "win32" ? "ollama.exe" : "ollama";
		const binaryPath = join(destDir, "bin", binaryName);
		if (!this._exists(binaryPath)) {
			return { ok: false, error: "extract-fail: binary not found after extraction" };
		}
		onProgress?.("Ollama installed.");
		return { ok: true };
	}

	/** Real extraction: `tar-gz` lets `tar` itself gunzip; `tar-zst` decompresses first (native
	 * node:zlib preferred, system `zstd` as fallback, an honest error if neither exists — see
	 * {@link _chooseZstdStrategy}); `zip` needs a seekable file, so it's buffered to disk first. */
	private async _extractArchive(
		input: NodeJS.ReadableStream,
		destDir: string,
		kind: OllamaAssetKind,
	): Promise<{ ok: boolean; error?: string }> {
		try {
			if (kind === "zip") {
				return await this._extractZip(input, destDir);
			}
			return await this._extractTar(input, destDir, kind);
		} catch (error) {
			return { ok: false, error: `extract-fail: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	private async _extractTar(
		input: NodeJS.ReadableStream,
		destDir: string,
		kind: "tar-gz" | "tar-zst",
	): Promise<{ ok: boolean; error?: string }> {
		let decompressed: Readable = input as unknown as Readable;
		const tarArgs = ["-xf", "-", "-C", destDir];
		if (kind === "tar-zst") {
			const strategy = this._chooseZstdStrategy();
			if (strategy.kind === "unavailable") {
				return {
					ok: false,
					error: "zstd-missing: this archive needs zstd to decompress and neither Node's built-in support nor a system `zstd` binary was found. Install zstd (e.g. `apt-get install zstd`, `dnf install zstd`, `pacman -S zstd`) and try again.",
				};
			}
			if (strategy.kind === "native") {
				decompressed = decompressed.pipe(
					this._createZstdDecompress?.() as unknown as NodeJS.ReadWriteStream & Readable,
				);
			} else {
				const zstdProc = spawnProcess("zstd", ["-d"], { stdio: ["pipe", "pipe", "pipe"] });
				decompressed.pipe(requireStdin(zstdProc, "zstd"));
				decompressed = zstdProc.stdout as unknown as Readable;
			}
		} else {
			// tar itself handles gzip via -z — no separate decompression step needed.
			tarArgs[0] = "-xzf";
		}
		const tarProc = spawnProcess("tar", tarArgs, { stdio: ["pipe", "pipe", "pipe"] });
		decompressed.pipe(requireStdin(tarProc, "tar"));
		const code = await waitForChildProcess(tarProc);
		if (code !== 0) {
			return { ok: false, error: `extract-fail: tar exited with code ${code}` };
		}
		return { ok: true };
	}

	private async _extractZip(input: NodeJS.ReadableStream, destDir: string): Promise<{ ok: boolean; error?: string }> {
		// Zip's central directory needs seekable file access — buffer to a temp file first.
		const { createWriteStream } = await import("node:fs");
		const { pipeline } = await import("node:stream/promises");
		const zipPath = join(destDir, "..", `ollama-download-${process.pid}-${Date.now()}.zip`);
		await pipeline(input as unknown as Readable, createWriteStream(zipPath));
		try {
			const extractCommand = this._platform() === "win32" && this._hasCommand("tar") ? "tar" : "unzip";
			const args = extractCommand === "tar" ? ["-xf", zipPath, "-C", destDir] : ["-q", zipPath, "-d", destDir];
			const proc = spawnProcess(extractCommand, args, { stdio: ["ignore", "pipe", "pipe"] });
			const code = await waitForChildProcess(proc);
			if (code !== 0) {
				return { ok: false, error: `extract-fail: ${extractCommand} exited with code ${code}` };
			}
			return { ok: true };
		} finally {
			try {
				const { rmSync } = await import("node:fs");
				rmSync(zipPath, { force: true });
			} catch {
				// best-effort cleanup
			}
		}
	}

	/** Shared spawn-then-health-poll for both start modes below; `extraEnv` is the only thing that
	 * differs between them (owned storage vs reusing the user's own). */
	private async _spawnAndPoll(
		binary: { path: string },
		extraEnv: NodeJS.ProcessEnv,
	): Promise<{ started: boolean; reason: string }> {
		const host = this._baseUrl.replace(/^https?:\/\//, "");
		this._child = this._spawn(binary.path, ["serve"], {
			env: { ...process.env, OLLAMA_HOST: host, ...extraEnv },
		});
		this._child.unref?.();
		for (let attempt = 0; attempt < START_POLL_ATTEMPTS; attempt++) {
			if (await this._serverUp()) return { started: true, reason: "started" };
			await this._sleep(START_POLL_INTERVAL_MS);
		}
		this.stop();
		return { started: false, reason: "health_check_timeout" };
	}

	/**
	 * Start a pi-managed serve with OWNED storage and the hardened env verified on this class of
	 * hardware. No-op (reported) when a server already responds — pi never double-serves. Used by
	 * `/models add` et al, where isolated per-model-pull storage is the point.
	 */
	async start(): Promise<{ started: boolean; reason: string }> {
		if (await this._serverUp()) {
			return { started: false, reason: this._child ? "already_running_managed" : "already_running_system" };
		}
		const binary = this._findBinary();
		if (!binary) return { started: false, reason: "binary_missing" };
		mkdirSync(this.ownedModelsDir(), { recursive: true });
		return this._spawnAndPoll(binary, {
			OLLAMA_MODELS: this.ownedModelsDir(),
			OLLAMA_FLASH_ATTENTION: "1",
			OLLAMA_KV_CACHE_TYPE: "q8_0",
			OLLAMA_NUM_PARALLEL: "1",
			OLLAMA_MAX_LOADED_MODELS: "3",
		});
	}

	/**
	 * Start a serve that REUSES the user's own existing models directory (no `OLLAMA_MODELS`
	 * override — falls through to Ollama's own default, `~/.ollama`), for callers that must see the
	 * user's already-pulled models rather than pi's isolated/owned storage. Same idempotency and
	 * hardened perf env as {@link start}; the only difference is which storage the server sees.
	 */
	async startReuseExisting(): Promise<{ started: boolean; reason: string }> {
		if (await this._serverUp()) {
			return { started: false, reason: this._child ? "already_running_managed" : "already_running_system" };
		}
		const binary = this._findBinary();
		if (!binary) return { started: false, reason: "binary_missing" };
		return this._spawnAndPoll(binary, {
			OLLAMA_FLASH_ATTENTION: "1",
			OLLAMA_KV_CACHE_TYPE: "q8_0",
			OLLAMA_NUM_PARALLEL: "1",
			OLLAMA_MAX_LOADED_MODELS: "3",
		});
	}

	/** Resource hygiene only: stops the pi-managed serve process; never deletes anything. */
	stop(): { stopped: boolean } {
		if (!this._child) return { stopped: false };
		try {
			this._child.kill("SIGTERM");
		} catch {
			// already gone
		}
		this._child = undefined;
		return { stopped: true };
	}

	async list(): Promise<InstalledLocalModel[]> {
		const response = await this._fetch(`${this._baseUrl}/api/tags`, { signal: AbortSignal.timeout(10_000) });
		if (!response.ok) throw new Error(`ollama list failed: HTTP ${response.status}`);
		const data = (await response.json()) as { models?: Array<{ name?: string; size?: number }> };
		return (data.models ?? [])
			.filter((model): model is { name: string; size?: number } => typeof model.name === "string")
			.map((model) => ({ name: model.name, sizeBytes: model.size ?? 0 }));
	}

	/** Pull a model through the server API (weights land in the SERVER's models dir). */
	async pull(ref: string, onProgress?: (status: string) => void): Promise<{ ok: boolean; error?: string }> {
		try {
			const response = await this._fetch(`${this._baseUrl}/api/pull`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: ref, stream: true }),
			});
			if (!response.ok || !response.body) {
				return {
					ok: false,
					error: `pull failed: HTTP ${response.status} ${await response.text().catch(() => "")}`,
				};
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let lastStatus = "";
			let errorMessage: string | undefined;
			const handleLine = (line: string): void => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line) as { status?: string; error?: string };
					if (event.error) errorMessage = event.error;
					if (event.status && event.status !== lastStatus) {
						lastStatus = event.status;
						onProgress?.(event.status);
					}
				} catch {
					// partial line noise
				}
			};
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) handleLine(line);
			}
			// The stream's FINAL line has no trailing newline — it stays in the buffer and holds
			// the terminal "success"/error event; dropping it misreports every completed pull.
			handleLine(buffer);
			if (errorMessage) return { ok: false, error: errorMessage };
			return lastStatus === "success"
				? { ok: true }
				: { ok: false, error: `pull ended with: ${lastStatus || "unknown"}` };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** EXPLICIT user action only — callers must have shown what gets deleted and confirmed. */
	async remove(ref: string): Promise<{ ok: boolean; error?: string }> {
		try {
			const response = await this._fetch(`${this._baseUrl}/api/delete`, {
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: ref }),
			});
			if (!response.ok) {
				return {
					ok: false,
					error: `delete failed: HTTP ${response.status} ${await response.text().catch(() => "")}`,
				};
			}
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}
}
