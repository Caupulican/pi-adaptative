import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { LocalRuntimeController, type LocalRuntimeControllerDeps } from "../src/core/local-runtime-controller.ts";
import {
	BONSAI_27B,
	PRISM_LLAMACPP_PINNED_RELEASE,
	type PrismLlamaCppDeps,
} from "../src/core/models/llamacpp-runtime.ts";

/**
 * Readiness-gate tests for pi-managed prism llama.cpp models: "usable when needed" (self-healing
 * serve-on-demand), never a one-shot serve-at-install. Follows agent-session-local-runtime.test.ts's
 * house style for LocalRuntimeController — a REAL runtime (PrismLlamaCppRuntime) with faked
 * fetch/spawn/exists, not a hand-rolled fake object — but constructs the controller directly rather
 * than through the full AgentSession/harness stack, since the seam under test
 * (`prismLlamaCppDeps`) doesn't need session-level machinery (extension runner, model router, etc.).
 */

function scratchDir(name: string): string {
	return mkdtempSync(join(tmpdir(), `pi-controller-prism-${name}-`));
}

function writeManifest(
	agentDir: string,
	manifest: { release: string; binaryRelPath: string; backend: "cpu" | "cuda" },
): void {
	const runtimeDir = join(agentDir, "runtimes", "prism-llamacpp");
	mkdirSync(runtimeDir, { recursive: true });
	writeFileSync(join(runtimeDir, "install.json"), JSON.stringify(manifest));
}

function fakeChild(pid: number): {
	pid: number;
	kill: ReturnType<typeof vi.fn>;
	unref: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
} {
	return { pid, kill: vi.fn(), unref: vi.fn(), on: vi.fn() };
}

/** BONSAI_27B.mmprojFile is optional on the descriptor type (future non-vision prism models could
 * omit it), but the curated Bonsai-27B constant always sets it — asserted once here so every test
 * below can use it as a plain string without repeating the narrowing. */
const MMPROJ_FILE = BONSAI_27B.mmprojFile as string;

function bonsaiModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "llama-cpp",
		id: BONSAI_27B.repo,
		name: BONSAI_27B.repo,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:8090/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 2_048,
		...overrides,
	} as Model<Api>;
}

function controller(agentDir: string, prismLlamaCppDeps?: PrismLlamaCppDeps): LocalRuntimeController {
	const deps: LocalRuntimeControllerDeps = {
		agentDir,
		prismLlamaCppDeps,
		getLastAssistantMessage: () => undefined,
		getUIContext: () => undefined,
		emit: () => {},
		resolveConfiguredTierModel: () => undefined,
		formatModel: (model) => `${model.provider}/${model.id}`,
	};
	return new LocalRuntimeController(deps);
}

function ensureReady(
	ctrl: LocalRuntimeController,
	model: Model<Api>,
): Promise<{ ready: boolean; reason: string; installGuide?: string[] }> {
	return (
		ctrl as unknown as {
			ensurePrismLlamaCppModelReady: (m: Model<Api>) => Promise<{ ready: boolean; reason: string }>;
		}
	).ensurePrismLlamaCppModelReady(model);
}

