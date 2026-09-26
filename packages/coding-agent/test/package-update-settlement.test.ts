// @isolated: exercises private package update concurrency with manually controlled promises
// @guards src/core/package-manager.ts

import { describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { tempDir } from "./temp-dir.ts";

type InstalledScope = "user" | "project";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
};

type PackageManagerInternals = {
	runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]>;
	shouldUpdateNpmSource(source: unknown, scope: InstalledScope): Promise<boolean>;
	updateConfiguredSources(sources: Array<{ source: string; scope: InstalledScope }>): Promise<void>;
	updateGit(source: { path: string }, scope: InstalledScope): Promise<void>;
	updateNpmBatch(sources: readonly unknown[], scope: InstalledScope): Promise<void>;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function createManager(): PackageManagerInternals {
	const scratch = tempDir("package-update-settlement-");
	return new DefaultPackageManager({
		cwd: scratch,
		agentDir: scratch,
		settingsManager: SettingsManager.inMemory(),
	}) as unknown as PackageManagerInternals;
}

async function observeSettlement(operation: Promise<unknown>): Promise<{
	settled: () => boolean;
	rejection: () => unknown;
	terminal: Promise<unknown>;
}> {
	let didSettle = false;
	let rejection: unknown;
	const terminal = operation
		.catch((error: unknown) => {
			rejection = error;
		})
		.finally(() => {
			didSettle = true;
		});
	await Promise.resolve();
	return {
		settled: () => didSettle,
		rejection: () => rejection,
		terminal,
	};
}

describe("package update settlement", () => {
	it("waits for independent npm and git mutations before publishing an update failure", async () => {
		const manager = createManager();
		const allStarted = deferred<void>();
		const failUserNpm = deferred<void>();
		const releaseProjectNpm = deferred<void>();
		const releaseGit = deferred<void>();
		const failure = new Error("user npm update failed");
		let started = 0;
		const noteStarted = () => {
			started += 1;
			if (started === 3) allStarted.resolve();
		};

		manager.shouldUpdateNpmSource = async () => true;
		manager.updateNpmBatch = async (_sources, scope) => {
			noteStarted();
			if (scope === "user") {
				await failUserNpm.promise;
				throw failure;
			}
			await releaseProjectNpm.promise;
		};
		manager.updateGit = async () => {
			noteStarted();
			await releaseGit.promise;
		};

		const operation = manager.updateConfiguredSources([
			{ source: "npm:user-extension", scope: "user" },
			{ source: "npm:project-extension", scope: "project" },
			{ source: "git:github.com/example/git-extension", scope: "user" },
		]);
		await allStarted.promise;
		const observed = await observeSettlement(operation);

		failUserNpm.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(observed.settled()).toBe(false);
		releaseProjectNpm.resolve();
		releaseGit.resolve();
		await observed.terminal;
		expect(observed.rejection()).toBe(failure);
	});

	it("waits for every active bounded worker before publishing a worker failure", async () => {
		const manager = createManager();
		const allStarted = deferred<void>();
		const failFirst = deferred<void>();
		const releaseSecond = deferred<void>();
		const releaseThird = deferred<void>();
		const failure = new Error("first worker failed");
		let started = 0;
		const task = (gate: Deferred<void>, error?: Error) => async () => {
			started += 1;
			if (started === 3) allStarted.resolve();
			await gate.promise;
			if (error) throw error;
			return started;
		};

		const operation = manager.runWithConcurrency(
			[task(failFirst, failure), task(releaseSecond), task(releaseThird)],
			3,
		);
		await allStarted.promise;
		const observed = await observeSettlement(operation);

		failFirst.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(observed.settled()).toBe(false);
		releaseSecond.resolve();
		releaseThird.resolve();
		await observed.terminal;
		expect(observed.rejection()).toBe(failure);
	});

	it("retains task-order results when bounded workers complete out of order", async () => {
		const manager = createManager();
		const first = deferred<void>();
		const second = deferred<void>();
		const operation = manager.runWithConcurrency(
			[
				async () => {
					await first.promise;
					return "first";
				},
				async () => {
					await second.promise;
					return "second";
				},
			],
			2,
		);

		second.resolve();
		await Promise.resolve();
		first.resolve();

		await expect(operation).resolves.toEqual(["first", "second"]);
	});

	it("waits for active workers before aggregating multiple failures", async () => {
		const manager = createManager();
		const failFirst = deferred<void>();
		const failSecond = deferred<void>();
		const releaseThird = deferred<void>();
		const firstFailure = new Error("first worker failed");
		const secondFailure = new Error("second worker failed");
		const operation = manager.runWithConcurrency(
			[
				async () => {
					await failFirst.promise;
					throw firstFailure;
				},
				async () => {
					await failSecond.promise;
					throw secondFailure;
				},
				async () => {
					await releaseThird.promise;
					return "third";
				},
			],
			3,
		);
		const observed = await observeSettlement(operation);

		failSecond.resolve();
		failFirst.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(observed.settled()).toBe(false);
		releaseThird.resolve();
		await observed.terminal;
		const rejection = observed.rejection();
		expect(rejection).toBeInstanceOf(AggregateError);
		expect((rejection as AggregateError).errors).toEqual([firstFailure, secondFailure]);
	});
});
