import { fileURLToPath } from "node:url";

const aiPackagePattern = "@(?:caupulican/pi-ai|earendil-works/pi-ai|mariozechner/pi-ai)";
const aiSrc = (path: string): string => fileURLToPath(new URL(`../ai/src/${path}`, import.meta.url));

const subpaths = {
	"api-registry": aiSrc("api-registry.ts"),
	"abort-signals": aiSrc("utils/abort-signals.ts"),
	"event-stream": aiSrc("utils/event-stream.ts"),
	"env-api-keys": aiSrc("env-api-keys.ts"),
	faux: aiSrc("providers/faux.ts"),
	"json-parse": aiSrc("utils/json-parse.ts"),
	models: aiSrc("models.ts"),
	oauth: aiSrc("oauth.ts"),
	overflow: aiSrc("utils/overflow.ts"),
	"provider-retry": aiSrc("utils/provider-retry.ts"),
	"register-builtins": aiSrc("providers/register-builtins.ts"),
	stream: aiSrc("stream.ts"),
	"session-resources": aiSrc("session-resources.ts"),
	"streaming-lines": aiSrc("utils/streaming-lines.ts"),
	"text-tool-protocol": aiSrc("utils/tool-repair/text-protocol.ts"),
	"tool-repair-registry": aiSrc("utils/tool-repair/registry.ts"),
	"typebox-helpers": aiSrc("utils/typebox-helpers.ts"),
	types: aiSrc("types.ts"),
	usage: aiSrc("usage.ts"),
	validation: aiSrc("utils/validation.ts"),
	"validation-path": aiSrc("utils/validation-path.ts"),
	uuid: aiSrc("utils/uuid.ts"),
} as const;

export const piAiSourceAliases = [
	...Object.entries(subpaths).map(([subpath, replacement]) => ({
		find: new RegExp(`^${aiPackagePattern}/${subpath}$`),
		replacement,
	})),
	{ find: new RegExp(`^${aiPackagePattern}$`), replacement: aiSrc("index.ts") },
];
