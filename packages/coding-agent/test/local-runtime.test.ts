import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	OllamaRuntime as ProductionOllamaRuntime,
	TransformersRuntime as ProductionTransformersRuntime,
	type RuntimeCommandRunner,
	resolveOllamaAsset,
	resolveTransformersBaseUrl,
} from "../src/core/models/local-runtime.ts";

class OllamaRuntime extends ProductionOllamaRuntime {
	constructor(args: ConstructorParameters<typeof ProductionOllamaRuntime>[0]) {
		super({ ...args, deps: { platform: () => "linux", ...args.deps } });
	}
}

class TransformersRuntime extends ProductionTransformersRuntime {
	constructor(args: ConstructorParameters<typeof ProductionTransformersRuntime>[0]) {
		super({ ...args, deps: { platform: () => "linux", ...args.deps } });
	}
}

function ndjsonResponse(lines: object[]): Response {
	const body = lines.map((line) => JSON.stringify(line)).join("\n");
	return new Response(body, { status: 200 });
}

beforeEach(() => {
	vi.stubEnv("PYTHON", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

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

describe("OllamaRuntime Windows binary discovery", () => {
	it("finds the .exe installed in the pi-owned runtime", async () => {
		const agentDir = "/agent";
		const ownedBinary = join(agentDir, "runtimes", "ollama", "bin", "ollama.exe");
		const checkedPaths: string[] = [];
		const runtime = new OllamaRuntime({
			agentDir,
			deps: {
				platform: () => "win32",
				existsFn: (path) => {
					checkedPaths.push(path);
					return path === ownedBinary;
				},
				envPath: "",
				fetchFn: async () => new Response(null, { status: 503 }),
			},
		});

		expect((await runtime.detect()).binarySource).toBe("pi-owned");
		expect(checkedPaths[0]).toBe(ownedBinary);
	});
});

describe("TransformersRuntime", () => {
	it("derives stable localhost base URLs per model without using Ollama's port", () => {
		const first = resolveTransformersBaseUrl("openbmb/MiniCPM5-1B");
		expect(first).toBe(resolveTransformersBaseUrl("openbmb/MiniCPM5-1B"));
		expect(first).toMatch(/^http:\/\/127\.0\.0\.1:18\d\d\d$/);
		expect(first).not.toBe("http://127.0.0.1:11434");
	});

	it("installs Transformers into a pi-owned venv with pinned CPU packages", async () => {
		const agentDir = `${process.cwd()}/.scratch-transformers-runtime-install`;
		let venvCreated = false;
		const commands: Array<{ command: string; args: string[] }> = [];
		const runCommand: RuntimeCommandRunner = async (command, args) => {
			commands.push({ command, args });
			if (args.includes("venv")) venvCreated = true;
			return { ok: true, stdout: "", stderr: "" };
		};
		const runtime = new TransformersRuntime({
			agentDir,
			modelId: "openbmb/MiniCPM5-1B",
			deps: {
				runCommand,
				existsFn: (path) => venvCreated && path === `${agentDir}/runtimes/hf-transformers/venv/bin/python`,
				platform: () => "linux",
			},
		});

		await expect(runtime.installManaged()).resolves.toEqual({ ok: true });
		expect(commands[0]).toEqual({ command: "python", args: ["--version"] });
		expect(commands.some((entry) => entry.args.join(" ").includes("transformers==5.13.0"))).toBe(true);
		expect(commands.some((entry) => entry.args.join(" ").includes("torch==2.12.1+cpu"))).toBe(true);
		expect(commands.some((entry) => entry.args.join(" ").includes("https://download.pytorch.org/whl/cpu"))).toBe(
			true,
		);
	});

	it("honors the PYTHON environment interpreter before PATH defaults", async () => {
		vi.stubEnv("PYTHON", "python3.11");
		const agentDir = `${process.cwd()}/.scratch-transformers-runtime-python-env`;
		let venvCreated = false;
		const commands: Array<{ command: string; args: string[] }> = [];
		const runCommand: RuntimeCommandRunner = async (command, args) => {
			commands.push({ command, args });
			if (args.includes("venv")) venvCreated = true;
			return { ok: true, stdout: "", stderr: "" };
		};
		const runtime = new TransformersRuntime({
			agentDir,
			modelId: "openbmb/MiniCPM5-1B",
			deps: {
				runCommand,
				existsFn: (path) => venvCreated && path === `${agentDir}/runtimes/hf-transformers/venv/bin/python`,
				platform: () => "linux",
			},
		});

		await expect(runtime.installManaged()).resolves.toEqual({ ok: true });
		expect(commands[0]).toEqual({ command: "python3.11", args: ["--version"] });
		expect(commands[1]).toEqual({
			command: "python3.11",
			args: ["-m", "venv", `${agentDir}/runtimes/hf-transformers/venv`],
		});
	});

	it("falls back to python3 only after environment python is unavailable", async () => {
		const agentDir = `${process.cwd()}/.scratch-transformers-runtime-python-fallback`;
		let venvCreated = false;
		const commands: Array<{ command: string; args: string[] }> = [];
		const runCommand: RuntimeCommandRunner = async (command, args) => {
			commands.push({ command, args });
			if (command === "python" && args[0] === "--version") {
				return { ok: false, stdout: "", stderr: "not found" };
			}
			if (args.includes("venv")) venvCreated = true;
			return { ok: true, stdout: "", stderr: "" };
		};
		const runtime = new TransformersRuntime({
			agentDir,
			modelId: "openbmb/MiniCPM5-1B",
			deps: {
				runCommand,
				existsFn: (path) => venvCreated && path === `${agentDir}/runtimes/hf-transformers/venv/bin/python`,
				platform: () => "linux",
			},
		});

		await expect(runtime.installManaged()).resolves.toEqual({ ok: true });
		expect(commands[0]).toEqual({ command: "python", args: ["--version"] });
		expect(commands[1]).toEqual({ command: "python3", args: ["--version"] });
		expect(commands[2]).toEqual({
			command: "python3",
			args: ["-m", "venv", `${agentDir}/runtimes/hf-transformers/venv`],
		});
	});

	it("repairs an orphaned venv by bootstrapping pip before package installation", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-transformers-orphan-"));
		const venvDir = join(agentDir, "runtimes", "hf-transformers", "venv");
		const pythonPath = join(venvDir, "bin", "python");
		mkdirSync(venvDir, { recursive: true });
		writeFileSync(join(venvDir, "pyvenv.cfg"), "home = /usr\n");
		let pipChecks = 0;
		const commands: Array<{ command: string; args: string[] }> = [];
		const runtime = new TransformersRuntime({
			agentDir,
			modelId: "openbmb/MiniCPM5-1B",
			deps: {
				existsFn: (path) => path === pythonPath || path === join(venvDir, "pyvenv.cfg"),
				platform: () => "linux",
				runCommand: async (command, args) => {
					commands.push({ command, args });
					const joined = args.join(" ");
					if (command === pythonPath && joined === "-m pip --version") {
						pipChecks++;
						return pipChecks === 1
							? { ok: false, stdout: "", stderr: "No module named pip" }
							: { ok: true, stdout: "pip 25", stderr: "" };
					}
					if (command === pythonPath && joined.includes("sys.base_prefix")) {
						return { ok: true, stdout: "/usr\n", stderr: "" };
					}
					return { ok: true, stdout: "", stderr: "" };
				},
			},
		});

		await expect(runtime.installManaged()).resolves.toEqual({ ok: true });
		const commandArgs = commands.map((entry) => entry.args.join(" "));
		expect(commandArgs.indexOf("-m ensurepip --upgrade")).toBeGreaterThan(commandArgs.indexOf("-m pip --version"));
		expect(commandArgs.indexOf("-m pip install --upgrade pip")).toBeGreaterThan(
			commandArgs.lastIndexOf("-m pip --version"),
		);
	});

	it("recreates a stale venv whose pyvenv.cfg points at a different interpreter", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-transformers-stale-"));
		const venvDir = join(agentDir, "runtimes", "hf-transformers", "venv");
		const pythonPath = join(venvDir, "bin", "python");
		mkdirSync(venvDir, { recursive: true });
		writeFileSync(join(venvDir, "pyvenv.cfg"), "home = /old/python\n");
		let recreated = false;
		const commands: Array<{ command: string; args: string[] }> = [];
		const runtime = new TransformersRuntime({
			agentDir,
			modelId: "openbmb/MiniCPM5-1B",
			deps: {
				existsFn: (path) => path === pythonPath || (!recreated && path === join(venvDir, "pyvenv.cfg")),
				platform: () => "linux",
				runCommand: async (command, args) => {
					commands.push({ command, args });
					if (command === "python" && args[0] === "--version") return { ok: true, stdout: "Python 3", stderr: "" };
					if (command === "python" && args.includes("venv")) {
						recreated = true;
						return { ok: true, stdout: "", stderr: "" };
					}
					if (command === pythonPath && args.join(" ").includes("sys.base_prefix")) {
						return { ok: true, stdout: "/new/python\n", stderr: "" };
					}
					return { ok: true, stdout: "", stderr: "" };
				},
			},
		});

		await expect(runtime.installManaged()).resolves.toEqual({ ok: true });
		expect(commands).toContainEqual({ command: "python", args: ["-m", "venv", venvDir] });
		expect(recreated).toBe(true);
	});

	it("returns an actionable venv package command when Python cannot create a venv", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-transformers-no-venv-"));
		const runtime = new TransformersRuntime({
			agentDir,
			modelId: "openbmb/MiniCPM5-1B",
			deps: {
				existsFn: () => false,
				platform: () => "linux",
				runCommand: async (command, args) => {
					if (command === "python" && args[0] === "--version") return { ok: true, stdout: "Python 3", stderr: "" };
					if (command === "python" && args.includes("venv")) {
						return {
							ok: false,
							stdout: "",
							stderr: "The virtual environment was not created because ensurepip is not available.",
						};
					}
					return { ok: true, stdout: "", stderr: "" };
				},
			},
		});

		const result = await runtime.installManaged();
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Install Python venv support");
		expect(result.error).toContain("python3-venv");
	});

	it("starts the bundled sidecar with pi-owned Hugging Face cache env", async () => {
		let up = false;
		let serveEnv: NodeJS.ProcessEnv | undefined;
		let serveArgs: string[] = [];
		const agentDir = `${process.cwd()}/.scratch-transformers-runtime-start`;
		const runtime = new TransformersRuntime({
			agentDir,
			modelId: "openbmb/MiniCPM5-1B",
			baseUrl: "http://127.0.0.1:18123",
			deps: {
				existsFn: (path) =>
					path === `${agentDir}/runtimes/hf-transformers/venv/bin/python` || path === "/tmp/server.py",
				transformersServerScriptPath: "/tmp/server.py",
				sleepFn: async () => {},
				fetchFn: async () =>
					new Response(JSON.stringify({ model: "openbmb/MiniCPM5-1B" }), { status: up ? 200 : 500 }),
				spawnFn: (_command, args, options) => {
					serveArgs = args;
					serveEnv = options.env;
					up = true;
					return { pid: 1234, kill: vi.fn(), unref: vi.fn(), on: vi.fn() } as never;
				},
			},
		});

		await expect(runtime.start()).resolves.toEqual({ started: true, reason: "started" });
		expect(serveArgs).toContain("--model-id");
		expect(serveArgs).toContain("openbmb/MiniCPM5-1B");
		expect(serveArgs).toContain("--port");
		expect(serveArgs).toContain("18123");
		expect(serveEnv?.HF_HOME).toBe(`${agentDir}/models/huggingface`);
		expect(serveEnv?.PYTHONNOUSERSITE).toBe("1");
		expect(serveEnv?.OLLAMA_MODELS).toBeUndefined();
	});

	it("treats an existing venv with missing Transformers modules as not installed", async () => {
		const agentDir = `${process.cwd()}/.scratch-transformers-runtime-missing-deps`;
		const commands: Array<{ command: string; args: string[] }> = [];
		const runtime = new TransformersRuntime({
			agentDir,
			modelId: "openbmb/MiniCPM5-1B",
			deps: {
				existsFn: (path) => path === `${agentDir}/runtimes/hf-transformers/venv/bin/python`,
				fetchFn: async () => new Response("{}", { status: 500 }),
				runCommand: async (command, args) => {
					commands.push({ command, args });
					return { ok: false, stdout: "", stderr: "missing huggingface_hub" };
				},
			},
		});

		const status = await runtime.detect();

		expect(status.runtimeInstalled).toBe(false);
		expect(commands).toHaveLength(1);
		expect(commands[0]?.args[1]).toContain("huggingface_hub");
	});

	it("reports incomplete Transformers runtime dependencies before model download", async () => {
		const agentDir = `${process.cwd()}/.scratch-transformers-runtime-download-missing-deps`;
		const runtime = new TransformersRuntime({
			agentDir,
			modelId: "openbmb/MiniCPM5-1B",
			deps: {
				existsFn: (path) => path === `${agentDir}/runtimes/hf-transformers/venv/bin/python`,
				runCommand: async () => ({ ok: false, stdout: "", stderr: "missing huggingface_hub" }),
			},
		});

		await expect(runtime.downloadModel()).resolves.toEqual({ ok: false, error: "runtime-dependencies-missing" });
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

	it("detect identifies the active store for owned and explicit user-store serves", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ollama-active-store-"));
		async function startRuntime(useOwnedStore: boolean) {
			let up = false;
			const runtime = new OllamaRuntime({
				agentDir: join(root, `agent-${useOwnedStore ? "owned" : "user"}`),
				deps: {
					existsFn: (path) => path === "/usr/bin/ollama",
					envPath: "/usr/bin",
					homeDir: "/home/u",
					sleepFn: async () => {},
					fetchFn: async () =>
						new Response(JSON.stringify({ models: [{ name: "qwen3:1.7b", size: 1 }] }), {
							status: up ? 200 : 500,
						}),
					spawnFn: () => {
						up = true;
						return { pid: 1234, kill: vi.fn(), unref: vi.fn(), on: vi.fn() } as never;
					},
				},
			});
			const started = useOwnedStore ? await runtime.start() : await runtime.startReuseExisting();
			expect(started.started).toBe(true);
			return { runtime, status: await runtime.detect() };
		}

		try {
			const owned = await startRuntime(true);
			expect(owned.status.activeStore).toMatchObject({
				kind: "pi-owned",
				path: owned.runtime.ownedModelsDir(),
				modelCount: 1,
			});
			expect(owned.runtime.stop()).toEqual({ stopped: true });

			const user = await startRuntime(false);
			expect(user.status.activeStore).toMatchObject({
				kind: "user",
				path: user.runtime.userModelsDir(),
				modelCount: 1,
			});
			expect(user.runtime.stop()).toEqual({ stopped: true });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("imports user Ollama models into the pi-owned store with idempotent hardlink-or-copy transfer", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ollama-import-"));
		try {
			const homeDir = join(root, "home");
			const agentDir = join(root, "agent");
			const userStore = join(homeDir, ".ollama", "models");
			const manifest = join(userStore, "manifests", "registry.ollama.ai", "library", "qwen3", "latest");
			const blob = join(userStore, "blobs", "sha256-abc");
			mkdirSync(join(userStore, "blobs"), { recursive: true });
			mkdirSync(join(userStore, "manifests", "registry.ollama.ai", "library", "qwen3"), { recursive: true });
			writeFileSync(manifest, "manifest", "utf-8");
			writeFileSync(blob, "blob", "utf-8");

			const runtime = new OllamaRuntime({ agentDir, deps: { homeDir } });
			const first = runtime.importUserModels();
			expect(first).toMatchObject({ manifestsImported: 1, blobsSkipped: 0 });
			expect(first.blobsHardlinked + first.blobsCopied).toBe(1);
			expect(
				readFileSync(
					join(runtime.ownedModelsDir(), "manifests", "registry.ollama.ai", "library", "qwen3", "latest"),
					"utf-8",
				),
			).toBe("manifest");
			const ownedBlob = join(runtime.ownedModelsDir(), "blobs", "sha256-abc");
			expect(readFileSync(ownedBlob, "utf-8")).toBe("blob");
			if (first.blobsHardlinked === 1) expect(statSync(ownedBlob).ino).toBe(statSync(blob).ino);
			expect(readFileSync(blob, "utf-8")).toBe("blob");

			const second = runtime.importUserModels();
			expect(second).toMatchObject({
				manifestsImported: 0,
				manifestsSkipped: 1,
				blobsHardlinked: 0,
				blobsSkipped: 1,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to blob copies when hardlinking crosses filesystems", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ollama-import-copy-"));
		try {
			const homeDir = join(root, "home");
			const agentDir = join(root, "agent");
			const userStore = join(homeDir, ".ollama", "models");
			const blob = join(userStore, "blobs", "sha256-def");
			mkdirSync(join(userStore, "blobs"), { recursive: true });
			writeFileSync(blob, "blob-copy", "utf-8");
			const runtime = new OllamaRuntime({
				agentDir,
				deps: {
					homeDir,
					linkFile: () => {
						throw Object.assign(new Error("cross device"), { code: "EXDEV" });
					},
					copyFile: copyFileSync,
				},
			});

			const result = runtime.importUserModels();
			expect(result).toMatchObject({ blobsHardlinked: 0, blobsCopied: 1 });
			expect(readFileSync(join(runtime.ownedModelsDir(), "blobs", "sha256-def"), "utf-8")).toBe("blob-copy");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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

	it("lists, loads, and releases resident Ollama models through native keep_alive endpoints", async () => {
		const requests: Array<{ url: string; body?: unknown }> = [];
		const runtime = new OllamaRuntime({
			agentDir: "/agent",
			deps: {
				fetchFn: async (input, init) => {
					requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
					if (String(input).endsWith("/api/ps")) {
						return new Response(JSON.stringify({ models: [{ model: "qwen3:1.7b", size_vram: 123 }] }), {
							status: 200,
						});
					}
					return new Response("{}", { status: 200 });
				},
			},
		});

		expect(await runtime.listResidentModels()).toEqual([{ name: "qwen3:1.7b", sizeBytes: 123 }]);
		expect(await runtime.ensureResident("qwen3:1.7b")).toEqual({ ok: true });
		expect(await runtime.releaseResident("qwen3:1.7b")).toEqual({ ok: true });
		expect(requests.at(-2)?.body).toMatchObject({ model: "qwen3:1.7b", keep_alive: "30m" });
		expect(requests.at(-1)?.body).toMatchObject({ model: "qwen3:1.7b", keep_alive: 0 });
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
