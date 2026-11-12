/** Windows shell prewarm admission across real root session shutdown. */
import { expect } from "vitest";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
} from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import { RuntimeBuilder } from "../../../../src/core/runtime-builder.ts";
import { routeShellContract } from "../../../../src/core/tools/shell-contract-router.ts";
import { ShellLanePool } from "../../../../src/core/tools/shell-lane-pool.ts";
import { calls, createBarrier, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { ICM_INTAKE_JUDGMENTS, latestBatchResults } from "./shared.ts";

/** A real leased lane must not materialize its engine after its owning root closes. */
export async function runWindowsPrewarmShutdownJourney(world: HarnessWorld): Promise<void> {
	if (process.platform !== "win32") return;
	const root = await world.createRootSession("root", {
		agentDir: `${world.agentDir}-h29-prewarm`,
		omitShellOperations: true,
	});
	let rootOpen = true;
	const entered = createBarrier();
	const release = createBarrier();
	const originalAcquire = ShellLanePool.prototype.acquire;
	let held = false;
	const before = world.windowsShell.spawns.length;
	let prewarm: Promise<void> | undefined;
	try {
		ShellLanePool.prototype.acquire = async function (signal) {
			if (held) return originalAcquire.call(this, signal);
			held = true;
			const lane = await originalAcquire.call(this, signal);
			entered.release();
			await release.promise;
			return lane;
		};
		prewarm = root.session.prewarmShell();
		await withDeadline(world.trace, "H29 real prewarm lane acquired", entered.promise);
		rootOpen = false;
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		release.release();
		await withDeadline(world.trace, "H29 prewarm joins after shutdown", prewarm);
		expect(world.windowsShell.spawns.slice(before).filter((spawn) => spawn.kind === "engine-daemon")).toEqual([]);
		for (const spawn of world.windowsShell.spawns.slice(before))
			expect(world.processTable.isAlive(spawn.pid)).toBe(false);
	} finally {
		release.release();
		ShellLanePool.prototype.acquire = originalAcquire;
		if (prewarm) await prewarm;
		if (rootOpen) await world.disposeSessionInBody(root.session);
	}
	await verifyScheduledWorkerWarmup(world, "engine");
	world.windowsShell.provisionPowerShell();
	try {
		await verifyScheduledWorkerWarmup(world, "floor");
		await verifyHealthyFloor(world);
	} finally {
		world.windowsShell.releasePowerShell();
	}

	const healthy = await world.createRootSession("root", {
		agentDir: `${world.agentDir}-h29-healthy`,
		omitShellOperations: true,
	});
	const healthyBefore = world.windowsShell.spawns.length;
	try {
		world.shell.enqueue({
			name: "h29-healthy-command",
			command: "echo h29-healthy",
			cwd: HARNESS_PROJECT_CWD,
			output: "h29-healthy\n",
			exitCode: 0,
		});
		const result = await withDeadline(
			world.trace,
			"H29 healthy shell command",
			healthy.session.executeBash("echo h29-healthy"),
		);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("h29-healthy");
		expect(
			world.windowsShell.requests.some(
				(request) => request.command === "echo h29-healthy" && request.outcome === "completed",
			),
		).toBe(true);
	} finally {
		expect(await world.disposeSessionInBody(healthy.session)).toBeUndefined();
	}
	const children = world.windowsShell.spawns.slice(healthyBefore);
	expect(children.some((spawn) => spawn.kind === "engine-daemon")).toBe(true);
	for (const spawn of children) expect(world.processTable.isAlive(spawn.pid)).toBe(false);
}

/** The same actual floor still starts, executes a command and closes its child for a live owner. */
async function verifyHealthyFloor(world: HarnessWorld): Promise<void> {
	const root = await world.createRootSession("root", {
		agentDir: `${world.agentDir}-h29-floor-healthy`,
		omitShellOperations: true,
		settings: { windowsShell: { pythonEngine: false } },
	});
	const route = routeShellContract("echo h29-floor-healthy", "win32", { pythonEngine: false });
	if (route.kind === "unsupported") throw new Error(route.error);
	const before = world.windowsShell.spawns.length;
	const requests = world.windowsShell.floorRequests.length;
	try {
		world.shell.enqueue({
			name: "h29-floor-healthy",
			command: route.command,
			cwd: HARNESS_PROJECT_CWD,
			output: "h29-floor-healthy\n",
			exitCode: 0,
		});
		const result = await withDeadline(
			world.trace,
			"H29 healthy PowerShell floor command",
			root.session.executeBash("echo h29-floor-healthy"),
		);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("h29-floor-healthy");
		expect(world.windowsShell.floorRequests.slice(requests)).toMatchObject([
			{ command: route.command, outcome: "completed" },
		]);
	} finally {
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
	}
	const children = world.windowsShell.spawns.slice(before);
	expect(children.some((spawn) => spawn.kind === "powershell-floor")).toBe(true);
	for (const child of children) expect(world.processTable.isAlive(child.pid)).toBe(false);
}

/** Capture only the actual worker tool's deferred callback, then invoke it after the lane's owner joins. */
async function verifyScheduledWorkerWarmup(world: HarnessWorld, tier: "engine" | "floor"): Promise<void> {
	const agentDir = `${world.agentDir}-h29-worker-${tier}`;
	const profile: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "h29-shell-worker",
		description: "Read-only worker with a shell tool.",
		role: "explorer",
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: "harness-script", modelId: "worker-a", thinkingLevel: "off" }],
		},
		capabilityCeiling: ["filesystem.read", "process.exec"],
		readOnly: true,
		toolNames: ["read", "bash"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: {},
		maxConcurrent: 1,
		leaseTtlMs: 60_000,
		requireIndependentVerification: false,
		createdAt: "2026-10-09T00:00:00.000Z",
		updatedAt: "2026-10-09T00:00:00.000Z",
	};
	new OrchestrationProfileStore({ agentDir, cwd: HARNESS_PROJECT_CWD, projectTrusted: false }).save(profile, "global");
	const root = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		omitShellOperations: true,
		settings: {
			memorySystem: "okf",
			autoLearn: { enabled: false },
			proactivity: { enabled: false },
			windowsShell: { pythonEngine: tier === "engine" },
		},
	});
	const originalOptions = RuntimeBuilder.prototype.getSharedLaneToolOptions;
	const scheduled = createBarrier();
	const reached = createBarrier();
	const release = createBarrier();
	const callbacks: Array<() => Promise<void>> = [];
	const before = world.windowsShell.spawns.length;
	const processRefusals = world.processes.unscripted.length;
	const originalAcquire = ShellLanePool.prototype.acquire;
	const floorAcquired = createBarrier();
	const releaseFloor = createBarrier();
	let floorWarm: Promise<void> | undefined;
	let rootOpen = true;
	let prompt: Promise<void> | undefined;
	let dispatchFailure: string | undefined;
	try {
		RuntimeBuilder.prototype.getSharedLaneToolOptions = function () {
			const options = originalOptions.call(this);
			return {
				...options,
				bash: {
					...options.bash,
					scheduleWarmup: (callback) => {
						callbacks.push(callback);
						scheduled.release();
					},
				},
			};
		};
		world.systemOne.enterPhase("h29-worker", ICM_INTAKE_JUDGMENTS);
		world.provider.enqueue(
			"root",
			calls("h29-worker-start", [
				{
					id: "h29-worker-start",
					name: "delegate",
					arguments: {
						action: "start",
						profileId: profile.profileId,
						instructions: "Inspect the project and report.",
					},
				},
			]),
			{
				...text("h29-worker-started", "The worker is running."),
				check: (request) => {
					const result = latestBatchResults(request).find((item) => item.toolName === "delegate");
					if (!result || result.isError) {
						dispatchFailure = result?.text.slice(0, 1000) ?? "delegate result missing";
						throw new Error(`H29 delegate admission failed: ${dispatchFailure}`);
					}
				},
			},
		);
		world.provider.enqueue("worker-a", {
			name: "h29-worker-held",
			check: (request) => {
				expect(request.context.tools?.some((tool) => tool.name === "bash")).toBe(true);
				reached.release();
			},
			gate: release.promise,
			reply: { content: [{ type: "text", text: "Worker stopped." }] },
		});
		prompt = root.session.prompt("Start the shell worker.");
		await withDeadline(
			world.trace,
			"H29 worker scheduled its own warmup",
			Promise.race([
				scheduled.promise,
				prompt.then(() => {
					if (dispatchFailure) throw new Error(`H29 delegate admission failed: ${dispatchFailure}`);
					return scheduled.promise;
				}),
			]),
		);
		await withDeadline(world.trace, "H29 worker entered its provider turn", reached.promise);
		await withDeadline(world.trace, "H29 root dispatch answer is terminal", prompt);
		expect(callbacks).toHaveLength(1);
		if (tier === "floor") {
			let selected = false;
			ShellLanePool.prototype.acquire = async function (signal) {
				if (selected) return originalAcquire.call(this, signal);
				selected = true;
				const lane = await originalAcquire.call(this, signal);
				floorAcquired.release();
				await releaseFloor.promise;
				return lane;
			};
			floorWarm = callbacks[0]!();
			await withDeadline(world.trace, "H29 floor prewarm acquired the worker lane", floorAcquired.promise);
		}
		rootOpen = false;
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		const afterClose = world.windowsShell.spawns.length;
		releaseFloor.release();
		await withDeadline(world.trace, "H29 deferred warmup joins after shutdown", floorWarm ?? callbacks[0]!());
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(world.windowsShell.spawns.slice(afterClose), "closed warmup starts no new process").toEqual([]);
		expect(world.processes.unscripted.length, "the closed warmup attempts no process").toBe(processRefusals);
		for (const spawn of world.windowsShell.spawns.slice(before))
			expect(world.processTable.isAlive(spawn.pid)).toBe(false);
	} finally {
		release.release();
		releaseFloor.release();
		ShellLanePool.prototype.acquire = originalAcquire;
		RuntimeBuilder.prototype.getSharedLaneToolOptions = originalOptions;
		if (rootOpen) await world.disposeSessionInBody(root.session);
		if (floorWarm) await floorWarm;
		if (prompt) await prompt.catch(() => undefined);
	}
}
