import { getKeybindings, setKeybindings, type Terminal } from "@caupulican/pi-tui";
import { expect, vi } from "vitest";
import { AgentSession } from "../../../src/core/agent-session.ts";
import { type AgentSessionRuntime, createAgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { FooterDataProvider } from "../../../src/core/footer-data-provider.ts";
import { ModelAdaptationStore } from "../../../src/core/models/adaptation-store.ts";
import { TerminalWarnings } from "../../../src/core/terminal-warnings.ts";
import { FooterComponent } from "../../../src/modes/interactive/components/footer.ts";
import { EditorOverlayHost } from "../../../src/modes/interactive/editor-overlay-host.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { SignalLifecycle } from "../../../src/modes/interactive/signal-lifecycle.ts";
import { initTheme, stopThemeWatcher } from "../../../src/presentation/theme/theme.ts";
import { trackDetachedChild, untrackDetachedChild } from "../../../src/utils/shell.ts";
import { type Barrier, createBarrier, HARNESS_PROVIDER } from "./scripted-provider.ts";
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
}
