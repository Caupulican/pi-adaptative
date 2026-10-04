import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { CHAT_AGENT_NAME_ENV, MAX_PEER_FIELD_CHARS } from "./constants.ts";
import type { ChatIdentity } from "./state.ts";

export type RuntimeIdentity = {
	id: string;
	name: string;
	pcLabel: string;
	persistent: boolean;
};

/**
 * A name reaches peers' prompts and UI, and the broker drops a peer whose name is empty, too long or holds
 * control characters. A configured name is normalized to what the broker accepts instead of making the
 * session silently invisible.
 */
function normalizeName(name: string | undefined): string | undefined {
	const clean = name
		?.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
		.trim()
		.slice(0, MAX_PEER_FIELD_CHARS - 16)
		.trim();
	return clean && clean.length > 0 ? clean : undefined;
}

export function createRuntimeIdentity(env: NodeJS.ProcessEnv = process.env): RuntimeIdentity {
	const pcLabel = hostname() || "local-machine";
	return {
		id: `runtime-${randomUUID()}`,
		name: normalizeName(env[CHAT_AGENT_NAME_ENV]) ?? `pi-${pcLabel}-${process.pid}`,
		pcLabel,
		persistent: false,
	};
}

export function createFilesystemIdentity(name?: string, now = new Date()): ChatIdentity {
	const pcLabel = hostname() || "local-machine";
	const cleanName = name?.trim();
	return {
		id: randomUUID(),
		name: cleanName && cleanName.length > 0 ? cleanName : `pi-${pcLabel}`,
		pcLabel,
		createdAt: now.toISOString(),
		storage: "filesystem-fallback",
	};
}

/**
 * A stored identity names the machine's agent; it never replaces the mesh id. The state root is shared by
 * every session on the machine, so its id would be one id for all of them, and peers sharing an id cannot
 * see or address each other. Each session keeps its own runtime id. `PI_CHAT_AGENT_NAME` overrides the stored
 * name, so one session can be named without rewriting the machine's state; the broker suffixes a name another
 * peer already holds.
 */
export function resolveIdentity(
	runtime: RuntimeIdentity,
	stored?: ChatIdentity,
	env: NodeJS.ProcessEnv = process.env,
): RuntimeIdentity {
	if (!stored) return runtime;
	const name = normalizeName(env[CHAT_AGENT_NAME_ENV]) ?? normalizeName(stored.name) ?? runtime.name;
	return { id: runtime.id, name, pcLabel: stored.pcLabel, persistent: true };
}
