/**
 * Ambient link-rendering context for one render pass.
 *
 * Set once per render pass by `renderDashboard` so the deep doc/wikilink
 * renderers can attach hover previews and open the note popover without
 * threading these through every function signature (mirrors the
 * `docDragSource` module-level idiom).
 *
 * Extracted from renderer.ts (Phase 4, "只搬不改") so `text-links.ts` can read
 * the same context without importing renderer.ts back — a cycle. Plain mutable
 * fields instead of setters: the call sites stay a direct assignment, which is
 * what they were before the move.
 */
import type { Component, HoverParent, TFile } from 'obsidian';

export const linkContext: {
	/** Hover preview host for the current pass, or null when none. */
	hoverParent: HoverParent | null;
	/** Opens a note in the dashboard's popover, if the caller supplied one. */
	noteOpener: ((file: TFile, subpath?: string) => void) | null;
	/** The rendering view as a Component — MarkdownRenderer.render requires one
	 *  for its async lifecycle; null when the caller passed a bare hover parent,
	 *  in which case memo cards keep the synchronous plain-lines paint. */
	markdownComponent: Component | null;
} = {
	hoverParent: null,
	noteOpener: null,
	markdownComponent: null,
};
