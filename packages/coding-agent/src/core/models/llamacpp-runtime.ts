import { type ChildProcess, spawn } from "node:child_process";
import {
	createWriteStream,
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { arch as osArch, platform as osPlatform } from "node:os";
import { dirname, join, relative } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnProcess, spawnProcessSync, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import { modelsDir as agentModelsDir, runtimesDir as agentRuntimesDir } from "../agent-paths.ts";

/**
 * Managed runtime for prism-ml 1-bit GGUF models (Bonsai-27B first). The provider requires their
 * llama.cpp fork (Q1_0_g128 hybrid-attention kernels) — stock llama.cpp/Ollama cannot serve these
 * weights — so this module owns runtime install (prebuilt release download+extract), GGUF
 * downloads, and llama-server lifecycle. Mirrors local-runtime.ts's OllamaRuntime: injectable
 * seams for fetch/spawn/exists, pi-owned directories under agentDir (runtimes/, models/),
 * detached+tracked child processes, onProgress as best-effort UI feedback, honest error taxonomies
 * instead of silent fallbacks.
 *
 * The fork publishes precompiled per-platform archives on GitHub Releases (no local build): pin a
 * release tag, download the matching asset, extract it, and locate the `llama-server` binary once
 * at install time (release archive layouts vary — bin/ vs build/bin/ at the top level — so this is
 * a deterministic one-time scan, not a fallback). The found relative path and backend (cpu/cuda)
 * are persisted to a manifest so later `detect()`/`serve()` calls never need to re-scan.
 */

/**
 * Pinned Prism ML llama.cpp fork release — verified via
 * `GET https://api.github.com/repos/PrismML-Eng/llama.cpp/releases/tags/prism-b9594-38c66ad` on
 * 2026-07-18 (release exists, all assets referenced below are present on it). Bump here (and
 * re-verify with the same API call) when the provider ships new kernels.
 */
export const PRISM_LLAMACPP_PINNED_RELEASE = "prism-b9594-38c66ad";

export const PRISM_LLAMACPP_RELEASES_BASE_URL = "https://github.com/PrismML-Eng/llama.cpp/releases/download";

export interface PrismModelDescriptor {
	repo: string;
	file: string;
	mmprojFile?: string;
	displayName: string;
}

/** Curated first-model descriptor; the `/models add` wiring task consumes this. */
export const BONSAI_27B: PrismModelDescriptor = {
	repo: "prism-ml/Bonsai-27B-gguf",
	file: "Bonsai-27B-Q1_0.gguf",
	mmprojFile: "Bonsai-27B-mmproj-Q8_0.gguf",
	displayName: "Bonsai-27B (1-bit Q1_0 + vision)",
};

export type PrismBackend = "cpu" | "cuda";
export type PrismAssetKind = "tar-gz" | "zip";

export interface PrismLlamaAsset {
	name: string;
	kind: PrismAssetKind;
	backend: PrismBackend;
}

// Verbatim asset names from the pinned release (see PRISM_LLAMACPP_PINNED_RELEASE doc comment) —
// hardcoded rather than templated from the tag because the provider's naming isn't fully
// consistent across platforms (Windows CPU assets drop the tag/commit segment entirely; the
// Windows CUDA asset uses a different build-number segment, "b1" not "b9594").
const LINUX_X64_CPU_ASSET = "llama-prism-b9594-38c66ad-bin-ubuntu-x64.tar.gz";
const LINUX_ARM64_CPU_ASSET = "llama-prism-b9594-38c66ad-bin-ubuntu-arm64.tar.gz";
const LINUX_X64_CUDA_ASSET = "llama-prism-b9594-38c66ad-bin-linux-cuda-12.4-x64.tar.gz";
const MACOS_ARM64_ASSET = "llama-prism-b9594-38c66ad-bin-macos-arm64.tar.gz";
const MACOS_X64_ASSET = "llama-prism-b9594-38c66ad-bin-macos-x64.tar.gz";
const WIN_X64_CPU_ASSET = "llama-bin-win-cpu-x64.zip";
const WIN_ARM64_CPU_ASSET = "llama-bin-win-cpu-arm64.zip";

/**
 * Maps a platform/arch/GPU triple to the exact Prism llama.cpp release asset for
 * {@link PRISM_LLAMACPP_PINNED_RELEASE} — verified against the real GitHub release, not guessed.
 * CPU asset by default; the CUDA 12.4 variant is only offered for linux x64 with an NVIDIA GPU
 * present (a 12.8 variant also exists upstream but has no wired caller yet). Windows CUDA needs a
 * companion `cudart-*` archive and is out of scope for v1 — Windows always resolves to the CPU zip
 * regardless of `hasNvidiaGpu`. Pure and exported so it's independently testable.
 */
export function resolvePrismLlamaAsset(
	plat: string,
	architecture: string,
	hasNvidiaGpu: boolean,
): PrismLlamaAsset | undefined {
	if (plat === "linux") {
		if (architecture === "x64") {
			return hasNvidiaGpu
				? { name: LINUX_X64_CUDA_ASSET, kind: "tar-gz", backend: "cuda" }
				: { name: LINUX_X64_CPU_ASSET, kind: "tar-gz", backend: "cpu" };
		}
		if (architecture === "arm64") return { name: LINUX_ARM64_CPU_ASSET, kind: "tar-gz", backend: "cpu" };
		return undefined;
	}
	if (plat === "darwin") {
		if (architecture === "arm64") return { name: MACOS_ARM64_ASSET, kind: "tar-gz", backend: "cpu" };
		if (architecture === "x64") return { name: MACOS_X64_ASSET, kind: "tar-gz", backend: "cpu" };
		return undefined;
	}
	if (plat === "win32") {
		if (architecture === "x64") return { name: WIN_X64_CPU_ASSET, kind: "zip", backend: "cpu" };
		if (architecture === "arm64") return { name: WIN_ARM64_CPU_ASSET, kind: "zip", backend: "cpu" };
		return undefined;
	}
	return undefined;
}

export interface PrismDetectResult {
	runtimeInstalled: boolean;
	binaryPath?: string;
	release?: string;
}

export interface PrismDownloadResult {
	ok: boolean;
	path?: string;
	skipped?: boolean;
	error?: string;
}

export type PrismServeResult = { ok: true; baseUrl: string } | { ok: false; error: string };

interface PrismInstallManifest {
	release: string;
	binaryRelPath: string;
	backend: PrismBackend;
}

type PrismSpawnOptions = { detached?: boolean; stdio?: "ignore"; env?: NodeJS.ProcessEnv };
type PrismSpawnFn = (
	command: string,
	args: string[],
	options: PrismSpawnOptions,
) => Pick<ChildProcess, "pid" | "kill" | "unref" | "on">;
type PrismExtractArchiveFn = (
	input: Readable,
	destDir: string,
	kind: PrismAssetKind,
) => Promise<{ ok: boolean; error?: string }>;

export interface PrismLlamaCppDeps {
	fetchFn?: typeof fetch;
	spawnFn?: PrismSpawnFn;
	existsFn?: (path: string) => boolean;
	sleepFn?: (ms: number) => Promise<void>;
	/** Whether a named command exists on PATH (nvidia-smi, tar — for zip extraction on Windows). */
	hasCommand?: (command: string) => boolean;
	/** Decided once at install time and persisted as `backend` — serve() reads the persisted value
	 * so `-ngl 99` reflects what was actually installed, not the host's current GPU state. */
	hasNvidiaGpu?: () => boolean;
	platform?: () => string;
	arch?: () => string;
	/** Runs the extraction step for a downloaded archive. Injectable so installManaged's
	 * download->extract->scan orchestration is testable without a real tar/unzip pipeline; defaults
	 * to the real spawn-based extractor. */
	extractArchive?: PrismExtractArchiveFn;
	/** Health-poll bounds for serve(); default ~120s (240 * 500ms), both overridable for tests. */
	healthPollAttempts?: number;
	healthPollIntervalMs?: number;
}

const EXTRACTION_TIMEOUT_MS = 10 * 60_000;
const COMMAND_KILL_GRACE_MS = 2_000;
const DEFAULT_HEALTH_POLL_ATTEMPTS = 240;
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_CHECK_TIMEOUT_MS = 2_000;
const HEAD_REQUEST_TIMEOUT_MS = 10_000;

function parseContentLength(header: string | null): number | undefined {
	if (!header) return undefined;
	const value = Number(header);
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * `spawnProcess(..., { stdio: ["pipe", ...] })` always yields a non-null `stdin` at runtime, but
 * child-process.ts's typed overload only narrows `.stdin` for the capture-only stdio shape used
 * elsewhere. This makes the true invariant explicit and fails loudly instead of silently
 * misbehaving if it's ever violated by a future stdio change.
 */
function requireStdin(proc: ChildProcess, label: string): Writable {
	if (!proc.stdin) throw new Error(`${label}: no stdin pipe`);
	return proc.stdin;
}

export class PrismLlamaCppRuntime {
	private readonly _agentDir: string;
	private readonly _fetch: typeof fetch;
	private readonly _spawn: PrismSpawnFn;
	private readonly _exists: (path: string) => boolean;
	private readonly _sleep: (ms: number) => Promise<void>;
	private readonly _hasCommand: (command: string) => boolean;
	private readonly _hasNvidiaGpu: () => boolean;
	private readonly _platform: () => string;
	private readonly _arch: () => string;
	private readonly _extractArchiveOverride: PrismExtractArchiveFn | undefined;
	private readonly _healthPollAttempts: number;
	private readonly _healthPollIntervalMs: number;
	private _child: Pick<ChildProcess, "pid" | "kill" | "unref" | "on"> | undefined;

	constructor(args: { agentDir: string; deps?: PrismLlamaCppDeps }) {
		this._agentDir = args.agentDir;
		this._fetch = args.deps?.fetchFn ?? fetch;
		this._spawn =
			args.deps?.spawnFn ?? ((command, argv, options) => spawn(command, argv, { ...options, stdio: "ignore" }));
		this._exists = args.deps?.existsFn ?? existsSync;
		this._sleep = args.deps?.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this._hasCommand =
			args.deps?.hasCommand ??
			((command) =>
				spawnProcessSync(command, ["--version"], { encoding: "utf8", timeout: 5_000 }).error === undefined);
		this._hasNvidiaGpu = args.deps?.hasNvidiaGpu ?? (() => this._hasCommand("nvidia-smi"));
		this._platform = args.deps?.platform ?? osPlatform;
		this._arch = args.deps?.arch ?? osArch;
		this._extractArchiveOverride = args.deps?.extractArchive;
		this._healthPollAttempts = args.deps?.healthPollAttempts ?? DEFAULT_HEALTH_POLL_ATTEMPTS;
		this._healthPollIntervalMs = args.deps?.healthPollIntervalMs ?? DEFAULT_HEALTH_POLL_INTERVAL_MS;
	}

	runtimeDir(): string {
		return agentRuntimesDir("prism-llamacpp", this._agentDir);
	}

	modelsDir(): string {
		return agentModelsDir("llamacpp", this._agentDir);
	}

	private _binaryName(): string {
		return this._platform() === "win32" ? "llama-server.exe" : "llama-server";
	}

	private _manifestPath(): string {
		return join(this.runtimeDir(), "install.json");
	}

	private _readManifest(): PrismInstallManifest | undefined {
		try {
			const parsed = JSON.parse(readFileSync(this._manifestPath(), "utf8")) as {
				release?: unknown;
				binaryRelPath?: unknown;
				backend?: unknown;
			};
			if (
				typeof parsed.release === "string" &&
				typeof parsed.binaryRelPath === "string" &&
				(parsed.backend === "cpu" || parsed.backend === "cuda")
			) {
				return { release: parsed.release, binaryRelPath: parsed.binaryRelPath, backend: parsed.backend };
			}
			return undefined;
		} catch {
			return undefined;
		}
	}

	private _writeManifest(manifest: PrismInstallManifest): void {
		writeFileSync(this._manifestPath(), JSON.stringify(manifest, null, "\t"));
	}

	async detect(): Promise<PrismDetectResult> {
		const manifest = this._readManifest();
		if (!manifest) return { runtimeInstalled: false };
		const binaryPath = join(this.runtimeDir(), manifest.binaryRelPath);
		const runtimeInstalled = this._exists(binaryPath);
		return {
			runtimeInstalled,
			binaryPath: runtimeInstalled ? binaryPath : undefined,
			release: manifest.release,
		};
	}

	/** One-time recursive scan for the `llama-server` binary inside a freshly extracted release
	 * archive — layouts vary (bin/ vs build/bin/ at the top level) across platforms/backends, so
	 * this locates it deterministically instead of assuming a fixed path, then the result is
	 * persisted so later calls never need to re-scan. */
	private _findBinaryRelPath(root: string): string | undefined {
		const targetName = this._binaryName();
		const stack: string[] = [root];
		while (stack.length > 0) {
			const dir = stack.pop();
			if (dir === undefined) continue;
			let entries: Dirent[];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) stack.push(full);
				else if (entry.isFile() && entry.name === targetName) return relative(root, full);
			}
		}
		return undefined;
	}

	/**
	 * Download the pinned release asset for this host and extract it (consent-gated by the caller,
	 * same contract as OllamaRuntime#installManaged — this method only does the mechanical
	 * download+extract+locate and reports the outcome honestly). No compiler toolchain required:
	 * the fork ships prebuilt binaries.
	 */
	async installManaged(onProgress?: (status: string) => void): Promise<{ ok: boolean; error?: string }> {
		const asset = resolvePrismLlamaAsset(this._platform(), this._arch(), this._hasNvidiaGpu());
		if (!asset) return { ok: false, error: "unsupported-platform" };

		onProgress?.(`Downloading ${asset.name}…`);
		const downloadUrl = `${PRISM_LLAMACPP_RELEASES_BASE_URL}/${PRISM_LLAMACPP_PINNED_RELEASE}/${asset.name}`;
		let response: Response;
		try {
			response = await this._fetch(downloadUrl);
		} catch (error) {
			return { ok: false, error: `download-fail: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!response.ok || !response.body) {
			return { ok: false, error: `download-fail: HTTP ${response.status}` };
		}

		const destDir = this.runtimeDir();
		mkdirSync(destDir, { recursive: true });

		onProgress?.(`Extracting ${asset.name}…`);
		const extract = this._extractArchiveOverride ?? ((input, dest, kind) => this._extractArchive(input, dest, kind));
		const extracted = await extract(response.body as unknown as Readable, destDir, asset.kind);
		if (!extracted.ok) return extracted;

		onProgress?.("Locating llama-server binary…");
		const binaryRelPath = this._findBinaryRelPath(destDir);
		if (!binaryRelPath) {
			return { ok: false, error: "binary-missing: no llama-server binary found in the extracted archive" };
		}

		this._writeManifest({ release: PRISM_LLAMACPP_PINNED_RELEASE, binaryRelPath, backend: asset.backend });
		onProgress?.("Prism llama.cpp runtime installed.");
		return { ok: true };
	}

	private async _extractArchive(
		input: Readable,
		destDir: string,
		kind: PrismAssetKind,
	): Promise<{ ok: boolean; error?: string }> {
		try {
			return kind === "zip" ? await this._extractZip(input, destDir) : await this._extractTarGz(input, destDir);
		} catch (error) {
			return { ok: false, error: `extract-fail: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	private async _extractTarGz(input: Readable, destDir: string): Promise<{ ok: boolean; error?: string }> {
		const tarProc = spawnProcess("tar", ["-xzf", "-", "-C", destDir], {
			detached: process.platform !== "win32",
			stdio: ["pipe", "ignore", "ignore"],
		});
		const terminationController = new AbortController();
		const processWait = waitForChildProcessWithTermination(tarProc, {
			signal: terminationController.signal,
			timeoutMs: EXTRACTION_TIMEOUT_MS,
			killGraceMs: COMMAND_KILL_GRACE_MS,
		});
		try {
			await pipeline(input, requireStdin(tarProc, "tar"));
		} catch (error) {
			terminationController.abort();
			await processWait.catch(() => {});
			throw error;
		}
		const terminal = await processWait;
		if (terminal.reason === "timeout" || terminal.code !== 0) {
			return {
				ok: false,
				error:
					terminal.reason === "timeout"
						? `extract-fail: tar extraction timed out after ${EXTRACTION_TIMEOUT_MS}ms`
						: `extract-fail: tar exited with code ${terminal.code ?? "unknown"}`,
			};
		}
		return { ok: true };
	}

	private async _extractZip(input: Readable, destDir: string): Promise<{ ok: boolean; error?: string }> {
		// Zip's central directory needs seekable file access — buffer to a temp file first.
		const zipPath = join(destDir, "..", `prism-llamacpp-download-${process.pid}-${Date.now()}.zip`);
		await pipeline(input, createWriteStream(zipPath));
		try {
			const extractCommand = this._platform() === "win32" && this._hasCommand("tar") ? "tar" : "unzip";
			const args = extractCommand === "tar" ? ["-xf", zipPath, "-C", destDir] : ["-q", zipPath, "-d", destDir];
			const proc = spawnProcess(extractCommand, args, { detached: process.platform !== "win32", stdio: "ignore" });
			const terminal = await waitForChildProcessWithTermination(proc, {
				timeoutMs: EXTRACTION_TIMEOUT_MS,
				killGraceMs: COMMAND_KILL_GRACE_MS,
			});
			if (terminal.reason === "timeout" || terminal.code !== 0) {
				return {
					ok: false,
					error:
						terminal.reason === "timeout"
							? `extract-fail: ${extractCommand} timed out after ${EXTRACTION_TIMEOUT_MS}ms`
							: `extract-fail: ${extractCommand} exited with code ${terminal.code ?? "unknown"}`,
				};
			}
			return { ok: true };
		} finally {
			try {
				rmSync(zipPath, { force: true });
			} catch {
				// best-effort cleanup
			}
		}
	}

	private async _remoteContentLength(url: string): Promise<number | undefined> {
		try {
			const response = await this._fetch(url, {
				method: "HEAD",
				signal: AbortSignal.timeout(HEAD_REQUEST_TIMEOUT_MS),
			});
			return response.ok ? parseContentLength(response.headers.get("content-length")) : undefined;
		} catch {
			return undefined;
		}
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
	 * Wait until a write stream's underlying fd is actually closed. `pipeline()` destroys the
	 * stream on error but its promise can settle before the fd close completes (Windows in
	 * particular keeps the file handle open a tick longer) — unlinking before that races with the
	 * OS and can leave the "partial" file behind or fail the delete outright. Resolves immediately
	 * if the stream already reports `closed`.
	 */
	private _waitForStreamClosed(stream: Writable & { closed?: boolean }): Promise<void> {
		if (stream.closed) return Promise.resolve();
		return new Promise((resolve) => {
			stream.once("close", () => resolve());
			stream.destroy();
		});
	}

	/**
	 * Stream a GGUF (or mmproj) file from Hugging Face into pi's owned models dir. Skips a re-download
	 * when the local file already matches the remote size; verifies size when the response reports
	 * `content-length` and deletes the partial file on any failure or mismatch — never leaves a
	 * corrupt/truncated weight file behind for a later load to silently misread.
	 */
	async downloadModel(
		args: { repo: string; file: string },
		onProgress?: (status: string) => void,
	): Promise<PrismDownloadResult> {
		const destPath = join(this.modelsDir(), args.repo, args.file);
		const url = `https://huggingface.co/${args.repo}/resolve/main/${args.file}`;
		mkdirSync(dirname(destPath), { recursive: true });

		if (this._exists(destPath)) {
			const remoteSize = await this._remoteContentLength(url);
			if (remoteSize !== undefined && remoteSize === this._fileSizeBytes(destPath)) {
				onProgress?.(`${args.file} already downloaded (${remoteSize} bytes) — skipping.`);
				return { ok: true, path: destPath, skipped: true };
			}
		}

		onProgress?.(`Downloading ${args.file} from ${args.repo}…`);
		let response: Response;
		try {
			response = await this._fetch(url);
		} catch (error) {
			return { ok: false, error: `download-fail: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!response.ok || !response.body) {
			return { ok: false, error: `download-fail: HTTP ${response.status}` };
		}

		const expectedBytes = parseContentLength(response.headers.get("content-length"));
		const writeStream = createWriteStream(destPath);
		try {
			await pipeline(response.body as unknown as Readable, writeStream);
		} catch (error) {
			await this._waitForStreamClosed(writeStream);
			this._cleanupPartial(destPath);
			return { ok: false, error: `download-fail: ${error instanceof Error ? error.message : String(error)}` };
		}

		const actualBytes = this._fileSizeBytes(destPath);
		if (expectedBytes !== undefined && actualBytes !== expectedBytes) {
			this._cleanupPartial(destPath);
			return { ok: false, error: `size-mismatch: expected ${expectedBytes} bytes, got ${actualBytes ?? 0}` };
		}

		onProgress?.(`${args.file} downloaded (${actualBytes ?? 0} bytes).`);
		return { ok: true, path: destPath };
	}

	private async _healthUp(baseUrl: string): Promise<boolean> {
		try {
			const response = await this._fetch(`${baseUrl}/health`, {
				signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	/**
	 * Spawn `llama-server` detached+tracked (killed on parent shutdown even if pi crashes without
	 * calling stop()) and poll `/health` until ready. `-ngl 99` is only added when the installed
	 * asset's persisted `backend` is `"cuda"`, not from the host's current GPU state.
	 */
	async serve(args: {
		modelPath: string;
		mmprojPath?: string;
		port: number;
		numCtx: number;
	}): Promise<PrismServeResult> {
		const manifest = this._readManifest();
		if (!manifest) return { ok: false, error: "binary-missing" };
		const binaryPath = join(this.runtimeDir(), manifest.binaryRelPath);
		if (!this._exists(binaryPath)) return { ok: false, error: "binary-missing" };

		const baseUrl = `http://127.0.0.1:${args.port}`;
		const argv = [
			"-m",
			args.modelPath,
			...(args.mmprojPath ? ["--mmproj", args.mmprojPath] : []),
			"--host",
			"127.0.0.1",
			"--port",
			String(args.port),
			"-c",
			String(args.numCtx),
			...(manifest.backend === "cuda" ? ["-ngl", "99"] : []),
		];

		const child = this._spawn(binaryPath, argv, {
			detached: process.platform !== "win32",
			stdio: "ignore",
			env: process.env,
		});
		if (child.pid) trackDetachedChildPid(child.pid);
		child.unref?.();
		child.on("exit", () => {
			this._child = undefined;
		});
		this._child = child;

		for (let attempt = 0; attempt < this._healthPollAttempts; attempt++) {
			if (await this._healthUp(baseUrl)) return { ok: true, baseUrl };
			await this._sleep(this._healthPollIntervalMs);
		}
		this.stop();
		return { ok: false, error: "health-timeout" };
	}

	stop(): { stopped: boolean } {
		const child = this._child;
		if (!child) return { stopped: false };
		this._child = undefined;
		if (child.pid) {
			untrackDetachedChildPid(child.pid);
			killProcessTree(child.pid);
		}
		return { stopped: true };
	}

	isRunning(): boolean {
		return this._child !== undefined;
	}
}
