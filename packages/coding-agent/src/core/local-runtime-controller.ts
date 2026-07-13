/**
 * Local-runtime (Ollama) lifecycle controller.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Owns the cached, per-server
 * {@link OllamaRuntime} instances, the "confirmed up this session" flag, and the router's readiness
 * gate for a turn routed to a local (`ollama`) model — including the #31 install-on-consent flow and
 * the #27 graceful tier-escalation fallback. Takes narrow deps (agent dir, a last-assistant-message
 * accessor, the session's UI context/event emitter, and the router's own tier resolver) rather than
 * the whole AgentSession.
 */

import { totalmem } from "node:os";
import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import type { AgentSessionEvent } from "./agent-session.ts";
import type { RouteDecision } from "./autonomy/contracts.ts";
import type { ExtensionUIContext } from "./extensions/index.ts";
import { HF_TRANSFORMERS_PROVIDER, OLLAMA_PROVIDER } from "./models/local-registration.ts";
import {
	type LocalRuntimeDeps,
	OllamaRuntime,
	resolveTransformersBaseUrl,
	TransformersRuntime,
} from "./models/local-runtime.ts";
import { matchesInstalledLocalModel } from "./models/model-ref.ts";
import {
	OllamaRuntimeResidencyAdapter,
	type RuntimeEvictionRecord,
	type RuntimeResidencyAdapter,
	RuntimeResidencyArbiter,
	TransformersRuntimeResidencyAdapter,
} from "./models/runtime-arbiter.ts";

/** User-facing router tiers in ascending order — "learning" is never selected for a user turn, so
 * it has no place in the escalation ladder (#27's ensureRouteModelReady walks this forward only). */
const MODEL_ROUTER_TIER_ORDER: readonly ("cheap" | "medium" | "expensive")[] = ["cheap", "medium", "expensive"];

/** How long the #31 "install ollama now?" confirm waits before auto-dismissing (same as a "No") —
 * long enough to read and decide, short enough that an unattended session doesn't hang a turn on it. */
const OLLAMA_INSTALL_CONFIRM_TIMEOUT_MS = 30_000;

function parseWrongOllamaStoreReason(
	reason: string,
): { activePath: string; modelCount: number; ownedPath: string } | undefined {
	if (!reason.startsWith("wrong_store:")) return undefined;
	const parts = reason.slice("wrong_store:".length).split(":");
	if (parts.length < 3) return undefined;
	const [activePath, countText, ...ownedPathParts] = parts;
	const modelCount = Number(countText);
	return {
		activePath,
		modelCount: Number.isFinite(modelCount) ? modelCount : 0,
		ownedPath: ownedPathParts.join(":"),
	};
}

export interface LocalRuntimeControllerDeps {
	/** Root directory OllamaRuntime instances are scoped under — fixed for the session's lifetime. */
	agentDir: string;
	/** Test-injectable seams for OllamaRuntime's own fetch/spawn/exists calls; unset in production. */
	localRuntimeDeps?: LocalRuntimeDeps;
	/** The session's last assistant message, to detect a just-failed local call and drop a stale
	 * "confirmed up" flag. */
	getLastAssistantMessage(): AssistantMessage | undefined;
	/** The session's live interactive UI context, if any — undefined in headless/RPC/print modes. */
	getUIContext(): ExtensionUIContext | undefined;
	/** Emits a session event (only ever `warning` / `routing_start` / `routing_end` from this controller). */
	emit(event: AgentSessionEvent): void;
	/** Resolves the model configured for a router tier, respecting configured auth — owned by the
	 * router itself, not this controller. */
	resolveConfiguredTierModel(tier: "medium" | "expensive"): Model<Api> | undefined;
	/** `${provider}/${id}` label for a model, for warning/confirm text. */
	formatModel(model: Model<Api>): string;
}

