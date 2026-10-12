import { type Api, type Model, OPENAI_CODEX_CLIENT_VERSION } from "@caupulican/pi-ai";
import { getKeybindings, setKeybindings, type Terminal } from "@caupulican/pi-tui";
import * as undici from "undici";
import { expect, type Mock, vi } from "vitest";
import { AgentSession } from "../../../src/core/agent-session.ts";
import { type AgentSessionRuntime, createAgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { FooterDataProvider } from "../../../src/core/footer-data-provider.ts";
import { PROVIDER_RETRY_CUSTOM_TYPE } from "../../../src/core/foreground-lifecycle-controller.ts";
import {
	awaitHttpDispatcherRetirements,
	configureHttpDispatcher,
	disposeHttpDispatcher,
} from "../../../src/core/http-dispatcher.ts";
import { AccountModelCatalog } from "../../../src/core/model-router/account-models.ts";
import { ModelAdaptationStore } from "../../../src/core/models/adaptation-store.ts";
import { TerminalWarnings } from "../../../src/core/terminal-warnings.ts";
import { FooterComponent } from "../../../src/modes/interactive/components/footer.ts";
import { EditorOverlayHost } from "../../../src/modes/interactive/editor-overlay-host.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { SignalLifecycle } from "../../../src/modes/interactive/signal-lifecycle.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { initTheme, stopThemeWatcher } from "../../../src/presentation/theme/theme.ts";
import { trackDetachedChild, untrackDetachedChild } from "../../../src/utils/shell.ts";
import { type Barrier, createBarrier, fail, HARNESS_API, HARNESS_PROVIDER, text } from "./scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "./session-fixture.ts";

const GUARD_CLOSING_WARNING = "Guard witness: a closing warning the held terminal keeps until stop.";
const GUARD_STOP_FAILURE = "Guard witness: stop failed after the release.";
const GUARD_DRAIN_FAILURE = "Guard witness: the terminal input drain failed.";
/** The cause text of a value whose `toString` and `Symbol.toStringTag` both throw: plainText falls back to its typeof. */
const UNCONVERTIBLE_CAUSE_TEXT = "[object]";
const INTERACTIVE_STOP_WARNING = "Interactive stop witness: a closing warning the held terminal keeps until stop.";
const INTERACTIVE_STOP_FAILURE = "Interactive stop witness: the terminal progress teardown failed.";
const FOOTER_DATA_PROVIDER_FAILURE = "Interactive stop witness: the footer data provider teardown failed.";
const CLOSING_GATE_CONTROL_REPLY = "The closing gate control reply.";
/** Warning a run's preparation emits for a `text-protocol` verdict with no calibration on record, before any provider request. */
const CALIBRATION_WARNING = `Text tool protocol for ${HARNESS_PROVIDER}/root has no valid calibration on record; falling back to native tool calls this turn. Run /toolprobe ${HARNESS_PROVIDER}/root to calibrate.`;
/** The owner prompt of both calibration runs: the same text, so both classify identically before preparation reaches the warning. */
const CALIBRATION_RUN_PROMPT = "Run the control.";
const CALIBRATION_BASELINE_REPLY = "The calibration baseline reply.";

/** Neutral owner words: backlog settlement also screens and checks capabilities; steering classifies directly. */
function enterNeutralModeIntake(world: HarnessWorld, phase: string, input: string, backlog: boolean): void {
	if (!world.systemOne.enabled) return;
	const judgments = {
		...(backlog
			? {
					carries_0: { kind: "noul" as const, probability: 0.02 },
					capabilities_authorized: { kind: "noul" as const, probability: 0.02 },
				}
			: {}),
		changes_model_pools: { kind: "noul" as const, probability: 0.02 },
		local_commits_only: { kind: "noul" as const, probability: 0.02 },
		lifts_delivery_block: { kind: "noul" as const, probability: 0.02 },
		full_handoff: { kind: "noul" as const, probability: 0.02 },
		optional_tool_0: { kind: "choice" as const, choice: "unchanged", confidence: 0.97 },
	};
	world.systemOne.enterPhase(phase, judgments, {
		expect: ({ state, questions }) => {
			if ("carries_0" in questions) {
				expect(backlog, "only deferred owner words need screening").toBe(true);
				expect(Object.keys(questions), "the backlog screen has its own question schema").toEqual(["carries_0"]);
				expect(state, "the screen sees this helper's exact earlier submission").toEqual({
					owner_messages: [input],
				});
				return;
			}
			expect(Object.keys(questions).sort(), "only the declared intake schema reads intake state").toEqual(
				Object.keys(judgments)
					.filter((id) => id !== "carries_0")
					.sort(),
			);
			const intake = state as Record<string, unknown>;
			expect(intake.user_request, "the intake sees this helper's exact owner words").toBe(input);
			expect(intake.pending_owner_requests, "no unrelated owner input enters this intake").toEqual([]);
			expect(intake.previous_optional_tool_intent, "no earlier tool request is invented").toBeNull();
			expect(intake.optional_tools, "the neutral judgment refers to the real built-in candidate").toMatchObject([
				{ toolName: "secret_store", sourcePath: "<builtin:secret_store>" },
			]);
			expect("capabilities_authorized" in questions, "steering does not classify deferred capabilities").toBe(
				backlog,
			);
		},
	});
}
const REJECTION_STACK = "Error: late rejection \u001b[2J at guard witness";
const REJECTION_LINE = "Unhandled promise rejection during shutdown. Error: late rejection \\x1b[2J at guard witness\n";
const CRASH_STACK = "Error: guard crash at guard witness";
const CRASH_LINE = `pi exiting due to uncaughtException during shutdown: ${CRASH_STACK}\n`;
const GUARD_ARMED = ["stdout:error", "stderr:error", "uncaughtException", "unhandledRejection"];
const TEARDOWN_STEPS = [
	"guard.removed:stdout:error",
	"guard.removed:stderr:error",
	"guard.removed:uncaughtException",
	"guard.removed:unhandledRejection",
	"terminal.setProgress",
	"footer.dispose",
	"footerDataProvider.dispose",
	"overlay.unmount",
	"session.unsubscribe",
];
/**
 * The extensions-changed subscription belongs to an attended mode only: an unattended `init()` returns after its rebind, and the
 * rebind subscribes inside `if (this.hasHumanAudience)`. A mode without an audience owns no such subscription, so its stop has
 * nothing to unsubscribe, and the stop must not report one. The attended teardown of that subscription stays unreached here.
 */
const ATTENDED_ONLY_TEARDOWN_STEP = "extensions.unsubscribe";

function isSignalName(name: string): boolean {
	return name.startsWith("SIG");
}

/** An error whose stack is fixed here, so the reported text is exact and has no platform-specific frames. */
function fixedError(stack: string): Error {
	const error = new Error("guard witness");
	error.stack = stack;
	return error;
}

/** A thrown value whose conversion and tag both throw: the cause report must still name it, and must not throw while doing so. */
/** An Error with no readable stack (the getter throws) and a non-string message: its report must still be written. */
function stacklessError(): Error {
	const error = new Error("guard witness");
	Object.defineProperty(error, "stack", {
		get: () => {
			throw new Error("Guard witness: stack getter throws.");
		},
	});
	Object.defineProperty(error, "message", { value: 42 });
	return error;
}

function unconvertibleCause(): object {
	return {
		toString: () => {
			throw new Error("Guard witness: toString throws.");
		},
		get [Symbol.toStringTag](): string {
			throw new Error("Guard witness: Symbol.toStringTag throws.");
		},
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface Install {
	readonly name: string;
	readonly handler: (...args: never[]) => void;
	removed: boolean;
}

/** The listener the lifecycle or the mode armed under `name` last; a missing one is a broken witness, never a silent skip. */
function armedListener(installs: readonly Install[], name: string): (...args: never[]) => void {
	const matches = installs.filter((install) => install.name === name && !install.removed);
	const listener = matches[matches.length - 1];
	if (!listener) throw new Error(`Mode witness: no armed ${name} listener.`);
	return listener.handler;
}

function armedNames(installs: readonly Install[]): string[] {
	return installs.filter((install) => !install.removed).map((install) => install.name);
}

interface GuardHost {
	readonly lifecycle: SignalLifecycle;
	readonly installs: Install[];
	readonly log: string[];
	readonly warnings: string[];
	readonly stderr: string[];
	readonly exits: number[];
	readonly guardsAtDispose: string[];
	readonly forcesAtDispose: string[];
	/** Released once the dispose has written its closing warning and is waiting on `hold`. */
	readonly reached: Barrier;
	readonly hold: Barrier;
}

interface GuardHostOptions {
	readonly holdDispose: boolean;
	readonly stopFails: boolean;
	/** The runtime dispose rejects with this value after it has written its closing warning. */
	readonly disposeFails?: { readonly thrown: unknown };
	readonly drainFails?: boolean;
}

function createGuardHost(options: GuardHostOptions): GuardHost {
	const installs: Install[] = [];
	const log: string[] = [];
	const warnings: string[] = [];
	const stderr: string[] = [];
	const exits: number[] = [];
	const guardsAtDispose: string[] = [];
	const forcesAtDispose: string[] = [];
	const terminal = new TerminalWarnings((released) => {
		warnings.push(...released);
	});
	terminal.hold();
	const reached = createBarrier();
	const hold = createBarrier();
	if (!options.holdDispose) hold.release();
	const install = (name: string, handler: (...args: never[]) => void): (() => void) => {
		const entry: Install = { name, handler, removed: false };
		installs.push(entry);
		return () => {
			entry.removed = true;
		};
	};
	const lifecycle = new SignalLifecycle(
		{
			runtimeHost: {
				dispose: async () => {
					log.push("dispose");
					const armed = armedNames(installs);
					guardsAtDispose.push(...armed.filter((name) => !isSignalName(name)));
					forcesAtDispose.push(...armed.filter(isSignalName));
					terminal.write([GUARD_CLOSING_WARNING]);
					reached.release();
					await hold.promise;
					if (options.disposeFails) throw options.disposeFails.thrown;
				},
			},
			ui: {
				start: () => {},
				stop: () => {},
				requestRender: () => {},
				terminal: {
					drainInput: async () => {
						log.push("drain");
						if (options.drainFails) throw new Error(GUARD_DRAIN_FAILURE);
					},
				},
			},
			isShutdownRequested: () => false,
			stop: () => {
				log.push("stop");
				terminal.release();
				if (options.stopFails) throw new Error(GUARD_STOP_FAILURE);
			},
			formatResumeCommand: () => undefined,
			showStatus: () => {},
			showError: () => {},
		},
		{
			exit: (code) => {
				exits.push(code);
			},
			stderr: (text) => {
				stderr.push(text);
			},
			stdout: () => {},
			prependListener: install,
			onStreamError: (stream, handler) => install(`${stream}:error`, handler),
		},
	);
	return { lifecycle, installs, log, warnings, stderr, exits, guardsAtDispose, forcesAtDispose, reached, hold };
}

interface GuardRun {
	readonly guardsAtDispose: readonly string[];
	readonly forcesAtDispose: readonly string[];
	/** What is still armed when the run is read: the guards after a normal exit, the forced listeners while they are still armed. */
	readonly guardsAtEnd: readonly string[];
	readonly forcesAtEnd: readonly string[];
	readonly log: readonly string[];
	readonly warnings: readonly string[];
	readonly stderr: readonly string[];
	readonly exits: readonly number[];
}

function guardRunOf(host: GuardHost): GuardRun {
	const armed = armedNames(host.installs);
	// Independent copies: a shutdown that completes after the run is read (the emergency runs) cannot mutate what was observed.
	return {
		guardsAtDispose: [...host.guardsAtDispose],
		forcesAtDispose: [...host.forcesAtDispose],
		guardsAtEnd: armed.filter((name) => !isSignalName(name)),
		forcesAtEnd: armed.filter(isSignalName),
		log: [...host.log],
		warnings: [...host.warnings],
		stderr: [...host.stderr],
		exits: [...host.exits],
	};
}

/** Normal order: no listener fires; the shutdown disposes, drains and stops, removes the forced listeners and exits 0. */
async function runGuardControl(): Promise<GuardRun> {
	const host = createGuardHost({ holdDispose: false, stopFails: false });
	host.lifecycle.registerSignalHandlers();
	await host.lifecycle.shutdown({ fromSignal: true });
	return guardRunOf(host);
}

/** A rejection arrives while the dispose is held: it is reported escaped on stderr and the shutdown keeps running to exit 0. */
async function runGuardRejection(reason: unknown = fixedError(REJECTION_STACK)): Promise<GuardRun> {
	const host = createGuardHost({ holdDispose: true, stopFails: false });
	host.lifecycle.registerSignalHandlers();
	const shutdown = host.lifecycle.shutdown({ fromSignal: true });
	await host.reached.promise;
	(armedListener(host.installs, "unhandledRejection") as (reason: unknown) => void)(reason);
	host.hold.release();
	await shutdown;
	return guardRunOf(host);
}

/**
 * An uncaught exception arrives while the dispose is held: stop restores the terminal and releases the held warning, the crash is
 * reported and the exit is 1. The injected exit returns, so the run is read there: the process would have ended at that exit.
 */
async function runGuardCrash(thrown: unknown, options: { readonly stopFails: boolean }): Promise<GuardRun> {
	const host = createGuardHost({ holdDispose: true, stopFails: options.stopFails });
	host.lifecycle.registerSignalHandlers();
	const shutdown = host.lifecycle.shutdown({ fromSignal: true });
	try {
		await host.reached.promise;
		(armedListener(host.installs, "uncaughtException") as (value: unknown) => void)(thrown);
		return guardRunOf(host);
	} finally {
		// The injected exit returned, so the held shutdown is still unfinished: release it, join it and remove the listeners this
		// fixture owns, after the observation above was copied.
		host.hold.release();
		await shutdown;
		host.lifecycle.unregisterSignalHandlers();
	}
}

/**
 * A second termination signal arrives while the dispose is held: the forced listener kills the tracked children, stops the terminal once
 * and exits with the signal's status. The run is read at that exit.
 */
async function runGuardSecondSignal(signal: NodeJS.Signals): Promise<GuardRun> {
	const host = createGuardHost({ holdDispose: true, stopFails: false });
	host.lifecycle.registerSignalHandlers();
	const shutdown = host.lifecycle.shutdown({ fromSignal: true });
	try {
		await host.reached.promise;
		(armedListener(host.installs, signal) as () => void)();
		return guardRunOf(host);
	} finally {
		host.hold.release();
		await shutdown;
		host.lifecycle.unregisterSignalHandlers();
	}
}

/**
 * Two cleanup steps of a signal shutdown fail: the runtime dispose rejects with an unconvertible value, then the terminal input drain
 * rejects with an Error. Every step still runs, the stop releases the held warning, and the one line reports both causes before exit 1.
 */
async function runGuardTwoCauses(): Promise<GuardRun> {
	const host = createGuardHost({
		holdDispose: false,
		stopFails: false,
		disposeFails: { thrown: unconvertibleCause() },
		drainFails: true,
	});
	host.lifecycle.registerSignalHandlers();
	await host.lifecycle.shutdown({ fromSignal: true });
	return guardRunOf(host);
}

/** The process reporter bounds width, depth and total text independently; cleanup still reaches every step. */
async function verifyGuardCauseBounds(): Promise<void> {
	let deep: unknown = new Error("hidden leaf");
	for (let level = 4; level >= 0; level--) deep = new AggregateError([deep], `depth-${level}`);
	for (const [cause, expected] of [
		[deep, "Shutdown failed: depth-0 (depth-1 (depth-2 (depth-3 (depth-4 (1 more causes)))))\n"],
		[
			new AggregateError(
				Array.from({ length: 10 }, (_, index) => new Error(`cause-${index}`)),
				"wide",
			),
			"Shutdown failed: wide (cause-0; cause-1; cause-2; cause-3; cause-4; cause-5; cause-6; cause-7; 2 more causes)\n",
		],
		[new Error("a".repeat(2_100)), `Shutdown failed: ${"a".repeat(1_999)}…\n`],
	] as const) {
		const host = createGuardHost({ holdDispose: false, stopFails: false, disposeFails: { thrown: cause } });
		host.lifecycle.registerSignalHandlers();
		await host.lifecycle.shutdown({ fromSignal: true });
		expect(host.stderr, "the real shutdown reporter preserves each configured cause bound and elision").toEqual([
			expected,
		]);
		expect(host.log, "bounded reporting never skips drain or terminal restoration").toEqual([
			"dispose",
			"drain",
			"stop",
		]);
		expect(host.warnings, "bounded failures still release the held warning").toEqual([GUARD_CLOSING_WARNING]);
		expect(host.exits, "each bounded failure exits with failure status").toEqual([1]);
	}
}

interface InteractiveHarness {
	readonly mode: InteractiveMode;
	readonly runtime: AgentSessionRuntime;
	readonly terminalWarnings: TerminalWarnings;
	readonly calls: string[];
	readonly warnings: string[];
	/** The runtime's own closing disclosures (its terminal sink), kept apart from the mode's warnings and asserted by each witness. */
	readonly disposalWarnings: string[];
	readonly stderr: string[];
	readonly stdout: string[];
	readonly exits: number[];
	readonly installs: Install[];
	readonly flags: { progressFails: boolean };
	/** Non-signal guards removed before the runtime dispose started. */
	readonly removedGuardsAtDispose: string[];
	/** Released when the runtime dispose has started and is waiting on `hold`. */
	readonly reached: Barrier;
	readonly hold: Barrier;
	/** Released at the first exit. */
	readonly exited: Barrier;
	/** Released at the exit with status 0: a forced exit or a crash ran first, and the held quit then finished by itself. */
	readonly quitFinished: Barrier;
}

/** A real InteractiveMode on a recording input-only terminal, its runtime from the world, and every listener it arms recorded. */
async function createInteractiveHarness(
	world: HarnessWorld,
	options: { readonly holdDispose: boolean; readonly extensionFactories?: readonly ExtensionFactory[] },
): Promise<InteractiveHarness> {
	initTheme("dark");
	const calls: string[] = [];
	const warnings: string[] = [];
	const stderr: string[] = [];
	const stdout: string[] = [];
	const exits: number[] = [];
	const installs: Install[] = [];
	const removedGuardsAtDispose: string[] = [];
	const flags = { progressFails: false };
	const reached = createBarrier();
	const hold = createBarrier();
	const exited = createBarrier();
	const quitFinished = createBarrier();
	const terminal: Terminal = {
		inputOnly: true,
		columns: 80,
		rows: 24,
		kittyProtocolActive: false,
		start: () => {},
		stop: () => {
			calls.push("terminal.stop");
		},
		drainInput: async () => {},
		write: () => {},
		moveBy: () => {},
		hideCursor: () => {},
		showCursor: () => {},
		clearLine: () => {},
		clearFromCursor: () => {},
		clearScreen: () => {},
		setTitle: () => {},
		setProgress: () => {
			calls.push("terminal.setProgress");
			if (flags.progressFails) throw new Error(INTERACTIVE_STOP_FAILURE);
		},
	};
	const terminalWarnings = new TerminalWarnings((released) => {
		calls.push("release");
		warnings.push(...released);
	});
	const disposalWarnings: string[] = [];
	const runtime = await createAgentSessionRuntime(
		async ({ cwd, agentDir, sessionManager }) => {
			const root = await world.createRootSession("root", {
				agentDir,
				sessionManager,
				settings: { memorySystem: undefined, terminal: { showTerminalProgress: true } },
				extensionFactories: options.extensionFactories ? [...options.extensionFactories] : undefined,
			});
			return {
				session: root.session,
				sessionManager: root.sessionManager,
				getExtensionRunner: root.getExtensionRunner,
				extensionsResult: root.extensionsResult,
				services: {
					cwd,
					agentDir,
					authStorage: world.authStorage,
					settingsManager: root.settingsManager,
					modelRegistry: world.modelRegistry,
					resourceLoader: root.session.resourceLoader,
					diagnostics: [],
				},
				diagnostics: [],
			};
		},
		{
			cwd: HARNESS_PROJECT_CWD,
			agentDir: world.agentDir,
			sessionManager: world.createSessionManager(),
			// The runtime's disposal warnings are recorded apart from the mode's and every witness asserts them (none in normal order).
			onTerminalWarnings: (released) => {
				disposalWarnings.push(...released);
			},
		},
	);
	// The listeners the mode arms are recorded, not installed: the witness does not own the worker's signals.
	const install = (name: string, handler: (...args: never[]) => void): (() => void) => {
		const entry: Install = { name, handler, removed: false };
		installs.push(entry);
		return () => {
			if (entry.removed) return;
			entry.removed = true;
			if (!isSignalName(name)) calls.push(`guard.removed:${name}`);
		};
	};
	const mode = new InteractiveMode(runtime, {
		terminalWarnings,
		hasHumanAudience: false,
		terminal,
		signalIo: {
			exit: (code) => {
				exits.push(code);
				exited.release();
				if (code === 0) quitFinished.release();
			},
			stderr: (text) => {
				stderr.push(text);
			},
			stdout: (text) => {
				stdout.push(text);
			},
			prependListener: install,
			onStreamError: (stream, handler) => install(`${stream}:error`, handler),
		},
	});
	const realDispose = runtime.dispose.bind(runtime);
	runtime.dispose = async () => {
		if (options.holdDispose) {
			removedGuardsAtDispose.push(...installs.filter((i) => i.removed && !isSignalName(i.name)).map((i) => i.name));
			reached.release();
			await hold.promise;
		}
		await realDispose();
	};
	return {
		mode,
		runtime,
		terminalWarnings,
		calls,
		warnings,
		disposalWarnings,
		stderr,
		stdout,
		exits,
		installs,
		flags,
		removedGuardsAtDispose,
		reached,
		hold,
		exited,
		quitFinished,
	};
}

/**
 * Spies on the teardown owners the stop reaches, recording each call into `calls`. The real methods run, except that with `fail` the
 * footer data provider's teardown throws. The restore function puts the prototypes back.
 */
function observeTeardown(calls: string[], fail: boolean): () => void {
	const realFooterDispose = FooterComponent.prototype.dispose;
	const realFooterDataProviderDispose = FooterDataProvider.prototype.dispose;
	const realOverlayUnmount = EditorOverlayHost.prototype.unmount;
	const realSubscribe = AgentSession.prototype.subscribe;
	const realOnExtensionsChanged = AgentSession.prototype.onExtensionsChanged;
	const spies = [
		vi.spyOn(FooterComponent.prototype, "dispose").mockImplementation(function (this: FooterComponent) {
			calls.push("footer.dispose");
			realFooterDispose.call(this);
		}),
		vi.spyOn(FooterDataProvider.prototype, "dispose").mockImplementation(function (this: FooterDataProvider) {
			calls.push("footerDataProvider.dispose");
			if (fail) throw new Error(FOOTER_DATA_PROVIDER_FAILURE);
			realFooterDataProviderDispose.call(this);
		}),
		vi.spyOn(EditorOverlayHost.prototype, "unmount").mockImplementation(function (this: EditorOverlayHost) {
			calls.push("overlay.unmount");
			realOverlayUnmount.call(this);
		}),
		vi.spyOn(AgentSession.prototype, "subscribe").mockImplementation(function (
			this: AgentSession,
			listener: Parameters<AgentSession["subscribe"]>[0],
		) {
			const unsubscribe = realSubscribe.call(this, listener);
			return () => {
				calls.push("session.unsubscribe");
				unsubscribe();
			};
		}),
		vi.spyOn(AgentSession.prototype, "onExtensionsChanged").mockImplementation(function (
			this: AgentSession,
			callback: Parameters<AgentSession["onExtensionsChanged"]>[0],
		) {
			const unsubscribe = realOnExtensionsChanged.call(this, callback);
			return () => {
				calls.push("extensions.unsubscribe");
				unsubscribe();
			};
		}),
	];
	return () => {
		for (const spy of spies) spy.mockRestore();
	};
}

interface StopRun {
	readonly calls: readonly string[];
	readonly warnings: readonly string[];
	/** The messages of the failures stop rethrew: one, or each of an AggregateError's. */
	readonly failures: readonly string[];
	readonly aggregate: boolean;
	readonly disposalWarnings: readonly string[];
}

/**
 * A real InteractiveMode stopped after a start. Terminal progress is on, so stop's first group resets it on the terminal; with
 * `progressFails` that reset throws and so does the footer data provider's teardown, which runs after it. Every teardown step still runs,
 * the terminal is restored and the held warning released after it, and both failures are rethrown together.
 */
async function runInteractiveStop(world: HarnessWorld, progressFails: boolean): Promise<StopRun> {
	const harness = await createInteractiveHarness(world, { holdDispose: false });
	harness.terminalWarnings.write([INTERACTIVE_STOP_WARNING]);
	const restore = observeTeardown(harness.calls, progressFails);
	let failures: string[] = [];
	let aggregate = false;
	try {
		await withDeadline(world.trace, "interactive stop: the mode starts", harness.mode.init());
		harness.calls.length = 0;
		harness.flags.progressFails = progressFails;
		try {
			harness.mode.stop();
		} catch (error: unknown) {
			aggregate = error instanceof AggregateError;
			failures = error instanceof AggregateError ? error.errors.map(messageOf) : [messageOf(error)];
		}
	} finally {
		restore();
	}
	const stopped = { calls: [...harness.calls], warnings: [...harness.warnings], failures, aggregate };
	await harness.runtime.dispose();
	return { ...stopped, disposalWarnings: [...harness.disposalWarnings] };
}

/** A session-start extension that keeps the context the mode gives it, so the scenario can ask the mode to quit through it. */
function captureShutdownContext(capture: { shutdown?: () => void }): ExtensionFactory {
	return (pi) => {
		pi.on("session_start", (_event, ctx) => {
			capture.shutdown = () => ctx.shutdown();
		});
	};
}

interface QuitRun {
	readonly removedGuardsAtDispose: readonly string[];
	readonly stderr: readonly string[];
	readonly stdout: readonly string[];
	readonly exits: readonly number[];
	readonly disposalWarnings: readonly string[];
}

/**
 * A quit through the extension's shutdown, with the runtime dispose held: the process guards must still be armed for the dispose, so a
 * rejection in that window is reported on stderr and the quit completes with exit 0.
 */
async function runQuitWithHeldDispose(world: HarnessWorld): Promise<QuitRun> {
	const capture: { shutdown?: () => void } = {};
	const harness = await createInteractiveHarness(world, {
		holdDispose: true,
		extensionFactories: [captureShutdownContext(capture)],
	});
	await withDeadline(world.trace, "quit: the interactive mode starts", harness.mode.init());
	if (!capture.shutdown) throw new Error("the quit witness: session_start never reached the extension context");
	capture.shutdown();
	await withDeadline(world.trace, "quit: the runtime dispose is held", harness.reached.promise);
	(armedListener(harness.installs, "unhandledRejection") as (reason: unknown) => void)(fixedError(REJECTION_STACK));
	harness.hold.release();
	await withDeadline(world.trace, "quit: the process exits", harness.exited.promise, 60_000);
	return {
		removedGuardsAtDispose: harness.removedGuardsAtDispose,
		stderr: harness.stderr,
		stdout: harness.stdout,
		exits: harness.exits,
		disposalWarnings: [...harness.disposalWarnings],
	};
}

interface QuitSecondSignalRun {
	/** Signal listeners armed while the quit's runtime dispose is held. */
	readonly armedSignalsAtDispose: readonly string[];
	/** The exit codes the instant the forced listener has run. */
	readonly exitsAtSignal: readonly number[];
	/** How many times the terminal was stopped before and after the signal. */
	readonly terminalStopsBefore: number;
	readonly terminalStopsAfter: number;
	readonly stderr: readonly string[];
	/** The signals the owned tracked child and the owned untracked control child received, as the process table delivered them. */
	readonly trackedChildSignals: readonly string[];
	readonly untrackedChildSignals: readonly string[];
}

/** Two owned virtual children in the world's process table: one tracked like a detached shell child, one untracked as a control. */
interface ChildProbe {
	signalsOfTracked(): string[];
	signalsOfUntracked(): string[];
	/** The children's physical close and the lifecycle's untracking, kept apart from the signal delivery they follow. */
	release(): void;
}

function probeChildren(world: HarnessWorld): ChildProbe {
	const table = world.processTable;
	const trackedPid = table.registerChild({ detached: true, deliver: () => {} });
	const untrackedPid = table.registerChild({ detached: true, deliver: () => {} });
	const handle = { pid: trackedPid, exitCode: null, signalCode: null };
	trackDetachedChild(handle);
	const signalsOf = (pid: number): string[] =>
		table.delivered.filter((entry) => entry.pid === pid).map((entry) => entry.signal);
	return {
		signalsOfTracked: () => signalsOf(trackedPid),
		signalsOfUntracked: () => signalsOf(untrackedPid),
		release: () => {
			untrackDetachedChild(handle);
			table.releaseChild(trackedPid);
			table.releaseChild(untrackedPid);
		},
	};
}

/**
 * A quit with the runtime dispose held, then a second signal on its own live held quit: the forced listener must be armed on the quit
 * path too, exit with the signal's status (128 + signal), kill the tracked child (SIGKILL; the untracked control child receives none)
 * and not stop the terminal a second time (the quit's own stop already ran). Delivery is acceptance, not death: both children are
 * released (physically closed) afterwards, and the held quit then finishes by itself.
 */
async function runQuitSecondSignal(world: HarnessWorld, signal: "SIGTERM" | "SIGINT"): Promise<QuitSecondSignalRun> {
	const capture: { shutdown?: () => void } = {};
	const harness = await createInteractiveHarness(world, {
		holdDispose: true,
		extensionFactories: [captureShutdownContext(capture)],
	});
	await withDeadline(world.trace, `quit ${signal}: the interactive mode starts`, harness.mode.init());
	if (!capture.shutdown)
		throw new Error("the quit second-signal witness: session_start never reached the extension context");
	const children = probeChildren(world);
	capture.shutdown();
	try {
		await withDeadline(world.trace, `quit ${signal}: the runtime dispose is held`, harness.reached.promise);
		const armedSignalsAtDispose = armedNames(harness.installs).filter(isSignalName);
		const terminalStopsBefore = harness.calls.filter((call) => call === "terminal.stop").length;
		(armedListener(harness.installs, signal) as () => void)();
		return {
			armedSignalsAtDispose,
			exitsAtSignal: [...harness.exits],
			terminalStopsBefore,
			terminalStopsAfter: harness.calls.filter((call) => call === "terminal.stop").length,
			stderr: [...harness.stderr],
			trackedChildSignals: children.signalsOfTracked(),
			untrackedChildSignals: children.signalsOfUntracked(),
		};
	} finally {
		harness.hold.release();
		await withDeadline(world.trace, `quit ${signal}: the quit finishes`, harness.quitFinished.promise, 60_000);
		children.release();
	}
}

interface QuitCrashRun {
	/** The terminal stops before and after the uncaught exception that lands while the held dispose waits. */
	readonly terminalStopsBefore: number;
	readonly terminalStopsAfter: number;
	/** The exit codes the instant the crash has been reported, before the held quit resumes. */
	readonly exitsAtCrash: readonly number[];
	readonly stderr: readonly string[];
	/** The signals the tracked child and the untracked control child received by the time the crash was reported. */
	readonly trackedChildSignals: readonly string[];
	readonly untrackedChildSignals: readonly string[];
}

/**
 * A quit whose runtime dispose is held after its stop already ran (the interactive order stops the terminal, then disposes), then an
 * uncaught exception. The crash branch reports, exits 1 and does not stop the terminal again: stop-once covers this branch too.
 */
async function runQuitCrashAfterStop(world: HarnessWorld): Promise<QuitCrashRun> {
	const capture: { shutdown?: () => void } = {};
	const harness = await createInteractiveHarness(world, {
		holdDispose: true,
		extensionFactories: [captureShutdownContext(capture)],
	});
	await withDeadline(world.trace, "quit crash: the interactive mode starts", harness.mode.init());
	if (!capture.shutdown) throw new Error("the quit crash witness: session_start never reached the extension context");
	const children = probeChildren(world);
	capture.shutdown();
	try {
		await withDeadline(world.trace, "quit crash: the runtime dispose is held", harness.reached.promise);
		const terminalStopsBefore = harness.calls.filter((call) => call === "terminal.stop").length;
		(armedListener(harness.installs, "uncaughtException") as (value: unknown) => void)(fixedError(CRASH_STACK));
		return {
			terminalStopsBefore,
			terminalStopsAfter: harness.calls.filter((call) => call === "terminal.stop").length,
			exitsAtCrash: [...harness.exits],
			stderr: [...harness.stderr],
			trackedChildSignals: children.signalsOfTracked(),
			untrackedChildSignals: children.signalsOfUntracked(),
		};
	} finally {
		// The injected exit returned, so the held quit is still unfinished: release it and join it after the observation above was copied.
		harness.hold.release();
		await withDeadline(world.trace, "quit crash: the quit finishes", harness.quitFinished.promise, 60_000);
		children.release();
	}
}

/** Undici's promise close calls this.close(callback): only the outer promise call may be held or decorated. */
function observeDispatcherClose(
	dispatcher: undici.Dispatcher,
	wrap: (settleNative: () => Promise<void>) => Promise<void>,
): Mock<undici.Dispatcher["close"]> {
	const nativeClose = dispatcher.close.bind(dispatcher);
	function close(callback: () => void): void;
	function close(): Promise<void>;
	function close(callback?: () => void): void | Promise<void> {
		if (callback !== undefined) return nativeClose(callback);
		return wrap(() => nativeClose());
	}
	return vi.spyOn(dispatcher, "close").mockImplementation(close);
}

/** Application retirement and Undici's internal callback delegation are distinct calls to the same overloaded public method. */
function dispatcherCloseCount(
	spy: Mock<undici.Dispatcher["close"]>,
	overload: "promise" | "callback" = "promise",
): number {
	return spy.mock.calls.filter((args: readonly unknown[]) =>
		overload === "promise" ? args.length === 0 : args.length === 1 && typeof args[0] === "function",
	).length;
}

interface HttpInstallRun {
	/** Production replaced the global fetch during the mode's init, and every replacement was undici's own fetch. */
	readonly replacementsAreUndiciFetch: boolean;
	readonly replacements: number;
	/** A caller-created dispatcher is never retired by the production owner. */
	readonly foreignDispatcherKept: boolean;
	readonly installedDispatcherIsNew: boolean;
	/** A second application supersedes the first installed dispatcher, which is then closed; the new one is open. */
	readonly supersededClosed: boolean;
	readonly currentOpen: boolean;
	readonly pendingRetirementKeepsSettingsSynchronous: boolean;
	readonly rejectedCloseCauseKept: boolean;
	readonly retirementFailureDrainedOnce: boolean;
	readonly finalOwnedCloseSettled: boolean;
	readonly callerReplacementKeptAtDispose: boolean;
	readonly failedInstallPreservesOwnerAndRetiresNewPool: boolean;
	readonly callerTakeoverRestoredAfterReconfigure: boolean;
	readonly disposalTimeoutKeptLateCloseCause: boolean;
	readonly invalidDisposalTimeoutKeepsOwnership: boolean;
	readonly disposalTimeoutKeptRecordedCloseCause: boolean;
	readonly nativeCallbackDelegationPreserved: boolean;
}

/**
 * The real mode's init applies the HTTP dispatcher settings: the world records the fetch replacement that `undici.install()` attempts (and does
 * not install it), and the dispatcher lifecycle follows the owner's contract: each application closes only the dispatcher it installed before.
 */
async function runHttpInstall(world: HarnessWorld): Promise<HttpInstallRun> {
	await disposeHttpDispatcher();
	const previous = undici.getGlobalDispatcher();
	const foreign = new undici.Agent();
	const foreignClose = vi.spyOn(foreign, "close");
	const takeover = new undici.Agent();
	const takeoverClose = vi.spyOn(takeover, "close");
	undici.setGlobalDispatcher(foreign);
	const effectsBefore = world.guard.effects.length;
	let harness: InteractiveHarness | undefined;
	const failures: unknown[] = [];
	const closeSpies: Array<{ mockRestore(): void }> = [];
	const holdClose = createBarrier();
	const closeReached = createBarrier();
	const timeoutCloseHold = createBarrier();
	let result: HttpInstallRun | undefined;
	try {
		harness = await createInteractiveHarness(world, { holdDispose: false });
		await withDeadline(world.trace, "http install: the interactive mode starts", harness.mode.init());
		const replacements = world.guard.effects
			.slice(effectsBefore)
			.filter((effect) => effect.kind === "globalThis.fetch");
		const installed = undici.getGlobalDispatcher();
		const installedClose = observeDispatcherClose(installed, (settleNative) => {
			closeReached.release();
			return holdClose.promise.then(settleNative);
		});
		closeSpies.push(installedClose);
		configureHttpDispatcher();
		const current = undici.getGlobalDispatcher();
		const currentClose = vi.spyOn(current, "close");
		closeSpies.push(currentClose);
		let retirementSettled = false;
		const retirement = awaitHttpDispatcherRetirements().then(() => {
			retirementSettled = true;
		});
		await withDeadline(world.trace, "http install: close reaches its held boundary", closeReached.promise);
		const pendingRetirementKeepsSettingsSynchronous = current !== installed && !retirementSettled;
		process.stderr.write(
			`[http-close] release heapMiB=${Math.round(process.memoryUsage().heapUsed / (1024 * 1024))}\n`,
		);
		holdClose.release();
		await withDeadline(world.trace, "http install: the superseded pool settles", retirement);
		process.stderr.write(
			`[http-close] settled heapMiB=${Math.round(process.memoryUsage().heapUsed / (1024 * 1024))}\n`,
		);
		const closeResult = installedClose.mock.results[0];
		if (closeResult?.type !== "return" || !(closeResult.value instanceof Promise)) {
			throw new Error("HTTP install witness: graceful retirement returned no settlement promise");
		}
		await withDeadline(world.trace, "http install: the actual close promise settles", closeResult.value);
		const currentOpen = currentClose.mock.calls.length === 0;
		currentClose.mockRestore();
		const closeFailure = new Error("HTTP install witness: graceful close failed after settling the owned pool");
		const rejectingClose = observeDispatcherClose(current, async (settleNative) => {
			await settleNative();
			throw closeFailure;
		});
		closeSpies.push(rejectingClose);
		configureHttpDispatcher();
		let rejectedCloseCauseKept = false;
		try {
			await withDeadline(
				world.trace,
				"http install: rejected close reaches the owner",
				awaitHttpDispatcherRetirements(),
			);
		} catch (error) {
			rejectedCloseCauseKept =
				error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === closeFailure;
		}
		await withDeadline(
			world.trace,
			"http install: the reported failure is drained once",
			awaitHttpDispatcherRetirements(),
		);
		const displacedOwned = undici.getGlobalDispatcher();
		const displacedClose = vi.spyOn(displacedOwned, "close");
		closeSpies.push(displacedClose);
		undici.setGlobalDispatcher(takeover);
		configureHttpDispatcher();
		const finalOwned = undici.getGlobalDispatcher();
		await withDeadline(
			world.trace,
			"http install: takeover still retires the displaced owned pool",
			awaitHttpDispatcherRetirements(),
		);
		const displacedCloseResult = displacedClose.mock.results[0];
		if (displacedCloseResult?.type !== "return" || !(displacedCloseResult.value instanceof Promise)) {
			throw new Error("HTTP install witness: displaced owned close returned no settlement promise");
		}
		await withDeadline(world.trace, "http install: displaced owned close settles", displacedCloseResult.value);
		const headersDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Headers");
		const installFailure = new Error("HTTP install witness: Headers installation refused");
		let failedPoolClose: Mock<undici.Dispatcher["close"]> | undefined;
		let installCauseKept = false;
		try {
			Object.defineProperty(globalThis, "Headers", {
				configurable: true,
				get: () => headersDescriptor?.value,
				set: () => {
					failedPoolClose = vi.spyOn(undici.getGlobalDispatcher(), "close");
					closeSpies.push(failedPoolClose);
					throw installFailure;
				},
			});
			try {
				configureHttpDispatcher();
			} catch (error) {
				installCauseKept = error === installFailure;
			}
		} finally {
			if (headersDescriptor) Object.defineProperty(globalThis, "Headers", headersDescriptor);
			else Reflect.deleteProperty(globalThis, "Headers");
		}
		await withDeadline(
			world.trace,
			"http install: failed installation's new pool settles",
			awaitHttpDispatcherRetirements(),
		);
		const failedInstallPreservesOwnerAndRetiresNewPool =
			installCauseKept &&
			undici.getGlobalDispatcher() === finalOwned &&
			failedPoolClose !== undefined &&
			dispatcherCloseCount(failedPoolClose) === 1;
		const finalClose = vi.spyOn(finalOwned, "close");
		closeSpies.push(finalClose);
		await withDeadline(world.trace, "http install: final owned pool settles at shutdown", disposeHttpDispatcher());
		const finalCloseResult = finalClose.mock.results[0];
		if (finalCloseResult?.type !== "return" || !(finalCloseResult.value instanceof Promise)) {
			throw new Error("HTTP install witness: final graceful close returned no settlement promise");
		}
		await withDeadline(world.trace, "http install: final actual close promise settles", finalCloseResult.value);
		const callerTakeoverRestoredAfterReconfigure =
			undici.getGlobalDispatcher() === takeover &&
			takeoverClose.mock.calls.length === 0 &&
			foreignClose.mock.calls.length === 0 &&
			dispatcherCloseCount(displacedClose) === 1 &&
			finalOwned !== displacedOwned &&
			finalOwned !== takeover;
		configureHttpDispatcher();
		const externallyReplacedOwned = undici.getGlobalDispatcher();
		const externallyReplacedClose = vi.spyOn(externallyReplacedOwned, "close");
		closeSpies.push(externallyReplacedClose);
		undici.setGlobalDispatcher(foreign);
		await withDeadline(
			world.trace,
			"http install: caller replacement keeps global ownership at disposal",
			disposeHttpDispatcher(),
		);
		const callerReplacementKeptAtDispose =
			undici.getGlobalDispatcher() === foreign && foreignClose.mock.calls.length === 0;
		configureHttpDispatcher();
		const failedBeforeTimeoutOwned = undici.getGlobalDispatcher();
		const recordedCloseFailure = new Error(
			"HTTP install witness: recorded close failure before another pool times out",
		);
		const recordedCloseReached = createBarrier();
		const recordedFailureClose = observeDispatcherClose(failedBeforeTimeoutOwned, async (settleNative) => {
			recordedCloseReached.release();
			await settleNative();
			throw recordedCloseFailure;
		});
		closeSpies.push(recordedFailureClose);
		configureHttpDispatcher();
		await withDeadline(world.trace, "http install: earlier close reaches its boundary", recordedCloseReached.promise);
		const recordedFailureResult = recordedFailureClose.mock.results[0];
		if (recordedFailureResult?.type !== "return" || !(recordedFailureResult.value instanceof Promise)) {
			throw new Error("HTTP install witness: recorded failure close returned no settlement promise");
		}
		const recordedFailureSettled = await withDeadline(
			world.trace,
			"http install: earlier real close settles with its cause",
			recordedFailureResult.value.then(
				() => false,
				(error: unknown) => error === recordedCloseFailure,
			),
		);
		const timeoutOwned = undici.getGlobalDispatcher();
		const lateCloseFailure = new Error("HTTP install witness: late close rejection after disposal timeout");
		const timeoutClose = observeDispatcherClose(timeoutOwned, async (settleNative) => {
			await timeoutCloseHold.promise;
			await settleNative();
			throw lateCloseFailure;
		});
		closeSpies.push(timeoutClose);
		let rejectedTimeouts = 0;
		for (const invalidTimeout of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
			try {
				await disposeHttpDispatcher(invalidTimeout);
			} catch (error) {
				if (error instanceof RangeError) rejectedTimeouts++;
			}
		}
		const invalidDisposalTimeoutKeepsOwnership =
			rejectedTimeouts === 4 &&
			undici.getGlobalDispatcher() === timeoutOwned &&
			timeoutClose.mock.calls.length === 0;
		let timeoutReported = false;
		let recordedCauseReported = false;
		try {
			await withDeadline(
				world.trace,
				"http install: held final close reaches disposal timeout",
				disposeHttpDispatcher(1),
			);
		} catch (error) {
			timeoutReported =
				error instanceof AggregateError &&
				error.errors.length === 2 &&
				error.errors[0] instanceof Error &&
				error.errors[0].message ===
					"HTTP dispatcher disposal timed out after 1ms; 1 graceful close(s) remain pending";
			recordedCauseReported = error instanceof AggregateError && error.errors[1] === recordedCloseFailure;
		}
		timeoutCloseHold.release();
		let lateCauseKept = false;
		try {
			await withDeadline(
				world.trace,
				"http install: late close rejection remains reportable",
				awaitHttpDispatcherRetirements(),
			);
		} catch (error) {
			lateCauseKept =
				error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === lateCloseFailure;
		}
		await withDeadline(world.trace, "http install: late close cause drains once", awaitHttpDispatcherRetirements());
		result = {
			replacementsAreUndiciFetch:
				replacements.length > 0 && replacements.every((effect) => effect.arguments[0] === undici.fetch),
			replacements: replacements.length,
			foreignDispatcherKept: foreignClose.mock.calls.length === 0 && installed !== foreign,
			installedDispatcherIsNew: installed !== foreign && current !== installed,
			supersededClosed: dispatcherCloseCount(installedClose) === 1,
			currentOpen,
			pendingRetirementKeepsSettingsSynchronous,
			rejectedCloseCauseKept,
			retirementFailureDrainedOnce: dispatcherCloseCount(rejectingClose) === 1,
			finalOwnedCloseSettled:
				dispatcherCloseCount(finalClose) === 1 && dispatcherCloseCount(externallyReplacedClose) === 1,
			callerReplacementKeptAtDispose,
			failedInstallPreservesOwnerAndRetiresNewPool,
			callerTakeoverRestoredAfterReconfigure,
			disposalTimeoutKeptLateCloseCause:
				timeoutReported && lateCauseKept && dispatcherCloseCount(timeoutClose) === 1,
			invalidDisposalTimeoutKeepsOwnership,
			disposalTimeoutKeptRecordedCloseCause:
				recordedFailureSettled && recordedCauseReported && dispatcherCloseCount(recordedFailureClose) === 1,
			nativeCallbackDelegationPreserved: [installedClose, rejectingClose, recordedFailureClose, timeoutClose].every(
				(spy) => dispatcherCloseCount(spy, "callback") === 1,
			),
		};
	} catch (error) {
		failures.push(error);
	} finally {
		holdClose.release();
		timeoutCloseHold.release();
		for (const cleanup of [
			() => harness?.mode.stop(),
			() => harness?.runtime.dispose(),
			() => disposeHttpDispatcher(),
			() => {
				for (const spy of closeSpies) spy.mockRestore();
				foreignClose.mockRestore();
				undici.setGlobalDispatcher(previous);
				return foreign.close();
			},
			() => {
				takeoverClose.mockRestore();
				return takeover.close();
			},
		]) {
			try {
				await cleanup();
			} catch (error) {
				failures.push(error);
			}
		}
	}
	if (failures.length > 0) throw new AggregateError(failures, "HTTP install witness failed");
	if (!result) throw new Error("HTTP install witness produced no observation");
	return result;
}

/** An extension that holds every run at `before_agent_start`: after the submission has its lease, before any provider request. */
function holdBeforeAgentStart(hold: Barrier, reached: Barrier): ExtensionFactory {
	return (pi) => {
		pi.on("before_agent_start", async () => {
			reached.release();
			await hold.promise;
		});
	};
}

interface ClosingGateStartRun {
	readonly requestsAddedByRelease: number;
	/** What the file gained after the release (empty when nothing was written), cut for evidence. */
	readonly fileGrowthByRelease: string;
	readonly startOutcome: string;
	readonly controlCommitted: boolean;
}

/** What the file gained between two reads (empty when nothing was written), cut for evidence; a rewrite is marked instead. */
function fileGrowthSince(before: string, after: string): string {
	return after.startsWith(before)
		? after.slice(before.length).slice(0, 600)
		: `<the file was rewritten> ${after.slice(0, 300)}`;
}

/**
 * Quit while a run is held at `before_agent_start`. After the release the submission reaches its preflight cancellation check
 * (agent-session.ts `submissionSignal.aborted`, which the quit has set) and returns before any run, so no provider request is made, the
 * file gains nothing and the prompt resolves. That check is the guard reached: the closing gate in foreground-recovery-controller.ts is
 * behind it, and no public hold point sits between the two, so this does not isolate the closing gate. The control releases before the
 * quit and commits its reply.
 */
async function runClosingGateAtStart(world: HarnessWorld): Promise<ClosingGateStartRun> {
	const { trace } = world;
	const hold = createBarrier();
	const reached = createBarrier();
	const held = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: { memorySystem: undefined },
		extensionFactories: [holdBeforeAgentStart(hold, reached)],
	});
	const heldSession = held.session;
	await heldSession.bindExtensions({ uiContext: world.humanInput.ui });
	const heldFile = held.sessionManager.getSessionFile();
	if (heldFile === undefined) throw new Error("the held start owner has no file");
	const start = heldSession.prompt("Start a run the extension holds before it begins.").then(
		() => "resolved",
		(error: unknown) => messageOf(error),
	);
	await withDeadline(trace, "closing gate: the extension holds the start", reached.promise);
	await withDeadline(
		trace,
		"closing gate: the owner disposes while the start is held",
		heldSession.disposeAndWait(),
		60_000,
	);
	const fileAtQuit = world.io.peekFile(heldFile) ?? "";
	const requestsAtQuit = world.provider.requests.length;
	hold.release();
	const startOutcome = await withDeadline(trace, "closing gate: the held start settles", start, 60_000);
	const requestsAddedByRelease = world.provider.requests.length - requestsAtQuit;
	const fileAfterRelease = world.io.peekFile(heldFile) ?? "";
	const fileGrowthByRelease = fileGrowthSince(fileAtQuit, fileAfterRelease);

	// Normal order: the start is released before the quit, so the run reaches its provider and commits through the same owner.
	const released = createBarrier();
	released.release();
	const control = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: { memorySystem: undefined },
		extensionFactories: [holdBeforeAgentStart(released, createBarrier())],
	});
	await control.session.bindExtensions({ uiContext: world.humanInput.ui });
	const controlFile = control.sessionManager.getSessionFile();
	if (controlFile === undefined) throw new Error("the closing gate control owner has no file");
	world.provider.enqueue("root", {
		name: "closing-gate-control",
		reply: { content: [{ type: "text", text: CLOSING_GATE_CONTROL_REPLY }] },
	});
	await withDeadline(trace, "closing gate control: the run completes", control.session.prompt("Run the control."));
	await world.disposeSessionInBody(control.session);
	return {
		requestsAddedByRelease,
		fileGrowthByRelease,
		startOutcome,
		controlCommitted: (world.io.peekFile(controlFile) ?? "").includes(CLOSING_GATE_CONTROL_REPLY),
	};
}

