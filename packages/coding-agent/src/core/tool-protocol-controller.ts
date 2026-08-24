import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, StreamFn } from "@caupulican/pi-agent-core";
import {
	formatVariantEnvelope,
	generateTextToolProtocolPrimer,
	parseTextToolCalls,
	TEXT_TOOL_PROTOCOL_VARIANTS,
	type TextToolProtocolVariant,
} from "@caupulican/pi-ai/text-tool-protocol";
import { formatToolRepairStandingRule, type ToolRepairModeName } from "@caupulican/pi-ai/tool-repair-registry";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	TextContent,
	TextToolProtocolParseEvent,
	ThinkingContent,
	Tool,
	Usage,
} from "@caupulican/pi-ai/types";
import type { ToolArgumentValidationTelemetryEvent } from "@caupulican/pi-ai/validation";
import { Type } from "typebox";
import { getProcessWorkRun } from "../utils/work-directory.ts";
import type { ModelRegistry } from "./model-registry.ts";
import {
	MODEL_TOOL_PROTOCOL_VERSION,
	type ModelToolProtocolResolution,
	resolveModelToolProtocol,
} from "./model-tool-protocol.ts";
import type {
	ModelAdaptationRule,
	ModelAdaptationStore,
	ModelToolProbe,
	ModelToolProbeVerdict,
	NativeToolProbeGrade,
} from "./models/adaptation-store.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { ToolRecoveryLoggerStats } from "./tool-recovery-logger.ts";
import { formatToolRepairHealthReport } from "./tool-repair-health.ts";
import { resolveCurrentToolRepairSettings } from "./tool-repair-settings.ts";

const MODEL_ADAPTATION_REPAIR_THRESHOLD = 3;
const TEXT_TOOL_PROTOCOL_TRIALS_PER_VARIANT = 2;
const TEXT_TOOL_PROTOCOL_PARSE_FAILURE_THRESHOLD = 3;
const TEXT_TOOL_PROTOCOL_STEER_INTERVAL = 5;
const MAX_PARSE_FAILURE_EPISODES = 128;
const AUTO_TOOL_PROBE_FRESHNESS_MS = 15 * 60 * 1000;
const NO_CERTIFIED_TOOL_ROUTE_SYSTEM_GUIDANCE =
	"TOOL ROUTE UNAVAILABLE: No tools are available for this turn. Do not emit provider-native tool calls or text tool envelopes. Complete only with available text evidence; if execution is required, state the bounded blocker and request a working tool route or model.";
const TEXT_TOOL_PROTOCOL_ECHO_TOOL = {
	name: "echo",
	description: "Echo calibration data",
	parameters: Type.Object({ data: Type.String() }),
} satisfies Tool;
const TEXT_TOOL_PROTOCOL_TASK_EDIT_TOOL = {
	name: "edit",
	description: "Apply exact text replacements",
	parameters: Type.Object({
		path: Type.String(),
		edits: Type.Array(
			Type.Object({
				oldText: Type.String(),
				newText: Type.String(),
			}),
		),
	}),
} satisfies Tool;
const TEXT_TOOL_PROTOCOL_TASK_EDIT_ARGUMENTS = {
	path: "src/calibration fixture.ts",
	edits: [
		{
			oldText: 'const value = "before";\n',
			newText: 'const value = "after";\nconsole.log("escaped \\"quote\\"");\n',
		},
	],
};
const NATIVE_TOOL_PROBE_READ_TOOL = {
	name: "read",
	description: "Read file contents",
	parameters: Type.Object({ path: Type.String() }),
} satisfies Tool;

function toolProtocolProbeText(message: AssistantMessage): string {
	return message.content
		.filter(
			(block): block is TextContent | ThinkingContent =>
				block.type === "text" || (block.type === "thinking" && !block.redacted),
		)
		.map((block) => (block.type === "text" ? block.text : block.thinking))
		.join("\n")
		.trim();
}

export type ToolProbeVerdict = "native" | "text-protocol" | "none";

export interface ToolProbeResult {
	model: string;
	verdict: ToolProbeVerdict;
	variant?: TextToolProtocolVariant;
	nativeGrade?: NativeToolProbeGrade;
	diagnostic?: string;
}

