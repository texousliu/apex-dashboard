/**
 * One task card's rows: the recursive row renderer, the in-place collapse /
 * checkbox-mirror DOM edits, and the live path reader.
 *
 * Moved verbatim out of renderer.ts (Phase 4, "只搬不改"). This is
 * the densest interaction cluster in the plugin — every handler is
 * path-keyed and several of them deliberately avoid a re-render — so it earns
 * its own file where the contracts in the comments sit next to the code that
 * depends on them.
 */
import { App, setIcon } from 'obsidian';
import type { DashboardCard, RenderCallbacks, TaskItem } from '../types';
import { t } from '../i18n';
import { ITEM_DRAG_TYPE } from '../dnd';
import { attachFileSuggest } from '../file-suggest';
import { renderTextWithLinks } from './text-links';
import { createReminderButton } from './reminder-popup';
import { toggleCollapseInPlace } from './collapse';

let taskDragSource: { cardId: string; taskPath: number[] } | null = null;

// One-shot focus hint for consecutive task adds: the add input records the
// card on Enter, and the section rebuild (the write's in-place refresh
// replaces the input element) re-focuses the fresh input within a short
// window. Cleared on expiry or when the user points somewhere else, so a
// later unrelated rebuild never steals focus.
const pendingTaskAddFocus: { cardId: string | null; at: number } = { cardId: null, at: 0 };
let taskAddFocusGuardInstalled = false;

function installTaskAddFocusGuard(): void {
	if (taskAddFocusGuardInstalled) return;
	taskAddFocusGuardInstalled = true;
	// User explicitly points somewhere else (anything that is not an add-task
	// input) → stop re-focusing across rebuilds.
	(activeDocument ?? document).addEventListener('pointerdown', (e) => {
		const target = e.target as HTMLElement | null;
		if (target?.closest?.('.dashboard-task-input')) return;
		pendingTaskAddFocus.cardId = null;
	}, true);
}

/**
 * Mirror a checkbox toggle into the task-list DOM WITHOUT a rebuild — the
 * section rebuild on every check was the "complete a task → whole card
 * flashes" bug. All rows (parents and children) are flat siblings of one
 * .dashboard-task-list, each stamped with its data-task-path JSON.
 *
 * Mirrors exactly what sync.applyTaskToggle does to the data:
 * 1. own row's done styling; parent toggles cascade to their subtree;
 * 2. child toggles recalc every ancestor (checked = ALL children checked,
 *    recalcChecked semantics);
 * 3. completing a TOP-LEVEL task applies the per-card completion behavior:
 *    'end' moves the block to the bottom, 'afterUnfinished' drops it just
 *    past the last unfinished top-level row, 'stay' keeps the slot. The
 *    moved rows are re-parented via appendChild/insertBefore (existing
 *    nodes, listeners intact), then every shifted data-task-path is
 *    re-stamped so edit/drag handlers keep targeting the right tasks.
 */
