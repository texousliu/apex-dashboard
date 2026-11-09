/**
 * Reading-tracker sidebar widget + its four modals (end session, edit book
 * info, book search, reading stats).
 *
 * Moved verbatim out of renderer.ts (Phase 4, "只搬不改"): the cluster only
 * talks to ReadingService and the book search service, so it had no reason to
 * live in the file that also owns the whole dashboard layout.
 */
import { setIcon } from 'obsidian';
import { t } from '../i18n';
import { applyModalTheme } from '../modal-theme';
import type { ReadingService } from '../reading-service';
import { searchBooks, resolveCoverAsObjectUrl } from '../book-service';
import { formatTime } from './time-format';

function formatReadingDuration(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const mins = Math.floor((totalSeconds % 3600) / 60);
	if (hours > 0 && mins > 0) return t('reading.timeHM', { h: hours, m: mins });
	if (hours > 0) return t('reading.hours', { count: hours });
	return t('reading.minutes', { count: Math.max(1, mins) });
}

function formatShortDuration(totalSeconds: number): string {
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	if (h > 0) return `${h}h${m > 0 ? m + 'm' : ''}`;
	return `${Math.max(1, m)}m`;
}

export function renderSidebarReading(
	container: HTMLElement,
	service: ReadingService,
): void {
	const widget = container.createDiv({ cls: 'dashboard-sidebar-widget dashboard-sidebar-reading' });

	// Title row
	const titleRow = widget.createDiv({ cls: 'dashboard-reading-title-row' });
	titleRow.createDiv({ cls: 'dashboard-reading-title', text: t('reading.title') });
	titleRow.createDiv({ cls: 'dashboard-reading-title-spacer' });
	const addBtn = titleRow.createDiv({ cls: 'dashboard-reading-add-btn' });
	setIcon(addBtn, 'plus');
	const statsBtn = titleRow.createDiv({ cls: 'dashboard-reading-stats-btn' });
	setIcon(statsBtn, 'bar-chart-2');

	// Book cards scroll area
	const scrollArea = widget.createDiv({ cls: 'dashboard-reading-scroll' });

	const state = service.getState();
	const activeBooks = service.getActiveBooks();

	for (const book of activeBooks) {
		const isActive = state.status !== 'idle' && state.currentBook?.title === book.title;
		const isRunning = isActive && state.status === 'running';
		const card = scrollArea.createDiv({
			cls: 'dashboard-reading-book-card' + (isActive ? ' dashboard-reading-book-card--active' : ''),
		});

		// Cover - always show title fallback, async load real cover
		const coverWrap = card.createDiv({ cls: 'dashboard-reading-book-card-cover-wrap' });
		const placeholder = coverWrap.createDiv({ cls: 'dashboard-reading-book-card-cover-placeholder' });
		placeholder.textContent = book.title.length > 8 ? book.title.slice(0, 8) + '..' : book.title;
		if (book.coverUrl) {
			void resolveCoverAsObjectUrl(book.coverUrl, service.getApp()).then(blobUrl => {
				if (blobUrl) {
					placeholder.setCssProps({ display: 'none' });
					coverWrap.style.backgroundImage = `url(${blobUrl})`;
				}
			});
		}

		// Info area
		const info = card.createDiv({ cls: 'dashboard-reading-book-card-info' });
		info.createDiv({ cls: 'dashboard-reading-book-card-title', text: book.title });
		if (book.author) {
			info.createDiv({ cls: 'dashboard-reading-book-card-author', text: book.author });
		}

		// Timer row
		const timerRow = info.createDiv({ cls: 'dashboard-reading-book-card-timer' });

		if (isActive) {
			timerRow.createDiv({
				cls: 'dashboard-reading-book-card-time dashboard-reading-book-card-time--active',
				text: formatTime(state.elapsedSeconds),
			});
		} else {
			const todaySec = service.getTodaySecondsForBook(book.title);
			timerRow.createDiv({
				cls: 'dashboard-reading-book-card-time',
				text: todaySec > 0 ? formatShortDuration(todaySec) : '--',
			});
		}

		// Play/pause/stop buttons
		const actions = timerRow.createDiv({ cls: 'dashboard-reading-book-card-actions' });

		if (isRunning) {
			const pauseBtn = actions.createDiv({ cls: 'dashboard-reading-book-card-btn dashboard-reading-book-card-btn--pause' });
			setIcon(pauseBtn, 'pause');
			pauseBtn.addEventListener('click', (e) => { e.stopPropagation(); service.pause(); refreshCards(); });
			const stopBtn = actions.createDiv({ cls: 'dashboard-reading-book-card-btn dashboard-reading-book-card-btn--stop' });
			setIcon(stopBtn, 'square');
			stopBtn.addEventListener('click', (e) => { e.stopPropagation(); service.pause(); showEndModal(book); });
		} else if (isActive && state.status === 'paused') {
			const resumeBtn = actions.createDiv({ cls: 'dashboard-reading-book-card-btn dashboard-reading-book-card-btn--play' });
			setIcon(resumeBtn, 'play');
			resumeBtn.addEventListener('click', (e) => { e.stopPropagation(); service.resume(); refreshCards(); });
			const stopBtn = actions.createDiv({ cls: 'dashboard-reading-book-card-btn dashboard-reading-book-card-btn--stop' });
			setIcon(stopBtn, 'square');
			stopBtn.addEventListener('click', (e) => { e.stopPropagation(); showEndModal(book); });
		} else {
			const playBtn = actions.createDiv({ cls: 'dashboard-reading-book-card-btn dashboard-reading-book-card-btn--play' });
			setIcon(playBtn, 'play');
			playBtn.addEventListener('click', (e) => { e.stopPropagation(); service.startReading(book); refreshCards(); });
		}

		// Progress bar
		if (book.totalPages > 0) {
			const progressWrap = info.createDiv({ cls: 'dashboard-reading-book-card-progress' });
			const pct = book.finished ? 100 : Math.min(100, Math.round((book.currentPage / book.totalPages) * 100));
			const progressBar = progressWrap.createDiv({ cls: 'dashboard-reading-book-card-progress-bar' });
			progressBar.createDiv({
				cls: 'dashboard-reading-book-card-progress-fill' + (book.finished ? ' dashboard-reading-book-card-progress-fill--done' : ''),
				attr: { style: `width:${pct}%` },
			});
			progressWrap.createDiv({
				cls: 'dashboard-reading-book-card-progress-text',
				text: book.finished ? '100%' : `${book.currentPage}/${book.totalPages}`,
			});
		}

		// Action buttons (edit / remove)
		const editBtn = card.createDiv({ cls: 'dashboard-reading-book-card-action dashboard-reading-book-card-edit' });
		setIcon(editBtn, 'pencil');
		editBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			openEditBookInfo(widget.ownerDocument, service, book, () => refreshCards());
		});

		const removeBtn = card.createDiv({ cls: 'dashboard-reading-book-card-action dashboard-reading-book-card-remove' });
		setIcon(removeBtn, 'x');
		removeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			void service.removeActiveBook(book.title).then(() => refreshCards());
		});
	}

	// Timer tick - update active timer display
	service.setOnTick(() => {
		const s = service.getState();
		if (s.status === 'running') {
			const activeTime = scrollArea.querySelector('.dashboard-reading-book-card-time--active');
			if (activeTime) activeTime.textContent = formatTime(s.elapsedSeconds);
		}
	});

	addBtn.addEventListener('click', () => {
		openBookSearch(widget.ownerDocument, service, (book) => {
			if (book) void service.addActiveBook(book).then(() => refreshCards());
		});
	});

	statsBtn.addEventListener('click', () => {
		showReadingStats(widget.ownerDocument, service);
	});

	function showEndModal(book: import('../reading-service').BookInfo): void {
		const elapsed = service.getElapsedSeconds();
		openEndReadingModal(widget.ownerDocument, service, book, elapsed, () => refreshCards());
	}

	function refreshCards(): void {
		refreshSidebarReadingWidget(widget.ownerDocument, service);
	}
}

