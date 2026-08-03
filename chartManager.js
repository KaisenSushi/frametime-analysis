// We'll store the Chart.js instance & chart-specific data arrays
window.mainChart = null;
window.chartDatasets = [];
window.currentChartMetric = '';

// Shared dataset palette used across every tab. Ordered to keep adjacent
// datasets visually distinct; cycles after the last entry.
const BENCHMARK_COLORS = [
  '#3B82F6', // blue
  '#EF4444', // red
  '#F59E0B', // amber
  '#22C55E', // green
  '#A855F7', // purple
  '#06B6D4', // cyan
  '#F97316', // orange
  '#EC4899', // pink
  '#84CC16', // lime
  '#6366F1'  // indigo
];

const CHART_THEME_FALLBACKS = Object.freeze({
  text: 'rgba(245,245,245,0.9)',
  grid: 'rgba(255,255,255,0.16)',
  border: 'rgba(255,255,255,0.28)',
  tooltipBg: 'rgba(10,10,10,0.96)',
  tooltipTitle: 'rgba(245,245,245,0.95)',
  tooltipBody: 'rgba(245,245,245,0.88)',
  insideLabel: 'rgba(255,255,255,0.95)',
  zoomFill: 'rgba(255,255,255,0.10)',
  zoomBorder: 'rgba(255,255,255,0.35)'
});

function getDatasetLabel(dataset) {
  return window.getDatasetDisplayName?.(dataset) || dataset?.displayName || dataset?.name || 'Dataset';
}

function compactDatasetLabel(value, maxLength = 52) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  const extensionMatch = text.match(/(\.[a-z0-9]{1,8})$/i);
  const extension = extensionMatch?.[1] || '';
  const body = extension ? text.slice(0, -extension.length) : text;
  const available = Math.max(12, maxLength - extension.length - 1);
  const left = Math.ceil(available * 0.62);
  const right = Math.max(5, available - left);
  return `${body.slice(0, left)}…${body.slice(-right)}${extension}`;
}

function generateCompactLegendLabels(chart) {
  const generator = Chart.defaults?.plugins?.legend?.labels?.generateLabels;
  const labels = typeof generator === 'function' ? generator(chart) : [];
  return labels.map(item => ({ ...item, text: compactDatasetLabel(item.text, 56) }));
}

function readChartCssVariable(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function getChartThemeColors() {
  return {
    text: readChartCssVariable('--chart-text', CHART_THEME_FALLBACKS.text),
    grid: readChartCssVariable('--chart-grid', CHART_THEME_FALLBACKS.grid),
    border: readChartCssVariable('--chart-border', CHART_THEME_FALLBACKS.border),
    tooltipBg: readChartCssVariable('--chart-tooltip-bg', CHART_THEME_FALLBACKS.tooltipBg),
    tooltipTitle: readChartCssVariable('--chart-tooltip-title', CHART_THEME_FALLBACKS.tooltipTitle),
    tooltipBody: readChartCssVariable('--chart-tooltip-body', CHART_THEME_FALLBACKS.tooltipBody),
    insideLabel: readChartCssVariable('--chart-inside-label', CHART_THEME_FALLBACKS.insideLabel),
    zoomFill: readChartCssVariable('--chart-zoom-fill', CHART_THEME_FALLBACKS.zoomFill),
    zoomBorder: readChartCssVariable('--chart-zoom-border', CHART_THEME_FALLBACKS.zoomBorder)
  };
}

function getBenchmarkColor(index) {
  return BENCHMARK_COLORS[index % BENCHMARK_COLORS.length];
}

function assignDatasetColors() {
  (window.allDatasets || []).forEach((ds, index) => {
    if (!ds.color) ds.color = getBenchmarkColor(index);
  });
}

/**
 * Push current dataset.color onto any live Visualization chart series so a
 * color change shows immediately without Clear / re-add.
 */
function syncLiveChartColors() {
  if (window.analysisBoardReady && analysisBoardDatasetIndices.length) {
    buildAnalysisBoard(analysisBoardDatasetIndices, { silent: true });
    return true;
  }
  if (!Array.isArray(window.chartDatasets) || !window.chartDatasets.length) return false;

  let changed = false;
  const chartType = window.currentChartType;

  window.chartDatasets.forEach(cfg => {
    if (Array.isArray(cfg.sourceDatasetIndices)) {
      const colors = cfg.sourceDatasetIndices.map(i => {
        const ds = window.allDatasets?.[i];
        return ds?.color || getBenchmarkColor(i);
      });
      if (cfg.type === 'violin') {
        cfg.borderColor = colors;
        cfg.backgroundColor = colors.map(c => hexToRgba(c, 0.3));
      } else if (cfg.type === 'boxplot') {
        cfg.borderColor = colors;
        cfg.backgroundColor = colors.map(c => hexToRgba(c, chartType === 'violin' ? 0.4 : 0.4));
      }
      changed = true;
      return;
    }

    if (!Number.isInteger(cfg.sourceDatasetIndex)) return;
    const ds = window.allDatasets?.[cfg.sourceDatasetIndex];
    if (!ds?.color) return;
    const color = ds.color;

    if (cfg.qqRole === 'reference') {
      cfg.borderColor = hexToRgba(color, 0.9);
      cfg.backgroundColor = hexToRgba(color, 0.9);
    } else if (cfg.qqRole === 'sample') {
      cfg.borderColor = color;
      cfg.backgroundColor = hexToRgba(color, 0.75);
    } else if (chartType === 'histogram' || cfg.type === 'bar') {
      cfg.borderColor = color;
      cfg.backgroundColor = hexToRgba(color, 0.7);
    } else {
      cfg.borderColor = color;
      cfg.backgroundColor = color;
    }
    changed = true;
  });

  if (changed && window.mainChart) {
    window.mainChart.data.datasets = window.chartDatasets.slice();
    window.mainChart.update('none');
  }
  return changed;
}

/** Frame-Time-Analysis style global Chart.js defaults */
function initChartDefaults() {
  if (!window.Chart?.defaults) return;
  const d = Chart.defaults;
  d.animation = false;
  d.font.size = 13;
  const theme = getChartThemeColors();
  d.color = theme.text;
  d.borderColor = theme.border;
  d.normalized = true;
}

initChartDefaults();

/** Summary-bar stat colors from the same family as BENCHMARK_COLORS (no red/green coding). */
const BAR_STAT_DEFS = [
  { key: 'max',    color: '#FBBF24' },
  { key: 'avg',    color: '#F59E0B' },
  { key: 'min',    color: '#D97706' },
  { key: 'p1',     color: '#2DD4BF' },
  { key: 'p01',    color: '#22D3EE' },
  { key: 'p001',   color: '#14B8A6' },
  { key: 'low1',   color: '#E879F9' },
  { key: 'low01',  color: '#C084FC' },
  { key: 'low001', color: '#A78BFA' },
  { key: 'stdev',  color: '#A3E635' }
];

const BAR_STAT_DEF_MAP = Object.fromEntries(BAR_STAT_DEFS.map(d => [d.key, d]));

function formatSummaryBarValue(value, statKey = 'avg') {
  if (!Number.isFinite(value)) return '';
  if (typeof window.formatStatValue === 'function') {
    return window.formatStatValue(window.currentChartMetric, statKey, value);
  }
  return value.toFixed(2);
}

const summaryBarLabelsPlugin = {
  id: 'summaryBarLabels',
  afterDatasetsDraw(chart) {
    if (!chart.options.plugins?.summaryBarLabels?.enabled) return;

    const { ctx } = chart;
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 11px system-ui, sans-serif';

    chart.data.datasets.forEach((dataset, dsIndex) => {
      const meta = chart.getDatasetMeta(dsIndex);
      if (meta.hidden) return;

      meta.data.forEach((bar, index) => {
        const value = dataset.data[index];
        if (!Number.isFinite(value)) return;

        const text = formatSummaryBarValue(value, dataset.statKey);
        const { x, y, base } = bar.getProps(['x', 'y', 'base'], true);
        const barEnd = Math.max(x, base);
        const barStart = Math.min(x, base);
        const barWidth = barEnd - barStart;
        const textWidth = ctx.measureText(text).width;

        if (barWidth > textWidth + 16) {
          ctx.fillStyle = getChartThemeColors().insideLabel;
          ctx.fillText(text, barStart + 8, y);
        } else {
          ctx.fillStyle = getChartThemeColors().text;
          ctx.fillText(text, barEnd + 6, y);
        }
      });
    });

    ctx.restore();
  }
};

if (window.Chart) {
  Chart.register(summaryBarLabelsPlugin);
}

function getSelectedBarStats() {
  return Array.from(document.querySelectorAll('#barStatGroup .toggle-button.active'))
    .map(btn => btn.dataset.stat)
    .filter(Boolean);
}

function getStatsSeriesForChart(dataset, metric) {
  if (typeof window.collectMetricValues === 'function') {
    return window.collectMetricValues(dataset, metric);
  }
  return getMetricSeries(dataset, metric);
}

function buildSummaryBarChart(indices, metric, statKeys) {
  const labels = indices.map(i => getDatasetLabel(window.allDatasets[i]));
  const benchStats = indices.map(i => {
    const ds = window.allDatasets[i];
    const values = getStatsSeriesForChart(ds, metric);
    return window.calculateStatistics(values, metric);
  });

  window.chartLabels = labels;
  window.chartDatasets = statKeys.map(statKey => {
    const def = BAR_STAT_DEF_MAP[statKey];
    const label = typeof window.getStatDisplayName === 'function'
      ? window.getStatDisplayName(statKey, [metric])
      : statKey;
    return {
      label,
      statKey,
      data: benchStats.map(s => s[statKey]),
      backgroundColor: def?.color || '#888',
      borderColor: def?.color || '#888',
      borderWidth: 0,
      borderRadius: 10,
      borderSkipped: false,
      barPercentage: 0.82,
      categoryPercentage: 0.88
    };
  });

  adjustSummaryBarHeight(indices.length, statKeys.length);
}

function getSummaryBarRequiredHeight(datasetCount, statCount) {
  const categories = Math.max(1, Number(datasetCount) || 0);
  const series = Math.max(1, Number(statCount) || 0);

  // Chart.js divides each dataset category among every selected statistic.
  // Reserve enough vertical room for readable bars, category labels and legend.
  const pixelsPerBarSlot = 18;
  const categoryGap = 12;
  const chartChrome = 110;
  return Math.max(
    320,
    Math.ceil(chartChrome + categories * (series * pixelsPerBarSlot + categoryGap))
  );
}

function adjustSummaryBarHeight(datasetCount, statCount) {
  const chartContainer = document.getElementById('chartContainer');
  const range = document.getElementById('chartHeight');
  if (!chartContainer) return;

  const requiredHeight = getSummaryBarRequiredHeight(datasetCount, statCount);
  let targetHeight = requiredHeight;

  if (range) {
    const currentMax = Number(range.max) || 900;
    if (requiredHeight > currentMax) {
      // Extend the control only when the comparison needs it. This avoids
      // silently clipping larger summary charts while preserving the normal UI.
      range.max = String(Math.min(1800, Math.ceil(requiredHeight / 100) * 100));
    }

    targetHeight = Math.min(requiredHeight, Number(range.max) || requiredHeight);
    if (Number(range.value) < targetHeight) {
      range.value = String(targetHeight);
    }
    range.setAttribute('aria-valuetext', `${range.value} pixels`);

    const heightValSpan = document.getElementById('chartHeightValue');
    if (heightValSpan) heightValSpan.textContent = `${range.value}px`;
    chartContainer.style.height = `${range.value}px`;
  } else {
    chartContainer.style.height = `${targetHeight}px`;
  }

  chartContainer.style.minHeight = `${targetHeight}px`;
  if (window.mainChart) window.mainChart.resize();
}

// Cap rendered points so large captures stay responsive.
const MAX_LINE_SCATTER_POINTS = 4500;
const MAX_DISTRIBUTION_POINTS = 6000;
const MAX_QQ_POINTS = 3000;

/**
 * Largest-Triangle-Three-Buckets downsampling - preserves visual shape of line data.
 * @param {{x:number,y:number}[]} points
 * @param {number} threshold
 */
function decimateLTTB(points, threshold) {
  const len = points.length;
  if (len <= threshold || threshold < 3) return points;

  const sampled = new Array(threshold);
  let sampledIndex = 0;
  sampled[sampledIndex++] = points[0];

  const bucketSize = (len - 2) / (threshold - 2);
  let a = 0;

  for (let i = 0; i < threshold - 2; i++) {
    const rangeStart = Math.floor((i + 1) * bucketSize) + 1;
    const rangeEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, len);

    let avgX = 0;
    let avgY = 0;
    const avgStart = Math.floor(i * bucketSize) + 1;
    const avgEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, len);
    const avgCount = avgEnd - avgStart;
    for (let j = avgStart; j < avgEnd; j++) {
      avgX += points[j].x;
      avgY += points[j].y;
    }
    avgX /= avgCount;
    avgY /= avgCount;

    let maxArea = -1;
    let nextA = rangeStart;
    const pointA = points[a];

    for (let j = rangeStart; j < rangeEnd; j++) {
      const pointJ = points[j];
      const area = Math.abs(
        (pointA.x - avgX) * (pointJ.y - pointA.y) -
        (pointA.x - pointJ.x) * (avgY - pointA.y)
      );
      if (area > maxArea) {
        maxArea = area;
        nextA = j;
      }
    }

    sampled[sampledIndex++] = points[nextA];
    a = nextA;
  }

  sampled[sampledIndex++] = points[len - 1];
  return sampled;
}

