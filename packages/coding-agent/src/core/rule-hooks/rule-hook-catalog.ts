import { createHash } from "node:crypto";
import { RULE_HOOKS } from "./rule-hook-rules.ts";

/**
 * Rule hooks: standing rules kept out of the always-on system prompt and delivered by the host, as one text
 * block appended to the result of a trigger tool call that succeeded (see `rule-hook-delivery.ts`). Delivery
 * does not depend on a model decision, so the rule lands in history and is cached with the prefix.
 *
 * A rule's id is derived from its content, so it can never describe a version other than the one the model
 * received: `<topic>@<first 8 hex of sha256(body)>`. The delivered text starts with the line `RULE <id>`, which is
 * what a later verification and the delivered-once check anchor on. The rules are product constants
 * (`rule-hook-rules.ts`), so building a prompt has no filesystem dependency.
 */

/** A delivered rule is one tool-result block; a larger rule is split into smaller topics instead. */
export const MAX_RULE_HOOK_CHARS = 4096;
const TOPIC_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const TOOL_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Values a rule body may depend on at delivery time. */
export interface RuleHookContext {
	/** Directory of the installed harness package (README.md, docs/, examples/). */
	readonly packageRoot: string;
}

/** A finished tool call, as the trigger predicate sees it. */
export interface RuleHookCall extends RuleHookContext {
	readonly toolName: string;
	readonly args: unknown;
	/** The directory the call's relative paths resolve against. */
	readonly cwd: string;
}

/**
 * What delivers a rule. `tool-call`: a successful call of one of `tools` (narrowed by `matches` over the call
 * arguments; absent means any call) gets the rule appended to its result. `preflight`: a host check that is about
 * to accept an action asks for the rule first (see `RuleHookDelivery.refusalFor`), so the rule precedes the action.
 */
export type RuleHookTrigger =
	| {
			readonly kind: "tool-call";
			readonly tools: readonly string[];
			readonly matches?: (call: RuleHookCall) => boolean;
	  }
	| { readonly kind: "preflight" };

export interface RuleHookSource {
	readonly topic: string;
	readonly trigger: RuleHookTrigger;
	/** Delivered to the root session only; a worker session never receives it. */
	readonly rootOnly?: boolean;
	/** Delivered only while this tool is active: a rule about a tool is never sent to a session that lacks it. */
	readonly requiresTool?: string;
	/**
	 * The rule text. A function renders it from the delivery context; the id is derived from the text it renders
	 * for {@link TEMPLATE_CONTEXT}, so it stays stable while the context varies.
	 */
	readonly body: string | ((context: RuleHookContext) => string);
}

export interface RuleHook extends Omit<RuleHookSource, "body"> {
	readonly id: string;
	/** The static text the id is derived from. */
	readonly template: string;
	render(context: RuleHookContext): string;
}

/** The context a dynamic body renders for when its id is derived. */
const TEMPLATE_CONTEXT: RuleHookContext = { packageRoot: "<package-root>" };

export function ruleHookId(topic: string, body: string): string {
	return `${topic}@${createHash("sha256").update(body, "utf8").digest("hex").slice(0, 8)}`;
}

function normalizeBody(topic: string, text: string): string {
	const body = text.replace(/\r\n?/g, "\n").trim();
	if (body.length === 0) throw new Error(`Rule hook ${topic} has no body.`);
	if (body.length > MAX_RULE_HOOK_CHARS) {
		throw new Error(
			`Rule hook ${topic} is ${body.length} characters; the limit is ${MAX_RULE_HOOK_CHARS}. Split it into smaller topics.`,
		);
	}
	return body;
}

/** Validates one rule; an invalid constant is a programming error and fails the first delivery loudly. */
export function buildRuleHook(source: RuleHookSource): RuleHook {
	const { topic, trigger, rootOnly, requiresTool } = source;
	if (!TOPIC_PATTERN.test(topic)) throw new Error(`Rule hook topic ${topic} must be kebab-case.`);
	if (trigger.kind === "tool-call") {
		const { tools } = trigger;
		if (tools.length === 0 || tools.some((tool) => !TOOL_PATTERN.test(tool))) {
			throw new Error(`Rule hook ${topic} needs at least one valid trigger tool name.`);
		}
		if (new Set(tools).size !== tools.length) {
			throw new Error(`Rule hook ${topic} lists a trigger tool more than once.`);
		}
	}
	if (requiresTool !== undefined && !TOOL_PATTERN.test(requiresTool)) {
		throw new Error(`Rule hook ${topic} requires an invalid tool name.`);
	}
	const body = source.body;
	const template = normalizeBody(topic, typeof body === "string" ? body : body(TEMPLATE_CONTEXT));
	return {
		topic,
		trigger,
		id: ruleHookId(topic, template),
		template,
		render: (context) => normalizeBody(topic, typeof body === "string" ? body : body(context)),
		...(rootOnly ? { rootOnly } : {}),
		...(requiresTool !== undefined ? { requiresTool } : {}),
	};
}

let catalog: readonly RuleHook[] | undefined;

/** Every rule, in declaration order and validated once. */
export function loadRuleHooks(): readonly RuleHook[] {
	if (catalog) return catalog;
	const hooks = RULE_HOOKS.map(buildRuleHook);
	if (new Set(hooks.map((hook) => hook.topic)).size !== hooks.length) {
		throw new Error("Rule hook topics must be unique.");
	}
	catalog = hooks;
	return hooks;
}

/** A delivered rule's first line is this prefix followed by the id; a later check looks for exactly that line. */
export const RULE_MARKER_PREFIX = "RULE ";

/** The exact text delivered: the marker line, then the whole rule. */
export function formatRuleHook(hook: RuleHook, context: RuleHookContext): string {
	return `${RULE_MARKER_PREFIX}${hook.id}\n${hook.render(context)}`;
}