function mirrorTaskToggleInPlace(
	list: HTMLElement,
	item: HTMLElement,
	path: number[],
	checked: boolean,
	behavior: 'stay' | 'end' | 'afterUnfinished',
): void {
	const rows = Array.from(list.querySelectorAll<HTMLElement>(':scope > .dashboard-task-item'));
	const pathOf = (row: HTMLElement): number[] => {
		try { return JSON.parse(row.dataset.taskPath ?? '[]') as number[]; } catch { return []; }
	};
	const checkboxOf = (row: HTMLElement): HTMLInputElement | null =>
		row.querySelector<HTMLInputElement>('input.dashboard-task-checkbox');
	const setRowState = (row: HTMLElement, done: boolean): void => {
		row.querySelector<HTMLElement>('.dashboard-task-text')?.toggleClass('dashboard-task-text--done', done);
	};

	setRowState(item, checked);

	const idx = path[0] ?? -1;
	if (path.length === 1) {
		// Parent toggle: sync replaces every child's checked flag too.
		for (const row of rows) {
			const p = pathOf(row);
			if (p.length > 1 && p[0] === idx) {
				const cb = checkboxOf(row);
				if (cb) cb.checked = checked;
				setRowState(row, checked);
			}
		}
	} else {
		// Child toggle: ancestors recompute depth-by-depth (a grandparent's
		// state depends on the parent's FRESH state, so ascend in order).
		for (let d = 1; d < path.length; d++) {
			const prefix = path.slice(0, d);
			for (const row of rows) {
				const p = pathOf(row);
				if (p.length !== d || prefix.some((v, i) => p[i] !== v)) continue;
				const childRows = rows.filter((r) => {
					const cp = pathOf(r);
					return cp.length === d + 1 && prefix.every((v, i) => cp[i] === v);
				});
				const allChecked = childRows.every(r => checkboxOf(r)?.checked ?? false);
				const cb = checkboxOf(row);
				if (cb) cb.checked = allChecked;
				setRowState(row, allChecked);
			}
		}
	}

	// Completion-behavior reorder: top-level completions only.
	if (path.length !== 1 || !checked || behavior === 'stay') return;
	const block = rows.filter(r => pathOf(r)[0] === idx);
	if (block.length === 0) return;
	const isBlock = new Set(block);
	const others = rows.filter(r => !isBlock.has(r));
	if (behavior === 'end') {
		for (const r of block) list.appendChild(r);
	} else {
		const unfinished = others.filter(r =>
			pathOf(r).length === 1 && !(checkboxOf(r)?.checked ?? false));
		const anchor = unfinished[unfinished.length - 1];
		if (anchor) {
			let pos: ChildNode | null = anchor.nextSibling;
			for (const r of block) {
				list.insertBefore(r, pos);
				pos = r.nextSibling;
			}
		} else {
			const first = list.firstElementChild;
			for (const r of block) list.insertBefore(r, first);
		}
	}
	// The move shifted every later task's index — re-stamp paths so the
	// rows' edit/drag/delete handlers keep targeting the right tasks.
	let top = -1;
	for (const row of Array.from(list.querySelectorAll<HTMLElement>(':scope > .dashboard-task-item'))) {
		const p = pathOf(row);
		if (p.length === 0) continue;
		if (p.length === 1) top++;
		if (p[0] !== top) {
			row.dataset.taskPath = JSON.stringify(p.length === 1 ? [top] : [top, ...p.slice(1)]);
		}
	}
}

/** The row's CURRENT task path.
 *
 *  A row's index is not stable: completing a top-level task reorders the list
 *  (completion behavior) and `mirrorTaskToggleInPlace` re-stamps every row's
 *  `data-task-path` instead of re-rendering. A handler that captured the array
 *  it was rendered with therefore points at whatever task now sits in that slot
 *  — a few clicks in a row toggled the wrong notes. Read it from the DOM, which
 *  the mirror keeps fresh, and fall back to the render-time value.
 */
export function readTaskPath(row: HTMLElement, fallback: readonly number[]): number[] {
	const raw = row.dataset.taskPath;
	if (!raw) return [...fallback];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(v => typeof v === 'number')) {
			return parsed;
		}
	} catch {
		/* malformed stamp — fall through to the render-time path */
	}
	return [...fallback];
}

