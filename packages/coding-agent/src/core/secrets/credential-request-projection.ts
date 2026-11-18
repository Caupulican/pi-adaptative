/** Projects credentials and provider-signed fields at the session request boundary. */
import type { Api, Context, Model, SimpleStreamOptions } from "@caupulican/pi-ai";
import {
	countHistoryWork,
	freezeOwnedJson,
	historyWorkFallback,
	inheritHistoryWork,
	providerMessagePrefix,
	readOnlyProviderPayloadHook,
	registerProviderMessagePrefix,
	responsesInputPrefix,
} from "@caupulican/pi-ai/history-work";
import { redactCredentialContent } from "./credential-model-content.ts";
import { createProviderRequestSecretPolicy } from "./provider-request-secrets.ts";

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

function isPayloadIdentityKey(key: string): boolean {
	return REQUEST_IDENTITY_FIELDS.has(key) || key === "name";
}

function redactRequestContext(
	context: Context,
	redact: (text: string) => string,
	policy: ReturnType<typeof createProviderRequestSecretPolicy>,
): Context {
	const preserveKey = (path: readonly (string | number)[], key: string) =>
		REQUEST_IDENTITY_FIELDS.has(key) || (key === "name" && (path.at(-2) === "tools" || path.at(-2) === "content"));
	// Only typed image data is opaque, through the string policy. An arbitrary object whose
	// type is "image" (for example inside tool arguments) still needs ordinary redaction.
	return redactCredentialContent(
		context,
		redact,
		(path, key, parent, root) => preserveKey(path, key) || policy.contextKey(path, key, parent, root),
		undefined,
		policy.contextString,
	);
}

type PayloadHook = NonNullable<SimpleStreamOptions["onPayload"]>;
const hookActivity = new WeakMap<PayloadHook, () => boolean>();
export function conditionalPayloadHook(active: () => boolean, hook: PayloadHook): PayloadHook {
	hookActivity.set(hook, active);
	return hook;
}

function signatureMembership(opaque: Map<string, number>, generation: number, parent?: (text: string) => boolean) {
	return (text: string) => (opaque.get(text) ?? Infinity) <= generation || parent?.(text) === true;
}

type Rows = Context["messages"];
interface Frame {
	rows: Rows;
	scope: string;
	redactor: (text: string) => string;
	opaque: Map<string, number>;
	generation: number;
	forkDepth: number;
	parentMembership?: (text: string) => boolean;
	contains: (text: string) => boolean;
	extended: boolean;
	hasPolicy: boolean;
	rawInput?: unknown[];
	safeInput?: unknown[];
}

/** Owns session request redaction and the provenance of provider-signed fields. */
export class CredentialRequestProjection {
	private readonly frames = new WeakMap<Rows, Frame>();

	prepare(
		model: Model<Api>,
		context: Context,
		redactor: (text: string) => string,
		redact: (text: string) => string,
		hook?: PayloadHook,
	) {
		const proof = providerMessagePrefix(context.messages);
		const candidate = proof?.previous && this.frames.get(proof.previous as Rows);
		const scope = JSON.stringify([model.api, model.provider, model.id]);
		const prior = candidate?.scope === scope && candidate.redactor === redactor ? candidate : undefined;
		const from = prior ? proof!.count : 0;
		const tail = from ? context.messages.slice(from) : context.messages;
		const source = { ...context, messages: tail };
		const projected = redactRequestContext(source, redact, createProviderRequestSecretPolicy(source, model, redact));
		// Reuse the accepted input array when redaction preserves every row.
		const prefixUnchanged = !prior || prior.rows === proof?.previous;
		let messages =
			prefixUnchanged && projected.messages === tail
				? context.messages
				: from
					? prior!.rows.slice(0, from).concat(projected.messages)
					: projected.messages;
		if (proof) {
			if (projected.messages !== tail)
				for (let i = 0; i < tail.length; i++) {
					if (projected.messages[i] !== tail[i]) freezeOwnedJson(projected.messages[i]);
				}
			if (messages === context.messages && proof.previous && !prior) {
				// The credential snapshot changed. Start a new wire frame even if the text happens to match.
				messages = messages.slice();
				countHistoryWork(context.messages, "copiedRows", messages.length);
			}
			inheritHistoryWork(context.messages, messages);
			if (messages !== context.messages) {
				Object.freeze(messages);
				registerProviderMessagePrefix(messages, prior?.rows, from);
				countHistoryWork(messages, "copiedRows", from * 2);
			}
		}
		const safeContext =
			messages === context.messages &&
			projected.systemPrompt === context.systemPrompt &&
			projected.tools === context.tools
				? context
				: { ...projected, messages };

		return this.finish(model, context, safeContext, projected, prior, from, redactor, redact, scope, hook);
	}

