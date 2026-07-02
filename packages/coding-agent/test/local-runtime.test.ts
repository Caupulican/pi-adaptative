import { describe, expect, it, vi } from "vitest";
import { OllamaRuntime } from "../src/core/models/local-runtime.ts";

function ndjsonResponse(lines: object[]): Response {
	const body = lines.map((line) => JSON.stringify(line)).join("\n");
	return new Response(body, { status: 200 });
}

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

	it("install guide is manual steps only (never an executed command)", () => {
		const runtime = new OllamaRuntime({ agentDir: "/agent", deps: { homeDir: "/home/u" } });
		const guide = runtime.installGuide().join("\n");
		expect(guide).toContain("manual steps");
		expect(guide).toContain("/home/u/.local/share/ollama-dist");
		expect(guide).not.toContain("curl |");
	});
});
