export * from "./bedrock-scope.ts";

import { streamBedrock, streamSimpleBedrock } from "./providers/amazon-bedrock.ts";

export const bedrockProviderModule = {
	streamBedrock,
	streamSimpleBedrock,
};
