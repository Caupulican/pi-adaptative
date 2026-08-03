import type { ChildProcess } from "node:child_process";
import { type Dirent, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch as osArch, platform as osPlatform } from "node:os";
import { dirname, join, relative } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnProcess, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import { modelsDir as agentModelsDir, runtimesDir as agentRuntimesDir } from "../agent-paths.ts";
import {
	deriveHostLocalInferenceProfile,
	type LocalInferenceProfile,
	type LocalInferenceProfileMode,
} from "./local-inference-profile.ts";
import { probePrismLlamaCppServer } from "./prism-llamacpp-server-probe.ts";
import {
	extractZipArchive,
	fetchRuntimeDownload,
	installRuntimeArchive,
	type ManagedRuntimeSpawn,
	removePartialDownload,
	requireRuntimeStdin,
	resolveRuntimeLifecycleDependencies,
	runtimeCommandAvailable,
	tryFileSizeBytes,
	writeRuntimeDownload,
} from "./runtime-process.ts";

/**
 * Managed runtime for Pi's curated Prism 1-bit and ternary GGUF models. Q1_0 is available in
 * upstream llama.cpp, while the selected group-128 Q2_0 artifacts and paired DSpark acceleration
 * still require Prism's validated build. This module therefore owns the pinned runtime install,
 * GGUF downloads, and llama-server lifecycle. Mirrors local-runtime.ts's OllamaRuntime: injectable
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
	architecture: "dense";
	runtime: "prism-llamacpp";
	family: "bonsai" | "ternary-bonsai";
	parameterScale: "1.7B" | "4B" | "8B" | "27B";
	weightFormat: "q1_0" | "q2_0";
	matchedDrafter?: {
		kind: "dspark";
		file: string;
		draftMax: 4;
		minimumContext: 16_384;
		validatedBackend: "cuda";
	};
}

/** Curated 27B descriptor shared by the full local execution catalog. */
export const BONSAI_27B: PrismModelDescriptor = {
	repo: "prism-ml/Bonsai-27B-gguf",
	file: "Bonsai-27B-Q1_0.gguf",
	mmprojFile: "Bonsai-27B-mmproj-Q8_0.gguf",
	displayName: "Bonsai-27B (1-bit Q1_0 + vision)",
	architecture: "dense",
	runtime: "prism-llamacpp",
	family: "bonsai",
	parameterScale: "27B",
	weightFormat: "q1_0",
	matchedDrafter: {
		kind: "dspark",
		file: "Bonsai-27B-dspark-Q4_1.gguf",
		draftMax: 4,
		minimumContext: 16_384,
		validatedBackend: "cuda",
	},
};

export type PrismBackend = "cpu" | "cuda";
export type PrismAssetKind = "tar-gz" | "zip";

export interface PrismArchiveAsset {
	name: string;
	kind: PrismAssetKind;
}

