/**
 * Inline link rendering for plain-text sources (task rows, memo lines, calendar
 * task titles): splits on `[[wikilinks]]` and `[text](url)` markdown links and
 * renders each as a clickable span.
 *
 * Moved verbatim out of renderer.ts (Phase 4, "只搬不改"). It had to leave the
 * file to let the task-row renderer move too: a task row is mostly a text label,
 * so keeping these here would have made `task-row.ts` import renderer.ts while
 * renderer.ts imports `task-row.ts` — a cycle. The ambient hover/opener state
 * travels with them through `link-context.ts`.
 */
import { App, Platform } from 'obsidian';
import { resolveNoteFile } from './note-index';
import { linkContext } from './link-context';
import { attachNoteHover } from '../hover-preview';

export function renderTextWithLinks(container: HTMLElement, text: string, app: App): void {
	const parts = text.split(/(\[\[[^\]]+?\]\]|\[[^\]]+\]\([^)]+\))/g);
	for (const part of parts) {
		const wikiMatch = part.match(/^\[\[([^\]]+)\]\]$/);
		if (wikiMatch) {
			renderWikilink(container, wikiMatch[1]!, app);
			continue;
		}
		const extMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
		if (extMatch) {
			renderExternalLink(container, extMatch[1]!, extMatch[2]!);
			continue;
		}
		if (part) {
			container.appendText(part);
		}
	}
}

function renderWikilink(container: HTMLElement, content: string, app: App): void {
	let alias: string | undefined;
	let linkPart = content;

	const pipeIdx = content.indexOf('|');
	if (pipeIdx !== -1) {
		alias = content.slice(pipeIdx + 1);
		linkPart = content.slice(0, pipeIdx);
	}

	let path = linkPart;
	let fragment: string | undefined;

	const hashIdx = linkPart.indexOf('#');
	if (hashIdx !== -1) {
		path = linkPart.slice(0, hashIdx);
		fragment = linkPart.slice(hashIdx + 1);
	}

	const noteName = path.split('/').pop()?.replace(/\.md$/, '') ?? path;
	let displayName: string;
	if (alias) {
		displayName = alias;
	} else if (fragment) {
		displayName = `${noteName} > ${fragment}`;
	} else {
		displayName = noteName;
	}

	const link = container.createSpan({
		cls: 'dashboard-wikilink',
		text: displayName,
	});

	const file = resolveNoteFile(app, path);

	if (file && !Platform.isMobile && linkContext.hoverParent) {
		attachNoteHover(app, link, file, linkContext.hoverParent, fragment ? `#${fragment}` : undefined);
	}

	link.addEventListener('click', (e) => {
		e.stopPropagation();
		if (!file) return;
		linkContext.noteOpener?.(file, fragment ? `#${fragment}` : undefined);
	});
}

function renderExternalLink(container: HTMLElement, text: string, url: string): void {
	const link = container.createSpan({
		cls: 'dashboard-external-link',
		text: text,
	});
	link.addEventListener('click', (e) => {
		e.stopPropagation();
		window.open(url, '_blank');
	});
}
