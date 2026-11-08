/**
 * What a machine that is both a hub and a joiner tells the hub above it, so that hub can refuse a loop of hubs: the ids of
 * the machines joined here and how deep that chain goes. The hub controller of an agent directory provides it; the link
 * provider of the same directory reads it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface LinkContext {
	readonly subtree: () => readonly string[];
	readonly depth: () => number;
}

const contexts = new Map<string, LinkContext>();
/** Per agent directory, each joined hub's address and where its link stands, in the owner's words. */
const joinStates = new Map<string, Map<string, string>>();

export function reportJoinState(agentDir: string, address: string, text: string): void {
	const states = joinStates.get(agentDir) ?? new Map<string, string>();
	joinStates.set(agentDir, states);
	states.set(address, text);
	// Written beside the other link records, so a tool reading them sees where each link stands.
	try {
		mkdirSync(join(agentDir, "remote"), { recursive: true });
		writeFileSync(join(agentDir, "remote", "links.json"), `${JSON.stringify(Object.fromEntries(states), null, 1)}\n`);
	} catch {
		// The state is still served from memory.
	}
}

export function joinStateFor(agentDir: string, address: string): string {
	return joinStates.get(agentDir)?.get(address) ?? "not started";
}

export function provideLinkContext(agentDir: string, context: LinkContext): void {
	contexts.set(agentDir, context);
}

export function linkContextFor(agentDir: string): LinkContext {
	return contexts.get(agentDir) ?? { subtree: () => [], depth: () => 0 };
}
