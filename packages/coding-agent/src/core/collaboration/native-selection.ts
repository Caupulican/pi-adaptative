import type { NativeProviderSelection } from "./native-provider.ts";

const UNPROBED_AUTH_OPTIONS: Readonly<Record<string, RegExp>> = {
	pi: /^(?:--api-key|--models|--agent-dir|--config|--settings)(?:=|$)/,
	codex: /^(?:(?:--config|--profile|--oss|--local-provider|--remote|--remote-auth-token-env|--cd)(?:=|$)|-[cpC].*)/,
	claude: /^(?:--settings|--setting-sources|--bare|--remote|--cloud|--environment)(?:=|$)/,
};
const NONINTERACTIVE_OPTIONS: Readonly<Record<string, RegExp>> = {
	pi: /^(?:--(?:print|mode)(?:=|$)|-p.*)/,
	claude: /^(?:--(?:print|background|bg|output-format|input-format)(?:=|$)|-p.*)/,
	agy: /^(?:--(?:print|prompt|input-format|output-format)(?:=|$)|-p.*)/,
};
const CODEX_VALUE_OPTIONS = new Set([
	"--image",
	"-i",
	"--add-dir",
	"--enable",
	"--disable",
	"--sandbox",
	"-s",
	"--ask-for-approval",
	"-a",
]);
const CODEX_SWITCH_OPTIONS = new Set([
	"--search",
	"--no-alt-screen",
	"--strict-config",
	"--dangerously-bypass-approvals-and-sandbox",
	"--dangerously-bypass-hook-trust",
	"--approve-for-me",
	"--full-auto",
]);

/** Selectors are normalized before probing; a launch cannot silently change the probed login context. */
export function normalizeNativeProviderSelection(
	kind: string,
	rawArgs: readonly string[],
	requested: NativeProviderSelection = {},
): { selection: NativeProviderSelection; args: string[] } {
	if (kind !== "pi" && requested.provider !== undefined)
		throw new Error(
			"The apiProvider selector is supported only for native Pi; use the native provider's authenticated environment.",
		);
	const selection = { ...requested };
	const args: string[] = [];
	for (let index = 0; index < rawArgs.length; index++) {
		const argument = rawArgs[index]!;
		if (NONINTERACTIVE_OPTIONS[kind]?.test(argument))
			throw new Error("Native collaboration requires a persistent interactive CLI, not a headless invocation.");
		if (UNPROBED_AUTH_OPTIONS[kind]?.test(argument))
			throw new Error(
				"Native launch overrides an authentication context that its status probe cannot verify; configure the same environment or wrapper for both instead.",
			);
		const normalized =
			kind === "codex" && argument.startsWith("-m")
				? argument.length === 2
					? "--model"
					: `--model=${argument.slice(2).replace(/^=/, "")}`
				: argument;
		const selector = /^--(provider|model)(?:=(.*))?$/.exec(normalized);
		if (!selector) {
			args.push(argument);
			continue;
		}
		const key = selector[1] as "provider" | "model";
		if (kind !== "pi" && key === "provider")
			throw new Error("The provider selector is supported only for native Pi.");
		const value = selector[2] ?? rawArgs[++index];
		if (!value || value.startsWith("-") || value.length > 512 || /[\r\n\0]/.test(value))
			throw new Error("Native provider/model selection is missing or malformed.");
		if (selection[key] !== undefined && selection[key] !== value)
			throw new Error("Native provider/model selection conflicts with its authenticated launch identity.");
		selection[key] = value;
	}
	if (kind === "codex") {
		for (let index = 0; index < args.length; index++) {
			const argument = args[index]!;
			if (argument === "--") break;
			const option = argument.split("=", 1)[0]!;
			if (CODEX_VALUE_OPTIONS.has(option)) {
				if (!argument.includes("=") && !args[++index]) throw new Error("Native Codex option is missing its value.");
				continue;
			}
			if (CODEX_SWITCH_OPTIONS.has(argument)) continue;
			if (argument.startsWith("-"))
				throw new Error("Native Codex option is not supported by the interactive launch validator.");
			if (/^(?:exec|e|review|mcp-server|app-server)$/.test(argument))
				throw new Error("Native collaboration requires a persistent interactive CLI, not a headless invocation.");
			break;
		}
	}
	if (kind !== "pi" && selection.model) args.push("--model", selection.model);
	return { selection, args };
}
