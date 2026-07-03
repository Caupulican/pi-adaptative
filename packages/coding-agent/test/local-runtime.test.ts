import { describe, expect, it, vi } from "vitest";
import { OllamaRuntime, resolveOllamaAsset } from "../src/core/models/local-runtime.ts";

function ndjsonResponse(lines: object[]): Response {
	const body = lines.map((line) => JSON.stringify(line)).join("\n");
	return new Response(body, { status: 200 });
}

// Verified against the real ollama/ollama GitHub release (v0.31.1) and its own install.sh, not
// guessed: darwin ships a CLI .tgz (distinct from the Ollama.app/.dmg GUI installer), linux ships
// .tar.zst, windows ships .zip.
describe("resolveOllamaAsset", () => {
	it("resolves the darwin CLI tarball regardless of arch (universal binary)", () => {
		expect(resolveOllamaAsset("darwin", "arm64")).toEqual({ name: "ollama-darwin.tgz", kind: "tar-gz" });
		expect(resolveOllamaAsset("darwin", "x64")).toEqual({ name: "ollama-darwin.tgz", kind: "tar-gz" });
	});

	it("resolves the linux .tar.zst asset per architecture", () => {
		expect(resolveOllamaAsset("linux", "x64")).toEqual({ name: "ollama-linux-amd64.tar.zst", kind: "tar-zst" });
		expect(resolveOllamaAsset("linux", "arm64")).toEqual({ name: "ollama-linux-arm64.tar.zst", kind: "tar-zst" });
	});

	it("resolves the windows .zip asset per architecture", () => {
		expect(resolveOllamaAsset("win32", "x64")).toEqual({ name: "ollama-windows-amd64.zip", kind: "zip" });
		expect(resolveOllamaAsset("win32", "arm64")).toEqual({ name: "ollama-windows-arm64.zip", kind: "zip" });
	});

	it("returns undefined for an unsupported platform", () => {
		expect(resolveOllamaAsset("sunos", "x64")).toBeUndefined();
	});
});

