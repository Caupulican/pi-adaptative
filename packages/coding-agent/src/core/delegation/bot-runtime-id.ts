/**
 * The ids the harness gives a bot's own worker runtimes, and the one place their shapes are defined. A runtime is named
 * by a fresh UUID, by the hash of an operator send's replay key or of a leader's start, or, for a group thread, by the
 * hash of its group key. The builders below are the only producers of these shapes; the bot id domain excludes them
 * (`bot-runtime-bindings.ts`), so no owner or agent can name a bot like another bot's runtime, which the unbound default
 * would then adopt. The hash inputs are durable replay identities: changing one changes the id a repeated send names.
 */

import { createHash, randomUUID } from "node:crypto";

const DIGEST_CHARS = 32;

/** `bot-<uuid>`: a runtime started without a replay key. */
const BOT_UUID_RUNTIME_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `bot-<32 hex>`: a runtime named by the hash of a keyed send or of a leader's start. */
const BOT_DIGEST_RUNTIME_ID = /^bot-[0-9a-f]{32}$/;
/** `group-<32 hex>`: the runtime of a bot in a group thread, named by the hash of the group's key. */
const GROUP_DIGEST_RUNTIME_ID = /^group-[0-9a-f]{32}$/;

function digestId(prefix: "bot" | "group", material: string): string {
	return `${prefix}-${createHash("sha256").update(material).digest("hex").slice(0, DIGEST_CHARS)}`;
}

/** A runtime for a bot start that carries no replay key: each start gets its own. */
export function freshBotRuntimeId(): string {
	return `bot-${randomUUID()}`;
}

/** The runtime an operator send with a replay key starts: a repeated send names the same runtime. */
export function keyedBotRuntimeId(alias: string, replayKey: string): string {
	return digestId("bot", `operator-message\0${alias}\0${replayKey}`);
}

/** The runtime a leader's start of its bot names: a repeated call in one invocation names the same runtime. */
export function leaderOwnedBotRuntimeId(invocationId: string, alias: string): string {
	return digestId("bot", `leader-owned-start\0${invocationId}\0${alias}`);
}

/** The runtime of a bot in a group thread, from the group's canonical key (the team, its incarnation and the bot). */
export function groupBotRuntimeId(groupKey: string): string {
	return digestId("group", groupKey);
}

/** Whether `id` is a runtime id the harness generated for a bot. A bot may not take that name. */
export function isGeneratedBotRuntimeId(id: string): boolean {
	return BOT_UUID_RUNTIME_ID.test(id) || BOT_DIGEST_RUNTIME_ID.test(id) || GROUP_DIGEST_RUNTIME_ID.test(id);
}