/** Cached numeric series for a metric - avoids re-reading every row on each add. */
function getMetricSeries(dataset, metric) {
  if (dataset._seriesCache?.metric === metric) return dataset._seriesCache.values;

  // Keep only the most recently requested full series per dataset. Retaining
  // every metric duplicates large captures and can quickly exhaust memory.
  const values = typeof window.collectMetricValues === 'function'
    ? window.collectMetricValues(dataset, metric)
    : (dataset.rows || [])
        .map(row => getMetricValue(row, metric))
        .filter(value => Number.isFinite(value));
  dataset._seriesCache = { metric, values };
  return values;
}

/** Evenly spaced indices from 0..length-1, always including first and last. */
function sampleIndices(length, maxPoints) {
  if (length <= maxPoints) {
    return Array.from({ length }, (_, i) => i);
  }
  if (maxPoints <= 1) return [0];
  const indices = new Array(maxPoints);
  for (let i = 0; i < maxPoints; i++) {
    indices[i] = Math.round(i * (length - 1) / (maxPoints - 1));
  }
  const seen = new Set();
  const out = [];
  for (const idx of indices) {
    if (!seen.has(idx)) {
      seen.add(idx);
      out.push(idx);
    }
  }
  return out;
}

function sampleSeries(values, maxPoints) {
  if (values.length <= maxPoints) return values;
  return sampleIndices(values.length, maxPoints).map(i => values[i]);
}

/**
 * Builds (and caches) line/scatter points with optional LTTB decimation.
 * X is always valid-sample index (1..n after shared metric filtering).
 */
function getLineScatterPoints(dataset, metric) {
  if (dataset._pointCache?.metric === metric) return dataset._pointCache.result;

  const values = getMetricSeries(dataset, metric);
  const points = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    points[i] = { x: i + 1, y: values[i] };
  }

  const totalPoints = points.length;
  const displayPoints = totalPoints > MAX_LINE_SCATTER_POINTS
    ? decimateLTTB(points, MAX_LINE_SCATTER_POINTS)
    : points;

  const result = { points: displayPoints, totalPoints, displayedPoints: displayPoints.length };
  // Keep only the most recently used point series so several metrics do not
  // duplicate a large capture in memory.
  dataset._pointCache = { metric, result };
  return result;
}

function buildLineScatterPoints(rows, metric) {
  // Legacy entry point - prefer getLineScatterPoints when dataset object is available.
  const dataset = { rows, _pointCache: null };
  return getLineScatterPoints(dataset, metric).points;
}

/**
 * Builds a histogram from an array of numeric data.
 * @param {number[]} data
 * @param {{ minVal?: number, maxVal?: number, binCount?: number, binWidth?: number }} [binEdges]
 *        Optional shared bin edges for multi-dataset overlays. When omitted, edges are
 *        derived from this dataset alone (single-dataset / backward-compatible path).
 * @returns {{labels: string[], counts: number[]}}
 */
function buildHistogram(data, binEdges = {}) {
  if (!data.length) {
    return { labels: [], counts: [] };
  }

  let minVal = binEdges.minVal;
  let maxVal = binEdges.maxVal;

  if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
    minVal = Infinity;
    maxVal = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
  }

  // Handle case where all values are identical
  if (minVal === maxVal) {
    return { labels: [minVal.toString()], counts: [data.length] };
  }

  let binCount = binEdges.binCount;
  if (!Number.isFinite(binCount) || binCount < 1) {
    binCount = Math.max(1, Math.min(50, Math.ceil(Math.sqrt(data.length))));
  }

  let binWidth = binEdges.binWidth;
  if (!Number.isFinite(binWidth) || binWidth <= 0) {
    binWidth = (maxVal - minVal) / binCount;
  }

  const counts = Array(binCount).fill(0);

  for (let i = 0; i < data.length; i++) {
    const val = data[i];
    const idx = Math.min(binCount - 1, Math.floor((val - minVal) / binWidth));
    counts[idx]++;
  }

  const labels = [];
  for (let i = 0; i < binCount; i++) {
    const rangeStart = (minVal + i * binWidth).toFixed(2);
    const rangeEnd = (minVal + (i + 1) * binWidth).toFixed(2);
    labels.push(`${rangeStart}-${rangeEnd}`);
  }
  return { labels, counts };
}

function isHistogramPercentMode() {
  return Boolean(document.getElementById('histogramAsPercent')?.checked);
}

/** Convert raw bin counts to % of frames in that series. */
function histogramCountsForDisplay(counts, asPercent) {
  if (!asPercent) return counts.slice();
  const total = counts.reduce((sum, c) => sum + c, 0);
  if (total <= 0) return counts.map(() => 0);
  return counts.map(c => (c / total) * 100);
}

/**
 * Shared histogram edges so overlaid datasets land in identical x-axis buckets.
 * binCount uses the largest dataset's n (sqrt rule) so the densest series is not
 * under-binned; smaller series still share those same edges for direct comparison.
 * @param {number[][]} seriesList
 * @returns {{ minVal: number, maxVal: number, binCount: number, binWidth: number }|null}
 */
function computeSharedHistogramEdges(seriesList) {
  const series = (seriesList || []).filter(s => Array.isArray(s) && s.length);
  if (series.length < 2) return null;

  let minVal = Infinity;
  let maxVal = -Infinity;
  let maxN = 0;

  for (let s = 0; s < series.length; s++) {
    const data = series[s];
    maxN = Math.max(maxN, data.length);
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
  }

  if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) return null;

  const binCount = Math.max(1, Math.min(50, Math.ceil(Math.sqrt(maxN))));
  const binWidth = minVal === maxVal ? 0 : (maxVal - minVal) / binCount;
  return { minVal, maxVal, binCount, binWidth };
}

/**
 * Rebuild histogram series when switching between count and % of frames.
 */
function rebuildCurrentHistogramDatasets() {
  if (!Array.isArray(window.chartDatasets) || !window.chartDatasets.length) return;
  if (window.currentChartType !== 'histogram') return;

  const asPercent = isHistogramPercentMode();
  const metric = window.currentChartMetric;
  const indices = [];
  window.chartDatasets.forEach(cfg => {
    if (Number.isInteger(cfg.sourceDatasetIndex) && !indices.includes(cfg.sourceDatasetIndex)) {
      indices.push(cfg.sourceDatasetIndex);
    }
  });
  if (!indices.length || !metric) return;

  const seriesForBins = [];
  indices.forEach(idx => {
    const ds = window.allDatasets?.[idx];
    if (!(typeof window.getDatasetRowCount === 'function' ? window.getDatasetRowCount(ds) : ds?.rows?.length)) return;
    const vals = getMetricSeries(ds, metric);
    if (vals.length) seriesForBins.push(vals);
  });
  const sharedEdges = computeSharedHistogramEdges(seriesForBins);

  window.chartDatasets = indices.map(idx => {
    const ds = window.allDatasets[idx];
    const vals = getMetricSeries(ds, metric);
    const bins = sharedEdges ? buildHistogram(vals, sharedEdges) : buildHistogram(vals);
    const displayCounts = histogramCountsForDisplay(bins.counts, asPercent);
    const seriesColor = ds.color || getBenchmarkColor(idx);
    return {
      label: getDatasetLabel(ds),
      data: displayCounts.map((c, i) => ({ x: bins.labels[i], y: c })),
      type: 'bar',
      backgroundColor: hexToRgba(seriesColor, 0.7),
      borderColor: seriesColor,
      borderWidth: 1,
      sourceDatasetIndex: idx,
      sourceMetric: metric,
      histogramAsPercent: asPercent
    };
  });
}

/**
 * Evenly subsample a sorted array while preserving order statistics (for Q-Q plots).
 * @param {number[]} sorted ascending values
 * @param {number} maxPoints
 * @returns {number[]}
 */
/**
 * Subsample sorted values for plotting; each item keeps its 1-based rank in the full series.
 * @returns {{ value: number, rank: number }[]}
 */
function subsampleSortedWithRanks(sorted, maxPoints) {
  if (sorted.length <= maxPoints) {
    return sorted.map((value, i) => ({ value, rank: i + 1 }));
  }
  return sampleIndices(sorted.length, maxPoints).map(idx => ({
    value: sorted[idx],
    rank: idx + 1
  }));
}

/**
 * Builds Q-Q plot data: sample quantiles vs theoretical normal quantiles.
 * Uses Blom's plotting positions p = (i - 0.5) / n (rank i = 1..n).
 * Reference line: y = mean + std * x (expected under normality).
 * @param {number[]} data
 * @returns {{ points: {x:number,y:number}[], refLine: {x:number,y:number}[], mean: number, std: number } | null}
 */
function buildQQPlot(data) {
  if (typeof jStat === 'undefined' || typeof jStat.normal?.inv !== 'function') {
    console.error('jStat.normal.inv is not available for Q-Q plots.');
    return null;
  }

  const sorted = data.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (sorted.length < 2) return null;

  // Reference line uses full-series moments so it matches Statistics STDEV.
  const mean = jStat.mean(sorted);
  const std = jStat.stdev(sorted, true);

  // Only the plotted points are thinned for performance; ranks use the full series size.
  const nFull = sorted.length;
  const sample = subsampleSortedWithRanks(sorted, MAX_QQ_POINTS);

  const points = [];
  for (const { value, rank } of sample) {
    const p = (rank - 0.5) / nFull;
    const z = jStat.normal.inv(p, 0, 1);
    if (!Number.isFinite(z)) continue;
    points.push({ x: z, y: value });
  }

  if (points.length < 2) return null;

  const zMin = points[0].x;
  const zMax = points[points.length - 1].x;
  const safeStd = Number.isFinite(std) && std > 0 ? std : 0;
  const refLine = safeStd > 0
    ? [
        { x: zMin, y: mean + safeStd * zMin },
        { x: zMax, y: mean + safeStd * zMax }
      ]
    : [
        { x: zMin, y: mean },
        { x: zMax, y: mean }
      ];

  return { points, refLine, mean, std: safeStd, totalPoints: sorted.length, plottedPoints: points.length };
}

function isQQReferenceDataset(dataset) {
  return dataset?.qqRole === 'reference';
}

function getControllerType(chartType) {
  if (chartType === 'histogram' || chartType === 'summarybar') return 'bar';
  // FTA uses scatter + showLine for performant time-series lines
  if (chartType === 'line' || chartType === 'qqplot' || chartType === 'scatter') return 'scatter';
  if (chartType === 'violin') return 'violin';
  if (chartType === 'boxplot') return 'boxplot';
  return 'scatter';
}

function styleLinearAxis(config, title) {
  const theme = getChartThemeColors();
  return {
    type: 'linear',
    ...config,
    title: { display: true, text: title, color: theme.text, font: { size: 13, weight: '600' } },
    ticks: { color: theme.text, maxTicksLimit: 12 },
    grid: { color: theme.grid },
    border: { color: theme.border }
  };
}

function getYAxisLabel(metric) {
  if (!metric) return 'Value';
  if (metric === 'FPS' || metric === 'RenderedFPS' || metric === 'DisplayedFPS') return 'FPS';
  if (metric === 'FrameTime' || metric === 'DisplayedFrameTime' || /^Ms/i.test(metric)) return 'ms';
  if (typeof window.getMetricChipLabel === 'function') return window.getMetricChipLabel(metric);
  return typeof window.getMetricDisplayName === 'function'
    ? window.getMetricDisplayName(metric)
    : metric;
}

function buildZoomOptions() {
  const theme = getChartThemeColors();
  return {
    pan: {
      enabled: true,
      mode: 'xy',
      onPanComplete: () => setResetZoomEnabled(true)
    },
    zoom: {
      wheel: { enabled: true, modifierKey: 'ctrl' },
      drag: {
        enabled: true,
        modifierKey: 'ctrl',
        backgroundColor: theme.zoomFill,
        borderColor: theme.zoomBorder,
        borderWidth: 1
      },
      pinch: { enabled: true },
      mode: 'xy',
      onZoomComplete: () => setResetZoomEnabled(true)
    },
    limits: {
      x: { min: 'original', max: 'original' },
      y: { min: 'original', max: 'original' }
    }
  };
}

function setResetZoomEnabled(enabled) {
  const resetZoomBtn = document.getElementById('resetZoomBtn');
  if (resetZoomBtn) {
    resetZoomBtn.disabled = !enabled || window.currentChartType === 'summarybar';
  }
}

function applyDistributionValueAxisPadding(scales) {
  let minValue = Infinity;
  let maxValue = -Infinity;
  window.chartDatasets.forEach(dataset => {
    (dataset.data || []).forEach(group => {
      if (!Array.isArray(group)) return;
      for (let i = 0; i < group.length; i++) {
        const value = group[i];
        if (Number.isFinite(value)) {
          minValue = Math.min(minValue, value);
          maxValue = Math.max(maxValue, value);
        }
      }
    });
  });

  if (Number.isFinite(minValue) && Number.isFinite(maxValue)) {
    const span = maxValue - minValue;
    const padding = span > 0 ? span * 0.1 : Math.max(1, Math.abs(minValue) * 0.1, Math.abs(maxValue) * 0.1);
    scales.x.min = minValue - padding;
    scales.x.max = maxValue + padding;
  }
}

