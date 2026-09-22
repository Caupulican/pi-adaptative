import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@caupulican/pi-ai/faux";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthStorage, InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import type { HarnessCapability } from "../src/core/capability-contract.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationProfile } from "../src/core/orchestration/contracts.ts";
import { validateOrchestrationProfile } from "../src/core/orchestration/profile-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { TypeSafeEvidenceStore } from "../src/core/review/typesafe-evidence-store.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { capabilitySurvivesReadOnly, envelopeHasToolCapability } from "../src/core/tool-capability-policy.ts";
import { AuthDialogsController } from "../src/modes/interactive/auth-dialogs-controller.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness } from "./suite/harness.ts";

const dirs: string[] = [];
beforeAll(() => initTheme("dark"));
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("packaged TypeSafe reviewer", () => {
	it.each([false, true])("retrieves inherited review evidence only for a real fork: fork=%s", async (fork) => {
		const harness = await createHarness({
			initialActiveToolNames: ["typesafe_review"],
			settings: { workerDelegation: { orchestrationProfile: undefined } },
		});
		try {
			const archive = TypeSafeEvidenceStore.file(harness.tempDir, harness.sessionManager.getSessionId());
			const ref = archive.save("parent-review", {
				accepted: false,
				request: { state: "inherited adverse evidence" },
			});
			harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "parent-review",
				toolName: "typesafe_review",
				content: [{ type: "text", text: JSON.stringify({ evidence: ref }) }],
				details: { evidence: ref },
				isError: false,
				timestamp: Date.now(),
			});
			const manager = fork
				? harness.sessionManager.createBranchedSessionManager(harness.sessionManager.getLeafId()!)
				: SessionManager.inMemory(harness.tempDir);
			const { session } = await createAgentSession({
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				authStorage: harness.authStorage,
				modelRegistry: harness.session.modelRegistry,
				settingsManager: harness.settingsManager,
				model: harness.session.model,
				sessionManager: manager,
			});
			try {
				const result = await session
					.getToolDefinition("typesafe_review")!
					.execute("read-inherited", { action: "evidence", id: ref.id }, undefined, undefined, {} as never);
				if (fork) {
					expect(result).not.toMatchObject({ isError: true });
					const page = JSON.parse(result.content[0].type === "text" ? result.content[0].text : "{}");
					expect(JSON.parse(page.text)).toMatchObject({
						record: { accepted: false, request: { state: "inherited adverse evidence" } },
					});
				} else expect(result).toMatchObject({ isError: true });
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("typesafe_review", { action: "evidence", id: ref.id }), {
						stopReason: "toolUse",
					}),
					(context) => {
						const reviewed = context.messages.find(
							(message) => message.role === "toolResult" && message.toolName === "typesafe_review",
						);
						expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ isError: !fork });
						if (fork) expect(JSON.stringify(reviewed)).toContain("inherited adverse evidence");
						return fauxAssistantMessage(
							'{"summary":"Checked inherited evidence.","status":"completed","findings":[]}',
						);
					},
				]);
				const delegated = await session.runWorkerDelegationOnce({
					instructions: `Read review evidence ${ref.id}.`,
				});
				expect(delegated, JSON.stringify(delegated)).toMatchObject({
					started: true,
					record: { status: "succeeded" },
				});
			} finally {
				await session.disposeAndWait();
			}
		} finally {
			await harness.cleanup();
		}
	});
	it.each([
		{ capabilities: [] as HarnessCapability[], admitted: false },
		{ capabilities: ["network.http", "credentials.use"] as HarnessCapability[], admitted: false },
		{ capabilities: ["semantic.judge"] as HarnessCapability[], admitted: true },
	])(
		"requires semantic judgment authority before admitting review execution: $capabilities",
		async ({ capabilities, admitted }) => {
			const faux = registerFauxProvider();
			const model = faux.getModel();
			const now = new Date().toISOString();
			const profile: OrchestrationProfile = {
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				profileId: "review-authority",
				description: "Review authority fixture",
				role: "operator",
				modelPolicy: {
					mode: "fixed",
					candidates: [{ provider: model.provider, modelId: model.id, thinkingLevel: "off" }],
				},
				capabilityCeiling: capabilities,
				toolNames: ["typesafe_review"],
				resourceProfileNames: [],
				dispatchProfileIds: [],
				budget: { maxWallClockMs: 5_000, maxToolCalls: 4, maxTokens: 8_192, maxCostUsd: 1 },
				maxConcurrent: 1,
				leaseTtlMs: 10_000,
				requireIndependentVerification: false,
				createdAt: now,
				updatedAt: now,
			};
			const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				Response.json({
					model: "jev-1.13.0",
					answers: {
						q: {
							type: "choice",
							choice: "supports",
							confidence: 1,
							probabilities: { supports: 1, insufficient: 0 },
						},
					},
					usage: { input_tokens: 100, output_tokens: 10 },
				}),
			);
			let cleanup: (() => Promise<void>) | undefined;
			try {
				if (!admitted) {
					expect(() => validateOrchestrationProfile(profile)).toThrow("lacks judgment authority");
					expect(fetcher).not.toHaveBeenCalled();
					return;
				}
				expect(() => validateOrchestrationProfile(profile)).not.toThrow();
				const harness = await createHarness({ sharedFauxProvider: faux, orchestrationProfile: profile });
				cleanup = harness.cleanup;
				harness.authStorage.set("typesafe", { type: "api_key", key: "fixture-key" });
				harness.setResponses([
					fauxAssistantMessage(
						fauxToolCall("typesafe_review", {
							action: "review",
							review: {
								state: "fixture",
								questions: {
									q: {
										instructions: "Verify fixture",
										criteria: { supports: "Supported", insufficient: "Missing" },
										expected: "supports",
									},
								},
							},
						}),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("Done"),
				]);
				await harness.session.prompt("Review the fixture.");
				expect(fetcher).toHaveBeenCalledOnce();
				expect(
					harness.session.messages.find(
						(message) => message.role === "toolResult" && message.toolName === "typesafe_review",
					),
				).toMatchObject({ isError: false, details: { accepted: true } });
			} finally {
				await cleanup?.();
				faux.unregister();
			}
		},
	);
	it.each([200_000, 16_384, 8_192, 4_096])(
		"keeps the default reviewer available at context window %s",
		async (contextWindow) => {
			const harness = await createHarness({ models: [{ id: "reviewer-client", contextWindow }] });
			try {
				harness.authStorage.set("typesafe", { type: "api_key", key: "fixture-key" });
				expect(harness.session.getActiveToolNames()).toContain("typesafe_review");
				const definition = harness.session.getToolDefinition("typesafe_review");
				if (!definition) throw new Error("Missing reviewer");
				expect(
					await definition.execute("status", { action: "status" }, undefined, undefined, {} as never),
				).toMatchObject({ details: { enabled: true } });
			} finally {
				await harness.cleanup();
			}
		},
	);
	it("honors explicit exclusions even when Jev is configured", async () => {
		const harness = await createHarness({ excludedToolNames: ["typesafe_review"] });
		try {
			harness.authStorage.set("typesafe", { type: "api_key", key: "fixture-key" });
			expect(harness.session.getActiveToolNames()).not.toContain("typesafe_review");
			expect(harness.session.getToolDefinition("typesafe_review")).toBeUndefined();
		} finally {
			await harness.cleanup();
		}
	});
	it.each([
		{ withHook: false, status: 200 },
		{ withHook: true, status: 200 },
		{ withHook: false, status: 401 },
	])(
		"persists native review evidence, verdict and usage through the agent loop with hook=$withHook HTTP=$status",
		async ({ withHook, status }) => {
			const harness = await createHarness({
				initialActiveToolNames: ["typesafe_review"],
				extensionFactories: [
					(pi) => {
						pi.on("tool_call", (event) => {
							if (
								withHook &&
								event.toolName === "typesafe_review" &&
								typeof event.input.review === "object" &&
								event.input.review !== null
							) {
								Object.assign(event.input.review, { state: { fixture: "red square", hook: "applied-input" } });
							}
						});
					},
				],
			});
			const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				Response.json(
					{
						model: "jev-1.13.0",
						answers: {
							claim: {
								type: "choice",
								choice: "supports",
								confidence: 0.99,
								probabilities: { supports: 1, insufficient: 0 },
							},
						},
						usage: { input_tokens: 100, output_tokens: 10 },
					},
					{ status },
				),
			);
			try {
				harness.authStorage.set("typesafe", { type: "api_key", key: "fixture-key" });
				harness.setResponses([
					fauxAssistantMessage(
						fauxToolCall("typesafe_review", {
							action: "review",
							review: {
								state: { fixture: "red square" },
								questions: {
									claim: {
										instructions: "Does the fixture state a red square?",
										criteria: { supports: "Explicitly states it", insufficient: "Not stated" },
										expected: "supports",
									},
								},
							},
						}),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("Review recorded."),
				]);
				await harness.session.prompt("Verify the fixture with Jev.");
				const result = harness.session.messages.find(
					(message) => message.role === "toolResult" && message.toolName === "typesafe_review",
				);
				expect(result).toMatchObject({
					role: "toolResult",
					isError: status !== 200,
					details: {
						accepted: status === 200,
						evidence: { id: expect.any(String) },
						response: { model: "jev-1.13.0" },
					},
					usage: { input: 100, output: 10, totalTokens: 110 },
				});
				expect(
					harness.sessionManager
						.getBranch()
						.find((entry) => entry.type === "message" && entry.message.role === "toolResult"),
				).toMatchObject({
					message: {
						toolName: "typesafe_review",
						details: { accepted: status === 200 },
						usage: { totalTokens: 110 },
					},
				});
				expect(fetcher).toHaveBeenCalledOnce();
				const submitted = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
				expect(Object.keys(submitted).sort()).toEqual(["model", "questions", "state"]);
				expect(submitted.model).toBe("jev-latest");
				expect(submitted.state).toEqual(
					withHook ? { fixture: "red square", hook: "applied-input" } : { fixture: "red square" },
				);
				expect(result).toMatchObject({ details: { request: submitted } });
				expect(
					harness.sessionManager
						.getBranch()
						.find((entry) => entry.type === "message" && entry.message.role === "toolResult"),
				).toMatchObject({ message: { details: { request: submitted } } });
				if (result?.role !== "toolResult") throw new Error("Missing native review result");
				expect(JSON.stringify(result.content)).not.toContain("applied-input");
				expect(JSON.stringify(harness.session.messages)).not.toContain("fixture-key");
			} finally {
				await harness.cleanup();
			}
		},
	);
	it("is discoverable from a blank profile and reports live credential changes without network", async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "");
		const cwd = mkdtempSync(join(tmpdir(), "pi-typesafe-"));
		dirs.push(cwd);
		const agentDir = join(cwd, "agent");
		const authPath = join(agentDir, "auth.json");
		const authStorage = AuthStorage.create(authPath);
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();
		expect(loader.getSkills().skills.find((skill) => skill.name === "typesafe-review")).toBeDefined();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			resourceLoader: loader,
			model: getModel("anthropic", "claude-sonnet-4-5"),
			sessionManager: SessionManager.inMemory(),
		});
		try {
			expect(session.getActiveToolNames()).toContain("typesafe_review");
			const tool = session.getToolDefinition("typesafe_review");
			if (!tool) throw new Error("missing built-in review tool");
			expect(await tool.execute("status-1", { action: "status" }, undefined, undefined, {} as never)).toMatchObject({
				details: { enabled: false },
			});
			vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockResolvedValue("fixture-key");
			const showError = vi.fn();
			const login = new AuthDialogsController({
				getSession: () => session,
				ui: {
					tui: { requestRender: vi.fn() },
					overlayHost: { swap: vi.fn() },
					getEditor: () => ({}),
					showError,
					showStatus: vi.fn(),
				} as never,
			});
			await login.showOAuthSelector("login", "typesafe");
			expect(showError).not.toHaveBeenCalled();
			expect(await AuthStorage.create(authPath).getApiKey("typesafe")).toBe("fixture-key");
			expect(session.model?.provider).toBe("anthropic");
			expect(
				session.modelRegistry
					.getAll()
					.some((model) => model.provider === "typesafe" || model.id.startsWith("jev-")),
			).toBe(true);
			expect(await tool.execute("status-2", { action: "status" }, undefined, undefined, {} as never)).toMatchObject({
				details: { enabled: true },
			});
			await session.reload();
			const reloaded = session.getToolDefinition("typesafe_review");
			if (!reloaded) throw new Error("Reviewer was lost on reload");
			expect(
				await reloaded.execute("status-reload", { action: "status" }, undefined, undefined, {} as never),
			).toMatchObject({ details: { enabled: true } });
			expect(session.model?.provider).toBe("anthropic");
			vi.spyOn(loader, "reload").mockRejectedValueOnce(new Error("fixture reload failure"));
			await expect(session.reload()).rejects.toThrow("fixture reload failure");
			expect(session.getActiveToolNames()).toContain("typesafe_review");
			expect(
				await session
					.getToolDefinition("typesafe_review")!
					.execute("status-rollback", { action: "status" }, undefined, undefined, {} as never),
			).toMatchObject({ details: { enabled: true } });
			authStorage.setRuntimeApiKey("openai", "fixture-openai-key");
			await session.setModel(getModel("openai", "gpt-4.1"));
			expect(session.model?.provider).toBe("openai");
			expect(session.getActiveToolNames()).toContain("typesafe_review");
			authStorage.logout("typesafe");
			expect(await AuthStorage.create(authPath).getApiKey("typesafe")).toBeUndefined();
			expect(await tool.execute("status-3", { action: "status" }, undefined, undefined, {} as never)).toMatchObject({
				details: { enabled: false },
			});
		} finally {
			await session.disposeAndWait();
		}
	});
	it("resolves the environment through the existing credential owner", async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "fixture-env-key");
		const auth = AuthStorage.inMemory();
		expect(auth.hasAuth("typesafe")).toBe(true);
		expect(await auth.getApiKey("typesafe")).toBe("fixture-env-key");
	});
	it("is authorized by semantic judgment, which a read-only grant keeps", () => {
		// The host brokers the call and holds the credential: network or credential authority is neither
		// needed nor sufficient, and a read-only reviewer still gets Jev.
		expect(envelopeHasToolCapability(["network.http", "credentials.use"], "typesafe_review")).toBe(false);
		expect(envelopeHasToolCapability(["semantic.judge"], "typesafe_review")).toBe(true);
		expect(capabilitySurvivesReadOnly("semantic.judge")).toBe(true);
	});
	it.each([false, true])(
		"reports /login typesafe honestly when persistence fails=%s without changing the foreground model",
		async (failWrite) => {
			vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockResolvedValue("fixture-key");
			const backend = new InMemoryAuthStorageBackend();
			const authStorage = AuthStorage.fromStorage(backend);
			if (failWrite)
				vi.spyOn(backend, "withLock").mockImplementation(() => {
					throw new Error("fixture write failure");
				});
			const setModel = vi.fn();
			const showError = vi.fn();
			const showStatus = vi.fn();
			const controller = new AuthDialogsController({
				getSession: () =>
					({
						model: { provider: "unknown", id: "unknown", api: "unknown" },
						modelRegistry: { authStorage, getAll: () => [], refresh: vi.fn() },
						setModel,
					}) as never,
				ui: {
					tui: { requestRender: vi.fn() },
					overlayHost: { swap: vi.fn() },
					getEditor: () => ({}),
					showError,
					showStatus,
					updateAvailableProviderCount: vi.fn(async () => {}),
					invalidateFooter: vi.fn(),
					updateEditorBorderColor: vi.fn(),
				} as never,
			});
			await controller.showOAuthSelector("login", "typesafe");
			expect(await authStorage.getApiKey("typesafe")).toBe("fixture-key");
			expect(setModel).not.toHaveBeenCalled();
			if (failWrite) {
				expect(showError).toHaveBeenCalledWith(expect.stringContaining("not saved"));
				expect(showStatus).not.toHaveBeenCalled();
			} else {
				expect(showError).not.toHaveBeenCalled();
				expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("review"));
			}
		},
	);
});
