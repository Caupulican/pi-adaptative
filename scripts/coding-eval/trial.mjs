// One production SDK session per arm. Only projected evidence crosses back to the comparison driver.
import { clampThinkingLevel } from "@caupulican/pi-ai/models";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { retainedWorkerTaskSpend } from "../../packages/coding-agent/src/core/cost/worker-task-spend.ts";
import { isLocalExecutionModel } from "../../packages/coding-agent/src/core/models/model-endpoint.ts";
import { MODEL_POOL_POLICY_CUSTOM_TYPE } from "../../packages/coding-agent/src/core/model-router/owner-model-policy.ts";
import { ownerSessionStorageRoots } from "../../packages/coding-agent/src/kernel/session/session-bundle-paths.ts";
import { SessionManager } from "../../packages/coding-agent/src/kernel/session/session-manager.ts";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.ts";
import {
	attemptModelBinding,
	terminalAttemptStatus,
} from "../../packages/coding-agent/src/core/orchestration/task-runtime-state.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { loadSkillsFromDir } from "../../packages/coding-agent/src/core/skills.ts";
import { ACTIVE_SKILL_RECORD_KIND_PREFIX } from "../../packages/coding-agent/src/core/provider-request-context-controller.ts";
import { runGradedTask } from "./comparison.mjs";
import { cases, grade, skillSafetyCase } from "./corpus.mjs";
import { skillBodyDigest } from "../../packages/coding-agent/src/core/learning/skill-comparison.ts";

const send = (message) =>
	new Promise((resolve, reject) => process.send(message, (error) => (error ? reject(error) : resolve())));