describe("OllamaRuntime", () => {
	it("detects binary source by precedence: pi-owned > user > system PATH", async () => {
		const agentDir = "/agent";
		const existing = new Set(["/usr/bin/ollama", "/home/u/.local/share/ollama-dist/bin/ollama"]);
		const runtime = new OllamaRuntime({
			agentDir,
			deps: {
				existsFn: (path) => existing.has(path),
				envPath: "/usr/bin",
				homeDir: "/home/u",
				fetchFn: async () => new Response("{}", { status: 500 }),
			},
		});
		const status = await runtime.detect();
		expect(status.binarySource).toBe("user");
		expect(status.serverUp).toBe(false);
		expect(status.ownedModelsDir).toBe("/agent/models/ollama");
	});

	it("start refuses when a server already responds (never double-serves)", async () => {
		const runtime = new OllamaRuntime({
			agentDir: "/agent",
			deps: { fetchFn: async () => new Response('{"models":[]}', { status: 200 }) },
		});
		expect(await runtime.start()).toEqual({ started: false, reason: "already_running_system" });
	});

	it("start spawns serve with OWNED storage and hardened env, then health-polls", async () => {
		let serveEnv: NodeJS.ProcessEnv | undefined;
		let up = false;
		const runtime = new OllamaRuntime({
			agentDir: `${process.cwd()}/.scratch-runtime-test`,
			deps: {
				existsFn: (path) => path === "/usr/bin/ollama",
				envPath: "/usr/bin",
				homeDir: "/home/u",
				sleepFn: async () => {},
				fetchFn: async () => new Response("{}", { status: up ? 200 : 500 }),
				spawnFn: (_command, argv, options) => {
					expect(argv).toEqual(["serve"]);
					serveEnv = options.env;
					up = true;
					return { pid: 1234, kill: vi.fn(), unref: vi.fn(), on: vi.fn() } as never;
				},
			},
		});
		const result = await runtime.start();
		expect(result.started).toBe(true);
		expect(serveEnv?.OLLAMA_MODELS).toContain(".scratch-runtime-test/models/ollama");
		expect(serveEnv?.OLLAMA_FLASH_ATTENTION).toBe("1");
		expect(serveEnv?.OLLAMA_NUM_PARALLEL).toBe("1");
		expect(runtime.stop()).toEqual({ stopped: true });
	});

	it("startReuseExisting refuses when a server already responds (never double-serves)", async () => {
		const runtime = new OllamaRuntime({
			agentDir: "/agent",
			deps: { fetchFn: async () => new Response('{"models":[]}', { status: 200 }) },
		});
		expect(await runtime.startReuseExisting()).toEqual({ started: false, reason: "already_running_system" });
	});

	it("startReuseExisting reports binary_missing without spawning anything", async () => {
		const spawnFn = vi.fn();
		const runtime = new OllamaRuntime({
			agentDir: "/agent",
			deps: {
				existsFn: () => false,
				envPath: "",
				fetchFn: async () => new Response("", { status: 500 }),
				spawnFn,
			},
		});
		expect(await runtime.startReuseExisting()).toEqual({ started: false, reason: "binary_missing" });
		expect(spawnFn).not.toHaveBeenCalled();
	});

	it("startReuseExisting spawns serve WITHOUT an OLLAMA_MODELS override — reuses the user's own models dir", async () => {
		let serveEnv: NodeJS.ProcessEnv | undefined;
		let up = false;
		const runtime = new OllamaRuntime({
			agentDir: `${process.cwd()}/.scratch-runtime-test-reuse`,
			deps: {
				existsFn: (path) => path === "/usr/bin/ollama",
				envPath: "/usr/bin",
				homeDir: "/home/u",
				sleepFn: async () => {},
				fetchFn: async () => new Response("{}", { status: up ? 200 : 500 }),
				spawnFn: (_command, argv, options) => {
					expect(argv).toEqual(["serve"]);
					serveEnv = options.env;
					up = true;
					return { pid: 1234, kill: vi.fn(), unref: vi.fn(), on: vi.fn() } as never;
				},
			},
		});
		const result = await runtime.startReuseExisting();
		expect(result.started).toBe(true);
		// The whole point: no override, so Ollama falls through to its own default (~/.ollama), where
		// the user's already-pulled models live — NOT pi's owned/isolated storage.
		expect(serveEnv?.OLLAMA_MODELS).toBeUndefined();
		expect(serveEnv?.OLLAMA_FLASH_ATTENTION).toBe("1");
		expect(serveEnv?.OLLAMA_NUM_PARALLEL).toBe("1");
		expect(runtime.stop()).toEqual({ stopped: true });
	});

	it("start (owned-storage) is unaffected by startReuseExisting existing — still sets OLLAMA_MODELS", async () => {
		let serveEnv: NodeJS.ProcessEnv | undefined;
		let up = false;
		const runtime = new OllamaRuntime({
			agentDir: `${process.cwd()}/.scratch-runtime-test-owned`,
			deps: {
				existsFn: (path) => path === "/usr/bin/ollama",
				envPath: "/usr/bin",
				homeDir: "/home/u",
				sleepFn: async () => {},
				fetchFn: async () => new Response("{}", { status: up ? 200 : 500 }),
				spawnFn: (_command, _argv, options) => {
					serveEnv = options.env;
					up = true;
					return { pid: 1234, kill: vi.fn(), unref: vi.fn(), on: vi.fn() } as never;
				},
			},
		});
		await runtime.start();
		expect(serveEnv?.OLLAMA_MODELS).toContain(".scratch-runtime-test-owned/models/ollama");
		expect(runtime.stop()).toEqual({ stopped: true });
	});

	it("lists installed models with sizes from /api/tags", async () => {
		const runtime = new OllamaRuntime({
			agentDir: "/agent",
			deps: {
				fetchFn: async () =>
					new Response(JSON.stringify({ models: [{ name: "qwen3:1.7b", size: 1_400_000_000 }] }), { status: 200 }),
			},
		});
		expect(await runtime.list()).toEqual([{ name: "qwen3:1.7b", sizeBytes: 1_400_000_000 }]);
	});

	it("pull streams progress and reports upstream errors honestly", async () => {
		const statuses: string[] = [];
		const okRuntime = new OllamaRuntime({
			agentDir: "/agent",
			deps: {
				fetchFn: async () =>
					ndjsonResponse([{ status: "pulling manifest" }, { status: "downloading" }, { status: "success" }]),
			},
		});
		expect(await okRuntime.pull("qwen3:0.6b", (status) => statuses.push(status))).toEqual({ ok: true });
		expect(statuses).toEqual(["pulling manifest", "downloading", "success"]);

		const failRuntime = new OllamaRuntime({
			agentDir: "/agent",
			deps: {
				fetchFn: async () =>
					ndjsonResponse([{ status: "pulling manifest" }, { error: "pull model manifest: file does not exist" }]),
			},
		});
		const failed = await failRuntime.pull("nope:latest");
		expect(failed.ok).toBe(false);
		expect(failed.error).toContain("file does not exist");
	});

	it("remove goes through the API and surfaces failures", async () => {
		const runtime = new OllamaRuntime({
			agentDir: "/agent",
			deps: { fetchFn: async () => new Response("model not found", { status: 404 }) },
		});
		const result = await runtime.remove("ghost:latest");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("HTTP 404");
	});

	it("install guide is manual steps only (never an executed command), and states pi can also install", () => {
		const runtime = new OllamaRuntime({ agentDir: "/agent", deps: { homeDir: "/home/u" } });
		const guide = runtime.installGuide().join("\n");
		expect(guide).toContain("manual steps");
		expect(guide).toContain("/home/u/.local/share/ollama-dist");
		expect(guide).not.toContain("curl |");
		// #31: the stance reversed from "pi never installs" to "pi can install it for you, with consent" —
		// this text is the fallback shown when that didn't happen (declined/headless/install failed).
		expect(guide.toLowerCase()).toContain("pi can install it for you");
	});

	describe("_chooseZstdStrategy (private) — prefer in-process, verified not assumed", () => {
		function chooseStrategy(runtime: OllamaRuntime) {
			return (runtime as unknown as { _chooseZstdStrategy: () => { kind: string } })._chooseZstdStrategy();
		}

		it("prefers native (node:zlib) decompression when this Node build supports it", () => {
			const runtime = new OllamaRuntime({
				agentDir: "/agent",
				deps: {
					createZstdDecompress: () => ({}) as NodeJS.ReadWriteStream,
					hasCommand: () => true, // system zstd ALSO available — native must still win
				},
			});
			expect(chooseStrategy(runtime)).toEqual({ kind: "native" });
		});

		it("falls back to the system zstd binary when native isn't available", () => {
			const runtime = new OllamaRuntime({
				agentDir: "/agent",
				deps: { createZstdDecompress: undefined, hasCommand: (cmd) => cmd === "zstd" },
			});
			expect(chooseStrategy(runtime)).toEqual({ kind: "system" });
		});

		it("reports unavailable when neither native nor system zstd exists", () => {
			const runtime = new OllamaRuntime({
				agentDir: "/agent",
				deps: { createZstdDecompress: undefined, hasCommand: () => false },
			});
			expect(chooseStrategy(runtime)).toEqual({ kind: "unavailable" });
		});
	});

	describe("installManaged — orchestration (download -> extract -> verify), no real network/process", () => {
		function fakeBody(): NodeJS.ReadableStream {
			return {} as NodeJS.ReadableStream;
		}

		it("reports unsupported-platform without attempting any download", async () => {
			const fetchFn = vi.fn();
			const runtime = new OllamaRuntime({
				agentDir: "/agent",
				deps: { platform: () => "sunos", arch: () => "x64", fetchFn: fetchFn as unknown as typeof fetch },
			});
			const result = await runtime.installManaged();
			expect(result).toEqual({ ok: false, error: "unsupported-platform" });
			expect(fetchFn).not.toHaveBeenCalled();
		});

		it("reports download-fail when the download itself throws", async () => {
			const runtime = new OllamaRuntime({
				agentDir: "/agent",
				deps: {
					platform: () => "linux",
					arch: () => "x64",
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
			const runtime = new OllamaRuntime({
				agentDir: "/agent",
				deps: {
					platform: () => "linux",
					arch: () => "x64",
					fetchFn: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
				},
			});
			const result = await runtime.installManaged();
			expect(result.ok).toBe(false);
			expect(result.error).toContain("download-fail");
			expect(result.error).toContain("404");
		});

		it("delegates extraction to the injected extractArchive with the right destDir and asset kind, propagating its failure verbatim", async () => {
			const agentDir = `${process.cwd()}/.scratch-runtime-test-install-1`;
			const extractArchive = vi.fn(async (_input: NodeJS.ReadableStream, _destDir: string, _kind: string) => ({
				ok: false,
				error: "zstd-missing",
			}));
			const runtime = new OllamaRuntime({
				agentDir,
				deps: {
					platform: () => "linux",
					arch: () => "x64",
					fetchFn: (async () => new Response(fakeBody() as never, { status: 200 })) as unknown as typeof fetch,
					extractArchive,
				},
			});
			const result = await runtime.installManaged();
			expect(result).toEqual({ ok: false, error: "zstd-missing" });
			expect(extractArchive).toHaveBeenCalledTimes(1);
			const [, destDir, kind] = extractArchive.mock.calls[0] as [unknown, string, string];
			expect(destDir).toBe(`${agentDir}/runtimes/ollama`);
			expect(kind).toBe("tar-zst");
		});

		it("reports extract-fail when extraction reports success but the binary still isn't found", async () => {
			const agentDir = `${process.cwd()}/.scratch-runtime-test-install-2`;
			const runtime = new OllamaRuntime({
				agentDir,
				deps: {
					platform: () => "linux",
					arch: () => "x64",
					fetchFn: (async () => new Response(fakeBody() as never, { status: 200 })) as unknown as typeof fetch,
					extractArchive: async () => ({ ok: true }),
					existsFn: () => false,
				},
			});
			const result = await runtime.installManaged();
			expect(result.ok).toBe(false);
			expect(result.error).toContain("extract-fail");
		});

		it("reports ok and reports progress when download, extraction, and the post-extract check all succeed", async () => {
			const agentDir = `${process.cwd()}/.scratch-runtime-test-install-3`;
			const progress: string[] = [];
			const runtime = new OllamaRuntime({
				agentDir,
				deps: {
					platform: () => "linux",
					arch: () => "x64",
					fetchFn: (async () => new Response(fakeBody() as never, { status: 200 })) as unknown as typeof fetch,
					extractArchive: async () => ({ ok: true }),
					existsFn: (path) => path === `${agentDir}/runtimes/ollama/bin/ollama`,
				},
			});
			const result = await runtime.installManaged((status) => progress.push(status));
			expect(result).toEqual({ ok: true });
			expect(progress.length).toBeGreaterThan(0);
		});
	});
});
