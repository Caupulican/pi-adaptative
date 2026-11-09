/**
 * The capability advert (`cap/1`): what a machine tells a peer it can take, as code facts only. The operating system,
 * the checkouts it offers by identity (never by path), the tools on its PATH from a fixed vocabulary, the model access
 * it has by provider class (never an account, a key or a token), how many jobs it can take now, and whether it takes
 * jobs from this peer at all. A peer's advert is third-party data: every field is rebuilt from a closed set or a
 * bounded pattern, so a label a peer chose never reaches a model or a screen unchecked.
 */

import { existsSync } from "node:fs";
import { arch as osArch, platform } from "node:os";
import { delimiter, join } from "node:path";
import { isProcessOwnerRecord, judgeOwner } from "../../kernel/reliability/owner-identity.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type { LinkSettings } from "./registry.ts";
import { resolveRepoIdentity } from "./repo-identity.ts";

export const CAPABILITY_TOOLS = ["git", "node", "npm", "bun", "python", "cargo", "go", "dotnet", "docker"] as const;
export type CapabilityTool = (typeof CAPABILITY_TOOLS)[number];
export const MODEL_ACCESS = ["subscription", "api", "local"] as const;
export type ModelAccess = (typeof MODEL_ACCESS)[number];
export const MODEL_HEADROOM = ["ok", "low", "out", "unknown"] as const;
export type ModelHeadroom = (typeof MODEL_HEADROOM)[number];

export interface CheckoutFact {
	readonly repoKey: string;
	readonly headSha?: string;
	/** The owner marked the checkout ready for work (dependencies installed). */
	readonly ready: boolean;
}

export interface ModelFact {
	readonly provider: string;
	readonly modelClass: string;
	readonly access: ModelAccess;
	readonly headroom: ModelHeadroom;
}

export interface CapabilityFacts {
	readonly os: "linux" | "darwin" | "win32" | "other";
	readonly arch: string;
	readonly shell: "posix" | "pwsh7";
	readonly checkouts: readonly CheckoutFact[];
	readonly tools: readonly CapabilityTool[];
	readonly models: readonly ModelFact[];
	/** How many more jobs this machine takes now; 0 while no session there runs placed jobs. */
	readonly room: number;
	/** What it takes from the peer it sent this advert to. */
	readonly accepts: { readonly jobs: boolean; readonly writes: boolean; readonly leader: boolean };
	/** Grows whenever any other field changes, so a receiver keeps only the newest advert. */
	readonly capRev: number;
}

export const MAX_ADVERT_CHECKOUTS = 32;
export const MAX_ADVERT_MODELS = 32;
const MAX_ROOM = 64;
/** A repository identity on the wire. */
export const REPO_KEY = /^[0-9a-f]{64}$/;
/** A commit id on the wire (SHA-1 or SHA-256). */
export const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** A provider, model class or architecture word on the wire: lowercase, no spaces, never free text. */
export const WIRE_WORD = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const OSES = ["linux", "darwin", "win32", "other"] as const;

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (values as readonly string[]).includes(value);
}

function parseCheckout(value: unknown): CheckoutFact | undefined {
	if (!isPlainRecord(value) || typeof value.repoKey !== "string" || !REPO_KEY.test(value.repoKey)) return undefined;
	if (value.headSha !== undefined && (typeof value.headSha !== "string" || !COMMIT_SHA.test(value.headSha)))
		return undefined;
	if (typeof value.ready !== "boolean") return undefined;
	return {
		repoKey: value.repoKey,
		...(typeof value.headSha === "string" ? { headSha: value.headSha } : {}),
		ready: value.ready,
	};
}

function parseModel(value: unknown): ModelFact | undefined {
	return isPlainRecord(value) &&
		typeof value.provider === "string" &&
		WIRE_WORD.test(value.provider) &&
		typeof value.modelClass === "string" &&
		WIRE_WORD.test(value.modelClass) &&
		isOneOf(MODEL_ACCESS, value.access) &&
		isOneOf(MODEL_HEADROOM, value.headroom)
		? { provider: value.provider, modelClass: value.modelClass, access: value.access, headroom: value.headroom }
		: undefined;
}

function parseList<T>(value: unknown, max: number, parse: (entry: unknown) => T | undefined): T[] | undefined {
	if (!Array.isArray(value) || value.length > max) return undefined;
	const parsed = value.map(parse);
	return parsed.every((entry) => entry !== undefined) ? (parsed as T[]) : undefined;
}