describe("LocalRuntimeController.ensurePrismLlamaCppModelReady (private) — serve on demand", () => {
	it("is a no-op when the server is already healthy — no downloads, no spawn", async () => {
		const agentDir = scratchDir("healthy");
		try {
			const fetchCalls: string[] = [];
			const spawnFn = vi.fn();
			const fetchFn = (async (url: string) => {
				fetchCalls.push(String(url));
				return new Response("{}", { status: 200 });
			}) as unknown as typeof fetch;
			const ctrl = controller(agentDir, { fetchFn, spawnFn: spawnFn as never });

			const result = await ensureReady(ctrl, bonsaiModel());

			expect(result).toEqual({ ready: true, reason: "already_running" });
			expect(fetchCalls).toEqual(["http://127.0.0.1:8090/health"]);
			expect(spawnFn).not.toHaveBeenCalled();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("skips the health-check on a second call once confirmed up (same cache the Ollama gate uses)", async () => {
		const agentDir = scratchDir("cached");
		try {
			const fetchCalls: string[] = [];
			const fetchFn = (async (url: string) => {
				fetchCalls.push(String(url));
				return new Response("{}", { status: 200 });
			}) as unknown as typeof fetch;
			const ctrl = controller(agentDir, { fetchFn });

			const first = await ensureReady(ctrl, bonsaiModel());
			const callsAfterFirst = fetchCalls.length;
			const second = await ensureReady(ctrl, bonsaiModel());

			expect(first.ready).toBe(true);
			expect(second).toEqual({ ready: true, reason: "confirmed_up_cached" });
			expect(fetchCalls.length).toBe(callsAfterFirst);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("never gates the user's own llama-cpp/local model — zero fetch calls, zero runtime touch", async () => {
		const agentDir = scratchDir("userowned");
		try {
			const fetchCalls: string[] = [];
			const fetchFn = (async (url: string) => {
				fetchCalls.push(String(url));
				return new Response("{}", { status: 200 });
			}) as unknown as typeof fetch;
			const ctrl = controller(agentDir, { fetchFn });

			const result = await ensureReady(ctrl, bonsaiModel({ id: "local", baseUrl: "http://127.0.0.1:8080/v1" }));

			expect(result).toEqual({ ready: true, reason: "not_pi_managed_llama_cpp" });
			expect(fetchCalls).toEqual([]);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("down + files re-verified (a missing mmproj is re-downloaded, not skipped) -> serves with --mmproj attached", async () => {
		const agentDir = scratchDir("reserve");
		try {
			writeManifest(agentDir, {
				release: PRISM_LLAMACPP_PINNED_RELEASE,
				binaryRelPath: "bin/llama-server",
				backend: "cpu",
			});
			const binaryPath = join(agentDir, "runtimes", "prism-llamacpp", "bin", "llama-server");
			let up = false;
			let spawnArgs: string[] = [];
			const downloadedUrls: string[] = [];
			const fetchFn = (async (url: string) => {
				const u = String(url);
				if (u.endsWith("/health")) return new Response("", { status: up ? 200 : 503 });
				downloadedUrls.push(u);
				return new Response("fake-gguf-bytes", { status: 200 });
			}) as unknown as typeof fetch;
			const ctrl = controller(agentDir, {
				existsFn: (path: string) => path === binaryPath,
				sleepFn: async () => {},
				fetchFn,
				spawnFn: (_command, args) => {
					spawnArgs = args;
					up = true;
					return fakeChild(9001);
				},
			});

			const result = await ensureReady(ctrl, bonsaiModel());

			expect(result).toEqual({ ready: true, reason: "started" });
			expect(downloadedUrls.some((u) => u.includes(BONSAI_27B.file))).toBe(true);
			expect(downloadedUrls.some((u) => u.includes(MMPROJ_FILE))).toBe(true);
			expect(spawnArgs).toContain("--mmproj");
			expect(spawnArgs).toContain("-c");
			expect(spawnArgs[spawnArgs.indexOf("-c") + 1]).toBe("8192"); // reuses model.contextWindow, never re-derives from RAM
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("a download failure (mmproj) surfaces a clear stage-tagged error and NEVER spawns llama-server", async () => {
		const agentDir = scratchDir("dlfail-mmproj");
		try {
			writeManifest(agentDir, {
				release: PRISM_LLAMACPP_PINNED_RELEASE,
				binaryRelPath: "bin/llama-server",
				backend: "cpu",
			});
			const binaryPath = join(agentDir, "runtimes", "prism-llamacpp", "bin", "llama-server");
			const spawnFn = vi.fn();
			const fetchFn = (async (url: string) => {
				const u = String(url);
				if (u.endsWith("/health")) return new Response("", { status: 503 });
				if (u.includes(MMPROJ_FILE)) return new Response("not found", { status: 404 });
				return new Response("fake-gguf-bytes", { status: 200 });
			}) as unknown as typeof fetch;
			const ctrl = controller(agentDir, {
				existsFn: (path: string) => path === binaryPath,
				sleepFn: async () => {},
				fetchFn,
				spawnFn: spawnFn as never,
			});

			const result = await ensureReady(ctrl, bonsaiModel());

			expect(result.ready).toBe(false);
			expect(result.reason).toContain("mmproj-download");
			expect(result.reason).toContain("HTTP 404");
			expect(spawnFn).not.toHaveBeenCalled();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("a download failure (main weights) also never spawns llama-server", async () => {
		const agentDir = scratchDir("dlfail-main");
		try {
			writeManifest(agentDir, {
				release: PRISM_LLAMACPP_PINNED_RELEASE,
				binaryRelPath: "bin/llama-server",
				backend: "cpu",
			});
			const binaryPath = join(agentDir, "runtimes", "prism-llamacpp", "bin", "llama-server");
			const spawnFn = vi.fn();
			const fetchFn = (async (url: string) => {
				const u = String(url);
				if (u.endsWith("/health")) return new Response("", { status: 503 });
				if (u.includes(BONSAI_27B.file)) return new Response("server error", { status: 500 });
				return new Response("fake-gguf-bytes", { status: 200 });
			}) as unknown as typeof fetch;
			const ctrl = controller(agentDir, {
				existsFn: (path: string) => path === binaryPath,
				sleepFn: async () => {},
				fetchFn,
				spawnFn: spawnFn as never,
			});

			const result = await ensureReady(ctrl, bonsaiModel());

			expect(result.ready).toBe(false);
			expect(result.reason).toContain("model-download");
			expect(spawnFn).not.toHaveBeenCalled();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
