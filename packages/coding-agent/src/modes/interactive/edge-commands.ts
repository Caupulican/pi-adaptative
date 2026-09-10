/**
 * `/edge` — the operator's view of, and authority over, the edge.
 *
 * The edge is the short list of operation classes that can need the operator (publishing a
 * repository or a package, adding a dependency, deleting outside the task, changing the harness's
 * own authority). A granted class never asks; an ungranted one asks once. Grants come from the task
 * instructions (recorded by the model with the operator's exact words), from here, or from the
 * machine's settings (`edge.allow`).
 */
import {
	EDGE_CLASS_DESCRIPTIONS,
	EDGE_CLASSES,
	type EdgeClass,
	type EdgeGrantView,
	isEdgeClass,
} from "../../core/autonomy/edge-policy.ts";

export interface EdgeHost {
	getEdgeGrants(): EdgeGrantView[];
	grantEdge(edgeClass: EdgeClass, note?: string): Promise<void>;
	revokeEdge(edgeClass: EdgeClass): Promise<boolean>;
	showStatus(message: string): void;
	showError(message: string): void;
	/** Multi-line output in the conversation (status lines are single rows). */
	showText(text: string): void;
}

export const EDGE_USAGE = "/edge [list] · /edge allow <class> [note] · /edge revoke <class>";

function describeGrant(grant: EdgeGrantView): string {
	const from =
		grant.source === "instructions"
			? `instructions${grant.quote ? ` — "${grant.quote}"` : ""}`
			: grant.source === "operator"
				? `this session${grant.note ? ` — ${grant.note}` : ""}`
				: "settings (edge.allow)";
	return `granted · ${from}`;
}

export async function handleEdgeCommand(host: EdgeHost, text: string): Promise<void> {
	const args = text.replace(/^\/edge\b/, "").trim();
	const [action = "list", target, ...rest] = args.split(/\s+/).filter(Boolean);
	if (action === "list" || action === "") {
		const grants = new Map(host.getEdgeGrants().map((grant) => [grant.class, grant]));
		host.showText(
			[
				`Edge — ${grants.size} of ${EDGE_CLASSES.length} classes granted; an ungranted class asks once`,
				...EDGE_CLASSES.map((cls) => {
					const grant = grants.get(cls);
					return `${grant ? "✓" : "·"} ${cls} — ${EDGE_CLASS_DESCRIPTIONS[cls]}\n   ${grant ? describeGrant(grant) : "asks"}`;
				}),
				EDGE_USAGE,
			].join("\n"),
		);
		return;
	}
	if (action === "allow" || action === "revoke") {
		if (!isEdgeClass(target)) {
			host.showError(`${EDGE_USAGE} — classes: ${EDGE_CLASSES.join(", ")}`);
			return;
		}
		if (action === "allow") {
			await host.grantEdge(target, rest.join(" ") || undefined);
			host.showStatus(`Edge: ${target} granted for this session; it will not ask.`);
			return;
		}
		const revoked = await host.revokeEdge(target);
		host.showStatus(
			revoked
				? `Edge: ${target} revoked; it asks again.`
				: `Edge: ${target} was not granted in this session (a settings grant is changed in edge.allow).`,
		);
		return;
	}
	host.showError(EDGE_USAGE);
}