interface CalibrationGateRun {
	/** The baseline turn's reply is in the persisted file before the calibration boundary is armed. */
	readonly baselinePersisted: boolean;
	/** The quit ran inside the calibration warning, which preparation emits before the run's provider request. */
	readonly quitReached: boolean;
	/** The run the quit landed in was admitted (one active run), and its owner was not yet shut down. */
	readonly activeRunsAtQuit: number;
	readonly shutdownBeforeQuit: boolean;
	readonly shutdownAfterQuit: boolean;
	readonly requestsAddedByQuit: number;
	readonly messagesAddedByQuit: number;
	readonly fileGrowthByQuit: string;
	/** The warnings the quit's run emitted, claimed here and removed from the world's allowance check. */
	readonly quitWarnings: readonly string[];
	readonly startOutcome: string;
	readonly disposal: string;
	readonly controlRequestModels: readonly string[];
	readonly controlWarnings: readonly string[];
	readonly controlCommitted: boolean;
}

/**
 * Seeds the production model-adaptation store with a `text-protocol` tool verdict that has no calibration, so the first run's preparation
 * (`ToolProtocolController.ensureActiveModelProtocol`) reports `probe_calibration_missing`. The fresh `probedAt` keeps auto-probing off.
 */
function seedCalibrationMissing(agentDir: string): void {
	ModelAdaptationStore.forAgentDir(agentDir).save(`${HARNESS_PROVIDER}/root`, {
		rules: [],
		teachStats: {},
		toolProbe: { version: 1, status: "text-protocol", probedAt: new Date().toISOString() },
	});
}

