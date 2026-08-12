import type { TLocalizedValidationError } from "typebox/error";

/** Format a TypeBox validation location consistently across package boundaries. */
export function formatValidationPath(error: TLocalizedValidationError): string {
	const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	if (error.keyword === "additionalProperties") {
		const params = error.params as { additionalProperty?: string; additionalProperties?: string[] };
		const additionalProperty = params.additionalProperty ?? params.additionalProperties?.[0];
		if (additionalProperty) {
			return basePath ? `${basePath}.${additionalProperty}` : additionalProperty;
		}
	}
	return basePath || "root";
}