/** A capability advert rebuilt field by field, or undefined when any field is malformed. */
export function parseCapabilityFacts(value: unknown): CapabilityFacts | undefined {
	if (!isPlainRecord(value) || !isOneOf(OSES, value.os) || !isOneOf(["posix", "pwsh7"] as const, value.shell))
		return undefined;
	if (typeof value.arch !== "string" || !WIRE_WORD.test(value.arch)) return undefined;
	const checkouts = parseList(value.checkouts, MAX_ADVERT_CHECKOUTS, parseCheckout);
	const models = parseList(value.models, MAX_ADVERT_MODELS, parseModel);
	const tools = parseList(value.tools, CAPABILITY_TOOLS.length, (entry) =>
		isOneOf(CAPABILITY_TOOLS, entry) ? entry : undefined,
	);
	const accepts = isPlainRecord(value.accepts) ? value.accepts : undefined;
	if (!checkouts || !models || !tools || !accepts) return undefined;
	if (typeof accepts.jobs !== "boolean" || typeof accepts.writes !== "boolean" || typeof accepts.leader !== "boolean")
		return undefined;
	if (typeof value.room !== "number" || !Number.isSafeInteger(value.room) || value.room < 0 || value.room > MAX_ROOM)
		return undefined;
	if (typeof value.capRev !== "number" || !Number.isSafeInteger(value.capRev) || value.capRev < 0) return undefined;
	return {
		os: value.os,
		arch: value.arch,
		shell: value.shell,
		checkouts,
		tools: [...new Set(tools)],
		models,
		room: value.room,
		accepts: { jobs: accepts.jobs, writes: accepts.writes, leader: accepts.leader },
		capRev: value.capRev,
	};
}

/** The session running placed jobs here, as it publishes itself (`remote/jobs/runner.json`). */
export interface RunnerAdvert {
	readonly models: readonly ModelFact[];
	readonly room: number;
}

/** The runner's advert when its session is alive; undefined when no session runs placed jobs here. */
export function liveRunnerAdvert(stored: unknown): RunnerAdvert | undefined {
	if (!isPlainRecord(stored) || !isProcessOwnerRecord(stored.owner) || judgeOwner(stored.owner) !== "alive")
		return undefined;
	const models = parseList(stored.models, MAX_ADVERT_MODELS, parseModel) ?? [];
	const room =
		typeof stored.room === "number" && Number.isSafeInteger(stored.room)
			? Math.max(0, Math.min(MAX_ROOM, stored.room))
			: 0;
	return { models, room };
}

let toolCache: { at: number; tools: CapabilityTool[] } | undefined;
const TOOL_TTL_MS = 10 * 60_000;

/** The vocabulary's tools found on PATH, by looking for the file in each PATH directory: nothing is run. */
function toolsOnPath(now: number): CapabilityTool[] {
	if (toolCache && now - toolCache.at < TOOL_TTL_MS) return toolCache.tools;
	const dirs = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);
	const extensions =
		process.platform === "win32"
			? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter((ext) => ext.length > 0)
			: [""];
	const names: Readonly<Record<CapabilityTool, readonly string[]>> = {
		git: ["git"],
		node: ["node"],
		npm: ["npm"],
		bun: ["bun"],
		python: ["python3", "python"],
		cargo: ["cargo"],
		go: ["go"],
		dotnet: ["dotnet"],
		docker: ["docker"],
	};
	const tools = CAPABILITY_TOOLS.filter((tool) =>
		names[tool].some((name) => dirs.some((dir) => extensions.some((ext) => existsSync(join(dir, `${name}${ext}`))))),
	);
	toolCache = { at: now, tools };
	return tools;
}

/** A checkout the owner offers here: its fact for the advert, and its path, which never leaves this machine. */
export interface OfferedCheckout {
	readonly path: string;
	readonly fact: CheckoutFact;
}

/** The checkouts the owner offers here, by identity; a listed path that is not a git checkout is left out. */
export async function offeredCheckouts(settings: LinkSettings): Promise<OfferedCheckout[]> {
	const offered: OfferedCheckout[] = [];
	for (const repo of settings.repos.slice(0, MAX_ADVERT_CHECKOUTS)) {
		const identity = await resolveRepoIdentity(repo.path);
		if (identity)
			offered.push({
				path: repo.path,
				fact: {
					repoKey: identity.repoKey,
					...(identity.headSha ? { headSha: identity.headSha } : {}),
					ready: repo.ready === true,
				},
			});
	}
	return offered;
}

/** This machine's advert for one peer, without the revision (the sender numbers what it sends). */
export function localFacts(input: {
	readonly checkouts: readonly CheckoutFact[];
	readonly runner: RunnerAdvert | undefined;
	/** Placed jobs admitted here and not yet finished, from every placer. */
	readonly activeJobs: number;
	readonly acceptsJobs: boolean;
	readonly now?: number;
}): Omit<CapabilityFacts, "capRev"> {
	const os = platform();
	const runs = input.acceptsJobs && input.runner !== undefined;
	return {
		os: isOneOf(OSES, os) ? os : "other",
		arch: WIRE_WORD.test(osArch()) ? osArch() : "other",
		shell: os === "win32" ? "pwsh7" : "posix",
		checkouts: input.checkouts,
		tools: toolsOnPath(input.now ?? Date.now()),
		models: input.runner?.models ?? [],
		room: runs && input.runner ? Math.max(0, input.runner.room - input.activeJobs) : 0,
		accepts: { jobs: runs, writes: false, leader: false },
	};
}
