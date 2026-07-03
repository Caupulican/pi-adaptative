import { fauxAssistantMessage, type Model, registerFauxProvider } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import type { RouteDecision } from "../src/core/autonomy/contracts.ts";
import type { LocalRuntimeDeps } from "../src/core/models/local-runtime.ts";
import { OllamaRuntime } from "../src/core/models/local-runtime.ts";
import { createHarness } from "./suite/harness.ts";

type Api = string;

/** A model literal shaped like one resolved from the registry, for direct unit calls. */
function localModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "ollama",
		id: "qwen3:0.6b",
		name: "qwen3:0.6b",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:11434/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
		...overrides,
	} as Model<Api>;
}

function cloudModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "faux-cloud",
		id: "cloud-1",
		name: "cloud-1",
		api: "faux",
		baseUrl: "https://api.example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8192,
		...overrides,
	} as Model<Api>;
}

/** A minimal fake child process matching Pick<ChildProcess, "pid"|"kill"|"unref"|"on">. */
function fakeChild(): ReturnType<NonNullable<LocalRuntimeDeps["spawnFn"]>> {
	const child: { pid: number; kill: () => boolean; unref: () => void; on: () => typeof child } = {
		pid: 1,
		kill: () => true,
		unref: () => {},
		on: () => child,
	};
	return child as unknown as ReturnType<NonNullable<LocalRuntimeDeps["spawnFn"]>>;
}

/** Deps where the server is already reachable — start()/detect() are no-ops that report "up". */
function upDeps(): LocalRuntimeDeps {
	return {
		fetchFn: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
		existsFn: () => true,
		spawnFn: fakeChild,
		sleepFn: async () => {},
	};
}