/** Re-render every live reading widget (desktop sidebar + mobile drawer
 *  copies) from scratch. Used after mutations that outlive a single card
 *  (session finished, book added/removed) — also by the floating mini
 *  reading timer, which lives outside the widget's closure. */
export function refreshSidebarReadingWidget(doc: Document, service: ReadingService): void {
	const widgets = Array.from(doc.querySelectorAll<HTMLElement>('.dashboard-sidebar-reading'));
	if (widgets.length === 0) return;
	service.setOnTick(null);
	for (const w of widgets) {
		const parent = w.parentElement;
		if (!parent) continue;
		w.remove();
		renderSidebarReading(parent, service);
	}
}

export function openEndReadingModal(
	doc: Document,
	service: ReadingService,
	book: import('../reading-service').BookInfo,
	elapsedSeconds: number,
	onDone: () => void,
): void {
	const overlay = doc.body.createDiv({ cls: 'dashboard-reading-end-overlay' });
	const modal = overlay.createDiv({ cls: 'dashboard-reading-end-modal' });
	applyModalTheme(modal);

	function close() {
		doc.removeEventListener('keydown', onKey);
		overlay.remove();
	}
	function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
	doc.addEventListener('keydown', onKey);
	overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

	// Header
	const header = modal.createDiv({ cls: 'dashboard-reading-end-header' });
	header.createDiv({ cls: 'dashboard-reading-end-title', text: t('reading.endTitle') });
	const closeBtn = header.createDiv({ cls: 'dashboard-reading-end-close' });
	setIcon(closeBtn, 'x');
	closeBtn.addEventListener('click', close);

	// Body
	const body = modal.createDiv({ cls: 'dashboard-reading-end-body' });

	// Date row
	const dateRow = body.createDiv({ cls: 'dashboard-reading-end-row' });
	dateRow.createDiv({ cls: 'dashboard-reading-end-label', text: t('reading.endDate') });
	const now = new Date();
	dateRow.createDiv({
		cls: 'dashboard-reading-end-value',
		text: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
	});

	// Duration row
	const durRow = body.createDiv({ cls: 'dashboard-reading-end-row' });
	durRow.createDiv({ cls: 'dashboard-reading-end-label', text: t('reading.endDuration') });
	durRow.createDiv({ cls: 'dashboard-reading-end-value', text: formatReadingDuration(elapsedSeconds) });

	// Progress section
	const progressSection = body.createDiv({ cls: 'dashboard-reading-end-section' });
	progressSection.createDiv({ cls: 'dashboard-reading-end-section-title', text: t('reading.endProgress') });

	// Mode toggle: page / percentage
	let progressMode: 'page' | 'pct' = book.totalPages > 0 ? 'page' : 'pct';
	const modeToggle = progressSection.createDiv({ cls: 'dashboard-reading-end-mode-toggle' });
	const pageModeBtn = modeToggle.createDiv({
		cls: 'dashboard-reading-end-mode-btn' + (progressMode === 'page' ? ' dashboard-reading-end-mode-btn--active' : ''),
		text: t('reading.endModePage'),
	});
	const pctModeBtn = modeToggle.createDiv({
		cls: 'dashboard-reading-end-mode-btn' + (progressMode === 'pct' ? ' dashboard-reading-end-mode-btn--active' : ''),
		text: t('reading.endModePct'),
	});

	// Inputs container
	const inputsContainer = progressSection.createDiv({ cls: 'dashboard-reading-end-inputs' });

	function renderInputs(): void {
		inputsContainer.empty();
		const pageRow = inputsContainer.createDiv({ cls: 'dashboard-reading-end-page-row' });

		// Start value (readonly)
		const startCol = pageRow.createDiv({ cls: 'dashboard-reading-end-page-col' });
		startCol.createDiv({ cls: 'dashboard-reading-end-page-label', text: t('reading.endStartPage') });
		const startVal = progressMode === 'pct'
			? (book.totalPages > 0 ? Math.round((book.currentPage / book.totalPages) * 100) : 0)
			: book.currentPage;
		const suffix = progressMode === 'pct' ? '%' : '';
		startCol.createDiv({ cls: 'dashboard-reading-end-page-readonly', text: `${startVal}${suffix}` });

		pageRow.createDiv({ cls: 'dashboard-reading-end-page-arrow' });

		// End value (input)
		const endCol = pageRow.createDiv({ cls: 'dashboard-reading-end-page-col' });
		endCol.createDiv({ cls: 'dashboard-reading-end-page-label', text: t('reading.endEndPage') });
		const endInput = endCol.createEl('input', {
			cls: 'dashboard-reading-end-page-input',
			attr: {
				type: 'number',
				min: '0',
				max: progressMode === 'pct' ? '100' : '',
				placeholder: progressMode === 'pct' ? '0%' : '0',
			},
		});
		endInput.focus();

		// Total pages row (page mode, unknown total)
		if (progressMode === 'page' && !book.totalPages) {
			const totalRow = inputsContainer.createDiv({ cls: 'dashboard-reading-end-total-row' });
			totalRow.createDiv({ cls: 'dashboard-reading-end-page-label', text: t('reading.endTotalPages') });
			totalRow.createEl('input', {
				cls: 'dashboard-reading-end-page-input dashboard-reading-end-page-input--total',
				attr: { type: 'number', min: '0', placeholder: '?' },
			});
		}
	}
	renderInputs();

	pageModeBtn.addEventListener('click', () => {
		progressMode = 'page';
		pageModeBtn.addClass('dashboard-reading-end-mode-btn--active');
		pctModeBtn.removeClass('dashboard-reading-end-mode-btn--active');
		renderInputs();
	});
	pctModeBtn.addEventListener('click', () => {
		progressMode = 'pct';
		pctModeBtn.addClass('dashboard-reading-end-mode-btn--active');
		pageModeBtn.removeClass('dashboard-reading-end-mode-btn--active');
		renderInputs();
	});

	// Finished checkbox
	const finishedRow = body.createDiv({ cls: 'dashboard-reading-end-finished' });
	const checkbox = finishedRow.createEl('input', {
		cls: 'dashboard-reading-end-checkbox',
		attr: { type: 'checkbox', id: 'reading-finished' },
	});
	const checkLabel = finishedRow.createEl('label', {
		cls: 'dashboard-reading-end-checkbox-label',
		attr: { for: 'reading-finished' },
	});
	checkLabel.textContent = t('reading.endMarkFinished');

	// Footer
	const footer = modal.createDiv({ cls: 'dashboard-reading-end-footer' });

	footer.createEl('button', {
		cls: 'dashboard-reading-end-btn dashboard-reading-end-btn--cancel',
		text: t('reading.endCancel'),
	}).addEventListener('click', close);

	footer.createEl('button', {
		cls: 'dashboard-reading-end-btn dashboard-reading-end-btn--discard',
		text: t('reading.endDiscard'),
	}).addEventListener('click', () => {
		service.discardSession();
		close();
		onDone();
	});

	footer.createEl('button', {
		cls: 'dashboard-reading-end-btn dashboard-reading-end-btn--confirm',
		text: t('reading.endConfirm'),
	}).addEventListener('click', () => {
		void (async () => {
			const endInput = inputsContainer.querySelector<HTMLInputElement>('.dashboard-reading-end-page-input:not(.dashboard-reading-end-page-input--total)');
			const totalInput = inputsContainer.querySelector<HTMLInputElement>('.dashboard-reading-end-page-input--total');
			const endVal = parseInt(endInput?.value || '0') || 0;
			const finished = checkbox.checked;

			let endPage: number;
			let totalPages = book.totalPages;

			if (progressMode === 'pct') {
				if (totalPages > 0) {
					endPage = Math.round((Math.min(endVal, 100) / 100) * totalPages);
				} else {
					endPage = Math.min(endVal, 100);
					totalPages = 100;
				}
			} else {
				endPage = endVal;
				if (totalInput) {
					totalPages = parseInt(totalInput.value) || 0;
				}
			}

			await service.finishSession(endPage, totalPages, finished);
			close();
			onDone();
		})();
	});
}

