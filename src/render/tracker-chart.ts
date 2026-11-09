/**
 * Tracker card charts (line / bar / heatmap) plus the instance registry that
 * lets a re-render destroy the canvas it is about to replace.
 *
 * Moved verbatim out of renderer.ts (Phase 4, "只搬不改"). The registry is
 * owned here because every chart it holds is created here; `renderer.ts` only
 * asks for cleanup at the two moments a board is torn down.
 */
import { Chart, LineController, LineElement, PointElement, BarController, BarElement, LinearScale, CategoryScale, Filler, Tooltip } from 'chart.js';
import type { CardSize, TrackerDataPoint } from '../types';
import { getCSSVar } from './color';

Chart.register(LineController, LineElement, PointElement, BarController, BarElement, LinearScale, CategoryScale, Filler, Tooltip);

const chartInstances = new Map<string, Chart>();

export function destroyChart(cardId: string): void {
	const chart = chartInstances.get(cardId);
	if (chart) {
		chart.destroy();
		chartInstances.delete(cardId);
	}
}

/** Drop every canvas the tracker cards own, ahead of a full re-render. */
export function destroyAllChartInstances(): void {
	for (const [, chart] of chartInstances) {
		chart.destroy();
	}
	chartInstances.clear();
}

export function renderTrackerLineChart(el: HTMLElement, data: TrackerDataPoint[], size: CardSize, accentColor: string, cardId: string): void {
	const chartWrap = el.createDiv({ cls: 'dashboard-tracker-chart' });
	const canvasEl = chartWrap.createEl('canvas', { cls: 'dashboard-chart-canvas' });
	const ctx = canvasEl.getContext('2d');
	if (!ctx) return;

	const chart = new Chart(ctx, {
		type: 'line',
		data: {
			labels: data.map(p => p.date.slice(5)),
			datasets: [{
				data: data.map(p => p.value),
				borderColor: accentColor,
				backgroundColor: `${accentColor}22`,
				fill: true,
				tension: 0.4,
				pointRadius: size === 'L' ? 3 : 0,
				pointHoverRadius: 5,
				pointBackgroundColor: accentColor,
				borderWidth: 2,
			}],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: { legend: { display: false }, tooltip: { enabled: true } },
			scales: {
				x: { display: false },
				y: { display: false },
			},
			animation: { duration: 600 },
		},
	});
	chartInstances.set(cardId, chart);
}

export function renderTrackerBarChart(el: HTMLElement, data: TrackerDataPoint[], size: CardSize, accentColor: string, cardId: string): void {
	const chartWrap = el.createDiv({ cls: 'dashboard-tracker-chart' });
	const canvasEl = chartWrap.createEl('canvas', { cls: 'dashboard-chart-canvas' });
	const ctx = canvasEl.getContext('2d');
	if (!ctx) return;

	const textColor = getCSSVar('--db-text-muted') || '#888';
	const validVals = data.filter(p => p.value !== null).map(p => p.value!);
	const barMax = validVals.length > 0 ? Math.max(...validVals) : 1;

	const chart = new Chart(ctx, {
		type: 'bar',
		data: {
			labels: data.map(p => p.date.slice(5)),
			datasets: [{
				data: data.map(p => p.value ?? 0),
				backgroundColor: data.map(p => {
					if (p.value === null) return 'transparent';
					const intensity = barMax > 0 ? p.value / barMax : 0;
					return `${accentColor}${Math.round(40 + intensity * 180).toString(16).padStart(2, '0')}`;
				}),
				borderRadius: 2,
				barPercentage: 0.8,
			}],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: { legend: { display: false }, tooltip: { enabled: true } },
			scales: {
				x: { display: false },
				y: { display: size === 'L', grid: { display: false }, ticks: { color: textColor, font: { size: 10 } } },
			},
			animation: { duration: 600 },
		},
	});
	chartInstances.set(cardId, chart);
}

export function renderTrackerHeatmap(el: HTMLElement, data: TrackerDataPoint[], minVal: number, maxVal: number, size: CardSize, accentColor: string): void {
	const heatmap = el.createDiv({ cls: 'dashboard-tracker-heatmap' });

	const range = maxVal - minVal || 1;
	const cellSize = size === 'M' ? 10 : 14;
	const gap = 2;

	// Organize data into weeks (columns), days are rows (Mon-Sun)
	// Each column = 1 week, from oldest to newest
	const firstDate = data[0] ? new Date(data[0].date + 'T00:00:00') : new Date();
	const startDayOfWeek = firstDate.getDay(); // 0=Sun, 1=Mon...
	const mondayOffset = startDayOfWeek === 0 ? 6 : startDayOfWeek - 1; // days from Monday

	// Build week columns
	const weeks: (TrackerDataPoint | null)[][] = [];
	let currentWeek: (TrackerDataPoint | null)[] = [];

	// Pad first week with nulls to align to Monday
	for (let i = 0; i < mondayOffset; i++) {
		currentWeek.push(null);
	}

	for (const point of data) {
		currentWeek.push(point);
		if (currentWeek.length === 7) {
			weeks.push(currentWeek);
			currentWeek = [];
		}
	}
	if (currentWeek.length > 0) {
		weeks.push(currentWeek);
	}

	// Limit visible weeks based on size
	const maxWeeks = size === 'M' ? 15 : size === 'L' ? 26 : 52;
	const visibleWeeks = weeks.slice(-maxWeeks);

	const grid = heatmap.createDiv({ cls: 'dashboard-tracker-heatmap-grid' });
	grid.setCssProps({
		display: 'grid',
		gridTemplateColumns: `repeat(${visibleWeeks.length}, ${cellSize}px)`,
		gridTemplateRows: `repeat(7, ${cellSize}px)`,
		gap: `${gap}px`,
	});

	// Day labels (Mon, Tue, ... Sun) for L size
	if (size === 'L') {
		const labels = heatmap.createDiv({ cls: 'dashboard-tracker-heatmap-labels' });
		const dayNames = ['M', '', 'W', '', 'F', '', 'S'];
		for (const name of dayNames) {
			labels.createDiv({ cls: 'dashboard-tracker-heatmap-day-label', text: name });
		}
	}

	for (const week of visibleWeeks) {
		for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
			const point = week[dayIdx] ?? null;
			const cell = grid.createDiv({ cls: 'dashboard-tracker-heatmap-cell' });
			cell.style.width = `${cellSize}px`;
			cell.style.height = `${cellSize}px`;
			cell.style.borderRadius = `${Math.max(2, cellSize / 4)}px`;

			if (point === null || point.value === null) {
				cell.addClass('dashboard-tracker-heatmap-cell--empty');
			} else {
				const intensity = (point.value - minVal) / range;
				const alpha = 0.15 + intensity * 0.85;
				cell.style.backgroundColor = accentColor;
				cell.style.opacity = String(alpha);
				cell.title = `${point.date}: ${point.value}`;
			}
		}
	}
}