export class LocalRuntimeController {
	/** Lazy, cached by baseUrl so the router path and any other caller share one instance per server. */
	private readonly _runtimes = new Map<string, OllamaRuntime>();
	/** Lazy, cached by model+baseUrl so the router and `/models` share one sidecar handle per HF model. */
	private readonly _transformersRuntimes = new Map<string, TransformersRuntime>();
	/** Server URLs confirmed reachable THIS session — skips the health-check round trip on every
	 * local-routed turn once warm. Keyed the same way as _runtimes. */
	private readonly _confirmedUp = new Set<string>();
	/** All live runtime adapters participate in one session-wide residency view. */
	private readonly _residencyAdapters = new Map<string, RuntimeResidencyAdapter>();
	private readonly _recentEvictions: RuntimeEvictionRecord[] = [];

	private readonly deps: LocalRuntimeControllerDeps;

	constructor(deps: LocalRuntimeControllerDeps) {
		this.deps = deps;
	}

	/**
	 * Shared {@link OllamaRuntime} for a given server, lazily created and cached by baseUrl so every
	 * caller — the router's readiness gate below and any host UI's own model-lifecycle commands
	 * (e.g. `/models`) — sees and can stop the SAME pi-managed process instead of each tracking its
	 * own untracked child.
	 */
	getLocalRuntime(baseUrl?: string): OllamaRuntime {
		const key = baseUrl ?? "default";
		let runtime = this._runtimes.get(key);
		if (!runtime) {
			runtime = new OllamaRuntime({ agentDir: this.deps.agentDir, baseUrl, deps: this.deps.localRuntimeDeps });
			this._runtimes.set(key, runtime);
		}
		return runtime;
	}

	getTransformersRuntime(modelId: string, baseUrl?: string): TransformersRuntime {
		const resolvedBaseUrl = baseUrl?.replace(/\/$/, "") ?? resolveTransformersBaseUrl(modelId);
		const key = `${modelId}\0${resolvedBaseUrl}`;
		let runtime = this._transformersRuntimes.get(key);
		if (!runtime) {
			runtime = new TransformersRuntime({
				agentDir: this.deps.agentDir,
				modelId,
				baseUrl: resolvedBaseUrl,
				deps: this.deps.localRuntimeDeps,
			});
			this._transformersRuntimes.set(key, runtime);
		}
		return runtime;
	}

	/** models.json registers a local model's baseUrl as `<server>/v1` (OpenAI-compat); the runtime's
	 * own health/boot endpoints are on the Ollama-native server root. */
	deriveOllamaServerUrl(modelBaseUrl: string): string {
		return modelBaseUrl.replace(/\/v1\/?$/, "");
	}

	private deriveOpenAICompatServerUrl(modelBaseUrl: string): string {
		return modelBaseUrl.replace(/\/v1\/?$/, "");
	}

	private isManagedLocalProvider(provider: string): boolean {
		return provider === OLLAMA_PROVIDER || provider === HF_TRANSFORMERS_PROVIDER;
	}

	/**
	 * If the last assistant message in this session was an error from THIS exact local server, a
	 * cached "confirmed up" flag would be stale (the server may have died mid-session) — drop it so
	 * the next ensure-check is a real one instead of trusting stale state.
	 */
	private confirmationKey(model: Model<Api>, serverUrl: string): string {
		return model.provider === HF_TRANSFORMERS_PROVIDER ? `${serverUrl}\0${model.id}` : serverUrl;
	}

	private invalidateIfLastCallFailed(model: Model<Api>, serverUrl: string): void {
		const lastAssistant = this.deps.getLastAssistantMessage();
		if (
			lastAssistant?.stopReason === "error" &&
			lastAssistant.provider === model.provider &&
			lastAssistant.model === model.id
		) {
			this._confirmedUp.delete(this.confirmationKey(model, serverUrl));
		}
	}