/** Deps where the server is down and no binary can be found anywhere. */
function binaryMissingDeps(): LocalRuntimeDeps {
	return {
		fetchFn: (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch,
		existsFn: () => false,
		spawnFn: fakeChild,
		sleepFn: async () => {},
	};
}

/** Deps where the server is down, a binary exists, and spawning it succeeds on the first health poll. */
function bootableDeps(onSpawn?: (env: NodeJS.ProcessEnv) => void): LocalRuntimeDeps {
	let up = false;
	return {
		fetchFn: (async () => {
			if (!up) throw new Error("ECONNREFUSED");
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch,
		existsFn: (path: string) => path.includes("ollama-dist"),
		spawnFn: (_command, _argv, options) => {
			up = true; // pretend the spawned process starts serving immediately
			onSpawn?.(options.env);
			return fakeChild();
		},
		sleepFn: async () => {},
		homeDir: "/home/tester",
	};
}

describe("AgentSession local (Ollama) runtime readiness", () => {
	it("getLocalRuntime returns the same cached instance for the same baseUrl, a different one for a different baseUrl", async () => {
		const harness = await createHarness({ localRuntimeDeps: upDeps() });
		try {
			const a1 = harness.session.getLocalRuntime("http://127.0.0.1:11434");
			const a2 = harness.session.getLocalRuntime("http://127.0.0.1:11434");
			const b = harness.session.getLocalRuntime("http://127.0.0.1:22345");
			expect(a1).toBe(a2);
			expect(a1).not.toBe(b);
			expect(a1).toBeInstanceOf(OllamaRuntime);
		} finally {
			harness.cleanup();
		}
	});

	it("getLocalRuntime with no argument uses the same default-keyed instance every time", async () => {
		const harness = await createHarness({ localRuntimeDeps: upDeps() });
		try {
			expect(harness.session.getLocalRuntime()).toBe(harness.session.getLocalRuntime());
		} finally {
			harness.cleanup();
		}
	});

	describe("_ensureLocalModelReady (private)", () => {
		function ensureReady(harness: Awaited<ReturnType<typeof createHarness>>, model: Model<Api>) {
			return (
				harness.session as unknown as {
					_ensureLocalModelReady: (
						m: Model<Api>,
					) => Promise<{ ready: boolean; reason: string; installGuide?: string[] }>;
				}
			)._ensureLocalModelReady(model);
		}

		it("is a no-op for a non-local (non-ollama) model", async () => {
			const harness = await createHarness({ localRuntimeDeps: binaryMissingDeps() });
			try {
				const result = await ensureReady(harness, cloudModel());
				expect(result.ready).toBe(true);
				expect(result.reason).toBe("not_local");
			} finally {
				harness.cleanup();
			}
		});

		it("reports ready immediately when the server already responds", async () => {
			const harness = await createHarness({ localRuntimeDeps: upDeps() });
			try {
				const result = await ensureReady(harness, localModel());
				expect(result.ready).toBe(true);
			} finally {
				harness.cleanup();
			}
		});

		it("reports binary_missing with an install guide when no server is up and no binary resolves", async () => {
			const harness = await createHarness({ localRuntimeDeps: binaryMissingDeps() });
			try {
				const result = await ensureReady(harness, localModel());
				expect(result.ready).toBe(false);
				expect(result.reason).toBe("binary_missing");
				expect(result.installGuide?.length).toBeGreaterThan(0);
				expect(result.installGuide?.join("\n")).toContain("never runs installers");
			} finally {
				harness.cleanup();
			}
		});

		it("boots the server and reports ready when a binary is found", async () => {
			const harness = await createHarness({ localRuntimeDeps: bootableDeps() });
			try {
				const result = await ensureReady(harness, localModel());
				expect(result.ready).toBe(true);
			} finally {
				harness.cleanup();
			}
		});

		it("health-checks the URL derived from the model's configured baseUrl, stripping the /v1 suffix", async () => {
			const seenUrls: string[] = [];
			const harness = await createHarness({
				localRuntimeDeps: {
					...upDeps(),
					fetchFn: (async (url: string) => {
						seenUrls.push(String(url));
						return new Response("{}", { status: 200 });
					}) as unknown as typeof fetch,
				},
			});
			try {
				await ensureReady(harness, localModel({ baseUrl: "http://localhost:22345/v1" }));
				expect(seenUrls.some((url) => url.startsWith("http://localhost:22345/api/"))).toBe(true);
				expect(seenUrls.some((url) => url.includes("/v1/api/"))).toBe(false);
			} finally {
				harness.cleanup();
			}
		});
	});

	describe("_ensureRouteModelReady (private) — graceful fallback, never a dead-ended turn", () => {
		function ensureRouteReady(
			harness: Awaited<ReturnType<typeof createHarness>>,
			resolved: { decision: RouteDecision; model: Model<Api> } | undefined,
		) {
			return (
				harness.session as unknown as {
					_ensureRouteModelReady: (
						r: { decision: RouteDecision; model: Model<Api> } | undefined,
					) => Promise<{ decision: RouteDecision; model: Model<Api> } | undefined>;
				}
			)._ensureRouteModelReady(resolved);
		}

		function cheapRoute(
			model: Model<Api>,
			overrides: Partial<RouteDecision> = {},
		): { decision: RouteDecision; model: Model<Api> } {
			return {
				model,
				decision: {
					tier: "cheap",
					risk: "read-only",
					confidence: 0.9,
					reasonCode: "explain",
					reasons: ["mechanical lookup"],
					...overrides,
				},
			};
		}

		it("passes undefined through unchanged", async () => {
			const harness = await createHarness({ localRuntimeDeps: upDeps() });
			try {
				expect(await ensureRouteReady(harness, undefined)).toBeUndefined();
			} finally {
				harness.cleanup();
			}
		});

		it("passes a non-local model through unchanged, with no readiness check performed", async () => {
			const calls: string[] = [];
			const harness = await createHarness({
				localRuntimeDeps: {
					...upDeps(),
					fetchFn: (async () => {
						calls.push("fetch");
						return new Response("{}");
					}) as unknown as typeof fetch,
				},
			});
			try {
				const route = cheapRoute(cloudModel());
				const result = await ensureRouteReady(harness, route);
				expect(result).toEqual(route);
				expect(calls).toEqual([]);
			} finally {
				harness.cleanup();
			}
		});

		it("passes a ready local model through unchanged", async () => {
			const harness = await createHarness({ localRuntimeDeps: upDeps() });
			try {
				const route = cheapRoute(localModel());
				const result = await ensureRouteReady(harness, route);
				expect(result?.model).toBe(route.model);
				expect(result?.decision.tier).toBe("cheap");
			} finally {
				harness.cleanup();
			}
		});

		it("falls back to the configured medium tier and warns with WHY (install guide) and WHICH tier now handles it", async () => {
			const mediumFaux = cloudModel({ provider: "faux", id: "medium-cloud" });
			const harness = await createHarness({
				models: [{ id: "medium-cloud" }],
				settings: { modelRouter: { enabled: true, mediumModel: "faux/medium-cloud" } },
				localRuntimeDeps: binaryMissingDeps(),
			});
			try {
				const before = harness.eventsOfType("warning").length;
				const result = await ensureRouteReady(harness, cheapRoute(localModel()));

				expect(result?.decision.tier).toBe("medium");
				expect(result?.decision.fallbackFrom).toBe("cheap");
				expect(result?.decision.reasonCode).toBe("local_model_not_ready_fallback");
				expect(result?.model.provider).toBe("faux");
				expect(result?.model.id).toBe(mediumFaux.id);

				const warnings = harness.eventsOfType("warning");
				expect(warnings.length).toBe(before + 1);
				const message = warnings.at(-1)?.message ?? "";
				expect(message).toContain("unavailable"); // WHY it's unavailable...
				expect(message).toContain("never runs installers"); // ...binary-missing -> guide inline
				expect(message).toContain("medium"); // WHICH tier now handles the turn
			} finally {
				harness.cleanup();
			}
		});

		it("hints to check ollama is running when the server is unreachable for a reason other than a missing binary", async () => {
			const harness = await createHarness({
				models: [{ id: "medium-cloud" }],
				settings: { modelRouter: { enabled: true, mediumModel: "faux/medium-cloud" } },
				// Binary IS found, but the boot attempt itself never comes up (health_check_timeout) —
				// distinct from binary_missing, so the warning's wording must differ too.
				localRuntimeDeps: {
					existsFn: (path: string) => path.includes("ollama-dist"),
					fetchFn: (async () => {
						throw new Error("ECONNREFUSED");
					}) as unknown as typeof fetch,
					spawnFn: fakeChild,
					sleepFn: async () => {},
					homeDir: "/home/tester",
				},
			});
			try {
				await ensureRouteReady(harness, cheapRoute(localModel()));
				const message = harness.eventsOfType("warning").at(-1)?.message ?? "";
				expect(message).toContain("check that ollama is running");
				expect(message).not.toContain("never runs installers"); // not the binary-missing wording
			} finally {
				harness.cleanup();
			}
		});

		it("escalates all the way to expensive when medium is not configured", async () => {
			const harness = await createHarness({
				models: [{ id: "expensive-cloud" }],
				settings: { modelRouter: { enabled: true, expensiveModel: "faux/expensive-cloud" } },
				localRuntimeDeps: binaryMissingDeps(),
			});
			try {
				const result = await ensureRouteReady(harness, cheapRoute(localModel()));
				expect(result?.decision.tier).toBe("expensive");
				expect(result?.decision.fallbackFrom).toBe("cheap");
			} finally {
				harness.cleanup();
			}
		});

		it("gives up (session default) when no higher tier is configured/available at all", async () => {
			const harness = await createHarness({
				settings: { modelRouter: { enabled: true } },
				localRuntimeDeps: binaryMissingDeps(),
			});
			try {
				const result = await ensureRouteReady(harness, cheapRoute(localModel()));
				expect(result).toBeUndefined();
			} finally {
				harness.cleanup();
			}
		});

		it("covers the executor lane: an executor-routed local model that can't be reached also degrades gracefully", async () => {
			const harness = await createHarness({
				models: [{ id: "medium-cloud" }],
				settings: { modelRouter: { enabled: true, mediumModel: "faux/medium-cloud" } },
				localRuntimeDeps: binaryMissingDeps(),
			});
			try {
				// Same shape _resolveExecutorRoute returns: tier "cheap", reasonCode "executor_direct".
				const executorRoute = cheapRoute(localModel(), {
					reasonCode: "executor_direct",
					risk: "scoped-write",
					confidence: 1,
				});
				const result = await ensureRouteReady(harness, executorRoute);
				expect(result?.decision.tier).toBe("medium");
				expect(result?.decision.fallbackFrom).toBe("cheap");
				expect(result?.model.id).toBe("medium-cloud");
			} finally {
				harness.cleanup();
			}
		});
	});
});

/** Registers a SECOND, "ollama"-named faux provider on top of an existing harness — the harness's
 * own faux provider is a single, fixed provider name, so a local-vs-cloud scenario needs its own. */
function registerOllamaFaux(harness: Awaited<ReturnType<typeof createHarness>>, ids: string[]) {
	const ollamaFaux = registerFauxProvider({ provider: "ollama", models: ids.map((id) => ({ id })) });
	harness.authStorage.setRuntimeApiKey("ollama", "faux-key");
	harness.session.modelRegistry.registerProvider("ollama", {
		baseUrl: ollamaFaux.models[0].baseUrl,
		apiKey: "faux-key",
		api: ollamaFaux.api,
		models: ollamaFaux.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		})),
	});
	return ollamaFaux;
}

