/**
 * Refreshes the Command Code section of the model catalog (src/models.generated.ts) from the service's live
 * catalogue, leaving every other provider's section as committed. The daily catalog refresh does the same for
 * every provider; this is the by-hand run for this one.
 *
 *   npm run sync:command-code-models        (in packages/ai)
 *
 * Review the diff and commit it like any other change.
 */

process.env.PI_FETCH_MODELS = "1";
process.env.PI_MODEL_CATALOG_PROVIDER = "command-code";
await import("./generate-models.ts");
