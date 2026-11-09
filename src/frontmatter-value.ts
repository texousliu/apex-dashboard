/**
 * Render a frontmatter value as display/search text.
 *
 * YAML frontmatter fields arrive as strings, numbers, booleans, null, arrays
 * (or objects, when the user wrote a nested block). The model layers used to
 * call String(value) directly, which stamped "[object Object]" into chips,
 * stage keys and sorts whenever a field held an object — the no-base-to-string
 * lint errors that flagged all of those sites.
 *
 * Semantics: strings pass through; numbers/booleans/bigints stringify;
 * arrays join with "," (String's own behavior for YAML lists — a
 * `platform: [小红书, B站]` still reads as "小红书,B站"); null/undefined and
 * objects render empty.
 */
export function fmString(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
	if (Array.isArray(value)) return value.map(v => fmString(v)).join(',');
	return '';
}
