import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeCommandResult, RuntimeCommandRunner } from "../src/core/models/local-runtime.ts";
import {
	NEEDLE_PINNED_COMMIT,
	NEEDLE_REPO_URL,
	NEEDLE_WEIGHTS_BYTES,
	NEEDLE_WEIGHTS_SHA256,
	type NeedleRuntimeDeps,
	NeedleRuntime as ProductionNeedleRuntime,
} from "../src/core/models/needle-runtime.ts";

class NeedleRuntime extends ProductionNeedleRuntime {
	constructor(args: ConstructorParameters<typeof ProductionNeedleRuntime>[0]) {
		super({ ...args, deps: { platform: () => "linux", ...args.deps } });
	}
}

function scratchDir(name: string): string {
	return mkdtempSync(join(tmpdir(), `pi-needle-${name}-`));
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

// Small synthetic fixture with a precomputed sha256 — used to exercise the real download+verify
// path via the `weightsIntegrity` test seam, instead of needing the real 52MB pickle.
const FAKE_WEIGHTS_CONTENT = "fake-pickled-weights-payload";
const FAKE_WEIGHTS_INTEGRITY = { sha256: sha256(FAKE_WEIGHTS_CONTENT), bytes: Buffer.byteLength(FAKE_WEIGHTS_CONTENT) };

function ok(stdout = "", stderr = ""): RuntimeCommandResult {
	return { ok: true, stdout, stderr, code: 0 };
}

// Mirrors what the real default runner produces on failure: `error` IS the trimmed stderr (see
// defaultRunCommand), so a fake failure must carry the same text in both fields for the
// `tailLines(result.error ?? result.stderr)` call sites to see it.
function fail(stderr: string): RuntimeCommandResult {
	return { ok: false, stdout: "", stderr, code: 1, error: stderr };
}

// Real stdout captured from a live `needle run --checkpoint ... --query ... --tools ...` invocation
// (see the module's investigation notes) — first call on a cold tokenizer cache.
const REAL_STDOUT_COLD_CACHE = [
	"Loading checkpoint: checkpoints/needle.pkl",
	"Downloading pretrained tokenizer from HuggingFace...",
	"Model parameters: 26,315,421",
	"",
	"Query: What's the weather in San Francisco?",
	'Tools: [{"name":"get_weather","description":"Get current weather for a city.","paramete...',
	"",
	'<tool_call>[{"name":"get_weather","arguments":{"location":"SanFrancisco"}}]',
	"",
].join("\n");

// Same real capture, warm cache (no tokenizer-download line) — proves the parser doesn't depend on a
// fixed line count/position.
const REAL_STDOUT_WARM_CACHE = [
	"Loading checkpoint: checkpoints/needle.pkl",
	"Model parameters: 26,315,421",
	"",
	"Query: Turn off the lights in the kitchen, please!",
	'Tools: [{"name":"toggle_lights","description":"Toggle smart lights on or off.","paramet...',
	"",
	'<tool_call>[{"name":"toggle_lights","arguments":{"room":"kitchen","state":"off"}}]',
	"",
].join("\n");

// Real capture with a camelCase tool name, demonstrating the verified upstream CLI quirk: the
// streamed stdout reports the snake_cased internal name, not the original casing.
const REAL_STDOUT_SNAKE_CASE_QUIRK = [
	"Loading checkpoint: checkpoints/needle.pkl",
	"Model parameters: 26,315,421",
	"",
	'Query: Weird "quoted" query; with $pecial & chars \\n literal',
	'Tools: [{"name":"getWeatherNow","description":"Get current weather for a city.","parame...',
	"",
	'<tool_call>[{"name":"get_weather_now","arguments":{"location":"quoted"}}]',
	"",
].join("\n");

describe("exported pin constants", () => {
	it("pins an exact 40-character commit SHA on the real repo URL", () => {
		expect(NEEDLE_REPO_URL).toBe("https://github.com/cactus-compute/needle.git");
		expect(NEEDLE_PINNED_COMMIT).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("detect", () => {
	it("reports not installed when the console script is missing, and surfaces pythonAvailable", async () => {
		const runtime = new NeedleRuntime({
			agentDir: "/agent",
			deps: { existsFn: () => false, hasCommand: (command) => command === "python3" },
		});
		expect(await runtime.detect()).toEqual({
			installed: false,
			installDir: undefined,
			commit: undefined,
			pythonAvailable: true,
			checkpointPresent: false,
		});
	});

	it("reports python unavailable with a clean boolean, not a workaround", async () => {
		const runtime = new NeedleRuntime({
			agentDir: "/agent",
			deps: { existsFn: () => false, hasCommand: () => false },
		});
		expect((await runtime.detect()).pythonAvailable).toBe(false);
	});

	it("reports installed with installDir and the manifest's commit when the console script and manifest both exist", async () => {
		const agentDir = scratchDir("detect-installed");
		try {
			const runtimeDir = join(agentDir, "runtimes", "needle");
			const entryPath = join(runtimeDir, "venv", "bin", "needle");
			mkdirSync(join(runtimeDir, "venv", "bin"), { recursive: true });
			writeFileSync(entryPath, "#!/bin/sh\n");
			writeFileSync(join(runtimeDir, "install.json"), JSON.stringify({ commit: "abc123", entryCommand: entryPath }));
			const runtime = new NeedleRuntime({ agentDir, deps: { hasCommand: () => true } });
			expect(await runtime.detect()).toEqual({
				installed: true,
				installDir: runtimeDir,
				commit: "abc123",
				pythonAvailable: true,
				checkpointPresent: false,
			});
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("reports checkpointPresent: true only when needle.pkl actually exists at the expected path, false otherwise", async () => {
		const checkpointPath = join("/agent", "models", "needle", "needle.pkl");
		const missing = new NeedleRuntime({ agentDir: "/agent", deps: { existsFn: () => false } });
		expect((await missing.detect()).checkpointPresent).toBe(false);

		const present = new NeedleRuntime({
			agentDir: "/agent",
			deps: { existsFn: (path) => path === checkpointPath },
		});
		expect((await present.detect()).checkpointPresent).toBe(true);
	});
});

describe("installManaged", () => {
	// Deterministic paths the runtime itself derives from agentDir — computed independently here so
	// tests can build override keys before constructing the runtime/collector.
	function needlePaths(agentDir: string) {
		const srcDir = join(agentDir, "runtimes", "needle", "src");
		const venvDir = join(agentDir, "runtimes", "needle", "venv");
		const pythonPath = join(venvDir, "bin", "python");
		const entryPath = join(venvDir, "bin", "needle");
		return { srcDir, venvDir, pythonPath, entryPath };
	}

	function commandCollector(agentDir: string, overrides: Record<string, RuntimeCommandResult> = {}) {
		const commands: Array<{ command: string; args: string[] }> = [];
		let venvCreated = false;
		const { venvDir, pythonPath, entryPath } = needlePaths(agentDir);
		const runCommand: RuntimeCommandRunner = async (command, args) => {
			commands.push({ command, args });
			const key = `${command} ${args.join(" ")}`;
			if (overrides[key]) return overrides[key];
			if (args.includes("venv")) venvCreated = true;
			return ok();
		};
		const deps: NeedleRuntimeDeps = {
			hasCommand: (command) => command === "git" || command === "python3",
			runCommand,
			existsFn: (path) => (path === pythonPath || path === entryPath) && venvCreated,
		};
		return { commands, deps, venvDir, pythonPath, entryPath };
	}

	it("reports git-missing without attempting any command when git is absent", async () => {
		const runtime = new NeedleRuntime({
			agentDir: "/agent",
			deps: { hasCommand: () => false, runCommand: async () => ok() },
		});
		const result = await runtime.installManaged();
		expect(result.ok).toBe(false);
		expect(result.error).toContain("git-missing");
	});

	it("reports python-missing when git is present but python3 is absent", async () => {
		const runtime = new NeedleRuntime({
			agentDir: "/agent",
			deps: { hasCommand: (command) => command === "git", runCommand: async () => ok() },
		});
		const result = await runtime.installManaged();
		expect(result.ok).toBe(false);
		expect(result.error).toContain("python-missing");
	});

	it("clones by fetching the exact pinned SHA (init/remote/fetch/checkout), not a bare depth-1 clone", async () => {
		const agentDir = scratchDir("install-clone");
		try {
			const { commands, deps } = commandCollector(agentDir);
			const runtime = new NeedleRuntime({ agentDir, deps });
			await runtime.installManaged();
			const srcDir = join(agentDir, "runtimes", "needle", "src");
			expect(commands[0]).toEqual({ command: "git", args: ["init", "-q", srcDir] });
			expect(commands[1]).toEqual({
				command: "git",
				args: ["-C", srcDir, "remote", "add", "origin", NEEDLE_REPO_URL],
			});
			expect(commands[2]).toEqual({
				command: "git",
				args: ["-C", srcDir, "fetch", "--depth", "1", "origin", NEEDLE_PINNED_COMMIT],
			});
			expect(commands[3]).toEqual({ command: "git", args: ["-C", srcDir, "checkout", "-q", "FETCH_HEAD"] });
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("reports clone-fail with a stderr tail when the pinned fetch fails", async () => {
		const agentDir = scratchDir("install-clone-fail");
		try {
			const { srcDir } = needlePaths(agentDir);
			const { deps } = commandCollector(agentDir, {
				[`git -C ${srcDir} fetch --depth 1 origin ${NEEDLE_PINNED_COMMIT}`]: fail(
					"line1\nline2\nfatal: could not fetch requested SHA",
				),
			});
			const runtime = new NeedleRuntime({ agentDir, deps });
			const result = await runtime.installManaged();
			expect(result.ok).toBe(false);
			expect(result.error).toContain("clone-fail");
			expect(result.error).toContain("fatal: could not fetch requested SHA");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("reports setup-fail with a stderr tail when venv creation fails", async () => {
		const agentDir = scratchDir("install-venv-fail");
		try {
			const { venvDir } = needlePaths(agentDir);
			const { deps } = commandCollector(agentDir, {
				[`python3 -m venv ${venvDir}`]: fail("line1\nensurepip is not available"),
			});
			const runtime = new NeedleRuntime({ agentDir, deps });
			const result = await runtime.installManaged();
			expect(result.ok).toBe(false);
			expect(result.error).toContain("setup-fail");
			expect(result.error).toContain("ensurepip is not available");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("reports setup-fail with a stderr tail when the editable install fails", async () => {
		const agentDir = scratchDir("install-pip-fail");
		try {
			const { srcDir, pythonPath } = needlePaths(agentDir);
			const { deps } = commandCollector(agentDir, {
				[`${pythonPath} -m pip install -e ${srcDir}`]: fail("line1\nERROR: package needle requires Python >=3.11"),
			});
			const runtime = new NeedleRuntime({ agentDir, deps });
			const result = await runtime.installManaged();
			expect(result.ok).toBe(false);
			expect(result.error).toContain("setup-fail");
			expect(result.error).toContain("requires Python >=3.11");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("reports verify-fail when the post-install import check fails", async () => {
		const agentDir = scratchDir("install-verify-fail");
		try {
			const { pythonPath } = needlePaths(agentDir);
			const { deps } = commandCollector(agentDir, {
				[`${pythonPath} -c import jax, needle; print(needle.__file__)`]: fail("line1\nModuleNotFoundError: jax"),
			});
			const runtime = new NeedleRuntime({ agentDir, deps });
			const result = await runtime.installManaged();
			expect(result.ok).toBe(false);
			expect(result.error).toContain("verify-fail");
			expect(result.error).toContain("ModuleNotFoundError");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("reports verify-fail when the console script is missing even though every command reported success", async () => {
		const agentDir = scratchDir("install-entry-missing");
		try {
			const { commands, pythonPath } = commandCollector(agentDir);
			const runCommand: RuntimeCommandRunner = async (command, args) => {
				commands.push({ command, args });
				return ok();
			};
			const runtime = new NeedleRuntime({
				agentDir,
				deps: {
					hasCommand: (command) => command === "git" || command === "python3",
					runCommand,
					// python exists (so venv/pip-install steps proceed) but the console script never appears.
					existsFn: (path) => path === pythonPath,
				},
			});
			const result = await runtime.installManaged();
			expect(result.ok).toBe(false);
			expect(result.error).toContain("verify-fail");
			expect(result.error).toContain("was not found");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("happy path: installs the CPU jax backend by default and persists commit + entryCommand under agentDir", async () => {
		const agentDir = scratchDir("install-happy-cpu");
		try {
			const { commands, deps, pythonPath, entryPath } = commandCollector(agentDir);
			const runtime = new NeedleRuntime({ agentDir, deps: { ...deps, hasNvidiaGpu: () => false } });
			const result = await runtime.installManaged();
			expect(result).toEqual({ ok: true });

			const jaxInstall = commands.find((entry) => entry.args.includes("jax") && entry.args.includes("-U"));
			expect(jaxInstall?.args).not.toContain("jax[cuda12]");

			const manifestPath = join(agentDir, "runtimes", "needle", "install.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { commit: string; entryCommand: string };
			expect(manifest.commit).toBe(NEEDLE_PINNED_COMMIT);
			expect(manifest.entryCommand).toBe(entryPath);

			// Containment: every path this install touches lives under agentDir.
			for (const entry of commands) {
				for (const arg of entry.args) {
					if (arg.startsWith("/") && !arg.startsWith(agentDir) && arg !== "-q") {
						throw new Error(`command touched a path outside agentDir: ${arg}`);
					}
				}
			}
			expect(pythonPath.startsWith(agentDir)).toBe(true);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("installs the CUDA 12 jax backend when an NVIDIA GPU is detected", async () => {
		const agentDir = scratchDir("install-happy-cuda");
		try {
			const { commands, deps } = commandCollector(agentDir);
			const runtime = new NeedleRuntime({ agentDir, deps: { ...deps, hasNvidiaGpu: () => true } });
			await runtime.installManaged();
			const jaxInstall = commands.find((entry) => entry.args.some((arg) => arg.includes("jax")));
			expect(jaxInstall?.args).toContain("jax[cuda12]");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("downloadWeights", () => {
	it("streams the response body to <agentDir>/models/needle/needle.pkl and verifies it against the pinned sha256+size", async () => {
		const agentDir = scratchDir("weights-ok");
		try {
			const runtime = new NeedleRuntime({
				agentDir,
				deps: {
					weightsIntegrity: FAKE_WEIGHTS_INTEGRITY,
					fetchFn: (async () => new Response(FAKE_WEIGHTS_CONTENT, { status: 200 })) as typeof fetch,
				},
			});
			const result = await runtime.downloadWeights();
			const destPath = join(agentDir, "models", "needle", "needle.pkl");
			expect(result).toEqual({ ok: true, path: destPath });
			expect(readFileSync(destPath, "utf8")).toBe(FAKE_WEIGHTS_CONTENT);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("uses the real pinned NEEDLE_WEIGHTS_SHA256/NEEDLE_WEIGHTS_BYTES by default, rejecting content that doesn't match them", async () => {
		const agentDir = scratchDir("weights-real-pin-default");
		try {
			// No weightsIntegrity override — exercises the constructor's real default. Fake content can
			// never hash to the real pinned sha256, so this proves the default seam is actually wired to
			// NEEDLE_WEIGHTS_SHA256/NEEDLE_WEIGHTS_BYTES rather than silently accepting anything.
			const runtime = new NeedleRuntime({
				agentDir,
				deps: { fetchFn: (async () => new Response(FAKE_WEIGHTS_CONTENT, { status: 200 })) as typeof fetch },
			});
			const result = await runtime.downloadWeights();
			expect(result.ok).toBe(false);
			expect(result.error).toContain("integrity-fail");
			expect(result.error).toContain(NEEDLE_WEIGHTS_SHA256);
			expect(result.error).toContain(String(NEEDLE_WEIGHTS_BYTES));
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("skips re-downloading when the local file already matches the pinned byte size, without any network call", async () => {
		const agentDir = scratchDir("weights-skip");
		try {
			const destPath = join(agentDir, "models", "needle", "needle.pkl");
			mkdirSync(join(agentDir, "models", "needle"), { recursive: true });
			writeFileSync(destPath, FAKE_WEIGHTS_CONTENT);
			let fetchCalled = false;
			const runtime = new NeedleRuntime({
				agentDir,
				deps: {
					weightsIntegrity: FAKE_WEIGHTS_INTEGRITY,
					fetchFn: (async () => {
						fetchCalled = true;
						return new Response(FAKE_WEIGHTS_CONTENT, { status: 200 });
					}) as typeof fetch,
				},
			});
			const result = await runtime.downloadWeights();
			expect(result).toEqual({ ok: true, path: destPath, skipped: true });
			expect(fetchCalled).toBe(false);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("re-downloads when the local file exists but its size doesn't match the pinned expectation", async () => {
		const agentDir = scratchDir("weights-stale");
		try {
			const destPath = join(agentDir, "models", "needle", "needle.pkl");
			mkdirSync(join(agentDir, "models", "needle"), { recursive: true });
			writeFileSync(destPath, "stale-wrong-size-content");
			let fetchCalled = false;
			const runtime = new NeedleRuntime({
				agentDir,
				deps: {
					weightsIntegrity: FAKE_WEIGHTS_INTEGRITY,
					fetchFn: (async () => {
						fetchCalled = true;
						return new Response(FAKE_WEIGHTS_CONTENT, { status: 200 });
					}) as typeof fetch,
				},
			});
			const result = await runtime.downloadWeights();
			expect(result).toEqual({ ok: true, path: destPath });
			expect(fetchCalled).toBe(true);
			expect(readFileSync(destPath, "utf8")).toBe(FAKE_WEIGHTS_CONTENT);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("cleans up a partial file when the stream fails mid-download", async () => {
		const agentDir = scratchDir("weights-partial");
		try {
			const runtime = new NeedleRuntime({
				agentDir,
				deps: {
					weightsIntegrity: FAKE_WEIGHTS_INTEGRITY,
					fetchFn: (async () => {
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
			const result = await runtime.downloadWeights();
			expect(result.ok).toBe(false);
			expect(result.error).toContain("download-fail");
			expect(existsSync(join(agentDir, "models", "needle", "needle.pkl"))).toBe(false);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("rejects and cleans up when the downloaded content's sha256 doesn't match the pin, even if a size were to coincidentally align", async () => {
		const agentDir = scratchDir("weights-hash-mismatch");
		try {
			const wrongContent = "x".repeat(FAKE_WEIGHTS_INTEGRITY.bytes); // same byte length, different content/hash
			const runtime = new NeedleRuntime({
				agentDir,
				deps: {
					weightsIntegrity: FAKE_WEIGHTS_INTEGRITY,
					fetchFn: (async () => new Response(wrongContent, { status: 200 })) as typeof fetch,
				},
			});
			const result = await runtime.downloadWeights();
			expect(result.ok).toBe(false);
			expect(result.error).toContain("integrity-fail");
			expect(result.error).toContain("Refusing to keep a pickle file that failed integrity verification");
			expect(existsSync(join(agentDir, "models", "needle", "needle.pkl"))).toBe(false);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("runFunctionCall", () => {
	function installedRuntime(
		runCommand: RuntimeCommandRunner,
		overrides?: Partial<NeedleRuntimeDeps>,
	): { runtime: NeedleRuntime; agentDir: string; entryPath: string; checkpointPath: string } {
		const agentDir = "/agent";
		const entryPath = join(agentDir, "runtimes", "needle", "venv", "bin", "needle");
		const checkpointPath = join(agentDir, "models", "needle", "needle.pkl");
		const runtime = new NeedleRuntime({
			agentDir,
			deps: {
				existsFn: (path) => path === entryPath || path === checkpointPath,
				runCommand,
				...overrides,
			},
		});
		return { runtime, agentDir, entryPath, checkpointPath };
	}

	it("reports not-installed without spawning anything when the console script is missing", async () => {
		let called = false;
		const { runtime } = installedRuntime(async () => {
			called = true;
			return ok();
		}, {});
		const runtimeUninstalled = new NeedleRuntime({
			agentDir: "/agent",
			deps: { existsFn: () => false, runCommand: async () => ok() },
		});
		const result = await runtimeUninstalled.runFunctionCall({ query: "hi", tools: [] });
		expect(result).toEqual({ ok: false, error: "not-installed: run installManaged() first", rawOutput: "" });
		expect(called).toBe(false);
		void runtime;
	});

	it("reports checkpoint-missing without spawning anything when the console script exists but no checkpoint does", async () => {
		let called = false;
		const agentDir = "/agent";
		const entryPath = join(agentDir, "runtimes", "needle", "venv", "bin", "needle");
		const runtime = new NeedleRuntime({
			agentDir,
			deps: {
				existsFn: (path) => path === entryPath,
				runCommand: async () => {
					called = true;
					return ok();
				},
			},
		});
		const result = await runtime.runFunctionCall({ query: "hi", tools: [] });
		expect(result.ok).toBe(false);
		expect((result as { error: string }).error).toContain("checkpoint-missing");
		expect(called).toBe(false);
	});

	it("builds argv as a single element per field — quotes/spaces/JSON-hostile query text pass through literally, tools serialized exactly once", async () => {
		let capturedArgv: string[] | undefined;
		const query = 'Weird "quoted" query; with $pecial & chars \\n literal';
		const tools = [{ name: "get_weather", description: "d", parameters: {} }];
		const { runtime, checkpointPath } = installedRuntime(async (_command, args) => {
			capturedArgv = args;
			return ok(REAL_STDOUT_SNAKE_CASE_QUIRK);
		});
		await runtime.runFunctionCall({ query, tools });
		expect(capturedArgv).toEqual([
			"run",
			"--checkpoint",
			checkpointPath,
			"--query",
			query,
			"--tools",
			JSON.stringify(tools),
		]);
		// Exactly one occurrence of the serialized tools string — never double-encoded.
		expect(capturedArgv?.filter((arg) => arg === JSON.stringify(tools))).toHaveLength(1);
	});

	it("invokes the resolved console script as argv[0]", async () => {
		let capturedCommand: string | undefined;
		const { runtime, entryPath } = installedRuntime(async (command) => {
			capturedCommand = command;
			return ok(REAL_STDOUT_WARM_CACHE);
		});
		await runtime.runFunctionCall({ query: "q", tools: [] });
		expect(capturedCommand).toBe(entryPath);
	});

	it("parses a real cold-cache stdout capture (with the one-time tokenizer-download line) into the tool call", async () => {
		const { runtime } = installedRuntime(async () => ok(REAL_STDOUT_COLD_CACHE));
		const result = await runtime.runFunctionCall({
			query: "What's the weather in San Francisco?",
			tools: [{ name: "get_weather", description: "d", parameters: {} }],
		});
		expect(result).toEqual({ ok: true, call: { name: "get_weather", arguments: { location: "SanFrancisco" } } });
	});

	it("parses a real warm-cache stdout capture (no tokenizer-download line) into the tool call", async () => {
		const { runtime } = installedRuntime(async () => ok(REAL_STDOUT_WARM_CACHE));
		const result = await runtime.runFunctionCall({
			query: "Turn off the lights in the kitchen, please!",
			tools: [{ name: "toggle_lights", description: "d", parameters: {} }],
		});
		expect(result).toEqual({
			ok: true,
			call: { name: "toggle_lights", arguments: { room: "kitchen", state: "off" } },
		});
	});

	it("reports the snake_case tool-name it actually parsed (verified upstream CLI quirk), never a guessed original casing", async () => {
		const { runtime } = installedRuntime(async () => ok(REAL_STDOUT_SNAKE_CASE_QUIRK));
		const result = await runtime.runFunctionCall({
			query: "irrelevant",
			tools: [{ name: "getWeatherNow", description: "d", parameters: {} }],
		});
		expect(result).toEqual({ ok: true, call: { name: "get_weather_now", arguments: { location: "quoted" } } });
	});

	it("strict-parse failure: no <tool_call> marker in stdout carries the raw output verbatim", async () => {
		const noise = "Loading checkpoint: x\nModel parameters: 1\n\nQuery: q\nTools: []\n";
		const { runtime } = installedRuntime(async () => ok(noise));
		const result = await runtime.runFunctionCall({ query: "q", tools: [] });
		expect(result.ok).toBe(false);
		expect((result as { error: string }).error).toContain("unparseable-output");
		expect((result as { rawOutput: string }).rawOutput).toContain(noise.trim());
	});

	it("strict-parse failure: malformed JSON after the marker carries the raw output, never a guessed result", async () => {
		const broken = 'Loading checkpoint: x\n\n<tool_call>[{"name":"get_weather", not valid json';
		const { runtime } = installedRuntime(async () => ok(broken));
		const result = await runtime.runFunctionCall({ query: "q", tools: [] });
		expect(result.ok).toBe(false);
		expect((result as { error: string }).error).toContain("unparseable-output");
		expect((result as { rawOutput: string }).rawOutput).toContain("not valid json");
	});

	it("strict-parse failure: an empty tool-call array is reported as an error, not fabricated as a call", async () => {
		const empty = "Loading checkpoint: x\n\n<tool_call>[]";
		const { runtime } = installedRuntime(async () => ok(empty));
		const result = await runtime.runFunctionCall({ query: "q", tools: [] });
		expect(result.ok).toBe(false);
		expect((result as { error: string }).error).toContain("unparseable-output");
	});

	it("propagates a non-zero exit as run-fail with a stderr tail, carrying combined stdout+stderr as rawOutput", async () => {
		const { runtime } = installedRuntime(async () => fail("line1\nline2\nTraceback: OOM killed"));
		const result = await runtime.runFunctionCall({ query: "q", tools: [] });
		expect(result.ok).toBe(false);
		expect((result as { error: string }).error).toContain("run-fail");
		expect((result as { error: string }).error).toContain("OOM killed");
		expect((result as { rawOutput: string }).rawOutput).toContain("OOM killed");
	});

	it("honors an explicit checkpointPath override instead of the default", async () => {
		let capturedArgv: string[] | undefined;
		const agentDir = "/agent";
		const entryPath = join(agentDir, "runtimes", "needle", "venv", "bin", "needle");
		const customCheckpoint = "/elsewhere/custom.pkl";
		const runtime = new NeedleRuntime({
			agentDir,
			deps: {
				existsFn: (path) => path === entryPath || path === customCheckpoint,
				runCommand: async (_command, args) => {
					capturedArgv = args;
					return ok(REAL_STDOUT_WARM_CACHE);
				},
			},
		});
		await runtime.runFunctionCall({ query: "q", tools: [] }, { checkpointPath: customCheckpoint });
		expect(capturedArgv).toContain(customCheckpoint);
	});
});

describe("smokeTest", () => {
	it("succeeds with a latencyMs and the parsed call from a real stdout capture", async () => {
		const agentDir = "/agent";
		const entryPath = join(agentDir, "runtimes", "needle", "venv", "bin", "needle");
		const checkpointPath = join(agentDir, "models", "needle", "needle.pkl");
		const runtime = new NeedleRuntime({
			agentDir,
			deps: {
				existsFn: (path) => path === entryPath || path === checkpointPath,
				runCommand: async () => ok(REAL_STDOUT_COLD_CACHE),
			},
		});
		const result = await runtime.smokeTest();
		expect(result.ok).toBe(true);
		expect(typeof result.latencyMs).toBe("number");
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(result.call).toEqual({ name: "get_weather", arguments: { location: "SanFrancisco" } });
	});

	it("propagates failure with an error and a latencyMs, never fabricating a call", async () => {
		const agentDir = "/agent";
		const entryPath = join(agentDir, "runtimes", "needle", "venv", "bin", "needle");
		const checkpointPath = join(agentDir, "models", "needle", "needle.pkl");
		const runtime = new NeedleRuntime({
			agentDir,
			deps: {
				existsFn: (path) => path === entryPath || path === checkpointPath,
				runCommand: async () => fail("segfault"),
			},
		});
		const result = await runtime.smokeTest();
		expect(result.ok).toBe(false);
		expect(result.call).toBeUndefined();
		expect(result.error).toContain("run-fail");
		expect(typeof result.latencyMs).toBe("number");
	});

	it("reports the not-installed error when invoked before installManaged()", async () => {
		const runtime = new NeedleRuntime({
			agentDir: "/agent",
			deps: { existsFn: () => false, runCommand: async () => ok() },
		});
		const result = await runtime.smokeTest();
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not-installed");
	});
});

describe("dispose", () => {
	it("is a documented no-op: needle invocations are one-shot, so there is no tracked child to kill", () => {
		const runtime = new NeedleRuntime({ agentDir: "/agent" });
		expect(() => runtime.dispose()).not.toThrow();
		expect(runtime.dispose()).toBeUndefined();
	});
});