	private async ensureOllamaResident(
		model: Model<Api>,
		runtime: OllamaRuntime,
		knownSizeBytes?: number,
	): Promise<{ ok: boolean; reason?: string }> {
		let bytes = knownSizeBytes ?? 0;
		if (knownSizeBytes === undefined) {
			try {
				const installed = await runtime.list();
				bytes = installed.find((entry) => matchesInstalledLocalModel(model.id, entry.name))?.sizeBytes ?? 0;
			} catch {
				// Residency is best-effort; a list failure falls back to a zero-byte admission request.
			}
		}
		const serverUrl = this.deriveOllamaServerUrl(model.baseUrl);
		const adapterId = `ollama:${serverUrl}`;
		this._residencyAdapters.set(adapterId, new OllamaRuntimeResidencyAdapter(adapterId, runtime));
		const arbiter = this.createResidencyArbiter();
		try {
			const nowMs = Date.now();
			const plan = await arbiter.ensureResident(adapterId, {
				model: model.id,
				bytes,
				role: "active",
				priority: 100,
				nowMs,
				pinActiveModel: model.id,
				recentEvictions: this._recentEvictions,
				// Cold Ollama loads can legitimately take several minutes. The actual adaptive stream
				// owns that wait; readiness must not front-run it with a 60-second empty generation.
				loadModel: false,
			});
			this.recordEvictions(plan.evict, model.id, nowMs, adapterId);
			return plan.status === "fits" ? { ok: true } : { ok: false, reason: `residency_refused:${plan.reason}` };
		} catch (error) {
			return { ok: false, reason: `residency_error:${error instanceof Error ? error.message : String(error)}` };
		}
	}

	private async ensureTransformersResident(
		model: Model<Api>,
		runtime: TransformersRuntime,
	): Promise<{ ok: boolean; reason?: string }> {
		const serverUrl = this.deriveOpenAICompatServerUrl(model.baseUrl);
		const adapterId = `transformers:${model.id}:${serverUrl}`;
		this._residencyAdapters.set(adapterId, new TransformersRuntimeResidencyAdapter(adapterId, runtime, model.id, 0));
		const arbiter = this.createResidencyArbiter();
		try {
			const nowMs = Date.now();
			const plan = await arbiter.ensureResident(adapterId, {
				model: model.id,
				bytes: 0,
				role: "active",
				priority: 100,
				nowMs,
				pinActiveModel: model.id,
				recentEvictions: this._recentEvictions,
				loadModel: false,
			});
			this.recordEvictions(plan.evict, model.id, nowMs, adapterId);
			return plan.status === "fits" ? { ok: true } : { ok: false, reason: `residency_refused:${plan.reason}` };
		} catch (error) {
			return { ok: false, reason: `residency_error:${error instanceof Error ? error.message : String(error)}` };
		}
	}

	private createResidencyArbiter(): RuntimeResidencyArbiter {
		return new RuntimeResidencyArbiter({
			budgetBytes: Math.floor(totalmem() * 0.85),
			adapters: [...this._residencyAdapters.values()],
		});
	}

	private recordEvictions(
		evicted: readonly { adapterId: string; model: string }[],
		loaded: string,
		atMs: number,
		loadedAdapterId: string,
	): void {
		for (const resident of evicted) {
			this._recentEvictions.push({
				evicted: resident.model,
				loaded,
				atMs,
				evictedAdapterId: resident.adapterId,
				loadedAdapterId,
			});
		}
		const cutoff = atMs - 5 * 60_000;
		while (this._recentEvictions[0]?.atMs < cutoff) this._recentEvictions.shift();
	}

	/**
	 * Readiness gate for every isolated/background completion. Unlike the foreground route gate it
	 * never prompts or changes tiers: lanes either use the configured model or fail visibly.
	 */
	async ensureIsolatedModelReady(model: Model<Api>): Promise<void> {
		if (!this.isManagedLocalProvider(model.provider)) return;
		const readiness =
			model.provider === OLLAMA_PROVIDER
				? await this.ensureLocalModelReady(model)
				: await this.ensureTransformersModelReady(model);
		if (readiness.ready) return;
		const guide = readiness.installGuide?.length ? `\n${readiness.installGuide.join("\n")}` : "";
		throw new Error(
			`Managed local model ${this.deps.formatModel(model)} is unavailable for isolated execution (${readiness.reason}).${guide}`,
		);
	}