function computeSeriesExtents(datasets) {
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;

  datasets.forEach(ds => {
    (ds.data || []).forEach(point => {
      if (!point || typeof point !== 'object') return;
      if (Number.isFinite(point.x)) {
        xMin = Math.min(xMin, point.x);
        xMax = Math.max(xMax, point.x);
      }
      if (Number.isFinite(point.y)) {
        yMin = Math.min(yMin, point.y);
        yMax = Math.max(yMax, point.y);
      }
    });
  });

  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;

  const ySpan = yMax - yMin;
  const yPad = ySpan > 0 ? ySpan * 0.05 : Math.max(0.5, Math.abs(yMax) * 0.05);

  return {
    xMin: Number.isFinite(xMin) ? xMin : undefined,
    xMax: Number.isFinite(xMax) ? xMax : undefined,
    yMin: yMin - yPad,
    yMax: yMax + yPad
  };
}

function buildChartScales(chartType) {
  const theme = getChartThemeColors();
  const scales = {};
  const xTitle = 'Frame #';
  const yTitle = getYAxisLabel(window.currentChartMetric);

  if (chartType === 'histogram') {
    const yTitle = isHistogramPercentMode() ? '% of frames' : 'Count';
    scales.x = { type: 'category', title: { display: true, text: 'Bin Range', color: theme.text }, ticks: { color: theme.text }, grid: { color: theme.grid } };
    scales.y = styleLinearAxis({}, yTitle);
  } else if (chartType === 'summarybar') {
    scales.x = styleLinearAxis({ min: 0, grid: { display: true } }, getYAxisLabel(window.currentChartMetric));
    scales.y = {
      type: 'category',
      grid: { display: false },
      ticks: {
        color: theme.text,
        autoSkip: false,
        callback(value) {
          return compactDatasetLabel(this.getLabelForValue(value), 34);
        }
      },
      border: { color: theme.border }
    };
  } else if (chartType === 'qqplot') {
    const yTitle = getYAxisLabel(window.currentChartMetric);
    scales.x = styleLinearAxis({}, 'Theoretical Quantiles (σ)');
    scales.y = styleLinearAxis({}, `Sample Quantiles (${yTitle})`);
    const extents = computeSeriesExtents(window.chartDatasets);
    if (extents) {
      if (extents.xMin !== undefined) scales.x.min = extents.xMin;
      if (extents.xMax !== undefined) scales.x.max = extents.xMax;
      scales.y.min = extents.yMin;
      scales.y.max = extents.yMax;
    }
  } else if (chartType === 'scatter' || chartType === 'line') {
    scales.x = styleLinearAxis({ grid: { display: false } }, xTitle);
    scales.y = styleLinearAxis({}, yTitle);
    const extents = computeSeriesExtents(window.chartDatasets);
    if (extents) {
      if (extents.xMin !== undefined) scales.x.min = extents.xMin;
      if (extents.xMax !== undefined) scales.x.max = extents.xMax;
      scales.y.min = extents.yMin;
      scales.y.max = extents.yMax;
    }
  } else if (chartType === 'boxplot' || chartType === 'violin') {
    // Both use horizontal layout: categories on Y, values on X.
    scales.y = { type: 'category', title: { display: true, text: 'Dataset', color: theme.text }, ticks: { color: theme.text }, grid: { display: false } };
    scales.x = styleLinearAxis({ beginAtZero: false, grace: '10%' }, yTitle);
  } else {
    scales.x = styleLinearAxis({}, xTitle);
    scales.y = styleLinearAxis({}, yTitle);
  }
  return scales;
}

/**
 * Renders (or updates) the Chart.js chart based on the current chartDatasets array.
 * @param {string} chartType
 * @param {{ incremental?: boolean }} [opts]
 */
function renderChart(chartType, opts = {}) {
  const canvas = document.getElementById('mainChart');
  const chartContainer = document.getElementById('chartContainer');
  if (!canvas || !chartContainer) {
    console.warn("Chart elements not found in HTML.");
    return;
  }

  window.currentChartType = chartType;

  const ctx = canvas.getContext('2d');
  const incremental = Boolean(opts.incremental);
  const canIncremental = incremental &&
    window.mainChart &&
    window.currentChartType === chartType &&
    chartType !== 'violin' &&
    chartType !== 'boxplot' &&
    chartType !== 'summarybar' &&
    chartType !== 'qqplot';

  if (!Array.isArray(window.chartDatasets) || window.chartDatasets.length === 0) {
    if (window.mainChart) {
      window.mainChart.destroy();
      window.mainChart = null;
    }
    chartContainer.classList.add('empty');
    canvas.setAttribute('aria-hidden', 'true');
    return;
  }
  chartContainer.classList.remove('empty');
  canvas.setAttribute('aria-hidden', 'false');

  if (canIncremental) {
    window.mainChart.data.datasets = window.chartDatasets.slice();
    if (chartType === 'violin' || chartType === 'boxplot') {
      window.mainChart.data.labels = window.chartLabels.slice();
    }
    window.mainChart.options.scales = buildChartScales(chartType);
    window.mainChart.update('none');
    updateChartStatusLine();
    return;
  }

  if (window.mainChart) {
    window.mainChart.destroy();
  }

  const ctrlType = getControllerType(chartType);
  const theme = getChartThemeColors();
  const scales = buildChartScales(chartType);

  const cfg = {
    type: ctrlType,
    data: {
      datasets: window.chartDatasets.slice()
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales,
      plugins: {
        decimation: false,
        tooltip: {
          enabled: false,
          backgroundColor: theme.tooltipBg,
          titleColor: theme.tooltipTitle,
          bodyColor: theme.tooltipBody,
          borderColor: theme.border,
          borderWidth: 1,
          callbacks: {
            label(ctx) {
              if (ctx.dataset.type === 'violin') {
                const vals = ctx.dataset.data[ctx.dataIndex];
                const fullVals = ctx.dataset.fullDistributionData?.[ctx.dataIndex] || vals;
                const [q1, m, q3] = jStat.quantiles(fullVals, [0.25, 0.5, 0.75]);
                return [
                  `N = ${fullVals.length}`,
                  `Q1 = ${q1.toFixed(2)}`,
                  `Median = ${m.toFixed(2)}`,
                  `Q3 = ${q3.toFixed(2)}`
                ];
              }
              const ds = ctx.dataset;
              if (window.currentChartType === 'qqplot') {
                const raw = ctx.raw;
                if (raw && typeof raw === 'object' && Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
                  if (ctx.dataset.qqRole === 'reference') {
                    return `${ctx.dataset.label}: expected normal fit`;
                  }
                  const formatted = typeof window.formatStatValue === 'function'
                    ? window.formatStatValue(window.currentChartMetric, 'avg', raw.y)
                    : raw.y.toFixed(3);
                  return [
                    ctx.dataset.label,
                    `Theoretical: ${raw.x.toFixed(3)} σ`,
                    `Observed: ${formatted}`
                  ];
                }
              }
              if (window.currentChartType === 'summarybar') {
                const val = ctx.raw;
                if (!Number.isFinite(val)) return `${ctx.dataset.label}: N/A`;
                const formatted = formatSummaryBarValue(val, ctx.dataset.statKey);
                return `${ctx.dataset.label}: ${formatted}`;
              }
              if (ds.totalPoints && ds.displayedPoints && ds.totalPoints > ds.displayedPoints) {
                return `${ds.label}: ${ctx.formattedValue} (${ds.displayedPoints.toLocaleString()} of ${ds.totalPoints.toLocaleString()} frames)`;
              }
              return `${ctx.dataset.label}: ${ctx.formattedValue}`;
            }
          }
        },
        legend: {
          display: true,
          position: 'bottom',
          align: 'start',
          labels: {
            color: theme.text,
            boxWidth: 14,
            padding: 12,
            usePointStyle: true,
            pointStyle: 'line',
            generateLabels: generateCompactLegendLabels
          }
        },
        zoom: chartType === 'summarybar' ? false : buildZoomOptions()
      },
      elements: {
        line: { borderWidth: 2, tension: 0 },
        point: { radius: 0, hitRadius: 4 },
        bar: { borderRadius: 10, borderSkipped: false }
      }
    }
  };

  if (chartType === 'qqplot') {
    cfg.options.plugins.legend.labels.filter = (item, chartData) => {
      const datasets = chartData?.datasets ?? chartData?.data?.datasets;
      return !isQQReferenceDataset(datasets?.[item.datasetIndex]);
    };
    cfg.options.elements.point.radius = 2.5;
  }

  if (chartType === 'violin' || chartType === 'boxplot' || chartType === 'summarybar') {
    cfg.data.labels = window.chartLabels.slice();
  }

  if (chartType === 'summarybar') {
    cfg.options.indexAxis = 'y';
    cfg.options.plugins.legend.labels.usePointStyle = false;
    cfg.options.plugins.legend.labels.pointStyle = 'rectRounded';
    cfg.options.plugins.summaryBarLabels = { enabled: true };
    cfg.options.layout = { padding: { right: 48 } };
  }

  if (chartType === 'boxplot' || chartType === 'violin') {
    cfg.options.indexAxis = 'y';
  }

  if (chartType === 'violin' || chartType === 'boxplot') {
    // Horizontal layout: numeric values live on the x axis.
    applyDistributionValueAxisPadding(cfg.options.scales);
  }

  try {
    window.mainChart = new Chart(ctx, cfg);
    const metricLabel = window.getMetricDisplayName?.(window.currentChartMetric) || window.currentChartMetric;
    canvas.setAttribute('aria-label', `${chartType} chart for ${metricLabel || 'the selected metric'}. ${window.chartDatasets.length} series shown.`);
    setResetZoomEnabled(false);
  } catch (err) {
    console.error('Chart render failed:', err);
    window.notify?.(`Chart failed to render: ${err.message}`, 'error');
    chartContainer.classList.add('empty');
    window.mainChart = null;
  }

  updateChartStatusLine();
}

function updateChartStatusLine() {
  const el = document.getElementById('chartStatusLine');
  if (!el) return;

  const datasets = window.chartDatasets || [];
  if (!datasets.length || !window.currentChartType) {
    el.textContent = '';
    return;
  }

  if (window.currentChartType === 'qqplot') {
    const sample = datasets.find(d => d.qqRole === 'sample' && d.qqTotalPoints);
    if (sample?.qqTotalPoints && sample.qqPlottedPoints) {
      el.textContent = `${sample.qqPlottedPoints.toLocaleString()} of ${sample.qqTotalPoints.toLocaleString()} plotted`;
      return;
    }
  }

  if (window.currentChartType === 'line' || window.currentChartType === 'scatter') {
    let displayed = 0;
    let total = 0;
    datasets.forEach(d => {
      if (Number.isFinite(d.displayedPoints)) displayed += d.displayedPoints;
      if (Number.isFinite(d.totalPoints)) total += d.totalPoints;
    });
    if (total > 0 && displayed > 0 && displayed < total) {
      el.textContent = `${displayed.toLocaleString()} of ${total.toLocaleString()} frames`;
      return;
    }
    if (total > 0) {
      el.textContent = `${total.toLocaleString()} frames`;
      return;
    }
  }

  el.textContent = '';
}


let visualizationResultMode = 'single';
let analysisBoardCharts = [];
let analysisBoardDatasetIndices = [];
let analysisBoardConfig = null;
let analysisBoardSelections = null;
let analysisBoardRebuildTimer = null;
let analysisBoardCardCounter = 0;
window.analysisBoardReady = false;

const ANALYSIS_BOARD_STORAGE_KEY = 'fta-analysis-board-config-v3';
const ANALYSIS_BOARD_MAX_CARDS = 6;
const ANALYSIS_BOARD_CARD_TYPES = Object.freeze({
  timeline: { label: 'Timeline', description: 'Sampled values over the capture.' },
  scatter: { label: 'Scatter', description: 'Individual sampled values make spikes and outliers easy to see.' },
  percentile: { label: 'Percentile curve', description: 'Full distribution from the lowest to highest values.' },
  histogram: { label: 'Histogram', description: 'Share of valid samples in shared value ranges.' },
  boxplot: { label: 'Box plot', description: 'Median, spread, whiskers, and outliers.' },
  summary: { label: 'Summary bars', description: 'Average and low-FPS tail means.' },
  advanced: { label: 'Advanced metrics', description: 'Median, P95, P99, maximum spike, and frames above the spike threshold.' }
});

const ANALYSIS_BOARD_FALLBACK_METRICS = [
  'FrameTime', 'RenderedFPS', 'DisplayedFrameTime', 'DisplayedFPS',
  'MsBetweenPresents', 'MsBetweenDisplayChange', 'MsGPUBusy', 'MsUntilDisplayed'
];

const ANALYSIS_BOARD_DEFAULT_SELECTIONS = Object.freeze({
  metrics: ['FrameTime'],
  chartTypes: ['timeline', 'scatter', 'histogram', 'percentile']
});