	private finish(
		model: Model<Api>,
		raw: Context,
		safe: Context,
		tail: Context,
		prior: Frame | undefined,
		from: number,
		redactor: (text: string) => string,
		redact: (text: string) => string,
		scope: string,
		hook?: PayloadHook,
	) {
		const certified = !!providerMessagePrefix(raw.messages);
		// Share append-only signature membership. Each request observes its own generation,
		// even if a sibling request concurrently prepares a different suffix.
		const samePrefix = prior?.hasPolicy && from === prior.rows.length;
		const append = samePrefix && (!prior.extended || prior.forkDepth < 8);
		const fork = append && prior.extended;
		const opaque = append && !fork ? prior.opaque : new Map<string, number>();
		const generation = append && !fork ? prior.generation + 1 : 1;
		const parentMembership = append ? (fork ? prior.contains : prior.parentMembership) : undefined;
		const contains = signatureMembership(opaque, generation, parentMembership);
		const frame: Frame = {
			rows: safe.messages,
			scope,
			redactor,
			opaque,
			generation,
			extended: false,
			hasPolicy: !!hook,
			forkDepth: append ? prior.forkDepth + Number(fork) : 0,
			parentMembership,
			contains,
		};
		if (certified) this.frames.set(raw.messages, frame);
		if (!hook) return { context: safe };
		if (append) prior.extended = true;
		if (prior && !append) {
			historyWorkFallback(raw.messages, "credential-provenance-fork-or-edit");
			countHistoryWork(raw.messages, "oldRowsRead", from);
		}
		const policy = createProviderRequestSecretPolicy(append ? tail : safe, model, redact, contains);
		for (const value of policy.opaque) if (!opaque.has(value)) opaque.set(value, generation);
		const apply = <T>(payload: T) =>
			redactCredentialContent(
				payload,
				redact,
				(path, key, parent, root) => isPayloadIdentityKey(key) || policy.payloadKey(path, key, parent, root),
				policy.payloadObject,
				policy.payloadString,
			);
		const active = hookActivity.get(hook);
		const shared = certified && !!active && !active() && model.api === "openai-responses";
		const onPayload: PayloadHook = async (payload, payloadModel) => {
			const input =
				shared && payload && typeof payload === "object" && Object.getPrototypeOf(payload) === Object.prototype
					? Object.getOwnPropertyDescriptor(payload, "input")?.value
					: undefined;
			const receipt = shared && Array.isArray(input) ? responsesInputPrefix(input) : undefined;
			if (receipt?.source === safe.messages && Array.isArray(input)) {
				const count = prior?.safeInput && append && receipt.previous === prior.rawInput ? receipt.count : 0;
				const suffix = count ? input.slice(count) : input;
				const base = payload as Record<string, unknown>;
				const shell = count ? { ...base, input: suffix } : base;
				const result = apply(shell);
				const previousSafe = prior?.safeInput;
				const useOriginal = (!count || previousSafe === prior?.rawInput) && suffix === result.input;
				const safeInput = useOriginal
					? input
					: count
						? previousSafe!.slice(0, count).concat(result.input)
						: result.input;
				if (!Array.isArray(safeInput)) throw new Error("Invalid Responses input projection");
				// Exposed transport arrays cannot modify a later request's redacted prefix.
				if (!useOriginal) {
					for (let index = count; index < safeInput.length; index++) freezeOwnedJson(safeInput[index]);
					Object.freeze(safeInput);
				}
				frame.safeInput = safeInput;
				frame.rawInput = input;
				const safePayload = result === shell && useOriginal ? payload : { ...result, input: safeInput };
				if (!active!()) return safePayload;
				// A handler installed while the request was in flight owns a mutable private copy.
				const detached = structuredClone(safePayload);
				return apply((await hook(detached, payloadModel)) ?? detached);
			}
			const first = apply(payload);
			if (active && !active()) return first;
			return apply((await hook(first, payloadModel)) ?? first);
		};
		return { context: safe, onPayload: shared ? readOnlyProviderPayloadHook(onPayload) : onPayload };
	}
}
