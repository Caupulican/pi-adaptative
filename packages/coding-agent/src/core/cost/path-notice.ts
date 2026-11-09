/**
 * Usage-delivery warning text that names a file path within the host's warning bound: the path is elided in its middle and
 * its file name kept whole, so the evidence stays identifiable.
 */
import { basename } from "node:path";

/** The host bounds one warning to this many characters (AgentSession.emitHostWarning); a handoff must fit whole. */
const HANDOFF_MESSAGE_CHARS = 500;

/** A notice whose path is elided to fit the host's bound, with the text around it kept whole. */
export function pathNotice(lead: string, path: string, tail: string): string {
	return `${lead}${elidePath(path, HANDOFF_MESSAGE_CHARS - lead.length - tail.length)}${tail}`;
}

/**
 * A path shortened to `budget` UTF-16 units (the host's own measure) by eliding its middle behind an explicit marker. The file
 * name is kept whole, so the evidence stays identifiable; only the directories are shortened.
 */
function elidePath(path: string, budget: number): string {
	if (path.length <= budget) return path;
	const marker = "…";
	const name = basename(path);
	if (name.length + marker.length > budget) return marker + name.slice(name.length - (budget - marker.length));
	return `${path.slice(0, budget - name.length - marker.length)}${marker}${name}`;
}
