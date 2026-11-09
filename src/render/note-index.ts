/**
 * Vault note resolution: a cached basename → TFile index plus the shared
 * `resolveNoteFile` used by both the doc list and inline wikilinks.
 *
 * Moved verbatim out of renderer.ts (Phase 4, "只搬不改"): the index is
 * cross-module state — link rendering, doc rows and search all read it — and
 * had to become its own module before the wikilink renderers could leave
 * renderer.ts without dragging the whole cache along.
 */
import { App, TFile } from 'obsidian';
import type { EventRef } from 'obsidian';
import { SUPPORTED_FILE_EXTS } from '../file-types';

const VAULT_FILE_EXTS = SUPPORTED_FILE_EXTS;

export function getSearchableFiles(app: App) {
	return app.vault.getFiles()
		.filter(f => !f.path.startsWith('.') && VAULT_FILE_EXTS.has(f.extension));
}

/**
 * Cached basename → TFile index for the wikilink/doc basename fallback in
 * {@link resolveNoteFile}. Building it scans the whole vault, so doing that per
 * wikilink (the old behavior) was O(wikilinks × vaultSize) per render — the
 * dominant cost on large vaults. We build it once lazily and keep it in sync
 * via vault create/delete/rename events (registered once per app).
 *
 * `null` = not built yet; the Map is keyed by basename and holds the first
 * matching file (wikilinks resolve to one target anyway).
 */
let basenameIndex: Map<string, TFile> | null = null;
let basenameIndexApp: App | null = null;
const basenameEventRefs: EventRef[] = [];

function indexFile(file: TFile): void {
	if (file.path.startsWith('.') || !VAULT_FILE_EXTS.has(file.extension)) return;
	const idx = basenameIndex;
	if (idx && !idx.has(file.basename)) idx.set(file.basename, file);
}

function unindexFile(file: TFile): void {
	const idx = basenameIndex;
	if (!idx) return;
	// Only clear if this file is the one indexed; a same-named other may own it.
	if (idx.get(file.basename) === file) {
		idx.delete(file.basename);
	}
}

function ensureBasenameIndex(app: App): Map<string, TFile> {
	if (basenameIndex && basenameIndexApp === app) return basenameIndex;
	const idx = new Map<string, TFile>();
	for (const f of app.vault.getFiles()) {
		if (!f.path.startsWith('.') && VAULT_FILE_EXTS.has(f.extension) && !idx.has(f.basename)) {
			idx.set(f.basename, f);
		}
	}
	basenameIndex = idx;
	basenameIndexApp = app;
	// Register invalidation hooks exactly once per app; store refs so the plugin
	// can detach them on unload (matches the sync.ts EventRef pattern).
	basenameEventRefs.push(app.vault.on('create', indexFile));
	basenameEventRefs.push(app.vault.on('delete', unindexFile));
	basenameEventRefs.push(app.vault.on('rename', (file, oldPath) => {
		// Rename keeps the TFile identity but Obsidian has already updated
		// file.basename/path to the NEW values by the time this fires. Drop the
		// old key (derived from oldPath) if this file owned it, then re-index.
		const oldBasename = oldPath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
		if (basenameIndex?.get(oldBasename) === file) basenameIndex?.delete(oldBasename);
		if (file instanceof TFile) indexFile(file);
	}));
	return idx;
}

/**
 * Detach the basename index's vault listeners and drop the cache. Called from
 * plugin onunload to avoid leaking handlers across hot reloads.
 */
export function teardownBasenameIndex(app: App): void {
	for (const ref of basenameEventRefs) app.vault.offref(ref);
	basenameEventRefs.length = 0;
	basenameIndex = null;
	basenameIndexApp = null;
}

/**
 * Resolve a raw doc/wikilink target to a TFile, trying the path verbatim, with
 * an implicit `.md`, and finally a cached basename lookup. Centralised so the
 * doc list and inline wikilinks resolve links identically.
 */
export function resolveNoteFile(app: App, rawPath: string): TFile | null {
	const direct = app.vault.getFileByPath(rawPath);
	if (direct) return direct;
	const withMd = rawPath.includes('.') ? rawPath : `${rawPath}.md`;
	const tried = app.vault.getFileByPath(withMd);
	if (tried) return tried;
	const basename = rawPath.split('/').pop()?.replace(/\.md$/, '') ?? '';
	if (basename) {
		return ensureBasenameIndex(app).get(basename) ?? null;
	}
	return null;
}
