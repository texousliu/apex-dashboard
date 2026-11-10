/**
 * Prefix / suffix templates for newly added tasks (todo card → gear → "New
 * task prefix / suffix").
 *
 * A pure function rather than inline code in `sync.addTask`, so the rules that
 * are easy to get subtly wrong — which placeholder wins, how the pieces are
 * joined, what a template without {{text}} means — can be pinned by a verify
 * script without a vault or a render.
 *
 * The templates are stored per card in the dashboard file (`taskPrefix:` /
 * `taskSuffix:` metadata lines) and applied at the one place tasks are created,
 * so the card DOM, the daily-note mirror and the raw markdown all carry the
 * same decorated text.
 */

/** The token both templates use to say "the task text goes here". */
export const TASK_TEXT_TOKEN = '{{text}}';

/** Placeholder names both templates understand, in the order the settings
 *  dialog documents them. `text` is listed first because it is the only one
 *  that moves the body around (see {@link applyTaskAffixes}). */
export const TASK_AFFIX_PLACEHOLDERS = ['text', 'date', 'time', 'title'] as const;

export type TaskAffixPlaceholder = typeof TASK_AFFIX_PLACEHOLDERS[number];

export interface TaskAffixConfig {
	/** Template placed before the task text. */
	prefix?: string;
	/** Template appended after the task text. */
	suffix?: string;
	/** Card title, for `{{title}}`. */
	title?: string;
}

function pad2(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

/** Local `YYYY-MM-DD`. Deliberately local, not UTC: a task added at 23:30
 *  belongs to the day the user is living in. */
export function affixDate(now: Date): string {
	return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** Local `HH:mm`. */
export function affixTime(now: Date): string {
	return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

/** Replace every known placeholder in one template. Unknown `{{...}}` sequences
 *  are left alone — a user typing `{{foo}}` gets it back verbatim rather than a
 *  silently deleted fragment. */
function fillTemplate(template: string, values: Record<TaskAffixPlaceholder, string>): string {
	let out = template;
	for (const name of TASK_AFFIX_PLACEHOLDERS) {
		out = out.split(`{{${name}}}`).join(values[name]);
	}
	return out;
}

/**
 * Decorate a task about to be stored.
 *
 * - Both templates are trimmed; an all-empty config returns the text untouched.
 * - `{{text}}` decides the body's position: whichever template carries it owns
 *   the text, and the other one is rendered without it. When neither does, the
 *   text sits between the two — the common `#tag` + `@{{date}}` case.
 * - Pieces are joined with a single space, so `#todo` yields `#todo Buy milk`
 *   without the user having to guess how many trailing spaces to type. To glue
 *   something on tightly, put `{{text}}` in the template (`@{{text}}`).
 */
export function applyTaskAffixes(
	text: string,
	config: TaskAffixConfig | undefined,
	now: Date,
): string {
	const base = text.trim();
	if (!base || !config) return base;

	const prefix = (config.prefix ?? '').trim();
	const suffix = (config.suffix ?? '').trim();
	if (!prefix && !suffix) return base;

	const values: Record<TaskAffixPlaceholder, string> = {
		text: base,
		date: affixDate(now),
		time: affixTime(now),
		title: config.title ?? '',
	};

	// The prefix wins when both templates claim {{text}}: the body can only
	// appear once, and the leading position reads more naturally.
	const prefixOwnsText = prefix.includes(TASK_TEXT_TOKEN);
	const suffixOwnsText = !prefixOwnsText && suffix.includes(TASK_TEXT_TOKEN);

	const head = prefix
		? fillTemplate(prefix, { ...values, text: prefixOwnsText ? base : '' }).trim()
		: '';
	const tail = suffix
		? fillTemplate(suffix, { ...values, text: suffixOwnsText ? base : '' }).trim()
		: '';
	const middle = prefixOwnsText || suffixOwnsText ? '' : base;

	return [head, middle, tail].filter(part => part.length > 0).join(' ');
}
