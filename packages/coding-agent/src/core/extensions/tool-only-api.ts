/**
 * The extension API a worker PROCESS gives an extension it loaded only because of a tool grant
 * (`worker-extension-grants.ts`). The grant admits tools, never the rest of the extension: the factory runs
 * whole, so it may register commands, handlers, providers and renderers in its body, but here only
 * `registerTool` for a granted tool name takes effect. Everything else is a recorded no-op: never a throw,
 * because a throw would fail the extension load and withhold the granted tool along with what was refused.
 *
 * The view is an explicit allow-list over `ExtensionAPI`. It is typed as a complete `ExtensionAPI` literal,
 * so a member added to the interface later does not compile until it is classified here; a new capability
 * can never reach a granted extension by default.
 */

import type { ExecutionContext } from "../../kernel/index.ts";
import type { ReadonlySessionManager } from "../../kernel/node.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { Extension, ExtensionAPI, ExtensionContext, ExtensionToolOnlyView, ExtensionUIContext } from "./types.ts";

/** Distinct ignored labels kept per extension; further distinct labels are counted, not stored. */
export const MAX_TOOL_ONLY_IGNORED_LABELS = 24;
const MAX_TOOL_ONLY_LABEL_LENGTH = 96;
/** One reported ignored label, with its extension path, is clipped to this many characters. */
export const MAX_TOOL_ONLY_NOTICE_LENGTH = 256;
const OVERFLOW_LABEL = "further distinct ignored calls (ledger full)";

/** The views of the tool-only extensions loaded in this process, by extension path (latest generation wins). */
const toolOnlyViews = new Map<string, ExtensionToolOnlyView>();
/** Receives one attributed notice the first time a distinct label is ignored; see {@link onToolOnlyIgnored}. */
let ignoredSink: ((notice: string) => void) | undefined;

function boundedLabel(label: string): string {
	const flat = Array.from(label, (char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 127 ? " " : char;
	})
		.join("")
		.trim();
	return flat.length > MAX_TOOL_ONLY_LABEL_LENGTH ? `${flat.slice(0, MAX_TOOL_ONLY_LABEL_LENGTH - 3)}...` : flat;
}

function noticeFor(view: ExtensionToolOnlyView, label: string): string {
	const text = `${view.extensionPath}: ${label}`;
	return text.length > MAX_TOOL_ONLY_NOTICE_LENGTH ? `${text.slice(0, MAX_TOOL_ONLY_NOTICE_LENGTH - 3)}...` : text;
}

function announce(view: ExtensionToolOnlyView, label: string): void {
	if (!ignoredSink) return;
	try {
		ignoredSink(noticeFor(view, label));
	} catch {
		// Reporting what a granted extension tried is advisory; it never fails the extension or the tool call.
	}
}

/**
 * Record one ignored registration, call or context access in the view's bounded ledger. The first time a
 * distinct label appears it is also announced to the installed sink, so a refusal made later (during a tool
 * call, long after startup) still reaches whoever reports it.
 */
export function recordToolOnlyIgnored(view: ExtensionToolOnlyView, what: string): void {
	const label = boundedLabel(what);
	const seen = view.ignored.get(label);
	if (seen !== undefined) {
		view.ignored.set(label, seen + 1);
	} else if (view.ignored.size < MAX_TOOL_ONLY_IGNORED_LABELS) {
		view.ignored.set(label, 1);
		announce(view, label);
	} else if (view.omitted++ === 0) {
		announce(view, OVERFLOW_LABEL);
	}
}

/**
 * Install the one receiver of ignored-label notices and replay what the loaded views already ignored (the
 * startup registrations). Replaces any earlier sink. Returns a function that removes this sink.
 */
export function onToolOnlyIgnored(sink: (notice: string) => void): () => void {
	ignoredSink = sink;
	for (const view of toolOnlyViews.values()) {
		for (const label of view.ignored.keys()) announce(view, label);
		if (view.omitted > 0) announce(view, OVERFLOW_LABEL);
	}
	return () => {
		if (ignoredSink === sink) ignoredSink = undefined;
	};
}

/**
 * Mark `extension` as loaded for a tool grant and return its ledger view. Idempotent: a lazy extension is
 * marked when it is created (before its factory has run) so the restricted tool context applies to its very
 * first call. Throws when no granted tool name is given: the caller refuses the grant, it never falls back.
 */