const ANALYSIS_BOARD_EXCLUDED_METRICS = new Set([
  'Stepwise_Relative_SD', 'Coefficient_of_Variation', 'RMSSD',
  'Rendered_FTSD', 'Displayed_FTSD',
  'Rendered_Coefficient_of_Variation', 'Displayed_Coefficient_of_Variation',
  'Rendered_RMSSD', 'Displayed_RMSSD',
  'Rendered_Stepwise_Relative_SD', 'Displayed_Stepwise_Relative_SD',
  'Skewness', 'Kurtosis', 'Nonparametric_Skew'
]);

const ANALYSIS_BOARD_PRESET_TITLES = Object.freeze({
  performance: 'Performance overview',
  consistency: 'Frame-time consistency',
  renderedDisplayed: 'Rendered vs displayed'
});

const ANALYSIS_BOARD_PRESETS = Object.freeze({
  performance: [
    { id: 'performance-timeline', type: 'timeline', metric: 'FrameTime' },
    { id: 'performance-scatter', type: 'scatter', metric: 'FrameTime' },
    { id: 'performance-histogram', type: 'histogram', metric: 'FrameTime' },
    { id: 'performance-percentile', type: 'percentile', metric: 'RenderedFPS' },
    { id: 'performance-summary', type: 'summary', metric: 'RenderedFPS' },
    { id: 'performance-advanced', type: 'advanced', metric: 'FrameTime', thresholdMs: 16.67 }
  ],
  consistency: [
    { id: 'consistency-timeline', type: 'timeline', metric: 'FrameTime' },
    { id: 'consistency-histogram', type: 'histogram', metric: 'FrameTime' },
    { id: 'consistency-percentile', type: 'percentile', metric: 'FrameTime' },
    { id: 'consistency-box', type: 'boxplot', metric: 'FrameTime' }
  ],
  renderedDisplayed: [
    { id: 'comparison-rendered-timeline', type: 'timeline', metric: 'RenderedFPS' },
    { id: 'comparison-displayed-timeline', type: 'timeline', metric: 'DisplayedFPS' },
    { id: 'comparison-rendered-percentile', type: 'percentile', metric: 'RenderedFPS' },
    { id: 'comparison-displayed-percentile', type: 'percentile', metric: 'DisplayedFPS' },
    { id: 'comparison-rendered-box', type: 'boxplot', metric: 'RenderedFPS' },
    { id: 'comparison-displayed-box', type: 'boxplot', metric: 'DisplayedFPS' }
  ]
});

function cloneBoardCards(cards) {
  return (cards || []).map(card => ({ ...card }));
}

function createBoardCardId() {
  analysisBoardCardCounter += 1;
  return `custom-${Date.now().toString(36)}-${analysisBoardCardCounter.toString(36)}`;
}