function openEditBookInfo(
	doc: Document,
	service: ReadingService,
	book: import('../reading-service').BookInfo,
	onDone: () => void,
): void {
	const overlay = doc.body.createDiv({ cls: 'dashboard-reading-end-overlay' });
	const modal = overlay.createDiv({ cls: 'dashboard-reading-end-modal' });
	applyModalTheme(modal);

	function close() {
		doc.removeEventListener('keydown', onKey);
		overlay.remove();
	}
	function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
	doc.addEventListener('keydown', onKey);
	overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

	const header = modal.createDiv({ cls: 'dashboard-reading-end-header' });
	header.createDiv({ cls: 'dashboard-reading-end-title', text: t('reading.editTitle') });
	const closeBtn = header.createDiv({ cls: 'dashboard-reading-end-close' });
	setIcon(closeBtn, 'x');
	closeBtn.addEventListener('click', close);

	const body = modal.createDiv({ cls: 'dashboard-reading-end-body' });

	body.createDiv({ cls: 'dashboard-reading-end-label', text: t('reading.editBookName') });
	const titleInput = body.createEl('input', {
		cls: 'dashboard-reading-end-input',
		attr: { type: 'text' },
	});
	titleInput.value = book.title;

	body.createDiv({ cls: 'dashboard-reading-end-label', text: t('reading.editAuthorName') });
	const authorInput = body.createEl('input', {
		cls: 'dashboard-reading-end-input',
		attr: { type: 'text' },
	});
	authorInput.value = book.author;

	body.createDiv({ cls: 'dashboard-reading-end-label', text: t('reading.editTotalPages') });
	const pagesInput = body.createEl('input', {
		cls: 'dashboard-reading-end-input',
		attr: { type: 'number', min: '0' },
	});
	pagesInput.value = String(book.totalPages || '');

	body.createDiv({ cls: 'dashboard-reading-end-label', text: t('reading.editCoverUrl') });
	const coverInput = body.createEl('input', {
		cls: 'dashboard-reading-end-input',
		attr: { type: 'text', placeholder: t('reading.editCoverPlaceholder') },
	});
	coverInput.value = book.coverUrl;

	const footer = modal.createDiv({ cls: 'dashboard-reading-end-footer' });
	const saveBtn = footer.createEl('button', {
		cls: 'dashboard-reading-end-btn dashboard-reading-end-btn--confirm',
		text: t('reading.editConfirm'),
	});
	footer.createEl('button', {
		cls: 'dashboard-reading-end-btn dashboard-reading-end-btn--cancel',
		text: t('reading.endCancel'),
	}).addEventListener('click', close);

	const deleteBtn = footer.createEl('button', {
		cls: 'dashboard-reading-end-btn dashboard-reading-end-btn--delete',
		text: t('reading.editDeleteBook'),
	});
	deleteBtn.addEventListener('click', () => {
		void (async () => {
			await service.removeActiveBook(book.title);
			close();
			onDone();
		})();
	});

	saveBtn.addEventListener('click', () => {
		void (async () => {
			const newTitle = titleInput.value.trim();
			if (!newTitle) return;

			await service.updateBookInfo(book.title, {
				title: newTitle,
				author: authorInput.value.trim(),
				coverUrl: coverInput.value.trim(),
				totalPages: parseInt(pagesInput.value) || 0,
			});
			close();
			onDone();
		})();
	});

	titleInput.focus();
}

