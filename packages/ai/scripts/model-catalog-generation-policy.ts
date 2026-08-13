import { existsSync } from "fs";
import { basename } from "path";

interface ModelCatalogGenerationOptions {
	catalogPath: string;
	/** Set to "1" to explicitly opt into a live fetch; any other value keeps the build hermetic. */
	fetchRequested: string | undefined;
	generate: () => Promise<void>;
	pathExists?: (path: string) => boolean;
	log?: (message: string) => void;
}

/**
 * Hermetic-by-default model catalog generation: a plain build never touches the network and
 * never dirties the committed catalog. Live fetching only happens when explicitly requested via
 * PI_FETCH_MODELS=1, which is reserved for an intentional refresh (a human/CI job reviewing and
 * committing the resulting diff), never a side effect of `npm run build`.
 */
export async function runModelCatalogGeneration(
	options: ModelCatalogGenerationOptions,
): Promise<"generated" | "retained"> {
	if (options.fetchRequested === "1") {
		await options.generate();
		return "generated";
	}

	const pathExists = options.pathExists ?? existsSync;
	if (!pathExists(options.catalogPath)) {
		throw new Error(
			`No committed model catalog at ${options.catalogPath} and PI_FETCH_MODELS=1 was not set; refusing to fetch live data implicitly. Run with PI_FETCH_MODELS=1 to generate one.`,
		);
	}

	const log = options.log ?? console.log;
	log(`Hermetic build - keeping committed ${basename(options.catalogPath)} (set PI_FETCH_MODELS=1 to refresh from live data)`);
	return "retained";
}