	/**
	 * Readiness gate for a manually selected/default foreground model when no router route owns the
	 * turn. Interactive sessions may offer the same managed-install consent as routed turns; the
	 * selected model is never silently replaced.
	 */
	async ensureForegroundModelReady(model: Model<Api>): Promise<void> {
		if (!this.isManagedLocalProvider(model.provider)) return;
		let readiness: {
			ready: boolean;
			reason: string;
			installGuide?: string[];
			installAttemptError?: string;
		} =
			model.provider === OLLAMA_PROVIDER
				? await this.ensureLocalModelReady(model)
				: await this.ensureTransformersModelReady(model);
		if (!readiness.ready) {
			readiness =
				model.provider === OLLAMA_PROVIDER
					? await this.maybeInstallOllamaOnConsent(model, readiness)
					: await this.maybeInstallTransformersOnConsent(model, readiness);
		}
		if (readiness.ready) return;
		const detail = readiness.installAttemptError ?? readiness.installGuide?.join("\n") ?? readiness.reason;
		throw new Error(`Managed local model ${this.deps.formatModel(model)} is unavailable: ${detail}`);
	}

	/**
	 * Ensure a routed managed-local model is actually reachable before the turn calls it. No-op (and
	 * free) for non-local/API models. Caches a "confirmed up this session" flag per server (and per
	 * Transformers model) so steady-state routing pays the health-check round trip once; invalidated
	 * above when a prior local call failed so a dead sidecar gets re-detected instead of trusted.
	 */
	async ensureLocalModelReady(
		model: Model<Api>,
	): Promise<{ ready: boolean; reason: string; installGuide?: string[] }> {
		if (model.provider !== OLLAMA_PROVIDER) {
			return { ready: true, reason: "not_local" };
		}
		const serverUrl = this.deriveOllamaServerUrl(model.baseUrl);
		const confirmedKey = this.confirmationKey(model, serverUrl);
		this.invalidateIfLastCallFailed(model, serverUrl);
		if (this._confirmedUp.has(confirmedKey)) {
			return { ready: true, reason: "confirmed_up_cached" };
		}
		const runtime = this.getLocalRuntime(serverUrl);
		const status = await runtime.detect();
		if (status.serverUp) {
			// Server ownership is not a capability boundary. Reuse a configured user/system server
			// when it exposes the requested model; this preserves its accelerator settings and warm
			// cache instead of forcing a slower duplicate Pi-owned process/store.
			const installedEntry = status.serverModels.find((entry) => matchesInstalledLocalModel(model.id, entry.name));
			if (!installedEntry) {
				return {
					ready: false,
					reason: `model_missing_on_server:${model.id}:${status.activeStore?.path ?? "external/unknown"}`,
				};
			}
			const resident = await this.ensureOllamaResident(model, runtime, installedEntry.sizeBytes);
			if (!resident.ok) return { ready: false, reason: resident.reason ?? "residency_refused" };
			this._confirmedUp.add(confirmedKey);
			return {
				ready: true,
				reason: status.managedByPi ? "already_running_managed" : "already_running_configured_server",
			};
		}
		if (!status.binaryPath) {
			return { ready: false, reason: "binary_missing", installGuide: runtime.installGuide() };
		}
		const started = await runtime.start();
		if (started.started) {
			let installedEntry: { name: string; sizeBytes: number } | undefined;
			try {
				const installed = await runtime.list();
				installedEntry = installed.find((entry) => matchesInstalledLocalModel(model.id, entry.name));
			} catch (error) {
				runtime.stop();
				return {
					ready: false,
					reason: `model_list_failed_after_start:${error instanceof Error ? error.message : String(error)}`,
				};
			}
			if (!installedEntry) {
				runtime.stop();
				return { ready: false, reason: `model_missing_on_started_server:${model.id}` };
			}
			const resident = await this.ensureOllamaResident(model, runtime, installedEntry.sizeBytes);
			if (!resident.ok) {
				runtime.stop();
				return { ready: false, reason: resident.reason ?? "residency_refused" };
			}
			this._confirmedUp.add(confirmedKey);
		}
		return { ready: started.started, reason: started.reason };
	}