/**
 * Quit from inside a run's preparation. The calibration warning is emitted synchronously by `prepareRun()`, after the run was admitted and
 * before `runAgentExecution`'s closing gate (foreground-recovery-controller.ts, the first check after `prepareRun()`). The listener disposes
 * the session at that point, so the gate is the first check that sees the quit: it returns before `agent.prompt()`, so no provider request
 * is made and no message enters the agent. The control is the same setup with no quit: the run passes the gate and answers.
 */
async function runClosingGateAtCalibration(world: HarnessWorld): Promise<CalibrationGateRun> {
	const { trace } = world;
	// Its own agent directory: the seeded verdict must not reach the journey's later turns on the same model.
	const agentDir = `${world.agentDir}-calibration-gate`;
	const held = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings: { memorySystem: undefined },
	});
	const heldSession = held.session;
	await heldSession.bindExtensions({ uiContext: world.humanInput.ui });
	const heldFile = held.sessionManager.getSessionFile();
	if (heldFile === undefined) throw new Error("the calibration gate owner has no file");
	// A never-created file cannot prove preservation: a normal turn persists a baseline first, then the verdict is seeded so the NEXT
	// run's preparation reports the missing calibration (preparation reads the store on every run).
	world.provider.enqueue("root", {
		name: "calibration-gate-baseline",
		reply: { content: [{ type: "text", text: CALIBRATION_BASELINE_REPLY }] },
	});
	world.systemOne.enterPhase("mode-calibration-baseline", {});
	await withDeadline(
		trace,
		"calibration gate: the baseline turn completes",
		heldSession.prompt(CALIBRATION_RUN_PROMPT),
	);
	const baselinePersisted = (world.io.peekFile(heldFile) ?? "").includes(CALIBRATION_BASELINE_REPLY);
	seedCalibrationMissing(agentDir);
	const mark = world.warnings.length;
	let quitReached = false;
	let activeRunsAtQuit = 0;
	let shutdownBeforeQuit = false;
	let shutdownAfterQuit = false;
	let requestsAtQuit = 0;
	let messagesAtQuit = 0;
	let fileAtQuit = "";
	let quit: Promise<string> | undefined;
	heldSession.subscribe((event) => {
		if (quitReached || event.type !== "warning" || event.message !== CALIBRATION_WARNING) return;
		quitReached = true;
		const before = heldSession.getResourceSnapshot().foregroundRecovery;
		activeRunsAtQuit = before.activeRuns;
		shutdownBeforeQuit = before.shutdown;
		requestsAtQuit = world.provider.requests.length;
		messagesAtQuit = heldSession.state.messages.length;
		fileAtQuit = world.io.peekFile(heldFile) ?? "";
		// `disposeAndWait()` runs its shutdown synchronously before its first await, so the closing state is read right after the call.
		quit = disposed(heldSession);
		shutdownAfterQuit = heldSession.getResourceSnapshot().foregroundRecovery.shutdown;
	});
	enterNeutralModeIntake(world, "mode-calibration-backlog", CALIBRATION_RUN_PROMPT, true);
	const start = heldSession.prompt(CALIBRATION_RUN_PROMPT).then(
		() => "resolved",
		(error: unknown) => messageOf(error),
	);
	const startOutcome = await withDeadline(trace, "calibration gate: the held start settles", start, 60_000);
	const disposal = await withDeadline(
		trace,
		"calibration gate: the quit completes",
		quit ?? disposed(heldSession),
		60_000,
	);
	// Claimed after the quit completes, so the disclosures the dispose itself writes are part of what is claimed.
	const quitWarnings = world.warnings.splice(mark);
	const requestsAddedByQuit = world.provider.requests.length - requestsAtQuit;
	const messagesAddedByQuit = heldSession.state.messages.length - messagesAtQuit;
	const fileGrowthByQuit = fileGrowthSince(fileAtQuit, world.io.peekFile(heldFile) ?? "");

	// Normal order: the same setup with no quit. The run passes the gate, makes its one provider request on the root track and commits.
	const control = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings: { memorySystem: undefined },
	});
	await control.session.bindExtensions({ uiContext: world.humanInput.ui });
	const controlFile = control.sessionManager.getSessionFile();
	if (controlFile === undefined) throw new Error("the calibration gate control owner has no file");
	const controlMark = world.warnings.length;
	const controlRequestMark = world.provider.requests.length;
	world.provider.enqueue("root", {
		name: "calibration-gate-control",
		reply: { content: [{ type: "text", text: CLOSING_GATE_CONTROL_REPLY }] },
	});
	world.systemOne.enterPhase("mode-calibration-control", {});
	await withDeadline(
		trace,
		"calibration gate control: the run completes",
		control.session.prompt(CALIBRATION_RUN_PROMPT),
	);
	const controlWarnings = world.warnings.splice(controlMark);
	const controlRequestModels = world.provider.requests.slice(controlRequestMark).map((request) => request.model.id);
	await world.disposeSessionInBody(control.session);
	return {
		baselinePersisted,
		quitReached,
		activeRunsAtQuit,
		shutdownBeforeQuit,
		shutdownAfterQuit,
		requestsAddedByQuit,
		messagesAddedByQuit,
		fileGrowthByQuit,
		quitWarnings,
		startOutcome,
		disposal,
		controlRequestModels,
		controlWarnings,
		controlCommitted: (world.io.peekFile(controlFile) ?? "").includes(CLOSING_GATE_CONTROL_REPLY),
	};
}

