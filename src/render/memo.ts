/**
 * Sticky-note cards: view/edit toggle, the synchronous plain-lines paint, the
 * markdown pass that replaces it, and the link wiring for the rendered result.
 *
 * Moved verbatim out of renderer.ts (Phase 4, "只搬不改"). Also the
 * shared home of `memoMarkdownSource`, which the view/render paths use to keep
 * line-per-line memos reading the way they were written.
 */
import { App, Component, MarkdownRenderer, Platform } from 'obsidian';
import type { DashboardCard, RenderCallbacks } from '../types';
import { t } from '../i18n';
import { memoCardText } from '../card-move';
import { extractCardParts } from '../parser';
import { attachFileSuggest } from '../file-suggest';
import { attachNoteHover } from '../hover-preview';
import { renderTextWithLinks } from './text-links';
import { resolveNoteFile } from './note-index';
import { linkContext } from './link-context';

export function renderMemoBody(container: HTMLElement, card: DashboardCard, callbacks: RenderCallbacks, app: App): void {
	const text = memoCardText(card);
	let dirty = false;

	// View mode: rendered text with clickable links
	const view = container.createDiv({ cls: 'dashboard-memo-view' });
	renderMemoViewContent(view, text, app);
	view.addEventListener('click', () => {
		view.setCssProps({ display: 'none' });
		textarea.setCssProps({ display: '' });
		textarea.focus();
	});

	// Edit mode: textarea (hidden by default)
	const textarea = container.createEl('textarea', {
		cls: 'dashboard-memo-textarea',
		text: text,
		attr: { placeholder: t('renderer.writeThoughts') },
	});
	textarea.setCssProps({ display: 'none' });

	attachFileSuggest(textarea, app);

	textarea.addEventListener('input', () => {
		dirty = true;
	});

	const save = () => {
		if (!dirty) return;
		dirty = false;
		const value = textarea.value;
		const parts = extractCardParts(value);
		callbacks.onMemoUpdate(card, {
			body: parts.cleanBody,
			blockquote: parts.blockquote,
			tasks: parts.tasks,
			docs: parts.docs,
			wikiLink: '',
			url: '',
			type: 'generic',
		});
	};

	textarea.addEventListener('blur', () => {
		save();
		// If re-render didn't happen (not dirty), switch to view manually
		if (activeDocument.body.contains(view)) {
			renderMemoViewContent(view, textarea.value, app);
			view.setCssProps({ display: '' });
			textarea.setCssProps({ display: 'none' });
		}
	});
}

function renderMemoViewContent(container: HTMLElement, text: string, app: App): void {
	container.empty();
	container.removeClass('dashboard-memo-view--md');
	if (!text) {
		container.addClass('dashboard-memo-view--empty');
		container.setText(t('renderer.writeThoughts'));
		return;
	}
	container.removeClass('dashboard-memo-view--empty');

	// Instant plain-lines paint so the card never flashes empty while the
	// async markdown pass is in flight; renderMemoMarkdown swaps it out on
	// success (and leaves this paint standing on failure).
	renderMemoPlainLines(container, text, app);
	const component = linkContext.markdownComponent;
	if (component) void renderMemoMarkdown(container, text, app, component);
}

/** The legacy line-per-line paint: blockquote lines + wikilink/URL lines.
 *  Kept as the synchronous fallback under the markdown pass. */
function renderMemoPlainLines(container: HTMLElement, text: string, app: App): void {
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (i > 0) container.createEl('br');
		const line = lines[i]!;
		if (line.startsWith('> ')) {
			const quote = container.createDiv({ cls: 'dashboard-note-quote' });
			quote.setText(line.slice(2));
		} else {
			renderTextWithLinks(container, line, app);
		}
	}
}

/**
 * Adapt memo text (written line-per-line in a plain textarea) for markdown
 * rendering without changing how existing memos read: every plain line becomes
 * its own paragraph (markdown would otherwise soft-wrap them together), while
 * consecutive list-item lines stay grouped so `-`/`1.` lists and task lines
 * render as real lists. Code-fence interiors are passed through untouched.
 */
export function memoMarkdownSource(text: string): string {
	const lines = text.split('\n');
	const out: string[] = [];
	let listBuf: string[] = [];
	let inFence = false;
	const flush = (): void => {
		if (listBuf.length > 0) {
			out.push(...listBuf, '');
			listBuf = [];
		}
	};
	for (const line of lines) {
		if (/^\s*(```|~~~)/.test(line)) {
			flush();
			inFence = !inFence;
			out.push(line);
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}
		const isListItem = /^(\s*)([-*+]|\d+\.)\s+/.test(line);
		const isContinuation = listBuf.length > 0 && /^\s+\S/.test(line);
		if (isListItem || isContinuation) {
			listBuf.push(line);
		} else {
			flush();
			out.push(line, '');
		}
	}
	flush();
	return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Render the memo view's text as real markdown (Obsidian's renderer), then
 * wire the produced links to the dashboard's open/hover semantics. Swaps the
 * container's legacy plain-lines paint in one step on success; on any failure
 * the plain paint stays. Exported for the verify scripts.
 */
export function renderMemoMarkdown(
	container: HTMLElement,
	text: string,
	app: App,
	component: Component,
): Promise<void> {
	const host = createDiv();
	return MarkdownRenderer.render(app, memoMarkdownSource(text), host, '', component)
		.then(() => {
			if (!container.isConnected || !host.hasChildNodes()) return;
			container.empty();
			container.addClass('dashboard-memo-view--md');
			while (host.firstChild) container.appendChild(host.firstChild);
			wireMemoMarkdownLinks(container, app);
		})
		.catch(() => {
			// Keep the plain-lines paint — a render failure must not blank the card.
		});
}

/** Attach open/click (and desktop hover) behavior to the anchors Obsidian's
 *  markdown pass produced — the same semantics renderWikilink/renderExternalLink
 *  give the plain paint, so internal links open through the note opener and
 *  external ones open in the browser. */
function wireMemoMarkdownLinks(container: HTMLElement, app: App): void {
	container.querySelectorAll('a').forEach(raw => {
		const a = raw as HTMLElement;
		const href = a.getAttribute('href') ?? '';
		if (a.hasClass('internal-link') || href === '' || href.startsWith('#')) {
			const target = a.getAttribute('data-href') ?? a.getText();
			const path = target.split('#')[0]!;
			const file = resolveNoteFile(app, path);
			if (file && !Platform.isMobile && linkContext.hoverParent) {
				attachNoteHover(app, a, file, linkContext.hoverParent, target.includes('#') ? `#${target.split('#').pop()}` : undefined);
			}
			a.addEventListener('click', (e) => {
				e.stopPropagation();
				e.preventDefault();
				if (!file) return;
				linkContext.noteOpener?.(file, target.includes('#') ? `#${target.split('#').pop()}` : undefined);
			});
		} else if (/^https?:/i.test(href)) {
			a.addEventListener('click', (e) => {
				e.stopPropagation();
				e.preventDefault();
				window.open(href, '_blank');
			});
		}
	});
}

