import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			coverage: {
				provider: "v8",
				all: true,
				include: [
					"src/core/tools/managed-shell-preparation.ts",
					"src/core/bash-execution-controller.ts",
					"src/utils/shell.ts",
					"src/core/tools/shell-test-command.ts",
					"src/core/tools/shell-output-projection.ts",
					"src/core/tools/bash.ts",
					"src/core/tools/tool-task.ts",
					"src/core/background-tool-task-controller.ts",
					"src/core/foreground-terminal-handoff-controller.ts",
					"src/core/tools/goal.ts",
					"src/core/compaction-controller.ts",
					"src/core/agent-session.ts",
					"src/core/runtime-builder.ts",
				],
				exclude: ["src/**/*.d.ts"],
				reporter: ["text", "json-summary"],
				reportsDirectory: "coverage/verification-harness",
				thresholds: {
					perFile: true,
					"src/core/tools/managed-shell-preparation.ts": { statements: 97, branches: 83, functions: 100, lines: 100 },
					"src/core/bash-execution-controller.ts": { statements: 82, branches: 83, functions: 83, lines: 82 },
					"src/utils/shell.ts": { statements: 38, branches: 35, functions: 58, lines: 39 },
					"src/core/tools/shell-test-command.ts": { statements: 96, branches: 91, functions: 100, lines: 99 },
					"src/core/tools/shell-output-projection.ts": { statements: 89, branches: 77, functions: 100, lines: 91 },
					"src/core/tools/bash.ts": { statements: 61, branches: 55, functions: 61, lines: 62 },
					"src/core/tools/tool-task.ts": { statements: 98, branches: 97, functions: 100, lines: 100 },
					"src/core/background-tool-task-controller.ts": { statements: 95, branches: 92, functions: 97, lines: 97 },
					"src/core/foreground-terminal-handoff-controller.ts": { statements: 80, branches: 59, functions: 89, lines: 83 },
					"src/core/tools/goal.ts": { statements: 78, branches: 64, functions: 72, lines: 78 },
					"src/core/compaction-controller.ts": { statements: 90, branches: 82, functions: 96, lines: 93 },
					"src/core/agent-session.ts": { statements: 48, branches: 43, functions: 37, lines: 48 },
					"src/core/runtime-builder.ts": { statements: 54, branches: 47, functions: 37, lines: 54 },
				},
			},
		},
	}),
);
