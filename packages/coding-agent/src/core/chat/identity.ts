import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { CHAT_AGENT_NAME_ENV } from "./constants.ts";
import type { ChatIdentity } from "./state.ts";

export type RuntimeIdentity = {
	id: string;
	name: string;
	pcLabel: string;
	persistent: boolean;
};

export function createRuntimeIdentity(env: NodeJS.ProcessEnv = process.env): RuntimeIdentity {
	const pcLabel = hostname() || "local-machine";
	const configuredName = env[CHAT_AGENT_NAME_ENV]?.trim();
	return {
		id: `runtime-${randomUUID()}`,
		name: configuredName && configuredName.length > 0 ? configuredName : `pi-${pcLabel}-${process.pid}`,
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

export function resolveIdentity(runtime: RuntimeIdentity, stored?: ChatIdentity): RuntimeIdentity {
	if (!stored) return runtime;
	return { id: stored.id, name: stored.name, pcLabel: stored.pcLabel, persistent: true };
}