function renderTaskItem(
	list: HTMLElement,
	task: TaskItem,
	initialPath: number[],
	card: DashboardCard,
	callbacks: RenderCallbacks,
	app: App,
	depth: number,
	ancestorHidden = false,
): void {
	const item = list.createDiv({ cls: 'dashboard-task-item' });
	if (depth > 0) item.addClass('dashboard-task-item--child');
	if (ancestorHidden) item.addClass('dashboard-task-item--hidden');
	item.style.marginLeft = `${depth * 18}px`;
	item.setAttribute('draggable', 'true');
	item.dataset.taskPath = JSON.stringify(initialPath);
	item.dataset.cardId = card.id;
	// Every handler below resolves the path through this, never through the
	// render-time array (see readTaskPath).
	const currentPath = (): number[] => readTaskPath(item, initialPath);

	const clearDragClasses = () => {
		item.removeClass('dashboard-task-item--drag-top');
		item.removeClass('dashboard-task-item--drag-bottom');
		item.removeClass('dashboard-task-item--drag-nest');
	};

	// Mobile gestures: tap (show buttons), long-press (drag), quick-swipe (nest/unnest)
	let touchState: {
		startX: number;
		startY: number;
		startT: number;
		moved: boolean;
		dragging: boolean;
		timer: number | null;
	} | null = null;

	item.addEventListener('touchstart', (e) => {
		const tch = e.touches[0];
		if (!tch) return;
		touchState = {
			startX: tch.clientX,
			startY: tch.clientY,
			startT: Date.now(),
			moved: false,
			dragging: false,
			timer: null,
		};
		touchState.timer = window.setTimeout(() => {
			if (touchState && !touchState.moved) {
				touchState.dragging = true;
				item.addClass('dashboard-task-item--dragging');
			}
		}, 500);
	}, { passive: true });

	item.addEventListener('touchmove', (e) => {
		if (!touchState) return;
		const tch = e.touches[0];
		if (!tch) return;
		const dx = tch.clientX - touchState.startX;
		const dy = tch.clientY - touchState.startY;
		if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
			touchState.moved = true;
			if (touchState.timer) {
				window.clearTimeout(touchState.timer);
				touchState.timer = null;
			}
		}
		if (!touchState.dragging && touchState.moved && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
			item.style.transform = `translateX(${Math.max(-40, Math.min(40, dx * 0.5))}px)`;
		}
	}, { passive: true });

	item.addEventListener('touchend', (e) => {
		const ts = touchState;
		touchState = null;
		item.setCssProps({ transform: '' });
		if (!ts) return;
		if (ts.timer) window.clearTimeout(ts.timer);
		if (ts.dragging) {
			item.removeClass('dashboard-task-item--dragging');
			return;
		}
		const tch = e.changedTouches[0];
		const dx = tch ? tch.clientX - ts.startX : 0;
		const dy = tch ? tch.clientY - ts.startY : 0;
		const dt = Date.now() - ts.startT;
		const isSwipe = dt < 500 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5;
		if (isSwipe) {
			if (dx > 0) callbacks.onTaskNest(card.id, currentPath());
			else callbacks.onTaskUnnest(card.id, currentPath());
			return;
		}
		if (!ts.moved) {
			const wasActive = item.hasClass('dashboard-task-item--touched');
			activeDocument.querySelectorAll('.dashboard-task-item--touched').forEach(el => {
				el.removeClass('dashboard-task-item--touched');
			});
			if (!wasActive) item.addClass('dashboard-task-item--touched');
		}
	}, { passive: true });

	item.addEventListener('touchcancel', () => {
		if (touchState?.timer) window.clearTimeout(touchState.timer);
		touchState = null;
		item.setCssProps({ transform: '' });
		item.removeClass('dashboard-task-item--dragging');
	}, { passive: true });

	const hasChildren = (task.children?.length ?? 0) > 0;
	if (hasChildren) {
		item.setAttribute('aria-expanded', task.collapsed ? 'false' : 'true');
		const toggle = item.createDiv({ cls: 'dashboard-task-toggle dashboard-task-toggle--active' });
		toggle.setAttribute('role', 'button');
		toggle.setAttribute('aria-label', task.collapsed ? t('renderer.expandTask') : t('renderer.collapseTask'));
		setIcon(toggle, task.collapsed ? 'chevron-right' : 'chevron-down');
		// Track collapse state locally. The quiet toggle path no longer rebuilds
		// the DOM (no full re-render), so the closed-over `task` reference would
		// stay frozen at its initial value and the chevron could only ever fold
		// once. This mutable flag is the source of truth for the click handler.
		let isCollapsed = task.collapsed;
		toggle.addEventListener('click', (e) => {
			e.stopPropagation();
			// Optimistic in-place DOM update + debounced quiet persist. Avoids the
			// full-board re-render the old collapse path triggered.
			isCollapsed = !isCollapsed;
			toggleCollapseInPlace(item, currentPath(), 'data-task-path', isCollapsed);
			toggle.setAttribute('aria-label', isCollapsed ? t('renderer.expandTask') : t('renderer.collapseTask'));
			callbacks.onTaskToggleCollapse(card.id, currentPath());
		});
	}

	const checkbox = item.createEl('input', {
		cls: 'dashboard-task-checkbox',
		attr: { type: 'checkbox' },
	});
	checkbox.checked = task.checked;
	checkbox.addEventListener('change', () => {
		// EVERY card mirrors the toggle into the DOM and persists quietly —
		// daily-linked (tasksFromDaily) cards included. Their old loud path
		// (sync.toggleTask → notify echo) rebuilt the whole section on every
		// check/uncheck; the quiet path's note round-trip (vault event →
		// re-read → same content → signature guard) confirms the state
		// without ever re-rendering.
		// Resolve the path ONCE per click: the mirror below re-stamps this row's
		// index when the completion reorder moves it, so the model update and the
		// DOM edit must agree on the pre-click path.
		const toggledPath = currentPath();
		mirrorTaskToggleInPlace(list, item, toggledPath, checkbox.checked, card.taskCompleteBehavior ?? 'end');
		callbacks.onCheckboxToggleQuiet(card.id, toggledPath, checkbox.checked);
	});

	const label = item.createSpan({
		cls: task.checked ? 'dashboard-task-text dashboard-task-text--done' : 'dashboard-task-text',
	});
	renderTextWithLinks(label, task.text, app);
	label.addEventListener('dblclick', (e) => {
		e.stopPropagation();
		const currentText = label.getText();
		label.empty();
		item.setAttribute('draggable', 'false');

		const textarea = label.createEl('textarea', {
			cls: 'dashboard-task-edit-textarea',
			text: task.text,
		});

		const autoResize = () => {
			textarea.setCssProps({ height: 'auto' });
			textarea.style.height = textarea.scrollHeight + 'px';
		};
		autoResize();
		textarea.focus();
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);

		const finish = (save: boolean) => {
			const newText = textarea.value.trim();
			if (save && newText && newText !== task.text) {
				callbacks.onTaskEdit(card.id, currentPath(), newText);
			} else {
				label.empty();
				label.setText(currentText);
			}
			item.setAttribute('draggable', 'true');
		};

		textarea.addEventListener('input', autoResize);
		textarea.addEventListener('keydown', (ke) => {
			if (ke.key === 'Enter' && !ke.shiftKey) {
				ke.preventDefault();
				finish(true);
			} else if (ke.key === 'Escape') {
				ke.preventDefault();
				finish(false);
			}
		});
		textarea.addEventListener('blur', () => finish(true));
	});

	const delBtn = item.createEl('button', {
		cls: 'dashboard-task-delete',
		attr: { 'aria-label': t('renderer.deleteTask') },
	});
	setIcon(delBtn, 'x');
	delBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		callbacks.onTaskDelete(card.id, currentPath());
	});

	const reminderBtn = createReminderButton(item, card.id, currentPath, task, callbacks);
	item.appendChild(reminderBtn);

	item.addEventListener('dragstart', (e) => {
		e.stopPropagation();
		taskDragSource = { cardId: card.id, taskPath: currentPath() };
		item.addClass('dashboard-task-item--dragging');
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', JSON.stringify(currentPath()));
			// Marks this as an in-card item drag so the card-level file-drop
			// layer (which would force dropEffect='link' and kill the drop)
			// and the section-row handlers stand down.
			e.dataTransfer.setData(ITEM_DRAG_TYPE, '1');
		}
	});

	item.addEventListener('dragend', () => {
		item.removeClass('dashboard-task-item--dragging');
		activeDocument.querySelectorAll(
			'.dashboard-task-item--drag-top,.dashboard-task-item--drag-bottom,.dashboard-task-item--drag-nest'
		).forEach(el => el.removeClass('dashboard-task-item--drag-top', 'dashboard-task-item--drag-bottom', 'dashboard-task-item--drag-nest'));
		taskDragSource = null;
	});

	item.addEventListener('dragover', (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (!taskDragSource) return;
		const sameNode = taskDragSource.cardId === card.id &&
			JSON.stringify(taskDragSource.taskPath) === JSON.stringify(currentPath());
		if (sameNode) return;
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		activeDocument.querySelectorAll(
			'.dashboard-task-item--drag-top,.dashboard-task-item--drag-bottom,.dashboard-task-item--drag-nest'
		).forEach(el => el.removeClass('dashboard-task-item--drag-top', 'dashboard-task-item--drag-bottom', 'dashboard-task-item--drag-nest'));
		const rect = item.getBoundingClientRect();
		const ratio = (e.clientY - rect.top) / rect.height;
		if (ratio < 0.3) item.addClass('dashboard-task-item--drag-top');
		else if (ratio > 0.7) item.addClass('dashboard-task-item--drag-bottom');
		else item.addClass('dashboard-task-item--drag-nest');
	});

	item.addEventListener('dragleave', () => {
		clearDragClasses();
	});

	item.addEventListener('drop', (e) => {
		e.preventDefault();
		e.stopPropagation();
		clearDragClasses();
		if (!taskDragSource) return;
		const sameNode = taskDragSource.cardId === card.id &&
			JSON.stringify(taskDragSource.taskPath) === JSON.stringify(currentPath());
		if (sameNode) return;

		const rect = item.getBoundingClientRect();
		const ratio = (e.clientY - rect.top) / rect.height;
		const src = taskDragSource;

		if (src.cardId === card.id) {
			if (ratio < 0.3) callbacks.onTaskReorder(card.id, src.taskPath, currentPath(), true);
			else if (ratio > 0.7) callbacks.onTaskReorder(card.id, src.taskPath, currentPath(), false);
			else callbacks.onTaskNestInto(card.id, src.taskPath, currentPath());
		} else {
			const mode: 'before' | 'after' | 'nest' = ratio < 0.3 ? 'before' : ratio > 0.7 ? 'after' : 'nest';
			callbacks.onTaskMoveToCard(src.cardId, src.taskPath, card.id, currentPath(), mode);
		}
	});

	// CONTRACT: always render children, even when collapsed. The in-place
	// toggle (`toggleCollapseInPlace`) can only show/hide DOM that already
	// exists — if collapsed subtrees were skipped here, an expand after any full
	// re-render (e.g. checking a sibling task) would find nothing to unhide and
	// the chevron would appear dead. Do NOT "optimize" this back to
	// `!task.collapsed` — that was the bug. Collapsed subtrees are hidden via the
	// `--hidden` class (driven by `ancestorHidden`), not by omitting the DOM.
	// Trade-off: a deeply collapsed tree pays DOM-creation cost on full render;
	// acceptable because full render is low-frequency (chevron clicks are O(n)
	// in-place, not re-renders).
	if (task.children && task.children.length > 0) {
		const childHidden = ancestorHidden || task.collapsed;
		for (let i = 0; i < task.children.length; i++) {
			renderTaskItem(list, task.children[i]!, [...initialPath, i], card, callbacks, app, depth + 1, childHidden);
		}
	}
}

