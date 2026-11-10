/**
 * Static hygiene checks over `src/` — the things a type-checker cannot see.
 *
 * 1. **No stray control bytes.** `reading-service.ts` carried a literal NUL
 *    byte as a key separator. TypeScript was happy, but `grep` and `git diff`
 *    classified the whole file as binary and silently skipped it, so any
 *    search over `src/` quietly missed that file. It is `'\u0000'` (an escape
 *    sequence) now — same runtime value, no reason for tooling to give up.
 * 2. **Every `t('key')` resolves.** The lookup falls back
 *    `translations[lang][key] ?? translations.en[key] ?? key`, so a typo does
 *    not throw — it renders the key itself in the UI. Three such keys shipped
 *    (`folder.libraryAll`, `media.deleteFailed`, `pomodoro.tagMergeHint`).
 * 3. **Dynamic keys resolve too.** `t('widget.size' + size)` is checked by
 *    prefix: at least one key must start with the literal.
 * 4. **Every language carries the same key set.** A missing string in one
 *    locale silently falls back to English; that is the right runtime
 *    behaviour but it should be a decision, not an accident.
 *
 * Run: `npm run test:source-hygiene`
 */
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'src';

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (name.endsWith('.ts')) out.push(full.split('\\').join('/'));
	}
	return out;
}

const files = walk(SRC);
assert.ok(files.length > 100, `1: walked the source tree (${files.length} files)`);

{
	// 1. Control bytes. Tab / LF / CR are the only legal ones.
	const bad: string[] = [];
	for (const file of files) {
		const buf = readFileSync(file);
		for (let i = 0; i < buf.length; i++) {
			const b = buf[i]!;
			if (b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13)) {
				bad.push(`${file}: byte ${b} at offset ${i}`);
			}
		}
	}
	assert.deepEqual(bad, [], '1: no NUL or stray control bytes in src/');
}

/** Keys declared at the start of a line — values never start a line, so this
 *  cannot pick up a `': '` inside a translated sentence. */
function dictKeys(text: string): Set<string> {
	const keys = new Set<string>();
	for (const line of text.split(/\r?\n/)) {
		const m = /^\s*(?:'([^']+)'|"([^"]+)")\s*:/.exec(line);
		if (m) keys.add((m[1] ?? m[2])!);
	}
	return keys;
}

const i18nLines = readFileSync('src/i18n.ts', 'utf8').split(/\r?\n/);
const dictStarts: Array<{ name: string; at: number }> = [];
i18nLines.forEach((line, i) => {
	const m = /^\t(en|zh|'zh-TW')\s*:\s*\{/.exec(line);
	if (m) dictStarts.push({ name: m[1]!.replace(/'/g, ''), at: i });
});
assert.equal(dictStarts.length, 3, '2: i18n.ts still declares en / zh / zh-TW');

const dicts = new Map<string, Set<string>>();
dictStarts.forEach((d, i) => {
	const end = i + 1 < dictStarts.length ? dictStarts[i + 1]!.at : i18nLines.length;
	dicts.set(d.name, dictKeys(i18nLines.slice(d.at, end).join('\n')));
});

const en = dicts.get('en')!;
assert.ok(en.size > 2000, `2: en dictionary parsed (${en.size} keys)`);

{
	// 2 + 3. Every call site resolves against the union of all dictionaries,
	//        which is what the runtime falls back through.
	const allKeys = new Set<string>();
	for (const set of dicts.values()) for (const key of set) allKeys.add(key);

	const missing: string[] = [];
	const badPrefix: string[] = [];
	for (const file of files) {
		if (file === 'src/i18n.ts') continue;
		const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
		for (const m of code.matchAll(/\bt\(\s*(?:'([^']+)'|"([^"]+)")\s*(\+)?/g)) {
			const literal = (m[1] ?? m[2])!;
			if (m[3]) {
				if (![...allKeys].some((k) => k.startsWith(literal))) {
					badPrefix.push(`${literal} + … (${file})`);
				}
			} else if (!allKeys.has(literal)) {
				missing.push(`${literal} (${file})`);
			}
		}
	}
	assert.deepEqual(missing, [], '2: every t() literal exists in the dictionaries');
	assert.deepEqual(badPrefix, [], '3: every dynamic t() prefix matches at least one key');
}

{
	// 4. Language parity. zh / zh-TW are inline; the rest are src/locales/<lang>.
	for (const name of ['zh', 'zh-TW']) {
		const keys = dicts.get(name)!;
		const absent = [...en].filter((k) => !keys.has(k));
		assert.deepEqual(absent, [], `4: ${name} carries every en key`);
	}

	const langs = readdirSync('src/locales').filter((n) => statSync(join('src/locales', n)).isDirectory());
	assert.equal(langs.length, 8, `4: eight locale directories (${langs.join(', ')})`);
	for (const lang of langs) {
		const dir = join('src/locales', lang);
		const keys = new Set<string>();
		for (const part of readdirSync(dir)) {
			if (!part.endsWith('.ts')) continue;
			for (const k of dictKeys(readFileSync(join(dir, part), 'utf8'))) keys.add(k);
		}
		const absent = [...en].filter((k) => !keys.has(k));
		assert.deepEqual(absent, [], `4: ${lang} carries every en key`);
	}
}

{
	// 5. Banned patterns, scanned across the WHOLE tree. A file-local assertion
	//    would go silently vacuous the moment the code moved, so the check is
	//    written to survive relocation.
	const banned: Array<[RegExp, string]> = [
		// 0 is a real coordinate (equator, prime meridian); `||` silently
		// replaced it with the Shanghai default.
		[/widgetWeather(?:Lat|Lon)\s*\|\|/, 'weather coordinates must use `??`, not `||`'],
	];
	const hits: string[] = [];
	for (const file of files) {
		const text = readFileSync(file, 'utf8');
		for (const [re, why] of banned) if (re.test(text)) hits.push(`${file}: ${why}`);
	}
	assert.deepEqual(hits, [], '5: no banned patterns in src/');
}

console.log('verify-source-hygiene: ok');
