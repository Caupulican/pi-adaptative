import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantMessageEventStream, createEmptyUsage } from "@caupulican/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import type { PromptOptions } from "../src/core/agent-session-contracts.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getOwnerEvidenceSnapshots } from "../src/core/learning/owner-evidence-ledger.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { entryTurnOrigin } from "../src/core/turn-origin.ts";

const answer = "SYNTHETIC_ORIGIN_OK";
const request = "Reply with the synthetic origin witness.";
const origin = {
	channel: "synthetic-peer",
	sender: "Guest",
	verified: true,
	text: request,
};

afterEach(() => vi.unstubAllGlobals());

it.each([
	{ label: "ordinary owner", options: undefined, owner: true },
	{ label: "peer with omitted source", options: { origin }, owner: false },
	{
		label: "peer with interactive source",
		options: { origin, source: "interactive" },
		owner: false,
	},
	{
		label: "peer with RPC source",
		options: { origin, source: "rpc" },
		owner: false,
	},
] satisfies {
	label: string;
	options: PromptOptions | undefined;
	owner: boolean;
}[])("keeps public SDK origin authority consistent for $label", async ({ options, owner }) => {
	const root = mkdtempSync(join(tmpdir(), "pi-peer-origin-"));
	const agentDir = join(root, "agent");
	const network = vi.fn(async () => {
		throw new Error("The offline origin fixture has no external transport");
	});
	vi.stubGlobal("fetch", network);
	const authStorage = AuthStorage.inMemory({
		openai: { type: "api_key", key: "synthetic" },
	});
	const modelRegistry = ModelRegistry.create(authStorage, join(root, "models.json"));
	const model = modelRegistry.find("openai", "gpt-4.1");
	if (!model) throw new Error("Missing fixture model");
	const settingsManager = SettingsManager.inMemory({
		memorySystem: "okf",
		contextPolicy: {
			memory: {
				enabled: false,
				includeInPrompt: false,
			},
		},
		autoLearn: { enabled: false },
		proactivity: { enabled: false },
		systemOne: { enabled: false },
		modelCapability: { mode: "off" },
		modelRouter: { enabled: false },
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager,
		installMissingPackages: false,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session, sessionManager } = await createAgentSession({
		cwd: root,
		agentDir,
		settingsManager,
		resourceLoader,
		authStorage,
		modelRegistry,
		model,
		pinnedModel: true,
		isExplicitModel: true,
		systemOneEnabled: false,
		noTools: "all",
		tools: [],
	});
	let replies = 0;
	session.agent.streamFn = (usedModel) => {
		replies++;
		const message = {
			role: "assistant" as const,
			api: usedModel.api,
			provider: usedModel.provider,
			model: usedModel.id,
			content: [{ type: "text" as const, text: answer }],
			stopReason: "stop" as const,
			usage: createEmptyUsage(),
			timestamp: Date.now(),
		};
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
		});
		return stream;
	};
	try {
		await session.initializeMemory();
		await session.prompt(request, options);
		await session.waitForForegroundIdle();
		expect(session.getLastAssistantText()).toBe(answer);
		expect(replies).toBe(1);
		const branch = sessionManager.getBranch();
		expect(getOwnerEvidenceSnapshots(branch)).toHaveLength(owner ? 1 : 0);
		const incoming = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
		if (incoming?.type !== "message") throw new Error("Missing incoming fixture entry");
		expect(incoming.ownerInputId?.startsWith(owner ? "prompt:" : "extension:")).toBe(true);
		if (!owner)
			expect(entryTurnOrigin(incoming)).toMatchObject({
				channel: origin.channel,
				thirdParty: true,
			});
		expect(
			branch.filter((entry) => entry.type === "custom_message" && entry.customType === "ordinary-work-continuation"),
		).toHaveLength(0);
		const databasePath = join(agentDir, "state", "decision-ledger.sqlite");
		if (existsSync(databasePath)) {
			const ledger = new DecisionLedgerStore({ databasePath });
			try {
				const rows = ledger.ordinaryWork.forSession(sessionManager.getSessionId());
				expect(rows).toHaveLength(owner ? 1 : 0);
				if (owner) expect(rows[0]?.continuationCount).toBe(0);
			} finally {
				ledger.close();
			}
		} else expect(owner).toBe(false);
	} finally {
		await session.abort("offline origin fixture closes", {
			ordinaryWork: "preserve",
		});
		await session.disposeAndWait();
		rmSync(root, { recursive: true, force: true });
	}
});
