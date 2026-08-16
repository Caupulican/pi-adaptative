const browserInertCredentialImports = new Map([
	["core/credentials.mjs", new Set(["node:fs", "node:path"])],
	["lib/credentials/credential-chain.mjs", new Set(["node:fs"])],
	["lib/credentials/identity-token.mjs", new Set(["node:fs"])],
	["lib/credentials/types.mjs", new Set(["node:fs", "node:path"])],
	["lib/credentials/user-oauth.mjs", new Set(["node:fs"])],
]);

const browserCredentialNamespace = "browser-inert-anthropic-credentials";

export function isBrowserInertAnthropicCredentialImport({ kind, path, importer }) {
	if (kind !== "dynamic-import") return false;

	const normalizedImporter = importer.replaceAll("\\", "/");
	const sdkPathMarker = "/node_modules/@anthropic-ai/sdk/";
	const sdkPathIndex = normalizedImporter.lastIndexOf(sdkPathMarker);
	if (sdkPathIndex === -1) return false;

	const sdkRelativePath = normalizedImporter.slice(sdkPathIndex + sdkPathMarker.length);
	return browserInertCredentialImports.get(sdkRelativePath)?.has(path) === true;
}

export const browserSmokeNodeImportPolicy = {
	name: "browser-smoke-node-import-policy",
	setup(build) {
		build.onResolve({ filter: /^node:/ }, (args) => {
			if (!isBrowserInertAnthropicCredentialImport(args)) return undefined;
			return { path: args.path, namespace: browserCredentialNamespace };
		});

		build.onLoad({ filter: /.*/, namespace: browserCredentialNamespace }, () => ({
			contents: "export {};",
			loader: "js",
		}));
	},
};