function openBookSearch(
	doc: Document,
	service: ReadingService,
	onSelect: (book: import('../reading-service').BookInfo | null) => void,
): void {
	const overlay = doc.body.createDiv({ cls: 'dashboard-reading-book-overlay' });
	const modal = overlay.createDiv({ cls: 'dashboard-reading-book-modal' });
	applyModalTheme(modal);

	function close() {
		doc.removeEventListener('keydown', onKey);
		overlay.remove();
	}
	function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
	doc.addEventListener('keydown', onKey);

	overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

	const header = modal.createDiv({ cls: 'dashboard-reading-book-header' });
	header.createDiv({ cls: 'dashboard-reading-book-header-title', text: t('reading.selectBook') });
	const closeBtn = header.createDiv({ cls: 'dashboard-reading-book-close' });
	setIcon(closeBtn, 'x');
	closeBtn.addEventListener('click', close);

	const inputArea = modal.createDiv({ cls: 'dashboard-reading-book-input-area' });
	const input = inputArea.createEl('input', {
		cls: 'dashboard-reading-book-input',
		attr: { type: 'text', placeholder: t('reading.searchBook') },
	});
	input.focus();

	const resultsArea = modal.createDiv({ cls: 'dashboard-reading-book-results' });

	// Manual input row (always at bottom)
	const manualRow = resultsArea.createDiv({ cls: 'dashboard-reading-book-manual' });
	manualRow.createDiv({ cls: 'dashboard-reading-book-manual-label', text: t('reading.manualInput') });
	const manualInput = manualRow.createEl('input', {
		cls: 'dashboard-reading-book-manual-input',
		attr: { type: 'text', placeholder: t('reading.manualPlaceholder') },
	});
	const manualBtn = manualRow.createEl('button', {
		cls: 'dashboard-reading-book-manual-btn',
		text: 'OK',
	});
	manualBtn.addEventListener('click', () => {
		const val = manualInput.value.trim();
		if (val) {
			onSelect({ title: val, author: '', coverUrl: '', isbn: '', source: 'manual', currentPage: 0, totalPages: 0, finished: false });
			close();
		}
	});

	let searchTimer: number | null = null;
	let searching = false;

	input.addEventListener('input', () => {
		if (searchTimer) window.clearTimeout(searchTimer);
		const query = input.value.trim();

		// Remove previous search results (keep manual row)
		while (resultsArea.firstChild && resultsArea.firstChild !== manualRow) {
			resultsArea.removeChild(resultsArea.firstChild);
		}

		if (!query) return;

		const indicator = resultsArea.createDiv({ cls: 'dashboard-reading-book-searching', text: t('reading.searching') });
		resultsArea.insertBefore(indicator, manualRow);

		searchTimer = window.setTimeout(() => {
			void (async () => {
				if (searching) return;
				searching = true;

				let results: import('../book-service').BookSearchResult[] = [];
				try {
					results = await searchBooks(query);
				} catch {
					results = [];
				}
				searching = false;

				// Remove previous results
				while (resultsArea.firstChild && resultsArea.firstChild !== manualRow) {
					resultsArea.removeChild(resultsArea.firstChild);
				}

				if (results.length === 0) {
					const noResult = resultsArea.createDiv({ cls: 'dashboard-reading-book-no-results', text: t('reading.noResults') });
					resultsArea.insertBefore(noResult, manualRow);
					return;
				}

				for (const book of results) {
					const item = resultsArea.createDiv({ cls: 'dashboard-reading-book-item' });
					if (book.coverUrl) {
						const c = item.createDiv({ cls: 'dashboard-reading-book-item-cover' });
						void resolveCoverAsObjectUrl(book.coverUrl, service.getApp()).then(url => { if (url) c.style.backgroundImage = `url(${url})`; });
					} else {
						item.createDiv({ cls: 'dashboard-reading-book-item-nocover' });
					}
					const info = item.createDiv({ cls: 'dashboard-reading-book-item-info' });
					info.createDiv({ cls: 'dashboard-reading-book-item-title', text: book.title });
					if (book.author) {
						info.createDiv({ cls: 'dashboard-reading-book-item-author', text: book.author });
					}
					item.addEventListener('click', () => {
						onSelect({
							title: book.title, author: book.author, coverUrl: book.coverUrl,
							isbn: book.isbn, source: 'google', currentPage: 0, totalPages: 0, finished: false,
						});
						close();
					});
					resultsArea.insertBefore(item, manualRow);
				}
			})();
		}, 500);
	});
}

