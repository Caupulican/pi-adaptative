import type { StreamFn } from "@caupulican/pi-agent-core";
import { type StreamIdleOptions, withStreamIdleWatchdog } from "@caupulican/pi-agent-core/reliability";
import type { SessionManager } from "@caupulican/pi-agent-core/session";
import type { AssistantMessage, Context } from "@caupulican/pi-ai";
import { createAssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import { streamSimple } from "@caupulican/pi-ai/stream";
import { createEmptyUsage } from "@caupulican/pi-ai/usage";
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
import { isCredentialSecretKey } from "./secrets/credential-content-mock.ts";
import { CredentialContentProjectionError, redactCredentialContent } from "./secrets/credential-model-content.ts";
import { redactTokenShapes } from "./security/secret-text.ts";
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
	authStorage: {
		get(provider: string): AuthCredential | undefined;
		getOAuthRequestHeaders(provider: string, apiKey: string): Record<string, string> | undefined;
	};
	/** The current host credential boundary; looked up lazily for each request. */
	redactSensitiveText?: (text: string, additionalValues?: readonly string[]) => string;
	/** Precomputed exact-value redactor used for every string in this request. */
	createSensitiveTextRedactor?: (additionalValues?: readonly string[]) => (text: string) => string;
	/** Snapshot host credential values once at the request boundary, without refreshing providers. */
	getSensitiveValues?: () => readonly string[] | Promise<readonly string[]>;
	/** Live wait notifications for the operator's activity lane. */
	onWait?: (event: ProviderAdmissionWaitEvent) => void;
	/** The output repetition guard's threshold follows the model's capability tier. */
	getRepetitionGuardRepeats: () => number;
	/** Test-only stream-idle override, read per request (see `setStreamIdleOptionsForTests`). */
	getStreamIdleOptionsOverride: () => Partial<StreamIdleOptions> | undefined;
}

const REQUEST_IDENTITY_FIELDS = new Set([
	"role",
	"api",
	"provider",
	"model",
	"responseModel",
	"responseId",
	"stopReason",
	"timestamp",
	"type",
	"id",
	"toolName",
	"toolCallId",
	"mimeType",
	"textSignature",
	"thinkingSignature",
	"thoughtSignature",
]);

type CredentialRequestOptions = NonNullable<Parameters<StreamFn>[2]> & {
	credentialHeaders?: Record<string, string>;
};

function isPayloadIdentityKey(key: string): boolean {
	return REQUEST_IDENTITY_FIELDS.has(key) || key === "name";
}

function requestCredentialValues(options: Parameters<StreamFn>[2]): readonly string[] | undefined {
	const values = new Set<string>();
	const credentialOptions = options as CredentialRequestOptions | undefined;
	if (credentialOptions?.apiKey) values.add(credentialOptions.apiKey);
	for (const headers of [credentialOptions?.headers, credentialOptions?.credentialHeaders]) {
		for (const [name, value] of Object.entries(headers ?? {})) {
			if (isCredentialSecretKey(name) && value) {
				values.add(value);
				const bearer = /^\s*Bearer\s+(.+?)\s*$/iu.exec(value);
				if (bearer?.[1]) values.add(bearer[1]);
			}
		}
	}
	return values.size > 0 ? [...values] : undefined;
}

function combineCredentialValues(
	hostValues: readonly string[],
	requestValues: readonly string[] | undefined,
): readonly string[] | undefined {
	if (hostValues.length === 0 && !requestValues?.length) return undefined;
	const values = new Set(hostValues);
	for (const value of requestValues ?? []) values.add(value);
	return [...values];
}

function redactRequestContext(context: Context, redact: (text: string) => string): Context {
	const preserveKey = (path: readonly (string | number)[], key: string) =>
		REQUEST_IDENTITY_FIELDS.has(key) || (key === "name" && (path.at(-2) === "tools" || path.at(-2) === "content"));
	const preserveImage = (_path: readonly (string | number)[], value: object) => {
		const type = Object.getOwnPropertyDescriptor(value, "type");
		return type?.enumerable === true && "value" in type && type.value === "image";
	};
	return redactCredentialContent(context, redact, preserveKey, preserveImage);
}