export interface ToolProbeReport {
	results: ToolProbeResult[];
	table: string;
}

export interface ToolProtocolControllerDeps {
	agent: Agent;
	agentDir: string;
	settingsManager: SettingsManager;
	getModelRegistry(): ModelRegistry;
	adaptationStore: ModelAdaptationStore;
	isRawStreamSimple(fn: StreamFn): boolean;
	getRequiredRequestAuth(model: Model<Api>): Promise<RequestAuth>;
	addSpawnedUsage(usage: Usage, opts: { label?: string; reportId: string }): string | undefined;
	emitWarning(message: string): void;
	sendCorrectiveSteer(message: string): Promise<void>;
	findLastAssistantMessage(): AssistantMessage | undefined;
	buildToolFreeSystemPrompt(suffix: string): string;
	isDisposed(): boolean;
	probeForAuto(model: Model<Api>): Promise<ToolProbeResult>;
}

/** Owns model tool-protocol selection, probing, circuit breaking, and repair teaching. */
export class ToolProtocolController {
	private readonly repairModeSessionCounts = new Map<string, number>();
	/** Bounded, independent evidence episodes keyed by model + protocol failure class. */
	private readonly parseFailures = new Map<string, { repeats: number }>();
	private parseObservedThisTurn = false;
	private parsedTextProtocolThisTurn = false;
	private readonly parseFailureKeysThisTurn = new Set<string>();
	private correctiveSteerCount = 0;
	private probeUsageReportSeq = 0;
	private readonly autoProbedModels = new Set<string>();
	/** The exact active tool surface and prompt withheld for one no-route run; restored at completion. */
	private withheldRouteState: { tools: Agent["state"]["tools"]; systemPrompt: string } | undefined;
	private readonly deps: ToolProtocolControllerDeps;

	constructor(deps: ToolProtocolControllerDeps) {
		this.deps = deps;
	}

	applyRepairLayerSettings(): void {
		this.deps.agent.toolArgumentTeachEnabled = this.getRepairSettings().teach;
	}

	resetTurnState(): void {
		this.parseObservedThisTurn = false;
		this.parsedTextProtocolThisTurn = false;
		this.parseFailureKeysThisTurn.clear();
	}

	getAdaptationRulesForPrompt(): ModelAdaptationRule[] {
		if (!this.getRepairSettings().teach || this.withheldRouteState) return [];
		const modelKey = this.modelKey(this.deps.agent.state.model);
		return modelKey ? this.deps.adaptationStore.get(modelKey).rules : [];
	}

	resolveModelToolProtocol(model: Model<Api>): ModelToolProtocolResolution {
		return resolveModelToolProtocol({
			model,
			settingsOverride: this.getRepairSettings().textProtocol,
			adaptation: this.deps.adaptationStore.get(this.modelRef(model)),
		});
	}

	async ensureActiveModelProtocol(): Promise<void> {
		const model = this.deps.agent.state.model;
		const resolution = this.resolveModelToolProtocol(model);
		this.deps.agent.textToolCallProtocol = resolution.protocol;
		if (resolution.reasonCode === "probe_no_working_path") {
			this.withholdToolsForNoRouteRun();
		} else {
			this.restoreWithheldTools();
		}
		if (
			resolution.reasonCode !== "probe_calibration_missing" &&
			resolution.reasonCode !== "probe_calibration_failed" &&
			resolution.reasonCode !== "probe_calibration_invalid" &&
			resolution.reasonCode !== "probe_no_working_path"
		) {
			return;
		}
		const modelKey = this.modelRef(model);
		this.deps.emitWarning(
			resolution.reasonCode === "probe_no_working_path"
				? `No certified tool-call route remains for ${modelKey}; the failed text protocol stays disabled and native support is not proven. This non-routed turn has no automatic escalation. Run /toolprobe ${modelKey} after changing provider conditions or select a model with a working tool route.`
				: resolution.reasonCode === "probe_calibration_failed"
					? `Text tool protocol calibration for ${modelKey} previously failed (variants tried: ${(resolution.variantsTried ?? []).join(", ")}); falling back to native tool calls this turn. Run /toolprobe ${modelKey} to recalibrate.`
					: `Text tool protocol for ${modelKey} has no valid calibration on record; falling back to native tool calls this turn. Run /toolprobe ${modelKey} to calibrate.`,
		);
	}

