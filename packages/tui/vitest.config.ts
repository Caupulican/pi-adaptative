import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/wrap-ansi.test.ts"],
		passWithNoTests: true,
		execArgv: ["--conditions=pi-source"],
		experimental: { viteModuleRunner: false },
	},
});