	async ensureTransformersModelReady(
		model: Model<Api>,
	): Promise<{ ready: boolean; reason: string; installGuide?: string[] }> {
		if (model.provider !== HF_TRANSFORMERS_PROVIDER) {
			return { ready: true, reason: "not_transformers" };
		}
		const serverUrl = this.deriveOpenAICompatServerUrl(model.baseUrl);
		const confirmedKey = this.confirmationKey(model, serverUrl);
		this.invalidateIfLastCallFailed(model, serverUrl);
		if (this._confirmedUp.has(confirmedKey)) {
			return { ready: true, reason: "confirmed_up_cached" };
		}
		const runtime = this.getTransformersRuntime(model.id, serverUrl);
		const status = await runtime.detect();
		if (status.serverUp) {
			const resident = await this.ensureTransformersResident(model, runtime);
			if (!resident.ok) return { ready: false, reason: resident.reason ?? "residency_refused" };
			this._confirmedUp.add(confirmedKey);
			return { ready: true, reason: "already_running" };
		}
		if (!status.runtimeInstalled) {
			return { ready: false, reason: "runtime_missing", installGuide: runtime.installGuide() };
		}
		const started = await runtime.start();
		if (started.started || started.reason === "already_running") {
			const resident = await this.ensureTransformersResident(model, runtime);
			if (!resident.ok) return { ready: false, reason: resident.reason ?? "residency_refused" };
			this._confirmedUp.add(confirmedKey);
			return { ready: true, reason: started.reason };
		}
		return { ready: false, reason: started.reason };
	}

	/**
	 * #31: the ONE case a routed local model's unreadiness can be fixed automatically is a missing
	 * ollama binary — an unreachable server can't be helped by installing, so that reason is left to
	 * the graceful-fallback warning below unchanged. Only offered when there's an interactive UI to
	 * ask through: headless/RPC/print sessions have no UI context and fall straight through, same as
	 * declining or timing out (both resolve confirm() to false). Reverses "pi never runs installers
	 * itself" specifically for this one path — the user is asked first, the download is pi's own
	 * (never curl|sh), and it lands in pi's own runtimes dir (see OllamaRuntime.installManaged).
	 *
	 * Pauses/resumes the routing working-indicator around the confirm dialog itself (re-emitting
	 * routing_end/routing_start — both already idempotent, see interactive-mode.ts's handlers) so an
	 * animated spinner doesn't fight a dialog the user is trying to read and answer; the indicator
	 * comes back for the download/extract that follows a "yes", which is genuine processing feedback.
	 */
	private async maybeInstallOllamaOnConsent(
		model: Model<Api>,
		readiness: { ready: boolean; reason: string; installGuide?: string[] },
	): Promise<{ ready: boolean; reason: string; installGuide?: string[]; installAttemptError?: string }> {
		const ui = this.deps.getUIContext();
		if (!ui || readiness.ready || readiness.reason !== "binary_missing") return readiness;

		const modelLabel = this.deps.formatModel(model);
		this.deps.emit({ type: "routing_end" });
		let confirmed: boolean;
		try {
			confirmed = await ui.confirm(
				"Install Ollama?",
				`Ollama isn't installed, so the local model "${modelLabel}" can't run. Pi can download and ` +
					"install it now (a large one-time download, possibly over 1 GB depending on your platform) " +
					"into its own runtimes folder — never curl|sh, never touching anything outside pi's own " +
					"directory. Install it now?",
				{ timeout: OLLAMA_INSTALL_CONFIRM_TIMEOUT_MS },
			);
		} finally {
			this.deps.emit({ type: "routing_start" });
		}
		if (!confirmed) return readiness;

		const serverUrl = this.deriveOllamaServerUrl(model.baseUrl);
		const runtime = this.getLocalRuntime(serverUrl);
		let installResult: { ok: boolean; error?: string };
		try {
			installResult = await runtime.installManaged((status) => ui.setStatus("ollama-install", status));
		} finally {
			ui.setStatus("ollama-install", undefined);
		}
		if (!installResult.ok) {
			return { ready: false, reason: "install_failed", installAttemptError: installResult.error };
		}
		return this.ensureLocalModelReady(model);
	}

