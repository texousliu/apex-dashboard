/**
 * Project cards: the recursive doc tree (collapse / drag-reorder / nest /
 * remove / open) plus the add-document search row.
 *
 * Moved verbatim out of renderer.ts (Phase 4, "只搬不改") — only the
 * legacy one-level extra indent was normalized, nothing else changed. Shares
 * `toggleCollapseInPlace` with task rows (same `--hidden`-class technique, but
 * keyed on `data-doc-path`).
 */
import { App, Platform, setIcon } from 'obsidian';
import type { DashboardCard, DocNode, RenderCallbacks } from '../types';
import { t } from '../i18n';
import { ITEM_DRAG_TYPE } from '../dnd';
import { iconForExtension } from '../file-types';
import { showConfirmDialog } from '../confirm-dialog';
import { attachNoteHover } from '../hover-preview';
import { getSearchableFiles, resolveNoteFile } from './note-index';
import { linkContext } from './link-context';
import { toggleCollapseInPlace } from './collapse';

let docDragSource: { cardId: string; docPath: number[] } | null = null;

/** The doc being dragged right now, if any.
 *
 *  The card body accepts docs from OTHER cards (a cross-card drop), and that
 *  drop zone lives in renderer.ts next to the card chrome — not in the doc
 *  tree. Exposing the in-flight source read-only keeps the drag state owned by
 *  the module that sets it. */
export function currentDocDragSource(): { cardId: string; docPath: number[] } | null {
	return docDragSource;
}

