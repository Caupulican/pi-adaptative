import { installedCliVersion, writeClientIdentity } from "./sync-client-identity-core.mjs";

const [executableArg, outputArg, ...extra] = process.argv.slice(2);
if (extra.length > 0) throw new Error("Usage: node scripts/sync-grok-identity.mjs [grok-executable] [output-file]");
const version = await installedCliVersion(
	"grok",
	executableArg,
	/^grok (\d+\.\d+\.\d+) \([0-9a-f]+\)(?: \[(?:stable|alpha)\])?$/,
	"Grok",
);
writeClientIdentity(
	outputArg,
	new URL("../src/providers/xai-client-config.generated.ts", import.meta.url),
	"XAI_CLIENT_CONFIG",
	{ version },
	"Grok",
);