	/** Restore the normal active-tool surface after a bounded no-route run settles. */
	restoreWithheldTools(): void {
		if (!this.withheldRouteState) return;
		this.deps.agent.state.tools = this.withheldRouteState.tools;
		this.deps.agent.state.systemPrompt = this.withheldRouteState.systemPrompt;
		this.withheldRouteState = undefined;
	}

	getToolProbeVerdict(model: Model<Api>): ModelToolProbeVerdict | undefined {
		return this.deps.adaptationStore.get(this.modelRef(model)).toolProbe?.status;
	}

	async probeToolCalling(target?: string): Promise<ToolProbeReport> {
		const models = await this.resolveToolProbeModels(target);
		if (models.length === 0) throw new Error("No available models to probe.");
		const results: ToolProbeResult[] = [];
		for (const model of models) results.push(await this.probeToolCallingForModel(model));
		return { results, table: this.formatToolProbeReport(results) };
	}

	async probeToolCallingForModel(model: Model<Api>): Promise<ToolProbeResult> {
		const modelKey = this.modelRef(model);
		const probedAt = new Date().toISOString();
		let nativeGrade: NativeToolProbeGrade = "absent";
		let diagnostic: string | undefined;
		try {
			nativeGrade = await this.gradeNativeToolCallingForModel(model, "pi-native-probe");
			if (nativeGrade === "task") {
				this.storeToolProbe(modelKey, {
					version: MODEL_TOOL_PROTOCOL_VERSION,
					status: "native",
					probedAt,
					nativeGrade,
				});
				return { model: modelKey, verdict: "native", nativeGrade };
			}
			diagnostic =
				nativeGrade === "echo-only"
					? "Native echo probe passed but task-scale read probe failed."
					: "Native task-scale read and echo probes did not produce provider-native tool calls.";
		} catch (error) {
			diagnostic = error instanceof Error ? error.message : String(error);
		}

		try {
			const calibrated = await this.calibrateTextToolProtocolForModel(model, modelKey, { persistFailure: false });
			if (calibrated.status === "calibrated") {
				this.storeToolProbe(modelKey, {
					version: MODEL_TOOL_PROTOCOL_VERSION,
					status: "text-protocol",
					probedAt: calibrated.calibratedAt,
					variant: calibrated.variant,
					nativeGrade,
					diagnostic,
				});
				return { model: modelKey, verdict: "text-protocol", variant: calibrated.variant, nativeGrade, diagnostic };
			}
			diagnostic = `${diagnostic ? `${diagnostic} ` : ""}Text protocol variants failed: ${calibrated.variantsTried.join(", ")}`;
		} catch (error) {
			diagnostic = error instanceof Error ? error.message : String(error);
		}

		this.storeToolProbe(modelKey, {
			version: MODEL_TOOL_PROTOCOL_VERSION,
			status: "none",
			probedAt,
			nativeGrade,
			diagnostic,
		});
		return { model: modelKey, verdict: "none", nativeGrade, diagnostic };
	}

	handleTextProtocolParse(event: TextToolProtocolParseEvent & { failureClass?: string }): void {
		this.parseObservedThisTurn = true;
		const modelKey = `${event.provider}/${event.model}`;
		if (event.status === "parsed") {
			this.parsedTextProtocolThisTurn = true;
			return;
		}
		this.maybeInjectCorrectiveSteer(event.variant);
		const signature = `${event.variant}:${event.failureClass ?? event.reason ?? "failed"}`;
		const failureKey = `${modelKey}\0${signature}`;
		this.parseFailureKeysThisTurn.add(failureKey);
		const repeats = (this.parseFailures.get(failureKey)?.repeats ?? 0) + 1;
		this.parseFailures.set(failureKey, { repeats });
		this.trimParseFailureEpisodes();
		if (repeats < TEXT_TOOL_PROTOCOL_PARSE_FAILURE_THRESHOLD) return;

		const profile = this.deps.adaptationStore.get(modelKey);
		if (profile.protocol?.version === MODEL_TOOL_PROTOCOL_VERSION && profile.protocol.status !== "failed") {
			this.deps.adaptationStore.removeProtocol(modelKey);
			this.deps.agent.textToolCallProtocol = undefined;
		}
		this.clearParseFailuresForModel(modelKey);
		const probedAt = new Date().toISOString();
		this.deps.adaptationStore.setToolProbe(
			modelKey,
			{
				version: MODEL_TOOL_PROTOCOL_VERSION,
				status: "none",
				probedAt,
				nativeGrade: profile.toolProbe?.nativeGrade,
				diagnostic: `Text protocol parsing failed ${TEXT_TOOL_PROTOCOL_PARSE_FAILURE_THRESHOLD}x within the current failure episode with signature "${signature}".`,
			},
			probedAt,
		);
		this.deps.emitWarning(
			`Text tool protocol for ${modelKey} stopped parsing after ${TEXT_TOOL_PROTOCOL_PARSE_FAILURE_THRESHOLD} failures within the current failure episode; demoted to the no-route fallback. Run /toolprobe ${modelKey} to recalibrate.`,
		);
	}

