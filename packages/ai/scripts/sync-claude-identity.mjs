import { installedCliVersion, writeClientIdentity } from "./sync-client-identity-core.mjs";

const [executableArg, outputArg, ...extra] = process.argv.slice(2);
if (extra.length > 0) throw new Error("Usage: node scripts/sync-claude-identity.mjs [claude-executable] [output-file]");
const version = installedCliVersion("claude", executableArg, /^(\d+\.\d+\.\d+) \(Claude Code\)$/, "Claude");
writeClientIdentity(
	outputArg,
	new URL("../src/providers/anthropic-client-config.generated.ts", import.meta.url),
	"ANTHROPIC_CLIENT_CONFIG",
	{
		version,
		messagesUserAgent: `claude-cli/${version} (external, cli)`,
		usageUserAgent: `claude-code/${version}`,
	},
	"Claude",
);