function normalizeBoardCards(cards) {
  const source = Array.isArray(cards) ? cards : ANALYSIS_BOARD_PRESETS.performance;
  const seen = new Set();
  const normalized = [];
  source.slice(0, ANALYSIS_BOARD_MAX_CARDS).forEach((card, index) => {
    const type = Object.prototype.hasOwnProperty.call(ANALYSIS_BOARD_CARD_TYPES, card?.type)
      ? card.type
      : 'timeline';
    const metric = typeof card?.metric === 'string' && card.metric.trim()
      ? card.metric.trim()
      : 'RenderedFPS';
    let id = String(card?.id || `card-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '-');
    if (!id || seen.has(id)) id = createBoardCardId();
    seen.add(id);
    const thresholdMs = Number.isFinite(Number(card?.thresholdMs)) && Number(card.thresholdMs) > 0
      ? Math.min(1000, Number(card.thresholdMs))
      : 16.67;
    normalized.push({ id, type, metric, thresholdMs });
  });
  return normalized;
}

function cardsMatchPreset(cards, presetCards) {
  if (!Array.isArray(cards) || cards.length !== presetCards.length) return false;
  return cards.every((card, index) => {
    const preset = presetCards[index];
    const sameThreshold = card.type !== 'advanced'
      || Math.abs(Number(card.thresholdMs || 16.67) - Number(preset.thresholdMs || 16.67)) < 0.001;
    return card.type === preset.type && card.metric === preset.metric && sameThreshold;
  });
}

function detectAnalysisBoardPreset(cards = analysisBoardConfig?.cards) {
  for (const [name, presetCards] of Object.entries(ANALYSIS_BOARD_PRESETS)) {
    if (cardsMatchPreset(cards, presetCards)) return name;
  }
  return 'custom';
}

function normalizeAnalysisBoardSelections(value) {
  const source = value && typeof value === 'object' ? value : ANALYSIS_BOARD_DEFAULT_SELECTIONS;
  const metrics = Array.from(new Set((Array.isArray(source.metrics) ? source.metrics : [])
    .filter(metric => typeof metric === 'string' && metric.trim())
    .map(metric => metric.trim())));
  const chartTypes = Array.from(new Set((Array.isArray(source.chartTypes) ? source.chartTypes : [])
    .filter(type => Object.prototype.hasOwnProperty.call(ANALYSIS_BOARD_CARD_TYPES, type))));
  return { metrics, chartTypes };
}

function cardsFromAnalysisBoardSelections(selections) {
  const cards = [];
  selections.metrics.forEach(metric => {
    selections.chartTypes.forEach(type => {
      if (cards.length >= ANALYSIS_BOARD_MAX_CARDS) return;
      cards.push({
        id: `selected-${type}-${metric}`.replace(/[^a-zA-Z0-9_-]/g, '-'),
        type,
        metric,
        thresholdMs: 16.67
      });
    });
  });
  return cards;
}

function loadAnalysisBoardConfig() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ANALYSIS_BOARD_STORAGE_KEY) || 'null');
    if (parsed && parsed.selections) {
      analysisBoardSelections = normalizeAnalysisBoardSelections(parsed.selections);
      return { cards: cardsFromAnalysisBoardSelections(analysisBoardSelections) };
    }
  } catch (error) {
    console.warn('Could not restore analysis-board configuration:', error);
  }
  analysisBoardSelections = normalizeAnalysisBoardSelections(ANALYSIS_BOARD_DEFAULT_SELECTIONS);
  return { cards: cardsFromAnalysisBoardSelections(analysisBoardSelections) };
}

function saveAnalysisBoardConfig() {
  if (!analysisBoardConfig) return;
  try {
    localStorage.setItem(ANALYSIS_BOARD_STORAGE_KEY, JSON.stringify({
      version: 3,
      selections: normalizeAnalysisBoardSelections(analysisBoardSelections)
    }));
  } catch (error) {
    console.warn('Could not save analysis-board configuration:', error);
  }
}

function ensureAnalysisBoardConfig() {
  if (!analysisBoardConfig) analysisBoardConfig = loadAnalysisBoardConfig();
  analysisBoardConfig.cards = normalizeBoardCards(analysisBoardConfig.cards);
  return analysisBoardConfig;
}

function getBoardMetricChoices() {
  const options = [];
  const seen = new Set();
  const add = (value, label) => {
    if (!value || seen.has(value) || ANALYSIS_BOARD_EXCLUDED_METRICS.has(value)) return;
    seen.add(value);
    options.push({ value, label: label || window.getMetricDisplayName?.(value) || value });
  };

  document.querySelectorAll('#metricSelect option').forEach(option => {
    add(option.value, option.textContent?.trim());
  });
  if (!options.length) ['FrameTime', 'RenderedFPS'].forEach(metric => add(metric));
  ensureAnalysisBoardConfig().cards.forEach(card => add(card.metric));
  return options;
}

function renderAnalysisBoardSetupChoices() {
  const metricContainer = document.getElementById('analysisBoardMetricOptions');
  const typeContainer = document.getElementById('analysisBoardChartTypeOptions');
  if (!metricContainer || !typeContainer) return;
  const selections = analysisBoardSelections || normalizeAnalysisBoardSelections(ANALYSIS_BOARD_DEFAULT_SELECTIONS);
  const appendChoice = (container, group, value, labelText, checked) => {
    const label = document.createElement('label');
    label.className = 'analysis-board-multi-option';
    label.htmlFor = `analysisBoard-${group}-${value}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = label.htmlFor;
    input.dataset.boardGroup = group;
    input.value = value;
    input.checked = checked;
    const text = document.createElement('span');
    text.textContent = labelText;
    label.append(input, text);
    container.appendChild(label);
  };

  metricContainer.innerHTML = '';
  getBoardMetricChoices().forEach(choice => {
    appendChoice(metricContainer, 'metric', choice.value, choice.label, selections.metrics.includes(choice.value));
  });
  typeContainer.innerHTML = '';
  Object.entries(ANALYSIS_BOARD_CARD_TYPES).forEach(([value, definition]) => {
    appendChoice(typeContainer, 'chartType', value, definition.label, selections.chartTypes.includes(value));
  });
}

function updateAnalysisBoardPresetControl() {
  renderAnalysisBoardSetupChoices();
  const selections = analysisBoardSelections || normalizeAnalysisBoardSelections(ANALYSIS_BOARD_DEFAULT_SELECTIONS);
  const metricChoices = getBoardMetricChoices();
  const selectedMetricLabels = metricChoices
    .filter(choice => selections.metrics.includes(choice.value))
    .map(choice => choice.label);
  const selectedTypeLabels = Object.entries(ANALYSIS_BOARD_CARD_TYPES)
    .filter(([value]) => selections.chartTypes.includes(value))
    .map(([, definition]) => definition.label);
  const summarize = (labels, emptyText) => {
    if (!labels.length) return emptyText;
    return labels.join(', ');
  };
  const metricSummary = document.getElementById('analysisBoardMetricSummary');
  const typeSummary = document.getElementById('analysisBoardChartTypeSummary');
  if (metricSummary) metricSummary.textContent = summarize(selectedMetricLabels, 'Select metrics');
  if (typeSummary) typeSummary.textContent = summarize(selectedTypeLabels, 'Select chart types');
  const combinationCount = selections.metrics.length * selections.chartTypes.length;
  const count = document.getElementById('analysisBoardCombinationCount');
  if (count) {
    count.textContent = combinationCount
      ? `${combinationCount} card${combinationCount === 1 ? '' : 's'} selected`
      : 'Select at least one metric and one chart type.';
  }
}

function destroyAnalysisBoardCharts() {
  analysisBoardCharts.forEach(chart => {
    try { chart?.destroy?.(); } catch (error) { console.warn('Board chart cleanup failed:', error); }
  });
  analysisBoardCharts = [];
}

function destroyAnalysisBoard() {
  destroyAnalysisBoardCharts();
  analysisBoardDatasetIndices = [];
  window.analysisBoardReady = false;
  const grid = document.getElementById('analysisBoardGrid');
  const legend = document.getElementById('analysisBoardLegend');
  const body = document.getElementById('analysisBoardStatsBody');
  const status = document.getElementById('analysisBoardStatus');
  const meta = document.getElementById('analysisBoardExportMeta');
  const caption = document.getElementById('analysisBoardStatsCaption');
  const exportButton = document.getElementById('exportAnalysisBoardPngBtn');
  if (grid) grid.innerHTML = '';
  if (legend) legend.innerHTML = '';
  if (body) body.innerHTML = '';
  if (status) status.textContent = '';
  if (meta) meta.textContent = 'Custom multi-chart performance report';
  if (caption) caption.textContent = 'Board summary statistics';
  if (exportButton) exportButton.disabled = true;
}

function syncVisualizationResultUi(mode = visualizationResultMode) {
  const boardMode = mode === 'board';
  const board = document.getElementById('analysisBoard');
  const chartContainer = document.getElementById('chartContainer');
  const orderList = document.getElementById('datasetOrderList');
  const resetButton = document.getElementById('resetZoomBtn');
  const exportButton = document.getElementById('exportChartPngBtn');
  const boardToolbar = document.getElementById('analysisBoardToolbar');
  const boardExportButton = document.getElementById('exportAnalysisBoardPngBtn');
  const heightControl = document.querySelector('.chart-height-control');
  const hint = document.getElementById('vizChartHint');

  board?.classList.toggle('hidden', !boardMode || !window.analysisBoardReady);
  chartContainer?.classList.toggle('hidden', boardMode);
  orderList?.classList.toggle('hidden', boardMode);
  resetButton?.classList.toggle('hidden', boardMode);
  exportButton?.classList.toggle('hidden', boardMode);
  boardToolbar?.classList.toggle('hidden', !boardMode);
  if (boardExportButton) boardExportButton.disabled = !window.analysisBoardReady || !window.htmlToImage;
  heightControl?.classList.toggle('hidden', boardMode);
  if (hint) {
    hint.classList.toggle('hidden', boardMode);
    hint.textContent = 'Drag to pan. Ctrl+scroll or Ctrl+drag to zoom. Double-click chart to reset. Use the legend to toggle series.';
  }
  updateAnalysisBoardPresetControl();
}

function setVisualizationResultMode(mode) {
  const next = mode === 'board' ? 'board' : 'single';
  if (visualizationResultMode === next) {
    syncVisualizationResultUi(next);
    return;
  }
  visualizationResultMode = next;
  clearChart();
  syncVisualizationResultUi(next);
}

function makeBoardLinearAxis(title, { beginAtZero = false, grid = true } = {}) {
  const theme = getChartThemeColors();
  return {
    type: 'linear',
    beginAtZero,
    title: { display: Boolean(title), text: title, color: theme.text },
    ticks: { color: theme.text, maxTicksLimit: 8 },
    grid: { display: grid, color: theme.grid },
    border: { color: theme.border }
  };
}

function makeBoardCategoryAxis(title = '') {
  const theme = getChartThemeColors();
  return {
    type: 'category',
    title: { display: Boolean(title), text: title, color: theme.text },
    ticks: { color: theme.text, autoSkip: false, callback(value) {
      return compactDatasetLabel(this.getLabelForValue(value), 28);
    } },
    grid: { display: false },
    border: { color: theme.border }
  };
}

function makeBoardOptions(scales, extra = {}) {
  const theme = getChartThemeColors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    normalized: true,
    parsing: false,
    interaction: { mode: 'nearest', intersect: false },
    scales,
    plugins: {
      legend: { display: false, labels: { color: theme.text } },
      tooltip: { enabled: false },
      zoom: false
    },
    elements: {
      line: { borderWidth: 1.5, tension: 0 },
      point: { radius: 0, hitRadius: 3 },
      bar: { borderRadius: 5, borderSkipped: false }
    },
    ...extra
  };
}

function createAnalysisBoardChart(canvas, config) {
  if (!canvas) return null;
  const existing = window.Chart?.getChart?.(canvas);
  existing?.destroy?.();
  const chart = new Chart(canvas.getContext('2d'), config);
  analysisBoardCharts.push(chart);
  return chart;
}

function getBoardCardText(card) {
  const metricLabel = window.getMetricDisplayName?.(card.metric) || card.metric;
  const type = ANALYSIS_BOARD_CARD_TYPES[card.type] || ANALYSIS_BOARD_CARD_TYPES.timeline;
  const titles = {
    timeline: `${metricLabel} timeline`,
    scatter: `${metricLabel} scatter`,
    percentile: `${metricLabel} percentiles`,
    histogram: `${metricLabel} histogram`,
    boxplot: `${metricLabel} distribution`,
    summary: `${metricLabel} summary`,
    advanced: `${metricLabel} advanced metrics`
  };
  return { title: titles[card.type] || metricLabel, description: type.description, metricLabel };
}

function makeBoardSelect(className, label, value, choices) {
  const select = document.createElement('select');
  select.className = className;
  select.setAttribute('aria-label', label);
  choices.forEach(choice => {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    select.appendChild(option);
  });
  select.value = value;
  return select;
}

function renderAnalysisBoardCardShells() {
  const grid = document.getElementById('analysisBoardGrid');
  if (!grid) return new Map();
  grid.innerHTML = '';
  const cards = ensureAnalysisBoardConfig().cards;
  const elements = new Map();

  cards.forEach((card, index) => {
    const text = getBoardCardText(card);
    const article = document.createElement('article');
    article.className = 'analysis-board-card';
    article.dataset.cardId = card.id;

    const header = document.createElement('div');
    header.className = 'analysis-board-card-head';
    const copy = document.createElement('div');
    copy.className = 'analysis-board-card-copy';
    const heading = document.createElement('h3');
    heading.textContent = text.title;
    const description = document.createElement('p');
    description.textContent = text.description;
    copy.append(heading, description);

    header.appendChild(copy);

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'analysis-board-canvas-wrap';
    const canvas = document.createElement('canvas');
    canvas.id = `analysisBoardChart-${card.id}`;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', text.title);
    const empty = document.createElement('p');
    empty.className = 'analysis-board-card-empty hidden';
    empty.setAttribute('aria-live', 'polite');
    canvasWrap.append(canvas, empty);
    article.append(header, canvasWrap);
    grid.appendChild(article);
    elements.set(card.id, { article, heading, description, canvas, empty });
  });
  updateAnalysisBoardPresetControl();
  return elements;
}

function setBoardCardEmpty(elements, message) {
  if (!elements) return;
  elements.canvas.classList.add('hidden');
  elements.empty.textContent = message;
  elements.empty.classList.remove('hidden');
}

function buildBoardLegend(indices) {
  const legend = document.getElementById('analysisBoardLegend');
  if (!legend) return;
  legend.innerHTML = '';
  indices.forEach(index => {
    const dataset = window.allDatasets[index];
    const item = document.createElement('span');
    item.className = 'analysis-board-legend-item';
    item.title = dataset?.name || '';
    const dot = document.createElement('span');
    dot.className = 'analysis-board-legend-dot';
    dot.style.backgroundColor = dataset?.color || getBenchmarkColor(index);
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.textContent = getDatasetLabel(dataset);
    item.append(dot, name);
    legend.appendChild(item);
  });
}

function isBoardFpsMetric(metric) {
  return metric === 'FPS' || metric === 'RenderedFPS' || metric === 'DisplayedFPS';
}

function buildBoardStatsTable(entries, metric) {
  const body = document.getElementById('analysisBoardStatsBody');
  const caption = document.getElementById('analysisBoardStatsCaption');
  if (!body) return;
  body.innerHTML = '';
  const metricLabel = window.getMetricDisplayName?.(metric) || metric;
  if (caption) caption.textContent = `${metricLabel} summary statistics`;

  entries.forEach(entry => {
    const row = document.createElement('tr');
    const nameCell = document.createElement('th');
    nameCell.scope = 'row';
    nameCell.title = entry.dataset.name;
    const dot = document.createElement('span');
    dot.className = 'analysis-board-table-dot';
    dot.style.backgroundColor = entry.color;
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.textContent = entry.label;
    nameCell.append(dot, name);
    row.appendChild(nameCell);

    const values = [
      window.formatStatValue?.(metric, 'avg', entry.stats.avg) ?? entry.stats.avg?.toFixed?.(2),
      window.formatStatValue?.(metric, 'low1', entry.stats.low1) ?? entry.stats.low1?.toFixed?.(2),
      window.formatStatValue?.(metric, 'low01', entry.stats.low01) ?? entry.stats.low01?.toFixed?.(2),
      window.formatStatValue?.(metric, 'stdev', entry.stats.stdev) ?? entry.stats.stdev?.toFixed?.(2),
      entry.values.length.toLocaleString()
    ];
    values.forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value || 'N/A';
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
}

function buildBoardCardChart(card, elements, entries) {
  if (!entries.length) {
    setBoardCardEmpty(elements, `No usable ${getBoardCardText(card).metricLabel} values in the selected datasets.`);
    return false;
  }
  const metricLabel = getBoardCardText(card).metricLabel;
  const yLabel = getYAxisLabel(card.metric);

  if (card.type === 'advanced') {
    const percentile = (sorted, percent) => {
      if (!sorted.length) return NaN;
      const position = (sorted.length - 1) * percent / 100;
      const lower = Math.floor(position);
      const upper = Math.ceil(position);
      return lower === upper
        ? sorted[lower]
        : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
    };
    const threshold = Number(card.thresholdMs) > 0 ? Number(card.thresholdMs) : 16.67;
    elements.canvas.classList.add('hidden');
    const panel = document.createElement('div');
    panel.className = 'analysis-board-advanced';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', `${metricLabel} advanced metrics with ${threshold.toFixed(2)} millisecond spike threshold`);
    entries.forEach(entry => {
      const sorted = Array.from(entry.values).sort((a, b) => a - b);
      const metrics = [
        ['Median', percentile(sorted, 50)],
        ['P95', percentile(sorted, 95)],
        ['P99', percentile(sorted, 99)],
        ['Maximum spike', sorted[sorted.length - 1]],
        [`Spikes > ${threshold.toFixed(2)} ms`, sorted.filter(value => value > threshold).length]
      ];
      const section = document.createElement('section');
      section.className = 'analysis-board-advanced-dataset';
      const heading = document.createElement('h4');
      heading.textContent = entry.label;
      heading.style.setProperty('--dataset-color', entry.color);
      const list = document.createElement('dl');
      metrics.forEach(([label, value], index) => {
        const term = document.createElement('dt');
        term.textContent = label;
        const detail = document.createElement('dd');
        detail.textContent = index === 4
          ? Number(value).toLocaleString()
          : (window.formatStatValue?.(card.metric, index === 0 ? 'median' : 'p1', value) ?? Number(value).toFixed(2));
        list.append(term, detail);
      });
      section.append(heading, list);
      panel.appendChild(section);
    });
    elements.canvas.parentElement.appendChild(panel);
    return true;
  }

  if (card.type === 'timeline' || card.type === 'scatter') {
    const useElapsedTime = [
      'FrameTime', 'DisplayedFrameTime', 'MsBetweenPresents', 'MsBetweenDisplayChange'
    ].includes(card.metric);
    const datasets = entries.map(entry => {
      const indicesToPlot = sampleIndices(entry.values.length, 2200);
      let points;
      if (useElapsedTime) {
        points = [];
        let elapsedMs = 0;
        let plotCursor = 0;
        for (let index = 0; index < entry.values.length; index++) {
          elapsedMs += entry.values[index];
          if (plotCursor < indicesToPlot.length && index === indicesToPlot[plotCursor]) {
            points.push({ x: elapsedMs / 1000, y: entry.values[index] });
            plotCursor += 1;
          }
        }
      } else {
        points = indicesToPlot.map(index => ({ x: index + 1, y: entry.values[index] }));
      }
      return {
        label: entry.label,
        data: points,
        borderColor: entry.color,
        backgroundColor: entry.color,
        pointRadius: card.type === 'scatter' ? 1.8 : 0,
        pointHoverRadius: card.type === 'scatter' ? 2.5 : 0,
        spanGaps: true,
        showLine: card.type !== 'scatter'
      };
    });
    createAnalysisBoardChart(elements.canvas, {
      type: 'line',
      data: { datasets },
      options: makeBoardOptions({
        x: makeBoardLinearAxis(useElapsedTime ? 'Elapsed time (s)' : 'Valid sample #', { grid: false }),
        y: makeBoardLinearAxis(yLabel)
      })
    });
    return true;
  }

  if (card.type === 'percentile') {
    const datasets = entries.map(entry => {
      const sorted = Array.from(entry.values).sort((a, b) => a - b);
      const plotIndices = sampleIndices(sorted.length, 1200);
      return {
        label: entry.label,
        data: plotIndices.map(index => ({
          x: sorted.length <= 1 ? 100 : index * 100 / (sorted.length - 1),
          y: sorted[index]
        })),
        borderColor: entry.color,
        backgroundColor: entry.color,
        pointRadius: 0,
        showLine: true
      };
    });
    const xAxis = makeBoardLinearAxis('Percentile', { grid: false });
    xAxis.min = 0;
    xAxis.max = 100;
    xAxis.ticks = { ...xAxis.ticks, callback: value => `${value}%` };
    createAnalysisBoardChart(elements.canvas, {
      type: 'line',
      data: { datasets },
      options: makeBoardOptions({ x: xAxis, y: makeBoardLinearAxis(yLabel) })
    });
    return true;
  }

  if (card.type === 'histogram') {
    const series = entries.map(entry => Array.from(entry.values));
    const shared = computeSharedHistogramEdges(series) || undefined;
    const histograms = series.map(values => buildHistogram(values, shared));
    const labels = histograms[0]?.labels || [];
    createAnalysisBoardChart(elements.canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: entries.map((entry, index) => ({
          label: entry.label,
          data: histogramCountsForDisplay(histograms[index].counts, true),
          backgroundColor: hexToRgba(entry.color, 0.42),
          borderColor: entry.color,
          borderWidth: 1,
          barPercentage: 1,
          categoryPercentage: 1
        }))
      },
      options: makeBoardOptions({
        x: {
          ...makeBoardCategoryAxis(metricLabel),
          ticks: { color: getChartThemeColors().text, autoSkip: true, maxTicksLimit: 8, maxRotation: 0 }
        },
        y: makeBoardLinearAxis('% of valid samples', { beginAtZero: true })
      }, { parsing: true })
    });
    return true;
  }

  if (card.type === 'boxplot') {
    try {
      createAnalysisBoardChart(elements.canvas, {
        type: 'boxplot',
        data: {
          labels: entries.map(entry => entry.label),
          datasets: [{
            label: metricLabel,
            data: entries.map(entry => sampleSeries(entry.values, MAX_DISTRIBUTION_POINTS)),
            backgroundColor: entries.map(entry => hexToRgba(entry.color, 0.45)),
            borderColor: entries.map(entry => entry.color),
            borderWidth: 1.5
          }]
        },
        options: makeBoardOptions({
          x: makeBoardLinearAxis(yLabel),
          y: makeBoardCategoryAxis('Dataset')
        }, { indexAxis: 'y', parsing: true })
      });
      return true;
    } catch (error) {
      console.error('Analysis-board box plot failed:', error);
      setBoardCardEmpty(elements, 'Box plot unavailable because the chart extension failed to load.');
      return false;
    }
  }

  if (card.type === 'summary') {
    const labels = ['Average', '1% Low', '0.1% Low'];
    createAnalysisBoardChart(elements.canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: entries.map(entry => ({
          label: entry.label,
          data: [entry.stats.avg, entry.stats.low1, entry.stats.low01],
          backgroundColor: hexToRgba(entry.color, 0.78),
          borderColor: entry.color,
          borderWidth: 1
        }))
      },
      options: makeBoardOptions({
        x: makeBoardLinearAxis(yLabel, { beginAtZero: isBoardFpsMetric(card.metric) }),
        y: makeBoardCategoryAxis('Statistic')
      }, { indexAxis: 'y', parsing: true })
    });
    return true;
  }

  setBoardCardEmpty(elements, 'Unsupported card type.');
  return false;
}

