import { configDefaults, defineConfig } from "vitest/config";
import { piAiSourceAliases } from "./vitest-ai-source-aliases.ts";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// CI runs the native OS success control alone after the parallel suites. Under competing
		// benchmarks the bounded Windows observer may correctly refuse an unavailable snapshot.
		// Default/local runs include it; deterministic refusal coverage always remains included.
		exclude: [
			...configDefaults.exclude,
			...(process.env.PI_VITEST_ISOLATE_NATIVE_PROCESS === "1"
				? ["test/reliability/process-tree-native-tree.test.ts"]
				: []),
		],
		testTimeout: 30000, // 30 seconds for API calls
		setupFiles: ["../../scripts/vitest-worker-parent-exit.ts"],
		execArgv: ["--conditions=pi-source", "--expose-gc"],
		experimental: { viteModuleRunner: false },
	},
	resolve: {
		alias: piAiSourceAliases,
	},
});
