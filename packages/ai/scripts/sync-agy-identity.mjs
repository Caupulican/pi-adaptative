import { installedCliVersion, writeClientIdentity } from "./sync-client-identity-core.mjs";

const [executableArg, outputArg, ...extra] = process.argv.slice(2);
if (extra.length > 0) throw new Error("Usage: node scripts/sync-agy-identity.mjs [agy-executable] [output-file]");
const version = installedCliVersion("agy", executableArg, /^(\d+\.\d+\.\d+)$/, "AGY");
writeClientIdentity(
	outputArg,
	new URL("../src/providers/antigravity-client-config.generated.ts", import.meta.url),
	"ANTIGRAVITY_CLIENT_CONFIG",
	{ version, userAgentPrefix: `antigravity/cli/${version}` },
	"AGY",
);
