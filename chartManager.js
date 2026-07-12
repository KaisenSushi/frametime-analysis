// We'll store the Chart.js instance & chart-specific data arrays
window.mainChart = null;
window.chartDatasets = [];
window.currentChartMetric = '';

// Benchmark palette from BoringBoredom's Frame-Time-Analysis
const BENCHMARK_COLORS = [
  '#800000', '#008000', '#00bfff', '#ff8c00', '#ff00ff', '#deb887',
  '#00ff00', '#0000ff', '#000080', '#2f4f4f', '#ffff54', '#dda0dd',
  '#ff1493', '#7fffd4'
];

const CHART_TEXT = 'rgba(255,255,255,0.88)';
const CHART_GRID = 'rgba(70,70,70,0.45)';
const CHART_BORDER = 'rgba(70,70,70,0.8)';

function getBenchmarkColor(index) {
  return BENCHMARK_COLORS[index % BENCHMARK_COLORS.length];
}

function assignDatasetColors() {
  (window.allDatasets || []).forEach((ds, index) => {
    if (!ds.color) ds.color = getBenchmarkColor(index);
  });
}

/** Frame-Time-Analysis style global Chart.js defaults */
function initChartDefaults() {
  if (!window.Chart?.defaults) return;
  const d = Chart.defaults;
  d.animation = false;
  d.font.size = 13;
  d.color = CHART_TEXT;
  d.borderColor = CHART_BORDER;
  d.normalized = true;
}

initChartDefaults();

/** CapFrameX / FTA-style summary bar stat colors */
const BAR_STAT_DEFS = [
  { key: 'max',    label: 'Max',       color: 'rgb(0,70,0)' },
  { key: 'avg',    label: 'Avg',       color: 'rgb(0,140,0)' },
  { key: 'min',    label: 'Min',       color: 'rgb(0,210,0)' },
  { key: 'p1',     label: '1%ile',     color: 'rgb(0,0,70)' },
  { key: 'p01',    label: '0.1%ile',   color: 'rgb(0,0,140)' },
  { key: 'p001',   label: '0.01%ile',  color: 'rgb(0,0,210)' },
  { key: 'low1',   label: '1% Low',    color: 'rgb(70,0,0)' },
  { key: 'low01',  label: '0.1% Low',  color: 'rgb(140,0,0)' },
  { key: 'low001', label: '0.01% Low', color: 'rgb(210,0,0)' },
  { key: 'stdev',  label: 'STDEV',     color: 'rgb(140,140,140)' }
];

const BAR_STAT_DEF_MAP = Object.fromEntries(BAR_STAT_DEFS.map(d => [d.key, d]));