export interface PrismLlamaAsset extends PrismArchiveAsset {
	backend: PrismBackend;
	companionAssets?: readonly PrismArchiveAsset[];
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
const WIN_X64_CUDA_ASSET = "llama-prism-b1-38c66ad-bin-win-cuda-12.4-x64.zip";
const WIN_X64_CUDA_COMPANION_ASSET = "cudart-llama-bin-win-cuda-12.4-x64.zip";

/**
 * Maps a platform/arch/GPU triple to the exact Prism llama.cpp release asset for
 * {@link PRISM_LLAMACPP_PINNED_RELEASE} — verified against the real GitHub release, not guessed.
 * CPU asset by default; CUDA 12.4 is selected for x64 Linux or Windows with an NVIDIA GPU. The
 * pinned Windows build is incomplete without its matching `cudart-*` archive, so the resolver
 * returns both as one mandatory installation plan. Pure and exported so it's independently
 * testable.
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
		if (architecture === "x64") {
			return hasNvidiaGpu
				? {
						name: WIN_X64_CUDA_ASSET,
						kind: "zip",
						backend: "cuda",
						companionAssets: [{ name: WIN_X64_CUDA_COMPANION_ASSET, kind: "zip" }],
					}
				: { name: WIN_X64_CPU_ASSET, kind: "zip", backend: "cpu" };
		}
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

type PrismExtractArchiveFn = (
	input: Readable,
	destDir: string,
	kind: PrismAssetKind,
) => Promise<{ ok: boolean; error?: string }>;

export interface PrismLlamaCppDeps {
	fetchFn?: typeof fetch;
	spawnFn?: ManagedRuntimeSpawn;
	existsFn?: (path: string) => boolean;
	sleepFn?: (ms: number) => Promise<void>;
	/** Whether a named command exists on PATH (nvidia-smi, tar — for zip extraction on Windows). */
	hasCommand?: (command: string) => boolean;
	/** Decided once at install time and persisted as `backend` — serve() reads the persisted value
	 * so `-ngl 99` reflects what was actually installed, not the host's current GPU state. */
	hasNvidiaGpu?: () => boolean;
	platform?: () => string;
	arch?: () => string;
	/** Host capacity probes used once to derive the bounded local inference profile. */
	totalMemoryBytes?: () => number;
	logicalCpuCount?: () => number;
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

function modelIdentityConflictError(servedModelIds: readonly string[]): string {
	return `model-identity-conflict:${servedModelIds.join(",") || "unknown"}`;
}

export class PrismLlamaCppRuntime {
	private readonly _agentDir: string;
	private readonly _fetch: typeof fetch;
	private readonly _spawn: ManagedRuntimeSpawn;
	private readonly _exists: (path: string) => boolean;
	private readonly _sleep: (ms: number) => Promise<void>;
	private readonly _hasCommand: (command: string) => boolean;
	private readonly _hasNvidiaGpu: () => boolean;
	private readonly _platform: () => string;
	private readonly _arch: () => string;
	private readonly _extractArchiveFn: PrismExtractArchiveFn;
	private readonly _healthPollAttempts: number;
	private readonly _healthPollIntervalMs: number;
	private readonly _profile: LocalInferenceProfile;
	private _child: Pick<ChildProcess, "pid" | "kill" | "unref" | "on"> | undefined;

	constructor(args: {
		agentDir: string;
		profileMode?: LocalInferenceProfileMode;
		deps?: PrismLlamaCppDeps;
	}) {
		this._agentDir = args.agentDir;
		[this._fetch, this._spawn, this._exists, this._sleep] = resolveRuntimeLifecycleDependencies(args.deps);
		this._hasCommand = args.deps?.hasCommand ?? runtimeCommandAvailable;
		this._hasNvidiaGpu = args.deps?.hasNvidiaGpu ?? (() => this._hasCommand("nvidia-smi"));
		this._platform = args.deps?.platform ?? osPlatform;
		this._arch = args.deps?.arch ?? osArch;
		this._profile = deriveHostLocalInferenceProfile(args.profileMode ?? "balanced", args.deps);
		this._extractArchiveFn =
			args.deps?.extractArchive ?? ((input, destDir, kind) => this._extractArchive(input, destDir, kind));
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

		const archives: readonly PrismArchiveAsset[] = [asset, ...(asset.companionAssets ?? [])];
		for (const archive of archives) {
			const downloadUrl = `${PRISM_LLAMACPP_RELEASES_BASE_URL}/${PRISM_LLAMACPP_PINNED_RELEASE}/${archive.name}`;
			const extracted = await this._installArchive(downloadUrl, archive, onProgress);
			if (!extracted.ok) return extracted;
		}

		onProgress?.("Locating llama-server binary…");
		const destDir = this.runtimeDir();
		const binaryRelPath = this._findBinaryRelPath(destDir);
		if (!binaryRelPath) {
			return { ok: false, error: "binary-missing: no llama-server binary found in the extracted archive" };
		}

		this._writeManifest({ release: PRISM_LLAMACPP_PINNED_RELEASE, binaryRelPath, backend: asset.backend });
		onProgress?.("Prism llama.cpp runtime installed.");
		return { ok: true };
	}