function scheduleAnalysisBoardRebuild() {
  clearTimeout(analysisBoardRebuildTimer);
  if (!window.analysisBoardReady || !analysisBoardDatasetIndices.length) return;
  analysisBoardRebuildTimer = setTimeout(() => {
    buildAnalysisBoard(analysisBoardDatasetIndices, { silent: true });
  }, 70);
}

function buildAnalysisBoard(indices, { silent = false } = {}) {
  destroyAnalysisBoardCharts();
  if (window.mainChart) {
    window.mainChart.destroy();
    window.mainChart = null;
  }
  window.chartDatasets.length = 0;
  window.chartLabels = [];
  document.getElementById('datasetOrderList')?.replaceChildren();
  setResetZoomEnabled(false);
  visualizationResultMode = 'board';
  window.assignDatasetColors?.();
  ensureAnalysisBoardConfig();

  const validIndices = indices.filter(index => window.allDatasets?.[index]);
  if (!validIndices.length) {
    window.analysisBoardReady = false;
    syncVisualizationResultUi('board');
    if (!silent) window.notify?.('Select at least one dataset before building the analysis board.', 'warning');
    return false;
  }
  analysisBoardDatasetIndices = validIndices.slice();
  buildBoardLegend(analysisBoardDatasetIndices);
  const cardElements = renderAnalysisBoardCardShells();
  const seriesCache = new Map();
  const getSeries = (index, metric) => {
    const key = `${index}\u0000${metric}`;
    if (!seriesCache.has(key)) {
      seriesCache.set(key, getMetricSeries(window.allDatasets[index], metric));
    }
    return seriesCache.get(key);
  };
  const getEntries = metric => validIndices.map(index => {
    const dataset = window.allDatasets[index];
    const values = getSeries(index, metric);
    if (!values?.length) return null;
    return {
      index,
      dataset,
      label: getDatasetLabel(dataset),
      color: dataset.color || getBenchmarkColor(index),
      values,
      stats: window.calculateStatistics(values, metric)
    };
  }).filter(Boolean);

  let builtCards = 0;
  ensureAnalysisBoardConfig().cards.forEach(card => {
    const elements = cardElements.get(card.id);
    const entries = getEntries(card.metric);
    if (buildBoardCardChart(card, elements, entries)) builtCards += 1;
  });

  if (!builtCards) {
    window.analysisBoardReady = false;
    syncVisualizationResultUi('board');
    if (!silent) window.notify?.('None of the board cards have usable values for the selected datasets.', 'warning');
    return false;
  }

  const summaryCard = ensureAnalysisBoardConfig().cards.find(card => card.type === 'summary');
  const statsMetric = summaryCard?.metric || ensureAnalysisBoardConfig().cards[0]?.metric || 'RenderedFPS';
  const statsEntries = getEntries(statsMetric);
  buildBoardStatsTable(statsEntries, statsMetric);

  const samples = statsEntries.reduce((sum, entry) => sum + entry.values.length, 0);
  const status = document.getElementById('analysisBoardStatus');
  const meta = document.getElementById('analysisBoardExportMeta');
  if (status) {
    status.textContent = `${validIndices.length} dataset${validIndices.length === 1 ? '' : 's'} · ${builtCards} card${builtCards === 1 ? '' : 's'}`;
  }
  if (meta) {
    meta.textContent = `${builtCards}-card analysis · ${validIndices.length} dataset${validIndices.length === 1 ? '' : 's'} · ${samples.toLocaleString()} summary samples`;
  }

  window.currentChartType = 'analysisboard';
  window.currentChartMetric = statsMetric;
  window.analysisBoardReady = true;
  const clearButton = document.getElementById('clearChartBtn');
  if (clearButton) clearButton.disabled = false;
  const exportButton = document.getElementById('exportAnalysisBoardPngBtn');
  if (exportButton) exportButton.disabled = !window.htmlToImage;
  syncVisualizationActionLabels();
  syncVisualizationResultUi('board');
  return true;
}

function resizeAnalysisBoardCharts() {
  if (!window.analysisBoardReady) return;
  analysisBoardCharts.forEach(chart => {
    try {
      chart.resize?.();
      chart.update?.('none');
    } catch (error) {
      console.warn('Analysis-board resize failed:', error);
    }
  });
}

function refreshAnalysisBoardTheme() {
  if (!window.analysisBoardReady) return;
  const theme = getChartThemeColors();
  analysisBoardCharts.forEach(chart => {
    Object.values(chart.options.scales || {}).forEach(scale => {
      if (scale.title) scale.title.color = theme.text;
      if (scale.ticks) scale.ticks.color = theme.text;
      if (scale.grid?.display !== false) scale.grid.color = theme.grid;
      if (scale.border) scale.border.color = theme.border;
    });
    if (chart.options.plugins?.legend?.labels) chart.options.plugins.legend.labels.color = theme.text;
    chart.update('none');
  });
}

function refreshDatasetDisplayNames() {
  const displayForIndex = index => getDatasetLabel(window.allDatasets?.[index]);
  (window.chartDatasets || []).forEach(dataset => {
    if (Number.isInteger(dataset.sourceDatasetIndex)) {
      const label = displayForIndex(dataset.sourceDatasetIndex);
      dataset.label = dataset.qqRole === 'reference' ? `${label} (normal ref.)` : label;
    }
  });
  const distributionIndices = getDistributionChartIndices();
  if (distributionIndices.length) {
    window.chartLabels = distributionIndices.map(displayForIndex);
    if (window.mainChart) window.mainChart.data.labels = window.chartLabels.slice();
  }
  if (window.currentChartType === 'summarybar') {
    const indices = typeof window.getDatasetPickerIndices === 'function'
      ? window.getDatasetPickerIndices('datasetSelect')
      : [];
    window.chartLabels = indices.map(displayForIndex);
    if (window.mainChart) window.mainChart.data.labels = window.chartLabels.slice();
  }
  if (window.mainChart) {
    window.mainChart.data.datasets = window.chartDatasets.slice();
    window.mainChart.update('none');
    updateDatasetOrder();
  }
  if (window.analysisBoardReady && analysisBoardDatasetIndices.length) {
    buildAnalysisBoard(analysisBoardDatasetIndices, { silent: true });
  }
}

function setupAnalysisBoardCustomization() {
  ensureAnalysisBoardConfig();
  const controls = document.getElementById('analysisBoardSetupHint');
  const metricDropdown = document.getElementById('analysisBoardMetricsDropdown');
  const chartTypeDropdown = document.getElementById('analysisBoardChartTypesDropdown');

  controls?.addEventListener('change', event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.dataset.boardGroup) return;
    const metrics = Array.from(
      controls.querySelectorAll('input[data-board-group="metric"]:checked'),
      input => input.value
    );
    const chartTypes = Array.from(
      controls.querySelectorAll('input[data-board-group="chartType"]:checked'),
      input => input.value
    );
    if (metrics.length * chartTypes.length > ANALYSIS_BOARD_MAX_CARDS) {
      target.checked = false;
      window.notify?.(`Choose combinations that create no more than ${ANALYSIS_BOARD_MAX_CARDS} cards.`, 'warning');
      return;
    }
    analysisBoardSelections = normalizeAnalysisBoardSelections({ metrics, chartTypes });
    analysisBoardConfig = { cards: cardsFromAnalysisBoardSelections(analysisBoardSelections) };
    saveAnalysisBoardConfig();
    updateAnalysisBoardPresetControl();
    if (window.analysisBoardReady) {
      destroyAnalysisBoard();
      syncVisualizationResultUi('board');
    }
  });

  metricDropdown?.addEventListener('toggle', () => {
    if (metricDropdown.open && chartTypeDropdown) chartTypeDropdown.open = false;
  });
  chartTypeDropdown?.addEventListener('toggle', () => {
    if (chartTypeDropdown.open && metricDropdown) metricDropdown.open = false;
  });
  document.addEventListener('click', event => {
    if (!controls?.contains(event.target)) {
      if (metricDropdown) metricDropdown.open = false;
      if (chartTypeDropdown) chartTypeDropdown.open = false;
    }
  });

  document.addEventListener('datasetsUpdated', () => {
    updateAnalysisBoardPresetControl();
    if (window.analysisBoardReady && analysisBoardDatasetIndices.length) {
      scheduleAnalysisBoardRebuild();
    }
  });
  updateAnalysisBoardPresetControl();
}


let chartOpGeneration = 0;

/**
 * Clears the current chart (removes all datasets from chartDatasets).
 */
function clearChart() {
  chartOpGeneration++;
  destroyAnalysisBoard();
  window.currentChartType = null;
  window.currentChartMetric = '';
  window.chartLabels = [];
  window.chartDatasets.length = 0;
  if (window.mainChart) {
    window.mainChart.destroy();
    window.mainChart = null;
  }

  const chartContainer = document.getElementById('chartContainer');
  if (chartContainer) {
    chartContainer.classList.add('empty');
    chartContainer.style.removeProperty('min-height');
  }

  const datasetOrderList = document.getElementById('datasetOrderList');
  if (datasetOrderList) {
    datasetOrderList.innerHTML = '';
  }

  updateChartStatusLine();

  const clearChartBtn = document.getElementById('clearChartBtn');
  if (clearChartBtn) {
    clearChartBtn.disabled = true;
    clearChartBtn.textContent = visualizationResultMode === 'board' ? 'Clear board' : 'Clear chart';
    clearChartBtn.setAttribute('aria-label', visualizationResultMode === 'board' ? 'Clear analysis board' : 'Clear chart');
  }
  setResetZoomEnabled(false);
  setChartBusy(false);
  document.getElementById('mainChart')?.setAttribute('aria-hidden', 'true');
  document.getElementById('mainChart')
    ?.setAttribute('aria-label', 'Frame timing chart. Select datasets, then add them to the chart.');
  syncVisualizationResultUi(visualizationResultMode);
}

function resetChartZoom() {
  if (!window.mainChart || window.currentChartType === 'summarybar') return;
  window.mainChart.resetZoom?.();
  setResetZoomEnabled(false);
}

