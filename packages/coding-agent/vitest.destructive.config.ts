import { defineConfig } from "vitest/config";
import { codingAgentVitestAliases } from "./vitest.shared-aliases.ts";

/**
 * The destructive suite's own, separate vitest config (destructive-testing-blueprint.md §0.4/§5).
 * Invoked only via `test:destructive`(`:crash|chaos|stress|soak`) — never by the default `test`
 * script (`vitest --run`, which resolves `vitest.config.ts` and never this file). Runs the tests
 * under `test-destructive/`, which `vitest.config.ts` explicitly excludes from its own projects.
 */
export default defineConfig({
	test: {
		name: "destructive",
		globals: true,
		environment: "node",
		// Crash sweeps and chaos loops issue many small fs/provider operations across many synthetic
		// worker/goal runs per test; generous relative to the default suite's 30s (blueprint §0.4:
		// full suite budget is 15 minutes, not per-test).
		testTimeout: 120_000,
		execArgv: ["--conditions=pi-source"],
		experimental: {
			viteModuleRunner: false,
		},
		include: ["test-destructive/**/*.test.ts"],
		// Deterministic, one-scenario-at-a-time execution: crash sweeps construct many temp
		// directories and chaos loops drive fake timers, neither of which should interleave across
		// files. Passing with zero matching files is fine for now — stress/ and soak/ are empty until
		// Phase 3 populates them (blueprint §6); an empty sub-selector must not hard-fail Phase 1.
		fileParallelism: false,
		passWithNoTests: true,
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: codingAgentVitestAliases,
	},
});
