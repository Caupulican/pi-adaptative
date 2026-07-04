/**
 * Auto-Learn / Native-Reflection controller.
 *
 * Extracted verbatim from interactive-mode.ts (god-file decomposition). Owns the disk-backed
 * Auto Learn run-state machine (state.json + lockfile), the background-learner spawn/prune
 * lifecycle, and the in-process native reflection pass. It takes narrow deps (a live session
 * accessor, a self-modification-source resolver that stays in the host, and a small UI callback
 * surface) rather than the whole InteractiveMode instance.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import { isAutoLearnSessionId } from "@caupulican/pi-agent-core/node";
import type { Model } from "@caupulican/pi-ai";
import type { SelectItem } from "@caupulican/pi-tui";
import { spawn } from "child_process";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { readAutoLearnSessionIdFromFile, reportCompletedAutoLearnUsageHelper } from "../../core/cost/session-usage.ts";
import { resolveCliModel } from "../../core/model-resolver.ts";
import { getPendingReloadBlockers } from "../../core/reload-blockers.ts";
import type { AutoLearnSettings, AutonomyMode } from "../../core/settings-manager.ts";
import { theme } from "./theme/theme.ts";

const AUTO_LEARN_DEFAULTS = {
	enabled: false,
	model: "active",
	thinkingLevel: "low",
	longSessionMessages: 32,
	longSessionContextPercent: 70,
	cooldownMinutes: 24 * 60,
	leaseMinutes: 90,
	maxConcurrentLearners: 1,
	applyHighConfidence: false,
	reflectionReview: true,
	reflectionMinToolCalls: 12,
	reflectionCooldownMinutes: 24 * 60,
	complexTaskToolCalls: 12,
} as const satisfies Required<AutoLearnSettings>;

const AUTONOMY_AUTO_LEARN_PRESETS = {
	off: { ...AUTO_LEARN_DEFAULTS, enabled: false, reflectionReview: false },
	safe: {
		...AUTO_LEARN_DEFAULTS,
		enabled: false,
		longSessionMessages: 64,
		longSessionContextPercent: 85,
		cooldownMinutes: 24 * 60,
		leaseMinutes: 60,
		maxConcurrentLearners: 1,
		applyHighConfidence: false,
		reflectionReview: false,
		reflectionMinToolCalls: 12,
		reflectionCooldownMinutes: 24 * 60,
		complexTaskToolCalls: 12,
	},
	balanced: {
		...AUTO_LEARN_DEFAULTS,
		enabled: false,
		longSessionMessages: 64,
		longSessionContextPercent: 85,
		cooldownMinutes: 24 * 60,
		leaseMinutes: 90,
		maxConcurrentLearners: 1,
		applyHighConfidence: false,
		reflectionReview: false,
		reflectionMinToolCalls: 12,
		reflectionCooldownMinutes: 24 * 60,
		complexTaskToolCalls: 12,
	},
	full: {
		...AUTO_LEARN_DEFAULTS,
		enabled: true,
		longSessionMessages: 64,
		longSessionContextPercent: 85,
		cooldownMinutes: 24 * 60,
		leaseMinutes: 90,
		maxConcurrentLearners: 1,
		applyHighConfidence: true,
		reflectionReview: true,
		reflectionMinToolCalls: 12,
		reflectionCooldownMinutes: 24 * 60,
		complexTaskToolCalls: 12,
	},
} as const satisfies Record<AutonomyMode, Required<AutoLearnSettings>>;

export const AUTONOMY_MODES: AutonomyMode[] = ["off", "safe", "balanced", "full"];
const AUTO_LEARN_RESERVATION_MS = 2 * 60 * 1000;
export const AUTO_LEARN_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface AutoLearnHistoryPruneResult {
	promptFiles: number;
	logFiles: number;
	sessionFiles: number;
	errors: number;
}

export interface AutoLearnHistoryPruneOptions {
	dataDir: string;
	now?: number;
	retentionMs?: number;
	activeRunIds?: Iterable<string | undefined>;
	activeSessionIds?: Iterable<string | undefined>;
}

type AutoLearnHistoryPruneCounter = Exclude<keyof AutoLearnHistoryPruneResult, "errors">;

function definedStringSet(values: Iterable<string | undefined> | undefined): Set<string> {
	const set = new Set<string>();
	if (!values) return set;
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) set.add(value);
	}
	return set;
}

function sanitizeAutoLearnPathPart(input: string | undefined, fallback: string): string {
	const cleaned = (input || fallback)
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return cleaned || fallback;
}

function isOldAutoLearnArtifact(filePath: string, now: number, retentionMs: number): boolean {
	const stats = fs.lstatSync(filePath);
	return stats.isFile() && now - stats.mtimeMs > retentionMs;
}

function removeOldAutoLearnArtifact(
	filePath: string,
	result: AutoLearnHistoryPruneResult,
	counter: AutoLearnHistoryPruneCounter,
): void {
	try {
		fs.rmSync(filePath, { force: true });
		result[counter]++;
	} catch {
		result.errors++;
	}
}

function isPathInside(target: string, root: string): boolean {
	const resolvedTarget = path.resolve(target);
	const resolvedRoot = path.resolve(root);
	return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function removeAutoLearnArtifactPath(filePath: string, root: string): boolean {
	if (!isPathInside(filePath, root)) return false;
	try {
		fs.rmSync(filePath, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

function getAutoLearnSessionIdFromFileName(fileName: string): string | undefined {
	return fileName.match(/_(auto-learn-[A-Za-z0-9._-]+)\.jsonl$/)?.[1];
}

function pruneAutoLearnSessionFiles(
	dir: string,
	activeSessionIds: ReadonlySet<string>,
	now: number,
	retentionMs: number,
	result: AutoLearnHistoryPruneResult,
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			pruneAutoLearnSessionFiles(filePath, activeSessionIds, now, retentionMs, result);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		let shouldPrune = false;
		try {
			shouldPrune = isOldAutoLearnArtifact(filePath, now, retentionMs);
		} catch {
			result.errors++;
			continue;
		}
		if (!shouldPrune) continue;
		const sessionId = readAutoLearnSessionIdFromFile(filePath) ?? getAutoLearnSessionIdFromFileName(entry.name);
		if (!sessionId || !isAutoLearnSessionId(sessionId) || activeSessionIds.has(sessionId)) continue;
		removeOldAutoLearnArtifact(filePath, result, "sessionFiles");
	}
}

function pruneAutoLearnRunArtifacts(
	dir: string,
	activeRunIds: ReadonlySet<string>,
	now: number,
	retentionMs: number,
	result: AutoLearnHistoryPruneResult,
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			pruneAutoLearnRunArtifacts(filePath, activeRunIds, now, retentionMs, result);
			continue;
		}
		if (!entry.isFile()) continue;
		const promptRunId = entry.name.endsWith(".prompt.md") ? entry.name.slice(0, -".prompt.md".length) : undefined;
		const logRunId = entry.name.endsWith(".log") ? entry.name.slice(0, -".log".length) : undefined;
		const runId = promptRunId ?? logRunId;
		if (!runId || activeRunIds.has(runId)) continue;
		let shouldPrune = false;
		try {
			shouldPrune = isOldAutoLearnArtifact(filePath, now, retentionMs);
		} catch {
			result.errors++;
			continue;
		}
		if (!shouldPrune) continue;
		removeOldAutoLearnArtifact(filePath, result, promptRunId ? "promptFiles" : "logFiles");
	}
}

export function pruneAutoLearnConversationHistory(options: AutoLearnHistoryPruneOptions): AutoLearnHistoryPruneResult {
	const result: AutoLearnHistoryPruneResult = { promptFiles: 0, logFiles: 0, sessionFiles: 0, errors: 0 };
	const dataDir = path.resolve(options.dataDir);
	const now = options.now ?? Date.now();
	const retentionMs = options.retentionMs ?? AUTO_LEARN_HISTORY_RETENTION_MS;
	const activeRunIds = definedStringSet(options.activeRunIds);
	const activeSessionIds = definedStringSet(options.activeSessionIds);
	if (retentionMs <= 0 || !fs.existsSync(dataDir)) return result;

	pruneAutoLearnRunArtifacts(dataDir, activeRunIds, now, retentionMs, result);
	pruneAutoLearnSessionFiles(dataDir, activeSessionIds, now, retentionMs, result);
	return result;
}

export interface AutoLearnRunRecord {
	tenant: string;
	pid?: number;
	model: string;
	reason: string;
	startedAt: number;
	expiresAt: number;
	cwd: string;
	logPath: string;
	sessionDir?: string;
	sessionId?: string;
	promptPath?: string;
	kind?: "auto" | "reflection";
	autonomyMode?: AutonomyMode;
	authority?: string;
	status?: "reserved" | "running";
}

export interface AutoLearnState {
	lastLaunchByTenant?: Record<string, number>;
	lastReflectionByTenant?: Record<string, number>;
	runs?: Record<string, AutoLearnRunRecord>;
}

interface AutoLearnStateLockResult<T> {
	result: T;
	next?: AutoLearnState;
}

interface AutoLearnDecision {
	shouldRun: boolean;
	reason: string;
	messageCount: number;
	contextPercent: number | null;
	cooldownRemainingMs: number;
	runningCount: number;
	bypassCooldown?: boolean;
}

interface AutoLearnReservation {
	runId: string;
	startedAt: number;
}

type AutoLearnReservationResult = { ok: true; reservation: AutoLearnReservation } | { ok: false; reason: string };

interface AutonomyReviewDecision extends AutoLearnDecision {
	toolCalls: number;
	digest?: string;
}

export interface AutoLearnSpawnTarget {
	command: string;
	argsPrefix: string[];
}

export interface AutoLearnSpawnArgsOptions {
	name: string;
	modelPattern: string;
	thinkingLevel?: string;
	sessionDir: string;
	sessionId: string;
	promptPath: string;
}

export function buildAutoLearnSpawnArgs(
	spawnTarget: AutoLearnSpawnTarget,
	options: AutoLearnSpawnArgsOptions,
): string[] {
	return [
		...spawnTarget.argsPrefix,
		"--print",
		"--name",
		options.name,
		"--model",
		options.modelPattern,
		...(options.thinkingLevel ? ["--thinking", options.thinkingLevel] : []),
		"--session-dir",
		options.sessionDir,
		"--session-id",
		options.sessionId,
		`@${options.promptPath}`,
	];
}

export function findAutoLearnSpawnNullByteInput(command: string, args: readonly string[]): string | undefined {
	if (command.includes("\0")) return "command";
	const argIndex = args.findIndex((arg) => arg.includes("\0"));
	return argIndex === -1 ? undefined : `args[${argIndex}]`;
}

export interface AutoLearnControllerUi {
	showStatus(message: string): void;
	readonly footerDataProvider: { setExtensionStatus(key: string, text: string | undefined): void };
	invalidateFooter(): void;
	requestRender(): void;
}

export interface AutoLearnControllerDeps {
	getSession(): AgentSession;
	resolveSelfModificationSource(settings: { sourcePath?: string; sourcePaths?: string[] }): string | undefined;
	ui: AutoLearnControllerUi;
}

export class AutoLearnController {
	// Native-reflection debounce: prevents back-to-back/overlapping background reflection passes (cost
	// guard). `_nativeReflectionInFlight` blocks a second pass while one runs; `_lastNativeReflectionAt`
	// enforces a minimum gap between passes. A debounce-skipped turn's text is BUFFERED in
	// `_pendingReflectionText` (not dropped) and folded into the next pass, so no corrective feedback is
	// lost — reflection sees only the current turn's messages, so dropping a skipped turn would lose its
	// learning entirely (bug #29).
	private _nativeReflectionInFlight = false;
	private _lastNativeReflectionAt = 0;
	private _pendingReflectionText: string[] = [];
	private static readonly NATIVE_REFLECTION_MIN_INTERVAL_MS = 45_000;
	private static readonly PENDING_REFLECTION_MAX_CHARS = 12_000;

	private readonly deps: AutoLearnControllerDeps;

	constructor(deps: AutoLearnControllerDeps) {
		this.deps = deps;
	}

	private get session(): AgentSession {
		return this.deps.getSession();
	}
	private get sessionManager() {
		return this.deps.getSession().sessionManager;
	}
	private get settingsManager() {
		return this.deps.getSession().settingsManager;
	}
	private get ui(): AutoLearnControllerUi {
		return this.deps.ui;
	}

	private getAutoLearnModelAuthPriority(model: Model<any>): number {
		if (this.session.model && model.provider === this.session.model.provider && model.id === this.session.model.id) {
			return 0;
		}

		const credential = this.session.modelRegistry.authStorage.get(model.provider);
		if (credential?.type === "oauth") return 1;
		if (credential?.type === "api_key") return 2;

		const authStatus = this.session.modelRegistry.getProviderAuthStatus(model.provider);
		switch (authStatus.source) {
			case "runtime":
				return 3;
			case "environment":
				return 4;
			case "models_json_key":
			case "models_json_command":
			case "fallback":
				return 5;
			default:
				return 6;
		}
	}

	private getAutoLearnModelAuthLabel(model: Model<any>): string {
		const credential = this.session.modelRegistry.authStorage.get(model.provider);
		if (credential?.type === "oauth") return "subscription";
		if (credential?.type === "api_key") return "API key";

		const authStatus = this.session.modelRegistry.getProviderAuthStatus(model.provider);
		switch (authStatus.source) {
			case "runtime":
				return authStatus.label ? `runtime ${authStatus.label}` : "runtime API key";
			case "environment":
				return authStatus.label ? `env ${authStatus.label}` : "environment API key";
			case "models_json_key":
				return "models.json API key";
			case "models_json_command":
				return "models.json command";
			case "fallback":
				return authStatus.label ?? "custom provider config";
			default:
				return "configured";
		}
	}

	getAutoLearnModelOptions(): SelectItem[] {
		this.session.modelRegistry.refresh();
		const availableModels = this.session.modelRegistry.getAvailable();
		const sortedModels = [...availableModels].sort((a, b) => {
			const priorityDelta = this.getAutoLearnModelAuthPriority(a) - this.getAutoLearnModelAuthPriority(b);
			if (priorityDelta !== 0) return priorityDelta;
			const providerDelta = this.session.modelRegistry
				.getProviderDisplayName(a.provider)
				.localeCompare(this.session.modelRegistry.getProviderDisplayName(b.provider));
			if (providerDelta !== 0) return providerDelta;
			return a.id.localeCompare(b.id);
		});

		return sortedModels.map((model) => {
			const providerName = this.session.modelRegistry.getProviderDisplayName(model.provider);
			const authLabel = this.getAutoLearnModelAuthLabel(model);
			const modelPattern = `${model.provider}/${model.id}`;
			const currentLabel =
				this.session.model && model.provider === this.session.model.provider && model.id === this.session.model.id
					? " · current"
					: "";
			const displayName = model.name && model.name !== model.id ? ` · ${model.name}` : "";
			return {
				value: modelPattern,
				label: modelPattern,
				description: `${providerName} · ${authLabel}${currentLabel}${displayName}`,
			};
		});
	}

	getAutoLearnDataDir(): string {
		return path.join(getAgentDir(), "auto-learn");
	}

	private getAutoLearnStatePath(): string {
		return path.join(this.getAutoLearnDataDir(), "state.json");
	}

	private ensureAutoLearnStateFile(): void {
		const dir = this.getAutoLearnDataDir();
		fs.mkdirSync(dir, { recursive: true });
		const statePath = this.getAutoLearnStatePath();
		if (!fs.existsSync(statePath)) {
			fs.writeFileSync(statePath, "{}\n", "utf-8");
		}
	}

	private readAutoLearnState(): AutoLearnState {
		try {
			const statePath = this.getAutoLearnStatePath();
			if (!fs.existsSync(statePath)) return {};
			return JSON.parse(fs.readFileSync(statePath, "utf-8")) as AutoLearnState;
		} catch {
			return {};
		}
	}

	private writeAutoLearnState(state: AutoLearnState): void {
		const dir = this.getAutoLearnDataDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(this.getAutoLearnStatePath(), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
	}

	private acquireAutoLearnStateLock(): () => void {
		this.ensureAutoLearnStateFile();
		const statePath = this.getAutoLearnStatePath();
		const maxAttempts = 20;
		const delayMs = 25;
		let lastError: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(statePath, { realpath: false, stale: 30000 });
			} catch (error: unknown) {
				const code =
					error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Synchronous callers need a synchronous lock retry loop.
				}
			}
		}
		throw lastError instanceof Error ? lastError : new Error("Failed to acquire Auto Learn state lock");
	}

	private withAutoLearnStateLock<T>(fn: (state: AutoLearnState) => AutoLearnStateLockResult<T>): T {
		let release: (() => void) | undefined;
		try {
			release = this.acquireAutoLearnStateLock();
			const { result, next } = fn(this.readAutoLearnState());
			if (next !== undefined) {
				this.writeAutoLearnState(next);
			}
			return result;
		} finally {
			release?.();
		}
	}

	private appendAutoLearnLog(logPath: string, message: string): void {
		try {
			fs.appendFileSync(logPath, `${message}\n`, "utf-8");
		} catch {
			// Logging must never turn a background learner startup failure into an interactive crash.
		}
	}

	private isAutoLearnPidAlive(pid: number | undefined): boolean {
		if (typeof pid !== "number" || pid <= 0) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			const code =
				error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
			return code === "EPERM";
		}
	}

	private pruneAutoLearnState(state: AutoLearnState, now = Date.now()): AutoLearnState {
		const runs = { ...(state.runs ?? {}) };
		for (const [id, run] of Object.entries(runs)) {
			if (run.expiresAt <= now) {
				delete runs[id];
				continue;
			}
			if (run.status === "reserved" && run.pid === undefined) {
				continue;
			}
			if (!this.isAutoLearnPidAlive(run.pid)) {
				delete runs[id];
			}
		}
		return { ...state, runs };
	}

	private pruneAutoLearnHistoryFromState(state: AutoLearnState, now = Date.now()): AutoLearnState {
		const prunedState = this.pruneAutoLearnState(state, now);
		pruneAutoLearnConversationHistory({
			dataDir: this.getAutoLearnDataDir(),
			now,
			activeRunIds: Object.keys(prunedState.runs ?? {}),
			activeSessionIds: Object.values(prunedState.runs ?? {}).map((run) => run.sessionId),
		});
		return prunedState;
	}

	getPrunedAutoLearnState(): AutoLearnState {
		return this.withAutoLearnStateLock((current) => {
			const state = this.pruneAutoLearnHistoryFromState(current);
			return { result: state, next: state };
		});
	}

	getAutoLearnPresetForAutonomyMode(mode: AutonomyMode, current: AutoLearnSettings = {}): Required<AutoLearnSettings> {
		const preset = AUTONOMY_AUTO_LEARN_PRESETS[mode] ?? AUTONOMY_AUTO_LEARN_PRESETS.off;
		return { ...preset, model: current.model?.trim() || preset.model };
	}

	getEffectiveAutoLearnSettings(): Required<AutoLearnSettings> {
		const settings = this.settingsManager.getAutoLearnSettings();
		const preset = this.getAutoLearnPresetForAutonomyMode(this.settingsManager.getAutonomySettings().mode, settings);
		return {
			enabled: settings.enabled ?? preset.enabled,
			model: settings.model?.trim() || preset.model,
			longSessionMessages: settings.longSessionMessages ?? preset.longSessionMessages,
			longSessionContextPercent: settings.longSessionContextPercent ?? preset.longSessionContextPercent,
			cooldownMinutes: settings.cooldownMinutes ?? preset.cooldownMinutes,
			leaseMinutes: settings.leaseMinutes ?? preset.leaseMinutes,
			maxConcurrentLearners: settings.maxConcurrentLearners ?? preset.maxConcurrentLearners,
			applyHighConfidence: settings.applyHighConfidence ?? preset.applyHighConfidence,
			reflectionReview: settings.reflectionReview ?? preset.reflectionReview,
			reflectionMinToolCalls: settings.reflectionMinToolCalls ?? preset.reflectionMinToolCalls,
			reflectionCooldownMinutes: settings.reflectionCooldownMinutes ?? preset.reflectionCooldownMinutes,
			complexTaskToolCalls: settings.complexTaskToolCalls ?? preset.complexTaskToolCalls,
			thinkingLevel: settings.thinkingLevel ?? preset.thinkingLevel,
		};
	}

	getCurrentAutoLearnSettings(): Required<AutoLearnSettings> {
		return this.getEffectiveAutoLearnSettings();
	}

	getAutoLearnTenantKey(): string {
		return `${this.sessionManager.getCwd()}::${this.session.sessionId}`;
	}

	private getAutoLearnTenantId(): string {
		const cwdHash = crypto.createHash("sha256").update(this.sessionManager.getCwd()).digest("hex").slice(0, 8);
		const sessionPart = sanitizeAutoLearnPathPart(this.session.sessionId, "session");
		return `${sessionPart}-${cwdHash}`;
	}

	getAutoLearnTenantDataDir(): string {
		return path.join(this.getAutoLearnDataDir(), "tenants", this.getAutoLearnTenantId());
	}

	private getAutoLearnMessageCount(): number {
		return this.sessionManager.getBranch().filter((entry) => entry.type === "message").length;
	}

	private buildAutoLearnDecisionFromState(
		state: AutoLearnState,
		settings: Required<AutoLearnSettings>,
		force = false,
	): AutoLearnDecision {
		const now = Date.now();
		const tenant = this.getAutoLearnTenantKey();
		const runningCount = Object.values(state.runs ?? {}).filter((run) => run.tenant === tenant).length;
		const lastLaunch = state.lastLaunchByTenant?.[tenant] ?? 0;
		const cooldownMs = settings.cooldownMinutes * 60 * 1000;
		const cooldownRemainingMs = Math.max(0, lastLaunch + cooldownMs - now);
		const messageCount = this.getAutoLearnMessageCount();
		const contextPercent = this.session.getContextUsage()?.percent ?? null;

		if (!settings.enabled && !force) {
			return {
				shouldRun: false,
				reason: "disabled",
				messageCount,
				contextPercent,
				cooldownRemainingMs,
				runningCount,
			};
		}
		if (runningCount >= settings.maxConcurrentLearners) {
			return {
				shouldRun: false,
				reason: `max tenant learners running (${runningCount}/${settings.maxConcurrentLearners})`,
				messageCount,
				contextPercent,
				cooldownRemainingMs,
				runningCount,
			};
		}
		if (!force && cooldownRemainingMs > 0) {
			return {
				shouldRun: false,
				reason: "cooldown",
				messageCount,
				contextPercent,
				cooldownRemainingMs,
				runningCount,
			};
		}
		if (force) {
			return { shouldRun: true, reason: "manual", messageCount, contextPercent, cooldownRemainingMs, runningCount };
		}
		if (messageCount >= settings.longSessionMessages) {
			return {
				shouldRun: true,
				reason: `message trigger (${messageCount}/${settings.longSessionMessages})`,
				messageCount,
				contextPercent,
				cooldownRemainingMs,
				runningCount,
			};
		}
		if (contextPercent !== null && contextPercent >= settings.longSessionContextPercent) {
			return {
				shouldRun: true,
				reason: `context trigger (${contextPercent.toFixed(1)}%/${settings.longSessionContextPercent}%)`,
				messageCount,
				contextPercent,
				cooldownRemainingMs,
				runningCount,
			};
		}
		return {
			shouldRun: false,
			reason: "thresholds not met",
			messageCount,
			contextPercent,
			cooldownRemainingMs,
			runningCount,
		};
	}

	private resolveAutoLearnModelPattern(settings: Required<AutoLearnSettings>): string | undefined {
		if (settings.model === "active") {
			return this.session.model ? `${this.session.model.provider}/${this.session.model.id}` : undefined;
		}
		return settings.model;
	}

	private getAutoLearnSpawnTarget(): AutoLearnSpawnTarget | undefined {
		const overridePath = process.env.PI_AUTO_LEARN_CLI_PATH?.trim();
		if (overridePath) {
			return { command: overridePath, argsPrefix: [] };
		}

		const execBase = path.basename(process.execPath).toLowerCase();
		const isScriptRuntime =
			execBase === "node" || execBase === "node.exe" || execBase === "bun" || execBase === "bun.exe";
		if (!isScriptRuntime) {
			return { command: process.execPath, argsPrefix: [] };
		}

		const cliPath = process.argv[1];
		if (!cliPath || cliPath.startsWith("-")) {
			return undefined;
		}
		return { command: process.execPath, argsPrefix: [cliPath] };
	}

	validateAutoLearnModelValue(value: string | undefined): string | undefined {
		const modelValue = value?.trim();
		if (!modelValue || modelValue === "active") return undefined;
		const available = this.session.modelRegistry.getAvailable();
		if (modelValue.includes("/")) {
			const [provider, modelId] = modelValue.split("/", 2);
			if (available.some((model) => model.provider === provider && model.id === modelId)) return undefined;
			return `Auto Learn model "${modelValue}" is not in configured subscription/API models; saved as manual/unverified.`;
		}
		if (available.some((model) => model.id === modelValue)) return undefined;
		return `Auto Learn model "${modelValue}" is not in configured subscription/API models; saved as manual/unverified.`;
	}

	private evaluateAutoLearn(force = false): AutoLearnDecision {
		const settings = this.getEffectiveAutoLearnSettings();
		return this.withAutoLearnStateLock((current) => {
			const state = this.pruneAutoLearnHistoryFromState(current);
			return { result: this.buildAutoLearnDecisionFromState(state, settings, force), next: state };
		});
	}

	private buildAutonomyAuthorityPrompt(): string {
		const autonomy = this.settingsManager.getAutonomySettings();
		const selfModification = this.settingsManager.getSelfModificationSettings();
		if (autonomy.mode !== "full") {
			return [
				"Authority mode: proposal-gated.",
				"- You may autonomously query memory and run bounded learning tools.",
				"- Durable memory writes require the configured high-confidence policy; skills, extensions, source, settings, publishing, tagging, and releases remain proposals unless the foreground user explicitly asks.",
			].join("\n");
		}

		const selfModificationSource = selfModification.enabled
			? this.deps.resolveSelfModificationSource(selfModification)
			: undefined;
		const sourceAuthority =
			selfModification.enabled && selfModificationSource
				? `- Pi source: standing authority to edit the authorized selfModification source (${selfModificationSource}) for self-evolution improvements; inspect git status first, preserve unrelated user changes, run focused validation, and leave a clear rollback/test summary.`
				: "- Pi source: no standing source-edit authority until selfModification.enabled and selfModification.sourcePaths are set.";
		return [
			"Authority mode: FULL AUTONOMOUS standing grant.",
			"- Memory: may apply high-confidence durable Automata memory/corrections after duplicate and corroboration checks.",
			"- Skills: may create or patch user/project-owned procedural skills and support files; prefer updating existing umbrella skills; do not delete skills without making a recoverable archive/backup.",
			"- User/project extensions and tools: may create or patch small scoped extensions/tools under Pi user/project roots when they address repeated workflow/tooling gaps; validate and keep changes auditable.",
			"- Settings: may auto-tune autonomy/autoLearn settings to reduce bottlenecks; do not modify credentials, provider auth, package sources, or unrelated user preferences.",
			sourceAuthority,
			"- Hard stops without explicit foreground approval: publish, npm release, git push, tag creation, credential changes, destructive user-data deletion, network-exposed services, or authority expansion beyond this policy.",
			"- Audit: final output must list changed paths/settings, commands/tests run, evidence, residual risks, and rollback guidance. If no safe validation is possible, leave the change as a proposal instead of applying it.",
		].join("\n");
	}

	private buildAutoLearnPrompt(
		reason: string,
		settings: Required<AutoLearnSettings>,
		options: { kind?: "auto" | "reflection"; turnDigest?: string } = {},
	): string {
		const authorityBlock = this.buildAutonomyAuthorityPrompt();
		const reflectionBlock =
			options.kind === "reflection" && options.turnDigest
				? `\n\nLatest completed turn digest (bounded; use only as current-session evidence, not as longitudinal proof):\n<turn_digest>\n${options.turnDigest}\n</turn_digest>`
				: "";
		const objective =
			options.kind === "reflection"
				? "review the latest completed turn for durable memory, skill, validation, tooling, and code-baked self-improvement cues, then run one bounded continuous-learning pass if the learning tools are available"
				: "run one bounded continuous-learning pass for this Pi tenant";
		return `You are Pi Auto Learn running as a background learner.\n\nObjective: ${objective}.\nTrigger: ${reason}.\n\n${authorityBlock}\n\nRequired workflow:\n1. Query existing durable memory/rules first when tools allow it. Memory confrontation is mandatory before accepting, merging, upgrading, or rejecting learning candidates.\n2. Run the available Auto Learn tooling, preferably learning_run_auto, with applyHighConfidence=${settings.applyHighConfidence}. Process candidate validation in vectorized chunks/batches; avoid scalar per-candidate memory queries except for final selected writes.\n3. Apply the learning validation tree to each candidate chunk: (a) Why is this good for the user? (b) Is it unique, or similar to existing memory/skills/agents so it should merge or upgrade existing knowledge? (c) Will this make Pi a better agent? Candidates that cannot answer all three are noise.\n4. Hermes-style learning cycle: after a complex task (${settings.complexTaskToolCalls}+ tool calls), user correction, repeated steering pattern, non-trivial fix/workaround/debugging path, loaded-skill defect, trigger gap, tool gap, or harness workflow defect, actively create or update durable learning artifacts. Memory stores compact facts/preferences/state; skills/prompts/agents/extensions/source store procedural behavior. When a lesson changes how Pi should act on a future class of task, memory alone is not completion.\n5. Skill update preference order: (1) patch the currently loaded or consulted skill that governed the task; (2) patch an existing class-level umbrella skill/agent/prompt; (3) add a support file under references/, templates/, or scripts/ and add a SKILL.md pointer; (4) create a new class-level umbrella skill only when no existing artifact fits. Never create one-off PR/error/codename/session skills.\n6. Behavioral self-improvement is code-baked by default: prefer the lowest durable executable layer that fixes the behavior — patch an existing skill/prompt/agent/extension/tool, tune an approved setting, or edit the authorized Pi source when source authority is available. Use Automata only for concise facts/evidence pointers that support the baked change.\n7. Do not harden transient or environment-dependent failures into durable behavior: missing binaries, fresh-install package gaps, credentials not configured, path mismatches, one-off task narratives, or negative tool-broken claims should become setup/troubleshooting fixes only when the fix itself is reusable.\n8. Treat the latest-turn digest as current-session evidence only; do not auto-commit one-off cues unless deterministic tooling and memory confrontation corroborate them.\n9. In mode=full, apply safe memory/skill/user-extension/authorized-source improvements under the standing grant above; otherwise keep them proposal-gated.\n10. Never cross hard-stop boundaries from the authority policy.\n11. If the learning tools are unavailable, report BLOCKED with the missing tool names and do not improvise.\n12. Finish with PASS, BLOCKED, or FAIL and concise evidence, including chunk counts, merge/upgrade/code-bake decisions, changed paths/settings, validation, and cleanup/purge status.${reflectionBlock}`;
	}

	private reserveAutoLearnRun(params: {
		settings: Required<AutoLearnSettings>;
		force: boolean;
		cooldownKind?: "auto" | "reflection";
		bypassReflectionCooldown?: boolean;
		runId: string;
		modelPattern: string;
		reason: string;
		logPath: string;
		sessionDir: string;
		sessionId: string;
		promptPath: string;
		kind: "auto" | "reflection";
	}): AutoLearnReservationResult {
		return this.withAutoLearnStateLock<AutoLearnReservationResult>((current) => {
			const now = Date.now();
			const state = this.pruneAutoLearnHistoryFromState(current, now);
			const tenant = this.getAutoLearnTenantKey();

			if (params.cooldownKind === "reflection" && !params.bypassReflectionCooldown) {
				const lastReflection = state.lastReflectionByTenant?.[tenant] ?? 0;
				const cooldownMs = params.settings.reflectionCooldownMinutes * 60 * 1000;
				if (Math.max(0, lastReflection + cooldownMs - now) > 0) {
					return { result: { ok: false, reason: "reflection cooldown" }, next: state };
				}
			}

			const decision = this.buildAutoLearnDecisionFromState(state, params.settings, params.force);
			if (!decision.shouldRun) {
				return { result: { ok: false, reason: decision.reason }, next: state };
			}

			const run: AutoLearnRunRecord = {
				tenant,
				model: params.modelPattern,
				reason: params.reason,
				startedAt: now,
				expiresAt: now + AUTO_LEARN_RESERVATION_MS,
				cwd: this.sessionManager.getCwd(),
				logPath: params.logPath,
				sessionDir: params.sessionDir,
				sessionId: params.sessionId,
				promptPath: params.promptPath,
				kind: params.kind,
				autonomyMode: this.settingsManager.getAutonomySettings().mode,
				authority:
					this.settingsManager.getAutonomySettings().mode === "full"
						? "standing-full-autonomous"
						: "proposal-gated",
				status: "reserved",
			};
			const next: AutoLearnState = {
				...state,
				runs: { ...(state.runs ?? {}), [params.runId]: run },
			};
			if (params.cooldownKind === "reflection") {
				next.lastReflectionByTenant = { ...(state.lastReflectionByTenant ?? {}), [tenant]: now };
			} else {
				next.lastLaunchByTenant = { ...(state.lastLaunchByTenant ?? {}), [tenant]: now };
			}
			return { result: { ok: true, reservation: { runId: params.runId, startedAt: now } }, next };
		});
	}

	private releaseAutoLearnReservation(reservation: AutoLearnReservation, cooldownKind?: "auto" | "reflection"): void {
		this.withAutoLearnStateLock((current) => {
			const state = this.pruneAutoLearnHistoryFromState(current);
			const tenant = this.getAutoLearnTenantKey();
			const runs = { ...(state.runs ?? {}) };
			delete runs[reservation.runId];
			const next: AutoLearnState = { ...state, runs };
			if (cooldownKind === "reflection" && next.lastReflectionByTenant?.[tenant] === reservation.startedAt) {
				next.lastReflectionByTenant = { ...next.lastReflectionByTenant };
				delete next.lastReflectionByTenant[tenant];
			} else if (cooldownKind !== "reflection" && next.lastLaunchByTenant?.[tenant] === reservation.startedAt) {
				next.lastLaunchByTenant = { ...next.lastLaunchByTenant };
				delete next.lastLaunchByTenant[tenant];
			}
			return { result: undefined, next };
		});
	}

	private reportCompletedAutoLearnUsage(runId: string, sessionDir: string, sessionId: string, logPath: string): void {
		try {
			reportCompletedAutoLearnUsageHelper({
				runId,
				sessionDir,
				sessionId,
				logPath,
				parentSession: this.session,
				appendLog: (p, msg) => this.appendAutoLearnLog(p, msg),
			});
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			this.appendAutoLearnLog(logPath, `Auto Learn usage report failed: ${message}`);
		}
	}

	private cleanupCompletedAutoLearnRun(
		runId: string,
		options: {
			artifactPaths: string[];
			sessionDir: string;
			sessionId: string;
			logPath: string;
		},
	): void {
		this.reportCompletedAutoLearnUsage(runId, options.sessionDir, options.sessionId, options.logPath);
		const dataDir = this.getAutoLearnDataDir();
		for (const filePath of options.artifactPaths) removeAutoLearnArtifactPath(filePath, dataDir);
		this.withAutoLearnStateLock((current) => {
			const state = this.pruneAutoLearnState(current);
			const runs = { ...(state.runs ?? {}) };
			delete runs[runId];
			return { result: undefined, next: { ...state, runs } };
		});
		this.updateAutoLearnFooter();
	}

	private markAutoLearnReservationRunning(
		reservation: AutoLearnReservation,
		pid: number,
		settings: Required<AutoLearnSettings>,
	): void {
		this.withAutoLearnStateLock((current) => {
			const now = Date.now();
			const state = this.pruneAutoLearnHistoryFromState(current, now);
			const run = state.runs?.[reservation.runId];
			if (!run) {
				return { result: undefined, next: state };
			}
			return {
				result: undefined,
				next: {
					...state,
					runs: {
						...(state.runs ?? {}),
						[reservation.runId]: {
							...run,
							pid,
							expiresAt: now + settings.leaseMinutes * 60 * 1000,
							status: "running",
						},
					},
				},
			};
		});
	}

	launchAutoLearn(
		reason: string,
		force = false,
		options: {
			cooldownKind?: "auto" | "reflection";
			promptKind?: "auto" | "reflection";
			turnDigest?: string;
			bypassReflectionCooldown?: boolean;
		} = {},
	): string {
		const settings = this.getEffectiveAutoLearnSettings();
		const modelPattern = this.resolveAutoLearnModelPattern(settings);
		if (!modelPattern) {
			return "Auto Learn not started: no active model is available for model=active.";
		}
		const spawnTarget = this.getAutoLearnSpawnTarget();
		if (!spawnTarget) {
			return "Auto Learn not started: could not resolve current pi CLI path.";
		}

		const dir = this.getAutoLearnTenantDataDir();
		fs.mkdirSync(dir, { recursive: true });
		const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
		const logPath = path.join(dir, `${runId}.log`);
		const promptPath = path.join(dir, `${runId}.prompt.md`);
		const kind = options.promptKind ?? "auto";
		const sessionDir = path.join(dir, "sessions", runId);
		const sessionId = `auto-learn-${kind}-${this.getAutoLearnTenantId()}-${runId}`;
		fs.mkdirSync(sessionDir, { recursive: true });
		const prompt = this.buildAutoLearnPrompt(reason, settings, {
			kind,
			turnDigest: options.turnDigest,
		});
		const args = buildAutoLearnSpawnArgs(spawnTarget, {
			name: `Auto Learn ${runId}`,
			modelPattern,
			thinkingLevel: settings.thinkingLevel ?? "low",
			sessionDir,
			sessionId,
			promptPath,
		});
		const invalidSpawnInput = findAutoLearnSpawnNullByteInput(spawnTarget.command, args);
		if (invalidSpawnInput) {
			const message = `Auto Learn not started: ${invalidSpawnInput} contains a null byte.`;
			this.appendAutoLearnLog(logPath, message);
			this.updateAutoLearnFooter();
			return `${message} Log: ${logPath}`;
		}

		const reservationResult = this.reserveAutoLearnRun({
			settings,
			force,
			cooldownKind: options.cooldownKind,
			bypassReflectionCooldown: options.bypassReflectionCooldown,
			runId,
			modelPattern,
			reason,
			logPath,
			sessionDir,
			sessionId,
			promptPath,
			kind,
		});
		if (!reservationResult.ok) {
			return `Auto Learn not started: ${reservationResult.reason}`;
		}
		const { reservation } = reservationResult;

		try {
			fs.writeFileSync(promptPath, prompt, "utf-8");
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			this.releaseAutoLearnReservation(reservation, options.cooldownKind);
			this.appendAutoLearnLog(logPath, `Auto Learn failed to write prompt file: ${message}`);
			this.updateAutoLearnFooter();
			return `Auto Learn not started: failed to write prompt file (${message}). Log: ${logPath}`;
		}

		let child: ReturnType<typeof spawn> | undefined;
		let outFd: number | undefined;
		try {
			outFd = fs.openSync(logPath, "a");
			const sourceSessionFile = this.sessionManager.getSessionFile();
			child = spawn(spawnTarget.command, args, {
				cwd: this.sessionManager.getCwd(),
				detached: true,
				stdio: ["ignore", outFd, outFd],
				env: {
					...process.env,
					PI_AUTO_LEARN_CHILD: "1",
					...(sourceSessionFile ? { PI_AUTO_LEARN_SOURCE_SESSION_FILE: sourceSessionFile } : {}),
				},
			});
			child.once("error", (error) => {
				const message = error instanceof Error ? error.message : String(error);
				this.appendAutoLearnLog(logPath, `Auto Learn failed to start: ${message}`);
			});
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			this.releaseAutoLearnReservation(reservation, options.cooldownKind);
			this.appendAutoLearnLog(logPath, `Auto Learn failed to start: ${message}`);
			this.updateAutoLearnFooter();
			return `Auto Learn not started: failed to spawn background learner (${message}). Log: ${logPath}`;
		} finally {
			if (outFd !== undefined) {
				try {
					fs.closeSync(outFd);
				} catch {
					// The child has already been spawned or startup has already failed; ignore close errors here.
				}
			}
		}
		if (!child || typeof child.pid !== "number" || child.pid <= 0) {
			this.releaseAutoLearnReservation(reservation, options.cooldownKind);
			this.updateAutoLearnFooter();
			return `Auto Learn not started: failed to spawn background learner. Log: ${logPath}`;
		}
		const childPid = child.pid;
		child.once("exit", (code) => {
			if (code === 0) {
				this.cleanupCompletedAutoLearnRun(reservation.runId, {
					artifactPaths: [promptPath, logPath, sessionDir],
					sessionDir,
					sessionId,
					logPath,
				});
			}
		});
		child.unref();
		this.markAutoLearnReservationRunning(reservation, childPid, settings);

		this.updateAutoLearnFooter();
		return `Auto Learn started. Log: ${logPath}`;
	}

	private sanitizeAutoLearnDigestText(text: string): string {
		return text
			.replace(
				/-----BEGIN [A-Z ]*(?:PRIVATE|OPENSSH|RSA|DSA|EC) KEY-----[\s\S]*?-----END [A-Z ]*(?:PRIVATE|OPENSSH|RSA|DSA|EC) KEY-----/g,
				"[redacted-private-key]",
			)
			.replace(/\b(?:sk|pk)-(?:proj-)?[A-Za-z0-9_-]{12,}/g, "[redacted-api-key]")
			.replace(/\bsk-ant-[A-Za-z0-9_-]{12,}/g, "[redacted-api-key]")
			.replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, "[redacted-github-token]")
			.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted-aws-access-key]")
			.replace(/(?:Bearer\s+)[A-Za-z0-9._-]{16,}/gi, "Bearer [redacted]")
			.replace(/([?&](?:key|token|api_key|access_token|secret|password)=)[^&\s]+/gi, "$1[redacted]")
			.replace(
				/((?:access|refresh|token|apiKey|api_key|password|secret|authorization|auth)\s*[:=]\s*)[^\s,'"}]{8,}/gi,
				"$1[redacted]",
			);
	}

	private capAutoLearnDigestText(text: string, maxChars: number): string {
		const compact = this.sanitizeAutoLearnDigestText(text).replace(/\s+/g, " ").trim();
		if (compact.length <= maxChars) return compact;
		return `${compact.slice(0, Math.max(0, maxChars - 20)).trimEnd()} …[truncated]`;
	}

	private getAgentMessagePlainText(message: AgentMessage): string {
		const raw = message as unknown as Record<string, unknown>;
		const content = raw.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		const parts: string[] = [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const item = block as Record<string, unknown>;
			if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
			if (item.type === "toolCall" && typeof item.name === "string") parts.push(`[tool call: ${item.name}]`);
		}
		return parts.join("\n");
	}

	private countAgentToolCalls(messages: AgentMessage[]): number {
		let toolCalls = 0;
		let toolResults = 0;
		for (const message of messages) {
			const raw = message as unknown as Record<string, unknown>;
			const role = String(raw.role ?? "");
			if (role === "toolResult" || role === "bashExecution") toolResults++;
			const content = raw.content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (block && typeof block === "object" && (block as Record<string, unknown>).type === "toolCall") {
					toolCalls++;
				}
			}
		}
		return Math.max(toolCalls, toolResults);
	}

	private buildAutonomyReviewDigest(messages: AgentMessage[]): string {
		const lines: string[] = [];
		for (const message of messages.slice(-18)) {
			const raw = message as unknown as Record<string, unknown>;
			const role = String(raw.role ?? "message");
			const label = role === "toolResult" && typeof raw.toolName === "string" ? `toolResult:${raw.toolName}` : role;
			const text = this.capAutoLearnDigestText(this.getAgentMessagePlainText(message), 700);
			if (text) lines.push(`${label}: ${text}`);
		}
		const digest = lines.join("\n---\n");
		return this.capAutoLearnDigestText(digest || "[No textual turn digest available.]", 6000);
	}

	private evaluateAutonomyReview(messages: AgentMessage[]): AutonomyReviewDecision {
		const settings = this.getEffectiveAutoLearnSettings();
		const state = this.withAutoLearnStateLock((current) => {
			const pruned = this.pruneAutoLearnHistoryFromState(current);
			return { result: pruned, next: pruned };
		});
		const now = Date.now();
		const tenant = this.getAutoLearnTenantKey();
		const runningCount = Object.values(state.runs ?? {}).filter((run) => run.tenant === tenant).length;
		const lastReflection = state.lastReflectionByTenant?.[tenant] ?? 0;
		const cooldownMs = settings.reflectionCooldownMinutes * 60 * 1000;
		const cooldownRemainingMs = Math.max(0, lastReflection + cooldownMs - now);
		const messageCount = this.getAutoLearnMessageCount();
		const contextPercent = this.session.getContextUsage()?.percent ?? null;
		const toolCalls = this.countAgentToolCalls(messages);
		const userText = messages
			.filter((message) => String((message as unknown as Record<string, unknown>).role ?? "") === "user")
			.map((message) => this.getAgentMessagePlainText(message))
			.join("\n");
		const correctionSignal =
			/\b(next time|for future|from now on|remember this|don't|do not|avoid|instead|you should|should have|you forgot|you missed|not what i asked|wrong again)\b/i.test(
				userText,
			);
		const behavioralSelfImprovementSignal =
			/\b(harness|pi|agent|autonomy|autonomous|self[- ]?improv(?:e|ement|ing)?|steer(?:ing)?|trigger(?:s)?|skill(?:s)?|code[- ]?bak(?:e|ed)|bake(?:d)? into code|not (?:automata|memory)|reference agent|hermes)\b/i.test(
				userText,
			) &&
			/\b(improve|automatic(?:ally)?|autonomous|trigger|fire|skill|steer|self[- ]?improv(?:e|ement|ing)?|code[- ]?bak(?:e|ed)|bake(?:d)?|too much|less)\b/i.test(
				userText,
			);
		const complexTaskThreshold = Math.max(1, settings.complexTaskToolCalls ?? 12);
		const complexTaskSignal = toolCalls >= complexTaskThreshold;
		const bypassCooldown = correctionSignal || behavioralSelfImprovementSignal || complexTaskSignal;
		const base = { messageCount, contextPercent, cooldownRemainingMs, runningCount, toolCalls };
		if (!settings.enabled) return { ...base, shouldRun: false, reason: "disabled" };
		if (!settings.reflectionReview) return { ...base, shouldRun: false, reason: "reflection disabled" };
		if (runningCount >= settings.maxConcurrentLearners) {
			return {
				...base,
				shouldRun: false,
				reason: `max tenant learners running (${runningCount}/${settings.maxConcurrentLearners})`,
			};
		}
		if (cooldownRemainingMs > 0 && !bypassCooldown) {
			return { ...base, shouldRun: false, reason: "reflection cooldown" };
		}
		if (behavioralSelfImprovementSignal) {
			return {
				...base,
				shouldRun: true,
				reason: "reflection behavioral self-improvement signal",
				digest: this.buildAutonomyReviewDigest(messages),
				bypassCooldown: true,
			};
		}
		if (correctionSignal) {
			return {
				...base,
				shouldRun: true,
				reason: "reflection correction signal",
				digest: this.buildAutonomyReviewDigest(messages),
				bypassCooldown: true,
			};
		}
		if (complexTaskSignal) {
			return {
				...base,
				shouldRun: true,
				reason: `reflection complex task learning signal (${toolCalls}/${complexTaskThreshold} tool calls)`,
				digest: this.buildAutonomyReviewDigest(messages),
				bypassCooldown: true,
			};
		}
		// Full autonomy expands allowed action scope for triggered reviews; it does not make every turn a review trigger.
		if (toolCalls >= settings.reflectionMinToolCalls) {
			return {
				...base,
				shouldRun: true,
				reason: `reflection tool trigger (${toolCalls}/${settings.reflectionMinToolCalls})`,
				digest: this.buildAutonomyReviewDigest(messages),
			};
		}
		return { ...base, shouldRun: false, reason: "reflection thresholds not met" };
	}

	/**
	 * Native reflection (R2) is the in-process replacement for the buggy `continuous-learning`
	 * subprocess. It runs when auto-learn is enabled and is not killed via `PI_NATIVE_REFLECTION=0`.
	 */
	isNativeReflectionEnabled(): boolean {
		if (process.env.PI_NATIVE_REFLECTION === "0") return false;
		if (process.env.PI_AUTO_LEARN_CHILD === "1") return false;
		return this.getEffectiveAutoLearnSettings().enabled;
	}

	/** Heuristic: does the user's turn text read like a correction/steer worth learning from? */
	private hasCorrectionSignal(userText: string): boolean {
		return /\b(next time|for future|from now on|remember this|don't|do not|avoid|instead|you should|should have|you forgot|you missed|not what i asked|wrong again)\b/i.test(
			userText,
		);
	}

	/**
	 * End-of-loop native reflection: demand-gate the just-finished turn (zero-I/O) and, when
	 * warranted, run the in-process {@link AgentSession.runReflectionPass} as a fire-and-forget
	 * background microtask. No subprocess, no blocking of the UI.
	 */
	/**
	 * Resolve the model + thinking level the native reflection pass should use, from auto-learn
	 * settings (`model`, `thinkingLevel`). The configured model is honored only when its provider is
	 * AVAILABLE (api key / logged in) — otherwise we fall back to the session model (undefined). This
	 * lets the user pick a balanced/cheaper reflection model without risking an unusable one.
	 */
	private _resolveReflectionModel(settings: Required<AutoLearnSettings>) {
		let model: Model<any> | undefined;
		if (settings.model && settings.model !== "active") {
			const resolved = resolveCliModel({ cliModel: settings.model, modelRegistry: this.session.modelRegistry });
			if (resolved.model && this.session.modelRegistry.hasConfiguredAuth(resolved.model)) {
				model = resolved.model;
			}
		}
		const thinkingLevel = settings.thinkingLevel ?? "low";
		return { model, thinkingLevel };
	}

	/** Buffer a debounce-skipped turn's text so its learning is folded into the next pass (bug #29). */
	private _bufferPendingReflection(text: string): void {
		const t = text.trim();
		if (!t) return;
		this._pendingReflectionText.push(t);
		// Bound the buffer so a long skipped streak can't grow unbounded; drop oldest past the budget
		// (the most recent corrections matter most).
		let total = this._pendingReflectionText.reduce((n, s) => n + s.length + 1, 0);
		while (this._pendingReflectionText.length > 1 && total > AutoLearnController.PENDING_REFLECTION_MAX_CHARS) {
			total -= (this._pendingReflectionText.shift()?.length ?? 0) + 1;
		}
	}

	private _drainPendingReflection(): string {
		if (this._pendingReflectionText.length === 0) return "";
		const joined = this._pendingReflectionText.join("\n");
		this._pendingReflectionText = [];
		return joined;
	}

	maybeRunNativeReflection(messages: AgentMessage[]): void {
		if (!this.isNativeReflectionEnabled()) return;

		const settings = this.getEffectiveAutoLearnSettings();
		const toolCallCount = this.countAgentToolCalls(messages);
		const contextPercent = this.session.getContextUsage()?.percent ?? 0;
		const contextHeadroomPct = Math.max(0, 100 - contextPercent);

		const userText = messages
			.filter((m) => String((m as unknown as Record<string, unknown>).role ?? "") === "user")
			.map((m) => this.getAgentMessagePlainText(m))
			.join("\n");
		const hadCorrection = this.hasCorrectionSignal(userText);

		// A correction is worth learning from even on a short turn; otherwise require a complex turn.
		const trigger: "complex" | "corrective" | "none" = hadCorrection
			? "corrective"
			: toolCallCount >= Math.max(1, settings.complexTaskToolCalls ?? 12)
				? "complex"
				: "none";
		if (trigger === "none") return;

		const recentTurnText = messages
			.map((m) =>
				`${String((m as unknown as Record<string, unknown>).role ?? "")}: ${this.getAgentMessagePlainText(m)}`.trim(),
			)
			.filter(Boolean)
			.join("\n");

		// Debounce (cost guard): never run two background reflection passes at once, and never start one
		// within the min interval of the last — a multi-turn correction session would otherwise spawn
		// overlapping passes that re-reason the same task. A skipped turn is NOT dropped: its text is
		// buffered and folded into the next pass, so the corrective feedback is still learned (bug #29).
		const now = Date.now();
		const debounced =
			this._nativeReflectionInFlight ||
			now - this._lastNativeReflectionAt < AutoLearnController.NATIVE_REFLECTION_MIN_INTERVAL_MS;
		if (debounced) {
			this._bufferPendingReflection(recentTurnText);
			return;
		}

		// Fold any buffered (previously debounced) turns into this pass so nothing learned is lost.
		const pending = this._drainPendingReflection();
		const reflectionText = pending ? `${pending}\n${recentTurnText}` : recentTurnText;

		// Stable per-turn id so a duplicate scheduling/retry can't double-count the reflection cost.
		// Messages carry no `id` on the real path (only timestamps), so derive the key from the last
		// message's timestamp + the turn size — present on every real turn, stable across a retry of the
		// same agent_end, and distinct between turns. Falls back to a content signature if needed.
		const last = messages[messages.length - 1] as unknown as { id?: string; timestamp?: number | string };
		const turnKey = last?.id ?? (last?.timestamp != null ? `${last.timestamp}:${recentTurnText.length}` : undefined);
		const reportId = turnKey ? `reflection:${turnKey}` : undefined;

		// User-configurable reflection model + thinking (auto-learn settings), restricted to AVAILABLE
		// (authed) models — falls back to the session model when unset or unavailable.
		const { model, thinkingLevel } = this._resolveReflectionModel(settings);

		this._nativeReflectionInFlight = true;
		this._lastNativeReflectionAt = now;
		void this.session
			.runReflectionPass({
				signals: { trigger, toolCallCount, hadCorrection, contextHeadroomPct, usefulLately: 0 },
				recentTurnText: reflectionText,
				reportId,
				model,
				thinkingLevel,
			})
			.catch(() => {
				// best-effort background learning; never disrupt the session
			})
			.finally(() => {
				this._nativeReflectionInFlight = false;
			});
	}

	maybeStartAutoLearn(): boolean {
		if (process.env.PI_AUTO_LEARN_CHILD === "1") return false;
		const decision = this.evaluateAutoLearn(false);
		if (!decision.shouldRun) {
			this.updateAutoLearnFooter();
			return false;
		}
		const message = this.launchAutoLearn(decision.reason, false);
		if (!message.startsWith("Auto Learn started")) this.ui.showStatus(message);
		return message.startsWith("Auto Learn started");
	}

	maybeStartAutonomyReview(messages: AgentMessage[]): boolean {
		if (process.env.PI_AUTO_LEARN_CHILD === "1") return false;
		const decision = this.evaluateAutonomyReview(messages);
		if (!decision.shouldRun) return false;
		const message = this.launchAutoLearn(decision.reason, true, {
			cooldownKind: "reflection",
			promptKind: "reflection",
			turnDigest: decision.digest,
			bypassReflectionCooldown: decision.bypassCooldown,
		});
		if (!message.startsWith("Auto Learn started")) this.ui.showStatus(message);
		return message.startsWith("Auto Learn started");
	}

	updateAutoLearnFooter(): void {
		const settings = this.getEffectiveAutoLearnSettings();
		if (!settings.enabled) {
			this.ui.footerDataProvider.setExtensionStatus("auto-learn", undefined);
			return;
		}
		const tenant = this.getAutoLearnTenantKey();
		const state = this.getPrunedAutoLearnState();
		const hasActiveRun = Object.values(state.runs ?? {}).some(
			(run) => run.tenant === tenant && this.isAutoLearnPidAlive(run.pid),
		);
		this.ui.footerDataProvider.setExtensionStatus(
			"auto-learn",
			hasActiveRun ? theme.fg("warning", "(learning)") : undefined,
		);
		this.ui.invalidateFooter();
		this.ui.requestRender();
	}

	formatAutoLearnStatus(): string {
		const settings = this.getEffectiveAutoLearnSettings();
		const decision = this.evaluateAutoLearn(false);
		const state = this.getPrunedAutoLearnState();
		const tenant = this.getAutoLearnTenantKey();
		const runs = Object.entries(state.runs ?? {}).filter(([, run]) => run.tenant === tenant);
		const otherTenantRuns = Object.values(state.runs ?? {}).filter((run) => run.tenant !== tenant).length;
		const contextText = decision.contextPercent === null ? "unknown" : `${decision.contextPercent.toFixed(1)}%`;
		const cooldownText =
			decision.cooldownRemainingMs > 0 ? `${Math.ceil(decision.cooldownRemainingMs / 60000)}m remaining` : "ready";
		const runLines = runs.length
			? runs
					.map(([id, run]) => {
						const session = [
							run.sessionId ? `session=${run.sessionId}` : "",
							run.sessionDir ? `sessionDir=${run.sessionDir}` : "",
						]
							.filter(Boolean)
							.join(", ");
						const sessionText = session ? `, ${session}` : "";
						return `- ${id}: ${run.model}, kind=${run.kind ?? "auto"}, status=${run.status ?? "running"}, authority=${run.authority ?? "unknown"}, pid=${run.pid ?? "?"}${sessionText}, log=${run.logPath}`;
					})
					.join("\n")
			: "- none";
		const reloadBlockers = getPendingReloadBlockers({
			ownPid: process.pid,
			ownSessionId: this.sessionManager.getSessionId(),
			ownSessionFile: this.sessionManager.getSessionFile(),
		});
		const reloadBlockerLines = reloadBlockers.pending
			? reloadBlockers.descriptions.map((description) => `- ${description}`).join("\n")
			: "- none";
		const reflectionLast = state.lastReflectionByTenant?.[this.getAutoLearnTenantKey()] ?? 0;
		const reflectionCooldownRemainingMs = Math.max(
			0,
			reflectionLast + settings.reflectionCooldownMinutes * 60 * 1000 - Date.now(),
		);
		const reflectionCooldownText =
			reflectionCooldownRemainingMs > 0 ? `${Math.ceil(reflectionCooldownRemainingMs / 60000)}m remaining` : "ready";
		return `Auto Learn status\nEnabled: ${settings.enabled}\nModel: ${settings.model}\nNext decision: ${decision.shouldRun ? "ready" : decision.reason}\nMessages: ${decision.messageCount}/${settings.longSessionMessages}\nContext: ${contextText}/${settings.longSessionContextPercent}%\nCooldown: ${cooldownText}\nReflection review: ${settings.reflectionReview ? "enabled" : "disabled"} (tool trigger ${settings.reflectionMinToolCalls}, cooldown ${reflectionCooldownText})\nHistory retention: 7 days for internal Auto Learn prompts/logs/sessions\nRunning tenant leases: ${runs.length}/${settings.maxConcurrentLearners}\nOther tenant leases: ${otherTenantRuns}\nTenant artifact dir: ${this.getAutoLearnTenantDataDir()}\nPi auto-reload blockers: ${reloadBlockers.pending ? reloadBlockers.reason : "none"}\n${reloadBlockerLines}\nRuns:\n${runLines}`;
	}
}
