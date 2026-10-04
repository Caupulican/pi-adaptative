import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { piAiSourceAliases } from "./vitest-ai-source-aliases.ts";

const codingAgentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("./src/kernel/index.ts", import.meta.url));
const agentSrcAgent = fileURLToPath(new URL("./src/kernel/agent.ts", import.meta.url));
const agentSrcVerificationObligations = fileURLToPath(
	new URL("./src/kernel/verification-obligations.ts", import.meta.url),
);
const agentSrcAgentLoop = fileURLToPath(new URL("./src/kernel/agent-loop.ts", import.meta.url));
const agentSrcCompaction = fileURLToPath(new URL("./src/kernel/compaction/index.ts", import.meta.url));
const agentSrcBranchSummarization = fileURLToPath(
	new URL("./src/kernel/compaction/branch-summarization.ts", import.meta.url),
);
const agentSrcCompactionCore = fileURLToPath(new URL("./src/kernel/compaction/compaction.ts", import.meta.url));
const agentSrcCompactionLoop = fileURLToPath(new URL("./src/kernel/compaction/loop.ts", import.meta.url));
const agentSrcCompactionTokenBudget = fileURLToPath(
	new URL("./src/kernel/compaction/token-budget.ts", import.meta.url),
);
const agentSrcMessageRetention = fileURLToPath(
	new URL("./src/kernel/session/message-retention.ts", import.meta.url),
);
const agentSrcMessages = fileURLToPath(new URL("./src/kernel/messages.ts", import.meta.url));
const agentSrcNode = fileURLToPath(new URL("./src/kernel/node.ts", import.meta.url));
const agentSrcPaths = fileURLToPath(new URL("./src/kernel/utils/paths.ts", import.meta.url));
const agentSrcProcessTree = fileURLToPath(new URL("./src/kernel/reliability/process-tree.ts", import.meta.url));
const agentSrcProviderRequestEstimator = fileURLToPath(
	new URL("./src/kernel/provider-request-estimator.ts", import.meta.url),
);
const agentSrcProviderRequestPlanner = fileURLToPath(
	new URL("./src/kernel/provider-request-planner.ts", import.meta.url),
);
const agentSrcProviderToolProjection = fileURLToPath(
	new URL("./src/kernel/provider-tool-projection.ts", import.meta.url),
);
const agentSrcReliability = fileURLToPath(new URL("./src/kernel/reliability/index.ts", import.meta.url));
const agentSrcSession = fileURLToPath(new URL("./src/kernel/session/session-manager.ts", import.meta.url));
const agentSrcShellOutput = fileURLToPath(new URL("./src/kernel/utils/shell-output.ts", import.meta.url));
const agentSrcToolFailureMemory = fileURLToPath(new URL("./src/kernel/tool-failure-memory.ts", import.meta.url));
const agentSrcToolProtocolResidue = fileURLToPath(new URL("./src/kernel/tool-protocol-residue.ts", import.meta.url));
const agentSrcTruncate = fileURLToPath(new URL("./src/kernel/utils/truncate.ts", import.meta.url));
const agentSrcTypes = fileURLToPath(new URL("./src/kernel/types.ts", import.meta.url));
const agentSrcUsage = fileURLToPath(new URL("./src/kernel/usage.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		setupFiles: ["../../scripts/vitest-worker-parent-exit.ts"],
		execArgv: ["--conditions=pi-source"],
		experimental: {
			// Node 24 executes this repository's erasable TypeScript directly. Keep Vitest's loader
			// for vi.mock/import.meta.vitest, but skip the whole-graph Vite transform pass.
			viteModuleRunner: false,
		},
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
			{
				find: /^@caupulican\/pi-agent-core\/verification-obligations$/,
				replacement: agentSrcVerificationObligations,
			},
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
			{
				find: /^@caupulican\/pi-agent-core\/provider-request-estimator$/,
				replacement: agentSrcProviderRequestEstimator,
			},
			{
				find: /^@caupulican\/pi-agent-core\/provider-request-planner$/,
				replacement: agentSrcProviderRequestPlanner,
			},
			{
				find: /^@caupulican\/pi-agent-core\/provider-tool-projection$/,
				replacement: agentSrcProviderToolProjection,
			},
			{ find: /^@caupulican\/pi-agent-core\/reliability$/, replacement: agentSrcReliability },
			{ find: /^@caupulican\/pi-agent-core\/session$/, replacement: agentSrcSession },
			{ find: /^@caupulican\/pi-agent-core\/shell-output$/, replacement: agentSrcShellOutput },
			{ find: /^@caupulican\/pi-agent-core\/tool-failure-memory$/, replacement: agentSrcToolFailureMemory },
			{ find: /^@caupulican\/pi-agent-core\/tool-protocol-residue$/, replacement: agentSrcToolProtocolResidue },
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