	handleValidationOutcome(event: ToolArgumentValidationTelemetryEvent): void {
		if (event.source !== "text-protocol" || event.outcome !== "bounced") return;
		const protocol = this.deps.agent.textToolCallProtocol;
		const variant = protocol === true ? "tool-tag" : protocol ? protocol.variant : undefined;
		if (!variant) return;
		const failureClass =
			[...new Set([...event.failureModes, ...(event.errorKeywords ?? [])])].sort().join("+") || "validation-failed";
		// Validation events arrive once per finalized call, after the parser reported the assistant
		// batch as parsed. Record each bounce immediately: a valid sibling must neither replace this
		// evidence nor cause outer-turn finalization to count it a second time.
		this.handleTextProtocolParse({
			provider: event.provider ?? this.deps.agent.state.model.provider,
			model: event.model ?? this.deps.agent.state.model.id,
			variant,
			status: "failed",
			callCount: 1,
			textLength: 0,
			reason: event.errorKeywords?.includes("unknown_tool") ? "unknown-tool" : "validation-failed",
			failureClass,
		});
	}

	recordParseOutcomeFromLastAssistant(): void {
		if (this.parseObservedThisTurn) {
			this.completeParseFailureEpisode();
			return;
		}
		const protocol = this.deps.agent.textToolCallProtocol;
		if (protocol === false || protocol === true || !protocol?.variant) return;
		const response = this.deps.findLastAssistantMessage();
		if (!response) return;
		const responseText = response.content
			.filter((content): content is TextContent => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		if (!responseText) return;

		const parsed = parseTextToolCalls(responseText, this.deps.agent.state.tools);
		const attempted = parsed.attempted || this.looksLikeTextProtocolAttempt(responseText);
		if (!attempted) return;
		this.handleTextProtocolParse({
			provider: this.deps.agent.state.model.provider,
			model: this.deps.agent.state.model.id,
			variant: protocol.variant,
			status: parsed.calls.length > 0 ? "parsed" : "failed",
			reason: parsed.failure,
			callCount: parsed.calls.length,
			textLength: responseText.length,
		});
		this.completeParseFailureEpisode();
	}

	tagAdaptationRuleTeaching(event: ToolArgumentValidationTelemetryEvent): ToolArgumentValidationTelemetryEvent {
		if (!this.getRepairSettings().teach || event.taught !== "none") return event;
		const modelKey =
			event.provider && event.model
				? `${event.provider}/${event.model}`
				: this.modelKey(this.deps.agent.state.model);
		if (!modelKey) return event;
		try {
			const rules = this.deps.adaptationStore.get(modelKey).rules;
			const modes = new Set([...event.failureModes, ...event.repairsApplied]);
			if (rules.some((rule) => modes.has(rule.mode as ToolRepairModeName))) return { ...event, taught: "rule" };
		} catch {
			// Best-effort telemetry tagging.
		}
		return event;
	}

	handleAdaptationTelemetry(event: ToolArgumentValidationTelemetryEvent): void {
		if (!this.getRepairSettings().teach || (event.outcome !== "repaired" && event.outcome !== "bounced")) return;
		const modelKey =
			event.provider && event.model
				? `${event.provider}/${event.model}`
				: this.modelKey(this.deps.agent.state.model);
		if (!modelKey) return;
		try {
			const modes =
				event.outcome === "repaired" ? event.repairsApplied : event.failureModes.filter((mode) => mode !== "other");
			for (const mode of [...new Set(modes)]) {
				const profile = this.deps.adaptationStore.get(modelKey);
				const stats = profile.teachStats[mode] ?? { taught: 0, recurrenceBefore: 0, recurrenceAfter: 0 };
				if (profile.rules.some((rule) => rule.mode === mode)) {
					this.deps.adaptationStore.markRuleFired(modelKey, mode);
					this.deps.adaptationStore.setTeachStats(modelKey, mode, {
						...stats,
						recurrenceAfter: stats.recurrenceAfter + 1,
					});
					continue;
				}

				const recurrenceBefore = stats.recurrenceBefore + 1;
				this.deps.adaptationStore.setTeachStats(modelKey, mode, { ...stats, recurrenceBefore });
				const sessionCount = this.repairSessionCount(modelKey, mode);
				if (
					sessionCount >= MODEL_ADAPTATION_REPAIR_THRESHOLD ||
					recurrenceBefore >= MODEL_ADAPTATION_REPAIR_THRESHOLD
				) {
					this.deps.adaptationStore.addRule(modelKey, { mode, text: formatToolRepairStandingRule(mode) });
					this.deps.adaptationStore.setTeachStats(modelKey, mode, {
						...stats,
						taught: stats.taught + 1,
						recurrenceBefore,
					});
				}
			}
		} catch {
			// Best-effort adaptation persistence.
		}
	}

	maybeAutoProbe(model: Model<Api>): void {
		const modelKey = this.modelRef(model);
		if (this.autoProbedModels.has(modelKey) || this.hasFreshToolProbeVerdict(modelKey)) return;
		this.autoProbedModels.add(modelKey);
		void this.deps
			.probeForAuto(model)
			.then((result) => {
				if (this.deps.isDisposed()) return;
				const detail =
					result.verdict === "text-protocol"
						? ` (variant ${result.variant}); it will use the text tool protocol starting next turn`
						: result.verdict === "none"
							? " — no working tool-call path was found; run /toolprobe for details"
							: "; native tool calls stay in use";
				this.deps.emitWarning(
					`Auto-probed ${modelKey} after repeated native tool-call validation failures: verdict "${result.verdict}"${detail}.`,
				);
			})
			.catch((error) => {
				if (this.deps.isDisposed()) return;
				this.deps.emitWarning(
					`Auto-probe for ${modelKey} (triggered by repeated tool-call validation failures) did not complete: ${error instanceof Error ? error.message : String(error)}.`,
				);
			});
	}

	formatRepairHealth(stats?: ToolRecoveryLoggerStats): string {
		return formatToolRepairHealthReport(this.deps.adaptationStore, new Date(), stats);
	}

	removeRepairRule(model: string, mode: string): boolean {
		return this.deps.adaptationStore.removeRule(model, mode);
	}

	resetProtocolCalibration(model: string): boolean {
		const removed = this.deps.adaptationStore.removeProtocol(model);
		this.clearParseFailuresForModel(model);
		return removed;
	}

	getRepairSettings() {
		return resolveCurrentToolRepairSettings(this.deps.settingsManager.settings);
	}

	private modelKey(model: Model<Api> | undefined): string | undefined {
		return model ? this.modelRef(model) : undefined;
	}

	private modelRef(model: Model<Api>): string {
		return `${model.provider}/${model.id}`;
	}

	private async streamForProbe(model: Model<Api>, context: Context, options: SimpleStreamOptions) {
		let requestOptions = options;
		if (this.deps.isRawStreamSimple(this.deps.agent.streamFn)) {
			const auth = await this.deps.getRequiredRequestAuth(model);
			requestOptions = {
				...options,
				apiKey: auth.apiKey,
				headers: auth.headers || options.headers ? { ...auth.headers, ...options.headers } : undefined,
			};
		}
		return this.deps.agent.streamFn(model, context, requestOptions);
	}

	private nextProbeUsageReportId(model: Model<Api>, kind: string): string {
		return `tool-probe:${this.modelRef(model)}:${kind}:${this.probeUsageReportSeq++}`;
	}

	private async resolveProbeStreamCountingUsage(
		stream: AssistantMessageEventStream,
		label: string,
		reportId: string,
	): Promise<AssistantMessage> {
		const message = await stream.result();
		const usage = message.usage;
		if (usage && (usage.cost.total > 0 || usage.totalTokens > 0)) {
			this.deps.addSpawnedUsage(usage, { label, reportId });
		}
		return message;
	}

	private textProtocolCalibrationContext(variant: TextToolProtocolVariant, token: string): Context {
		const primer = generateTextToolProtocolPrimer([TEXT_TOOL_PROTOCOL_ECHO_TOOL], { variant });
		const exactEnvelope = formatVariantEnvelope(variant, "echo", JSON.stringify({ data: token }));
		const instruction = `Text tool protocol calibration trial. Call echo, data exactly "${token}". Output only:\n${exactEnvelope}`;
		return {
			systemPrompt: `${primer}\n\n${instruction}`,
			messages: [{ role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() }],
		};
	}

	private textProtocolTaskCalibrationContext(variant: TextToolProtocolVariant): Context {
		const primer = generateTextToolProtocolPrimer([TEXT_TOOL_PROTOCOL_TASK_EDIT_TOOL], { variant });
		const argumentsJson = JSON.stringify(TEXT_TOOL_PROTOCOL_TASK_EDIT_ARGUMENTS);
		const exactEnvelope = formatVariantEnvelope(variant, "edit", argumentsJson);
		const instruction = `Text tool protocol calibration trial: task-scale nested edit. Call edit with this exact multiline escaped payload. Output only:\n${exactEnvelope}`;
		return {
			systemPrompt: `${primer}\n\n${instruction}`,
			messages: [{ role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() }],
		};
	}

	private messageHasToolCallWithStringArgument(
		message: AssistantMessage,
		toolName: string,
		argName: string,
		argValue: string,
	): boolean {
		return message.content.some((block) => {
			if (block.type !== "toolCall" || block.name !== toolName) return false;
			const args = block.arguments as unknown;
			return (
				typeof args === "object" &&
				args !== null &&
				!Array.isArray(args) &&
				(args as Record<string, unknown>)[argName] === argValue
			);
		});
	}

	private nativeToolProbeSystemPrompt(instruction: string): string {
		const base = (this.deps.agent.state.systemPrompt ?? "").trim();
		return base ? `${base}\n\n${instruction}` : instruction;
	}

	private async runNativeToolProbeTrial(
		model: Model<Api>,
		instruction: string,
		tool: Tool,
		maxTokens: number,
		reportKind: string,
		argName: string,
		argValue: string,
	): Promise<boolean> {
		const stream = await this.streamForProbe(
			model,
			{
				systemPrompt: this.nativeToolProbeSystemPrompt(instruction),
				messages: [{ role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() }],
				tools: [tool],
			},
			{ textToolCallProtocol: false, maxRetries: 0, temperature: 0, maxTokens },
		);
		const message = await this.resolveProbeStreamCountingUsage(
			stream,
			"tool-probe",
			this.nextProbeUsageReportId(model, reportKind),
		);
		return this.messageHasToolCallWithStringArgument(message, tool.name, argName, argValue);
	}

	private async runNativeReadTaskProbeTrial(model: Model<Api>, path: string): Promise<boolean> {
		const instruction = `Native tool-call capability probe: task-scale read. Provider-native call only: read once, path exactly "${path}".`;
		return this.runNativeToolProbeTrial(
			model,
			instruction,
			NATIVE_TOOL_PROBE_READ_TOOL,
			768,
			"read-task",
			"path",
			path,
		);
	}

	private async runNativeEchoToolProbeTrial(model: Model<Api>, token: string): Promise<boolean> {
		const instruction = `Native tool-call capability probe: echo-only. Provider-native call only: echo, data exactly "${token}".`;
		return this.runNativeToolProbeTrial(model, instruction, TEXT_TOOL_PROTOCOL_ECHO_TOOL, 256, "echo", "data", token);
	}

	private async gradeNativeToolCallingForModel(model: Model<Api>, token: string): Promise<NativeToolProbeGrade> {
		const path = join(
			getProcessWorkRun(this.deps.agentDir, "probes", "native-tools").path,
			`pi-native-probe-${process.pid}-${Date.now()}.txt`,
		);
		writeFileSync(path, token, "utf-8");
		try {
			if (await this.runNativeReadTaskProbeTrial(model, path)) return "task";
			if (await this.runNativeEchoToolProbeTrial(model, token)) return "echo-only";
			return "absent";
		} finally {
			rmSync(path, { force: true });
		}
	}

	private async runTextProtocolTrial(
		model: Model<Api>,
		variant: TextToolProtocolVariant,
		token: string,
	): Promise<boolean> {
		const stream = await this.streamForProbe(model, this.textProtocolCalibrationContext(variant, token), {
			textToolCallProtocol: false,
			maxRetries: 0,
			temperature: 0,
			maxTokens: 256,
		});
		const message = await this.resolveProbeStreamCountingUsage(
			stream,
			"text-protocol-calibration",
			this.nextProbeUsageReportId(model, `text-protocol:${variant}`),
		);
		const text = toolProtocolProbeText(message);
		if (!text) return false;
		const parsed = parseTextToolCalls(text, [TEXT_TOOL_PROTOCOL_ECHO_TOOL]);
		if (!parsed.calls.some((call) => call.name === "echo" && call.arguments.data === token)) return false;

		const taskStream = await this.streamForProbe(model, this.textProtocolTaskCalibrationContext(variant), {
			textToolCallProtocol: false,
			maxRetries: 0,
			temperature: 0,
			maxTokens: 768,
		});
		const taskMessage = await this.resolveProbeStreamCountingUsage(
			taskStream,
			"text-protocol-calibration",
			this.nextProbeUsageReportId(model, `text-protocol-task:${variant}`),
		);
		const taskText = toolProtocolProbeText(taskMessage);
		if (!taskText) return false;
		const taskParsed = parseTextToolCalls(taskText, [TEXT_TOOL_PROTOCOL_TASK_EDIT_TOOL]);
		return taskParsed.calls.some(
			(call) =>
				call.name === "edit" &&
				JSON.stringify(call.arguments) === JSON.stringify(TEXT_TOOL_PROTOCOL_TASK_EDIT_ARGUMENTS),
		);
	}

	private async calibrateTextToolProtocolForModel(
		model: Model<Api>,
		modelKey: string | undefined,
		options: { persistFailure: boolean },
	): Promise<
		| { status: "calibrated"; variant: TextToolProtocolVariant; calibratedAt: string }
		| { status: "failed"; attemptedAt: string; variantsTried: string[] }
	> {
		const variantsTried: string[] = [];
		for (const variant of TEXT_TOOL_PROTOCOL_VARIANTS) {
			variantsTried.push(variant);
			let passed = true;
			for (let trial = 0; trial < TEXT_TOOL_PROTOCOL_TRIALS_PER_VARIANT; trial++) {
				if (!(await this.runTextProtocolTrial(model, variant, `pi-calibration-${trial + 1}`))) {
					passed = false;
					break;
				}
			}
			if (passed) {
				const calibratedAt = new Date().toISOString();
				if (modelKey) {
					this.deps.adaptationStore.setProtocol(
						modelKey,
						{ version: MODEL_TOOL_PROTOCOL_VERSION, status: "calibrated", variant, calibratedAt },
						calibratedAt,
					);
				}
				return { status: "calibrated", variant, calibratedAt };
			}
		}

		const attemptedAt = new Date().toISOString();
		if (modelKey && options.persistFailure) {
			this.deps.adaptationStore.setProtocol(
				modelKey,
				{ version: MODEL_TOOL_PROTOCOL_VERSION, status: "failed", attemptedAt, variantsTried },
				attemptedAt,
			);
		}
		return { status: "failed", attemptedAt, variantsTried };
	}

	private formatToolProbeReport(results: readonly ToolProbeResult[]): string {
		const lines = [
			"Tool probe results:",
			"Model | Verdict | Variant | Native grade | Diagnostic",
			"--- | --- | --- | --- | ---",
		];
		for (const result of results) {
			lines.push(
				[
					result.model,
					result.verdict,
					result.variant ?? "-",
					result.nativeGrade ?? "-",
					result.diagnostic ? result.diagnostic.replace(/\s+/g, " ").slice(0, 160) : "-",
				].join(" | "),
			);
		}
		return lines.join("\n");
	}

	private storeToolProbe(modelKey: string, probe: ModelToolProbe): void {
		this.deps.adaptationStore.setToolProbe(modelKey, probe, probe.probedAt);
	}

	private async resolveToolProbeModels(target?: string): Promise<Model<Api>[]> {
		const trimmed = target?.trim();
		if (!trimmed) return this.deps.getModelRegistry().getAvailable();
		const [provider, ...modelParts] = trimmed.split("/");
		const modelId = modelParts.join("/");
		if (!provider || !modelId) throw new Error("Usage: /toolprobe [provider/model]");
		const exact = this.deps.getModelRegistry().find(provider, modelId);
		if (exact) return [exact];
		const current = this.deps.agent.state.model;
		if (current?.provider === provider && current.id === modelId) return [current];
		throw new Error(`Model not found: ${trimmed}`);
	}

	private maybeInjectCorrectiveSteer(variant: TextToolProtocolVariant): void {
		this.correctiveSteerCount++;
		if (this.correctiveSteerCount !== 1 && this.correctiveSteerCount % TEXT_TOOL_PROTOCOL_STEER_INTERVAL !== 0) {
			return;
		}
		const reminder = `MANDATORY, NON-NEGOTIABLE: to call a tool, emit exactly this envelope shape: ${formatVariantEnvelope(variant, "TOOL", '{"arg":"value"}')} Only this parses. Reasoning before envelope only.`;
		this.deps.sendCorrectiveSteer(reminder).catch(() => {
			// Best-effort steer.
		});
	}

	private withholdToolsForNoRouteRun(): void {
		if (this.withheldRouteState) return;
		this.withheldRouteState = {
			tools: this.deps.agent.state.tools,
			systemPrompt: this.deps.agent.state.systemPrompt,
		};
		this.deps.agent.state.tools = [];
		// prepareRun built the normal prompt before protocol resolution. Rebuild against the empty
		// surface so no tool primer, snippet, or guideline can advertise a call the provider cannot make.
		this.deps.agent.state.systemPrompt = this.deps.buildToolFreeSystemPrompt(NO_CERTIFIED_TOOL_ROUTE_SYSTEM_GUIDANCE);
	}

	private completeParseFailureEpisode(): void {
		// A fully parsed turn with no bounced calls is the explicit clean boundary for every
		// in-memory episode. A parsed sibling alongside any bounce deliberately does not reset it.
		if (!this.parsedTextProtocolThisTurn || this.parseFailureKeysThisTurn.size > 0) return;
		const modelKey = this.modelKey(this.deps.agent.state.model);
		if (modelKey) this.clearParseFailuresForModel(modelKey);
	}

	private clearParseFailuresForModel(modelKey: string): void {
		const prefix = `${modelKey}\0`;
		for (const key of this.parseFailures.keys()) {
			if (key.startsWith(prefix)) this.parseFailures.delete(key);
		}
	}

	private trimParseFailureEpisodes(): void {
		while (this.parseFailures.size > MAX_PARSE_FAILURE_EPISODES) {
			const oldest = this.parseFailures.keys().next().value;
			if (!oldest) return;
			this.parseFailures.delete(oldest);
		}
	}

	private looksLikeTextProtocolAttempt(text: string): boolean {
		return /<pi:call\b|<tool_call\b|```(?:tool|tool_call)[\s\S]*"name"\s*:/i.test(text);
	}

	private repairSessionCount(modelKey: string, mode: ToolRepairModeName): number {
		const key = `${modelKey}\0${mode}`;
		const count = (this.repairModeSessionCounts.get(key) ?? 0) + 1;
		this.repairModeSessionCounts.set(key, count);
		return count;
	}

	private hasFreshToolProbeVerdict(modelKey: string): boolean {
		const probedAt = this.deps.adaptationStore.get(modelKey).toolProbe?.probedAt;
		if (!probedAt) return false;
		const age = Date.now() - new Date(probedAt).getTime();
		return Number.isFinite(age) && age >= 0 && age < AUTO_TOOL_PROBE_FRESHNESS_MS;
	}
}
