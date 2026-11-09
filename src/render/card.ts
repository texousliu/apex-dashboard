/**
 * A single dashboard card: chrome (cover, header, action buttons, resize) plus
 * every card body that is not a task row, memo or doc tree — those moved to
 * their own modules in earlier Phase 4 slices, and this file now owns the
 * weather / tracker bodies they were the only remaining callers of.
 *
 * Moved verbatim out of renderer.ts (Phase 4, "只搬不改"). What stays
 * behind is the section frame: `renderCard` is called once per card by
 * `renderSectionCards`.
 */
import { App, setIcon } from 'obsidian';
import type { DashboardCard, DashboardData, DashboardSettings, RenderCallbacks, CardSize, TrackerStyle } from '../types';
import { t, getLocale } from '../i18n';
import { resolveVaultImage } from '../banner';
import { focalToBackgroundPosition, isCenterFocal } from '../focal-point-picker';
import { TaskCardConfigModal } from '../task-card-config-modal';
import { fetchWeather, getCachedWeather, getWeatherDescription, getWeatherEmoji } from '../weather-service';
import { readTrackerData, computeStreak } from '../tracker-service';
import { getCSSVar } from './color';
import { destroyChart, renderTrackerLineChart, renderTrackerBarChart, renderTrackerHeatmap } from './tracker-chart';
import { renderTaskBody } from './task-row';
import { renderMemoBody } from './memo';
import { renderProjectBody, currentDocDragSource } from './project-doc';

