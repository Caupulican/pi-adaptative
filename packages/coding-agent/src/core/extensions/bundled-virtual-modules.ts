import * as bundledPiAgentCore from "@caupulican/pi-agent-core";
import * as bundledPiAgentCoreAgent from "@caupulican/pi-agent-core/agent";
import * as bundledPiAgentCoreAgentLoop from "@caupulican/pi-agent-core/agent-loop";
import * as bundledPiAgentCoreCompaction from "@caupulican/pi-agent-core/compaction";
import * as bundledPiAgentCoreBranchSummarization from "@caupulican/pi-agent-core/compaction/branch-summarization";
import * as bundledPiAgentCoreCompactionCore from "@caupulican/pi-agent-core/compaction/compaction";
import * as bundledPiAgentCoreCompactionLoop from "@caupulican/pi-agent-core/compaction/loop";
import * as bundledPiAgentCoreTokenBudget from "@caupulican/pi-agent-core/compaction/token-budget";
import * as bundledPiAgentCoreMessageRetention from "@caupulican/pi-agent-core/message-retention";
import * as bundledPiAgentCoreMessages from "@caupulican/pi-agent-core/messages";
import * as bundledPiAgentCoreNode from "@caupulican/pi-agent-core/node";
import * as bundledPiAgentCorePaths from "@caupulican/pi-agent-core/paths";
import * as bundledPiAgentCoreProcessTree from "@caupulican/pi-agent-core/process-tree";
import * as bundledPiAgentCoreReliability from "@caupulican/pi-agent-core/reliability";
import * as bundledPiAgentCoreSession from "@caupulican/pi-agent-core/session";
import * as bundledPiAgentCoreShellOutput from "@caupulican/pi-agent-core/shell-output";
import * as bundledPiAgentCoreToolFailureMemory from "@caupulican/pi-agent-core/tool-failure-memory";
import * as bundledPiAgentCoreTruncate from "@caupulican/pi-agent-core/truncate";
import * as bundledPiAgentCoreTypes from "@caupulican/pi-agent-core/types";
import * as bundledPiAgentCoreUsage from "@caupulican/pi-agent-core/usage";
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
import {
	type PiAgentCoreExtensionSubpath,
	type PiAiExtensionSubpath,
	registerBundledExtensionVirtualModules,
} from "./virtual-modules.ts";

const piAgentCoreVirtualSubpaths: Record<PiAgentCoreExtensionSubpath, unknown> = {
	agent: bundledPiAgentCoreAgent,
	"agent-loop": bundledPiAgentCoreAgentLoop,
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
	reliability: bundledPiAgentCoreReliability,
	session: bundledPiAgentCoreSession,
	"shell-output": bundledPiAgentCoreShellOutput,
	"tool-failure-memory": bundledPiAgentCoreToolFailureMemory,
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

registerBundledExtensionVirtualModules({
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
