import { writeClientIdentity } from "./sync-client-identity-core.mjs";
import { AnthropicCompatibilityResolver } from "../src/providers/anthropic-identity.ts";
import { ClaudeInstallationInspector } from "../src/providers/claude-installation.ts";

const [executableArg, outputArg, ...extra] = process.argv.slice(2);
if (extra.length > 0) throw new Error("Usage: node scripts/sync-claude-identity.mjs [claude-executable] [output-file]");
const resolver = new AnthropicCompatibilityResolver(new ClaudeInstallationInspector());
const compatibility = await resolver.resolve("identity-sync", executableArg);
if (compatibility.source !== "installed") {
	throw new Error(compatibility.warning ?? "No reviewed Claude installation found; identity config was not changed");
}
writeClientIdentity(
	outputArg,
	new URL("../src/providers/anthropic-client-config.generated.ts", import.meta.url),
	"ANTHROPIC_CLIENT_CONFIG",
	compatibility.identity,
	"Claude",
);
