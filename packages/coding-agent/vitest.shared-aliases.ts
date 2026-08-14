/**
 * Path aliases shared between vitest.config.ts (the default suite) and vitest.destructive.config.ts
 * (the destructive suite, test:destructive). Extracted so the destructive config can reuse them
 * without editing vitest.config.ts — the default suite's config stays byte-for-byte as it was before
 * this file existed, which is exactly the "add the destructive project WITHOUT touching the default
 * project" guarantee the destructive-testing blueprint (§0.4/§0.5) requires.
 */
import { fileURLToPath } from "node:url";
import type { AliasOptions } from "vite";
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

export const codingAgentVitestAliases: AliasOptions = [
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
];
