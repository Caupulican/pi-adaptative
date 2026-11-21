import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { type AgentSessionServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";

it.each(["explicit", "discovered", "disabled", "profile-denied"] as const)(
	"keeps %s extension commands and startup providers under the same authority",
	async (mode) => {
		const root = mkdtempSync(join(tmpdir(), "pi-extension-cli-authority-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const extensionPath = join(agentDir, "extensions", "startup-provider.js");
		mkdirSync(cwd);
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(
			extensionPath,
			`export default function (pi) {
 pi.registerCommand('startup-witness', {description:'Startup witness', handler:async()=>{}});
 pi.registerProvider('extension-cli-authority-fixture', {
  baseUrl:'https://zero-io.invalid',apiKey:'fixture',api:'extension-cli-authority-api',
  models:[{id:'witness',name:'Witness',reasoning:false,input:['text'],contextWindow:32000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
  streamSimple(){throw new Error('Startup must not invoke inference');}
 });
}`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				...(mode === "disabled" ? { disabledResources: { extensions: ["*"] } } : {}),
				...(mode === "profile-denied"
					? {
							activeResourceProfiles: ["deny-extensions"],
							resourceProfiles: { "deny-extensions": { extensions: { block: ["*"] } } },
						}
					: {}),
			}),
		);
		let services: AgentSessionServices | undefined;
		try {
			services = await createAgentSessionServices({
				cwd,
				agentDir,
				resourceLoaderOptions: { additionalExtensionPaths: mode === "discovered" ? [] : [extensionPath] },
			});
			const extension = services.resourceLoader
				.getExtensions()
				.extensions.find((extension) => extension.resolvedPath === extensionPath);
			const model = services.modelRegistry.find("extension-cli-authority-fixture", "witness");
			if (mode === "explicit") {
				expect(extension?.sourceInfo.source).toBe("cli");
				expect(extension?.commands.has("startup-witness")).toBe(true);
				expect(model?.provider).toBe("extension-cli-authority-fixture");
			} else {
				expect(extension).toBeUndefined();
				expect(model).toBeUndefined();
			}
		} finally {
			services?.modelRegistry.unregisterProvider("extension-cli-authority-fixture");
			await services?.resourceLoader.dispose?.();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
