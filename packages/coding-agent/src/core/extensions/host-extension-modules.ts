/**
 * Registers the host program's own module instances for extensions (see `registerHostExtensionModules`).
 * Imported for its effect by the process entries only (`cli.ts` before it loads `main.ts`, and first
 * thing by the Bun entry, whose bundler needs these imports static). Nothing inside the program imports
 * it, so it never closes an import cycle through the program entry it namespace-imports.
 */

import * as bundledPiAi from "@caupulican/pi-ai";
import * as bundledPiAiAbortSignals from "@caupulican/pi-ai/abort-signals";
import * as bundledPiAiApiRegistry from "@caupulican/pi-ai/api-registry";
import * as bundledPiAiBedrockProvider from "@caupulican/pi-ai/bedrock-provider";
import * as bundledPiAiEnvApiKeys from "@caupulican/pi-ai/env-api-keys";
import * as bundledPiAiEventStream from "@caupulican/pi-ai/event-stream";
import * as bundledPiAiFaux from "@caupulican/pi-ai/faux";
import * as bundledPiAiJsonParse from "@caupulican/pi-ai/json-parse";
import * as bundledPiAiModels from "@caupulican/pi-ai/models";
import * as bundledPiAiOauth from "@caupulican/pi-ai/oauth";
import * as bundledPiAiOverflow from "@caupulican/pi-ai/overflow";
import * as bundledPiAiProviderRetry from "@caupulican/pi-ai/provider-retry";
import * as bundledPiAiRegisterBuiltins from "@caupulican/pi-ai/register-builtins";
import * as bundledPiAiSessionResources from "@caupulican/pi-ai/session-resources";
import * as bundledPiAiStream from "@caupulican/pi-ai/stream";
import * as bundledPiAiStreamingLines from "@caupulican/pi-ai/streaming-lines";
import * as bundledPiAiTextToolProtocol from "@caupulican/pi-ai/text-tool-protocol";
import * as bundledPiAiToolRepairRegistry from "@caupulican/pi-ai/tool-repair-registry";
import * as bundledPiAiTypeboxHelpers from "@caupulican/pi-ai/typebox-helpers";
import * as bundledPiAiTypes from "@caupulican/pi-ai/types";
import * as bundledPiAiUsage from "@caupulican/pi-ai/usage";
import * as bundledPiAiUuid from "@caupulican/pi-ai/uuid";
import * as bundledPiAiValidation from "@caupulican/pi-ai/validation";
import * as bundledPiAiValidationPath from "@caupulican/pi-ai/validation-path";
import * as bundledPiTui from "@caupulican/pi-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
import * as bundledPiCodingAgent from "../../index.ts";
import * as bundledPiAgentCoreAgent from "../../kernel/agent.ts";
import * as bundledPiAgentCoreAgentLoop from "../../kernel/agent-loop.ts";
import * as bundledPiAgentCoreBranchSummarization from "../../kernel/compaction/branch-summarization.ts";
import * as bundledPiAgentCoreCompactionCore from "../../kernel/compaction/compaction.ts";
import * as bundledPiAgentCoreCompaction from "../../kernel/compaction/index.ts";
import * as bundledPiAgentCoreCompactionLoop from "../../kernel/compaction/loop.ts";
import * as bundledPiAgentCoreTokenBudget from "../../kernel/compaction/token-budget.ts";
import * as bundledPiAgentCore from "../../kernel/index.ts";
import * as bundledPiAgentCoreMessages from "../../kernel/messages.ts";
import * as bundledPiAgentCoreNode from "../../kernel/node.ts";
import * as bundledPiAgentCoreProviderRequestEstimator from "../../kernel/provider-request-estimator.ts";
import * as bundledPiAgentCoreProviderRequestImageBudget from "../../kernel/provider-request-image-budget.ts";
import * as bundledPiAgentCoreProviderRequestPlanner from "../../kernel/provider-request-planner.ts";
import * as bundledPiAgentCoreProviderToolProjection from "../../kernel/provider-tool-projection.ts";
import * as bundledPiAgentCoreReliability from "../../kernel/reliability/index.ts";
import * as bundledPiAgentCoreProcessTree from "../../kernel/reliability/process-tree.ts";
import * as bundledPiAgentCoreMessageRetention from "../../kernel/session/message-retention.ts";
import * as bundledPiAgentCoreSession from "../../kernel/session/session-manager.ts";
import * as bundledPiAgentCoreToolFailureMemory from "../../kernel/tool-failure-memory.ts";
import * as bundledPiAgentCoreToolProtocolResidue from "../../kernel/tool-protocol-residue.ts";
import * as bundledPiAgentCoreTypes from "../../kernel/types.ts";
import * as bundledPiAgentCoreUsage from "../../kernel/usage.ts";
import * as bundledPiAgentCorePaths from "../../kernel/utils/paths.ts";
import * as bundledPiAgentCoreShellOutput from "../../kernel/utils/shell-output.ts";
import * as bundledPiAgentCoreTruncate from "../../kernel/utils/truncate.ts";
import * as bundledPiAgentCoreVerificationObligations from "../../kernel/verification-obligations.ts";
import {
	type PiAgentCoreExtensionSubpath,
	type PiAiExtensionSubpath,
	registerHostExtensionModules,
} from "./virtual-modules.ts";

