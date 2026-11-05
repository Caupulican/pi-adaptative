import { EventEmitter } from "node:events";
import { expect } from "vitest";
import type { CiCurrentObservation, CiSubject } from "../../../../src/core/events/host-event-contract.ts";
import { CiRunMonitor } from "../../../../src/host/ci/ci-run-monitor.ts";
import { createCiCommandPort, GithubActionsCiProvider } from "../../../../src/host/ci/github-actions-ci-provider.ts";
import { builtinBoundary } from "../builtin-boundary.ts";
import { createBarrier } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, settlementState, withDeadline } from "../session-fixture.ts";

/** The OS can report a process exit before its pipes close. No production owner is replaced. */
export async function runJourney1CiCommandPhase(world: HarnessWorld, subject: CiSubject): Promise<void> {
	const started = createBarrier();
	const replacementStarted = createBarrier();
	const terminal = createBarrier();
	const failures: unknown[] = [];
	const children: Array<{ pid: number; close(): void }> = [];
	const initialLive = world.processTable.liveChildren();
	const initialSignals = world.processTable.delivered.length;
	let terminalCount = 0;
	let exits = 0;
	const restore = builtinBoundary.replace("process", "spawn", (...args) => {
		world.guard.effects.push({ kind: "process.spawn", arguments: args });
		const [file, argv, options] = args;
		expect(file).toBe("gh");
		expect(argv).toEqual(["run", "watch", String(801 + children.length), "--interval", "30"]);
		// The watch output is never buffered: only its exit status and a bounded stderr tail are read.
		expect(options).toMatchObject({ cwd: HARNESS_PROJECT_CWD, stdio: ["ignore", "ignore", "pipe"] });
		expect(options).not.toHaveProperty("signal");
		const child = Object.assign(new EventEmitter(), {
			pid: 0,
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill: () => world.processTable.signal(child.pid, "SIGTERM"),
		});
		let cancelled = false;
		let closed = false;
		child.pid = world.processTable.registerChild({
			detached: false,
			deliver: (signal) => {
				expect(signal).toBe("SIGTERM");
				expect(cancelled).toBe(false);
				cancelled = true;
				child.signalCode = "SIGTERM";
				exits++;
				child.emit("exit", null, "SIGTERM");
			},
		});
		children.push({
			pid: child.pid,
			close: () => {
				if (closed) return;
				closed = true;
				if (!cancelled) {
					child.exitCode = 0;
					exits++;
					child.emit("exit", 0, null);
				}
				world.processTable.releaseChild(child.pid);
				child.emit("close", child.exitCode, child.signalCode);
			},
		});
		queueMicrotask(() => {
			child.emit("spawn");
			if (children.length === 4) started.release();
			if (children.length === 5) replacementStarted.release();
		});
		return child;
	});
	const abort = new AbortController();
	const monitor = new CiRunMonitor(
		new GithubActionsCiProvider(createCiCommandPort(HARNESS_PROJECT_CWD)),
		abort.signal,
		() => {
			terminalCount++;
			terminal.release();
		},
		(error) => failures.push(error),
	);
	const observations: CiCurrentObservation[] = Array.from({ length: 5 }, (_, index) => ({
		subject: { ...subject, headSha: (index + 1).toString().repeat(40) },
		runId: 801 + index,
		runNumber: index + 1,
		runAttempt: 1,
		status: "in_progress",
	}));
	try {
		monitor.reconcile(observations.slice(0, 4));
		await withDeadline(world.trace, "four physical CI commands start", started.promise);
		monitor.reconcile(observations.slice(4));
		expect(exits, "cancelled processes exit before their pipes close").toBe(4);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(children, "cancelled live children still occupy all four monitor slots").toHaveLength(4);
		expect(world.processTable.liveChildren()).toEqual([...initialLive, ...children.map((child) => child.pid)]);
		expect(terminalCount, "cancellation cannot publish a terminal result").toBe(0);
		children[0].close();
		await withDeadline(world.trace, "physical close releases one CI monitor slot", replacementStarted.promise);
		expect(children).toHaveLength(5);
		children[4].close();
		await withDeadline(world.trace, "normal CI completion requests authoritative refresh", terminal.promise);
		const stopping = monitor.stop();
		expect(await settlementState(stopping), "shutdown joins cancelled processes until their pipes close").toBe(
			"pending",
		);
		for (const child of children) child.close();
		await withDeadline(world.trace, "CI command physical shutdown settles", stopping);
		expect(exits).toBe(5);
		expect(terminalCount).toBe(1);
		expect(failures).toEqual([]);
		expect(world.processTable.delivered.slice(initialSignals)).toHaveLength(4);
		expect(world.processTable.liveChildren()).toEqual(initialLive);
	} finally {
		const stopping = monitor.stop();
		for (const child of children) child.close();
		await stopping;
		restore();
	}
}
