import { mkdtempSync, rmSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Covers the lazy-install mechanism behind FFF native search (see
 * src/utils/tools-manager.ts and src/core/tools/fff-search-backend.ts):
 *
 * - Genuine "not applicable" conditions (offline mode, unsupported platform)
 *   must fall back cleanly without ever spawning a doomed install, and the
 *   reason must be observable (for a future `doctor` check) instead of only a
 *   console log.
 * - A real install ATTEMPT that fails (as opposed to "not applicable") must
 *   not permanently gate FFF out for the rest of the process: the next search
 *   must get a chance to retry instead of being silently stuck on the fd/rg
 *   fallback forever (see fff-search-tools.test.ts for the companion fix that
 *   ensures the install is attempted in the first place).
 */

// tools-manager.ts imports from the bare "os" specifier; mock that exact
// specifier so its `platform()`/`arch()` calls are the ones under test.
vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, platform: vi.fn(actual.platform), arch: vi.fn(actual.arch) };
});

async function withFreshManagedDir<T>(fn: () => Promise<T>): Promise<T> {
	const tempAgentDir = mkdtempSync(join(tmpdir(), "pi-agent-fresh-"));
	vi.resetModules();
	const config = await import("../src/config.ts");
	const envKey = config.ENV_AGENT_DIR;
	const previous = process.env[envKey];
	process.env[envKey] = tempAgentDir;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env[envKey];
		else process.env[envKey] = previous;
		rmSync(tempAgentDir, { recursive: true, force: true });
	}
}

describe("tools-manager: ensureFffNodePackage graceful fallbacks", () => {
	const previousOffline = process.env.PI_OFFLINE;

	afterEach(() => {
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
		// Offline mode is checked before platform/arch, so the offline case never
		// touches these mocks; only reset what the unsupported-platform case sets.
		vi.mocked(platform).mockReset();
		vi.mocked(arch).mockReset();
	});

	it("does not attempt a doomed install when offline mode is enabled, and records why", async () => {
		await withFreshManagedDir(async () => {
			process.env.PI_OFFLINE = "1";
			const toolsManager = await import("../src/utils/tools-manager.ts");

			// [] means "nothing is require-able" REGARDLESS of the ambient
			// environment: @ff-labs/fff-node is a real npm dependency
			// (package.json), so without this override, a CI box where `npm ci`
			// actually provisioned it would see loadAvailableFffNodePackage()
			// return the real module -- short-circuiting ensureFffNodePackage on
			// "already-available" before it ever reaches the offline check. This
			// exact gap broke the v0.80.101 CI publish (this file passed locally
			// only because our dev checkout never resolves fff-node this way; see
			// getLastFffInstallOutcome() reasoning in loadAvailableFffNodePackage's
			// doc comment).
			expect(toolsManager.loadAvailableFffNodePackage([])).toBeUndefined();

			const start = Date.now();
			const result = await toolsManager.ensureFffNodePackage(true, false, []);
			const elapsedMs = Date.now() - start;

			expect(result).toBeUndefined();
			// A real install spawns npm and hits the network; offline mode must bail
			// out well before that, not merely "eventually" fall back.
			expect(elapsedMs).toBeLessThan(2000);
			expect(toolsManager.getLastFffInstallOutcome()).toEqual({ status: "offline" });
		});
	});

	it("does not attempt a doomed install on an unsupported platform, and records why", async () => {
		await withFreshManagedDir(async () => {
			delete process.env.PI_OFFLINE;
			vi.mocked(platform).mockReturnValue("sunos" as NodeJS.Platform);
			vi.mocked(arch).mockReturnValue("mips" as NodeJS.Architecture);

			const toolsManager = await import("../src/utils/tools-manager.ts");
			// See the sibling offline-mode test above for why [] is required here
			// regardless of whether @ff-labs/fff-node happens to be resolvable in
			// the environment running this test.
			expect(toolsManager.loadAvailableFffNodePackage([])).toBeUndefined();

			const start = Date.now();
			const result = await toolsManager.ensureFffNodePackage(true, false, []);
			const elapsedMs = Date.now() - start;

			expect(result).toBeUndefined();
			expect(elapsedMs).toBeLessThan(2000);
			expect(toolsManager.getLastFffInstallOutcome()).toEqual({ status: "unsupported-platform" });
		});
	});
});

