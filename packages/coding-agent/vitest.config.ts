import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import { piAiSourceAliases } from "../agent/vitest-ai-source-aliases.ts";

const codingAgentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const agentSrcAgent = fileURLToPath(new URL("../agent/src/agent.ts", import.meta.url));
const agentSrcAgentLoop = fileURLToPath(new URL("../agent/src/agent-loop.ts", import.meta.url));
const agentSrcCompaction = fileURLToPath(new URL("../agent/src/compaction/index.ts", import.meta.url));
const agentSrcBranchSummarization = fileURLToPath(
	new URL("../agent/src/compaction/branch-summarization.ts", import.meta.url),
);
const agentSrcCompactionCore = fileURLToPath(new URL("../agent/src/compaction/compaction.ts", import.meta.url));
const agentSrcCompactionLoop = fileURLToPath(new URL("../agent/src/compaction/loop.ts", import.meta.url));
const agentSrcCompactionTokenBudget = fileURLToPath(
	new URL("../agent/src/compaction/token-budget.ts", import.meta.url),
);
const agentSrcMessageRetention = fileURLToPath(
	new URL("../agent/src/session/message-retention.ts", import.meta.url),
);
const agentSrcMessages = fileURLToPath(new URL("../agent/src/messages.ts", import.meta.url));
const agentSrcNode = fileURLToPath(new URL("../agent/src/node.ts", import.meta.url));
const agentSrcPaths = fileURLToPath(new URL("../agent/src/utils/paths.ts", import.meta.url));
const agentSrcProcessTree = fileURLToPath(new URL("../agent/src/reliability/process-tree.ts", import.meta.url));
const agentSrcReliability = fileURLToPath(new URL("../agent/src/reliability/index.ts", import.meta.url));
const agentSrcSession = fileURLToPath(new URL("../agent/src/session/session-manager.ts", import.meta.url));
const agentSrcShellOutput = fileURLToPath(new URL("../agent/src/utils/shell-output.ts", import.meta.url));
const agentSrcToolFailureMemory = fileURLToPath(new URL("../agent/src/tool-failure-memory.ts", import.meta.url));
const agentSrcTruncate = fileURLToPath(new URL("../agent/src/utils/truncate.ts", import.meta.url));
const agentSrcTypes = fileURLToPath(new URL("../agent/src/types.ts", import.meta.url));
const agentSrcUsage = fileURLToPath(new URL("../agent/src/usage.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

const defaultTestExcludes = [
	...configDefaults.exclude,
	...(process.env.PI_RUN_SCRATCH === "1" ? [] : ["**/scratch-*.test.ts"]),
];

// Vitest's native module runner cannot replace several ESM/CJS boundary modules used by these
// tests (Node built-ins, Photon, and resettable theme modules). Keep that bounded compatibility
// surface on Vite 8 while every other coding-agent test uses Node's native TypeScript loader.
const viteMockCompatibilityTests = [
	"test/clipboard-image-bmp-conversion.test.ts",
	"test/clipboard-image.test.ts",
	"test/output-accumulator-io-errors.test.ts",
	"test/restore-sandbox-env.test.ts",
	"test/theme-builtin-resilience.test.ts",
	"test/visual-truncate.test.ts",
];

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		execArgv: ["--conditions=pi-source"],
		experimental: {
			// Node 24 executes this repository's erasable TypeScript directly. Keep Vitest's loader
			// for vi.mock/import.meta.vitest, but skip the whole-graph Vite transform pass.
			viteModuleRunner: false,
		},
		// Many files spawn additional Node processes. Unbounded CPU-based parallelism exhausts
		// memory on development and CI hosts, making unrelated 30s tests fail nondeterministically.
		// Windows runs the same 4 workers: the win32 crashes that once motivated maxWorkers: 1
		// were libuv fs-event path-canonicalization failures (fixed at the root via
		// realpathSync.native temp dirs and fixture portability), not parallel load.
		maxWorkers: 4,
		projects: [
			{
				extends: true,
				test: {
					name: "native-source",
					exclude: [...defaultTestExcludes, ...viteMockCompatibilityTests],
					experimental: { viteModuleRunner: false },
				},
			},
			{
				extends: true,
				test: {
					name: "vite-mock-compatibility",
					include: viteMockCompatibilityTests,
					experimental: { viteModuleRunner: true },
				},
			},
		],
		// Scratch/live-model tests (test/scratch-*.test.ts) are OPT-IN. They gate on a reachable
		// local Ollama and, when it is reachable, run real model generations that time out under CI
		// or parallel load — so a plain `vitest --run` was non-deterministic (runs flipped between
		// green and timeout-failures purely on machine load, which repeatedly muddied verification).
		// Excluded by default so the suite is deterministic and needs no manual --exclude; set
		// PI_RUN_SCRATCH=1 to run them deliberately.
		exclude: defaultTestExcludes,
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			...piAiSourceAliases,
			{ find: /^@caupulican\/pi-adaptative$/, replacement: codingAgentSrcIndex },
			{ find: /^@earendil-works\/pi-coding-agent$/, replacement: codingAgentSrcIndex },
			{ find: /^@mariozechner\/pi-coding-agent$/, replacement: codingAgentSrcIndex },
			{ find: /^@caupulican\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@caupulican\/pi-agent-core\/agent$/, replacement: agentSrcAgent },
			{ find: /^@caupulican\/pi-agent-core\/agent-loop$/, replacement: agentSrcAgentLoop },
			{ find: /^@caupulican\/pi-agent-core\/compaction$/, replacement: agentSrcCompaction },
			{
				find: /^@caupulican\/pi-agent-core\/compaction\/branch-summarization$/,
				replacement: agentSrcBranchSummarization,
			},
			{ find: /^@caupulican\/pi-agent-core\/compaction\/compaction$/, replacement: agentSrcCompactionCore },
			{ find: /^@caupulican\/pi-agent-core\/compaction\/loop$/, replacement: agentSrcCompactionLoop },
			{
				find: /^@caupulican\/pi-agent-core\/compaction\/token-budget$/,
				replacement: agentSrcCompactionTokenBudget,
			},
			{ find: /^@caupulican\/pi-agent-core\/message-retention$/, replacement: agentSrcMessageRetention },
			{ find: /^@caupulican\/pi-agent-core\/messages$/, replacement: agentSrcMessages },
			{ find: /^@caupulican\/pi-agent-core\/node$/, replacement: agentSrcNode },
			{ find: /^@caupulican\/pi-agent-core\/paths$/, replacement: agentSrcPaths },
			{ find: /^@caupulican\/pi-agent-core\/process-tree$/, replacement: agentSrcProcessTree },
			{ find: /^@caupulican\/pi-agent-core\/reliability$/, replacement: agentSrcReliability },
			{ find: /^@caupulican\/pi-agent-core\/session$/, replacement: agentSrcSession },
			{ find: /^@caupulican\/pi-agent-core\/shell-output$/, replacement: agentSrcShellOutput },
			{ find: /^@caupulican\/pi-agent-core\/tool-failure-memory$/, replacement: agentSrcToolFailureMemory },
			{ find: /^@caupulican\/pi-agent-core\/truncate$/, replacement: agentSrcTruncate },
			{ find: /^@caupulican\/pi-agent-core\/types$/, replacement: agentSrcTypes },
			{ find: /^@caupulican\/pi-agent-core\/usage$/, replacement: agentSrcUsage },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@earendil-works\/pi-agent-core\/node$/, replacement: agentSrcNode },
			{ find: /^@earendil-works\/pi-agent-core\/paths$/, replacement: agentSrcPaths },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@mariozechner\/pi-agent-core\/node$/, replacement: agentSrcNode },
			{ find: /^@mariozechner\/pi-agent-core\/paths$/, replacement: agentSrcPaths },
			{ find: /^@caupulican\/pi-tui$/, replacement: tuiSrcIndex },
			{ find: /^@earendil-works\/pi-tui$/, replacement: tuiSrcIndex },
			{ find: /^@mariozechner\/pi-tui$/, replacement: tuiSrcIndex },
		],
	},
});