function formatSummaryBarValue(value) {
  if (!Number.isFinite(value)) return '';
  if (typeof window.formatStatValue === 'function') {
    return window.formatStatValue(window.currentChartMetric, 'avg', value);
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

        const text = formatSummaryBarValue(value);
        const { x, y, base } = bar.getProps(['x', 'y', 'base'], true);
        const barEnd = Math.max(x, base);
        const barStart = Math.min(x, base);
        const barWidth = barEnd - barStart;
        const textWidth = ctx.measureText(text).width;

        if (barWidth > textWidth + 16) {
          ctx.fillStyle = 'rgba(255,255,255,0.95)';
          ctx.fillText(text, barStart + 8, y);
        } else {
          ctx.fillStyle = CHART_TEXT;
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
  const labels = indices.map(i => window.allDatasets[i].name);
  const benchStats = indices.map(i => {
    const ds = window.allDatasets[i];
    const values = getStatsSeriesForChart(ds, metric);
    return window.calculateStatistics(values, metric);
  });

  window.chartLabels = labels;
  window.chartDatasets = statKeys.map(statKey => {
    const def = BAR_STAT_DEF_MAP[statKey];
    const label = def?.label || (typeof window.getStatDisplayName === 'function'
      ? window.getStatDisplayName(statKey)
      : statKey);
    return {
      label,
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

  adjustSummaryBarHeight(indices.length);
}

function adjustSummaryBarHeight(datasetCount) {
  const chartContainer = document.getElementById('chartContainer');
  const range = document.getElementById('chartHeight');
  if (!chartContainer) return;
  const autoMin = Math.max(280, 72 + datasetCount * 48);
  chartContainer.style.minHeight = autoMin + 'px';
  if (range && +range.value < autoMin) {
    range.value = String(Math.min(900, autoMin));
    chartContainer.style.height = range.value + 'px';
    const heightValSpan = document.getElementById('chartHeightValue');
    if (heightValSpan) heightValSpan.textContent = range.value + 'px';
    if (window.mainChart) window.mainChart.resize();
  }
}

// Cap rendered points so large captures stay responsive.
const MAX_LINE_SCATTER_POINTS = 4500;
const MAX_DISTRIBUTION_POINTS = 6000;
const MAX_QQ_POINTS = 3000;

/**
 * Largest-Triangle-Three-Buckets downsampling — preserves visual shape of line data.
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

/** Detect timestamp column once per dataset instead of scanning every row. */
function getDatasetTimestampKey(dataset) {
  if (dataset._timestampKey !== undefined) return dataset._timestampKey;

  const sample = dataset.rows?.[0];
  if (!sample) {
    dataset._timestampKey = null;
    return null;
  }

  for (const key of Object.keys(sample)) {
    const lk = key.toLowerCase();
    if (
      lk === 'timestamp' ||
      lk.includes('elapsed time') ||
      lk.includes('timestamp (elapsed time in seconds)') ||
      (lk.startsWith('time') && lk.includes('seconds'))
    ) {
      dataset._timestampKey = key;
      return key;
    }
  }

  dataset._timestampKey = null;
  return null;
}

/** Cached numeric series for a metric — avoids re-reading every row on each add. */
function getMetricSeries(dataset, metric) {
  if (!dataset._seriesCache) dataset._seriesCache = Object.create(null);
  if (dataset._seriesCache[metric]) return dataset._seriesCache[metric];

  const rows = dataset.rows || [];
  const values = [];
  for (let i = 0; i < rows.length; i++) {
    const v = getMetricValue(rows[i], metric);
    if (Number.isFinite(v)) values.push(v);
  }
  dataset._seriesCache[metric] = values;
  return values;
}

function sampleSeries(values, maxPoints) {
  if (values.length <= maxPoints) return values;
  const out = new Array(maxPoints);
  const step = values.length / maxPoints;
  for (let i = 0; i < maxPoints; i++) {
    out[i] = values[Math.floor(i * step)];
  }
  return out;
}

/**
 * Builds (and caches) line/scatter points with optional LTTB decimation.
 */
function getLineScatterPoints(dataset, metric, useValueX) {
  if (!dataset._pointCache) dataset._pointCache = Object.create(null);
  const cacheKey = `${metric}:${useValueX ? 1 : 0}`;
  if (dataset._pointCache[cacheKey]) return dataset._pointCache[cacheKey];

  const rows = dataset.rows || [];
  const timestampKey = useValueX ? getDatasetTimestampKey(dataset) : null;
  const points = [];
  let frameIndex = 0;

  for (let i = 0; i < rows.length; i++) {
    const value = getMetricValue(rows[i], metric);
    if (!Number.isFinite(value)) continue;

    frameIndex++;
    let xValue = frameIndex;
    if (useValueX && timestampKey) {
      const ts = parseFloat(rows[i][timestampKey]);
      if (Number.isFinite(ts)) xValue = ts;
    }

    points.push({ x: xValue, y: value });
  }

  const totalPoints = points.length;
  const displayPoints = totalPoints > MAX_LINE_SCATTER_POINTS
    ? decimateLTTB(points, MAX_LINE_SCATTER_POINTS)
    : points;

  const result = { points: displayPoints, totalPoints, displayedPoints: displayPoints.length };
  dataset._pointCache[cacheKey] = result;
  return result;
}

function buildLineScatterPoints(rows, metric, useValueX) {
  // Legacy entry point — prefer getLineScatterPoints when dataset object is available.
  const dataset = { rows, _pointCache: null, _timestampKey: undefined };
  return getLineScatterPoints(dataset, metric, useValueX).points;
}

/**
 * Builds a histogram from an array of numeric data.
 * @param {number[]} data
 * @returns {{labels: string[], counts: number[]}}
 */
function buildHistogram(data) {
  if (!data.length) {
    return { labels: [], counts: [] };
  }

  let minVal = Infinity;
  let maxVal = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }

  // Handle case where all values are identical
  if (minVal === maxVal) {
    return { labels: [minVal.toString()], counts: [data.length] };
  }

  const binCount = Math.max(1, Math.min(50, Math.ceil(Math.sqrt(data.length))));
  const binWidth = (maxVal - minVal) / binCount;
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

/**
 * Rebuilds X/Y points for existing line/scatter datasets when Time-based X toggles.
 * Uses source metadata captured when datasets are added to the chart.
 */
function rebuildCurrentLineScatterDatasets() {
  if (!Array.isArray(window.chartDatasets) || !window.chartDatasets.length) return;
  if (window.currentChartType !== 'line' && window.currentChartType !== 'scatter') return;

  const useValueX = document.getElementById('useValueX')?.checked;

  window.chartDatasets = window.chartDatasets.map(datasetCfg => {
    const sourceDatasetIndex = datasetCfg.sourceDatasetIndex;
    const sourceMetric = datasetCfg.sourceMetric;

    if (!Number.isInteger(sourceDatasetIndex) || typeof sourceMetric !== 'string') {
      return datasetCfg;
    }

    const sourceDataset = window.allDatasets?.[sourceDatasetIndex];
    if (!sourceDataset?.rows?.length) return datasetCfg;

    if (sourceDataset._pointCache) sourceDataset._pointCache = Object.create(null);
    const { points, totalPoints, displayedPoints } = getLineScatterPoints(
      sourceDataset, sourceMetric, useValueX
    );
    if (!points.length) return datasetCfg;

    return {
      ...datasetCfg,
      data: points,
      totalPoints,
      displayedPoints
    };
  });
}

/**
 * Evenly subsample a sorted array while preserving order statistics (for Q-Q plots).
 * @param {number[]} sorted ascending values
 * @param {number} maxPoints
 * @returns {number[]}
 */
function subsampleSorted(sorted, maxPoints) {
  if (sorted.length <= maxPoints) return sorted;
  const out = new Array(maxPoints);
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(
      sorted.length - 1,
      Math.floor((i * sorted.length) / maxPoints)
    );
    out[i] = sorted[idx];
  }
  return out;
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

  const sample = subsampleSorted(sorted, MAX_QQ_POINTS);
  const n = sample.length;
  const mean = jStat.mean(sample);
  const std = jStat.stdev(sample);

  const points = [];
  for (let i = 0; i < n; i++) {
    const p = (i + 0.5) / n;
    const z = jStat.normal.inv(p, 0, 1);
    if (!Number.isFinite(z)) continue;
    points.push({ x: z, y: sample[i] });
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

  return { points, refLine, mean, std: safeStd };
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
  return {
    type: 'linear',
    ...config,
    title: { display: true, text: title, color: CHART_TEXT, font: { size: 13, weight: '600' } },
    ticks: { color: CHART_TEXT, maxTicksLimit: 12 },
    grid: { color: CHART_GRID },
    border: { color: CHART_BORDER }
  };
}

function getYAxisLabel(metric) {
  if (!metric) return 'Value';
  if (metric === 'FPS' || metric === 'RenderedFPS' || metric === 'DisplayedFPS') return 'FPS';
  if (metric === 'FrameTime' || /^Ms/i.test(metric)) return 'ms';
  if (typeof window.getMetricChipLabel === 'function') return window.getMetricChipLabel(metric);
  return typeof window.getMetricDisplayName === 'function'
    ? window.getMetricDisplayName(metric)
    : metric;
}

function buildZoomOptions() {
  return {
    pan: { enabled: true, mode: 'xy' },
    zoom: {
      wheel: { enabled: true, modifierKey: 'ctrl' },
      drag: {
        enabled: true,
        modifierKey: 'ctrl',
        backgroundColor: 'rgba(90,90,90,0.15)',
        borderColor: 'rgba(255,255,255,0.35)',
        borderWidth: 1
      },
      pinch: { enabled: true },
      mode: 'xy'
    },
    limits: {
      x: { min: 'original', max: 'original' },
      y: { min: 'original', max: 'original' }
    }
  };
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
  const scales = {};
  const useValueX = document.getElementById('useValueX')?.checked;
  const xTitle = useValueX ? 'Duration (s)' : 'Frame #';
  const yTitle = getYAxisLabel(window.currentChartMetric);

  if (chartType === 'histogram') {
    scales.x = { type: 'category', title: { display: true, text: 'Bin Range', color: CHART_TEXT }, ticks: { color: CHART_TEXT }, grid: { color: CHART_GRID } };
    scales.y = styleLinearAxis({}, 'Count');
  } else if (chartType === 'summarybar') {
    scales.x = styleLinearAxis({ min: 0, grid: { display: true } }, getYAxisLabel(window.currentChartMetric));
    scales.y = {
      type: 'category',
      grid: { display: false },
      ticks: { color: CHART_TEXT, autoSkip: false },
      border: { color: CHART_BORDER }
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
  } else if (chartType === 'boxplot') {
    scales.y = { type: 'category', title: { display: true, text: 'Dataset', color: CHART_TEXT }, ticks: { color: CHART_TEXT }, grid: { display: false } };
    scales.x = styleLinearAxis({ beginAtZero: false, grace: '10%' }, yTitle);
  } else if (chartType === 'violin') {
    scales.x = { type: 'category', title: { display: true, text: 'Dataset', color: CHART_TEXT }, ticks: { color: CHART_TEXT }, grid: { color: CHART_GRID } };
    scales.y = styleLinearAxis({ beginAtZero: false, grace: '10%' }, yTitle);
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
    return;
  }
  chartContainer.classList.remove('empty');

  if (canIncremental) {
    window.mainChart.data.datasets = window.chartDatasets.slice();
    if (chartType === 'violin' || chartType === 'boxplot') {
      window.mainChart.data.labels = window.chartLabels.slice();
    }
    window.mainChart.options.scales = buildChartScales(chartType);
    window.mainChart.update('none');
    return;
  }

  if (window.mainChart) {
    window.mainChart.destroy();
  }

  const ctrlType = getControllerType(chartType);
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
        decimation: (chartType === 'line' || chartType === 'scatter') ? {
          enabled: true,
          algorithm: 'lttb',
          samples: 2000
        } : false,
        tooltip: {
          backgroundColor: 'rgba(30,30,30,0.95)',
          titleColor: CHART_TEXT,
          bodyColor: CHART_TEXT,
          borderColor: CHART_BORDER,
          borderWidth: 1,
          callbacks: {
            label(ctx) {
              if (ctx.dataset.type === 'violin') {
                const vals = ctx.dataset.data[ctx.dataIndex];
                const [q1, m, q3] = jStat.quantiles(vals, [0.25, 0.5, 0.75]);
                return [
                  `N = ${vals.length}`,
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
                const formatted = typeof window.formatStatValue === 'function'
                  ? window.formatStatValue(window.currentChartMetric, 'avg', val)
                  : val.toFixed(2);
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
            color: CHART_TEXT,
            boxWidth: 14,
            padding: 12,
            usePointStyle: true,
            pointStyle: 'line'
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

  if (chartType === 'boxplot') {
    cfg.options.indexAxis = 'y';
  }

  if (chartType === 'violin' || chartType === 'boxplot') {
    // For the horizontal boxplot the numeric values live on the x axis.
    const valueAxis = chartType === 'boxplot' ? 'x' : 'y';

    let minValue = Infinity;
    let maxValue = -Infinity;
    window.chartDatasets.forEach(dataset => {
      (dataset.data || []).forEach(group => {
        if (!Array.isArray(group)) return;
        for (let i = 0; i < group.length; i++) {
          const value = group[i];
          if (Number.isFinite(value)) {
            if (value < minValue) minValue = value;
            if (value > maxValue) maxValue = value;
          }
        }
      });
    });

    if (Number.isFinite(minValue) && Number.isFinite(maxValue)) {
      const span = maxValue - minValue;
      const padding = span > 0 ? span * 0.1 : Math.max(1, Math.abs(minValue) * 0.1, Math.abs(maxValue) * 0.1);
      cfg.options.scales[valueAxis].min = minValue - padding;
      cfg.options.scales[valueAxis].max = maxValue + padding;
    }
  }

  try {
    window.mainChart = new Chart(ctx, cfg);
  } catch (err) {
    console.error('Chart render failed:', err);
    window.notify?.(`Chart failed to render: ${err.message}`, 'error');
    chartContainer.classList.add('empty');
    window.mainChart = null;
  }
}


/**
 * Clears the current chart (removes all datasets from chartDatasets).
 */
function clearChart() {
  window.currentChartType = null;
  window.chartLabels = [];
  window.chartDatasets.length = 0;
  if (window.mainChart) {
    window.mainChart.destroy();
    window.mainChart = null;
  }
  
  // Show the empty state
  const chartContainer = document.getElementById('chartContainer');
  if (chartContainer) {
    chartContainer.classList.add('empty');
  }

  const datasetOrderList = document.getElementById('datasetOrderList');
  if (datasetOrderList) {
    datasetOrderList.innerHTML = '';
  }

  const clearChartBtn = document.getElementById('clearChartBtn');
  if (clearChartBtn) {
    clearChartBtn.disabled = true;
  }

  console.log("Chart cleared");
}

// helper to convert "#RRGGBB" → "rgba(r,g,b,a)"
function hexToRgba(hex, alpha) {
  const bigint = parseInt(hex.replace('#',''), 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8)  & 255;
  const b = bigint & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function setChartBusy(busy) {
  const btn = document.getElementById('addToChartBtn');
  const container = document.getElementById('chartContainer');
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? 'Adding…' : 'Add to chart';
  }
  container?.classList.toggle('chart-busy', busy);
}

/**
 * Builds chartDatasets (and for violin, chartLabels) then calls renderChart().
 */
function addToChartCore() {
  const select = document.getElementById('datasetSelect');
  if (!select) return;

  const indices = Array.from(select.selectedOptions).map(o => +o.value);
  if (indices.length === 0) {
    window.notify?.('Select at least one dataset before adding to chart.', 'warning');
    return;
  }

  const metric    = document.getElementById('metricSelect').value;
  const chartType = document.getElementById('chartTypeSelect').value;
  window.currentChartMetric = metric;

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

    window.currentChartType = 'summarybar';
    buildSummaryBarChart(indices, metric, statKeys);
    renderChart('summarybar');
    updateDatasetOrder();
    document.getElementById('clearChartBtn')?.removeAttribute('disabled');
    return;
  }

  const hadExistingChart = window.chartDatasets.length > 0 && window.mainChart;

  if (!window.chartDatasets.length) {
    window.currentChartType = chartType;
  }

  if (window.chartDatasets.length && chartType !== window.currentChartType) {
    window.notify?.(
      `You already started a "${window.currentChartType}" chart. Clear it first to switch to "${chartType}".`,
      'warning'
    );
    return;
  }

  // ---- VIOLIN + BOXPLOT COMBO ----
  if (chartType === 'violin') {
    const labels = indices.map(i => window.allDatasets[i].name);
    const groups = indices.map(i =>
      sampleSeries(getMetricSeries(window.allDatasets[i], metric), MAX_DISTRIBUTION_POINTS)
    );
    const colors = indices.map(i => window.allDatasets[i].color || getBenchmarkColor(i));

    window.chartLabels = labels.slice();

    window.chartDatasets = [{
      label: `${metric} Density`,
      type: 'violin',
      data: groups,
      backgroundColor: colors.map(c => hexToRgba(c, 0.3)),
      borderColor: colors,
      borderWidth: 1,
      order: 2
    }, {
      label: `${metric} Quartiles`,
      type: 'boxplot',
      data: groups,
      backgroundColor: colors.map(() => 'rgba(80,80,80,0.4)'),
      borderColor: colors.map(() => 'rgba(80,80,80,1)'),
      borderWidth: 2,
      order: 1,
      barPercentage: 0.05,
      categoryPercentage: 1.0
    }];

    renderChart('violin');
    updateDatasetOrder();
    document.getElementById('clearChartBtn')?.removeAttribute('disabled');
    return;
  }

  // ---- BOXPLOT ONLY ----
  if (chartType === 'boxplot') {
    const labels = indices.map(i => window.allDatasets[i].name);
    const groups = indices.map(i =>
      sampleSeries(getMetricSeries(window.allDatasets[i], metric), MAX_DISTRIBUTION_POINTS)
    );
    const colors = indices.map(i => window.allDatasets[i].color || getBenchmarkColor(i));

    window.chartLabels = labels.slice();
    window.chartDatasets = [{
      label: `${metric} Quartiles`,
      type: 'boxplot',
      data: groups,
      backgroundColor: colors.map(c => hexToRgba(c, 0.4)),
      borderColor: colors,
      borderWidth: 2
    }];

    renderChart('boxplot');
    updateDatasetOrder();
    document.getElementById('clearChartBtn')?.removeAttribute('disabled');
    return;
  }

  // ---- ALL OTHER CHART TYPES ----
  indices.forEach(idx => {
    const ds = window.allDatasets[idx];
    if (!ds?.rows?.length) return;

    const vals = getMetricSeries(ds, metric);
    if (!vals.length) return;

    let cfg;

    if (chartType === 'line' || chartType === 'scatter') {
      const useValueX = document.getElementById('useValueX')?.checked;
      const { points, totalPoints, displayedPoints } = getLineScatterPoints(ds, metric, useValueX);
      if (!points.length) return;

      const seriesColor = ds.color || getBenchmarkColor(idx);

      cfg = {
        label: ds.name,
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
    } else if (chartType === 'histogram') {
      const bins = buildHistogram(vals);
      const seriesColor = ds.color || getBenchmarkColor(idx);
      cfg = {
        label: ds.name,
        data: bins.counts.map((c, i) => ({ x: bins.labels[i], y: c })),
        type: 'bar',
        backgroundColor: hexToRgba(seriesColor, 0.7),
        borderColor: seriesColor,
        borderWidth: 1
      };
    } else if (chartType === 'qqplot') {
      const qqResult = buildQQPlot(vals);
      if (!qqResult) {
        window.notify?.(`${ds.name}: need at least 2 valid values for a Q-Q plot.`, 'warning');
        return;
      }

      const seriesColor = ds.color || getBenchmarkColor(idx);

      window.chartDatasets.push({
        label: ds.name,
        type: 'scatter',
        data: qqResult.points,
        borderColor: seriesColor,
        backgroundColor: hexToRgba(seriesColor, 0.75),
        pointRadius: 2.5,
        pointHitRadius: 6,
        showLine: false,
        parsing: false,
        order: 2,
        qqRole: 'sample'
      });

      cfg = {
        label: `${ds.name} (normal ref.)`,
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
        qqRole: 'reference'
      };
    }

    if (cfg) window.chartDatasets.push(cfg);
  });

  if (chartType === 'qqplot' && window.chartDatasets.length === 0) {
    window.notify?.('Could not build Q-Q plot from the selected data.', 'warning');
    return;
  }

  renderChart(chartType, { incremental: hadExistingChart });
  updateDatasetOrder();
  document.getElementById('clearChartBtn')?.removeAttribute('disabled');
}

function addToChart() {
  const btn = document.getElementById('addToChartBtn');
  if (btn?.disabled) return;

  setChartBusy(true);
  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        addToChartCore();
      } catch (err) {
        console.error('Add to chart failed:', err);
        window.notify?.(`Failed to add chart: ${err.message}`, 'error');
      } finally {
        setChartBusy(false);
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
function moveDataset(index, direction) {
  if (direction === 'up' && index === 0) return;
  if (direction === 'down' && index === window.chartDatasets.length - 1) return;

  const newIndex = direction === 'up' ? index - 1 : index + 1;
  [window.chartDatasets[index], window.chartDatasets[newIndex]] =
    [window.chartDatasets[newIndex], window.chartDatasets[index]];

  updateDatasetOrder();
  if (window.mainChart) {
    window.mainChart.data.datasets = window.chartDatasets;
    window.mainChart.update('none');
  }
}

/**
 * Removes a dataset from the chartDatasets array at the specified index
 * @param {number} index - The index of the dataset to remove
 */
function removeDataset(index) {
  if (index < 0 || index >= window.chartDatasets.length) return;
  
  // Remove the dataset at the specified index
  window.chartDatasets.splice(index, 1);

  // If all datasets are removed, fully reset chart state.
  if (window.chartDatasets.length === 0) {
    clearChart();
    return;
  }
  
  // Update the dataset order list
  updateDatasetOrder();
  
  // Update the chart
  if (window.mainChart) {
    window.mainChart.data.datasets = window.chartDatasets;
    window.mainChart.update('none');
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

  window.chartDatasets.forEach((dataset, index) => {
    const li = document.createElement('li');
    li.className      = 'dataset-order-item';
    li.dataset.index  = index;               // keep the index on the node

    /* small colour blob */
    const swatch = document.createElement('div');
    swatch.className = 'dataset-color';
    swatch.style.background =
      Array.isArray(dataset.backgroundColor)
        ? dataset.backgroundColor[0]
        : dataset.backgroundColor || '#888';

    /* label */
    const name = document.createElement('span');
    name.textContent = dataset.label;

    /* up / down / remove controls */
    const controls = document.createElement('div');
    controls.className = 'dataset-order-controls';

    const mkBtn = (txt, title, cb) => {
      const b = document.createElement('button');
      b.textContent = txt;
      b.title       = title;
      b.addEventListener('click', () => cb(index));
      return b;
    };

    controls.append(
      mkBtn('↑','Move up'  , i => moveDataset(i,'up'  )),
      mkBtn('↓','Move down', i => moveDataset(i,'down')),
      mkBtn('×','Remove'   , i => removeDataset(i)     )
    );

    li.append(swatch, name, controls);
    frag.appendChild(li);
  });

  orderList.innerHTML = '';
  orderList.appendChild(frag);
}


/**
 * Displays raw data from a selected dataset
 * @param {string|number} datasetId - ID of the dataset to display
 */
function displayRawData(datasetId) {
  const rawDataElement = document.getElementById('rawData');
  const rawDataInfo = document.querySelector('.raw-data-info');
  
  if (!rawDataElement) return;
  
  // Convert datasetId to a number if it's passed as a string
  const datasetIndex = parseInt(datasetId, 10);
  
  if (isNaN(datasetIndex) || !window.allDatasets || datasetIndex >= window.allDatasets.length) {
    rawDataElement.textContent = '';
    if (rawDataInfo) rawDataInfo.textContent = 'Select a dataset to view its raw content.';
    return;
  }
  
  const dataset = window.allDatasets[datasetIndex];
  
  // Update info about the selected dataset
  if (rawDataInfo) {
    rawDataInfo.innerHTML = `
      <strong>${dataset.name}</strong> - 
      ${dataset.rows.length} rows
    `;
  }
  
  // Format the data for display
  if (dataset.rows.length === 0) {
    rawDataElement.textContent = 'No data available in this dataset.';
    return;
  }
  
  // Get all available column names from the first row
  const columns = Object.keys(dataset.rows[0] || {});
  
  // Display the first page of data
  displayRawDataPage(dataset, columns, 0);
}

// Current page for raw data pagination
let currentPage = 0;
const rowsPerPage = 100;

/**
 * Displays a specific page of raw data
 * @param {Object} dataset - The dataset to display
 * @param {Array} columns - Array of column names
 * @param {number} page - Page number to display (0-based)
 */
function displayRawDataPage(dataset, columns, page = 0) {
  const rawDataElement = document.getElementById('rawData');
  if (!rawDataElement) return;
  
  // Update current page tracker
  currentPage = page;
  
  // Calculate start and end indices
  const startIdx = page * rowsPerPage;
  const endIdx = Math.min(startIdx + rowsPerPage, dataset.rows.length);
  
  // Create a header row
  let tableContent = columns.join('\t') + '\n';
  tableContent += columns.map(() => '--------').join('\t') + '\n';
  
  // Add data rows for current page
  for (let i = startIdx; i < endIdx; i++) {
    const row = dataset.rows[i];
    tableContent += columns.map(col => row[col] !== undefined ? row[col] : 'N/A').join('\t') + '\n';
  }
  
  // Add pagination info
  tableContent += `\n\nShowing rows ${startIdx+1} to ${endIdx} of ${dataset.rows.length}`;
  
  // Add pagination controls if dataset has more rows than one page
  if (dataset.rows.length > rowsPerPage) {
    tableContent += '\n\n';
    if (page > 0) {
      tableContent += '[Previous Page] ';
    }
    if (endIdx < dataset.rows.length) {
      tableContent += '[Next Page]';
    }
    
    // Add pagination explanation
    tableContent += '\n(Use the Raw Data Pagination controls below)';
    
    // Create pagination buttons if they don't exist
    let paginationControls = document.getElementById('rawDataPagination');
    if (!paginationControls) {
      paginationControls = document.createElement('div');
      paginationControls.id = 'rawDataPagination';
      paginationControls.className = 'pagination-controls';
      rawDataElement.parentNode.insertBefore(paginationControls, rawDataElement.nextSibling);
    }
    
    paginationControls.innerHTML = `
      <button id="prevPageBtn" ${page <= 0 ? 'disabled' : ''}>Previous Page</button>
      <span>Page ${page + 1}</span>
      <button id="nextPageBtn" ${endIdx >= dataset.rows.length ? 'disabled' : ''}>Next Page</button>
    `;
    
    // Add event listeners to pagination buttons
    document.getElementById('prevPageBtn')?.addEventListener('click', () => {
      if (page > 0) displayRawDataPage(dataset, columns, page - 1);
    });
    
    document.getElementById('nextPageBtn')?.addEventListener('click', () => {
      if (endIdx < dataset.rows.length) displayRawDataPage(dataset, columns, page + 1);
    });
  } else {
    // Remove pagination controls if not needed
    const paginationControls = document.getElementById('rawDataPagination');
    if (paginationControls) {
      paginationControls.remove();
    }
  }
  
  rawDataElement.textContent = tableContent;
}

// Export this function so it's available globally
window.displayRawData = displayRawData;

// Expose your chart functionality to the global scope
window.getBenchmarkColor = getBenchmarkColor;
window.assignDatasetColors = assignDatasetColors;
window.buildHistogram = buildHistogram;
window.buildQQPlot = buildQQPlot;
window.renderChart = renderChart;
window.rebuildCurrentLineScatterDatasets = rebuildCurrentLineScatterDatasets;
window.clearChart = clearChart;
window.addToChart = addToChart;
window.moveDataset = moveDataset;
window.updateDatasetOrder = updateDatasetOrder;
window.removeDataset = removeDataset;
