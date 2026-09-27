// The Anthropic API rejects a request whose tool input_schema is not valid
// under the JSON Schema draft 2020-12 meta-schema ("tools.N.custom.input_schema:
// JSON schema is invalid. It must match JSON Schema draft 2020-12"), and Claude
// Code 2.1.283 forwards an MCP tool's schema as-is, so one such tool fails every
// request of the session (measured with a draft-04 boolean `exclusiveMinimum`
// and a draft-07 tuple `items: [...]`). This checks a schema against the
// meta-schema's keyword shapes. The meta-schema allows any other keyword and
// does not assert formats, so only the value of each keyword it defines is
// checked here, and subschemas are checked where it expects a schema.

type Check = (value: unknown) => boolean;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): boolean => typeof value === "boolean";
const isNumber = (value: unknown): value is number => typeof value === "number";
const isNonNegativeInteger = (value: unknown): boolean => isNumber(value) && Number.isInteger(value) && value >= 0;
const isUniqueStringArray = (value: unknown): boolean =>
	Array.isArray(value) && value.every(isString) && new Set(value).size === value.length;
const SIMPLE_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
const isSimpleType = (value: unknown): boolean => isString(value) && SIMPLE_TYPES.has(value);
const ANCHOR = /^[A-Za-z_][-A-Za-z0-9._]*$/;
const isAnchor = (value: unknown): boolean => isString(value) && ANCHOR.test(value);
const schemaMap: Check = (value) => isObject(value) && Object.values(value).every(isDraft2020Schema);
const schemaArray: Check = (value) => Array.isArray(value) && value.length > 0 && value.every(isDraft2020Schema);
const schema: Check = (value) => isDraft2020Schema(value);

// Keyword -> what the 2020-12 meta-schema (schema.json and meta/*.json)
// requires of its value.
const KEYWORDS: Record<string, Check> = {
	// core
	$id: (value) => isString(value) && /^[^#]*#?$/.test(value),
	$schema: isString,
	$ref: isString,
	$anchor: isAnchor,
	$dynamicRef: isString,
	$dynamicAnchor: isAnchor,
	$vocabulary: (value) => isObject(value) && Object.values(value).every(isBoolean),
	$comment: isString,
	$defs: schemaMap,
	// applicator
	prefixItems: schemaArray,
	items: schema,
	contains: schema,
	additionalProperties: schema,
	properties: schemaMap,
	patternProperties: schemaMap,
	dependentSchemas: schemaMap,
	propertyNames: schema,
	if: schema,
	then: schema,
	else: schema,
	allOf: schemaArray,
	anyOf: schemaArray,
	oneOf: schemaArray,
	not: schema,
	// unevaluated
	unevaluatedItems: schema,
	unevaluatedProperties: schema,
	// validation
	type: (value) => isSimpleType(value)
		|| (Array.isArray(value) && value.length > 0 && value.every(isSimpleType) && new Set(value).size === value.length),
	enum: Array.isArray,
	multipleOf: (value) => isNumber(value) && value > 0,
	maximum: isNumber,
	exclusiveMaximum: isNumber,
	minimum: isNumber,
	exclusiveMinimum: isNumber,
	maxLength: isNonNegativeInteger,
	minLength: isNonNegativeInteger,
	pattern: isString,
	maxItems: isNonNegativeInteger,
	minItems: isNonNegativeInteger,
	uniqueItems: isBoolean,
	maxContains: isNonNegativeInteger,
	minContains: isNonNegativeInteger,
	maxProperties: isNonNegativeInteger,
	minProperties: isNonNegativeInteger,
	required: isUniqueStringArray,
	dependentRequired: (value) => isObject(value) && Object.values(value).every(isUniqueStringArray),
	// meta-data, format-annotation, content
	title: isString,
	description: isString,
	deprecated: isBoolean,
	readOnly: isBoolean,
	writeOnly: isBoolean,
	examples: Array.isArray,
	format: isString,
	contentEncoding: isString,
	contentMediaType: isString,
	contentSchema: schema,
	// earlier drafts' keywords the 2020-12 meta-schema still defines
	definitions: schemaMap,
	dependencies: (value) => isObject(value) && Object.values(value).every((entry) => isDraft2020Schema(entry) || isUniqueStringArray(entry)),
	$recursiveAnchor: isAnchor,
	$recursiveRef: isString,
};

/** Whether `value` is a valid JSON Schema under the draft 2020-12 meta-schema
 *  (format assertions aside). */
export function isDraft2020Schema(value: unknown): boolean {
	if (typeof value === "boolean") return true;
	if (!isObject(value)) return false;
	for (const [keyword, keywordValue] of Object.entries(value)) {
		const check = Object.hasOwn(KEYWORDS, keyword) ? KEYWORDS[keyword] : undefined;
		if (check && !check(keywordValue)) return false;
	}
	return true;
}