function failedRedactionStream(
	model: Parameters<StreamFn>[0],
	error: unknown,
): ReturnType<typeof createAssistantMessageEventStream> {
	const message = error instanceof Error ? error.message : String(error);
	const failure: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: "error",
		errorMessage: `Credential redaction failed; request withheld (${message})`,
		timestamp: Date.now(),
	};
	Object.defineProperty(failure, "cause", {
		value: error instanceof Error ? (error.cause ?? error) : error,
		enumerable: false,
	});
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "error", reason: "error", error: failure });
	stream.end();
	return stream;
}

export function buildSessionStreamFn(input: SessionStreamChainInput): StreamFn {
	const { baseStreamFn, settingsManager, sessionManager, modelAdaptationStore, providerAdmissionLedger } = input;
	const redactedBase: StreamFn = async (model, context, options) => {
		let redactedContext = context;
		let redactedOptions = options;
		try {
			const hostValues = (await input.getSensitiveValues?.()) ?? [];
			options?.signal?.throwIfAborted();
			const additionalValues = combineCredentialValues(hostValues, requestCredentialValues(options));
			const redactKnown =
				input.createSensitiveTextRedactor?.(additionalValues) ??
				((text: string) => input.redactSensitiveText?.(text, additionalValues) ?? text);
			// Known values are exact; token shapes are the floor for keys the host has never seen. Both are
			// unconditional: a session without a credential boundary still never sends a recognizable key.
			const redact = (text: string) => redactTokenShapes(redactKnown(text));
			redactedContext = redactRequestContext(context, redact);
			const onPayload = options?.onPayload;
			redactedOptions = onPayload
				? {
						...options,
						onPayload: async (payload: unknown, payloadModel: Parameters<NonNullable<typeof onPayload>>[1]) => {
							const safePayload = redactCredentialContent(payload, redact, (_path, key) =>
								isPayloadIdentityKey(key),
							);
							const hooked = await onPayload(safePayload, payloadModel);
							return redactCredentialContent(hooked === undefined ? safePayload : hooked, redact, (_path, key) =>
								isPayloadIdentityKey(key),
							);
						},
					}
				: options;
		} catch (error) {
			if (options?.signal?.aborted) throw error;
			const reason =
				error instanceof CredentialContentProjectionError ? error.failure : "credential source unavailable";
			return failedRedactionStream(model, new Error(reason, { cause: error }));
		}
		// Provider failures retain the transport owner's classification and retry behavior.
		return baseStreamFn(model, redactedContext, redactedOptions);
	};
	const credentialed: StreamFn =
		baseStreamFn === streamSimple
			? (model, context, options) =>
					redactedBase(model, context, {
						...options,
						credentialHeaders:
							options?.credentialHeaders ??
							(options?.apiKey
								? input.authStorage.getOAuthRequestHeaders(model.provider, options.apiKey)
								: undefined),
						credentialHeadersFor: (apiKey: string) =>
							input.authStorage.getOAuthRequestHeaders(model.provider, apiKey),
					})
			: redactedBase;
	const profiled = withModelPerfProfile(credentialed, {
		modelKey: (model) => formatModelRouterModel(model),
		recordSample: (modelKey, sample) => {
			modelAdaptationStore.recordPerfSample(modelKey, sample);
		},
	});
	const watched = withStreamIdleWatchdog(profiled, (model, context) => {
		const stallBudget = resolveStreamStallBudget(model, settingsManager);
		const testOverride = input.getStreamIdleOptionsOverride();
		const configured = {
			// Local/managed models and cloud providers draw on separate budgets; see resolveStreamStallBudget.
			...stallBudget.base,
			outputRepetitionRepeats: input.getRepetitionGuardRepeats(),
			...testOverride,
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
			allowCloudConnectReduction:
				stallBudget.modelClass === "cloud" &&
				!stallBudget.connectConfigured &&
				testOverride?.connectMs === undefined,
			ceilingMs: httpBounded.adaptiveCeilingMs ?? DEFAULT_ADAPTIVE_STREAM_IDLE_CEILING_MS,
		});
		return { ...httpBounded.options, ...adaptive };
	});
	const admitted = withProviderAdmission(watched, {
		ledger: providerAdmissionLedger,
		limits: input.providerLimitStore,
		isEmergencyStopEngaged: () => isEmergencyStopEngaged(input.agentDir),
		getAccountKey: (provider, apiKey) => resolveProviderAccountKey(input.authStorage, provider, apiKey),
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