	private async maybeInstallTransformersOnConsent(
		model: Model<Api>,
		readiness: { ready: boolean; reason: string; installGuide?: string[] },
	): Promise<{ ready: boolean; reason: string; installGuide?: string[]; installAttemptError?: string }> {
		const ui = this.deps.getUIContext();
		if (!ui || readiness.ready || readiness.reason !== "runtime_missing") return readiness;

		const modelLabel = this.deps.formatModel(model);
		this.deps.emit({ type: "routing_end" });
		let confirmed: boolean;
		try {
			confirmed = await ui.confirm(
				"Install Transformers runtime?",
				`The Hugging Face model "${modelLabel}" needs a pi-managed Python venv with Transformers ` +
					"and CPU PyTorch before it can run. Pi will install those packages into its own runtimes " +
					"folder, download the model into a pi-owned Hugging Face cache, and leave system Python, " +
					"your Ollama models, and your user HF cache untouched. Install it now?",
				{ timeout: OLLAMA_INSTALL_CONFIRM_TIMEOUT_MS },
			);
		} finally {
			this.deps.emit({ type: "routing_start" });
		}
		if (!confirmed) return readiness;

		const serverUrl = this.deriveOpenAICompatServerUrl(model.baseUrl);
		const runtime = this.getTransformersRuntime(model.id, serverUrl);
		let installResult: { ok: boolean; error?: string };
		try {
			installResult = await runtime.installManaged((status) => ui.setStatus("transformers-install", status));
		} finally {
			ui.setStatus("transformers-install", undefined);
		}
		if (!installResult.ok) {
			return { ready: false, reason: "install_failed", installAttemptError: installResult.error };
		}
		let downloadResult: { ok: boolean; error?: string };
		try {
			downloadResult = await runtime.downloadModel((status) => ui.setStatus("transformers-download", status));
		} finally {
			ui.setStatus("transformers-download", undefined);
		}
		if (!downloadResult.ok) {
			return { ready: false, reason: "download_failed", installAttemptError: downloadResult.error };
		}
		return this.ensureTransformersModelReady(model);
	}