function showReadingStats(doc: Document, service: ReadingService): void {
	const overlay = doc.body.createDiv({ cls: 'dashboard-pomodoro-stats-overlay' });
	const modal = overlay.createDiv({ cls: 'dashboard-pomodoro-stats-modal' });
	applyModalTheme(modal);

	function close() {
		doc.removeEventListener('keydown', onKey);
		overlay.remove();
	}
	function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
	doc.addEventListener('keydown', onKey);
	overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

	const header = modal.createDiv({ cls: 'dashboard-pomodoro-stats-header' });
	header.createDiv({ cls: 'dashboard-pomodoro-stats-header-title', text: t('reading.statsTitle') });
	const closeBtn = header.createDiv({ cls: 'dashboard-pomodoro-stats-close' });
	setIcon(closeBtn, 'x');
	closeBtn.addEventListener('click', close);

	const content = modal.createDiv({ cls: 'dashboard-reading-stats-content' });

	function renderContent(): void {
		content.empty();

		// Summary card
		const summaryCard = content.createDiv({ cls: 'dashboard-reading-stats-card' });
		const summaryGrid = summaryCard.createDiv({ cls: 'dashboard-reading-stats-summary' });
		const totalItem = summaryGrid.createDiv({ cls: 'dashboard-reading-stats-summary-item' });
		totalItem.createDiv({ cls: 'dashboard-reading-stats-summary-value', text: formatReadingDuration(service.getTotalSeconds()) });
		totalItem.createDiv({ cls: 'dashboard-reading-stats-summary-label', text: t('reading.totalReading') });
		const todayItem = summaryGrid.createDiv({ cls: 'dashboard-reading-stats-summary-item' });
		todayItem.createDiv({ cls: 'dashboard-reading-stats-summary-value', text: formatReadingDuration(service.getTodaySeconds()) });
		todayItem.createDiv({ cls: 'dashboard-reading-stats-summary-label', text: t('reading.todayReading') });
		const bookItem = summaryGrid.createDiv({ cls: 'dashboard-reading-stats-summary-item' });
		bookItem.createDiv({ cls: 'dashboard-reading-stats-summary-value', text: String(service.getBookCountInRange(365)) });
		bookItem.createDiv({ cls: 'dashboard-reading-stats-summary-label', text: t('reading.bookCount') });
		const streakItem = summaryGrid.createDiv({ cls: 'dashboard-reading-stats-summary-item' });
		streakItem.createDiv({ cls: 'dashboard-reading-stats-summary-value', text: String(service.getStreak()) });
		streakItem.createDiv({ cls: 'dashboard-reading-stats-summary-label', text: t('reading.streakDays') });

		// Book list card
		const bookCard = content.createDiv({ cls: 'dashboard-reading-stats-card' });
		bookCard.createDiv({ cls: 'dashboard-reading-stats-card-title', text: t('reading.bookList') });
		const rangeToggle = bookCard.createDiv({ cls: 'dashboard-reading-stats-range' });
		const ranges: { key: string; label: string; days: number }[] = [
			{ key: 'week', label: t('reading.rangeWeek'), days: 7 },
			{ key: 'month', label: t('reading.rangeMonth'), days: 30 },
			{ key: 'year', label: t('reading.rangeYear'), days: 365 },
		];
		let activeRange = 'month';
		const toggleButtons = ranges.map(r => rangeToggle.createDiv({
			cls: 'dashboard-reading-stats-range-btn' + (r.key === activeRange ? ' dashboard-reading-stats-range-btn--active' : ''),
			text: r.label,
		}));
		const bookListContainer = bookCard.createDiv({ cls: 'dashboard-reading-book-list' });

		function renderBookList(rangeKey: string): void {
			bookListContainer.empty();
			const rangeInfo = ranges.find(r => r.key === rangeKey);
			if (!rangeInfo) return;
			const books = service.getBookBreakdownInRange(rangeInfo.days);
			if (books.length === 0) {
				bookListContainer.createDiv({ cls: 'dashboard-reading-stats-empty', text: t('reading.noRecords') });
				return;
			}
			for (const book of books) {
				const row = bookListContainer.createDiv({ cls: 'dashboard-reading-book-list-row' });
				if (book.coverUrl) {
					const c = row.createDiv({ cls: 'dashboard-reading-book-list-cover' });
					void resolveCoverAsObjectUrl(book.coverUrl, service.getApp()).then(url => {
						if (url) c.style.backgroundImage = `url(${url})`;
					});
				} else {
					row.createDiv({ cls: 'dashboard-reading-book-list-nocover' });
				}
				const info = row.createDiv({ cls: 'dashboard-reading-book-list-info' });
				info.createDiv({ cls: 'dashboard-reading-book-list-title', text: book.title });
				if (book.author) info.createDiv({ cls: 'dashboard-reading-book-list-author', text: book.author });
				const meta = row.createDiv({ cls: 'dashboard-reading-book-list-meta' });
				meta.createDiv({ cls: 'dashboard-reading-book-list-duration', text: formatReadingDuration(book.totalSeconds) });
				meta.createDiv({ cls: 'dashboard-reading-book-list-sessions', text: t('reading.times', { count: book.sessions }) });
				const del = meta.createDiv({ cls: 'dashboard-reading-stats-record-del' });
				setIcon(del, 'trash-2');
				del.addEventListener('click', (e) => {
					e.stopPropagation();
					void (async () => {
						await service.deleteBookRecords(book.title);
						renderBookList(rangeKey);
					})();
				});
			}
		}
		toggleButtons.forEach((btn, i) => {
			btn.addEventListener('click', () => {
				activeRange = ranges[i]!.key;
				toggleButtons.forEach((b, j) => b.toggleClass('dashboard-reading-stats-range-btn--active', j === i));
				renderBookList(activeRange);
			});
		});
		renderBookList(activeRange);

		// Recent records card
		const recentRecords = service.getRecentRecords(10);
		if (recentRecords.length > 0) {
			const recentCard = content.createDiv({ cls: 'dashboard-reading-stats-card' });
			recentCard.createDiv({ cls: 'dashboard-reading-stats-card-title', text: t('reading.recentRecords') });
			for (const rec of recentRecords) {
				const row = recentCard.createDiv({ cls: 'dashboard-reading-stats-record' });
				const ts = new Date(rec.timestamp);
				const dateText = `${ts.getMonth() + 1}/${ts.getDate()} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`;
				row.createDiv({ cls: 'dashboard-reading-stats-record-date', text: dateText });
				row.createDiv({ cls: 'dashboard-reading-stats-record-book', text: rec.bookTitle });
				row.createDiv({ cls: 'dashboard-reading-stats-record-dur', text: formatReadingDuration(rec.durationSeconds) });
				const del = row.createDiv({ cls: 'dashboard-reading-stats-record-del' });
				setIcon(del, 'trash-2');
				del.addEventListener('click', (e) => {
					e.stopPropagation();
					void (async () => {
						await service.deleteRecord(rec.timestamp);
						renderContent();
					})();
				});
			}
		}
	}

	renderContent();
}
