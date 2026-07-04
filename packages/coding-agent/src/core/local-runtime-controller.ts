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

import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import type { AgentSessionEvent } from "./agent-session.ts";
import type { RouteDecision } from "./autonomy/contracts.ts";
import type { ExtensionUIContext } from "./extensions/index.ts";
import { OLLAMA_PROVIDER } from "./models/local-registration.ts";
import { type LocalRuntimeDeps, OllamaRuntime } from "./models/local-runtime.ts";

/** User-facing router tiers in ascending order — "learning" is never selected for a user turn, so
 * it has no place in the escalation ladder (#27's ensureRouteModelReady walks this forward only). */
const MODEL_ROUTER_TIER_ORDER: readonly ("cheap" | "medium" | "expensive")[] = ["cheap", "medium", "expensive"];

/** How long the #31 "install ollama now?" confirm waits before auto-dismissing (same as a "No") —
 * long enough to read and decide, short enough that an unattended session doesn't hang a turn on it. */
const OLLAMA_INSTALL_CONFIRM_TIMEOUT_MS = 30_000;

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
	/** Server URLs confirmed reachable THIS session — skips the health-check round trip on every
	 * local-routed turn once warm. Keyed the same way as _runtimes. */
	private readonly _confirmedUp = new Set<string>();

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

	/** models.json registers a local model's baseUrl as `<server>/v1` (OpenAI-compat); the runtime's
	 * own health/boot endpoints are on the Ollama-native server root. */
	deriveOllamaServerUrl(modelBaseUrl: string): string {
		return modelBaseUrl.replace(/\/v1\/?$/, "");
	}

	/**
	 * If the last assistant message in this session was an error from THIS exact local server, a
	 * cached "confirmed up" flag would be stale (the server may have died mid-session) — drop it so
	 * the next ensure-check is a real one instead of trusting stale state.
	 */
	private invalidateIfLastCallFailed(model: Model<Api>, serverUrl: string): void {
		const lastAssistant = this.deps.getLastAssistantMessage();
		if (
			lastAssistant?.stopReason === "error" &&
			lastAssistant.provider === OLLAMA_PROVIDER &&
			lastAssistant.model === model.id
		) {
			this._confirmedUp.delete(serverUrl);
		}
	}

	/**
	 * Ensure a routed model is actually reachable before the turn calls it. No-op (and free) for any
	 * non-local model — this only ever does network/process work for the `ollama` provider. Caches a
	 * "confirmed up this session" flag per server so a steady-state session pays the health-check
	 * round trip once, not on every turn; invalidated above when a prior local call actually failed,
	 * so a server that died mid-session gets re-detected rather than trusted forever. Boots via
	 * `startReuseExisting()` — never owned storage — so the turn sees the user's OWN pulled models,
	 * the same server `/models` commands and the user's own `ollama` CLI already talk to. Never
	 * installs anything itself (installGuide is GUIDE MODE: printed, never executed).
	 */
	async ensureLocalModelReady(
		model: Model<Api>,
	): Promise<{ ready: boolean; reason: string; installGuide?: string[] }> {
		if (model.provider !== OLLAMA_PROVIDER) {
			return { ready: true, reason: "not_local" };
		}
		const serverUrl = this.deriveOllamaServerUrl(model.baseUrl);
		this.invalidateIfLastCallFailed(model, serverUrl);
		if (this._confirmedUp.has(serverUrl)) {
			return { ready: true, reason: "confirmed_up_cached" };
		}
		const runtime = this.getLocalRuntime(serverUrl);
		const status = await runtime.detect();
		if (status.serverUp) {
			this._confirmedUp.add(serverUrl);
			return { ready: true, reason: "already_running" };
		}
		if (!status.binaryPath) {
			return { ready: false, reason: "binary_missing", installGuide: runtime.installGuide() };
		}
		const started = await runtime.startReuseExisting();
		if (started.started) {
			this._confirmedUp.add(serverUrl);
		}
		return { ready: started.started, reason: started.reason };
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
		while (current && current.model.provider === OLLAMA_PROVIDER) {
			let readiness: { ready: boolean; reason: string; installGuide?: string[]; installAttemptError?: string } =
				await this.ensureLocalModelReady(current.model);
			if (!readiness.ready) {
				readiness = await this.maybeInstallOllamaOnConsent(current.model, readiness);
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
			const whyText = readiness.installAttemptError
				? `pi tried to install it just now, but the install attempt failed: ${readiness.installAttemptError}`
				: readiness.installGuide
					? ["the ollama binary is not installed.", ...readiness.installGuide].join("\n")
					: `its server is not reachable (${readiness.reason}) — check that ollama is running.`;
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