describe("AgentSession local runtime readiness — end to end through prompt()", () => {
	it("boots the local model's server before the turn (reusing the user's own models, not owned storage) and runs the turn on it", async () => {
		let serveEnv: NodeJS.ProcessEnv | undefined;
		const harness = await createHarness({
			settings: { modelRouter: { enabled: true, cheapModel: "ollama/qwen3:0.6b" } },
			localRuntimeDeps: bootableDeps((env) => {
				serveEnv = env;
			}),
		});
		const ollamaFaux = registerOllamaFaux(harness, ["qwen3:0.6b"]);
		try {
			ollamaFaux.setResponses([fauxAssistantMessage("answered locally")]);

			await harness.session.prompt("Explain this code block");

			const assistantTexts = harness.session.messages
				.filter((message) => message.role === "assistant")
				.flatMap((message) => (message.role === "assistant" ? message.content : []))
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text);
			expect(assistantTexts).toEqual(["answered locally"]);
			expect(harness.eventsOfType("warning")).toHaveLength(0);
			// The router's boot path must reuse the user's OWN models dir, never pi's owned storage.
			expect(serveEnv?.OLLAMA_MODELS).toBeUndefined();
		} finally {
			ollamaFaux.unregister();
			harness.cleanup();
		}
	});

	it("warns (WHY + WHICH tier) and falls back to the configured medium tier when the local server can't be started — never dead-ends the turn", async () => {
		const harness = await createHarness({
			models: [{ id: "medium-cloud" }],
			settings: {
				modelRouter: {
					enabled: true,
					cheapModel: "ollama/qwen3:0.6b",
					mediumModel: "faux/medium-cloud",
					judgeEnabled: false,
				},
			},
			localRuntimeDeps: binaryMissingDeps(),
		});
		const ollamaFaux = registerOllamaFaux(harness, ["qwen3:0.6b"]);
		try {
			// Never queued a response for ollamaFaux — if the (unready) local model were somehow
			// still called, the faux provider would throw "no more responses configured".
			harness.setResponses([fauxAssistantMessage("answered on cloud")]);

			await harness.session.prompt("Explain this code block");

			const assistantTexts = harness.session.messages
				.filter((message) => message.role === "assistant")
				.flatMap((message) => (message.role === "assistant" ? message.content : []))
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text);
			expect(assistantTexts).toEqual(["answered on cloud"]);

			const warnings = harness.eventsOfType("warning");
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.message).toContain("unavailable");
			expect(warnings[0]?.message).toContain("never runs installers");
			expect(warnings[0]?.message).toContain("medium");
		} finally {
			ollamaFaux.unregister();
			harness.cleanup();
		}
	});
});

