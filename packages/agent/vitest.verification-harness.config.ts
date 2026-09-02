import { defineConfig } from "vitest/config";
import { piAiSourceAliases } from "./vitest-ai-source-aliases.ts";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30_000,
		execArgv: ["--conditions=pi-source", "--expose-gc"],
		experimental: { viteModuleRunner: false },
		include: [
			"test/verification-obligations.test.ts",
			"test/agent-loop.test.ts",
			"test/compaction/compaction.test.ts",
			"test/compaction/applicable-usage-finder.test.ts",
			"test/compaction/verification.test.ts",
			"test/compaction/session-replacement-compaction.test.ts",
			"test/compaction/branch-summarization.test.ts",
			"test/session/branched-session-manager.test.ts",
			"test/session/build-context.test.ts",
			"test/session/compacted-payload-release.test.ts",
			"test/session/latest-custom-entry-on-branch.test.ts",
			"test/session/session-context-cache.test.ts",
		],
		coverage: {
			provider: "v8",
			all: true,
			include: [
				"src/verification-obligations.ts",
				"src/agent-loop.ts",
				"src/messages.ts",
				"src/compaction/compaction.ts",
				"src/compaction/branch-summarization.ts",
				"src/session/session-manager.ts",
			],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text", "json-summary"],
			reportsDirectory: "coverage/verification-harness",
			thresholds: {
				perFile: true,
				"src/verification-obligations.ts": { statements: 95, branches: 92, functions: 100, lines: 100 },
				"src/agent-loop.ts": { statements: 75, branches: 66, functions: 80, lines: 77 },
				"src/messages.ts": { statements: 35, branches: 12, functions: 85, lines: 35 },
				"src/compaction/compaction.ts": { statements: 71, branches: 64, functions: 71, lines: 71 },
				"src/compaction/branch-summarization.ts": { statements: 60, branches: 46, functions: 75, lines: 63 },
				"src/session/session-manager.ts": { statements: 50, branches: 39, functions: 49, lines: 51 },
			},
		},
	},
	resolve: {
		alias: piAiSourceAliases,
	},
});
