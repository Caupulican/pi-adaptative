import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getProfilesDir } from "../../config.ts";
import { SessionManager } from "../../kernel/session/session-manager.ts";
import { stateFile } from "../agent-paths.ts";
import type { AgentSession } from "../agent-session.ts";
import { AuthStorage } from "../auth-storage.ts";
import { sessionSemanticUsageOf } from "../cost/semantic-usage-delivery.ts";
import { readContinuousChatSettings, validateContinuousChatSummaryModel } from "../memory/continuous-chat-settings.ts";
import { ModelRegistry } from "../model-registry.ts";
import { resolveCliModel, resolveProfileModelSettings } from "../model-resolver.ts";
import { resolveRouterCandidatePool } from "../model-router/candidate-pool.ts";
import { evaluateSurfaceFitness } from "../model-router/fitness-gate.ts";
import { OrchestrationProfileStore } from "../orchestration/profile-store.ts";
import { type Lfm3FitnessModality, runLfm3ModalityFitness } from "../research/lfm3-modality-fitness.ts";
import { isProbeAllFailed } from "../research/model-fitness.ts";
import { SystemOneReviewer } from "../review/typesafe-reviewer.ts";
import { createAgentSession } from "../sdk.ts";
import { createCredentialTextRedactor, redactCredentialValues } from "../secrets/credential-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../settings-manager.ts";
import { systemOneAccessFromSession } from "../system-one/access.ts";
import { SystemOneJevAdapter } from "../system-one/adapter.ts";
import { createSystemOneConfig } from "../system-one/config.ts";
import type { ToolProbeResult } from "../tool-protocol-controller.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
import { toolExecutionFailure } from "./fitness-tool-gate.ts";
import { Lfm3MediaClient } from "./lfm3-media.ts";
import { LFM3_MINIMUM_OLLAMA_VERSION, LFM3_MODELS } from "./lfm3-models.ts";
import { OllamaRuntime } from "./local-runtime.ts";
import { installOllamaModel } from "./ollama-model-installation.ts";

export interface Lfm3SetupOptions {
	agentDir: string;
	cwd: string;
	trials: number;
	model?: string;
	activate: boolean;
	signal?: AbortSignal;
	log: (message: string) => void;
}

