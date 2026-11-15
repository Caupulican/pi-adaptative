/**
 * The write facts of one plan call, F8, F9 and F11. F8: a step that changes files names what proves it (a requirement or a
 * proof). F9: two steps that may change the same files at the same time are ordered, or are members of one merge. F11: a
 * step names no file outside the roots the session's workers may write in.
 * Pure code over the steps stated at this call's version; a host revision (verify wrap, placement, merge land) never
 * passes through here, so it never trips them. Unverified write steps are a doubt, not a refusal.
 */

import { resolve } from "node:path";
import { pathWithinRoots } from "../delegation/worker-nested-start.ts";
import type { WorkerCeiling } from "../delegation/worker-parent-ceiling.ts";
import { type PlanNodeSpec, planPathExists, writeScopesOverlap } from "./plan-graph.ts";

export interface WriteFactRefusal {
	readonly fact: "F8" | "F9" | "F11";
	/** One plain-words fix line. */
	readonly fix: string;
}

function sharedMerge(nodes: readonly PlanNodeSpec[], a: string, b: string): boolean {
	return nodes.some(
		(node) =>
			node.kind === "merge" &&
			(node.join?.members.includes(a) ?? false) &&
			(node.join?.members.includes(b) ?? false),
	);
}

/**
 * The refusals of the steps stated at this version (`changed`): F8 for each changed work step that changes files with
 * neither a requirement nor a proof, and F9 for each pair of work steps with at least one changed, unordered, whose
 * write scopes overlap, unless both are members of one merge.
 */
export function checkWriteFacts(nodes: readonly PlanNodeSpec[], changed: ReadonlySet<string>): WriteFactRefusal[] {
	const refusals: WriteFactRefusal[] = [];
	for (const node of nodes) {
		if (!changed.has(node.id) || node.kind !== "work" || node.writeScope.length === 0) continue;
		if (node.requirementIds.length === 0 && (node.brief?.evid ?? "none") === "none") {
			refusals.push({
				fact: "F8",
				fix: `step "${node.id}" changes files but names no requirement and no proof; add req, or proof: cite|cmd|diff|check:<command>`,
			});
		}
	}
	const writers = nodes.filter((node) => node.kind === "work" && node.writeScope.length > 0);
	for (let first = 0; first < writers.length; first += 1) {
		for (let second = first + 1; second < writers.length; second += 1) {
			const a = writers[first] as PlanNodeSpec;
			const b = writers[second] as PlanNodeSpec;
			if (!changed.has(a.id) && !changed.has(b.id)) continue;
			if (planPathExists(nodes, a.id, b.id) || planPathExists(nodes, b.id, a.id)) continue;
			const path = writeScopesOverlap(a.writeScope, b.writeScope);
			if (path === undefined || sharedMerge(nodes, a.id, b.id)) continue;
			refusals.push({
				fact: "F9",
				fix: `steps "${a.id}" and "${b.id}" may change the same files (${path}) at the same time; add after, or merge the steps`,
			});
		}
	}
	return refusals;
}

/** Where a session's workers may write: its ceiling over them (`workerCeilingOf`) and the directory step files are under. */
export interface WorkerWriteReach {
	readonly ceiling: WorkerCeiling;
	readonly cwd: string;
}

/**
 * F11: the refusal of each step stated at this version (`changed`) that names a file outside the roots the session's
 * workers may write in (its ceiling's `writeRoots`, each file resolved against the session's directory); the owner's
 * reach, or a ceiling that bounds no root, refuses none. The ceiling would start such a step's worker without the write,
 * under a plan that orders, isolates, proves and lands the step as a writer of that file. A session whose workers write
 * nowhere (a read-only bot) plans every step as the read-only work its worker does, and no merge, whose steps must name
 * their files.
 */
export function unlentWriteRefusals(
	nodes: readonly PlanNodeSpec[],
	reach: WorkerWriteReach,
	changed: ReadonlySet<string>,
): WriteFactRefusal[] {
	const roots = reach.ceiling === "unbounded" ? undefined : reach.ceiling.writeRoots;
	if (roots === undefined) return [];
	return nodes.flatMap((node): WriteFactRefusal[] => {
		if (!changed.has(node.id)) return [];
		const outside = node.writeScope.filter((path) => !pathWithinRoots(resolve(reach.cwd, path), roots));
		if (outside.length === 0) return [];
		const fix =
			roots.length === 0
				? `step "${node.id}" names files, but this session changes no files and neither do its workers; leave out files`
				: `step "${node.id}" names ${outside.join(", ")}, outside where this session's workers may write (${roots.join(", ")}); name files inside it or leave them out`;
		return [{ fact: "F11", fix }];
	});
}

/** Work steps that change files and have no verify step downstream of them: a doubt on each, never a refusal. */
export function unverifiedWriteSteps(nodes: readonly PlanNodeSpec[]): string[] {
	const verifiers = nodes.filter((node) => node.kind === "verify");
	return nodes
		.filter(
			(node) =>
				node.kind === "work" &&
				node.writeScope.length > 0 &&
				!verifiers.some((verifier) => planPathExists(nodes, node.id, verifier.id)),
		)
		.map((node) => node.id);
}