export function renderProjectBody(container: HTMLElement, card: DashboardCard, callbacks: RenderCallbacks, app: App): void {
	const collectDocPaths = (docs: DocNode[]): string[] => {
		const out: string[] = [];
		const walk = (nodes: DocNode[]) => {
			for (const n of nodes) {
				out.push(n.path);
				if (n.children) walk(n.children);
			}
		};
		walk(docs);
		return out;
	};

	const clearDragClasses = () => {
		activeDocument.querySelectorAll(
			'.dashboard-task-item--drag-top,.dashboard-task-item--drag-bottom,.dashboard-task-item--drag-nest,.dashboard-task-item--drag-over,.dashboard-task-item--dragging'
		).forEach(el => {
			(el as HTMLElement).removeClass(
				'dashboard-task-item--drag-top',
				'dashboard-task-item--drag-bottom',
				'dashboard-task-item--drag-nest',
				'dashboard-task-item--drag-over',
				'dashboard-task-item--dragging',
			);
		});
	};

	const docList = container.createDiv({ cls: 'dashboard-project-docs' });
	docList.dataset.cardId = card.id;

	// Empty list drop target so docs can be dragged in (appends at top-level end)
	docList.addEventListener('dragover', (e) => {
		if (!docDragSource) return;
		if (docDragSource.cardId === card.id) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		docList.addClass('dashboard-project-docs--drop-target');
	});

	docList.addEventListener('dragleave', (e) => {
		if (!docList.contains(e.relatedTarget as Node)) {
			docList.removeClass('dashboard-project-docs--drop-target');
		}
	});

	docList.addEventListener('drop', (e) => {
		e.preventDefault();
		docList.removeClass('dashboard-project-docs--drop-target');
		if (!docDragSource) return;
		if (docDragSource.cardId === card.id) return;
		const destPath = [card.docs.length];
		callbacks.onDocMoveToCard(docDragSource.cardId, docDragSource.docPath, card.id, destPath, 'before');
	});

	const renderDocItem = (doc: DocNode, path: number[], depth: number, ancestorHidden = false) => {
		const docItem = docList.createDiv({ cls: 'dashboard-project-doc-item' });
		if (depth > 0) docItem.addClass('dashboard-project-doc-item--child');
		if (ancestorHidden) docItem.addClass('dashboard-project-doc-item--hidden');
		docItem.style.marginLeft = `${depth * 18}px`;
		docItem.setAttribute('draggable', 'true');
		docItem.dataset.docPath = JSON.stringify(path);

		const hasChildren = (doc.children?.length ?? 0) > 0;
		if (hasChildren) {
			docItem.setAttribute('aria-expanded', doc.collapsed ? 'false' : 'true');
			const toggle = docItem.createDiv({ cls: 'dashboard-task-toggle dashboard-task-toggle--active' });
			toggle.setAttribute('role', 'button');
			toggle.setAttribute('aria-label', doc.collapsed ? t('renderer.expandDoc') : t('renderer.collapseDoc'));
			setIcon(toggle, doc.collapsed ? 'chevron-right' : 'chevron-down');
			// See task toggle: mutable local flag avoids the frozen closed-over
			// value now that the quiet path skips the full re-render.
			let isCollapsed = doc.collapsed;
			toggle.addEventListener('click', (e) => {
				e.stopPropagation();
				// Optimistic in-place DOM update + debounced quiet persist. Avoids
				// the full-board re-render the old collapse path triggered.
				isCollapsed = !isCollapsed;
				toggleCollapseInPlace(docItem, path, 'data-doc-path', isCollapsed);
				toggle.setAttribute('aria-label', isCollapsed ? t('renderer.expandDoc') : t('renderer.collapseDoc'));
				callbacks.onDocToggleCollapse(card.id, path);
			});
		}

		const resolved = resolveNoteFile(app, doc.path);
		const docIcon = docItem.createSpan({ cls: 'dashboard-project-doc-icon' });
		setIcon(docIcon, iconForExtension(resolved?.extension ?? ''));
		docItem.createSpan({ text: resolved?.basename ?? doc.path.split('/').pop() ?? doc.path, cls: 'dashboard-project-doc-name' });

		if (resolved && !Platform.isMobile && linkContext.hoverParent) {
			attachNoteHover(app, docItem, resolved, linkContext.hoverParent);
		}

		const removeBtn = docItem.createEl('button', {
			cls: 'dashboard-project-doc-remove',
			attr: { 'aria-label': t('renderer.removeDoc') },
		});
		setIcon(removeBtn, 'x');
		removeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			void (async () => {
				const confirmed = await showConfirmDialog(app, {
					title: t('common.confirmDelete'),
					message: t('common.confirmDeleteMessage'),
				});
				if (!confirmed) return;
				callbacks.onDocDelete(card.id, path);
			})();
		});

		docItem.addEventListener('click', (e) => {
			if ((e.target as HTMLElement).tagName === 'BUTTON') return;
			if (!resolved) return;
			linkContext.noteOpener?.(resolved);
		});

		docItem.addEventListener('dragstart', (e) => {
			e.stopPropagation();
			docDragSource = { cardId: card.id, docPath: path };
			docItem.addClass('dashboard-task-item--dragging');
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
				e.dataTransfer.setData('text/plain', JSON.stringify(path));
				// Marks this as an in-card item drag so the card-level
				// file-drop layer (dropEffect='link' override) stands down.
				e.dataTransfer.setData(ITEM_DRAG_TYPE, '1');
			}
		});

		docItem.addEventListener('dragend', () => {
			docItem.removeClass('dashboard-task-item--dragging');
			clearDragClasses();
			docDragSource = null;
		});

		docItem.addEventListener('dragover', (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (!docDragSource) return;
			const sameNode = docDragSource.cardId === card.id &&
				JSON.stringify(docDragSource.docPath) === JSON.stringify(path);
			if (sameNode) return;
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
			clearDragClasses();
			const rect = docItem.getBoundingClientRect();
			const ratio = (e.clientY - rect.top) / rect.height;
			if (ratio < 0.3) docItem.addClass('dashboard-task-item--drag-top');
			else if (ratio > 0.7) docItem.addClass('dashboard-task-item--drag-bottom');
			else docItem.addClass('dashboard-task-item--drag-nest');
		});

		docItem.addEventListener('dragleave', () => {
			docItem.removeClass('dashboard-task-item--drag-top');
			docItem.removeClass('dashboard-task-item--drag-bottom');
			docItem.removeClass('dashboard-task-item--drag-nest');
		});

		docItem.addEventListener('drop', (e) => {
			e.preventDefault();
			e.stopPropagation();
			clearDragClasses();
			if (!docDragSource) return;
			const sameNode = docDragSource.cardId === card.id &&
				JSON.stringify(docDragSource.docPath) === JSON.stringify(path);
			if (sameNode) return;

			const rect = docItem.getBoundingClientRect();
			const ratio = (e.clientY - rect.top) / rect.height;
			const src = docDragSource;

			if (src.cardId === card.id) {
				if (ratio < 0.3) callbacks.onDocReorder(card.id, src.docPath, path, true);
				else if (ratio > 0.7) callbacks.onDocReorder(card.id, src.docPath, path, false);
				else callbacks.onDocNest(card.id, src.docPath);
			} else {
				const mode: 'before' | 'after' | 'nest' = ratio < 0.3 ? 'before' : ratio > 0.7 ? 'after' : 'nest';
				callbacks.onDocMoveToCard(src.cardId, src.docPath, card.id, path, mode);
			}
		});

		// CONTRACT: always render children, even when collapsed (see task
		// branch for the full rationale). Do not gate on `!doc.collapsed`.
		if (hasChildren) {
			const childHidden = ancestorHidden || doc.collapsed;
			doc.children!.forEach((child, i) => renderDocItem(child, [...path, i], depth + 1, childHidden));
		}
	};

	card.docs.forEach((doc, i) => renderDocItem(doc, [i], 0));

	const addDocRow = container.createDiv({ cls: 'dashboard-project-add-doc' });
	const docInput = addDocRow.createEl('input', {
		cls: 'dashboard-task-input',
		attr: { type: 'text', placeholder: t('renderer.addDocument') },
	});

	const docResults = addDocRow.createDiv({ cls: 'dashboard-project-doc-results' });

	docInput.addEventListener('input', () => {
		docResults.empty();
		const q = docInput.value.toLowerCase().trim();
		if (!q) return;

		const currentPaths = collectDocPaths(card.docs);
		const files = getSearchableFiles(app)
			.filter(f => !f.path.startsWith('.'))
			.filter(f => f.path.toLowerCase().includes(q) || f.basename.toLowerCase().includes(q))
			.filter(f => !currentPaths.includes(f.path))
			.slice(0, 50);

		for (const file of files) {
			const item = docResults.createDiv({ cls: 'dashboard-project-doc-result' });
			item.setText(file.basename);
			item.addEventListener('click', () => {
				callbacks.onDocAdd(card.id, file.path);
			});
		}
	});

	docInput.addEventListener('blur', () => {
		window.setTimeout(() => docResults.empty(), 200);
	});
}
