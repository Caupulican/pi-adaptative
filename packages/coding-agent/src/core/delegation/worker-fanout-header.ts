/**
 * Durable identity of a fan-out group member. A group has no store of its own: each member's dispatch
 * instructions begin with one host-written header line that names the group, its kind, the member and
 * every declared member id. The dispatch is already durable in the orchestration ledger, so group
 * membership and the declaration made up front survive a restart wherever the task does. This module
 * is a dependency-free leaf so the task label and the ledger projections can both read it.
 */

export const FANOUT_KINDS = ["partition", "race"] as const;
export type FanoutKind = (typeof FANOUT_KINDS)[number];

/** A partition declares at most this many slices; a race starts at most this many candidates. */
export const MAX_FANOUT_PARTITION_SLICES = 8;
export const MAX_FANOUT_RACE_CANDIDATES = 4;
export const MAX_FANOUT_MEMBER_ID_CHARS = 24;
export const FANOUT_MEMBER_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.-]*$";

const MEMBER_ID = new RegExp(FANOUT_MEMBER_ID_PATTERN);
const HEADER =
	/^\[fan-out (fo-[0-9a-f]{8}) \| (partition|race) \| (?:slice|candidate) ([A-Za-z0-9][A-Za-z0-9_.-]*) \| declared: ([A-Za-z0-9_.,-]+)\]\n/;

export interface FanoutMembership {
	groupId: string;
	kind: FanoutKind;
	memberId: string;
	/** Every member id the group declared up front, in declaration order. */
	declared: readonly string[];
}

export function isFanoutMemberId(value: string): boolean {
	return value.length > 0 && value.length <= MAX_FANOUT_MEMBER_ID_CHARS && MEMBER_ID.test(value);
}

export function formatFanoutHeader(membership: FanoutMembership): string {
	const word = membership.kind === "partition" ? "slice" : "candidate";
	return `[fan-out ${membership.groupId} | ${membership.kind} | ${word} ${membership.memberId} | declared: ${membership.declared.join(",")}]\n`;
}

/** The membership a dispatch's instructions declare, with the remaining body; undefined for ordinary work. */
export function parseFanoutHeader(instructions: string): { membership: FanoutMembership; body: string } | undefined {
	if (!instructions.startsWith("[fan-out ")) return undefined;
	const match = HEADER.exec(instructions);
	if (!match) return undefined;
	const [header, groupId, kind, memberId, declaredText] = match as unknown as [
		string,
		string,
		FanoutKind,
		string,
		string,
	];
	const declared = declaredText.split(",");
	if (
		declared.length < 2 ||
		declared.length > MAX_FANOUT_PARTITION_SLICES ||
		!declared.every(isFanoutMemberId) ||
		new Set(declared).size !== declared.length ||
		!declared.includes(memberId)
	) {
		return undefined;
	}
	return { membership: { groupId, kind, memberId, declared }, body: instructions.slice(header.length) };
}

/** Compact label prefix that keeps the group and member visible in status and Team views. */
export function fanoutLabelTag(membership: Pick<FanoutMembership, "groupId" | "memberId">): string {
	return `[${membership.groupId}/${membership.memberId}]`;
}
