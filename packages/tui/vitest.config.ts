import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		passWithNoTests: true,
		setupFiles: ["../../scripts/vitest-worker-parent-exit.ts"],
		execArgv: ["--conditions=pi-source"],
		experimental: { viteModuleRunner: false },
	},
});
