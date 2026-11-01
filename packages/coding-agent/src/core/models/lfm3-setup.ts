import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "../../kernel/session/session-manager.ts";
import { stateFile } from "../agent-paths.ts";
import { AuthStorage } from "../auth-storage.ts";
import { sessionSemanticUsageOf } from "../cost/semantic-usage-delivery.ts";
import { ModelRegistry } from "../model-registry.ts";
import { resolveProfileModelSettings } from "../model-resolver.ts";
import { evaluateSurfaceFitness } from "../model-router/fitness-gate.ts";
import { OrchestrationProfileStore } from "../orchestration/profile-store.ts";
import { type Lfm3FitnessModality, runLfm3ModalityFitness } from "../research/lfm3-modality-fitness.ts";
import { isProbeAllFailed } from "../research/model-fitness.ts";
import { SystemOneReviewer } from "../review/typesafe-reviewer.ts";
import { createAgentSession } from "../sdk.ts";
import { createCredentialTextRedactor, redactCredentialValues } from "../secrets/credential-manager.ts";
import { SettingsManager } from "../settings-manager.ts";
import { systemOneAccessFromSession } from "../system-one/access.ts";
import { SystemOneJevAdapter } from "../system-one/adapter.ts";
import { createSystemOneConfig } from "../system-one/config.ts";
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

/** A single staged owner; each failure remains visible and activation requires all gates. */
export async function setupLfm3(options: Lfm3SetupOptions): Promise<void> {
	const selected = options.model ? LFM3_MODELS.filter((item) => item.id === options.model) : [...LFM3_MODELS];
	if (!selected.length) throw new Error(`Unknown LFM3 model: ${options.model}`);
	const runtime = new OllamaRuntime({ agentDir: options.agentDir });
	const settings = SettingsManager.create(options.cwd, options.agentDir);
	const auth = AuthStorage.create(join(options.agentDir, "auth.json"));
	const registry = ModelRegistry.create(auth, join(options.agentDir, "models.json"));
	const access = systemOneAccessFromSession(settings, auth);
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
		runtime.retainForShutdown();
		session?.dispose();
	};
	options.signal?.addEventListener("abort", abortSession, { once: true });
	if (options.signal?.aborted) abortSession();
	const failures: unknown[] = [];
	try {
		checkAbort();
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
			const started = await runtime.start();
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
			const restarted = await runtime.start();
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
		const resolveLocalModels = () => {
			registry.refresh();
			return refs.map((ref) => {
				const model = registry.find("ollama", ref.slice("ollama/".length));
				if (!model) throw new Error(`Installed model ${ref} could not be resolved in the registry`);
				if (model.api !== "openai-completions" || model.baseUrl !== `${runtime.baseUrl}/v1`)
					throw new Error(`Installed model ${ref} does not resolve to the owned Ollama endpoint`);
				return model;
			});
		};
		const models = resolveLocalModels();
		const scoped = models.map((model) => ({ model: model! }));
		const made = await createAgentSession({
			cwd: options.cwd,
			agentDir: options.agentDir,
			authStorage: auth,
			modelRegistry: registry,
			settingsManager: settings,
			sessionManager: manager,
			model: scoped[0]!.model,
			isExplicitModel: true,
			scopedModels: scoped,
			routerPool: { source: "sdk_models", models: scoped },
			systemOneEnabled: true,
		});
		session = made.session;
		const media = new Lfm3MediaClient({ baseUrl: runtime.baseUrl });
		const successful: string[] = [];
		for (let i = 0; i < selected.length; i++) {
			checkAbort();
			const model = selected[i]!;
			const ref = refs[i]!;
			options.log(`Measuring ${ref}`);
			const outcome = await session.runModelFitness({ model: ref, trials: options.trials });
			if (!outcome.started || outcome.model !== ref)
				throw new Error(
					`Fitness did not run for ${ref}: ${outcome.started ? `resolved ${outcome.model}` : outcome.skipReason}`,
				);
			checkAbort();
			const tools = await session.probeToolCalling(ref);
			checkAbort();
			const tool = tools.results.find((item) => item.model === ref);
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
			const fitnessOk =
				!isProbeAllFailed(outcome.report) &&
				(["router_cheap", "router_medium", "router_expensive", "executor"] as const).every(
					(surface) => evaluateSurfaceFitness(surface, outcome.report).fit,
				);
			const toolsOk = toolExecutionFailure(tool) === undefined;
			const mediaOk = mediaReport.results
				.filter((result) => modalities.includes(result.modality))
				.every((result) => result.status === "pass");
			evidence.stages.push({
				stage: "fitness",
				id: model.id,
				ref,
				report: outcome.report,
				tool,
				media: mediaReport,
				fitnessOk,
				toolsOk,
				mediaOk,
			});
			persist();
			if (fitnessOk && toolsOk && mediaOk) successful.push(ref);
		}
		checkAbort();
		if (options.activate) {
			if (successful.length !== selected.length)
				throw new Error("Activation blocked: one or more models did not pass every required gate.");
			await settings.activateLocalModelPool(successful, options.signal, (settings) => {
				resolveLocalModels();
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
				const orchestrationId = settings.getActiveOrchestrationProfile();
				if (orchestrationId) {
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
								(router.selectionMode !== undefined && router.selectionMode !== "manual") ||
								(router.fitnessGate !== undefined && !router.fitnessGate) ||
								[
									router.cheapThinking,
									router.mediumThinking,
									router.expensiveThinking,
									router.executorThinking,
								].some((level) => level !== undefined && level !== "off") ||
								[
									router.cheapModel,
									router.mediumModel,
									router.expensiveModel,
									router.executorModel,
									router.learningModel,
								].some((ref) => ref !== undefined && ref !== successful[0]))
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
		if (successful.length !== selected.length)
			throw new Error("Setup completed with failed fitness gates; see status for evidence.");
	} catch (error) {
		failures.push(error);
		evidence.stages.push({ stage: "failure", error: error instanceof Error ? error.message : String(error) });
		try {
			persist();
		} catch (persistError) {
			failures.push(persistError);
		}
	} finally {
		runtime.retainForShutdown();
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
