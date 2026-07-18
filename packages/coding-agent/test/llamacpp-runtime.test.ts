import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BONSAI_27B,
	PRISM_LLAMACPP_PINNED_RELEASE,
	PRISM_LLAMACPP_RELEASES_BASE_URL,
	PrismLlamaCppRuntime as ProductionPrismLlamaCppRuntime,
	resolvePrismLlamaAsset,
} from "../src/core/models/llamacpp-runtime.ts";
import * as shellModule from "../src/utils/shell.ts";

class PrismLlamaCppRuntime extends ProductionPrismLlamaCppRuntime {
	constructor(args: ConstructorParameters<typeof ProductionPrismLlamaCppRuntime>[0]) {
		super({ ...args, deps: { platform: () => "linux", arch: () => "x64", ...args.deps } });
	}
}

function fakeChild(pid: number | undefined): {
	pid: number | undefined;
	kill: ReturnType<typeof vi.fn>;
	unref: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
} {
	return { pid, kill: vi.fn(), unref: vi.fn(), on: vi.fn() };
}

function scratchDir(name: string): string {
	return mkdtempSync(join(tmpdir(), `pi-prism-${name}-`));
}

function writeManifest(
	agentDir: string,
	manifest: { release: string; binaryRelPath: string; backend: "cpu" | "cuda" },
): void {
	const runtimeDir = join(agentDir, "runtimes", "prism-llamacpp");
	mkdirSync(runtimeDir, { recursive: true });
	writeFileSync(join(runtimeDir, "install.json"), JSON.stringify(manifest));
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("BONSAI_27B descriptor", () => {
	it("carries the curated repo/file/mmproj/displayName the wiring task consumes", () => {
		expect(BONSAI_27B).toEqual({
			repo: "prism-ml/Bonsai-27B-gguf",
			file: "Bonsai-27B-Q1_0.gguf",
			mmprojFile: "Bonsai-27B-mmproj-Q8_0.gguf",
			displayName: "Bonsai-27B (1-bit Q1_0 + vision)",
		});
	});
});

describe("resolvePrismLlamaAsset", () => {
	it("resolves the linux x64 CPU tarball when no NVIDIA GPU is present", () => {
		expect(resolvePrismLlamaAsset("linux", "x64", false)).toEqual({
			name: "llama-prism-b9594-38c66ad-bin-ubuntu-x64.tar.gz",
			kind: "tar-gz",
			backend: "cpu",
		});
	});

	it("resolves the linux x64 CUDA 12.4 tarball when an NVIDIA GPU is present", () => {
		expect(resolvePrismLlamaAsset("linux", "x64", true)).toEqual({
			name: "llama-prism-b9594-38c66ad-bin-linux-cuda-12.4-x64.tar.gz",
			kind: "tar-gz",
			backend: "cuda",
		});
	});

	it("resolves the linux arm64 CPU tarball regardless of GPU (no arm64 CUDA asset)", () => {
		expect(resolvePrismLlamaAsset("linux", "arm64", false)).toEqual({
			name: "llama-prism-b9594-38c66ad-bin-ubuntu-arm64.tar.gz",
			kind: "tar-gz",
			backend: "cpu",
		});
		expect(resolvePrismLlamaAsset("linux", "arm64", true)).toEqual({
			name: "llama-prism-b9594-38c66ad-bin-ubuntu-arm64.tar.gz",
			kind: "tar-gz",
			backend: "cpu",
		});
	});

	it("resolves macOS tarballs per architecture (CPU only, no CUDA on macOS)", () => {
		expect(resolvePrismLlamaAsset("darwin", "arm64", false)).toEqual({
			name: "llama-prism-b9594-38c66ad-bin-macos-arm64.tar.gz",
			kind: "tar-gz",
			backend: "cpu",
		});
		expect(resolvePrismLlamaAsset("darwin", "x64", true)).toEqual({
			name: "llama-prism-b9594-38c66ad-bin-macos-x64.tar.gz",
			kind: "tar-gz",
			backend: "cpu",
		});
	});

	it("resolves windows CPU zips per architecture, and stays CPU even with an NVIDIA GPU (CUDA-on-Windows out of scope for v1)", () => {
		expect(resolvePrismLlamaAsset("win32", "x64", false)).toEqual({
			name: "llama-bin-win-cpu-x64.zip",
			kind: "zip",
			backend: "cpu",
		});
		expect(resolvePrismLlamaAsset("win32", "x64", true)).toEqual({
			name: "llama-bin-win-cpu-x64.zip",
			kind: "zip",
			backend: "cpu",
		});
		expect(resolvePrismLlamaAsset("win32", "arm64", false)).toEqual({
			name: "llama-bin-win-cpu-arm64.zip",
			kind: "zip",
			backend: "cpu",
		});
	});

	it("returns undefined for an unsupported platform/arch combo", () => {
		expect(resolvePrismLlamaAsset("sunos", "x64", false)).toBeUndefined();
		expect(resolvePrismLlamaAsset("linux", "ia32", false)).toBeUndefined();
		expect(resolvePrismLlamaAsset("darwin", "x86", false)).toBeUndefined();
	});
});

describe("detect", () => {
	it("reports not installed when no manifest exists", async () => {
		const runtime = new PrismLlamaCppRuntime({ agentDir: "/agent", deps: { existsFn: () => false } });
		expect(await runtime.detect()).toEqual({ runtimeInstalled: false, binaryPath: undefined, release: undefined });
	});

	it("reports not installed when the manifest exists but the binary is missing", async () => {
		const agentDir = scratchDir("detect-missing-binary");
		try {
			writeManifest(agentDir, {
				release: PRISM_LLAMACPP_PINNED_RELEASE,
				binaryRelPath: "bin/llama-server",
				backend: "cpu",
			});
			const runtime = new PrismLlamaCppRuntime({ agentDir, deps: { existsFn: () => false } });
			expect(await runtime.detect()).toEqual({
				runtimeInstalled: false,
				binaryPath: undefined,
				release: PRISM_LLAMACPP_PINNED_RELEASE,
			});
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("reports installed with binaryPath and release when the manifest and binary both exist", async () => {
		const agentDir = scratchDir("detect-ok");
		try {
			writeManifest(agentDir, {
				release: PRISM_LLAMACPP_PINNED_RELEASE,
				binaryRelPath: "bin/llama-server",
				backend: "cpu",
			});
			const binaryPath = join(agentDir, "runtimes", "prism-llamacpp", "bin", "llama-server");
			const runtime = new PrismLlamaCppRuntime({ agentDir, deps: { existsFn: (path) => path === binaryPath } });
			expect(await runtime.detect()).toEqual({
				runtimeInstalled: true,
				binaryPath,
				release: PRISM_LLAMACPP_PINNED_RELEASE,
			});
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("installManaged", () => {
	it("reports unsupported-platform without attempting any download", async () => {
		const fetchFn = vi.fn();
		const runtime = new PrismLlamaCppRuntime({
			agentDir: "/agent",
			deps: { platform: () => "sunos", arch: () => "x64", fetchFn: fetchFn as unknown as typeof fetch },
		});
		const result = await runtime.installManaged();
		expect(result).toEqual({ ok: false, error: "unsupported-platform" });
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("reports download-fail when the download throws", async () => {
		const runtime = new PrismLlamaCppRuntime({
			agentDir: "/agent",
			deps: {
				fetchFn: (async () => {
					throw new Error("ECONNRESET");
				}) as unknown as typeof fetch,
			},
		});
		const result = await runtime.installManaged();
		expect(result.ok).toBe(false);
		expect(result.error).toContain("download-fail");
	});

	it("reports download-fail when the response is not ok", async () => {
		const runtime = new PrismLlamaCppRuntime({
			agentDir: "/agent",
			deps: { fetchFn: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch },
		});
		const result = await runtime.installManaged();
		expect(result.ok).toBe(false);
		expect(result.error).toContain("download-fail");
		expect(result.error).toContain("404");
	});

	it("downloads from the pinned release URL and delegates extraction to the injected seam, propagating its failure verbatim", async () => {
		const agentDir = scratchDir("install-extract-fail");
		try {
			let requestedUrl = "";
			const extractArchive = vi.fn(async (_input: Readable, _destDir: string, _kind: string) => ({
				ok: false,
				error: "extract-fail: bad archive",
			}));
			const runtime = new PrismLlamaCppRuntime({
				agentDir,
				deps: {
					hasNvidiaGpu: () => false,
					fetchFn: (async (url: string) => {
						requestedUrl = url;
						return new Response("fake-archive-bytes", { status: 200 });
					}) as unknown as typeof fetch,
					extractArchive,
				},
			});
			const result = await runtime.installManaged();
			expect(result).toEqual({ ok: false, error: "extract-fail: bad archive" });
			expect(requestedUrl).toBe(
				`${PRISM_LLAMACPP_RELEASES_BASE_URL}/${PRISM_LLAMACPP_PINNED_RELEASE}/llama-prism-b9594-38c66ad-bin-ubuntu-x64.tar.gz`,
			);
			expect(extractArchive).toHaveBeenCalledTimes(1);
			const [, destDir, kind] = extractArchive.mock.calls[0] as [unknown, string, string];
			expect(destDir).toBe(join(agentDir, "runtimes", "prism-llamacpp"));
			expect(kind).toBe("tar-gz");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("reports binary-missing when extraction succeeds but no llama-server binary is found anywhere in the tree", async () => {
		const agentDir = scratchDir("install-binary-missing");
		try {
			const runtime = new PrismLlamaCppRuntime({
				agentDir,
				deps: {
					hasNvidiaGpu: () => false,
					fetchFn: (async () => new Response("fake-archive-bytes", { status: 200 })) as unknown as typeof fetch,
					extractArchive: async (_input, destDir) => {
						mkdirSync(join(destDir, "somepkg", "bin"), { recursive: true });
						writeFileSync(join(destDir, "somepkg", "bin", "not-llama-server"), "");
						return { ok: true };
					},
				},
			});
			const result = await runtime.installManaged();
			expect(result.ok).toBe(false);
			expect(result.error).toContain("binary-missing");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("happy path: locates the binary at an arbitrary nested depth and persists the manifest (release, relative path, cpu backend)", async () => {
		const agentDir = scratchDir("install-ok");
		try {
			const progress: string[] = [];
			const runtime = new PrismLlamaCppRuntime({
				agentDir,
				deps: {
					hasNvidiaGpu: () => false,
					fetchFn: (async () => new Response("fake-archive-bytes", { status: 200 })) as unknown as typeof fetch,
					extractArchive: async (_input, destDir) => {
						// Release archives have varied layouts — nest the binary a few levels deep to prove
						// the scan isn't assuming a fixed path.
						mkdirSync(join(destDir, "llama-b9594", "build", "bin"), { recursive: true });
						writeFileSync(join(destDir, "llama-b9594", "build", "bin", "llama-server"), "#!/bin/sh\n");
						return { ok: true };
					},
				},
			});
			const result = await runtime.installManaged((status) => progress.push(status));
			expect(result).toEqual({ ok: true });
			expect(progress.length).toBeGreaterThan(0);

			const runtimeDir = join(agentDir, "runtimes", "prism-llamacpp");
			const manifest = JSON.parse(readFileSync(join(runtimeDir, "install.json"), "utf8"));
			expect(manifest).toEqual({
				release: PRISM_LLAMACPP_PINNED_RELEASE,
				binaryRelPath: join("llama-b9594", "build", "bin", "llama-server"),
				backend: "cpu",
			});

			const detected = await runtime.detect();
			expect(detected).toEqual({
				runtimeInstalled: true,
				binaryPath: join(runtimeDir, "llama-b9594", "build", "bin", "llama-server"),
				release: PRISM_LLAMACPP_PINNED_RELEASE,
			});
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("resolves and persists the CUDA asset/backend when an NVIDIA GPU is present", async () => {
		const agentDir = scratchDir("install-cuda");
		try {
			let requestedUrl = "";
			const runtime = new PrismLlamaCppRuntime({
				agentDir,
				deps: {
					hasNvidiaGpu: () => true,
					fetchFn: (async (url: string) => {
						requestedUrl = url;
						return new Response("fake-archive-bytes", { status: 200 });
					}) as unknown as typeof fetch,
					extractArchive: async (_input, destDir) => {
						mkdirSync(join(destDir, "bin"), { recursive: true });
						writeFileSync(join(destDir, "bin", "llama-server"), "");
						return { ok: true };
					},
				},
			});
			const result = await runtime.installManaged();
			expect(result).toEqual({ ok: true });
			expect(requestedUrl).toContain("linux-cuda-12.4-x64.tar.gz");

			const manifest = JSON.parse(
				readFileSync(join(agentDir, "runtimes", "prism-llamacpp", "install.json"), "utf8"),
			);
			expect(manifest.backend).toBe("cuda");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("downloadModel", () => {
	it("streams the response body to <agentDir>/models/llamacpp/<repo>/<file>", async () => {
		const agentDir = scratchDir("download-ok");
		try {
			const content = "gguf-bytes-payload";
			const runtime = new PrismLlamaCppRuntime({
				agentDir,
				deps: {
					fetchFn: (async (_input: string, init?: RequestInit) => {
						if (init?.method === "HEAD") return new Response(null, { status: 404 });
						return new Response(content, { status: 200, headers: { "content-length": String(content.length) } });
					}) as typeof fetch,
				},
			});
			const result = await runtime.downloadModel({ repo: "prism-ml/Bonsai-27B-gguf", file: "Bonsai-27B-Q1_0.gguf" });
			const destPath = join(agentDir, "models", "llamacpp", "prism-ml", "Bonsai-27B-gguf", "Bonsai-27B-Q1_0.gguf");
			expect(result).toEqual({ ok: true, path: destPath });
			expect(readFileSync(destPath, "utf8")).toBe(content);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("skips re-downloading when the local file already matches the remote size", async () => {
		const agentDir = scratchDir("download-skip");
		try {
			const content = "already-here";
			const destPath = join(agentDir, "models", "llamacpp", "acme", "model.gguf");
			mkdirSync(join(agentDir, "models", "llamacpp", "acme"), { recursive: true });
			writeFileSync(destPath, content);
			let getCalled = false;
			const runtime = new PrismLlamaCppRuntime({
				agentDir,
				deps: {
					fetchFn: (async (_input: string, init?: RequestInit) => {
						if (init?.method === "HEAD") {
							return new Response(null, { status: 200, headers: { "content-length": String(content.length) } });
						}
						getCalled = true;
						return new Response(content, { status: 200 });
					}) as typeof fetch,
				},
			});
			const result = await runtime.downloadModel({ repo: "acme", file: "model.gguf" });
			expect(result).toEqual({ ok: true, path: destPath, skipped: true });
			expect(getCalled).toBe(false);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("re-downloads (overwrites) when the local file exists but the remote size no longer matches", async () => {
		const agentDir = scratchDir("download-stale");
		try {
			const destPath = join(agentDir, "models", "llamacpp", "acme", "model.gguf");
			mkdirSync(join(agentDir, "models", "llamacpp", "acme"), { recursive: true });
			writeFileSync(destPath, "old-short");
			const newContent = "new-content-longer-than-before";
			const runtime = new PrismLlamaCppRuntime({
				agentDir,
				deps: {
					fetchFn: (async (_input: string, init?: RequestInit) => {
						if (init?.method === "HEAD")
							return new Response(null, { status: 200, headers: { "content-length": "999" } });
						return new Response(newContent, {
							status: 200,
							headers: { "content-length": String(newContent.length) },
						});
					}) as typeof fetch,
				},
			});
			const result = await runtime.downloadModel({ repo: "acme", file: "model.gguf" });
			expect(result).toEqual({ ok: true, path: destPath });
			expect(readFileSync(destPath, "utf8")).toBe(newContent);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("cleans up a partial file when the stream fails mid-download", async () => {
		const agentDir = scratchDir("download-partial");
		try {
			const runtime = new PrismLlamaCppRuntime({
				agentDir,
				deps: {
					fetchFn: (async (_input: string, init?: RequestInit) => {
						if (init?.method === "HEAD") return new Response(null, { status: 404 });
						const stream = new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode("partial-bytes"));
								controller.error(new Error("connection reset"));
							},
						});
						return new Response(stream, { status: 200 });
					}) as typeof fetch,
				},
			});
			const result = await runtime.downloadModel({ repo: "acme", file: "broken.gguf" });
			expect(result.ok).toBe(false);
			expect(result.error).toContain("download-fail");
			expect(existsSync(join(agentDir, "models", "llamacpp", "acme", "broken.gguf"))).toBe(false);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("rejects and cleans up when the downloaded byte count does not match content-length", async () => {
		const agentDir = scratchDir("download-mismatch");
		try {
			const runtime = new PrismLlamaCppRuntime({
				agentDir,
				deps: {
					fetchFn: (async (_input: string, init?: RequestInit) => {
						if (init?.method === "HEAD") return new Response(null, { status: 404 });
						return new Response("short", { status: 200, headers: { "content-length": "999" } });
					}) as typeof fetch,
				},
			});
			const result = await runtime.downloadModel({ repo: "acme", file: "truncated.gguf" });
			expect(result.ok).toBe(false);
			expect(result.error).toContain("size-mismatch");
			expect(existsSync(join(agentDir, "models", "llamacpp", "acme", "truncated.gguf"))).toBe(false);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("serve", () => {
	it("reports binary-missing when there is no manifest at all", async () => {
		const spawnFn = vi.fn();
		const runtime = new PrismLlamaCppRuntime({
			agentDir: "/agent",
			deps: { existsFn: () => false, spawnFn: spawnFn as never },
		});
		const result = await runtime.serve({ modelPath: "/models/m.gguf", port: 8123, numCtx: 4096 });
		expect(result).toEqual({ ok: false, error: "binary-missing" });
		expect(spawnFn).not.toHaveBeenCalled();
	});

	it("reports binary-missing when the manifest exists but the binary file does not, without spawning", async () => {
		const agentDir = scratchDir("serve-manifest-no-binary");
		try {
			writeManifest(agentDir, {
				release: PRISM_LLAMACPP_PINNED_RELEASE,
				binaryRelPath: "bin/llama-server",
				backend: "cpu",
			});
			const spawnFn = vi.fn();
			const runtime = new PrismLlamaCppRuntime({
				agentDir,
				deps: { existsFn: () => false, spawnFn: spawnFn as never },
			});
			const result = await runtime.serve({ modelPath: "/models/m.gguf", port: 8123, numCtx: 4096 });
			expect(result).toEqual({ ok: false, error: "binary-missing" });
			expect(spawnFn).not.toHaveBeenCalled();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("spawns with exact argv (-m/--mmproj/--host/--port/-c) and no -ngl on a cpu backend, then health-polls to ready", async () => {
		const agentDir = scratchDir("serve-argv");
		try {
			writeManifest(agentDir, {
				release: PRISM_LLAMACPP_PINNED_RELEASE,
				binaryRelPath: "bin/llama-server",
				backend: "cpu",
			});
			const binaryPath = join(agentDir, "runtimes", "prism-llamacpp", "bin", "llama-server");
			let spawnArgs: string[] = [];
			let spawnCommand = "";
			let up = false;
			const runtime = new PrismLlamaCppRuntime({
				agentDir,
				deps: {
					existsFn: (path) => path === binaryPath,
					sleepFn: async () => {},
					fetchFn: (async () => new Response("{}", { status: up ? 200 : 503 })) as typeof fetch,
					spawnFn: (command, args) => {
						spawnCommand = command;
						spawnArgs = args;
						up = true;
						return fakeChild(4242);
					},
				},
			});
			const result = await runtime.serve({
				modelPath: "/models/Bonsai-27B-Q1_0.gguf",
				mmprojPath: "/models/Bonsai-27B-mmproj-Q8_0.gguf",
				port: 8123,
				numCtx: 8192,
			});
			expect(result).toEqual({ ok: true, baseUrl: "http://127.0.0.1:8123" });
			expect(spawnCommand).toBe(binaryPath);
			expect(spawnArgs).toEqual([
				"-m",
				"/models/Bonsai-27B-Q1_0.gguf",
				"--mmproj",
				"/models/Bonsai-27B-mmproj-Q8_0.gguf",
				"--host",
				"127.0.0.1",
				"--port",
				"8123",
				"-c",
				"8192",
			]);
			expect(runtime.isRunning()).toBe(true);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("omits --mmproj when no mmproj is configured, and adds -ngl 99 only when the installed backend is cuda", async () => {
		const agentDir = scratchDir("serve-cuda");
		try {
			writeManifest(agentDir, {
				release: PRISM_LLAMACPP_PINNED_RELEASE,
				binaryRelPath: "bin/llama-server",
				backend: "cuda",
			});
			const binaryPath = join(agentDir, "runtimes", "prism-llamacpp", "bin", "llama-server");
			let spawnArgs: string[] = [];
			let up = false;
			const runtime = new PrismLlamaCppRuntime({
				agentDir,
				deps: {
					existsFn: (path) => path === binaryPath,
					sleepFn: async () => {},
					fetchFn: (async () => new Response("{}", { status: up ? 200 : 503 })) as typeof fetch,
					spawnFn: (_command, args) => {
						spawnArgs = args;
						up = true;
						return fakeChild(4243);
					},
				},
			});
			const result = await runtime.serve({ modelPath: "/models/m.gguf", port: 8124, numCtx: 4096 });
			expect(result).toEqual({ ok: true, baseUrl: "http://127.0.0.1:8124" });
			expect(spawnArgs).toEqual([
				"-m",
				"/models/m.gguf",
				"--host",
				"127.0.0.1",
				"--port",
				"8124",
				"-c",
				"4096",
				"-ngl",
				"99",
			]);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("times out (bounded) and kills the child when /health never reports ready", async () => {
		const agentDir = scratchDir("serve-timeout");
		try {
			writeManifest(agentDir, {
				release: PRISM_LLAMACPP_PINNED_RELEASE,
				binaryRelPath: "bin/llama-server",
				backend: "cpu",
			});
			const binaryPath = join(agentDir, "runtimes", "prism-llamacpp", "bin", "llama-server");
			const killProcessTreeSpy = vi.spyOn(shellModule, "killProcessTree").mockImplementation(() => {});
			const untrackSpy = vi.spyOn(shellModule, "untrackDetachedChildPid").mockImplementation(() => {});
			const sleeps: number[] = [];
			const runtime = new PrismLlamaCppRuntime({
				agentDir,
				deps: {
					existsFn: (path) => path === binaryPath,
					sleepFn: async (ms) => {
						sleeps.push(ms);
					},
					healthPollAttempts: 3,
					fetchFn: (async () => new Response("", { status: 503 })) as typeof fetch,
					spawnFn: () => fakeChild(4244),
				},
			});
			const result = await runtime.serve({ modelPath: "/models/m.gguf", port: 8125, numCtx: 4096 });
			expect(result).toEqual({ ok: false, error: "health-timeout" });
			expect(sleeps).toHaveLength(3);
			expect(killProcessTreeSpy).toHaveBeenCalledWith(4244);
			expect(untrackSpy).toHaveBeenCalledWith(4244);
			expect(runtime.isRunning()).toBe(false);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("stop() untracks and kills the tracked pid, and is a no-op when nothing is running", async () => {
		const agentDir = scratchDir("serve-stop");
		try {
			writeManifest(agentDir, {
				release: PRISM_LLAMACPP_PINNED_RELEASE,
				binaryRelPath: "bin/llama-server",
				backend: "cpu",
			});
			const binaryPath = join(agentDir, "runtimes", "prism-llamacpp", "bin", "llama-server");
			const killProcessTreeSpy = vi.spyOn(shellModule, "killProcessTree").mockImplementation(() => {});
			const untrackSpy = vi.spyOn(shellModule, "untrackDetachedChildPid").mockImplementation(() => {});
			const trackSpy = vi.spyOn(shellModule, "trackDetachedChildPid").mockImplementation(() => {});
			let up = false;
			const runtime = new PrismLlamaCppRuntime({
				agentDir,
				deps: {
					existsFn: (path) => path === binaryPath,
					sleepFn: async () => {},
					fetchFn: (async () => new Response("{}", { status: up ? 200 : 503 })) as typeof fetch,
					spawnFn: () => {
						up = true;
						return fakeChild(4245);
					},
				},
			});
			await runtime.serve({ modelPath: "/models/m.gguf", port: 8126, numCtx: 4096 });
			expect(trackSpy).toHaveBeenCalledWith(4245);
			expect(runtime.isRunning()).toBe(true);

			expect(runtime.stop()).toEqual({ stopped: true });
			expect(untrackSpy).toHaveBeenCalledWith(4245);
			expect(killProcessTreeSpy).toHaveBeenCalledWith(4245);
			expect(runtime.isRunning()).toBe(false);

			expect(runtime.stop()).toEqual({ stopped: false });
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
