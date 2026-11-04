/**
 * The delegation gate: the root orchestrates, workers carry out the work.
 *
 * The root keeps every tool, because it must author agent definitions and the instruction files its workers
 * read and follow. What it may not do is carry out the owner's task itself: a single session that can execute
 * does so and is interrupted by every new message (the Router/Worker split exists to prevent that). So each
 * root call is checked here, after the edge, and a call that is task work is refused with the way to delegate it.
 *
 * Deterministic by contract and path where code can decide: a typed write is orchestration when it lands in an
 * orchestration directory (agent definitions, instructions, harness state), task work anywhere else. A shell or
 * code call is only known by reading it, so System One is asked one question. Reversible work is never stopped by
 * a doubt or an outage (see authority-line.ts): only an established answer refuses, and without an engine the
 * call runs. The gate never applies to a worker, and not when the root has no worker to delegate to.
 */

import nodePath from "node:path";
import { getToolExecutionKey } from "../../kernel/tool-failure-memory.ts";
import { commandFromToolArgs } from "../acquisition/acquisition-boundary.ts";
import type { OperationEffectEngine } from "./operation-classifier.ts";
import { OPERATION_JUDGMENT_TIMEOUT_MS } from "./operation-gate.ts";

/** Shell and code tools: what they do is only known by reading the command. */
const JUDGED_TOOLS: ReadonlySet<string> = new Set(["bash", "run_process", "powershell", "python"]);
/** Typed writes: the path alone decides. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

/** The reading at or above which System One has established that a call is task work. */
const TASK_WORK_ESTABLISHED = 0.8;

export const DELEGATION_PROGRAM = {
	schema_version: "2.0",
	program_id: "JEV-ROOT-DELEGATION",
	description: "Whether one root operation carries out the owner's task itself instead of orchestrating it.",
	decisions: [
		{
			id: "performs_task_work",
			instruction:
				"Does `operation.command` change any file other than agent definitions and instruction files inside `orchestration_directories`, or run a build, test, install, migration, formatter or program that carries out the owner's work? Answer no for a command that only reads, lists, searches, shows or inspects state, including git status, log and diff.",
		},
	],
} as const;

export interface DelegationGateDeps {
	/** The setting is on, this is the owner-facing root, and a worker can be started (the `delegate` tool is active). */
	isActive(): boolean;
	getEngine(): OperationEffectEngine | undefined;
	/** The owner's request this turn serves. */
	getRequest(): string;
	/** Identity of the current user turn; a new one forgets cached verdicts. */
	getTurnKey(): string;
	/** Where agent definitions and instruction files live: the harness agent directory and the project's `.pi`. */
	getOrchestrationDirectories(): readonly string[];
	notify(message: string): void;
}

export interface DelegationRefusal {
	readonly block: true;
	readonly reason: string;
}

function isInside(root: string, path: string): boolean {
	const relative = nodePath.relative(nodePath.resolve(root), path);
	return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
}

function probability(answer: unknown): number | undefined {
	const noul = (answer as { noul?: unknown } | undefined)?.noul;
	return typeof noul === "number" && Number.isFinite(noul) && noul >= 0 && noul <= 1 ? noul : undefined;
}

export class DelegationGate {
	private readonly deps: DelegationGateDeps;
	private readonly verdicts = new Map<string, boolean>();
	private turnKey: string | undefined;
	private outageReported = false;

	constructor(deps: DelegationGateDeps) {
		this.deps = deps;
	}

	async check(
		toolName: string,
		args: unknown,
		cwd: string,
		signal?: AbortSignal,
	): Promise<DelegationRefusal | undefined> {
		signal?.throwIfAborted();
		const typedWrite = WRITE_TOOLS.has(toolName);
		if (!typedWrite && !JUDGED_TOOLS.has(toolName)) return undefined;
		if (!this.deps.isActive()) return undefined;
		const directories = this.deps.getOrchestrationDirectories();
		if (typedWrite) {
			const path = (args as { path?: unknown } | undefined)?.path;
			if (typeof path !== "string" || !path.trim()) return undefined;
			const resolved = nodePath.resolve(cwd, path);
			if (directories.some((root) => isInside(root, resolved))) return undefined;
			return this.refusal(`${toolName} ${resolved}`, directories);
		}
		const engine = this.deps.getEngine();
		const command = toolName === "run_process" ? processCommand(args) : commandFromToolArgs(args);
		if (!engine || !command) return undefined;
		this.rollTurn();
		const key = `${toolName}\u0000${getToolExecutionKey(toolName, args)}`;
		let taskWork = this.verdicts.get(key);
		if (taskWork === undefined) {
			taskWork = await this.judge(engine, toolName, command, directories, signal);
			this.verdicts.set(key, taskWork);
		}
		return taskWork ? this.refusal(command, directories) : undefined;
	}

	private async judge(
		engine: OperationEffectEngine,
		toolName: string,
		command: string,
		directories: readonly string[],
		signal?: AbortSignal,
	): Promise<boolean> {
		try {
			const bounded = [signal, AbortSignal.timeout(OPERATION_JUDGMENT_TIMEOUT_MS)].filter(
				(item): item is AbortSignal => item !== undefined,
			);
			const evaluation = await engine.evaluate(
				DELEGATION_PROGRAM,
				{
					operation: { tool: toolName, command },
					orchestration_directories: directories,
					request: this.deps.getRequest() || "(no request recorded)",
				},
				{ consequence: "high", signal: AbortSignal.any(bounded) },
			);
			return (probability(evaluation.answers?.performs_task_work) ?? 0) >= TASK_WORK_ESTABLISHED;
		} catch (error) {
			signal?.throwIfAborted();
			// Reversible work is never stopped by an outage: the call runs, and the doubt is shown once.
			if (!this.outageReported) {
				this.outageReported = true;
				this.deps.notify(
					`System One could not judge whether the root's call is task work (${error instanceof Error ? error.message : String(error)}); it runs.`,
				);
			}
			return false;
		}
	}

	private refusal(operation: string, directories: readonly string[]): DelegationRefusal {
		const shown = operation.replace(/\s+/g, " ").trim();
		const subject = shown.length <= 160 ? shown : `${shown.slice(0, 159)}…`;
		this.deps.notify(`The root delegates task work: ${subject}`);
		return {
			block: true,
			reason: `The root orchestrates and does not carry out task work itself: ${subject} is task work. Delegate it: write the instructions to a file under ${directories[0] ?? "the agent directory"} when they are long, start a worker with the delegate tool and tell it to read and follow them, then continue with other work. The worker's handoff arrives as an event.`,
		};
	}

	private rollTurn(): void {
		const turnKey = this.deps.getTurnKey();
		if (turnKey === this.turnKey) return;
		this.verdicts.clear();
		this.turnKey = turnKey;
	}
}

function processCommand(args: unknown): string | undefined {
	const record = args as { executable?: unknown; args?: unknown } | undefined;
	if (typeof record?.executable !== "string" || !record.executable.trim()) return undefined;
	const rest = Array.isArray(record.args)
		? record.args.filter((item): item is string => typeof item === "string")
		: [];
	return [record.executable.trim(), ...rest].join(" ");
}