describe("tools-manager: install-failed cooldown gates the npm spawn, not eviction", () => {
	// The cooldown must throttle ensureFffNodePackage's willingness to spawn a
	// NEW npm install, not whether a failed finder is evicted from
	// DefaultFffSearchBackend's cache (see isFffInstallRetryable, which is
	// intentionally cooldown-independent: a failed finder is ALWAYS evicted so
	// the next search re-enters ensureFffNodePackage, and it's this cooldown
	// check -- evaluated fresh, at that later call's own time -- that decides
	// whether the re-entry is a real attempt or a fast, spawn-free bail).
	//
	// An earlier version got this backwards: it gated EVICTION on the cooldown.
	// That check ran once, in the promise-resolution handler attached at the
	// moment createFinder was called -- i.e. it fired the instant the install
	// failed, when elapsed time was ~0ms and therefore always "still cooling
	// down". The failed finder was never evicted, so the retry (and the
	// cooldown expiring) never got a chance to happen at all: one transient
	// failure permanently gated FFF out for that basePath for the rest of the
	// process -- a variant of the exact bug this whole fix targets.
	it("is not cooling down immediately after a failure, but is once the cooldown elapses", async () => {
		const toolsManager = await import("../src/utils/tools-manager.ts");
		const failedOutcome: { status: "install-failed"; reason: string } = {
			status: "install-failed",
			reason: "registry timeout",
		};
		const failedAt = 1_000_000;

		expect(toolsManager.computeIsFffInstallCoolingDown(failedOutcome, failedAt, failedAt)).toBe(true);
		expect(
			toolsManager.computeIsFffInstallCoolingDown(
				failedOutcome,
				failedAt,
				failedAt + toolsManager.FFF_INSTALL_RETRY_COOLDOWN_MS - 1,
			),
		).toBe(true);
		expect(
			toolsManager.computeIsFffInstallCoolingDown(
				failedOutcome,
				failedAt,
				failedAt + toolsManager.FFF_INSTALL_RETRY_COOLDOWN_MS,
			),
		).toBe(false);
	});

	it("is never cooling down for a stable not-applicable outcome, regardless of elapsed time", async () => {
		const toolsManager = await import("../src/utils/tools-manager.ts");
		expect(toolsManager.computeIsFffInstallCoolingDown({ status: "offline" }, 0, Number.MAX_SAFE_INTEGER)).toBe(
			false,
		);
		expect(
			toolsManager.computeIsFffInstallCoolingDown({ status: "unsupported-platform" }, 0, Number.MAX_SAFE_INTEGER),
		).toBe(false);
	});

	it("real integration: does not re-spawn npm within the cooldown, but does after it elapses (real clock control, no injected retryability)", async () => {
		await withFreshManagedDir(async () => {
			delete process.env.PI_OFFLINE;
			const originalPath = process.env.PATH;
			// No mocking of child_process: make `npm` itself unresolvable so the
			// install genuinely, quickly, and deterministically fails -- a real
			// install-failed outcome with no network dependency.
			process.env.PATH = "";
			const nowSpy = vi.spyOn(Date, "now");
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
			const attemptCount = () =>
				logSpy.mock.calls.filter((call) => String(call[0]).includes("Installing managed FFF package")).length;

			try {
				const toolsManager = await import("../src/utils/tools-manager.ts");
				// [] forces "nothing already available" on every call below,
				// regardless of whether @ff-labs/fff-node happens to be resolvable
				// in the environment running this test (see the offline-mode test
				// above) -- otherwise the `existing` short-circuit in
				// ensureFffNodePackage would return early on "already-available"
				// and this test would never reach the install attempt it's
				// actually proving out.
				const noneAvailable: readonly ((id: string) => unknown)[] = [];

				nowSpy.mockReturnValue(1_000_000);
				const first = await toolsManager.ensureFffNodePackage(false, false, noneAvailable);
				expect(first).toBeUndefined();
				expect(toolsManager.getLastFffInstallOutcome()?.status).toBe("install-failed");
				expect(attemptCount()).toBe(1);

				// Still within the cooldown: must bail fast, without a new attempt.
				nowSpy.mockReturnValue(1_000_000 + toolsManager.FFF_INSTALL_RETRY_COOLDOWN_MS - 1);
				const second = await toolsManager.ensureFffNodePackage(false, false, noneAvailable);
				expect(second).toBeUndefined();
				expect(attemptCount()).toBe(1);

				// Past the cooldown: must attempt again (it still fails, since npm
				// is still unresolvable, but a NEW attempt is what we're proving).
				nowSpy.mockReturnValue(1_000_000 + toolsManager.FFF_INSTALL_RETRY_COOLDOWN_MS);
				const third = await toolsManager.ensureFffNodePackage(false, false, noneAvailable);
				expect(third).toBeUndefined();
				expect(attemptCount()).toBe(2);
			} finally {
				process.env.PATH = originalPath;
				nowSpy.mockRestore();
				logSpy.mockRestore();
			}
		});
	}, 20_000);
});