export function renderCard(card: DashboardCard, columnName: string, sectionType: string, callbacks: RenderCallbacks, app: App, data?: DashboardData, settings?: DashboardSettings, sectionShowCover = true): HTMLElement {
	const el = createDiv();
	el.addClass('dashboard-card', `dashboard-card--${card.type}`);
	el.dataset.cardId = card.id;
	el.dataset.cardType = card.type;
	el.setAttribute('role', 'article');
	el.setAttribute('aria-label', card.title);

	if (card.color) {
		el.dataset.hasColor = 'true';
		el.style.setProperty('--db-card-accent', card.color);
	}

	const isMemo = isMemoCard(sectionType, card);
	const isTask = !isMemo && card.type === 'task';
	const isWeather = card.type === 'weather';
	const isTracker = card.type === 'tracker';
	const isWidget = isWeather || isTracker;
	const isProjectLike = !isMemo && !isTask && !isWidget;
	const isDashboardSection = sectionType === 'dashboard';
	// Projects cards show covers unless the section's 显示封面 toggle is off
	// (the retired standalone no-cover type); sticky picks per card instead.
	const showCover = isProjectLike && !isDashboardSection && sectionShowCover
		&& (sectionType !== 'sticky' || card.noteStyle !== 'plain');

	if (showCover) {
		el.addClass('dashboard-card--cover');
	}

	if (card.coverImage && showCover) {
		const resolved = resolveVaultImage(app, card.coverImage);
		if (resolved) {
			const cover = el.createDiv({ cls: 'dashboard-project-cover' });
			cover.style.backgroundImage = `url("${resolved}")`;
			// Saved focal point (coverPos): background-position percentages;
			// absent stays the CSS default `center`.
			if (card.coverPos && !isCenterFocal(card.coverPos)) {
				cover.style.backgroundPosition = focalToBackgroundPosition(card.coverPos);
			}
			cover.setAttribute('draggable', 'true');
		} else {
			const cover = el.createDiv({ cls: 'dashboard-project-cover dashboard-project-cover--default' });
			cover.setAttribute('draggable', 'true');
		}
	} else if (showCover) {
		const cover = el.createDiv({ cls: 'dashboard-project-cover dashboard-project-cover--default' });
		cover.setAttribute('draggable', 'true');
	}

	const header = el.createDiv({ cls: 'dashboard-card-header' });
	header.setAttribute('draggable', 'true');

	// Mobile: tap header to toggle card action buttons
	header.addEventListener('touchstart', () => {
		const wasActive = header.hasClass('dashboard-card-header--touched');
		activeDocument.querySelectorAll('.dashboard-card-header--touched').forEach(el => {
			el.removeClass('dashboard-card-header--touched');
		});
		if (!wasActive) {
			header.addClass('dashboard-card-header--touched');
		}
	}, { passive: true });

	const titleEl = header.createEl('h4', { text: card.title, cls: 'dashboard-card-title' });

	const skipEditBtn = isMemo || isTask || (isWidget && isDashboardSection);

	titleEl.addEventListener('dblclick', (e) => {
		e.stopPropagation();
		const currentTitle = titleEl.getText();
		titleEl.empty();
		const input = titleEl.createEl('input', {
			cls: 'dashboard-title-edit-input',
			attr: { type: 'text', value: currentTitle },
		});
		input.focus();
		input.select();

		const finish = (save: boolean) => {
			const newTitle = input.value.trim();
			if (save && newTitle && newTitle !== currentTitle) {
				callbacks.onCardTitleEdit(card.id, newTitle);
			} else {
				titleEl.empty();
				titleEl.setText(currentTitle);
			}
		};

		input.addEventListener('keydown', (ke: KeyboardEvent) => {
			if (ke.key === 'Enter') {
				ke.preventDefault();
				finish(true);
			} else if (ke.key === 'Escape') {
				ke.preventDefault();
				finish(false);
			}
		});

		input.addEventListener('blur', () => {
			finish(true);
		});
	});
	titleEl.setCssProps({ cursor: 'pointer' });

	const actions = header.createDiv({ cls: 'dashboard-card-actions' });

	// Dashboard grid layout for widget cards
	if (isWidget && isDashboardSection) {
		const currentSize: CardSize = card.size || 'M';
		const sizeToGrid: Record<CardSize, { cols: number; rows: number }> = {
			S: { cols: 1, rows: 1 },
			M: { cols: 2, rows: 1 },
			L: { cols: 2, rows: 2 },
		};
		const grid = sizeToGrid[currentSize];
		el.style.gridColumn = `span ${grid.cols}`;
		el.style.gridRow = `span ${grid.rows}`;

		// Size selector button for dashboard widgets only
		const sizeBtn = actions.createEl('button', {
			cls: 'dashboard-card-btn dashboard-card-btn--size',
			attr: { 'aria-label': 'Card size' },
		});
		sizeBtn.setText(t('widget.size' + currentSize));
		sizeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			const sizes: CardSize[] = ['S', 'M', 'L'];
			const nextIdx = (sizes.indexOf(currentSize) + 1) % sizes.length;
			const nextSize = sizes[nextIdx]!;
			callbacks.onCardSizeChange(card.id, nextSize);
		});
	}

	// Widget cards (weather/tracker) keep their accent picker; memo cards
	// dropped theirs (Rae: the palette key read as clutter — the sticky card
	// type modal owns styling choices now). Saved memo colors still render.
	if (isWidget) {
		const colorBtn = actions.createEl('button', {
			cls: 'dashboard-card-btn dashboard-card-btn--color',
			attr: { 'aria-label': t('renderer.setMemoColor') },
		});
		setIcon(colorBtn, 'palette');
		if (card.color) {
			colorBtn.style.color = card.color;
		}
		colorBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			const input = createEl('input');
			input.type = 'color';
			input.value = card.color || '#f59e0b';
			input.setCssProps({
				position: 'absolute',
				opacity: '0',
				width: '0',
				height: '0',
			});
			activeDocument.body.appendChild(input);
			input.addEventListener('input', () => {
				callbacks.onMemoColorChange(card, input.value);
			});
			input.addEventListener('change', () => {
				if (input.value) {
					callbacks.onMemoColorChange(card, input.value);
				}
				input.remove();
			});
			input.addEventListener('blur', () => {
				input.remove();
			});
			input.click();
		});
	}

	// Per-card "new note" (notes sections only): creates a note and attaches it
	// to this card's doc list (view.handleCardNewNote). Rendered FIRST in the
	// actions row so it sits left of edit + delete. The click point anchors the
	// template menu when the section lists several templates.
	if (isProjectLike && sectionType === 'projects') {
		const newNoteBtn = actions.createEl('button', {
			cls: 'dashboard-card-btn dashboard-card-btn--newnote',
			attr: { 'aria-label': t('renderer.cardNewNote') },
		});
		setIcon(newNoteBtn, 'file-plus');
		newNoteBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			callbacks.onCardNewNote(card.id, { x: e.clientX, y: e.clientY });
		});
	}

	if (!skipEditBtn) {
		const editBtn = actions.createEl('button', {
			cls: 'dashboard-card-btn',
			attr: { 'aria-label': t('renderer.editCard') },
		});
		setIcon(editBtn, 'pencil');
		editBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			callbacks.onCardEdit(card);
		});
	}

	if (isMemo) {
		const saveBtn = actions.createEl('button', {
			cls: 'dashboard-card-btn',
			attr: { 'aria-label': t('renderer.saveMemoAsNote') },
		});
		setIcon(saveBtn, 'file-down');
		saveBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			callbacks.onMemoSaveAsNote(card);
		});
	}

	if (isTask) {
		const saveBtn = actions.createEl('button', {
			cls: 'dashboard-card-btn',
			attr: { 'aria-label': t('renderer.saveTasksToDaily') },
		});
		setIcon(saveBtn, 'save');
		saveBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			callbacks.onTaskSaveToDaily(card);
		});

		// Task-list per-card config. The options outgrew a dropdown menu
		// (completion behavior, daily-note task source, heading level), so the
		// gear opens a proper dialog that saves all three in one write.
		const cfgBtn = actions.createEl('button', {
			cls: 'dashboard-card-btn',
			attr: { 'aria-label': t('renderer.taskListBehavior') },
		});
		setIcon(cfgBtn, 'settings-2');
		cfgBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			new TaskCardConfigModal(app, card, (config) => {
				callbacks.onTaskCardConfigSave?.(card, config);
			}).open();
		});
	}

	// One-click pin-to-top: moves the card to the first slot of its section
	// (sticky sections have no sort mode — array order is the display order).
	if (sectionType === 'sticky') {
		const pinBtn = actions.createEl('button', {
			cls: 'dashboard-card-btn',
			attr: { 'aria-label': t('renderer.pinToTop') },
		});
		setIcon(pinBtn, 'pin');
		pinBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			callbacks.onCardPinTop(card.id, columnName);
		});
	}

	const deleteBtn = actions.createEl('button', {
		cls: 'dashboard-card-btn dashboard-card-btn--danger',
		attr: { 'aria-label': t('renderer.deleteCard') },
	});
	setIcon(deleteBtn, 'trash-2');
	deleteBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		callbacks.onCardDelete(card.id);
	});

	const body = el.createDiv({ cls: 'dashboard-card-body' });

	// When this is a project-like card, allow dropping docs onto the card body
	if (isProjectLike) {
		body.addEventListener('dragover', (e) => {
			const src = currentDocDragSource();
			if (!src) return;
			if (src.cardId === card.id) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
			body.addClass('dashboard-card-body--doc-drop');
		});

		body.addEventListener('dragleave', (e) => {
			if (!body.contains(e.relatedTarget as Node)) {
				body.removeClass('dashboard-card-body--doc-drop');
			}
		});

		body.addEventListener('drop', (e) => {
			body.removeClass('dashboard-card-body--doc-drop');
			const src = currentDocDragSource();
			if (!src) return;
			if (src.cardId === card.id) return;
			if (e.defaultPrevented) return;
			e.preventDefault();
			const destPath = [card.docs.length];
			callbacks.onDocMoveToCard(src.cardId, src.docPath, card.id, destPath, 'before');
		});
	}

	renderCardBody(body, card, columnName, sectionType, callbacks, app, data, settings);

	if (card.dueDate) {
		const due = el.createDiv({ cls: 'dashboard-card-due' });
		due.createSpan({ text: card.dueDate });
	}

	if (isMemo) {
		if (card.width > 0) {
			const w = Math.max(200, Math.min(600, card.width));
			el.style.flex = `0 0 ${w}px`;
			el.style.minWidth = `${w}px`;
			el.style.maxWidth = `${w}px`;
		}
	}

	// Dashboard grid layout for widget cards (styles only, button already created above)
	if (isWidget && isDashboardSection) {
		// grid styles already set above when creating the size button
	} else if (isMemo || isTask || isProjectLike) {
		const minW = 200;
		const maxW = 600;
		if (!isMemo && card.width > 0) {
			const w = Math.max(minW, Math.min(500, card.width));
			el.style.flex = `0 0 ${w}px`;
			el.style.minWidth = `${w}px`;
			el.style.maxWidth = `${w}px`;
		}
		const handle = el.createDiv({ cls: 'dashboard-card-resize-handle' });
		handle.addEventListener('mousedown', (e) => {
			e.preventDefault();
			e.stopPropagation();
			const startX = e.clientX;
			const startWidth = el.offsetWidth;
			el.addClass('dashboard-card--resizing');

			const onMove = (ev: MouseEvent) => {
				const delta = ev.clientX - startX;
				const newWidth = Math.max(minW, Math.min(maxW, startWidth + delta));
				el.style.flex = `0 0 ${newWidth}px`;
				el.style.minWidth = `${newWidth}px`;
				el.style.maxWidth = `${newWidth}px`;
			};

			const onUp = (ev: MouseEvent) => {
				activeDocument.removeEventListener('mousemove', onMove);
				activeDocument.removeEventListener('mouseup', onUp);
				el.removeClass('dashboard-card--resizing');
				const finalWidth = Math.max(minW, Math.min(maxW, startWidth + (ev.clientX - startX)));
				if (finalWidth !== card.width) {
					callbacks.onCardWidthChange(card.id, finalWidth);
				}
			};

			activeDocument.addEventListener('mousemove', onMove);
			activeDocument.addEventListener('mouseup', onUp);
		});
	}

	return el;
}

