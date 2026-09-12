import type { StreamFn } from "@caupulican/pi-agent-core";
import { type StreamIdleOptions, withStreamIdleWatchdog } from "@caupulican/pi-agent-core/reliability";
import type { SessionManager } from "@caupulican/pi-agent-core/session";
import { streamSimple } from "@caupulican/pi-ai/stream";
import type { AuthCredential } from "./auth-storage.ts";
import { constrainStreamIdleToHttpTimeout } from "./http-dispatcher.ts";
import { isWarmableLocalModel } from "./local-prefix-warm-controller.ts";
import { formatModelRouterModel } from "./model-router-controller.ts";
import type { ModelAdaptationStore } from "./models/adaptation-store.ts";
import {
	DEFAULT_ADAPTIVE_STREAM_IDLE_CEILING_MS,
	estimateContextPromptTokens,
	resolveAdaptiveStreamIdleOptions,
	withModelPerfProfile,
} from "./models/perf-profile.ts";
import { resolveProviderAccountKey } from "./provider-admission/account-key.ts";
import { isEmergencyStopEngaged } from "./provider-admission/emergency-stop.ts";
import {
	PROVIDER_ADMISSION_CUSTOM_TYPE,
	type ProviderAdmissionWaitEvent,
	withProviderAdmission,
} from "./provider-admission/gate.ts";
import type { ProviderAdmissionLedger } from "./provider-admission/ledger.ts";
import type { ProviderLimitStore } from "./provider-admission/limit-state.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { resolveStreamStallBudget } from "./stream-stall-budget.ts";

/**
 * The session's provider stream chain, innermost first:
 *
 *  1. perf profile: one sample per provider stream (request-to-first-token, stalls);
 *  2. idle watchdog: a silently dead connection is aborted and surfaced as a retryable stall;
 *  3. machine-wide admission: every lane honours a recorded provider limit (a 429 or exhausted
 *     window another process saw), worker and background lanes wait at a provider's configured
 *     in-flight limit and while the emergency stop is engaged; the owner's foreground lane is never
 *     held for capacity or the stop.
 *
 * Admission sits OUTSIDE the watchdog and the profiler on purpose: time spent waiting for a
 * shared-account slot is neither a connect stall nor the model's time to first token. The chain
 * is built once per session and installed exactly once; wrapping breaks the
 * `streamFn === streamSimple` identity the auth-injection checks use, so the result carries a
 * rawness marker (`isRawStreamSimpleFn`) that records whether the base was the raw provider entry.
 */

const RAW_STREAM_MARKER = Symbol.for("pi.rawStreamSimple");

/**
 * True when `fn` is the raw `streamSimple` provider entry, directly or as the base this chain
 * wrapped. Callers use it to decide whether request auth must be injected explicitly.
 */
export function isRawStreamSimpleFn(fn: StreamFn): boolean {
	return fn === streamSimple || (fn as { [RAW_STREAM_MARKER]?: boolean })[RAW_STREAM_MARKER] === true;
}

export interface SessionStreamChainInput {
	baseStreamFn: StreamFn;
	settingsManager: SettingsManager;
	sessionManager: SessionManager;
	modelAdaptationStore: ModelAdaptationStore;
	providerAdmissionLedger: ProviderAdmissionLedger;
	providerLimitStore: ProviderLimitStore;
	/** The agent directory whose ESTOP sentinel pauses new worker and background requests. */
	agentDir: string;
	/** Credentials, so limits and in-flight counts key on provider plus account (see account-key.ts). */
	authStorage: { get(provider: string): AuthCredential | undefined };
	/** Live wait notifications for the operator's activity lane. */
	onWait?: (event: ProviderAdmissionWaitEvent) => void;
	/** The output repetition guard's threshold follows the model's capability tier. */
	getRepetitionGuardRepeats: () => number;
	/** Test-only stream-idle override, read per request (see `setStreamIdleOptionsForTests`). */
	getStreamIdleOptionsOverride: () => Partial<StreamIdleOptions> | undefined;
}

export function buildSessionStreamFn(input: SessionStreamChainInput): StreamFn {
	const { baseStreamFn, settingsManager, sessionManager, modelAdaptationStore, providerAdmissionLedger } = input;
	const profiled = withModelPerfProfile(baseStreamFn, {
		modelKey: (model) => formatModelRouterModel(model),
		recordSample: (modelKey, sample) => {
			modelAdaptationStore.recordPerfSample(modelKey, sample);
		},
	});
	const watched = withStreamIdleWatchdog(profiled, (model, context) => {
		const configured = {
			// Local/managed models and cloud providers draw on separate budgets; see resolveStreamStallBudget.
			...resolveStreamStallBudget(model, settingsManager).base,
			outputRepetitionRepeats: input.getRepetitionGuardRepeats(),
			...input.getStreamIdleOptionsOverride(),
		};
		const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
		const httpBounded = constrainStreamIdleToHttpTimeout(configured, httpIdleTimeoutMs);
		const profile = modelAdaptationStore.get(formatModelRouterModel(model)).perf;
		const adaptive = resolveAdaptiveStreamIdleOptions({
			base: httpBounded.options,
			profile,
			promptTokens: estimateContextPromptTokens(context),
			localClass: isWarmableLocalModel(model),
			provider: model.provider,
			ceilingMs: httpBounded.adaptiveCeilingMs ?? DEFAULT_ADAPTIVE_STREAM_IDLE_CEILING_MS,
		});
		return { ...httpBounded.options, ...adaptive };
	});
	const admitted = withProviderAdmission(watched, {
		ledger: providerAdmissionLedger,
		limits: input.providerLimitStore,
		isEmergencyStopEngaged: () => isEmergencyStopEngaged(input.agentDir),
		getAccountKey: (provider) => resolveProviderAccountKey(input.authStorage, provider),
		...(input.onWait ? { onWait: input.onWait } : {}),
		getPolicy: () => settingsManager.getProviderAdmissionSettings(),
		record: (record) => {
			try {
				sessionManager.appendCustomEntry(PROVIDER_ADMISSION_CUSTOM_TYPE, record);
			} catch {
				// A failed diagnostic write must never fail the request it observes.
			}
		},
	});
	Object.defineProperty(admitted, RAW_STREAM_MARKER, { value: baseStreamFn === streamSimple });
	return admitted;
}