/** Disposes a session and reports how it settled, so a failed quit is an observed outcome instead of an unhandled rejection. */
function disposed(session: AgentSession): Promise<string> {
	return session.disposeAndWait().then(
		() => "disposed",
		(error: unknown) => messageOf(error),
	);
}

/**
 * Runs every mode witness and asserts each outcome. The expected values are written here from the production order and texts; none
 * is read back from a run.
 */
export async function verifyModeWitnesses(world: HarnessWorld): Promise<void> {
	// The real InteractiveMode installs process-global keybindings and a theme (and may start a theme file watcher): the previous
	// keybindings are restored and the watcher stopped when the witnesses end, so nothing leaks into the other journeys.
	const previousKeybindings = getKeybindings();
	try {
		await verifyModeWitnessesBody(world);
	} finally {
		setKeybindings(previousKeybindings);
		stopThemeWatcher();
	}
}

async function verifyModeWitnessesBody(world: HarnessWorld): Promise<void> {
	const signalsArmed = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	const shutdownLog = ["dispose", "drain", "stop"];

	const control = await runGuardControl();
	expect(control.guardsAtDispose, "the process guards stay armed while the signal path's dispose runs").toEqual(
		GUARD_ARMED,
	);
	expect(control.forcesAtDispose, "the second-signal listeners are armed for the signal path's cleanup").toEqual(
		signalsArmed,
	);
	expect(control.log, "a signal shutdown disposes, drains, then stops").toEqual(shutdownLog);
	expect(control.warnings, "the warning held through the dispose is released by stop").toEqual([
		GUARD_CLOSING_WARNING,
	]);
	expect(control.stderr, "a clean signal shutdown writes nothing to stderr").toEqual([]);
	expect(control.exits, "a clean signal shutdown exits 0").toEqual([0]);
	expect(control.forcesAtEnd, "the second-signal listeners are removed on the normal exit path").toEqual([]);
	expect(control.guardsAtEnd, "the process guards stay armed until the process exits").toEqual(GUARD_ARMED);

	const rejection = await runGuardRejection();
	expect(rejection.guardsAtDispose, "a rejection during the held dispose meets the armed guard").toEqual(GUARD_ARMED);
	expect(rejection.stderr, "the rejection is reported escaped on stderr while the shutdown continues").toEqual([
		REJECTION_LINE,
	]);
	expect(rejection.log, "the shutdown completes after the rejection").toEqual(shutdownLog);
	expect(rejection.exits, "the shutdown exits 0 after the rejection").toEqual([0]);

	const crash = await runGuardCrash(fixedError(CRASH_STACK), { stopFails: false });
	expect(crash.log, "a crash during the held dispose stops the terminal and no further step runs").toEqual([
		"dispose",
		"stop",
	]);
	expect(crash.warnings, "stop releases the warning held through the dispose before the crash is reported").toEqual([
		GUARD_CLOSING_WARNING,
	]);
	expect(crash.stderr, "the crash is reported with its stack").toEqual([CRASH_LINE]);
	expect(crash.exits, "a crash during shutdown exits 1").toEqual([1]);

	// A non-Error throw is wrapped before it is reported: the report and the exit both still happen.
	const stringCrash = await runGuardCrash("boom", { stopFails: false });
	expect(stringCrash.stderr, "a string thrown during shutdown is reported").toHaveLength(1);
	expect(stringCrash.stderr[0], "a string thrown during shutdown is reported as an Error").toMatch(
		/^pi exiting due to uncaughtException during shutdown: Error: boom/,
	);
	expect(stringCrash.exits, "a string thrown during shutdown exits 1").toEqual([1]);

	// An Error whose stack cannot be read and whose message is not text is reported by its message's plain text, and the exit still happens.
	const stacklessCrash = await runGuardCrash(stacklessError(), { stopFails: false });
	expect(stacklessCrash.stderr, "an Error without a readable stack is still reported during shutdown").toEqual([
		"pi exiting due to uncaughtException during shutdown: 42\n",
	]);
	expect(stacklessCrash.exits, "an Error without a readable stack still exits 1").toEqual([1]);
	const stacklessRejection = await runGuardRejection(stacklessError());
	expect(stacklessRejection.stderr, "a rejection Error without a readable stack is still reported").toEqual([
		"Unhandled promise rejection during shutdown. 42\n",
	]);
	expect(stacklessRejection.exits, "the shutdown still completes after that rejection").toEqual([0]);

	const stopFailsCrash = await runGuardCrash(fixedError(CRASH_STACK), { stopFails: true });
	expect(stopFailsCrash.stderr, "a stop failure during a crash is reported before the crash line").toEqual([
		`Stop failed during shutdown: ${GUARD_STOP_FAILURE}\n`,
		CRASH_LINE,
	]);
	expect(stopFailsCrash.warnings, "the warning is released before the failing stop").toEqual([GUARD_CLOSING_WARNING]);
	expect(stopFailsCrash.exits, "a stop failure during a crash still exits 1").toEqual([1]);

	const sigterm = await runGuardSecondSignal("SIGTERM");
	expect(sigterm.log, "a second SIGTERM stops the terminal once and leaves the held dispose behind").toEqual([
		"dispose",
		"stop",
	]);
	expect(sigterm.warnings, "a second SIGTERM releases the held warning").toEqual([GUARD_CLOSING_WARNING]);
	expect(sigterm.stderr, "a second SIGTERM writes nothing to stderr").toEqual([]);
	expect(sigterm.exits, "a second SIGTERM exits with 128 + 15").toEqual([143]);
	if (process.platform !== "win32") {
		const sighup = await runGuardSecondSignal("SIGHUP");
		expect(sighup.exits, "a second SIGHUP exits with 128 + 1").toEqual([129]);
	}

	const twoCauses = await runGuardTwoCauses();
	expect(twoCauses.log, "every cleanup step runs after the first step fails").toEqual(shutdownLog);
	expect(twoCauses.warnings, "the held warning is released by the stop after both failures").toEqual([
		GUARD_CLOSING_WARNING,
	]);
	expect(
		twoCauses.stderr,
		"both causes share one line: the unconvertible first cause by its plain text, then the drain failure",
	).toEqual([`Shutdown failed: ${UNCONVERTIBLE_CAUSE_TEXT} (${UNCONVERTIBLE_CAUSE_TEXT}; ${GUARD_DRAIN_FAILURE})\n`]);
	expect(twoCauses.exits, "a failed signal shutdown exits 1").toEqual([1]);
	await verifyGuardCauseBounds();

	const quit = await runQuitWithHeldDispose(world);
	expect(quit.removedGuardsAtDispose, "the quit leaves the process guards armed through the held dispose").toEqual([]);
	expect(quit.stderr, "a rejection during the quit's held dispose is reported escaped").toEqual([REJECTION_LINE]);
	expect(quit.exits, "the quit completes with exit 0 after the rejection").toEqual([0]);
	expect(quit.disposalWarnings, "the quit's runtime disposal discloses nothing in normal order").toEqual([]);
	// The resume line needs a real TTY and a session file on disk; the harness's session is virtual, so none is written here.
	expect(quit.stdout, "the quit writes no resume line for a virtual session").toEqual([]);

	// Each signal reaches its own live held quit: one stop, the tracked child killed (the untracked control child untouched), exit 128 + n.
	for (const [signal, code] of [
		["SIGTERM", 143],
		["SIGINT", 130],
	] as const) {
		const forced = await runQuitSecondSignal(world, signal);
		expect(
			forced.armedSignalsAtDispose,
			`the quit's held dispose keeps the forced listeners armed (${signal})`,
		).toEqual([...signalsArmed, "SIGINT"]);
		expect(forced.exitsAtSignal, `a ${signal} during the quit exits with 128 + n`).toEqual([code]);
		expect(forced.terminalStopsAfter, `the ${signal} forced exit does not stop the terminal a second time`).toBe(
			forced.terminalStopsBefore,
		);
		expect(forced.stderr, `a ${signal} during the quit writes nothing to stderr`).toEqual([]);
		expect(forced.trackedChildSignals, `the ${signal} forced exit kills the tracked child`).toContain("SIGKILL");
		expect(forced.untrackedChildSignals, `the ${signal} forced exit leaves an untracked owned child alone`).toEqual(
			[],
		);
	}

	const crashAfterStop = await runQuitCrashAfterStop(world);
	expect(
		crashAfterStop.terminalStopsBefore,
		"the interactive quit stops the terminal before its held dispose",
	).toBeGreaterThan(0);
	expect(crashAfterStop.terminalStopsAfter, "a crash after the stop does not stop the terminal a second time").toBe(
		crashAfterStop.terminalStopsBefore,
	);
	expect(crashAfterStop.exitsAtCrash, "a crash during the held quit exits 1").toEqual([1]);
	expect(crashAfterStop.stderr, "the crash is reported with its stack, and nothing else is written").toEqual([
		CRASH_LINE,
	]);
	expect(crashAfterStop.trackedChildSignals, "a crash during shutdown kills the tracked child").toContain("SIGKILL");
	expect(
		crashAfterStop.untrackedChildSignals,
		"a crash during shutdown leaves an untracked owned child alone",
	).toEqual([]);

	const standard = await runInteractiveStop(world, false);
	expect(standard.failures, "a stop with nothing failing rethrows nothing").toEqual([]);
	expect(standard.warnings, "the held warning is released by the stop").toEqual([INTERACTIVE_STOP_WARNING]);
	expect(standard.disposalWarnings, "normal order: the runtime's own disposal discloses nothing").toEqual([]);
	expect(standard.calls, "every teardown step ran during the stop").toEqual(expect.arrayContaining(TEARDOWN_STEPS));
	expect(standard.calls, "an unattended mode owns no extensions-changed subscription to unsubscribe").not.toContain(
		ATTENDED_ONLY_TEARDOWN_STEP,
	);
	expect(standard.calls.slice(-2), "the terminal is restored, then the warnings are released").toEqual([
		"terminal.stop",
		"release",
	]);

	const httpInstall = await runHttpInstall(world);
	expect(
		httpInstall.replacements,
		"the mode's init attempts the global fetch replacement at least once",
	).toBeGreaterThan(0);
	expect(httpInstall.replacementsAreUndiciFetch, "every recorded fetch replacement is undici's own fetch").toBe(true);
	expect(httpInstall.foreignDispatcherKept, "the dispatcher found before the mode is foreign and stays open").toBe(
		true,
	);
	expect(httpInstall.installedDispatcherIsNew, "each application installs a new dispatcher").toBe(true);
	expect(httpInstall.supersededClosed, "the superseded owned dispatcher is closed").toBe(true);
	expect(httpInstall.currentOpen, "the newly installed dispatcher is open").toBe(true);
	expect(
		httpInstall.pendingRetirementKeepsSettingsSynchronous,
		"settings install a new pool while an older close is held",
	).toBe(true);
	expect(httpInstall.rejectedCloseCauseKept, "the retirement owner reports the original close rejection").toBe(true);
	expect(
		httpInstall.retirementFailureDrainedOnce,
		"the close failure is reported once and the pool retired once",
	).toBe(true);
	expect(httpInstall.finalOwnedCloseSettled, "shutdown waits for the final owned pool's actual close promise").toBe(
		true,
	);
	expect(
		httpInstall.callerReplacementKeptAtDispose,
		"shutdown leaves a caller's replacement installed and unclosed",
	).toBe(true);
	expect(
		httpInstall.failedInstallPreservesOwnerAndRetiresNewPool,
		"failed installation keeps its cause and prior owner while retiring the new pool",
	).toBe(true);
	expect(
		httpInstall.callerTakeoverRestoredAfterReconfigure,
		"reconfiguration retires the displaced owned pool and restores the latest caller takeover at disposal",
	).toBe(true);
	expect(
		httpInstall.disposalTimeoutKeptLateCloseCause,
		"a bounded final wait preserves a late close rejection for one later report",
	).toBe(true);
	expect(
		httpInstall.invalidDisposalTimeoutKeepsOwnership,
		"invalid disposal grace values leave the current owned pool intact",
	).toBe(true);
	expect(
		httpInstall.disposalTimeoutKeptRecordedCloseCause,
		"timeout reports an already recorded close cause once while retaining later failures for recovery",
	).toBe(true);
	expect(
		httpInstall.nativeCallbackDelegationPreserved,
		"each observed promise close reaches the real native callback overload exactly once",
	).toBe(true);

	const failing = await runInteractiveStop(world, true);
	expect(failing.failures, "both failing teardown steps are rethrown together, in order").toEqual([
		INTERACTIVE_STOP_FAILURE,
		FOOTER_DATA_PROVIDER_FAILURE,
	]);
	expect(failing.aggregate, "two failures are rethrown as an AggregateError").toBe(true);
	expect(failing.calls, "every teardown step still ran after the failing progress reset").toEqual(
		expect.arrayContaining(TEARDOWN_STEPS),
	);
	expect(
		failing.calls.lastIndexOf("footer.dispose"),
		"the footer's teardown runs after the failing progress reset",
	).toBeGreaterThan(failing.calls.indexOf("terminal.setProgress"));
	expect(
		failing.calls.slice(-2),
		"the terminal is restored after the failures, then the warnings are released",
	).toEqual(["terminal.stop", "release"]);
	expect(failing.warnings, "the held warning is released even though a teardown step failed").toEqual([
		INTERACTIVE_STOP_WARNING,
	]);
	expect(failing.disposalWarnings, "a failing teardown step adds no runtime disposal disclosure").toEqual([]);

	const gate = await runClosingGateAtStart(world);
	expect(gate.requestsAddedByRelease, "a quit-cancelled start makes no provider request after the release").toBe(0);
	expect(gate.fileGrowthByRelease, "the file gains nothing after the release (any growth is printed here)").toBe("");
	expect(gate.startOutcome, "the held prompt resolves after the release").toBe("resolved");
	expect(gate.controlCommitted, "the control released before the quit commits its reply").toBe(true);

	const calibration = await runClosingGateAtCalibration(world);
	expect(calibration.baselinePersisted, "a nonempty persisted baseline exists before the quit is armed").toBe(true);
	expect(calibration.quitReached, "the held run's calibration warning is reached and the quit starts there").toBe(
		true,
	);
	expect(calibration.activeRunsAtQuit, "the quit lands in an admitted run before any provider request").toBe(1);
	expect(calibration.shutdownBeforeQuit, "the owner is still open when the calibration warning is emitted").toBe(
		false,
	);
	expect(
		calibration.shutdownAfterQuit,
		"the quit shuts the owner down synchronously, inside the run's preparation",
	).toBe(true);
	expect(calibration.requestsAddedByQuit, "a quit inside the closing gate makes no provider request").toBe(0);
	expect(calibration.messagesAddedByQuit, "a quit inside the closing gate admits no message to the agent").toBe(0);
	expect(calibration.fileGrowthByQuit, "the file gains nothing after the quit (any growth is printed here)").toBe("");
	expect(calibration.quitWarnings, "the quit's run discloses exactly the calibration warning").toEqual([
		CALIBRATION_WARNING,
	]);
	expect(calibration.startOutcome, "the held prompt resolves after the quit").toBe("resolved");
	expect(calibration.disposal, "the quit completes").toBe("disposed");
	expect(
		calibration.controlRequestModels,
		"normal order: the run makes one provider request, on the root track",
	).toEqual(["root"]);
	expect(calibration.controlWarnings, "normal order: the run discloses exactly the calibration warning").toEqual([
		CALIBRATION_WARNING,
	]);
	expect(calibration.controlCommitted, "normal order: the run's reply is committed").toBe(true);

	await verifyAccountListingRefusal(world);
	await verifyRetryClosingAndUnicodeQueue(world);
	await verifyBillingContinuation(world);
	await verifyPrintOwner(world);
}

