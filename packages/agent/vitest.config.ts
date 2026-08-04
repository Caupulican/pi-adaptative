import { defineConfig } from "vitest/config";
import { piAiSourceAliases } from "./vitest-ai-source-aliases.ts";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		execArgv: ["--conditions=pi-source"],
		experimental: { viteModuleRunner: false },
	},
	resolve: {
		alias: piAiSourceAliases,
	},
});