/**
 * Completion of a single task as a 0..1 fraction: a leaf is 0 or 1 by its
 * checkbox; a task with subtasks takes the average of its subtasks'
 * completion (recursively). Card progress is the average over top-level
 * tasks: 1 done task + 1 task with 2/5 subtasks done = (1 + 0.4) / 2 = 70%.
 */
function taskCompletion(task: TaskItem): number {
	if (!task.children || task.children.length === 0) return task.checked ? 1 : 0;
	const sum = task.children.reduce((acc, child) => acc + taskCompletion(child), 0);
	return sum / task.children.length;
}

export function renderTaskBody(container: HTMLElement, card: DashboardCard, callbacks: RenderCallbacks, app: App): void {
	const list = container.createDiv({ cls: 'dashboard-task-list' });
	list.dataset.cardId = card.id;

	// When the list is empty, make it a drop target so tasks can be dragged in
	list.addEventListener('dragover', (e) => {
		if (!taskDragSource) return;
		if (taskDragSource.cardId === card.id) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		list.addClass('dashboard-task-list--drop-target');
	});

	list.addEventListener('dragleave', (e) => {
		if (!list.contains(e.relatedTarget as Node)) {
			list.removeClass('dashboard-task-list--drop-target');
		}
	});

	list.addEventListener('drop', (e) => {
		e.preventDefault();
		list.removeClass('dashboard-task-list--drop-target');
		if (!taskDragSource) return;
		if (taskDragSource.cardId === card.id) return;
		callbacks.onTaskMoveToCard(taskDragSource.cardId, taskDragSource.taskPath, card.id, [card.tasks.length], 'before');
	});

	card.tasks.forEach((task, i) => renderTaskItem(list, task, [i], card, callbacks, app, 0));

	const addRow = container.createDiv({ cls: 'dashboard-task-add' });
	const input = addRow.createEl('input', {
		cls: 'dashboard-task-input',
		attr: { type: 'text', placeholder: t('renderer.addTask') },
	});
	const taskSuggest = attachFileSuggest(input, app);
	// Consecutive adds: Enter commits, the write rebuilds this section in
	// place (a fresh input element), and the pending hint re-focuses it so
	// the user can keep typing the next task without a mouse round-trip.
	// The focus is deferred to the next frame: renderTaskBody may still be
	// building a detached tree (refreshSectionInPlace swaps the node in only
	// after render returns), and focus() on a detached element is a silent
	// no-op — this was why the hint never took. The hint is intentionally
	// NOT consumed here: the optimistic rebuild is followed by the
	// vault-event debounced rebuild, which would otherwise steal focus right
	// back; each rebuild re-arms its own rAF and the last attached input wins.
	if (pendingTaskAddFocus.cardId === card.id && Date.now() - pendingTaskAddFocus.at < 5000) {
		window.requestAnimationFrame(() => {
			if (pendingTaskAddFocus.cardId === card.id && input.isConnected) input.focus();
		});
	}
	input.addEventListener('keydown', (e) => {
		if (taskSuggest.isActive()) return;
		if (e.key === 'Enter' && input.value.trim()) {
			pendingTaskAddFocus.cardId = card.id;
			pendingTaskAddFocus.at = Date.now();
			installTaskAddFocusGuard();
			callbacks.onTaskAdd(card.id, input.value.trim());
			input.value = '';
		}
	});

	if (card.tasks.length > 0) {
		const sum = card.tasks.reduce((acc, task) => acc + taskCompletion(task), 0);
		const percent = Math.round((sum / card.tasks.length) * 100);

		const progressWrap = container.createDiv({ cls: 'dashboard-progress' });
		const bar = progressWrap.createDiv({ cls: 'dashboard-progress-bar' });
		bar.createDiv({
			cls: 'dashboard-progress-fill',
			attr: { style: `width: ${percent}%` },
		});
		progressWrap.createSpan({
			cls: 'dashboard-progress-text',
			text: `${percent}%`,
		});
	}
}