/** The account the listing describes: the synthetic token carries its claim, and nothing signs or verifies it. */
const ACCOUNT_LISTING_ACCOUNT_ID = "acct-listing-witness";
/** The provider whose account the catalog checks. Its models are the scripted tracks, registered for this witness only. */
const ACCOUNT_PROVIDER = "openai-codex";
const ACCOUNT_BASE_URL = "https://harness.invalid";
const ACCOUNT_REFUSAL = "model is not supported when using Codex with a ChatGPT account";
const ACCOUNT_REFUSED_PROMPT = "Run the refused turn.";
const ACCOUNT_BASELINE_REPLY = "The account baseline reply.";
const ACCOUNT_ROOT_REPLY = "The account continuation reply.";
/** The warning the session emits when the refusal moves it to the account default, which the listing offers after the refused model. */
const ACCOUNT_SWITCH_WARNING = `${ACCOUNT_PROVIDER}/worker-a is not available on this account (refused by ${ACCOUNT_PROVIDER}: ${ACCOUNT_REFUSAL}); this session continues on ${ACCOUNT_PROVIDER}/root.`;
/** The retry's announced text: the refusal, then the switch's detail (prepareModelSwitchRetry joins them with one space). */
const ACCOUNT_RETRY_MESSAGE = `${ACCOUNT_REFUSAL}. Continuing on ${ACCOUNT_PROVIDER}/root.`;
/** The models endpoint's wire listing: the fields the catalog parses, worker-a first by priority. */
const ACCOUNT_LISTING = {
	models: [
		{ slug: "worker-a", display_name: "worker-a", visibility: "list", supported_in_api: true, priority: 0 },
		{ slug: "root", display_name: "root", visibility: "list", supported_in_api: true, priority: 1 },
	],
};