const piAgentCoreVirtualSubpaths: Record<PiAgentCoreExtensionSubpath, unknown> = {
	agent: bundledPiAgentCoreAgent,
	"agent-loop": bundledPiAgentCoreAgentLoop,
	"verification-obligations": bundledPiAgentCoreVerificationObligations,
	compaction: bundledPiAgentCoreCompaction,
	"compaction/branch-summarization": bundledPiAgentCoreBranchSummarization,
	"compaction/compaction": bundledPiAgentCoreCompactionCore,
	"compaction/loop": bundledPiAgentCoreCompactionLoop,
	"compaction/token-budget": bundledPiAgentCoreTokenBudget,
	"message-retention": bundledPiAgentCoreMessageRetention,
	messages: bundledPiAgentCoreMessages,
	node: bundledPiAgentCoreNode,
	paths: bundledPiAgentCorePaths,
	"process-tree": bundledPiAgentCoreProcessTree,
	"provider-request-estimator": bundledPiAgentCoreProviderRequestEstimator,
	"provider-request-image-budget": bundledPiAgentCoreProviderRequestImageBudget,
	"provider-request-planner": bundledPiAgentCoreProviderRequestPlanner,
	"provider-tool-projection": bundledPiAgentCoreProviderToolProjection,
	reliability: bundledPiAgentCoreReliability,
	session: bundledPiAgentCoreSession,
	"shell-output": bundledPiAgentCoreShellOutput,
	"tool-failure-memory": bundledPiAgentCoreToolFailureMemory,
	"tool-protocol-residue": bundledPiAgentCoreToolProtocolResidue,
	truncate: bundledPiAgentCoreTruncate,
	types: bundledPiAgentCoreTypes,
	usage: bundledPiAgentCoreUsage,
};

const piAiVirtualSubpaths: Record<PiAiExtensionSubpath, unknown> = {
	"api-registry": bundledPiAiApiRegistry,
	"abort-signals": bundledPiAiAbortSignals,
	"bedrock-provider": bundledPiAiBedrockProvider,
	"event-stream": bundledPiAiEventStream,
	"env-api-keys": bundledPiAiEnvApiKeys,
	faux: bundledPiAiFaux,
	"json-parse": bundledPiAiJsonParse,
	models: bundledPiAiModels,
	oauth: bundledPiAiOauth,
	overflow: bundledPiAiOverflow,
	"provider-retry": bundledPiAiProviderRetry,
	"register-builtins": bundledPiAiRegisterBuiltins,
	stream: bundledPiAiStream,
	"session-resources": bundledPiAiSessionResources,
	"streaming-lines": bundledPiAiStreamingLines,
	"text-tool-protocol": bundledPiAiTextToolProtocol,
	"tool-repair-registry": bundledPiAiToolRepairRegistry,
	"typebox-helpers": bundledPiAiTypeboxHelpers,
	types: bundledPiAiTypes,
	usage: bundledPiAiUsage,
	uuid: bundledPiAiUuid,
	validation: bundledPiAiValidation,
	"validation-path": bundledPiAiValidationPath,
};

function piAiVirtualModules(packageName: string): Record<string, unknown> {
	return Object.fromEntries([
		[packageName, bundledPiAi],
		...Object.entries(piAiVirtualSubpaths).map(([subpath, module]) => [`${packageName}/${subpath}`, module]),
	]);
}

function piAgentCoreVirtualModules(packageName: string): Record<string, unknown> {
	return Object.fromEntries([
		[packageName, bundledPiAgentCore],
		...Object.entries(piAgentCoreVirtualSubpaths).map(([subpath, module]) => [`${packageName}/${subpath}`, module]),
	]);
}

registerHostExtensionModules({
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	...piAgentCoreVirtualModules("@caupulican/pi-agent-core"),
	"@caupulican/pi-tui": bundledPiTui,
	...piAiVirtualModules("@caupulican/pi-ai"),
	"@caupulican/pi-adaptative": bundledPiCodingAgent,
	...piAgentCoreVirtualModules("@earendil-works/pi-agent-core"),
	"@earendil-works/pi-tui": bundledPiTui,
	...piAiVirtualModules("@earendil-works/pi-ai"),
	"@earendil-works/pi-coding-agent": bundledPiCodingAgent,
	...piAgentCoreVirtualModules("@mariozechner/pi-agent-core"),
	"@mariozechner/pi-tui": bundledPiTui,
	...piAiVirtualModules("@mariozechner/pi-ai"),
	"@mariozechner/pi-coding-agent": bundledPiCodingAgent,
});
