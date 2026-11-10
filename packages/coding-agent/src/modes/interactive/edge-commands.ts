/**
 * `/edge` — the operator's view of, and authority over, the edge.
 *
 * The edge is the short list of operation classes. Git, publishing, installing, and settings edits
 * run. An ungranted `destructive.fs` or `toolkit.script` asks once. Grants come from the task
 * instructions (recorded by the model with the operator's exact words), from here, or from the
 * machine's settings (`edge.allow`).
 */
import {
	EDGE_CLASSES,
	type EdgeClass,
	type EdgeGrantView,
	edgeClassDescriptions,
	edgeClassRequiresConfirmation,
	isEdgeClass,
} from "../../core/autonomy/edge-policy.ts";
import { interfaceText } from "../../core/language/interface-text.ts";

export interface EdgeHost {
	getEdgeGrants(): EdgeGrantView[];
	grantEdge(edgeClass: EdgeClass, note?: string): Promise<void>;
	revokeEdge(edgeClass: EdgeClass): Promise<boolean>;
	showStatus(message: string): void;
	showError(message: string): void;
	/** Multi-line output in the conversation (status lines are single rows). */
	showText(text: string): void;
}

export const EDGE_USAGE = "/edge [list] · /edge allow <class…|all> [note] · /edge revoke <class…|all>";

/**
 * The classes an allow/revoke names: explicit classes in the order given, or every class for
 * `all`. Undefined when a token is neither, so a typo never silently grants less than asked.
 */
export function resolveEdgeTargets(tokens: readonly string[]): { classes: EdgeClass[]; note?: string } | undefined {
	const classes: EdgeClass[] = [];
	let index = 0;
	for (; index < tokens.length; index++) {
		const token = tokens[index] as string;
		if (token === "all") {
			for (const cls of EDGE_CLASSES) if (!classes.includes(cls)) classes.push(cls);
			continue;
		}
		if (!isEdgeClass(token)) break;
		if (!classes.includes(token)) classes.push(token);
	}
	if (classes.length === 0) return undefined;
	const rest = tokens.slice(index);
	// Anything after the classes is the note; a stray token that looks like a class typo is refused.
	if (rest.some((token) => /^[a-z]+\.[a-z]+$/.test(token) && !isEdgeClass(token))) return undefined;
	return { classes, ...(rest.length > 0 ? { note: rest.join(" ") } : {}) };
}

function describeGrant(grant: EdgeGrantView): string {
	const words = interfaceText().autonomyCommands.edge;
	const from =
		grant.source === "instructions"
			? words.fromInstructions(grant.quote ? words.fromInstructionsQuote(grant.quote) : "")
			: grant.source === "operator"
				? words.fromSession(grant.note ? words.fromSessionNote(grant.note) : "")
				: words.fromSettings;
	return words.granted(from);
}

export async function handleEdgeCommand(host: EdgeHost, text: string): Promise<void> {
	const args = text.replace(/^\/edge\b/, "").trim();
	const [action = "list", target, ...rest] = args.split(/\s+/).filter(Boolean);
	if (action === "list" || action === "") {
		const words = interfaceText().autonomyCommands.edge;
		const descriptions = edgeClassDescriptions();
		const grants = new Map(host.getEdgeGrants().map((grant) => [grant.class, grant]));
		host.showText(
			[
				words.summary(grants.size, EDGE_CLASSES.length),
				...EDGE_CLASSES.map((cls) => {
					const grant = grants.get(cls);
					const pending = edgeClassRequiresConfirmation(cls) ? words.asks : words.runs;
					return `${grant ? "✓" : "·"} ${cls} — ${descriptions[cls]}\n   ${grant ? describeGrant(grant) : pending}`;
				}),
				EDGE_USAGE,
			].join("\n"),
		);
		return;
	}
	if (action === "allow" || action === "revoke") {
		const words = interfaceText().autonomyCommands.edge;
		const targets = resolveEdgeTargets(target === undefined ? [] : [target, ...rest]);
		if (!targets) {
			host.showError(`${EDGE_USAGE} — ${words.unknownTarget(EDGE_CLASSES.join(", "))}`);
			return;
		}
		if (action === "allow") {
			// One grant per class: the durable record stays per class, so a later `/edge revoke
			// git.publish` narrows a full grant instead of undoing it wholesale.
			for (const cls of targets.classes) await host.grantEdge(cls, targets.note);
			host.showStatus(
				targets.classes.length === EDGE_CLASSES.length
					? words.everyClassGranted
					: words.classesGranted(targets.classes.join(", "), targets.classes.length === 1),
			);
			return;
		}
		const revoked: EdgeClass[] = [];
		const untouched: EdgeClass[] = [];
		for (const cls of targets.classes) (await host.revokeEdge(cls)) ? revoked.push(cls) : untouched.push(cls);
		host.showStatus(
			[
				revoked.length > 0
					? `${words.revoked(revoked.join(", "))}${
							revoked.some((cls) => edgeClassRequiresConfirmation(cls))
								? words.revokedAsksAgain(revoked.length === 1)
								: "."
						}`
					: "",
				untouched.length > 0 ? words.notGranted(untouched.join(", "), untouched.length === 1) : "",
			]
				.filter(Boolean)
				.join(" "),
		);
		return;
	}
	host.showError(EDGE_USAGE);
}