/** An unsigned ChatGPT-shaped access token: the Codex client reads the account claim from its payload and verifies nothing. */
function syntheticChatGptToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `${header}.${payload}.harness`;
}

const ACCOUNT_LISTING_TOKEN = syntheticChatGptToken(ACCOUNT_LISTING_ACCOUNT_ID);

/** One listing request as the fixture received it. */
interface AccountListingRequest {
	/** Provider requests the world had seen when this listing was answered, counted from the witness's start. */
	readonly requestsBefore: number;
	readonly clientVersion: string | null;
	readonly authorization: string | null;
	readonly accountId: string | null;
}

/** Answers the account catalog's models GET with the wire listing and records what it sent; every other fetch passes through. */
function serveAccountListing(
	world: HarnessWorld,
	requests: AccountListingRequest[],
	requestBase: number,
	options: { available?: boolean; hold?: Barrier; reached?: Barrier } = {},
): void {
	world.fetchResponder = (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		if (init?.method !== "GET" || `${url.origin}${url.pathname}` !== `${ACCOUNT_BASE_URL}/api/codex/models`) {
			return undefined;
		}
		const headers = new Headers(init.headers);
		requests.push({
			requestsBefore: world.provider.requests.length - requestBase,
			clientVersion: url.searchParams.get("client_version"),
			authorization: headers.get("authorization"),
			accountId: headers.get("chatgpt-account-id"),
		});
		options.reached?.release();
		const response =
			options.available !== false
				? Response.json(ACCOUNT_LISTING)
				: Response.json({ error: "Account listing unavailable" }, { status: 503 });
		return options.hold ? options.hold.promise.then(() => response) : Promise.resolve(response);
	};
}

/** The registered descriptor of an account model: the same object the public registry hands the catalog and the session. */
function accountModel(world: HarnessWorld, id: string): Model<Api> {
	const model = world.modelRegistry.find(ACCOUNT_PROVIDER, id);
	if (model === undefined) throw new Error(`the account model ${ACCOUNT_PROVIDER}/${id} is not registered`);
	return model;
}

function modelRef(model: Model<Api> | undefined): string | undefined {
	return model === undefined ? undefined : `${model.provider}/${model.id}`;
}

/** The records of a session file's text, one JSON entry per line. */
function entriesIn(fileText: string): Array<Record<string, unknown>> {
	return fileText
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function retryRecordsIn(fileText: string): Array<Record<string, unknown>> {
	return entriesIn(fileText)
		.filter((entry) => entry.type === "custom" && entry.customType === PROVIDER_RETRY_CUSTOM_TYPE)
		.map((entry) => entry.data as Record<string, unknown>);
}

interface AccountQuitRun {
	readonly baselinePersisted: boolean;
	readonly fileAtQuit: string;
	readonly fileAfterQuit: string;
	readonly requestModelsAtQuit: readonly string[];
	readonly modelAtRetryStart: string | undefined;
	readonly retryStart:
		| { readonly attempt: number; readonly delayMs: number; readonly errorMessage: string }
		| undefined;
	readonly requestsAddedByQuit: number;
	readonly warnings: readonly string[];
	readonly startOutcome: string;
	readonly disposal: string;
}

/**
 * The refusal on worker-a moves the session to the account's default. The listener disposes the session from the announced retry: that
 * announcement comes after the switch and before the continuation, so the closing gate after the recovery (foreground-recovery-controller.ts)
 * starts no provider request on root. The cancelled retry end is the one record the quit still persists.
 */
async function runAccountQuit(world: HarnessWorld, agentDir: string): Promise<AccountQuitRun> {
	const { trace } = world;
	const held = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings: { memorySystem: undefined },
	});
	const heldSession = held.session;
	await heldSession.bindExtensions({ uiContext: world.humanInput.ui });
	await heldSession.setModel(accountModel(world, "worker-a"), { persistSettings: false });
	const heldFile = held.sessionManager.getSessionFile();
	if (heldFile === undefined) throw new Error("the account quit owner has no file");
	// A normal turn persists a baseline first, so the file claims below have a nonempty persisted file to be measured against.
	world.provider.enqueue("worker-a", text("account-quit-baseline", ACCOUNT_BASELINE_REPLY));
	world.systemOne.enterPhase("mode-account-quit-baseline", {});
	await withDeadline(trace, "account quit: the baseline turn completes", heldSession.prompt("Run the baseline turn."));
	const baselinePersisted = (world.io.peekFile(heldFile) ?? "").includes(ACCOUNT_BASELINE_REPLY);
	world.provider.enqueue("worker-a", fail("account-quit-refusal", ACCOUNT_REFUSAL));
	const mark = world.warnings.length;
	const refusalMark = world.provider.requests.length;
	let modelAtRetryStart: string | undefined;
	let retryStart: AccountQuitRun["retryStart"];
	let requestsAtQuit = 0;
	let requestModelsAtQuit: readonly string[] = [];
	let fileAtQuit = "";
	let quit: Promise<string> | undefined;
	heldSession.subscribe((event) => {
		if (quit !== undefined || event.type !== "auto_retry_start") return;
		modelAtRetryStart = modelRef(heldSession.model);
		retryStart = { attempt: event.attempt, delayMs: event.delayMs, errorMessage: event.errorMessage };
		requestsAtQuit = world.provider.requests.length;
		requestModelsAtQuit = world.provider.requests
			.slice(refusalMark)
			.map((request) => `${request.model.provider}/${request.model.id}`);
		fileAtQuit = world.io.peekFile(heldFile) ?? "";
		// `disposeAndWait()` runs its shutdown synchronously before its first await, so the listener returns with the owner already closed.
		quit = disposed(heldSession);
	});
	enterNeutralModeIntake(world, "mode-account-quit-backlog", "Run the baseline turn.", true);
	const start = heldSession.prompt(ACCOUNT_REFUSED_PROMPT).then(
		() => "resolved",
		(error: unknown) => messageOf(error),
	);
	const startOutcome = await withDeadline(trace, "account quit: the held refusal settles", start, 60_000);
	const disposal = await withDeadline(
		trace,
		"account quit: the quit completes",
		quit ?? disposed(heldSession),
		60_000,
	);
	// Claimed after the quit completes, so the disclosures the dispose itself writes are part of what is claimed.
	const warnings = world.warnings.splice(mark);
	return {
		baselinePersisted,
		fileAtQuit,
		fileAfterQuit: world.io.peekFile(heldFile) ?? "",
		requestModelsAtQuit,
		modelAtRetryStart,
		retryStart,
		requestsAddedByQuit: world.provider.requests.length - requestsAtQuit,
		warnings,
		startOutcome,
		disposal,
	};
}

interface AccountControlRun {
	readonly requestMark: number;
	readonly requestModels: readonly string[];
	readonly modelAfter: string | undefined;
	readonly retryEvents: ReadonlyArray<Record<string, unknown>>;
	readonly warnings: readonly string[];
	readonly fileText: string;
	readonly disposal: { readonly error: unknown } | undefined;
}

/** The same listing and refusal with no quit: the retry continues on the account default, and that answer is the turn's reply. */
async function runAccountControl(world: HarnessWorld, agentDir: string): Promise<AccountControlRun> {
	const { trace } = world;
	const control = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings: { memorySystem: undefined },
	});
	const controlSession = control.session;
	await controlSession.bindExtensions({ uiContext: world.humanInput.ui });
	await controlSession.setModel(accountModel(world, "worker-a"), { persistSettings: false });
	const controlFile = control.sessionManager.getSessionFile();
	if (controlFile === undefined) throw new Error("the account control owner has no file");
	const retryEvents: Array<Record<string, unknown>> = [];
	controlSession.subscribe((event) => {
		if (event.type === "auto_retry_start") {
			retryEvents.push({ type: event.type, attempt: event.attempt, errorMessage: event.errorMessage });
		} else if (event.type === "auto_retry_end") {
			retryEvents.push({ type: event.type, attempt: event.attempt, success: event.success });
		}
	});
	const mark = world.warnings.length;
	const requestMark = world.provider.requests.length;
	world.provider.enqueue("worker-a", fail("account-control-refusal", ACCOUNT_REFUSAL));
	world.provider.enqueue("root", text("account-control-reply", ACCOUNT_ROOT_REPLY));
	world.systemOne.enterPhase("mode-account-control", {});
	await withDeadline(
		trace,
		"account control: the refused turn completes on root",
		controlSession.prompt(ACCOUNT_REFUSED_PROMPT),
	);
	const warnings = world.warnings.splice(mark);
	const requestModels = world.provider.requests
		.slice(requestMark)
		.map((request) => `${request.model.provider}/${request.model.id}`);
	const fileText = world.io.peekFile(controlFile) ?? "";
	const modelAfter = modelRef(controlSession.model);
	const disposal = await world.disposeSessionInBody(controlSession);
	return { requestMark, requestModels, modelAfter, retryEvents, warnings, fileText, disposal };
}

/**
 * A refused account model moves the session to the account's own default, announced as a retry. The listing is fetched through the guard's
 * fetch port and consumed before the first model request, because the first submission waits for the account check. The witness reaches
 * the model-switch gates of foreground-recovery-controller.ts (the unsupported-model retry, then the post-recovery closing gate). The billing
 * failover continuation (`billing.continuedOn`) is not reached here.
 */
async function verifyAccountListingRefusal(world: HarnessWorld): Promise<void> {
	const requestBase = world.provider.requests.length;
	const escapesBefore = world.guard.escapes.length;
	const listingRequests: AccountListingRequest[] = [];
	const registry = world.modelRegistry.createReloadSnapshot();
	world.modelRegistry.registerProvider(ACCOUNT_PROVIDER, {
		api: HARNESS_API,
		baseUrl: ACCOUNT_BASE_URL,
		apiKey: ACCOUNT_LISTING_TOKEN,
		models: ["worker-a", "root"].map((id) => {
			const { name, reasoning, input, cost, contextWindow, maxTokens } = world.provider.model(id);
			return { id, name, reasoning, input, cost, contextWindow, maxTokens };
		}),
	});
	serveAccountListing(world, listingRequests, requestBase);
	const agentDir = `${world.agentDir}-account-listing`;
	try {
		const quit = await runAccountQuit(world, agentDir);
		// A refused effect inside production's own catch never throws out of the run: it is named here, at the step that reached it.
		expect(
			world.guard.escapes.slice(escapesBefore),
			"the account quit reaches no refused IO: its listing and requests stay on the guard's ports",
		).toEqual([]);
		expect(quit.baselinePersisted, "a nonempty persisted baseline exists before the refusal").toBe(true);
		expect(
			quit.requestModelsAtQuit,
			"the refusal reaches the provider on worker-a, the account's first model, before the switch",
		).toEqual([`${ACCOUNT_PROVIDER}/worker-a`]);
		expect(
			quit.fileAtQuit.includes(ACCOUNT_REFUSAL),
			"the refused assistant message is persisted on message end, before the retry is announced",
		).toBe(true);
		expect(
			retryRecordsIn(quit.fileAtQuit)[0],
			"the retry start is persisted before the quit: the record names the continuation",
		).toMatchObject({ phase: "start", attempt: 1, delayMs: 0, errorMessage: ACCOUNT_RETRY_MESSAGE });
		expect(quit.modelAtRetryStart, "the session stands on the account default when the retry is announced").toBe(
			`${ACCOUNT_PROVIDER}/root`,
		);
		expect(quit.retryStart, "the announced retry is a model-switch continuation with no delay").toEqual({
			attempt: 1,
			delayMs: 0,
			errorMessage: ACCOUNT_RETRY_MESSAGE,
		});
		expect(quit.warnings, "the switch discloses exactly the account warning").toEqual([ACCOUNT_SWITCH_WARNING]);
		expect(quit.requestsAddedByQuit, "a quit from the announced retry makes no provider request after it").toBe(0);
		expect(quit.startOutcome, "the held refusal turn resolves").toBe("resolved");
		expect(quit.disposal, "the quit completes").toBe("disposed");
		expect(
			quit.fileAfterQuit.startsWith(quit.fileAtQuit),
			"the file is appended to after the quit, never rewritten",
		).toBe(true);
		const growth = entriesIn(quit.fileAfterQuit.slice(quit.fileAtQuit.length));
		expect(
			growth.map((entry) => entry.customType ?? entry.type),
			"after the quit the only persisted record is the cancelled retry end",
		).toEqual([PROVIDER_RETRY_CUSTOM_TYPE]);
		expect(growth[0]?.data, "the cancelled retry end names the refused model and the cancellation").toMatchObject({
			phase: "end",
			attempt: 1,
			success: false,
			finalError: "Submission cancelled",
			provider: ACCOUNT_PROVIDER,
			modelId: "worker-a",
		});

		const control = await runAccountControl(world, agentDir);
		expect(
			world.guard.escapes.slice(escapesBefore),
			"the account control reaches no refused IO: its listing and requests stay on the guard's ports",
		).toEqual([]);
		expect(control.requestModels, "the refusal is answered by worker-a, then the continuation by root").toEqual([
			`${ACCOUNT_PROVIDER}/worker-a`,
			`${ACCOUNT_PROVIDER}/root`,
		]);
		expect(control.warnings, "the control discloses exactly the account warning").toEqual([ACCOUNT_SWITCH_WARNING]);
		expect(control.modelAfter, "the control session stands on the account default afterwards").toBe(
			`${ACCOUNT_PROVIDER}/root`,
		);
		expect(control.retryEvents, "the retry is announced, then ends successfully on root").toEqual([
			{ type: "auto_retry_start", attempt: 1, errorMessage: ACCOUNT_RETRY_MESSAGE },
			{ type: "auto_retry_end", attempt: 1, success: true },
		]);
		expect(control.fileText.includes(ACCOUNT_ROOT_REPLY), "normal order: the root answer is persisted").toBe(true);
		expect(
			retryRecordsIn(control.fileText).at(-1),
			"normal order: the persisted retry end is a success",
		).toMatchObject({ phase: "end", attempt: 1, success: true });
		expect(control.disposal, "the control disposes cleanly").toBeUndefined();

		expect(listingRequests, "each session asks the models endpoint once, before its first submission").toHaveLength(
			2,
		);
		expect(
			listingRequests.map((request) => request.clientVersion),
			"every listing is asked with the Codex client release",
		).toEqual([OPENAI_CODEX_CLIENT_VERSION, OPENAI_CODEX_CLIENT_VERSION]);
		expect(
			listingRequests.map((request) => request.accountId),
			"every listing carries the synthetic account header",
		).toEqual([ACCOUNT_LISTING_ACCOUNT_ID, ACCOUNT_LISTING_ACCOUNT_ID]);
		expect(
			listingRequests.map((request) => request.authorization),
			"every listing carries the synthetic bearer token",
		).toEqual([`Bearer ${ACCOUNT_LISTING_TOKEN}`, `Bearer ${ACCOUNT_LISTING_TOKEN}`]);
		expect(
			listingRequests[0]?.requestsBefore,
			"the quit owner's listing is answered before its first model request",
		).toBe(0);
		expect(
			listingRequests[1]?.requestsBefore,
			"the control's listing is answered before its first model request",
		).toBeLessThanOrEqual(control.requestMark - requestBase);
		await verifyMissingAccountListing(world, `${agentDir}-missing`);
		await verifyAccountPreflightAbort(world, `${agentDir}-preflight`);
	} finally {
		world.fetchResponder = undefined;
		world.modelRegistry.restoreReloadSnapshot(registry);
	}
}

