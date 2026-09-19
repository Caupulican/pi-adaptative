export interface ChoiceParamDef {
	readonly kind: "choice";
	readonly options: readonly string[];
	readonly descriptions?: Record<string, string>;
	readonly notFor?: Record<string, string>;
	readonly defaultValue?: string;
	readonly optional?: boolean;
}

export interface BooleanParamDef {
	readonly kind: "boolean";
	readonly description?: string;
	readonly defaultValue?: boolean;
	readonly optional?: boolean;
}

export type SemanticParamDef = ChoiceParamDef | BooleanParamDef;

export interface SemanticFunctionDef {
	readonly description?: string;
	readonly parameters: Record<string, SemanticParamDef>;
}

export type SemanticFunctionRegistry = Record<string, SemanticFunctionDef>;

export function choice(
	options: readonly string[],
	descriptions?: Record<string, string>,
	notFor?: Record<string, string>,
): ChoiceParamDef {
	return {
		kind: "choice",
		options,
		descriptions,
		notFor,
		optional: false,
	};
}

export function optionalChoice(
	options: readonly string[],
	defaultValue: string,
	descriptions?: Record<string, string>,
	notFor?: Record<string, string>,
): ChoiceParamDef {
	return {
		kind: "choice",
		options,
		descriptions,
		notFor,
		defaultValue,
		optional: true,
	};
}

export function booleanParam(description?: string, defaultValue?: boolean): BooleanParamDef {
	return {
		kind: "boolean",
		description,
		defaultValue,
		optional: defaultValue !== undefined,
	};
}

export function defineSemanticFunctions<T extends SemanticFunctionRegistry>(functions: T): T {
	return functions;
}
