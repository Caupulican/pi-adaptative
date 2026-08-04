import { defineConfig } from "vitest/config";
import { piAiSourceAliases } from "./vitest-ai-source-aliases.ts";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		execArgv: ["--conditions=pi-source"],
		experimental: { viteModuleRunner: false },
		include: ["test/harness/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/harness/**/*.ts", "src/agent.ts", "src/agent-loop.ts"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text", "html", "lcov"],
			reportsDirectory: "coverage/harness",
		},
	},
	resolve: {
		alias: piAiSourceAliases,
	},
});