	private _installArchive(
		downloadUrl: string,
		asset: PrismArchiveAsset,
		onProgress?: (status: string) => void,
	): Promise<{ ok: boolean; error?: string }> {
		return installRuntimeArchive(
			this._fetch,
			downloadUrl,
			this.runtimeDir(),
			asset,
			this._extractArchiveFn,
			onProgress,
		);
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
			await pipeline(input, requireRuntimeStdin(tarProc, "tar"));
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
		return extractZipArchive({
			input,
			destDir,
			tempPrefix: "prism-llamacpp-download",
			platform: this._platform,
			hasCommand: this._hasCommand,
			timeoutMs: EXTRACTION_TIMEOUT_MS,
			killGraceMs: COMMAND_KILL_GRACE_MS,
		});
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
			if (remoteSize !== undefined && remoteSize === tryFileSizeBytes(destPath)) {
				onProgress?.(`${args.file} already downloaded (${remoteSize} bytes) — skipping.`);
				return { ok: true, path: destPath, skipped: true };
			}
		}

		onProgress?.(`Downloading ${args.file} from ${args.repo}…`);
		const download = await fetchRuntimeDownload(this._fetch, url);
		if (!download.ok) return download;

		const expectedBytes = parseContentLength(download.response.headers.get("content-length"));
		const written = await writeRuntimeDownload(download.body as unknown as Readable, destPath);
		if (!written.ok) return written;

		const actualBytes = tryFileSizeBytes(destPath);
		if (expectedBytes !== undefined && actualBytes !== expectedBytes) {
			removePartialDownload(destPath);
			return { ok: false, error: `size-mismatch: expected ${expectedBytes} bytes, got ${actualBytes ?? 0}` };
		}

		onProgress?.(`${args.file} downloaded (${actualBytes ?? 0} bytes).`);
		return { ok: true, path: destPath };
	}

	/**
	 * Spawn `llama-server` detached+tracked (killed on parent shutdown even if pi crashes without
	 * calling stop()) and poll `/health` until ready. `-ngl 99` is only added when the installed
	 * asset's persisted `backend` is `"cuda"`, not from the host's current GPU state.
	 */
	async serve(args: {
		modelPath: string;
		modelAlias: string;
		mmprojPath?: string;
		port: number;
		numCtx: number;
	}): Promise<PrismServeResult> {
		const manifest = this._readManifest();
		if (!manifest) return { ok: false, error: "binary-missing" };
		const binaryPath = join(this.runtimeDir(), manifest.binaryRelPath);
		if (!this._exists(binaryPath)) return { ok: false, error: "binary-missing" };

		const baseUrl = `http://127.0.0.1:${args.port}`;
		const existing = await probePrismLlamaCppServer(baseUrl, args.modelAlias, this._fetch, HEALTH_CHECK_TIMEOUT_MS);
		if (existing.status === "matching") return { ok: true, baseUrl };
		if (existing.status === "conflict" && !this._child) {
			return { ok: false, error: modelIdentityConflictError(existing.servedModelIds) };
		}
		if (this._child) this.stop();
		const argv = [
			"-m",
			args.modelPath,
			"--alias",
			args.modelAlias,
			...(args.mmprojPath ? ["--mmproj", args.mmprojPath] : []),
			"--host",
			"127.0.0.1",
			"--port",
			String(args.port),
			"-c",
			String(args.numCtx),
			"--cache-ram",
			String(this._profile.promptCacheMiB),
			"-np",
			String(this._profile.parallelRequests),
			"-fa",
			this._profile.flashAttention ? "on" : "off",
			"-ctk",
			this._profile.kvCacheType,
			"-ctv",
			this._profile.kvCacheType,
			"-t",
			String(this._profile.generationThreads),
			"-tb",
			String(this._profile.batchThreads),
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
			if (this._child === child) {
				this._child = undefined;
			}
		});
		this._child = child;

		for (let attempt = 0; attempt < this._healthPollAttempts; attempt++) {
			const probe = await probePrismLlamaCppServer(baseUrl, args.modelAlias, this._fetch, HEALTH_CHECK_TIMEOUT_MS);
			if (probe.status === "matching") return { ok: true, baseUrl };
			if (probe.status === "conflict") {
				this.stop();
				return { ok: false, error: modelIdentityConflictError(probe.servedModelIds) };
			}
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