/**
 * Whether a card renders as a memo card. In sticky ("便利贴") sections the
 * generic/note cards do — task cards stay todo cards (checked before memo
 * via `card.type === 'task'`).
 */
function isMemoCard(sectionType: string, card: DashboardCard): boolean {
	return sectionType === 'sticky' && (card.type === 'generic' || card.type === 'note');
}

export function renderCardBody(container: HTMLElement, card: DashboardCard, columnName: string, sectionType: string, callbacks: RenderCallbacks, app: App, data?: DashboardData, settings?: DashboardSettings): void {
	if (card.type === 'weather') {
		renderWeatherBody(container, card, app);
		return;
	}

	if (card.type === 'tracker') {
		renderTrackerBody(container, card, app, settings);
		return;
	}

	const isMemo = isMemoCard(sectionType, card);
	const isTaskCard = !isMemo && card.type === 'task';

	if (isTaskCard) {
		renderTaskBody(container, card, callbacks, app);
		return;
	}

	if (isMemo) {
		renderMemoBody(container, card, callbacks, app);
		return;
	}

	// All non-memo, non-task cards render as project body
	renderProjectBody(container, card, callbacks, app);
}

function renderWeatherInto(el: HTMLElement, card: DashboardCard): void {
	if (!card.weatherConfig) return;

	const cached = getCachedWeather(card.weatherConfig);
	if (cached) {
		renderWeatherContent(el, cached, card.weatherConfig.cityName);
	} else {
		el.createDiv({ cls: 'dashboard-weather-loading', text: '...' });
		fetchWeather(card.weatherConfig).then(data => {
			el.empty();
			renderWeatherContent(el, data, card.weatherConfig!.cityName);
		}).catch(() => {
			el.empty();
			el.createDiv({ cls: 'dashboard-weather-error', text: t('weather.fetchError') });
		});
	}
}