/** An unanswered listing is unknown, not proof the account offers no alternative: only a real refusal makes the warning relevant. */
async function verifyMissingAccountListing(world: HarnessWorld, agentDir: string): Promise<void> {
	const requestBase = world.provider.requests.length;
	const listingRequests: AccountListingRequest[] = [];
	const escapesBefore = world.guard.escapes.length;
	serveAccountListing(world, listingRequests, requestBase, { available: false });
	const controlReply = "An unchecked account model can still answer the control.";
	for (const refused of [false, true]) {
		const mark = world.warnings.length;
		const requestMark = world.provider.requests.length;
		const created = await world.createRootSession("root", {
			agentDir,
			sessionManager: world.createSessionManager(agentDir),
			settings: { memorySystem: undefined },
		});
		const session = created.session;
		await session.bindExtensions({ uiContext: world.humanInput.ui });
		await session.setModel(accountModel(world, "worker-a"), { persistSettings: false });
		const file = created.sessionManager.getSessionFile();
		if (!file) throw new Error("The missing account listing witness has no persisted session file");
		const retries: string[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start" || event.type === "auto_retry_end") retries.push(event.type);
		});
		world.provider.enqueue(
			"worker-a",
			refused
				? fail("account-no-listing-refusal", ACCOUNT_REFUSAL)
				: text("account-no-listing-control", controlReply),
		);
		world.systemOne.enterPhase(`mode-account-no-listing-${refused ? "refused" : "control"}`, {});
		await withDeadline(
			world.trace,
			"missing account listing: the actual model request completes",
			session.prompt(ACCOUNT_REFUSED_PROMPT),
		);
		const modelAfter = modelRef(session.model);
		const disposal = await world.disposeSessionInBody(session);
		const warnings = world.warnings.splice(mark);
		expect(
			world.guard.escapes.slice(escapesBefore),
			"missing listing and model request stay on the world's external ports",
		).toEqual([]);
		expect(
			world.provider.requests.slice(requestMark).map((request) => `${request.model.provider}/${request.model.id}`),
			"an unchecked listing still reaches exactly the requested model and starts no guessed replacement",
		).toEqual([`${ACCOUNT_PROVIDER}/worker-a`]);
		expect(modelAfter, "no fetched listing leaves the session's selected model intact").toBe(
			`${ACCOUNT_PROVIDER}/worker-a`,
		);
		expect(retries, "no listing starts no replacement retry").toEqual([]);
		expect(
			retryRecordsIn(world.io.peekFile(file) ?? ""),
			"no replacement retry is persisted without an account listing",
		).toEqual([]);
		expect(disposal, "the missing-listing owner disposes normally").toBeUndefined();
		if (refused) {
			expect(
				warnings,
				"the no-listing branch reports missing evidence rather than claiming there are no other models",
			).toEqual([
				`${ACCOUNT_PROVIDER}/worker-a is not available on this account (refused by ${ACCOUNT_PROVIDER}: ${ACCOUNT_REFUSAL}), and no ${ACCOUNT_PROVIDER} account model listing is available to choose a replacement from.`,
			]);
			expect(
				(world.io.peekFile(file) ?? "").includes(ACCOUNT_REFUSAL),
				"the actual provider refusal is persisted without a continuation",
			).toBe(true);
		} else {
			expect(
				warnings,
				"normal order: listing failure alone does not declare an otherwise usable model unavailable",
			).toEqual([]);
			expect(
				(world.io.peekFile(file) ?? "").includes(controlReply),
				"normal order: the unchecked model's answer is persisted",
			).toBe(true);
		}
	}
	expect(
		listingRequests,
		"both owners reach the unsuccessful account listing before their model request",
	).toHaveLength(2);
	expect(
		listingRequests.map((request) => request.requestsBefore),
		"each unsuccessful listing precedes its owner's sole request",
	).toEqual([0, 1]);
}

/** The account-listing port holds a real submission in preflight; close aborts that wait before the extension/start/provider boundary. */
async function verifyAccountPreflightAbort(world: HarnessWorld, agentDir: string): Promise<void> {
	for (const closeFirst of [true, false]) {
		const hold = createBarrier();
		const listingReached = createBarrier();
		const requests: AccountListingRequest[] = [];
		const requestMark = world.provider.requests.length;
		const warningMark = world.warnings.length;
		let beforeStart = 0;
		serveAccountListing(world, requests, requestMark, { hold, reached: listingReached });
		const created = await world.createRootSession("root", {
			agentDir,
			sessionManager: world.createSessionManager(agentDir),
			settings: { memorySystem: undefined },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => {
						beforeStart++;
					});
				},
			],
		});
		const session = created.session;
		await session.bindExtensions({ uiContext: world.humanInput.ui });
		await session.setModel(accountModel(world, "worker-a"), { persistSettings: false });
		const routingReached = createBarrier();
		const routing: string[] = [];
		session.subscribe((event) => {
			if (event.type === "routing_start" || event.type === "routing_end") routing.push(event.type);
			if (event.type === "routing_start") routingReached.release();
		});
		await withDeadline(
			world.trace,
			"account preflight: the listing request reaches its hold",
			listingReached.promise,
		);
		const file = created.sessionManager.getSessionFile();
		if (!file) throw new Error("Account preflight witness has no session file");
		const reply = "The released account preflight reaches its provider.";
		const accountWaitReached = createBarrier();
		const readySignals: AbortSignal[] = [];
		const realReady = AccountModelCatalog.prototype.ready;
		const readySpy = vi.spyOn(AccountModelCatalog.prototype, "ready").mockImplementation(function (
			this: AccountModelCatalog,
			signal?: AbortSignal,
		) {
			const pending = realReady.call(this, signal);
			if (signal) {
				readySignals.push(signal);
				accountWaitReached.release();
			}
			return pending;
		});
		if (!closeFirst) {
			hold.release();
			world.provider.enqueue("worker-a", text("account-preflight-control", reply));
		}
		const preflightResults: boolean[] = [];
		const claimJudgments = {
			states_tests_pass: { kind: "choice" as const, choice: "no_current_success", confidence: 0.97 },
			states_committed: { kind: "noul" as const, probability: 0.02 },
			states_pushed: { kind: "noul" as const, probability: 0.02 },
			states_published: { kind: "noul" as const, probability: 0.02 },
			states_files_changed: { kind: "noul" as const, probability: 0.02 },
		};
		const claimPhase = `mode-account-preflight-${closeFirst ? "closed" : "control"}`;
		const claimRequestMark = world.systemOne.decoded.length;
		world.systemOne.enterPhase(claimPhase, closeFirst ? {} : claimJudgments, {
			expect: ({ state, questions }) => {
				expect(closeFirst, "the closed preflight publishes no answer to judge").toBe(false);
				expect(Object.keys(questions).sort(), "the live preflight reaches the real claim question pack").toEqual(
					Object.keys(claimJudgments).sort(),
				);
				expect(state, "the claim check reads this control's actual final answer").toEqual({
					final_answer: reply,
				});
			},
		});
		const prompt = session
			.prompt("Run the account preflight control.", {
				preflightResult: (passed) => {
					preflightResults.push(passed);
				},
			})
			.then(
				() => "resolved",
				(error: unknown) => messageOf(error),
			);
		try {
			await withDeadline(
				world.trace,
				"account preflight: routing started before any provider request",
				routingReached.promise,
			);
			await withDeadline(
				world.trace,
				"account preflight: actual ready method installed the live submission abort listener",
				accountWaitReached.promise,
			);
			expect(readySignals, "the actual account wait receives one live submission signal").toHaveLength(1);
			expect(readySignals[0]?.aborted, "the submission remains live at the held account-ready boundary").toBe(false);
			if (closeFirst) {
				expect(world.provider.requests.length, "held account preflight has reached no model request").toBe(
					requestMark,
				);
				await withDeadline(
					world.trace,
					"account preflight: close cancels the held account wait",
					session.disposeAndWait(),
					60_000,
				);
			}
			expect(
				await withDeadline(world.trace, "account preflight: submission settles", prompt),
				"preflight interruption is a clean abort outcome",
			).toBe("resolved");
			expect(
				world.systemOne.decoded.slice(claimRequestMark).map((request) => request.phase),
				"only the live ON control reaches and consumes the answer's claim judgment",
			).toEqual(world.systemOne.enabled && !closeFirst ? [claimPhase] : []);
			hold.release();
			expect(requests, "the actual account-listing boundary was reached exactly once").toHaveLength(1);
			expect(
				routing,
				"closed preflight has removed its public event sink; release-first preflight publishes its end",
			).toEqual(closeFirst ? ["routing_start"] : ["routing_start", "routing_end"]);
			expect(readySignals[0]?.aborted, "only close-first preflight aborts the actual account-ready signal").toBe(
				closeFirst,
			);
			expect(
				preflightResults,
				"the actual preflight callback distinguishes a quiet abort from successful admission",
			).toEqual([!closeFirst]);
			expect(
				beforeStart,
				"the interrupted preflight never reaches before_agent_start; the release-first control does",
			).toBe(closeFirst ? 0 : 1);
			expect(
				world.provider.requests.slice(requestMark).map((request) => request.model.id),
				"only release-first preflight reaches the scripted model",
			).toEqual(closeFirst ? [] : ["worker-a"]);
			expect(
				(world.io.peekFile(file) ?? "").includes(reply),
				"only release-first preflight persists an assistant reply",
			).toBe(!closeFirst);
			expect(
				world.warnings.splice(warningMark),
				"a preflight cancelled at its account wait manufactures no failure warning",
			).toEqual([]);
		} finally {
			readySpy.mockRestore();
			hold.release();
			await world.disposeSessionInBody(session);
		}
	}
}

/** Print's actual raw-write callback is held at its final flush, after real runtime cleanup, on clean and failed-disposal paths. */
async function verifyPrintOwner(world: HarnessWorld): Promise<void> {
	for (const failDispose of [false, true]) {
		const warningMark = world.warnings.length;
		const liveWarning = "Print witness: live warning \u001b[2J";
		const closingWarning = "Print witness: closing warning.";
		const disposeFailure = new Error("Print witness: runtime disposal failed after cleanup");
		const capture: { session?: AgentSession } = {};
		const harness = await createInteractiveHarness(world, {
			holdDispose: false,
			extensionFactories: [
				(pi) => {
					pi.on("session_shutdown", () => {
						capture.session?.emitHostWarning(closingWarning);
					});
				},
			],
		});
		capture.session = harness.runtime.session;
		configureHttpDispatcher();
		const printPool = undici.getGlobalDispatcher();
		let printPoolSettled = false;
		const poolCloseSpy = observeDispatcherClose(printPool, async (settleNative) => {
			await settleNative();
			printPoolSettled = true;
		});
		const stdout: string[] = [];
		const stderr: string[] = [];
		const consoleWarnings: string[] = [];
		const warningSpy = vi.spyOn(console, "warn").mockImplementation((...values: unknown[]) => {
			consoleWarnings.push(values.map(String).join(" "));
		});
		const flushed = createBarrier();
		let finishFlush: (() => void) | undefined;
		let cleaningUp = false;
		const signalCounts = [process.listenerCount("SIGTERM"), process.listenerCount("SIGHUP")];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			const text = String(chunk);
			stdout.push(text);
			if (text === "") {
				if (cleaningUp) done?.();
				else finishFlush = () => done?.();
				flushed.release();
			} else done?.();
			return true;
		}) as typeof process.stdout.write);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			stderr.push(String(chunk));
			(typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
			return true;
		}) as typeof process.stderr.write);
		const realDispose = harness.runtime.dispose.bind(harness.runtime);
		let runtimeDisposed = false;
		harness.runtime.dispose = async () => {
			await realDispose();
			runtimeDisposed = true;
			if (failDispose) throw disposeFailure;
		};
		const reply = "The real print mode reply.";
		world.provider.enqueue("root", {
			...text("print-owner-control", reply),
			check: () => {
				harness.runtime.session.emitHostWarning(liveWarning);
			},
		});
		let completed = false;
		world.systemOne.enterPhase(`mode-print-${failDispose ? "failed-disposal" : "control"}`, {});
		const run = runPrintMode(harness.runtime, { mode: "text", messages: ["Run the print witness."] }).then(
			(value) => {
				completed = true;
				return value;
			},
			(error: unknown) => {
				completed = true;
				return error;
			},
		);
		const failures: unknown[] = [];
		try {
			await withDeadline(world.trace, "print owner: real final flush callback is held", flushed.promise);
			expect(runtimeDisposed, "print flush begins only after the real runtime cleanup completes").toBe(true);
			expect(
				printPoolSettled &&
					dispatcherCloseCount(poolCloseSpy) === 1 &&
					dispatcherCloseCount(poolCloseSpy, "callback") === 1,
				"print attempts and awaits its actual owned HTTP pool retirement even when runtime disposal fails",
			).toBe(true);
			expect(completed, "print cannot return before its actual final write callback settles").toBe(false);
			expect(
				harness.disposalWarnings,
				"the world's still-live subscriber leaves no held closing warning for the runtime sink",
			).toEqual([]);
			expect(
				world.warnings.splice(warningMark),
				"live and closing warnings reach the existing world subscriber without loss",
			).toEqual([liveWarning, closingWarning]);
			expect(stdout, "print emits its actual reply then performs the final empty flush write").toEqual([
				`${reply}\n`,
				"",
			]);
			expect(
				consoleWarnings,
				"the live print warning reaches its real console boundary with controls escaped",
			).toEqual(["Warning: Print witness: live warning \\x1b[2J"]);
			expect(stderr, "the print owner emits no unclassified raw stderr line").toEqual([]);
			finishFlush?.();
			expect(
				await withDeadline(world.trace, "print owner: completion joins the flush", run),
				"print keeps a disposal failure after flushing and returns0 in normal order",
			).toBe(failDispose ? disposeFailure : 0);
			expect(
				[process.listenerCount("SIGTERM"), process.listenerCount("SIGHUP")],
				"print releases its real process signal listeners",
			).toEqual(signalCounts);
		} catch (error) {
			failures.push(error);
		} finally {
			cleaningUp = true;
			finishFlush?.();
			try {
				for (const cleanup of [
					() => withDeadline(world.trace, "print owner: cleanup stops the real runtime", realDispose(), 60_000),
					() => withDeadline(world.trace, "print owner: cleanup joins any late final flush", run, 60_000),
					() => harness.mode.stop(),
				]) {
					try {
						await cleanup();
					} catch (error) {
						failures.push(error);
					}
				}
			} finally {
				for (const spy of [stdoutSpy, stderrSpy, warningSpy, poolCloseSpy]) {
					try {
						spy.mockRestore();
					} catch (error) {
						failures.push(error);
					}
				}
			}
		}
		if (failures.length > 0) throw new AggregateError(failures, "Print owner witness and cleanup failed");
	}
}

