/**
 * The Root transcript's most recent `!` command, resolved once per conversation revision. The Execution
 * pane asks for it several times a frame, and rescanning every transcript child each time is pure waste.
 */

import type { Container } from "@caupulican/pi-tui";
import { BashExecutionComponent } from "./bash-execution.ts";

const cache = new WeakMap<Container, { revision: number; shell?: BashExecutionComponent }>();

/** The last user shell in `conversation`, re-resolved only after the container's revision moves. */
export function lastUserShell(conversation: Container): BashExecutionComponent | undefined {
	const revision = conversation.renderRevision ?? -1;
	const known = cache.get(conversation);
	if (known && known.revision === revision) return known.shell;
	const shell = conversation.children.findLast(
		(child): child is BashExecutionComponent => child instanceof BashExecutionComponent,
	);
	cache.set(conversation, { revision, shell });
	return shell;
}
