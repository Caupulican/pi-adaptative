import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/wrap-ansi.test.ts"],
		passWithNoTests: true,
		setupFiles: ["../../scripts/vitest-worker-parent-exit.ts"],
		execArgv: ["--conditions=pi-source"],
		experimental: { viteModuleRunner: false },
	},
});