describe("AgentSession local runtime readiness — confirmed-up cache", () => {
	function ensureReady(harness: Awaited<ReturnType<typeof createHarness>>, model: Model<Api>) {
		return (
			harness.session as unknown as {
				_ensureLocalModelReady: (
					m: Model<Api>,
				) => Promise<{ ready: boolean; reason: string; installGuide?: string[] }>;
			}
		)._ensureLocalModelReady(model);
	}

	it("skips the health-check on a second call once the server is confirmed up", async () => {
		let fetchCalls = 0;
		const harness = await createHarness({
			localRuntimeDeps: {
				...upDeps(),
				fetchFn: (async () => {
					fetchCalls++;
					return new Response("{}", { status: 200 });
				}) as unknown as typeof fetch,
			},
		});
		try {
			const first = await ensureReady(harness, localModel());
			const second = await ensureReady(harness, localModel());

			expect(first.ready).toBe(true);
			expect(second.ready).toBe(true);
			expect(second.reason).toBe("confirmed_up_cached");
			expect(fetchCalls).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("re-checks after a local-model turn's assistant response comes back as a connection-shaped error", async () => {
		let fetchCalls = 0;
		const harness = await createHarness({
			settings: { modelRouter: { enabled: true, cheapModel: "ollama/qwen3:0.6b" } },
			localRuntimeDeps: {
				...upDeps(),
				fetchFn: (async () => {
					fetchCalls++;
					return new Response("{}", { status: 200 });
				}) as unknown as typeof fetch,
			},
		});
		const ollamaFaux = registerOllamaFaux(harness, ["qwen3:0.6b"]);
		try {
			ollamaFaux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "connection reset" })]);
			await harness.session.prompt("Explain this code block").catch(() => {});
			expect(fetchCalls).toBe(1); // confirmed up once, before the (failed) call

			ollamaFaux.appendResponses([fauxAssistantMessage("recovered")]);
			await harness.session.prompt("Explain this code block again");
			expect(fetchCalls).toBe(2); // the prior error invalidated the cache — re-checked
		} finally {
			ollamaFaux.unregister();
			harness.cleanup();
		}
	});
});