describe("DefaultFffSearchBackend: install retry semantics", () => {
	function fakeFinder() {
		return {
			isDestroyed: false,
			destroy: () => {},
			fileSearch: () => ({ ok: true as const, value: { items: [], scores: [], totalMatched: 0, totalFiles: 0 } }),
			glob: () => ({ ok: true as const, value: { items: [], scores: [], totalMatched: 0, totalFiles: 0 } }),
			grep: () => ({
				ok: true as const,
				value: {
					items: [],
					totalMatched: 0,
					totalFilesSearched: 0,
					totalFiles: 0,
					filteredFileCount: 0,
					nextCursor: null,
				},
			}),
			waitForScan: async () => ({ ok: true as const, value: true }),
		};
	}

	function fakeModule(available: boolean) {
		return {
			FileFinder: {
				create: () => ({ ok: true as const, value: fakeFinder() }),
				isAvailable: () => available,
			},
		};
	}

	it("does not permanently gate FFF out after a genuine install failure -- the next search retries", async () => {
		const { DefaultFffSearchBackend } = await import("../src/core/tools/fff-search-backend.ts");

		let ensureModuleCalls = 0;
		const backend = new DefaultFffSearchBackend({
			ensureFffModule: async () => {
				ensureModuleCalls++;
				// First search: nothing loadable yet, and the (faked) install attempt
				// fails. Second search: the retry succeeds.
				return ensureModuleCalls === 1 ? null : (fakeModule(true) as any);
			},
			ensureFffNodePackage: async () => undefined,
			isInstallRetryable: () => true, // simulates tools-manager reporting "install-failed", not "offline"/"unsupported"
		});

		const first = await backend.getFinder("/tmp/does-not-matter-1");
		expect(first).toBeUndefined();

		const second = await backend.getFinder("/tmp/does-not-matter-1");
		expect(second).toBeDefined();
		expect(ensureModuleCalls).toBe(2);
	});

	it("does not retry when the last outcome was a stable not-applicable condition (offline/unsupported platform)", async () => {
		const { DefaultFffSearchBackend } = await import("../src/core/tools/fff-search-backend.ts");

		let ensureModuleCalls = 0;
		const backend = new DefaultFffSearchBackend({
			ensureFffModule: async () => {
				ensureModuleCalls++;
				return null;
			},
			ensureFffNodePackage: async () => undefined,
			isInstallRetryable: () => false, // simulates tools-manager reporting "offline" or "unsupported-platform"
		});

		const first = await backend.getFinder("/tmp/does-not-matter-2");
		expect(first).toBeUndefined();

		const second = await backend.getFinder("/tmp/does-not-matter-2");
		expect(second).toBeUndefined();
		// No retry: repeating a stable "not applicable" outcome on every search
		// would be a redundant install-check, not a fix.
		expect(ensureModuleCalls).toBe(1);
	});

	it("uses the real tools-manager wiring by default (no deps injected)", async () => {
		const { DefaultFffSearchBackend } = await import("../src/core/tools/fff-search-backend.ts");
		// Just proves the class is constructible with no args and implements the
		// FffSearchBackend contract -- the production singleton relies on this.
		const backend = new DefaultFffSearchBackend();
		expect(typeof backend.getFinder).toBe("function");
	});
});