export function markToolOnlyExtension(extension: Extension, grantedTools: readonly string[]): ExtensionToolOnlyView {
	if (extension.toolOnly) return extension.toolOnly;
	const granted = new Set(grantedTools.filter((tool) => typeof tool === "string" && tool.length > 0));
	if (granted.size === 0) throw new Error("the extension file has no granted tool name");
	const view: ExtensionToolOnlyView = {
		extensionPath: extension.path,
		grantedTools: granted,
		ignored: new Map(),
		omitted: 0,
	};
	extension.toolOnly = view;
	toolOnlyViews.set(extension.path, view);
	return view;
}

/**
 * Build the restricted view over `api` and record its ledger on `extension.toolOnly`. Throws when the view
 * cannot be built (no granted tool): the caller refuses the grant, it never falls back to `api`.
 */
export function createToolOnlyExtensionAPI(
	api: ExtensionAPI,
	extension: Extension,
	grantedTools: readonly string[],
): ExtensionAPI {
	const view = markToolOnlyExtension(extension, grantedTools);
	const granted = view.grantedTools;
	const ignore = (what: string): void => recordToolOnlyIgnored(view, what);

	const restricted: ExtensionAPI = {
		// Pure view; I/O happens only when the extension's own code writes to it.
		getStorage: (namespace) => api.getStorage(namespace),

		// Event subscriptions: a granted extension never observes the worker's session.
		on: (event: string) => ignore(`on(${event})`),

		registerTool(tool) {
			if (granted.has(tool.name)) api.registerTool(tool);
			else ignore(`registerTool(${tool.name})`);
		},

		registerCommand: (name) => ignore(`registerCommand(${name})`),
		registerShortcut: (shortcut) => ignore(`registerShortcut(${shortcut})`),
		registerFlag: (name) => ignore(`registerFlag(${name})`),
		getFlag: (name) => api.getFlag(name),
		registerMessageRenderer: (customType) => ignore(`registerMessageRenderer(${customType})`),
		registerMarkdownTransformer: () => ignore("registerMarkdownTransformer"),
		registerMemoryProvider: () => ignore("registerMemoryProvider"),
		registerContextMemoryProvider: () => ignore("registerContextMemoryProvider"),
		registerProvider: (name) => ignore(`registerProvider(${name})`),
		unregisterProvider: (name) => ignore(`unregisterProvider(${name})`),

		// Actions on the worker's own session: a granted tool reports through its result, not the transcript.
		sendMessage: () => ignore("sendMessage"),
		sendUserMessage: () => ignore("sendUserMessage"),
		appendEntry: () => ignore("appendEntry"),
		setSessionName: () => ignore("setSessionName"),
		setLabel: () => ignore("setLabel"),
		setActiveTools: () => ignore("setActiveTools"),
		setModel: () => {
			ignore("setModel");
			return Promise.resolve(false);
		},
		setThinkingLevel: () => ignore("setThinkingLevel"),
		reportSpawnedUsage: () => ignore("reportSpawnedUsage"),
		reportManagedLane: () => ignore("reportManagedLane"),

		// Read-only views and the process handle the tool needs to run.
		exec: (command, args, options) => api.exec(command, args, options),
		getSessionName: () => api.getSessionName(),
		getActiveTools: () => api.getActiveTools(),
		getAllTools: () => api.getAllTools(),
		getCommands: () => api.getCommands(),
		getExternalResourceRoots: () => api.getExternalResourceRoots(),
		getEffectiveResourceProfile: () => api.getEffectiveResourceProfile(),
		getHandoffPersonaGuidance: () => api.getHandoffPersonaGuidance(),
		getThinkingLevel: () => api.getThinkingLevel(),

		// Teardown of resources the tool itself creates stays available.
		onDispose: (fn) => api.onDispose(fn),

		// The shared bus connects extensions; a granted tool neither listens to nor speaks on it.
		events: {
			emit: (channel) => ignore(`events.emit(${channel})`),
			on: (channel) => {
				ignore(`events.on(${channel})`);
				return () => {};
			},
		},
	};
	return Object.freeze(restricted);
}

/** One bounded sentence naming what the tool-only view ignored, or undefined when it ignored nothing. */
export function describeToolOnlyIgnored(extension: Extension): string | undefined {
	const view = extension.toolOnly;
	if (!view || (view.ignored.size === 0 && view.omitted === 0)) return undefined;
	const entries = [...view.ignored].map(([label, count]) => (count > 1 ? `${label} x${count}` : label));
	if (view.omitted > 0) entries.push(`${view.omitted} more`);
	return `Extension "${extension.path}" is loaded for tool grant(s) [${[...view.grantedTools].join(", ")}] only; ignored: ${entries.join(", ")}.`;
}