function renderWeatherBody(container: HTMLElement, card: DashboardCard, app: App): void {
	if (!card.weatherConfig) return;

	const el = container.createDiv({ cls: 'dashboard-weather' });
	renderWeatherInto(el, card);
}

// Locally refresh every weather card in place, without rebuilding the whole
// dashboard. Caller must clearWeatherCache() first so cached data is refetched.
export function refreshWeatherCards(root: HTMLElement, data: DashboardData): void {
	for (const column of data.columns) {
		for (const card of column.cards) {
			if (card.type !== 'weather' || !card.weatherConfig) continue;
			const cardEl = root.querySelector(`[data-card-id="${CSS.escape(card.id)}"]`);
			if (!(cardEl instanceof HTMLElement)) continue;
			const weatherEl = cardEl.querySelector('.dashboard-weather');
			if (!(weatherEl instanceof HTMLElement)) continue;
			weatherEl.empty();
			renderWeatherInto(weatherEl, card);
		}
	}
}

function renderWeatherContent(el: HTMLElement, data: import('../types').WeatherData, cityName: string): void {
	const current = el.createDiv({ cls: 'dashboard-weather-current' });
	const tempWrap = current.createDiv({ cls: 'dashboard-weather-temp-wrap' });
	tempWrap.createDiv({ cls: 'dashboard-weather-temp', text: `${Math.round(data.temperature)}\u00B0` });
	tempWrap.createDiv({ cls: 'dashboard-weather-icon', text: getWeatherEmoji(data.weatherCode) });

	const details = current.createDiv({ cls: 'dashboard-weather-details' });
	details.createDiv({ cls: 'dashboard-weather-city', text: cityName });
	details.createDiv({ cls: 'dashboard-weather-desc', text: getWeatherDescription(data.weatherCode) });
	const metaLine = details.createDiv({ cls: 'dashboard-weather-wind' });
	metaLine.createSpan({ text: `${t('weather.feelsLike')} ${Math.round(data.feelsLike)}\u00B0  ${t('weather.humidity')} ${Math.round(data.humidity)}%  ${t('weather.wind')} ${Math.round(data.windSpeed)} km/h` });

	if (data.dailyDates.length > 0) {
		const forecast = el.createDiv({ cls: 'dashboard-weather-forecast' });
		const count = Math.min(data.dailyDates.length, 5);
		for (let i = 0; i < count; i++) {
			const day = forecast.createDiv({ cls: 'dashboard-weather-day' });
			const d = new Date(data.dailyDates[i]! + 'T00:00:00');
			const dayName = d.toLocaleDateString(getLocale(), { weekday: 'short' });
			day.createDiv({ cls: 'dashboard-weather-day-name', text: dayName });
			day.createDiv({ cls: 'dashboard-weather-day-icon', text: getWeatherEmoji(data.dailyCodes[i]!) });
			day.createDiv({ cls: 'dashboard-weather-day-temps', text: `${Math.round(data.dailyMax[i]!)}\u00B0 / ${Math.round(data.dailyMin[i]!)}\u00B0` });
		}
	}
}

