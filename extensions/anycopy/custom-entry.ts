const PREVIEW_LABELS: Record<string, string> = {
	capturedAt: "Captured at",
	promptKind: "Prompt kind",
	chars: "Characters",
	sha256: "SHA-256",
	contextFiles: "Context files",
	entryType: "Entry type",
};

const ARRAY_ITEM_IDENTITY_KEYS = ["path", "name", "title", "id", "type"];

const humanizeKey = (key: string): string => {
	const known = PREVIEW_LABELS[key];
	if (known) return known;
	const words = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
};

const formatLocalDate = (date: Date): string =>
	new Intl.DateTimeFormat("en-GB", {
		day: "2-digit",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		timeZoneName: "short",
	}).format(date);

const formatScalar = (key: string, value: unknown): string => {
	if (typeof value === "number") {
		if (key.endsWith("At") && Number.isFinite(value)) {
			const date = new Date(value);
			if (!Number.isNaN(date.getTime())) return formatLocalDate(date);
		}
		return /chars?|count|size/i.test(key) ? value.toLocaleString("en-US") : String(value);
	}
	if (typeof value === "boolean") return value ? "true" : "false";
	if (value === null) return "null";
	return String(value);
};

const formatLabel = (label: string, markdown: boolean, suffix = "", colon = true): string =>
	markdown ? `**${label}${suffix}${colon ? ":" : ""}**` : `${label}${suffix}${colon ? ":" : ""}`;

const renderValue = (value: unknown, depth: number, markdown: boolean, key = "value"): string[] => {
	const indent = "  ".repeat(depth);
	if (Array.isArray(value)) {
		if (value.length === 0) return [`${indent}${markdown ? "_(empty)_" : "(empty)"}`];
		return value.flatMap((item, index) => {
			if (typeof item !== "object" || item === null) {
				return [`${indent}${index + 1}. ${formatScalar(key, item)}`];
			}
			const record = item as Record<string, unknown>;
			const identityKey = ARRAY_ITEM_IDENTITY_KEYS.find((candidate) => {
				const identity = record[candidate];
				return typeof identity === "string" || typeof identity === "number";
			});
			if (!identityKey) return [`${indent}${index + 1}.`, ...renderValue(record, depth + 1, markdown)];
			const identity = formatScalar(identityKey, record[identityKey]);
			const remainder = Object.fromEntries(Object.entries(record).filter(([childKey]) => childKey !== identityKey));
			const remainderLines = Object.keys(remainder).length > 0 ? renderValue(remainder, depth + 1, markdown) : [];
			return [`${indent}${index + 1}. ${identity}`, ...remainderLines];
		});
	}
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) return [`${indent}${markdown ? "_(empty)_" : "(empty)"}`];
		return entries.flatMap(([childKey, childValue]) => {
			const label = humanizeKey(childKey);
			if (typeof childValue === "object" && childValue !== null) {
				const suffix = Array.isArray(childValue) ? ` (${childValue.length})` : "";
				return [
					`${indent}${formatLabel(label, markdown, suffix, false)}`,
					...renderValue(childValue, depth + 1, markdown, childKey),
				];
			}
			return [`${indent}${formatLabel(label, markdown)} ${formatScalar(childKey, childValue)}`];
		});
	}
	return [`${indent}${formatScalar(key, value)}`];
};

const formatCustomEntry = (customType: string, data: unknown, markdown: boolean): string => {
	const header = markdown ? `**Custom entry:** \`${customType}\`` : `Custom entry: ${customType}`;
	if (data === undefined) return header;
	return [header, "", ...renderValue(data, 0, markdown)].join("\n");
};

export const formatCustomEntryContent = (customType: string, data: unknown): string =>
	formatCustomEntry(customType, data, false);

export const formatCustomEntryPreview = (customType: string, data: unknown): string =>
	formatCustomEntry(customType, data, true);