// helper to convert "#RRGGBB" → "rgba(r,g,b,a)"
function hexToRgba(hex, alpha) {
  const bigint = parseInt(hex.replace('#',''), 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8)  & 255;
  const b = bigint & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function isAnalysisBoardModeSelected() {
  return (document.getElementById('vizResultMode')?.value || visualizationResultMode) === 'board';
}

function getAddToChartButtonLabel() {
  if (isAnalysisBoardModeSelected()) return 'Build analysis board';
  const chartTypeSelect = document.getElementById('chartTypeSelect')?.value;
  const isSummary = window.currentChartType === 'summarybar' || chartTypeSelect === 'summarybar';
  return isSummary ? 'Build summary bar' : 'Add to chart';
}

function hasVisualizationResult() {
  return isAnalysisBoardModeSelected()
    ? Boolean(window.analysisBoardReady)
    : Boolean(window.chartDatasets?.length);
}

function syncVisualizationActionLabels() {
  const boardMode = isAnalysisBoardModeSelected();
  const addButton = document.getElementById('addToChartBtn');
  const clearButton = document.getElementById('clearChartBtn');
  if (addButton && addButton.getAttribute('aria-busy') !== 'true') {
    addButton.textContent = getAddToChartButtonLabel();
    addButton.setAttribute('aria-label', boardMode ? 'Build analysis board' : 'Add selected datasets to chart');
  }
  if (clearButton) {
    clearButton.textContent = boardMode ? 'Clear board' : 'Clear chart';
    clearButton.setAttribute('aria-label', boardMode ? 'Clear analysis board' : 'Clear chart');
  }
}

function setChartBusy(busy) {
  const btn = document.getElementById('addToChartBtn');
  const clearChartBtn = document.getElementById('clearChartBtn');
  const container = document.getElementById('chartContainer');
  const statusLine = document.getElementById('chartStatusLine');
  const boardMode = isAnalysisBoardModeSelected();
  if (btn) {
    btn.disabled = busy;
    btn.setAttribute('aria-busy', String(busy));
    if (busy) {
      const selectedCount = window.getDatasetPickerIndices?.('datasetSelect').length || 0;
      btn.textContent = boardMode
        ? `Building board for ${selectedCount} dataset${selectedCount === 1 ? '' : 's'}…`
        : (selectedCount === 1 ? 'Adding 1 dataset…' : `Adding ${selectedCount} datasets…`);
      if (statusLine) {
        statusLine.textContent = boardMode
          ? `Preparing analysis board for ${selectedCount} selected dataset${selectedCount === 1 ? '' : 's'}.`
          : `Preparing chart for ${selectedCount} selected dataset${selectedCount === 1 ? '' : 's'}.`;
      }
    } else {
      syncVisualizationActionLabels();
      updateChartStatusLine();
    }
  }
  if (clearChartBtn) {
    clearChartBtn.disabled = busy || !hasVisualizationResult();
  }
  container?.classList.toggle('chart-busy', busy);
  container?.setAttribute('aria-busy', String(busy));
}

function removeExistingSeriesForDataset(datasetIndex, metric) {
  if (!Array.isArray(window.chartDatasets) || !window.chartDatasets.length) return;
  window.chartDatasets = window.chartDatasets.filter(cfg => !(
    cfg.sourceDatasetIndex === datasetIndex &&
    cfg.sourceMetric === metric
  ));
}

function getDistributionChartIndices() {
  const cfg = (window.chartDatasets || []).find(d => Array.isArray(d.sourceDatasetIndices));
  return cfg?.sourceDatasetIndices?.slice() || [];
}

function mergeDistributionIndices(existing, toAdd) {
  let merged = existing.filter(i => !toAdd.includes(i));
  return merged.concat(toAdd);
}

function rebuildDistributionChart(indices, metric, chartType) {
  const labels = indices.map(i => getDatasetLabel(window.allDatasets[i]));
  const fullGroups = indices.map(i => getMetricSeries(window.allDatasets[i], metric));
  const densityGroups = fullGroups.map(values =>
    sampleSeries(values, MAX_DISTRIBUTION_POINTS)
  );
  const colors = indices.map(i => window.allDatasets[i].color || getBenchmarkColor(i));

  window.chartLabels = labels.slice();

  if (chartType === 'violin') {
    window.chartDatasets = [{
      label: `${metric} Density`,
      type: 'violin',
      data: densityGroups,
      fullDistributionData: fullGroups,
      backgroundColor: colors.map(c => hexToRgba(c, 0.3)),
      borderColor: colors,
      borderWidth: 1,
      order: 2,
      sourceDatasetIndices: indices.slice(),
      sourceMetric: metric
    }, {
      label: `${metric} Quartiles`,
      type: 'boxplot',
      data: fullGroups,
      backgroundColor: colors.map(() => 'rgba(80,80,80,0.4)'),
      borderColor: colors.map(() => 'rgba(80,80,80,1)'),
      borderWidth: 2,
      order: 1,
      barPercentage: 0.05,
      categoryPercentage: 1.0,
      sourceDatasetIndices: indices.slice(),
      sourceMetric: metric
    }];
    return;
  }

  window.chartDatasets = [{
    label: `${metric} Quartiles`,
    type: 'boxplot',
    data: fullGroups,
    backgroundColor: colors.map(c => hexToRgba(c, 0.4)),
    borderColor: colors,
    borderWidth: 2,
    sourceDatasetIndices: indices.slice(),
    sourceMetric: metric
  }];
}

function getQQPairs() {
  const pairs = [];
  window.chartDatasets.forEach((dataset, chartIndex) => {
    if (dataset.qqRole !== 'sample') return;
    const refIndex = window.chartDatasets.findIndex(cfg =>
      cfg.qqRole === 'reference' && cfg.sourceDatasetIndex === dataset.sourceDatasetIndex
    );
    const chartIndices = refIndex >= 0 ? [chartIndex, refIndex] : [chartIndex];
    pairs.push({
      label: dataset.label,
      datasets: chartIndices.map(i => window.chartDatasets[i])
    });
  });
  return pairs;
}

function setChartDatasetsFromQQPairs(pairs) {
  window.chartDatasets = pairs.flatMap(pair => pair.datasets);
}

function getChartOrderEntries(qqPairsCache = null) {
  const chartType = window.currentChartType;

  if (chartType === 'violin' || chartType === 'boxplot') {
    return getDistributionChartIndices().map((datasetIndex, orderIndex) => ({
      kind: 'distribution',
      orderIndex,
      datasetIndex,
      label: getDatasetLabel(window.allDatasets[datasetIndex]) || `Dataset ${datasetIndex + 1}`
    }));
  }

  if (chartType === 'qqplot') {
    const pairs = qqPairsCache || getQQPairs();
    return pairs.map((pair, orderIndex) => ({
      kind: 'qq',
      orderIndex,
      chartIndices: pair.datasets.map((_, i) => i), // placeholder, not used after rebuild
      label: pair.label,
      pairIndex: orderIndex
    }));
  }

  return (window.chartDatasets || []).map((dataset, chartIndex) => ({
    kind: 'series',
    orderIndex: chartIndex,
    chartIndex,
    label: dataset.label
  }));
}

function swapChartDatasetsAt(a, b) {
  if (a === b) return;
  [window.chartDatasets[a], window.chartDatasets[b]] =
    [window.chartDatasets[b], window.chartDatasets[a]];
}

function refreshChartAfterOrderChange() {
  updateDatasetOrder();
  if (!window.mainChart) return;

  const chartType = window.currentChartType;
  if (window.currentChartType === 'violin' || window.currentChartType === 'boxplot') {
    window.mainChart.data.labels = window.chartLabels.slice();
  }
  window.mainChart.data.datasets = window.chartDatasets.slice();
  const scales = buildChartScales(chartType);
  if (chartType === 'violin' || chartType === 'boxplot') {
    applyDistributionValueAxisPadding(scales);
  }
  window.mainChart.options.scales = scales;
  window.mainChart.resetZoom?.();
  setResetZoomEnabled(false);
  window.mainChart.update('none');
}

/**
 * Builds chartDatasets (and for violin, chartLabels) then calls renderChart().
 * @param {number} generation - Operation token; abort if Clear/other ops advanced it.
 */
function addToChartCore(generation) {
  const isStale = () => generation !== chartOpGeneration;
  const select = document.getElementById('datasetSelect');
  if (!select || isStale()) return;

  const indices = typeof window.getDatasetPickerIndices === 'function'
    ? window.getDatasetPickerIndices(select)
    : [];
  if (indices.length === 0) {
    window.notify?.('Select at least one dataset before adding to chart.', 'warning');
    return;
  }

  const metric    = document.getElementById('metricSelect').value;
  const chartType = document.getElementById('chartTypeSelect').value;

  if (typeof window.assignDatasetColors === 'function') {
    window.assignDatasetColors();
  }

  if (['Stepwise_Relative_SD', 'Coefficient_of_Variation', 'RMSSD'].includes(metric)) {
    if (chartType !== 'summarybar') {
      window.notify?.('This is an aggregate frametime metric. Use Summary bar or the Statistics tab.', 'info');
      return;
    }
  }

  // ---- SUMMARY BAR (CapFrameX / FTA style, user-picked stats) ----
  if (chartType === 'summarybar') {
    const statKeys = getSelectedBarStats();
    if (!statKeys.length) {
      window.notify?.('Select at least one summary statistic.', 'warning');
      return;
    }

    if (window.chartDatasets.length && window.currentChartType && window.currentChartType !== 'summarybar') {
      window.notify?.(
        `You already started a "${window.currentChartType}" chart. Clear it first to switch to summary bar.`,
        'warning'
      );
      return;
    }

    if (isStale()) return;
    window.currentChartType = 'summarybar';
    window.currentChartMetric = metric;
    buildSummaryBarChart(indices, metric, statKeys);
    if (isStale()) return;
    renderChart('summarybar');
    updateDatasetOrder();
    return;
  }

  const hadExistingChart = window.chartDatasets.length > 0 && window.mainChart;

  if (!window.chartDatasets.length) {
    window.currentChartType = chartType;
    window.currentChartMetric = metric;
  }

  if (window.chartDatasets.length && chartType !== window.currentChartType) {
    window.notify?.(
      `You already started a "${window.currentChartType}" chart. Clear it first to switch to "${chartType}".`,
      'warning'
    );
    return;
  }

  if (window.chartDatasets.length && metric !== window.currentChartMetric) {
    window.notify?.(
      `This chart is already using "${window.getMetricDisplayName?.(window.currentChartMetric) || window.currentChartMetric}". Clear it before adding "${window.getMetricDisplayName?.(metric) || metric}".`,
      'warning'
    );
    return;
  }

  // ---- VIOLIN + BOXPLOT COMBO ----
  if (chartType === 'violin') {
    const existing = window.currentChartType === 'violin'
      ? getDistributionChartIndices()
      : [];
    const validIndices = indices.filter(idx => getMetricSeries(window.allDatasets[idx], metric).length);
    const allIndices = existing.length
      ? mergeDistributionIndices(existing, validIndices)
      : validIndices;

    if (!allIndices.length) {
      window.currentChartType = null;
      window.currentChartMetric = '';
      window.notify?.('No valid values were found for the selected datasets.', 'warning');
      return;
    }

    if (isStale()) return;
    rebuildDistributionChart(allIndices, metric, 'violin');
    if (isStale()) return;
    renderChart('violin');
    updateDatasetOrder();
    return;
  }

  // ---- BOXPLOT ONLY ----
  if (chartType === 'boxplot') {
    const existing = window.currentChartType === 'boxplot'
      ? getDistributionChartIndices()
      : [];
    const validIndices = indices.filter(idx => getMetricSeries(window.allDatasets[idx], metric).length);
    const allIndices = existing.length
      ? mergeDistributionIndices(existing, validIndices)
      : validIndices;

    if (!allIndices.length) {
      window.currentChartType = null;
      window.currentChartMetric = '';
      window.notify?.('No valid values were found for the selected datasets.', 'warning');
      return;
    }

    if (isStale()) return;
    rebuildDistributionChart(allIndices, metric, 'boxplot');
    if (isStale()) return;
    renderChart('boxplot');
    updateDatasetOrder();
    return;
  }

  // ---- ALL OTHER CHART TYPES ----
  if (chartType === 'histogram') {
    const existingIndices = window.chartDatasets
      .map(cfg => cfg.sourceDatasetIndex)
      .filter(Number.isInteger);
    const addedIndices = indices.filter(idx => {
      const ds = window.allDatasets[idx];
      return Boolean((typeof window.getDatasetRowCount === 'function' ? window.getDatasetRowCount(ds) : ds?.rows?.length) && getMetricSeries(ds, metric).length);
    });
    const allIndices = existingIndices
      .filter(idx => !addedIndices.includes(idx))
      .concat(addedIndices);

    if (!allIndices.length) {
      if (!hadExistingChart) {
        window.currentChartType = null;
        window.currentChartMetric = '';
      }
      window.notify?.('No valid values were found for the selected datasets.', 'warning');
      return;
    }

    if (isStale()) return;
    // Rebuild every overlay with one shared grid; a new range can change bins
    // for existing series, so this must be a full render.
    window.chartDatasets = allIndices.map(sourceDatasetIndex => ({ sourceDatasetIndex }));
    rebuildCurrentHistogramDatasets();
    if (isStale()) {
      if (!window.mainChart) window.chartDatasets.length = 0;
      return;
    }
    renderChart('histogram');
    updateDatasetOrder();
    return;
  }

  if (isStale()) return;
  indices.forEach(idx => {
    if (isStale()) return;
    const ds = window.allDatasets[idx];
    if (!(typeof window.getDatasetRowCount === 'function' ? window.getDatasetRowCount(ds) : ds?.rows?.length)) return;
    removeExistingSeriesForDataset(idx, metric);

    const vals = getMetricSeries(ds, metric);
    if (!vals.length) return;

    let cfg;

    if (chartType === 'line' || chartType === 'scatter') {
      const seriesResult = getLineScatterPoints(ds, metric);
      const { points, totalPoints, displayedPoints } = seriesResult;
      if (!points.length) return;

      const seriesColor = ds.color || getBenchmarkColor(idx);

      cfg = {
        label: getDatasetLabel(ds),
        data: points,
        totalPoints,
        displayedPoints,
        borderColor: seriesColor,
        backgroundColor: seriesColor,
        borderWidth: 2,
        pointRadius: chartType === 'scatter' ? 2 : 0,
        pointHitRadius: chartType === 'line' ? 4 : 2,
        showLine: chartType === 'line',
        spanGaps: true,
        fill: false,
        parsing: false,
        sourceDatasetIndex: idx,
        sourceMetric: metric
      };
    } else if (chartType === 'qqplot') {
      const qqResult = buildQQPlot(vals);
      if (!qqResult) {
        window.notify?.(`${getDatasetLabel(ds)}: need at least 2 valid values for a Q-Q plot.`, 'warning');
        return;
      }

      const seriesColor = ds.color || getBenchmarkColor(idx);

      window.chartDatasets.push({
        label: getDatasetLabel(ds),
        type: 'scatter',
        data: qqResult.points,
        borderColor: seriesColor,
        backgroundColor: hexToRgba(seriesColor, 0.75),
        pointRadius: 2.5,
        pointHitRadius: 6,
        showLine: false,
        parsing: false,
        order: 2,
        qqRole: 'sample',
        sourceDatasetIndex: idx,
        sourceMetric: metric,
        qqTotalPoints: qqResult.totalPoints,
        qqPlottedPoints: qqResult.plottedPoints
      });

      cfg = {
        label: `${getDatasetLabel(ds)} (normal ref.)`,
        type: 'scatter',
        data: qqResult.refLine,
        borderColor: hexToRgba(seriesColor, 0.9),
        backgroundColor: hexToRgba(seriesColor, 0.9),
        pointRadius: 0,
        borderWidth: 1.5,
        borderDash: [5, 4],
        showLine: true,
        parsing: false,
        order: 1,
        qqRole: 'reference',
        sourceDatasetIndex: idx,
        sourceMetric: metric
      };
    }

    if (cfg) window.chartDatasets.push(cfg);
  });

  if (isStale()) {
    // Drop late mutations if Clear/remove already destroyed the chart.
    if (!window.mainChart) window.chartDatasets.length = 0;
    return;
  }

  if (window.chartDatasets.length === 0) {
    if (!hadExistingChart) {
      window.currentChartType = null;
      window.currentChartMetric = '';
    }
    window.notify?.(chartType === 'qqplot'
      ? 'Could not build Q-Q plot from the selected data.'
      : 'No valid values were found for the selected datasets.', 'warning');
    return;
  }

  renderChart(chartType, { incremental: hadExistingChart });
  updateDatasetOrder();
}

function addToChart() {
  const btn = document.getElementById('addToChartBtn');
  if (btn?.disabled) return;

  const generation = ++chartOpGeneration;
  setChartBusy(true);
  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        if (generation !== chartOpGeneration) return;
        const resultMode = document.getElementById('vizResultMode')?.value || visualizationResultMode;
        if (resultMode === 'board') {
          const indices = typeof window.getDatasetPickerIndices === 'function'
            ? window.getDatasetPickerIndices('datasetSelect')
            : [];
          if (!indices.length) {
            window.notify?.('Select at least one dataset before building the analysis board.', 'warning');
            return;
          }
          buildAnalysisBoard(indices);
        } else {
          visualizationResultMode = 'single';
          syncVisualizationResultUi('single');
          addToChartCore(generation);
        }
      } catch (err) {
        console.error('Add to chart failed:', err);
        window.notify?.(`Failed to add chart: ${err.message}`, 'error');
      } finally {
        if (generation === chartOpGeneration) setChartBusy(false);
      }
    }, 0);
  });
}

