import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { piAiSourceAliases } from "../agent/vitest-ai-source-aliases.ts";

const codingAgentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const agentSrcAgent = fileURLToPath(new URL("../agent/src/agent.ts", import.meta.url));
const agentSrcVerificationObligations = fileURLToPath(
	new URL("../agent/src/verification-obligations.ts", import.meta.url),
);
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
const agentSrcProviderRequestEstimator = fileURLToPath(
	new URL("../agent/src/provider-request-estimator.ts", import.meta.url),
);
const agentSrcProviderRequestPlanner = fileURLToPath(
	new URL("../agent/src/provider-request-planner.ts", import.meta.url),
);
const agentSrcProviderToolProjection = fileURLToPath(
	new URL("../agent/src/provider-tool-projection.ts", import.meta.url),
);
const agentSrcReliability = fileURLToPath(new URL("../agent/src/reliability/index.ts", import.meta.url));
const agentSrcSession = fileURLToPath(new URL("../agent/src/session/session-manager.ts", import.meta.url));
const agentSrcShellOutput = fileURLToPath(new URL("../agent/src/utils/shell-output.ts", import.meta.url));
const agentSrcToolFailureMemory = fileURLToPath(new URL("../agent/src/tool-failure-memory.ts", import.meta.url));
const agentSrcToolProtocolResidue = fileURLToPath(new URL("../agent/src/tool-protocol-residue.ts", import.meta.url));
const agentSrcTruncate = fileURLToPath(new URL("../agent/src/utils/truncate.ts", import.meta.url));
const agentSrcTypes = fileURLToPath(new URL("../agent/src/types.ts", import.meta.url));
const agentSrcUsage = fileURLToPath(new URL("../agent/src/usage.ts", import.meta.url));
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