async function settledTurn(session, manager, prompt) {
	const previous = manager.getLeafId();
	await session.prompt(prompt);
	let stable;
	for (;;) {
		await session.waitForForegroundIdle();
		const state = session.backgroundLanes.getTaskRuntimeSnapshot();
		const resources = session.getResourceSnapshot();
		const w = resources.workers;
		const usage = session.getDurableCumulativeUsage();
		const quiet =
			(usage.settled || usage.history === "unavailable") &&
			session.nativeActivity.isSettled() &&
			!Object.values(state?.attempts ?? {}).some((a) => !terminalAttemptStatus(a.status)) &&
			!Object.values(state?.notifications ?? {}).some((n) => n.status === "pending") &&
			!w?.ingressPromiseCount &&
			!w?.executionPromiseCount &&
			!w?.inFlightLedgerCount &&
			!w?.pendingPhysicalCleanups.length &&
			!w?.pendingTerminalHandoffCount &&
			!resources.terminalHandoffs.pendingDeliveries &&
			!resources.backgroundToolTasks.physicalExecutions;
		const cursor = `${manager.getLeafId()}/${state?.lastOrdinal ?? 0}`;
		if (quiet && stable === cursor) break;
		stable = quiet ? cursor : undefined;
		await delay(150);
	}
	const branch = manager.getBranch();
	const boundary = previous ? branch.findIndex((e) => e.id === previous) : -1;
	const last = branch
		.slice(boundary + 1)
		.findLast((e) => e.type === "message" && e.message.role === "assistant")?.message;
	if ((previous && boundary < 0) || last?.stopReason !== "stop")
		throw new Error(`Assistant ended with ${last?.stopReason ?? "no response"}`);
	return last.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function evidence(session, skillMode = false) {
	const costs = session.getCostSummary();
	const reading = session.getDurableCumulativeUsage();
	const counts = [reading.usage.input, reading.usage.output, reading.usage.cacheRead, reading.usage.cacheWrite];
	const tokens =
		reading.settled && counts.every((count) => Number.isSafeInteger(count) && count >= 0)
			? counts.reduce((sum, count) => sum + count, 0)
			: null;
	const metrics = session.getTaskAndModelMetrics();
	const state = session.backgroundLanes.getTaskRuntimeSnapshot();
	const spend = state && retainedWorkerTaskSpend(state);
	const attempts = Object.values(state?.attempts ?? {}).map((a) => ({
		id: a.attemptId,
		taskId: a.taskId,
		status: a.status,
		reason: a.reasonCode,
		model: attemptModelBinding(a),
	}));
	const outcomes = Object.values(state?.tasks ?? {}).map((t) => ({
		id: t.task.taskId,
		status: t.outcome?.status,
		nextAction: t.outcome?.nextAction?.kind,
	}));
	const workerModelUsd = metrics.models.filter((m) => m.role === "subagent").reduce((sum, m) => sum + m.costUsd, 0);
	const complete =
		!costs.accountingStatus &&
		!costs.apiEquivalentPartial &&
		!metrics.apiEquivalentPartial &&
		metrics.models.some((m) => m.role === "root" && m.calls > 0) &&
		session.getDurableCumulativeUsage().settled &&
		!spend?.missingOutcomes &&
		!spend?.missingCosts &&
		(!attempts.length ||
			(spend.attempts === attempts.length && workerModelUsd > 0 && workerModelUsd + 1e-9 >= spend.recordedUsd));
	return {
		...(skillMode ? { tokens } : {}),
		attempts,
		outcomes,
		models: metrics.models,
		workerSpend: spend,
		recordedApiEquivalentUsd: costs.currentCost,
		reportedUsd: costs.reportedCost ?? null,
		pricing: {
			estimate: costs.costEstimate,
			partial: metrics.apiEquivalentPartial || costs.apiEquivalentPartial === true,
			history: costs.accountingStatus,
		},
		costUsd: complete ? costs.currentCost : null,
	};
}

async function main() {
	const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
	const { agentDir, ownerDir, arm } = config;
	const skillMode = config.skillMode === true;
	let skillApplied = false;
	const cwd = process.cwd();
	const task = [...cases, skillSafetyCase].find((item) => item.id === config.caseId);
	const authStorage = AuthStorage.create(join(ownerDir, "auth.json"));
	const registry = ModelRegistry.create(authStorage, join(ownerDir, "models.json"));
	const modelAllowed = (candidate) => !config.hostedOnly || !isLocalExecutionModel(candidate);
	function lookup(ref) {
		const slash = ref.indexOf("/");
		const model = registry.find(ref.slice(0, slash), ref.slice(slash + 1));
		if (model && !modelAllowed(model)) throw new Error(`Local inference excluded for ${ref}`);
		if (!model || !registry.hasConfiguredAuth(model))
			throw new Error(`Model unavailable or missing credentials for ${ref}`);
		return model;
	}
	const model = lookup(config.model);
	const thinkingLevel = clampThinkingLevel(model, config.thinking ?? "off");
	const probedModel = arm === "auto" && config.probeWorker ? lookup(config.probeWorker) : undefined;
	const worker = probedModel ?? model;
	const workerPin = {
		provider: worker.provider,
		modelId: worker.id,
		thinkingLevel: clampThinkingLevel(worker, thinkingLevel),
	};
	const assignment = probedModel
		? {
				...task,
				prompt: `Start one worker for this task. Have it inspect the fixture and report back. Wait for its report before you submit your answer.\n\n${task.prompt}`,
			}
		: task;
	const pool = [...new Set([config.model, ...config.candidates])].map((ref) => ({ model: lookup(ref) }));
	const tools = ["read", "grep", "find", "ls", "write", "edit"];
	if (arm === "auto") tools.push("delegate", "assign", "worktree_sync");
	const settings = {
		worktreeSync: { gate: "on", gateCommand: `git diff --check ${config.seedCommit}` },
		systemOne: { enabled: config.systemOne },
		modelRouter: { enabled: !skillMode },
		orchestrator: { delegationGate: false },
		routines: { automaticIntake: false, away: { enabled: false, autostart: "off" } },
		workerDelegation: {
			enabled: arm === "auto",
			account: config.accountRouting ? "other" : "same",
			routeProviders: config.candidates,
			...(config.accountRouting ? {} : { modelPins: { default: workerPin } }),
		},
	};
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings), { mode: 0o600 });
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const evaluationSkills = skillMode
		? loadSkillsFromDir({ dir: join(agentDir, "skills"), source: "user" })
		: undefined;
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noContextFiles: true,
		noExtensions: true,
		noSkills: !skillMode,
		noThemes: true,
		noPromptTemplates: true,
		...(evaluationSkills ? { skillsOverride: () => evaluationSkills } : {}),
		installMissingPackages: false,
	});
	await resourceLoader.reload();
	const manager = SessionManager.create(cwd, ownerSessionStorageRoots(agentDir));
	if (config.hostedOnly) {
		manager.appendCustomEntry(MODEL_POOL_POLICY_CUSTOM_TYPE, {
			version: 1,
			changedAt: new Date().toISOString(),
			policy: { subscription: true, metered: true, local: false },
		});
	}
	const { session, sessionManager } = await createAgentSession({
		sessionManager: manager,
		cwd,
		agentDir,
		authStorage,
		modelRegistry: registry,
		model,
		thinkingLevel,
		pinnedModel: true,
		isExplicitModel: true,
		isExplicitThinking: true,
		tools,
		toolProfileFilter: { allow: tools },
		routerPool: { source: "sdk_models", models: pool },
		privatePathScope: { readRoots: [cwd], writeRoots: [cwd], confinedWrites: true, deniedPaths: [ownerDir] },
		settingsManager,
		resourceLoader,
	});
	if (skillMode) {
		try {
			if (evaluationSkills.skills.length !== 1 || evaluationSkills.skills[0].name !== config.skillName)
				throw new Error("The isolated evaluation skill was not discovered");
			const loaded = session.skillVault.load(config.skillName, "user", true);
			if (!loaded.ok || !loaded.pinned) throw new Error("The selected evaluation skill could not be pinned");
			const snapshot = session.agent.onProviderRequestSnapshot;
			session.agent.onProviderRequestSnapshot = async (context, signal) => {
				if (context.model.provider !== model.provider || context.model.id !== model.id)
					throw new Error("Skill comparison switched away from its selected hosted model");
				const sections = session.skillVault.previewSkillSections();
				const selected = sections.find((section) => section.name === config.skillName);
				const record = context.sourceContext.messages.findLast(
					(message) =>
						message.role === "custom" &&
						message.customType === `${ACTIVE_SKILL_RECORD_KIND_PREFIX}${config.skillName}`,
				);
				const visible = context.context.messages.some(
					(message) =>
						message.role === "user" &&
						(typeof message.content === "string"
							? [message.content]
							: message.content.filter((part) => part.type === "text").map((part) => part.text)
						).some(
							(text) => text.includes(`ACTIVE SKILL ${config.skillName}`) && text.includes(config.skillBody),
						),
				);
				if (
					sections.length !== 1 ||
					!selected?.section.includes(config.skillBody) ||
					record?.content !== selected.section ||
					!visible
				)
					throw new Error("Selected native skill context is absent from the accepted provider request");
				await snapshot?.(context, signal);
				skillApplied = true;
			};
		} catch (error) {
			await session.disposeAndWait();
			throw error;
		}
	}
	// A hard cutoff cannot ask a hung child for a final snapshot. Keep the latest observed usage and
	// attempt identities in the parent's checkpoint while the trial still owns its event loop.
	let previousSample;
	let sampling = false;
	const sampler = setInterval(async () => {
		if (sampling) return;
		sampling = true;
		try {
			const sample = evidence(session, skillMode);
			const key = JSON.stringify(sample);
			if (key !== previousSample) {
				await send({ ...sample, costUsd: null });
				previousSample = key;
			}
		} catch {
			// Final accounting is read synchronously at submission. An interrupted sample cannot establish a price.
		} finally {
			sampling = false;
		}
	}, 1000);
	let status;
	try {
		const modelPolicy = session.getModelPolicy();
		if (config.hostedOnly && modelPolicy.local)
			throw new Error("Local models are still enabled in the session policy");
		const activeTools = session.getActiveToolNames();
		const availableWorkerModels = config.accountRouting
			? registry
					.getAvailable()
					.filter(modelAllowed)
					.map((m) => `${m.provider}/${m.id}`)
			: [probedModel ? config.probeWorker : config.model];
		await send({
			...(probedModel ? { probeWorker: config.probeWorker, probePrompt: assignment.prompt } : {}),
			modelPolicy,
			activeTools,
			availableWorkerModels,
			settings,
			...(skillMode ? { skillDigest: skillBodyDigest(config.skillBody) } : { sessionFile: session.sessionFile }),
			foreground: { provider: session.model?.provider, model: session.model?.id, thinking: session.thinkingLevel },
		});
		if (activeTools.includes("delegate") !== (arm === "auto"))
			throw new Error("The effective delegation tool does not match the assigned arm");
		status = await runGradedTask({
			task: assignment,
			maxCorrections: skillMode && task.id === skillSafetyCase.id ? 0 : config.maxCorrections,
			turn: (prompt) => settledTurn(session, sessionManager, prompt),
			assess: skillMode
				? (answer) =>
						new Promise((resolve, reject) => {
							const request = randomUUID();
							const receive = (message) => {
								if (message?.kind !== "grade-result" || message.request !== request) return;
								process.off("message", receive);
								resolve(message.findings);
							};
							process.on("message", receive);
							send({ kind: "grade", request, answer }).catch((error) => {
								process.off("message", receive);
								reject(error);
							});
						})
				: (answer) => grade(task, cwd, answer),
			observe: (data) => send({ ...data, ...evidence(session, skillMode) }),
		});
		clearInterval(sampler);
		const measured = evidence(session, skillMode);
		if ((arm === "direct" || skillMode) && measured.attempts.length)
			throw new Error("Foreground-only session dispatched worker work");
		await send({ ...measured, ...(skillMode ? { skillApplied } : {}) });
	} catch (error) {
		await send({ ...evidence(session, skillMode), costUsd: null });
		throw error;
	} finally {
		clearInterval(sampler);
		await session.disposeAndWait();
	}
	await send({ status });
}

process.once("disconnect", () => process.exit(1));
main().then(
	() => process.exit(0),
	async (error) => {
		try {
			await send({ status: "error", diagnostic: String(error.message).slice(0, 300), costUsd: null });
		} finally {
			process.exit(1);
		}
	},
);