	/**
	 * Router-swap gate (#27): a turn routed to a local model (any tier, including an executor-direct
	 * route — both carry tier "cheap") must not dead-end the turn just because ollama isn't up.
	 * Never a SILENT swap: every fallback is announced in a warning that states (i) the local model
	 * was unavailable and WHY — binary missing surfaces the install guide inline; any other reason
	 * gets a "check that ollama is running" hint — and (ii) which tier is now handling the turn, so
	 * the cost shift is never a surprise. Escalates cheap -> medium -> expensive, skipping any
	 * unconfigured intermediate tier, reusing the router's own existing "model unavailable"
	 * resolution (resolveConfiguredTierModel) rather than inventing a new fallback mechanism.
	 * Escalation is bounded: tier strictly increases each hop, so it terminates within two hops.
	 *
	 * Before the warning/escalation below: #31's consent gate gets one shot at fixing a missing
	 * binary interactively (see maybeInstallOllamaOnConsent) — declining, timing out, running
	 * headless, or the install attempt itself failing all fall through here unchanged, just with an
	 * honest reason (an install that failed is worded as a failed install, not re-labeled as if
	 * nothing was ever tried).
	 */
	async ensureRouteModelReady(
		resolved: { decision: RouteDecision; model: Model<Api> } | undefined,
	): Promise<{ decision: RouteDecision; model: Model<Api> } | undefined> {
		let current = resolved;
		while (current && this.isManagedLocalProvider(current.model.provider)) {
			let readiness: { ready: boolean; reason: string; installGuide?: string[]; installAttemptError?: string } =
				current.model.provider === OLLAMA_PROVIDER
					? await this.ensureLocalModelReady(current.model)
					: await this.ensureTransformersModelReady(current.model);
			if (!readiness.ready) {
				readiness =
					current.model.provider === OLLAMA_PROVIDER
						? await this.maybeInstallOllamaOnConsent(current.model, readiness)
						: await this.maybeInstallTransformersOnConsent(current.model, readiness);
			}
			if (readiness.ready) return current;

			// Walk the remaining tiers in order (never back down to cheap) and take the first one that
			// actually resolves — an unconfigured intermediate tier (e.g. no mediumModel set) must be
			// skipped, not treated as "no fallback available".
			const startIndex = MODEL_ROUTER_TIER_ORDER.indexOf(current.decision.tier as "cheap" | "medium" | "expensive");
			let escalated: { tier: "medium" | "expensive"; model: Model<Api> } | undefined;
			for (let i = startIndex + 1; startIndex !== -1 && i < MODEL_ROUTER_TIER_ORDER.length; i++) {
				const tier = MODEL_ROUTER_TIER_ORDER[i] as "medium" | "expensive";
				const model = this.deps.resolveConfiguredTierModel(tier);
				if (model) {
					escalated = { tier, model };
					break;
				}
			}

			const modelLabel = this.deps.formatModel(current.model);
			const localRuntimeName = current.model.provider === OLLAMA_PROVIDER ? "ollama" : "Transformers";
			const wrongStore = parseWrongOllamaStoreReason(readiness.reason);
			const whyText = readiness.installAttemptError
				? `pi tried to install it just now, but the install attempt failed: ${readiness.installAttemptError}`
				: readiness.installGuide
					? [
							current.model.provider === OLLAMA_PROVIDER
								? "the ollama binary is not installed."
								: "the pi-managed Transformers runtime is not installed.",
							...readiness.installGuide,
						].join("\n")
					: wrongStore
						? `an Ollama server is already running with store ${wrongStore.activePath} (${wrongStore.modelCount} model(s)); pi's owned store is ${wrongStore.ownedPath}. Stop the other server or run /models import, then retry.`
						: current.model.provider === OLLAMA_PROVIDER
							? `its ${localRuntimeName} server is not reachable (${readiness.reason}) — check that ollama is running.`
							: `its ${localRuntimeName} server is not reachable (${readiness.reason}) — check that the runtime is running.`;
			const fallbackText = escalated
				? `Falling back to the ${escalated.tier} tier for this turn.`
				: "No other tier is configured — falling back to the session's default model.";
			this.deps.emit({
				type: "warning",
				message: `Local model "${modelLabel}" is unavailable: ${whyText}\n${fallbackText}`,
			});

			if (!escalated) return undefined; // no higher tier resolves — caller falls back to the session default
			current = {
				model: escalated.model,
				decision: {
					...current.decision,
					tier: escalated.tier,
					fallbackFrom: current.decision.tier,
					reasonCode: "local_model_not_ready_fallback",
					reasons: [
						...current.decision.reasons,
						`Local model not ready (${readiness.reason}); escalated to ${escalated.tier}`,
					],
					model: this.deps.formatModel(escalated.model),
				},
			};
		}
		return current;
	}
}
