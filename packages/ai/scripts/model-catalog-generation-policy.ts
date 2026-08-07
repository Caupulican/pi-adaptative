import { existsSync } from "fs";
import { basename } from "path";

interface ModelCatalogGenerationOptions {
	catalogPath: string;
	skipFetch: string | undefined;
	generate: () => Promise<void>;
	pathExists?: (path: string) => boolean;
	log?: (message: string) => void;
}

export async function runModelCatalogGeneration(
	options: ModelCatalogGenerationOptions,
): Promise<"generated" | "retained"> {
	if (options.skipFetch !== "1") {
		await options.generate();
		return "generated";
	}

	const pathExists = options.pathExists ?? existsSync;
	if (!pathExists(options.catalogPath)) {
		throw new Error(
			`PI_SKIP_MODEL_FETCH=1 requires an existing committed model catalog at ${options.catalogPath}; refusing to fetch live data`,
		);
	}

	const log = options.log ?? console.log;
	log(`PI_SKIP_MODEL_FETCH=1 - keeping committed ${basename(options.catalogPath)} (no live fetch)`);
	return "retained";
}