/** What the runner lends a tool-only tool context: the live reads it keeps, never the session itself. */
export interface ToolOnlyContextHost {
	/** Throws when this runner generation is stale (the same guard the full context applies on every read). */
	assertActive(): void;
	/** The session working directory, used when no admitted execution context names the call's own. */
	getCwd(): string;
	/** The abort signal of the current run, or undefined when none is active. */
	getSignal(): AbortSignal | undefined;
	/** A UI that settles nothing: no prompt, no widget, no editor access. */
	readonly inertUI: ExtensionUIContext;
}

/** Property reads a runtime or serializer makes on any object; answering them never reaches the session. */
const INERT_PROPERTY_KEYS: ReadonlySet<string> = new Set(["then", "toJSON", "inspect", "$$typeof", "asymmetricMatch"]);

/**
 * A stand-in for a session-owned object: only the named members work; any other read or write records the
 * attempt and throws an error naming what was denied, so a tool that needs more learns it, and the parent
 * hears of it, instead of silently receiving the real object.
 */
function denyingFacade<T extends object>(
	label: string,
	allowed: Record<string, unknown>,
	deny: (what: string) => never,
): T {
	return new Proxy(allowed, {
		get(target, key) {
			if (typeof key === "symbol" || Object.hasOwn(target, key)) return Reflect.get(target, key);
			if (INERT_PROPERTY_KEYS.has(key)) return undefined;
			return deny(`${label}.${key}`);
		},
		set: (_target, key) => deny(`${label}.${String(key)} (write)`),
		defineProperty: (_target, key) => deny(`${label}.${String(key)} (define)`),
		deleteProperty: (_target, key) => deny(`${label}.${String(key)} (delete)`),
	}) as T;
}

/**
 * The `ctx` a tool-only extension's granted tool receives instead of the worker's full `ExtensionContext`.
 * It is an explicit allow-list typed as a complete `ExtensionContext` literal, so a member added to the
 * interface later does not compile until it is classified here. A tool keeps what it needs to run under the
 * worker's ceilings: the call's working directory, the run's abort signal, and `hasUI: false`. It never gets
 * the UI, the session or its transcript, the model registry or current model, the system prompt, or any way
 * to abort, shut down, compact or reload the session. Members that can only be answered neutrally record the
 * attempt in the extension's ignored ledger and return that neutral answer; members that cannot (the session
 * and model registry objects) record it and throw an error naming what was denied.
 */
export function createToolOnlyExtensionContext(
	view: ExtensionToolOnlyView,
	host: ToolOnlyContextHost,
	executionContext: ExecutionContext | undefined,
): ExtensionContext {
	const ignore = (what: string): void => recordToolOnlyIgnored(view, `ctx.${what}`);
	const deny = (what: string): never => {
		recordToolOnlyIgnored(view, `ctx.${what}`);
		throw new Error(
			`ctx.${what} is not available to a tool granted to a worker process (tool-only grant, ${view.extensionPath}). A granted tool may use its arguments, ctx.cwd, ctx.signal and pi.exec only.`,
		);
	};
	const sessionManager = denyingFacade<ReadonlySessionManager>(
		"sessionManager",
		{ getCwd: () => executionContext?.cwd ?? host.getCwd() },
		deny,
	);
	const modelRegistry = denyingFacade<ModelRegistry>("modelRegistry", {}, deny);
	return Object.freeze<ExtensionContext>({
		get ui() {
			host.assertActive();
			return host.inertUI;
		},
		get hasUI() {
			host.assertActive();
			return false;
		},
		get mode(): ExtensionContext["mode"] {
			host.assertActive();
			return "print";
		},
		get cwd() {
			host.assertActive();
			return executionContext?.cwd ?? host.getCwd();
		},
		executionContext,
		get sessionManager() {
			host.assertActive();
			return sessionManager;
		},
		get modelRegistry() {
			host.assertActive();
			return modelRegistry;
		},
		get model() {
			host.assertActive();
			return undefined;
		},
		isIdle: () => {
			host.assertActive();
			return false;
		},
		get signal() {
			host.assertActive();
			return host.getSignal();
		},
		abort: () => {
			host.assertActive();
			ignore("abort");
		},
		hasPendingMessages: () => {
			host.assertActive();
			return false;
		},
		shutdown: () => {
			host.assertActive();
			ignore("shutdown");
		},
		getContextUsage: () => {
			host.assertActive();
			return undefined;
		},
		compact: () => {
			host.assertActive();
			ignore("compact");
		},
		reload: () => {
			host.assertActive();
			ignore("reload");
			return Promise.resolve();
		},
		getSystemPrompt: () => {
			host.assertActive();
			return "";
		},
	});
}