function renderTrackerBody(container: HTMLElement, card: DashboardCard, app: App, settings?: import('../types').DashboardSettings): void {
	if (!card.trackerConfig) return;

	const config = card.trackerConfig;
		const size: CardSize = card.size || 'M';
	const style: TrackerStyle = config.style || 'line';
	destroyChart(card.id);

	const el = container.createDiv({ cls: `dashboard-tracker dashboard-tracker--${size}` });

	const data = readTrackerData(app, '', config.key, config.days);
	const validPoints = data.filter(p => p.value !== null);

	if (validPoints.length === 0) {
		el.createDiv({ cls: 'dashboard-tracker-empty', text: t('tracker.noData') + ': ' + config.key });
		return;
	}

	const values = data.map(p => p.value);
	const minVal = Math.min(...values.filter((v): v is number => v !== null));
	const maxVal = Math.max(...values.filter((v): v is number => v !== null));
	const sum = validPoints.reduce((s, p) => s + p.value!, 0);
	const avg = (sum / validPoints.length).toFixed(1);
	const latest = validPoints[validPoints.length - 1]!.value as number;
	const prev = validPoints.length > 1 ? validPoints[validPoints.length - 2]!.value as number : latest;
	const trendDir = latest > prev ? 'up' : latest < prev ? 'down' : 'flat';
	const trendPct = prev !== 0 ? ((latest - prev) / Math.abs(prev) * 100).toFixed(1) : '0';

	// Streak: consecutive days with data (from latest backward, today optional)
	const streak = computeStreak(data);

	if (size === 'S') {
		const row = el.createDiv({ cls: 'dashboard-tracker-compact' });
		row.createDiv({ cls: 'dashboard-tracker-compact-value', text: String(latest) });
		const arrow = row.createDiv({ cls: `dashboard-tracker-trend dashboard-tracker-trend--${trendDir}` });
		arrow.setText(trendDir === 'up' ? '↑' : trendDir === 'down' ? '↓' : '→');
		if (config.key) {
			row.createDiv({ cls: 'dashboard-tracker-compact-label', text: config.key });
		}
		return;
	}

	const accentColor = getCSSVar('--db-accent') || '#6366f1';

	// Dispatch by style
	if (style === 'heatmap') {
		renderTrackerHeatmap(el, data, minVal, maxVal, size, accentColor);
	} else if (style === 'bar') {
		renderTrackerBarChart(el, data, size, accentColor, card.id);
	} else {
		renderTrackerLineChart(el, data, size, accentColor, card.id);
	}

	// Stats
	const stats = el.createDiv({ cls: 'dashboard-tracker-stats' });
	const addStat = (label: string, value: string | number) => {
		const stat = stats.createDiv({ cls: 'dashboard-tracker-stat' });
		stat.createSpan({ cls: 'dashboard-tracker-stat-label', text: label });
		stat.createSpan({ cls: 'dashboard-tracker-stat-value', text: String(value) });
	};
	addStat(t('tracker.current'), latest);
	addStat(t('tracker.avg'), avg);

	if (size === 'M') {
		addStat(t('tracker.trend'), `${trendDir === 'up' ? '+' : ''}${trendPct}%`);
	}

	if (size === 'L') {
		addStat(t('tracker.trend'), `${trendDir === 'up' ? '+' : ''}${trendPct}%`);
		addStat(t('tracker.streak'), `${streak}d`);
		addStat(t('tracker.min'), minVal);
		addStat(t('tracker.max'), maxVal);
	}
}