/** A retryable transport error discriminates willRetry, real backoff cancellation/expiry, and full Unicode owner input at close. */
async function verifyRetryClosingAndUnicodeQueue(world: HarnessWorld): Promise<void> {
	const suffix = " owner payload kept complete after the preview boundary.";
	const queued = `${"x".repeat(198)}\u{1f600}${suffix}`;
	expect(
		queued.codePointAt(198),
		"the actual queued string contains the astral code point at its preview boundary",
	).toBe(0x1f600);
	expect(
		[queued.charCodeAt(198), queued.charCodeAt(199)],
		"the actual payload contains both UTF-16 surrogate units",
	).toEqual([0xd83d, 0xde00]);
	expect(queued.slice(198, 200), "the two-unit payload slice is the complete astral character").toBe(
		String.fromCodePoint(0x1f600),
	);
	expect(queued.length, "the queued payload counts the astral pair as two units before its complete suffix").toBe(
		200 + suffix.length,
	);
	const failure = "network error: scripted connection interrupted";
	for (const stopAt of ["message-end", "backoff", "control", "stranded-control"] as const) {
		const created = await world.createRootSession("root", {
			sessionManager: world.createSessionManager(),
			settings: {
				memorySystem: undefined,
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 5 },
				autonomy: { maxStallTurns: stopAt === "message-end" || stopAt === "stranded-control" ? 1 : 2 },
			},
		});
		const session = created.session;
		await session.bindExtensions({ uiContext: world.humanInput.ui });
		const file = created.sessionManager.getSessionFile();
		if (!file) throw new Error("Retry/Unicode queue witness has no session file");
		const hold = createBarrier();
		const reached = createBarrier();
		const requestMark = world.provider.requests.length;
		const warningMark = world.warnings.length;
		const retryFlags: boolean[] = [];
		const retryEvents: Array<Record<string, unknown>> = [];
		let close: Promise<string> | undefined;
		let activeBackoffAtClose = false;
		let closingNativeQueue = false;
		session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.stopReason === "error" &&
				stopAt === "message-end"
			) {
				close ??= disposed(session);
				closingNativeQueue =
					session.agent.hasQueuedMessages() && session.getResourceSnapshot().foregroundRecovery.shutdown;
			}
			if (event.type === "agent_end") retryFlags.push(event.willRetry);
			if (event.type === "auto_retry_start") {
				retryEvents.push({ type: event.type, attempt: event.attempt, delayMs: event.delayMs });
				if (stopAt === "backoff")
					queueMicrotask(() => {
						activeBackoffAtClose = session.getResourceSnapshot().foregroundRecovery.retrying;
						close ??= disposed(session);
					});
			} else if (event.type === "auto_retry_end")
				retryEvents.push({ type: event.type, success: event.success, finalError: event.finalError });
		});
		world.provider.enqueue("root", {
			...fail(`retry-${stopAt}-failure`, failure),
			check: () => reached.release(),
			gate: hold.promise,
		});
		if (stopAt === "control" || stopAt === "stranded-control")
			world.provider.enqueue("root", {
				...text(`retry-${stopAt}`, "The retry delivers the complete Unicode input."),
				check: (request) => {
					expect(
						request.context.messages.some(
							(message) =>
								message.role === "user" &&
								(typeof message.content === "string"
									? message.content === queued
									: message.content.some((part) => part.type === "text" && part.text === queued)),
						),
						"live retry provider sees the complete queued Unicode payload",
					).toBe(true);
				},
			});
		world.systemOne.enterPhase(`mode-retry-${stopAt}-start`, {});
		const prompt = session.prompt("Run the retry boundary witness.").then(
			() => "resolved",
			(error: unknown) => messageOf(error),
		);
		try {
			await withDeadline(world.trace, "retry witness: actual failing provider request is held", reached.promise);
			enterNeutralModeIntake(world, `mode-retry-${stopAt}-intake`, queued, false);
			await withDeadline(
				world.trace,
				"retry witness: Unicode owner input is admitted to steering",
				session.steer(queued),
			);
			expect(
				session.getSteeringMessages(),
				"the public queue owns the complete input before either failure or quit",
			).toEqual([queued]);
			hold.release();
			expect(
				await withDeadline(world.trace, "retry witness: run completes or cancels", prompt, 60_000),
				"both closed and live retry submissions resolve cleanly",
			).toBe("resolved");
			if (close)
				expect(
					await withDeadline(world.trace, "retry witness: close completes", close, 60_000),
					"the closing owner settles",
				).toBe("disposed");
			const warnings = world.warnings.splice(warningMark);
			expect(
				world.provider.requests.slice(requestMark).map((request) => request.model.id),
				"only live backoff expiry starts the retry provider round",
			).toEqual(stopAt === "control" || stopAt === "stranded-control" ? ["root", "root"] : ["root"]);
			if (stopAt === "control" || stopAt === "stranded-control") {
				expect(retryFlags, "a genuinely retryable live error advertises a retry, then success does not").toEqual([
					true,
					false,
				]);
				expect(
					retryEvents,
					"backoff expiry retries, while the stall-cap exit delivers stranded input without a recovery retry",
				).toEqual(
					stopAt === "stranded-control"
						? []
						: [
								{ type: "auto_retry_start", attempt: 1, delayMs: 5 },
								{ type: "auto_retry_end", success: true, finalError: undefined },
							],
				);
				expect(warnings, "live delivery never holds the queued owner input").toEqual([]);
				expect(session.pendingMessageCount, "the live retry consumes its complete admitted steering input").toBe(0);
				expect(
					(world.io.peekFile(file) ?? "").includes(queued),
					"live delivery persists the complete payload",
				).toBe(true);
			} else {
				expect(
					warnings,
					"closed delivery reports a surrogate-safe preview while retaining the full payload",
				).toEqual([
					`A queued message was not delivered because the session closed before it could be delivered. It is kept in full in the pending queue: ${"x".repeat(198)}…`,
				]);
				expect(
					session.getSteeringMessages(),
					"closing retains the full surrogate pair and every remaining payload byte",
				).toEqual([queued]);
				expect(
					session.deliverablePendingMessageCount,
					"held input remains visible but cannot be delivered by a later run",
				).toBe(0);
				expect(
					(world.io.peekFile(file) ?? "").includes(queued),
					"closed delivery persists the complete held Unicode payload",
				).toBe(true);
				expect(
					(world.io.peekFile(file) ?? "").includes(failure),
					"the closing run still durably records its actual retryable failure",
				).toBe(true);
				expect(
					retryFlags,
					"closure removes the external terminal sink; a later backoff close follows its earlier live retry flag",
				).toEqual(stopAt === "message-end" ? [] : [true]);
				if (stopAt === "message-end") {
					expect(retryEvents, "closed retryable failure never announces a retry").toEqual([]);
					expect(
						closingNativeQueue,
						"admitted native input and the actual closing gate coexist before stranded delivery",
					).toBe(true);
					expect(
						session.runtimeUpdates.getState(),
						"no runtime-update stop can replace this stall-cap/stranded-input route",
					).toBeUndefined();
					expect(
						session.agent.hasQueuedMessages(),
						"stranded closing delivery withdraws native input into the owner's held queue",
					).toBe(false);
				} else {
					expect(
						activeBackoffAtClose,
						"close runs after the real backoff has installed its active controller",
					).toBe(true);
					expect(retryEvents, "backoff close removes its external sink after the already-published start").toEqual(
						[{ type: "auto_retry_start", attempt: 1, delayMs: 5 }],
					);
					expect(
						retryRecordsIn(world.io.peekFile(file) ?? "").at(-1),
						"post-close cancellation remains durable although the session listener is already removed",
					).toMatchObject({ phase: "end", success: false, finalError: "Retry cancelled" });
				}
			}
		} finally {
			hold.release();
			await world.disposeSessionInBody(session);
		}
	}
}

/** An inert registered subscription supplies the real billing premise; metered quota still halts instead of spending elsewhere. */
async function verifyBillingContinuation(world: HarnessWorld): Promise<void> {
	const registry = world.modelRegistry.createReloadSnapshot();
	const credential = world.authStorage.get(HARNESS_PROVIDER);
	if (!credential) throw new Error("The scripted billing provider has no original virtual credential");
	const authActions: string[] = [];
	world.modelRegistry.registerProvider(HARNESS_PROVIDER, {
		oauth: {
			name: "Inert harness subscription",
			isSubscription: true,
			login: async () => {
				authActions.push("login");
				throw new Error("Harness subscription never logs in");
			},
			refreshToken: async () => {
				authActions.push("refresh");
				throw new Error("Harness subscription never refreshes");
			},
			getApiKey: (stored) => stored.access,
		},
	});
	const failure = "quota exceeded";
	try {
		for (const variant of ["metered", "closing-subscription", "live-subscription"] as const) {
			world.authStorage.set(
				HARNESS_PROVIDER,
				variant === "metered"
					? credential
					: {
							type: "oauth",
							access: "inert-harness-subscription-access",
							refresh: "inert-harness-subscription-refresh",
							expires: Date.now() + 86_400_000,
						},
			);
			const agentDir = `${world.agentDir}-billing-${variant}`;
			const created = await world.createRootSession("root", {
				agentDir,
				sessionManager: world.createSessionManager(agentDir),
				settings: {
					memorySystem: undefined,
					failover: { subscriptionHop: true },
					modelRouter: { enabled: false, selectionMode: "manual", expensiveModel: `${HARNESS_PROVIDER}/worker-a` },
				},
			});
			const session = created.session;
			await session.bindExtensions({ uiContext: world.humanInput.ui });
			const file = created.sessionManager.getSessionFile();
			if (!file) throw new Error("Billing continuation witness has no session file");
			expect(
				world.modelRegistry.isUsingSubscription(session.model!),
				"billing uses actual registry subscription evidence rather than an invented failover result",
			).toBe(variant !== "metered");
			const requestsBefore = world.provider.requests.length;
			const warningMark = world.warnings.length;
			const events: Array<Record<string, unknown>> = [];
			let close: Promise<string> | undefined;
			let modelAtRetry: string | undefined;
			session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					modelAtRetry = modelRef(session.model);
					events.push({
						type: event.type,
						attempt: event.attempt,
						delayMs: event.delayMs,
						errorMessage: event.errorMessage,
					});
					if (variant === "closing-subscription") close ??= disposed(session);
				} else if (event.type === "auto_retry_end")
					events.push({ type: event.type, success: event.success, finalError: event.finalError });
			});
			world.provider.enqueue("root", fail(`billing-${variant}`, failure));
			const reply = "The actual subscription failover continuation reply.";
			if (variant === "live-subscription")
				world.provider.enqueue("worker-a", text("billing-live-continuation", reply));
			world.systemOne.enterPhase(`mode-billing-${variant}`, {});
			try {
				await withDeadline(
					world.trace,
					"billing continuation: actual failed model and recovery settle",
					session.prompt("Run the billing continuation witness."),
					60_000,
				);
				if (close) expect(await close, "billing closing owner settles normally").toBe("disposed");
				const warnings = world.warnings.splice(warningMark);
				expect(
					world.provider.requests.slice(requestsBefore).map((request) => request.model.id),
					"metered/closed failover start no extra request while live subscription reaches its actual replacement",
				).toEqual(variant === "live-subscription" ? ["root", "worker-a"] : ["root"]);
				if (variant === "metered") {
					expect(warnings, "a metered quota does not authorize spend on the configured alternative").toEqual([
						`Provider quota/limit reached for ${HARNESS_PROVIDER}/root: switch models (/model), wait for the limit window, or re-send to retry`,
					]);
					expect(events, "metered halt advertises no continuation").toEqual([]);
					expect(retryRecordsIn(world.io.peekFile(file) ?? ""), "metered halt persists no invented retry").toEqual(
						[],
					);
				} else {
					expect(modelAtRetry, "billing applied the actual replacement before announcing its continuation").toBe(
						`${HARNESS_PROVIDER}/worker-a`,
					);
					expect(warnings, "subscription quota disclosure names the actual chosen replacement").toEqual([
						`root quota reached — continuing on ${HARNESS_PROVIDER}/worker-a`,
					]);
					expect(
						events,
						"live billing publishes its terminal event while a closing owner has removed its external sink",
					).toEqual([
						{
							type: "auto_retry_start",
							attempt: 1,
							delayMs: 0,
							errorMessage: `${failure}. Continuing on ${HARNESS_PROVIDER}/worker-a.`,
						},
						...(variant === "live-subscription"
							? [
									{
										type: "auto_retry_end",
										success: true,
										finalError: undefined,
									},
								]
							: []),
					]);
					expect(
						retryRecordsIn(world.io.peekFile(file) ?? "").at(-1),
						"the durable billing retry records its real terminal outcome",
					).toMatchObject({
						phase: "end",
						success: variant === "live-subscription",
						...(variant === "closing-subscription" ? { finalError: "Submission cancelled" } : {}),
					});
					expect(
						(world.io.peekFile(file) ?? "").includes(reply),
						"only the live replacement commits its actual reply",
					).toBe(variant === "live-subscription");
				}
			} finally {
				await world.disposeSessionInBody(session);
			}
		}
		expect(authActions, "the inert subscription fixture performs no login or token refresh").toEqual([]);
	} finally {
		world.modelRegistry.restoreReloadSnapshot(registry);
		world.authStorage.set(HARNESS_PROVIDER, credential);
	}
}