/**
 * Move a dataset up/down in the chartDatasets array.
 * Useful if you want to let the user reorder the stacked order in the chart.
 * @param {number} index
 * @param {"up"|"down"} direction
 */
function moveDataset(orderIndex, direction) {
  const entries = getChartOrderEntries();
  if (orderIndex < 0 || orderIndex >= entries.length) return;
  if (direction === 'up' && orderIndex === 0) return;
  if (direction === 'down' && orderIndex === entries.length - 1) return;

  const swapWith = direction === 'up' ? orderIndex - 1 : orderIndex + 1;
  const entry = entries[orderIndex];
  const other = entries[swapWith];

  if (entry.kind === 'distribution' && other.kind === 'distribution') {
    const indices = getDistributionChartIndices();
    [indices[orderIndex], indices[swapWith]] = [indices[swapWith], indices[orderIndex]];
    rebuildDistributionChart(indices, window.currentChartMetric, window.currentChartType);
    refreshChartAfterOrderChange();
    return;
  }

  if (entry.kind === 'qq' && other.kind === 'qq') {
    const pairs = getQQPairs();
    [pairs[orderIndex], pairs[swapWith]] = [pairs[swapWith], pairs[orderIndex]];
    setChartDatasetsFromQQPairs(pairs);
    refreshChartAfterOrderChange();
    return;
  }

  if (entry.kind === 'series' && other.kind === 'series') {
    swapChartDatasetsAt(entry.chartIndex, other.chartIndex);
    refreshChartAfterOrderChange();
  }
}

/**
 * Removes a dataset from the chart order list at the specified entry index.
 * @param {number} orderIndex
 */
function removeChartSeries(orderIndex) {
  const entries = getChartOrderEntries();
  const entry = entries[orderIndex];
  if (!entry) return;

  if (entry.kind === 'distribution') {
    const indices = getDistributionChartIndices().filter(i => i !== entry.datasetIndex);
    if (!indices.length) {
      clearChart();
      return;
    }
    rebuildDistributionChart(indices, window.currentChartMetric, window.currentChartType);
    refreshChartAfterOrderChange();
    return;
  }

  if (entry.kind === 'qq') {
    const pairs = getQQPairs();
    pairs.splice(orderIndex, 1);
    if (!pairs.length) {
      clearChart();
      return;
    }
    setChartDatasetsFromQQPairs(pairs);
    refreshChartAfterOrderChange();
    return;
  }

  if (entry.kind === 'series') {
    window.chartDatasets.splice(entry.chartIndex, 1);
    if (!window.chartDatasets.length) {
      clearChart();
      return;
    }
    refreshChartAfterOrderChange();
  }
}

/**
 * Re‑build the UL that shows the stacking order.
 * Called after every add / move / remove.
 */
function updateDatasetOrder () {
  const orderList = document.getElementById('datasetOrderList');
  if (!orderList) return;

  const frag = document.createDocumentFragment();
  const qqPairs = window.currentChartType === 'qqplot' ? getQQPairs() : null;
  const entries = getChartOrderEntries(qqPairs);

  entries.forEach((entry, index) => {
    const dataset = entry.kind === 'series'
      ? window.chartDatasets[entry.chartIndex]
      : entry.kind === 'qq'
        ? qqPairs[entry.orderIndex]?.datasets[0]
        : window.chartDatasets.find(d => Array.isArray(d.sourceDatasetIndices));

    const li = document.createElement('li');
    li.className      = 'dataset-order-item';
    li.dataset.index  = index;
    li.setAttribute('aria-posinset', String(index + 1));
    li.setAttribute('aria-setsize', String(entries.length));

    const swatch = document.createElement('div');
    swatch.className = 'dataset-color';
    swatch.setAttribute('aria-hidden', 'true');
    if (entry.kind === 'distribution') {
      const ds = window.allDatasets[entry.datasetIndex];
      swatch.style.background = ds?.color || getBenchmarkColor(entry.datasetIndex);
    } else {
      swatch.style.background =
        Array.isArray(dataset?.backgroundColor)
          ? dataset.backgroundColor[0]
          : dataset?.backgroundColor || dataset?.borderColor || '#888';
    }

    const name = document.createElement('span');
    name.textContent = entry.label;

    const controls = document.createElement('div');
    controls.className = 'dataset-order-controls';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', `Reorder ${entry.label}`);

    const mkBtn = (txt, title, cb, disabled = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = txt;
      b.title       = title;
      b.setAttribute('aria-label', title);
      b.disabled = disabled;
      b.addEventListener('click', () => cb(index));
      return b;
    };

    const removeLabel = window.currentChartType === 'summarybar'
      ? 'Remove series'
      : 'Remove dataset';

    controls.append(
      mkBtn('▲', 'Move up', i => moveDataset(i, 'up'), index === 0),
      mkBtn('▼', 'Move down', i => moveDataset(i, 'down'), index === entries.length - 1),
      mkBtn('×', removeLabel, i => removeChartSeries(i))
    );

    li.append(swatch, name, controls);
    frag.appendChild(li);
  });

  orderList.innerHTML = '';
  orderList.appendChild(frag);
  updateChartStatusLine();
}

function getBoardExportBackground() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:-9999px;visibility:hidden;background:var(--v2-bg, var(--bg, #1a1a1a))';
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).backgroundColor || '#1a1a1a';
  probe.remove();
  return color;
}

function sanitizeExportFilename(value) {
  return String(value || 'analysis-board')
    .trim()
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'analysis-board';
}

function waitForBoardExportLayout() {
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60)));
  });
}

async function exportAnalysisBoardPng() {
  const toPng = window.htmlToImage?.toPng;
  if (typeof toPng !== 'function') {
    window.notify?.('PNG export library failed to load. Check your connection and reload.', 'error');
    return;
  }
  if (!window.analysisBoardReady) {
    window.notify?.('Build the analysis board before exporting it.', 'warning');
    return;
  }

  const target = document.getElementById('analysisBoard');
  const button = document.getElementById('exportAnalysisBoardPngBtn');
  const titleInput = document.getElementById('analysisBoardTitleInput');
  const heading = document.getElementById('analysisBoardHeading');
  const meta = document.getElementById('analysisBoardExportMeta');
  const footer = document.getElementById('analysisBoardExportFooter');
  if (!target || !heading) return;

  const title = titleInput?.value.trim() || heading.textContent.trim() || 'Performance overview';
  heading.textContent = title;
  const originalMeta = meta?.textContent || '';
  const originalFooter = footer?.textContent || '';
  const originalInlineStyle = target.getAttribute('style');
  const exportedAt = new Date();
  const dateText = exportedAt.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Rendering board…';
  }
  window.notify?.('Rendering analysis-board PNG…', 'info');

  try {
    if (meta) meta.textContent = `${originalMeta} · Exported ${dateText}`;
    if (footer) footer.textContent = `Generated with Frame Timing Analyzer · ${dateText}`;
    target.classList.add('analysis-board-exporting');
    target.style.width = '1600px';
    target.style.maxWidth = '1600px';
    target.style.margin = '0';

    await waitForBoardExportLayout();
    resizeAnalysisBoardCharts();
    await waitForBoardExportLayout();

    const width = 1600;
    const height = Math.ceil(target.scrollHeight);
    const url = await toPng(target, {
      backgroundColor: getBoardExportBackground(),
      pixelRatio: 2,
      cacheBust: true,
      width,
      height,
      style: {
        width: `${width}px`,
        maxWidth: 'none',
        margin: '0'
      }
    });

    const link = document.createElement('a');
    const timestamp = exportedAt.toISOString().replace(/[:.]/g, '-');
    link.href = url;
    link.download = `${sanitizeExportFilename(title)}-${timestamp}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.notify?.('Analysis board exported as one high-resolution PNG.', 'success');
  } catch (error) {
    console.error('Analysis-board export failed:', error);
    window.notify?.(`Could not export analysis board: ${error.message}`, 'error');
  } finally {
    target.classList.remove('analysis-board-exporting');
    if (originalInlineStyle == null) target.removeAttribute('style');
    else target.setAttribute('style', originalInlineStyle);
    if (meta) meta.textContent = originalMeta;
    if (footer) footer.textContent = originalFooter;
    await waitForBoardExportLayout();
    resizeAnalysisBoardCharts();
    if (button) {
      button.disabled = !window.analysisBoardReady;
      button.removeAttribute('aria-busy');
      button.textContent = 'Export board PNG';
    }
  }
}

/**
 * Exports a Chart.js instance as a PNG. Chart.js canvases are transparent,
 * so we composite onto a solid background matching the app theme first.
 */
function exportChartPng(chart, filenamePrefix = 'chart') {
  if (!chart || !chart.canvas) {
    window.notify?.('Nothing to export yet - add data to the chart first.', 'warning');
    return;
  }

  const source = chart.canvas;
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = source.width;
  exportCanvas.height = source.height;
  const ctx = exportCanvas.getContext('2d');

  const probe = document.createElement('d' + 'iv');
  probe.style.cssText = 'position:fixed;left:-9999px;visibility:hidden;background:var(--panel-bg)';
  document.body.appendChild(probe);
  const bg = getComputedStyle(probe).backgroundColor || '#141414';
  probe.remove();
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
  ctx.drawImage(source, 0, 0);

  const url = exportCanvas.toDataURL('image/png', 1.0);
  const link = document.createElement('a');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.href = url;
  link.download = `${filenamePrefix}-${timestamp}.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();

  window.notify?.('Chart exported as PNG.', 'success');
}


// Expose chart functionality to the global scope
window.getBenchmarkColor = getBenchmarkColor;
window.BENCHMARK_COLORS = BENCHMARK_COLORS;
window.assignDatasetColors = assignDatasetColors;
window.buildHistogram = buildHistogram;
window.buildQQPlot = buildQQPlot;
window.renderChart = renderChart;
window.rebuildCurrentHistogramDatasets = rebuildCurrentHistogramDatasets;
window.syncLiveChartColors = syncLiveChartColors;
window.clearChart = clearChart;
window.addToChart = addToChart;
window.moveDataset = moveDataset;
window.updateDatasetOrder = updateDatasetOrder;
window.removeChartSeries = removeChartSeries;
window.resetChartZoom = resetChartZoom;
window.setResetZoomEnabled = setResetZoomEnabled;

function refreshChartTheme() {
  initChartDefaults();
  const chart = window.mainChart;
  if (!chart) {
    refreshAnalysisBoardTheme();
    return;
  }

  const theme = getChartThemeColors();
  chart.options.scales = buildChartScales(window.currentChartType);
  if (chart.options.plugins?.tooltip) {
    chart.options.plugins.tooltip.backgroundColor = theme.tooltipBg;
    chart.options.plugins.tooltip.titleColor = theme.tooltipTitle;
    chart.options.plugins.tooltip.bodyColor = theme.tooltipBody;
    chart.options.plugins.tooltip.borderColor = theme.border;
  }
  if (chart.options.plugins?.legend?.labels) {
    chart.options.plugins.legend.labels.color = theme.text;
  }
  chart.update('none');
  refreshAnalysisBoardTheme();
}

window.getChartThemeColors = getChartThemeColors;
window.refreshChartTheme = refreshChartTheme;

window.exportChartPng = exportChartPng;
window.exportAnalysisBoardPng = exportAnalysisBoardPng;
window.syncVisualizationActionLabels = syncVisualizationActionLabels;
window.setVisualizationResultMode = setVisualizationResultMode;
window.buildAnalysisBoard = buildAnalysisBoard;
window.refreshDatasetDisplayNames = refreshDatasetDisplayNames;
window.refreshAnalysisBoardTheme = refreshAnalysisBoardTheme;
window.resizeAnalysisBoardCharts = resizeAnalysisBoardCharts;
window.setupAnalysisBoardCustomization = setupAnalysisBoardCustomization;