export function lfm3Status(agentDir: string): string {
	try {
		return readFileSync(stateFile(agentDir, "lfm3-setup.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "No LFM3 setup evidence yet.";
		throw error;
	}
}

/** Session-only scope for measuring these exact models without changing the user's persisted selection. */
function createFitnessSettings(
	settings: SettingsManager,
	refs: readonly string[],
	agentDir: string,
	cwd: string,
): SettingsManager {
	const projected = structuredClone(settings.settings);
	projected.modelFavorites = settings.getModelFavoritesIncluding(refs);
	projected.enabledModels = [...refs];
	projected.localRuntimes = {
		...projected.localRuntimes,
		ollama: { ...projected.localRuntimes?.ollama, enabled: true },
	};
	projected.systemOne = { ...projected.systemOne, enabled: true };
	const memory = new InMemorySettingsStorage();
	memory.withLock("global", () => JSON.stringify(projected));
	return SettingsManager.fromStorage({
		withLock: (scope, fn) => memory.withLock(scope, fn),
		getProfilesDir: () => getProfilesDir(agentDir),
		getProfileResolutionBaseDir: () => cwd,
	});
}

/** A single staged owner; each failure remains visible and activation requires all gates. */
export async function setupLfm3(options: Lfm3SetupOptions): Promise<void> {
	const selected = options.model ? LFM3_MODELS.filter((item) => item.id === options.model) : [...LFM3_MODELS];
	if (!selected.length) throw new Error(`Unknown LFM3 model: ${options.model}`);
	const runtime = new OllamaRuntime({ agentDir: options.agentDir });
	const settings = SettingsManager.create(options.cwd, options.agentDir);
	const auth = AuthStorage.create(join(options.agentDir, "auth.json"));
	const registry = ModelRegistry.create(auth, join(options.agentDir, "models.json"));
	const access = systemOneAccessFromSession(
		{ getSystemOneSettings: () => ({ ...settings.getSystemOneSettings(), enabled: true }) },
		auth,
	);
	const manager = SessionManager.create(options.cwd, options.agentDir);
	options.log(`Fitness session ${manager.getSessionId()} in ${options.cwd}`);
	const reviewer = new SystemOneReviewer({
		access,
		usage: sessionSemanticUsageOf(manager),
		credentialBoundary: {
			getSensitiveValues: async () => registry.getKnownCredentialValues(),
			createSensitiveTextRedactor: (extra: readonly string[] = []) =>
				createCredentialTextRedactor([...registry.getKnownCredentialValues(), ...extra]),
			redactSensitiveText: (text: string, extra: readonly string[] = []) =>
				redactCredentialValues(text, [...registry.getKnownCredentialValues(), ...extra]),
		},
	});
	const adapter = new SystemOneJevAdapter(reviewer, createSystemOneConfig({ enabled: true }), {
		access,
		getUserKeys: () => access.keys(),
	});
	const evidence: { at: string; stages: unknown[]; activated: boolean } = {
		at: new Date().toISOString(),
		stages: [{ stage: "session", id: manager.getSessionId(), cwd: options.cwd, file: manager.getSessionFile() }],
		activated: false,
	};
	const path = stateFile(options.agentDir, "lfm3-setup.json");
	let previous: unknown[] = [];
	try {
		const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!saved || typeof saved !== "object") throw new Error("Invalid LFM3 setup evidence");
		if ("attempts" in saved && Array.isArray(saved.attempts)) previous = saved.attempts.slice(-9);
		else previous = [saved];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const persist = () => {
		writeFileAtomicSync(path, `${JSON.stringify({ attempts: [...previous, evidence] }, null, 2)}\n`, { mode: 0o600 });
	};
	const checkAbort = () => options.signal?.throwIfAborted();
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	const abortSession = () => {
		runtime.retainForOperation();
		session?.dispose();
	};
	options.signal?.addEventListener("abort", abortSession, { once: true });
	if (options.signal?.aborted) abortSession();
	const failures: unknown[] = [];
	try {
		checkAbort();
		manager.flushBufferedEntries();
		const readiness = await adapter.evaluate(
			{
				state: { value: "ready" },
				questions: {
					ready: {
						type: "choice",
						instructions: "What is the value in state.value?",
						criteria: { ready: "The value is ready.", other: "The value is not ready." },
					},
				},
			},
			{ signal: options.signal },
		);
		const ready = readiness.answers.ready;
		if (
			!ready ||
			typeof ready !== "object" ||
			!("choice" in ready) ||
			ready.choice !== "ready" ||
			!("confidence" in ready) ||
			typeof ready.confidence !== "number" ||
			ready.confidence < 0.9
		)
			throw new Error("System One readiness evaluation did not pass");
		evidence.stages.push({ stage: "system-one", model: readiness.model, ready: true });
		persist();
		let status = await runtime.detect();
		if (!status.binaryPath) {
			const installation = await runtime.installManaged(options.log, options.signal);
			if (!installation.ok) throw new Error(`Runtime installation: ${installation.error ?? "failed"}`);
			status = await runtime.detect();
		}
		if (status.serverUp && !status.managedByPi)
			throw new Error("An existing Ollama server is not owned by this setup; stop it before setup.");
		if (!status.serverUp) {
			const started = await runtime.start({ retainForOperation: true });
			if (!started.started) throw new Error(`Runtime start: ${started.reason}`);
		}
		status = await runtime.detect();
		if (!status.managedByPi || status.activeStore?.kind !== "pi-owned")
			throw new Error("Ollama ownership could not be established by this setup");
		let version = await runtime.version(options.signal);
		const minimum = LFM3_MINIMUM_OLLAMA_VERSION.split(".").map(Number);
		const supported = (value: string) => {
			const parts = /^(\d+)\.(\d+)\.(\d+)([-+].*)?$/.exec(value);
			if (!parts) return false;
			for (let i = 0; i < minimum.length; i++) {
				const number = Number(parts[i + 1]);
				if (number !== minimum[i]) return number > minimum[i]!;
			}
			return !parts[4]?.startsWith("-");
		};
		if (!supported(version)) {
			if (!(await runtime.stopAndWait()))
				throw new Error(
					`Ollama ${version} is below ${LFM3_MINIMUM_OLLAMA_VERSION} and the active server is not owned by this setup; stop or upgrade it before retrying.`,
				);
			checkAbort();
			const upgrade = await runtime.installManaged(options.log, options.signal);
			if (!upgrade.ok) throw new Error(`Ollama upgrade: ${upgrade.error ?? "failed"}`);
			checkAbort();
			const restarted = await runtime.start({ retainForOperation: true });
			if (!restarted.started) throw new Error(`Ollama restart: ${restarted.reason}`);
			status = await runtime.detect();
			if (!status.managedByPi || status.activeStore?.kind !== "pi-owned")
				throw new Error("Ollama ownership could not be established after restart");
			version = await runtime.version(options.signal);
			if (!supported(version))
				throw new Error(`Ollama ${version} is below required ${LFM3_MINIMUM_OLLAMA_VERSION} after upgrade`);
		}
		evidence.stages.push({ stage: "runtime", version });
		persist();
		const refs: string[] = [];
		for (const model of selected) {
			checkAbort();
			options.log(`Installing ${model.sourceRef}`);
			const result = await installOllamaModel({
				runtime,
				agentDir: options.agentDir,
				sourceRef: model.sourceRef,
				signal: options.signal,
				onProgress: options.log,
			});
			evidence.stages.push({ stage: "install", id: model.id, source: model.sourceRef, result });
			persist();
			if (!result.ok) throw new Error(`${model.id}: ${result.stage}: ${result.reason}`);
			refs.push(result.modelRef);
		}
		const resolveLocalModels = (requested: readonly string[] = refs) => {
			registry.refresh();
			return requested.map((ref) => {
				const model = registry.find("ollama", ref.slice("ollama/".length));
				if (!model) throw new Error(`Installed model ${ref} could not be resolved in the registry`);
				if (model.api !== "openai-completions" || model.baseUrl !== `${runtime.baseUrl}/v1`)
					throw new Error(`Installed model ${ref} does not resolve to the owned Ollama endpoint`);
				return model;
			});
		};
		const models = resolveLocalModels();
		const scoped = models.map((model) => ({ model: model! }));
		const fitnessSettings = createFitnessSettings(settings, refs, options.agentDir, options.cwd);
		const made = await createAgentSession({
			cwd: options.cwd,
			agentDir: options.agentDir,
			authStorage: auth,
			modelRegistry: registry,
			settingsManager: fitnessSettings,
			sessionManager: manager,
			model: scoped[0]!.model,
			isExplicitModel: true,
			scopedModels: scoped,
			routerPool: { source: "sdk_models", models: scoped },
			systemOneEnabled: true,
		});
		session = made.session;
		const trialPool = session.getRouterCandidatePool();
		if (
			trialPool.models.length !== refs.length ||
			trialPool.models.some((model) => !refs.includes(`${model.provider}/${model.id}`))
		) {
			throw new Error("Fitness session did not admit the exact local trial pool");
		}
		const media = new Lfm3MediaClient({ baseUrl: runtime.baseUrl });
		const successful: string[] = [];
		const summaryQualified: string[] = [];
		let allMediaReady = true;
		for (let i = 0; i < selected.length; i++) {
			checkAbort();
			const model = selected[i]!;
			const ref = refs[i]!;
			options.log(`Measuring ${ref}`);
			let outcome: Awaited<ReturnType<AgentSession["runModelFitness"]>> | undefined;
			let fitnessError: string | undefined;
			try {
				outcome = await session.runModelFitness({ model: ref, trials: options.trials });
				if (!outcome.started || outcome.model !== ref)
					fitnessError = outcome.started ? `resolved ${outcome.model}` : outcome.skipReason;
			} catch (error) {
				fitnessError = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
			}
			checkAbort();
			let tool: ToolProbeResult | undefined;
			let toolError: string | undefined;
			try {
				const tools = await session.probeToolCalling(ref);
				tool = tools.results.find((item) => item.model === ref);
				if (!tool) toolError = "Probe returned no result for the requested model";
			} catch (error) {
				toolError = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
			}
			checkAbort();
			const modalities: Lfm3FitnessModality[] = ["text"];
			if (model.modalities.includes("image")) modalities.push("vision");
			if (model.modalities.includes("audio")) modalities.push("transcription", "audio-understanding");
			if (model.modalities.includes("speech")) modalities.push("speech");
			if (model.id === "omni") modalities.push("omni");
			const mediaReport = await runLfm3ModalityFitness({
				client: media,
				model: ref.slice("ollama/".length),
				modalities,
				signal: options.signal,
				judge: async ({ criterion, evidence: output, signal }) => {
					const result = await adapter.evaluate(
						{
							state: { output },
							questions: {
								matches: {
									type: "choice",
									instructions: criterion,
									criteria: {
										yes: "The output satisfies the criterion.",
										no: "The output does not satisfy the criterion.",
									},
								},
							},
						},
						{ signal },
					);
					const answer = result.answers.matches;
					if (
						!answer ||
						typeof answer !== "object" ||
						!("choice" in answer) ||
						!("confidence" in answer) ||
						typeof answer.confidence !== "number"
					)
						throw new Error("System One did not return the requested judgment");
					return {
						pass: answer.choice === "yes",
						confidence: answer.confidence,
						explanation: `System One selected ${String(answer.choice)} with confidence ${answer.confidence}`,
					};
				},
			});
			const report = outcome?.started && outcome.model === ref ? outcome.report : undefined;
			const fitnessOk =
				!!report &&
				!fitnessError &&
				!isProbeAllFailed(report) &&
				(["router_cheap", "router_medium", "router_expensive", "executor"] as const).every(
					(surface) => evaluateSurfaceFitness(surface, report).fit,
				);
			const toolsOk = !toolError && toolExecutionFailure(tool) === undefined;
			const mediaOk = modalities.every((modality) =>
				mediaReport.results.some((result) => result.modality === modality && result.status === "pass"),
			);
			evidence.stages.push({
				stage: "fitness",
				id: model.id,
				ref,
				report,
				fitnessError,
				tool,
				toolError,
				media: mediaReport,
				fitnessOk,
				toolsOk,
				mediaOk,
			});
			persist();
			if (!mediaOk) allMediaReady = false;
			if (fitnessOk && toolsOk && mediaOk) {
				successful.push(ref);
				if (evaluateSurfaceFitness("compaction", report).fit) summaryQualified.push(ref);
			}
		}
		checkAbort();
		if (!allMediaReady)
			throw new Error(
				"Setup incomplete: one or more advertised media modalities did not pass; see status for evidence.",
			);
		if (options.activate) {
			if (successful.length === 0)
				throw new Error("Activation blocked: no model passed every general-agent fitness and tool gate.");
			if (summaryQualified.length === 0)
				throw new Error("Activation blocked: no general-agent model passed the compaction fitness gate.");
			const summarySettings = readContinuousChatSettings(settings);
			const resolveSummary = (ref: string) => {
				const model = resolveCliModel({ cliModel: ref, modelRegistry: registry }).model;
				return model && registry.hasConfiguredAuth(model) ? model : undefined;
			};
			const primary = summaryQualified.find(
				(ref) =>
					validateContinuousChatSummaryModel(
						{
							summaryModel: ref,
							thinkingLevel: summarySettings.thinkingLevel,
							allowExternalSummaryEgress: false,
						},
						{ resolveModel: resolveSummary },
					).ok,
			);
			if (!primary)
				throw new Error(
					`Activation blocked: no compaction-fit model supports the configured history summary thinking level ${summarySettings.thinkingLevel}.`,
				);
			successful.splice(successful.indexOf(primary), 1);
			successful.unshift(primary);
			await settings.activateLocalModelPool(successful, options.signal, (settings, candidate, projected) => {
				const scopedModels = resolveLocalModels(successful);
				const pool = resolveRouterCandidatePool({ source: "enabled_models", models: scopedModels }, registry, {
					favorites: candidate.modelFavorites ?? [],
				});
				if (
					pool.models.length !== successful.length ||
					pool.models.some((model) => !successful.includes(`${model.provider}/${model.id}`))
				)
					throw new Error("Verified local models are not all eligible in the router candidate pool");
				const requireQualifiedSummary = (setting: string, value: string): void => {
					const resolved = resolveCliModel({ cliModel: value, modelRegistry: registry }).model;
					if (
						!resolved ||
						!summaryQualified.includes(`${resolved.provider}/${resolved.id}`) ||
						resolved.api !== "openai-completions" ||
						resolved.baseUrl !== `${runtime.baseUrl}/v1`
					) {
						throw new Error(`${setting} resolves outside the qualified local agent pool: ${value}`);
					}
				};
				const effective = SettingsManager.inMemory(projected);
				const compaction = effective.getCompactionModel().trim();
				if (compaction && compaction !== "auto") requireQualifiedSummary("compaction.model", compaction);
				const history = effective.getMemoryHistorySettings();
				if (history.summaryModel) {
					requireQualifiedSummary("contextPolicy.memory.history.summaryModel", history.summaryModel);
				}
				const continuousChat = readContinuousChatSettings(effective);
				const validatedSummary = validateContinuousChatSummaryModel(continuousChat, {
					resolveModel: resolveSummary,
				});
				if (!validatedSummary.ok)
					throw new Error(`History summary model is not usable: ${validatedSummary.reason}`);
				const names = settings.getActiveResourceProfileNames();
				const profile = resolveProfileModelSettings({
					activeProfileNames: names,
					registry: settings.getProfileRegistry(),
					modelRegistry: registry,
					cwd: options.cwd,
				});
				if (
					profile.error ||
					(profile.model && !successful.includes(`${profile.model.provider}/${profile.model.id}`)) ||
					(profile.thinkingLevel && profile.thinkingLevel !== "off")
				) {
					throw new Error(
						`Active resource profile overrides the local model or thinking policy: ${profile.error ?? "conflicting model or thinking"}`,
					);
				}
				const pinPolicy = settings.getWorkerModelPinPolicy();
				if (pinPolicy.status === "invalid")
					throw new Error(`Invalid worker model pin policy: ${pinPolicy.diagnostics.join("; ")}`);
				if (
					pinPolicy.status === "active" &&
					Object.values(pinPolicy.byRole).some(
						(pin) =>
							pin &&
							(!successful.includes(`${pin.binding.provider}/${pin.binding.modelId}`) ||
								pin.binding.thinkingLevel !== "off"),
					)
				) {
					throw new Error(
						"Worker model pin policy selects a model outside the qualified local pool or non-off thinking",
					);
				}
				const orchestrationIds = new Set(
					[
						settings.getActiveOrchestrationProfile(),
						settings.getWorkerDelegationSettings().orchestrationProfile,
					].filter((id): id is string => !!id),
				);
				for (const orchestrationId of orchestrationIds) {
					const loaded = new OrchestrationProfileStore({
						agentDir: options.agentDir,
						cwd: options.cwd,
						projectTrusted: true,
					}).load();
					const orchestration = loaded.registry.get(orchestrationId);
					if (
						!orchestration ||
						orchestration.modelPolicy.candidates.some(
							(binding) =>
								!successful.includes(`${binding.provider}/${binding.modelId}`) ||
								binding.thinkingLevel !== "off",
						)
					) {
						throw new Error(
							`Active orchestration profile ${orchestrationId} may select a model outside the verified local pool or use non-off thinking`,
						);
					}
					for (const name of orchestration.resourceProfileNames) {
						const resource =
							name.startsWith("./") || name.startsWith("../")
								? settings.getProfileRegistry().resolveProfileRef(name, options.cwd)
								: settings.getProfileRegistry().getProfile(name);
						if (!resource) throw new Error(`Active orchestration resource profile ${name} could not be resolved`);
						const router = resource.modelRouter;
						if (
							router &&
							((router.enabled !== undefined && !router.enabled) ||
								(router.selectionMode !== undefined && router.selectionMode !== "auto") ||
								(router.fitnessGate !== undefined && !router.fitnessGate) ||
								[
									router.cheapThinking,
									router.mediumThinking,
									router.expensiveThinking,
									router.executorThinking,
								].some((level) => level !== undefined && level !== "off") ||
								[router.cheapModel, router.mediumModel, router.expensiveModel].some(
									(ref) => ref !== undefined && ref.trim() !== "",
								) ||
								[router.executorModel, router.learningModel].some(
									(ref) => ref !== undefined && ref !== successful[0],
								))
						) {
							throw new Error(
								`Active orchestration resource profile ${name} overrides the verified router configuration`,
							);
						}
					}
				}
			});
			evidence.activated = true;
			persist();
		}
		options.log(
			`${selected.length} model(s) media-ready; ${successful.length} qualified for the general-agent pool.`,
		);
	} catch (error) {
		failures.push(error);
		evidence.stages.push({ stage: "failure", error: error instanceof Error ? error.message : String(error) });
		try {
			persist();
		} catch (persistError) {
			failures.push(persistError);
		}
	} finally {
		runtime.retainForOperation();
		options.signal?.removeEventListener("abort", abortSession);
		for (const close of [() => session?.disposeAndWait(), () => runtime.stopAndWait()]) {
			try {
				await close();
			} catch (error) {
				failures.push(error);
				evidence.stages.push({
					stage: "cleanup-failure",
					error: (error instanceof Error ? error.message : String(error)).slice(0, 1024),
				});
			}
		}
	}
	if (options.signal?.aborted && failures.length === 0) {
		const error = options.signal.reason ?? new Error("Setup interrupted");
		failures.push(error);
		evidence.stages.push({ stage: "failure", error: error instanceof Error ? error.message : String(error) });
	}
	evidence.stages.push({ stage: "terminal", status: failures.length ? "failed" : "completed" });
	try {
		persist();
	} catch (error) {
		failures.push(error);
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1)
		throw new AggregateError(
			failures,
			`LFM3 setup and cleanup failed: ${failures.map((error) => (error instanceof Error ? error.message : String(error)).slice(0, 1024)).join("; ")}`,
		);
}
