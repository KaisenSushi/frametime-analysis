function getStatsDatasetLabel(dataset) {
  return window.getDatasetDisplayName?.(dataset) || dataset?.displayName || dataset?.name || 'Dataset';
}

/**
 * Retrieves the numeric value of a given metric from a row object.
 * Supports both standard metrics and PresentMon-style CSV formats.
 * @param {Object} row - One data row (key-value pairs).
 * @param {string} metric - Standard or PresentMon metric name
 * @returns {number|null} The numeric value, or null if unavailable.
 */
function findNumericKey(row, ...candidates) {
  for (const candidate of candidates) {
    if (typeof row[candidate] === 'number') return row[candidate];
    const match = Object.keys(row).find(key => key.toLowerCase() === candidate.toLowerCase());
    if (match && typeof row[match] === 'number') return row[match];
  }
  return null;
}

/**
 * Stepwise Relative SD - measures frame-to-frame relative variability.
 * Stepwise_Relative_SD = sqrt((1/(n-1)) * sum_{t=2}^{n} [(F_t - F_{t-1})/F_{t-1}]^2)
 * @param {number[]} values - Frametime or latency series (ms)
 * @returns {number}
 */
function calculateStepwiseRelativeSD(values) {
  const series = (values || []).filter(v => Number.isFinite(v) && v > 0);
  const n = series.length;
  if (n < 2) return NaN;

  let sumSq = 0;
  for (let t = 1; t < n; t++) {
    const prev = series[t - 1];
    const rel = (series[t] - prev) / prev;
    sumSq += rel * rel;
  }
  return Math.sqrt(sumSq / (n - 1));
}

/**
 * Coefficient of Variation - relative variability of the frametime series.
 * CV = σ / μ (sample stdev divided by mean).
 * @param {number[]} values - Frametime series (ms)
 * @returns {number}
 */
function calculateCoefficientOfVariation(values) {
  const series = (values || []).filter(v => Number.isFinite(v) && v > 0);
  const n = series.length;
  if (n < 2) return NaN;

  const mean = series.reduce((s, v) => s + v, 0) / n;
  if (mean === 0) return NaN;

  const stdev = (typeof window.jStat?.stdev === 'function')
    ? window.jStat.stdev(series, true)
    : Math.sqrt(series.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));

  return stdev / mean;
}

/**
 * RMSSD - root mean square of successive frametime differences.
 * RMSSD = sqrt((1 / (n - 1)) * Σ_{t=2}^{n} (F_t - F_{t-1})²)
 * @param {number[]} values - Frametime series (ms)
 * @returns {number}
 */
function calculateRMSSD(values) {
  const series = (values || []).filter(v => Number.isFinite(v) && v > 0);
  const n = series.length;
  if (n < 2) return NaN;

  let sumSqDiff = 0;
  for (let t = 1; t < n; t++) {
    const diff = series[t] - series[t - 1];
    sumSqDiff += diff * diff;
  }
  return Math.sqrt(sumSqDiff / (n - 1));
}

/**
 * FTSD - sample standard deviation of the raw frame-time series (ms).
 */
function calculateFrameTimeSD(values) {
  const series = (values || []).filter(v => Number.isFinite(v) && v > 0);
  const n = series.length;
  if (n < 2) return NaN;
  const mean = series.reduce((sum, value) => sum + value, 0) / n;
  return (typeof window.jStat?.stdev === 'function')
    ? window.jStat.stdev(series, true)
    : Math.sqrt(series.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1));
}

/**
 * Bias-corrected sample skewness / excess kurtosis (Excel SKEW / KURT,
 * SciPy skew/kurtosis with bias=False), plus nonparametric skew.
 */
function calculateDistributionShape(values) {
  const series = (values || []).filter(v => Number.isFinite(v) && v > 0);
  const n = series.length;
  if (n < 2) {
    return { skewness: NaN, kurtosis: NaN, nonparametricSkew: NaN };
  }

  const mean = series.reduce((sum, value) => sum + value, 0) / n;
  const variance = series.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const stdev = Math.sqrt(variance);
  if (!Number.isFinite(stdev) || stdev === 0) {
    return { skewness: NaN, kurtosis: NaN, nonparametricSkew: NaN };
  }

  let sumZ3 = 0;
  let sumZ4 = 0;
  for (let i = 0; i < n; i++) {
    const z = (series[i] - mean) / stdev;
    sumZ3 += z ** 3;
    sumZ4 += z ** 4;
  }

  // Excel SKEW / SciPy skew(bias=False)
  const skewness = n >= 3
    ? (n / ((n - 1) * (n - 2))) * sumZ3
    : NaN;

  // Excel KURT / SciPy kurtosis(bias=False, fisher=True). Excess kurtosis.
  const kurtosis = n >= 4
    ? (n * (n + 1) / ((n - 1) * (n - 2) * (n - 3))) * sumZ4
      - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3))
    : NaN;

  const sorted = series.slice().sort((a, b) => a - b);
  const median = calculatePercentile(sorted, 50);

  return {
    skewness,
    kurtosis,
    nonparametricSkew: (mean - median) / stdev
  };
}

/** Metrics computed once over the full frametime series (not per frame). */
const AGGREGATE_FRAMETIME_METRICS = new Set([
  'Stepwise_Relative_SD',
  'Coefficient_of_Variation',
  'RMSSD',
  'Skewness',
  'Kurtosis',
  'Nonparametric_Skew',
  'Rendered_FTSD',
  'Displayed_FTSD',
  'Rendered_Coefficient_of_Variation',
  'Displayed_Coefficient_of_Variation',
  'Rendered_RMSSD',
  'Displayed_RMSSD',
  'Rendered_Stepwise_Relative_SD',
  'Displayed_Stepwise_Relative_SD'
]);

function calculateAggregateMetric(values, metricName) {
  switch (metricName) {
    case 'Stepwise_Relative_SD': return calculateStepwiseRelativeSD(values);
    case 'Coefficient_of_Variation': return calculateCoefficientOfVariation(values);
    case 'RMSSD': return calculateRMSSD(values);
    case 'Skewness': return calculateDistributionShape(values).skewness;
    case 'Kurtosis': return calculateDistributionShape(values).kurtosis;
    case 'Nonparametric_Skew': return calculateDistributionShape(values).nonparametricSkew;
    case 'Rendered_FTSD':
    case 'Displayed_FTSD':
      return calculateFrameTimeSD(values);
    case 'Rendered_Coefficient_of_Variation':
    case 'Displayed_Coefficient_of_Variation':
      return calculateCoefficientOfVariation(values);
    case 'Rendered_RMSSD':
    case 'Displayed_RMSSD':
      return calculateRMSSD(values);
    case 'Rendered_Stepwise_Relative_SD':
    case 'Displayed_Stepwise_Relative_SD':
      return calculateStepwiseRelativeSD(values);
    default: return NaN;
  }
}
// Fall back to the shared visualization palette so colors match across tabs.
function getDatasetColor(index) {
  if (typeof window.getBenchmarkColor === 'function') {
    return window.getBenchmarkColor(index);
  }
  const fallback = [
    '#3B82F6', '#EF4444', '#F59E0B', '#22C55E', '#A855F7',
    '#06B6D4', '#F97316', '#EC4899', '#84CC16', '#6366F1'
  ];
  return fallback[index % fallback.length];
}

// Prefer a dataset's assigned color so the Statistics tab matches the chart.
function getStatsDatasetColor(dataset, index) {
  return dataset?.color || getDatasetColor(index);
}

// Single-value aggregate metrics derived from the frametime series.
function isAggregateMetric(metric) {
  return AGGREGATE_FRAMETIME_METRICS.has(metric);
}

function isFpsLikeMetric(metric) {
  return metric === 'FPS' ||
         metric === 'RenderedFPS' ||
         metric === 'DisplayedFPS' ||
         metric.toLowerCase().includes('fps');
}

function getAverageMeanKind(metrics = []) {
  const selected = metrics.filter(Boolean);
  if (!selected.length) return 'none';

  const hasFps = selected.some(isFpsLikeMetric);
  const hasNonFps = selected.some(metric => !isFpsLikeMetric(metric));

  if (hasFps && !hasNonFps) return 'harmonic';
  if (!hasFps && hasNonFps) return 'arithmetic';
  return 'mixed';
}

function getAverageDisplayLabel(metrics = []) {
  switch (getAverageMeanKind(metrics)) {
    case 'harmonic': return 'Avg (Harmonic Mean)';
    case 'arithmetic': return 'Avg (Arithmetic Mean)';
    case 'mixed': return 'Avg (Harmonic / Arithmetic Mean)';
    default: return 'Avg';
  }
}

function getAverageMeanSubLabel(metrics = []) {
  switch (getAverageMeanKind(metrics)) {
    case 'harmonic': return 'Harmonic';
    case 'arithmetic': return 'Arithmetic';
    case 'mixed': return 'Harmonic / Arithmetic';
    case 'none':
    default: return '';
  }
}

function updateStatsAverageLabel() {
  const avgButton = document.querySelector('#statsTypeGroup [data-stat="avg"]');
  if (!avgButton) return;

  const selectedMetrics = Array.from(
    document.querySelectorAll('#statMetricsGroup .toggle-button.active')
  ).map(button => button.dataset.metric);

  const subLabel = avgButton.querySelector('.stats-avg-sub');
  if (subLabel) subLabel.textContent = getAverageMeanSubLabel(selectedMetrics);

  const label = getAverageDisplayLabel(selectedMetrics);
  const accessibleLabel = selectedMetrics.length
    ? `${label}; the formula is selected per metric.`
    : 'Select a metric to see which mean is used.';
  avgButton.title = accessibleLabel;
  avgButton.setAttribute('aria-label', accessibleLabel);

  document.querySelectorAll('#statsTypeGroup [data-stat]').forEach(button => {
    const stat = button.dataset.stat;
    if (!['p1', 'p01', 'p001', 'low1', 'low01', 'low001', 'high1', 'high01'].includes(stat)) return;
    const statLabel = getStatDisplayName(stat, selectedMetrics);
    button.textContent = statLabel;
    button.title = getStatDescription(stat, selectedMetrics);
    button.setAttribute('aria-label', statLabel);
  });
}

/**
 * Formats a stat value for display, choosing a sensible precision per metric.
 * @param {string} metric
 * @param {string} stat
 * @param {number} value
 * @returns {string}
 */
function formatStatValue(metric, stat, value) {
  if (!Number.isFinite(value)) return 'N/A';
  if (metric === 'RMSSD' || metric === 'Rendered_RMSSD' || metric === 'Displayed_RMSSD') {
    return value.toFixed(2);
  }
  if (metric === 'Rendered_FTSD' || metric === 'Displayed_FTSD') return value.toFixed(4);
  if (
    metric === 'Stepwise_Relative_SD' ||
    metric === 'Coefficient_of_Variation' ||
    metric === 'Rendered_Stepwise_Relative_SD' ||
    metric === 'Displayed_Stepwise_Relative_SD' ||
    metric === 'Rendered_Coefficient_of_Variation' ||
    metric === 'Displayed_Coefficient_of_Variation' ||
    metric === 'Skewness' ||
    metric === 'Kurtosis' ||
    metric === 'Nonparametric_Skew'
  ) return value.toFixed(4);
  if (isFpsLikeMetric(metric)) return value.toFixed(1);
  if (stat === 'stdev') return value.toFixed(3);
  return value.toFixed(2);
}

function getMetricValue(row, metric) {
  // Handle FrameTime specially - can come from different sources
  if (metric === 'FrameTime') {
    // PresentMon's MsBetweenPresents is authoritative for rendered/presented
    // frame time. Generic FrameTime remains a compatibility fallback.
    const presentTime = findNumericKey(row, 'MsBetweenPresents');
    if (presentTime != null) return presentTime;
    return typeof row.FrameTime === 'number' ? row.FrameTime : null;
  }
  
  // Presented/rendered FPS: application Present() cadence.
  if (metric === 'RenderedFPS') {
    const direct = findNumericKey(row, 'RenderedFPS');
    if (direct && direct > 0) return direct;
    const ms = findNumericKey(row, 'MsBetweenPresents', 'FrameTime');
    return (ms && ms > 0) ? 1000.0 / ms : null;
  }

  // Displayed FPS: actual on-screen image-change cadence. Never fall back
  // to presented timing when display-change data is unavailable.
  if (metric === 'DisplayedFPS') {
    const direct = findNumericKey(row, 'DisplayedFPS');
    if (direct && direct > 0) return direct;
    const ms = findNumericKey(row, 'MsBetweenDisplayChange', 'MsBetweenDisplayChanges');
    return (ms && ms > 0) ? 1000.0 / ms : null;
  }

  if (metric === 'DisplayedFrameTime') {
    return findNumericKey(row, 'MsBetweenDisplayChange', 'MsBetweenDisplayChanges');
  }

  // GPU busy time - critical for input lag even when FPS looks fine
  if (metric === 'MsGPUBusy') {
    return findNumericKey(row, 'MsGPUBusy', 'GPUBusy', 'MsGpuBusy');
  }

  // Time from CPU frame completion to display output
  if (metric === 'MsUntilDisplayed') {
    return findNumericKey(row, 'MsUntilDisplayed', 'MsUntilDisplayComplete');
  }

  // Aggregate-only metrics - not meaningful per row
  if (AGGREGATE_FRAMETIME_METRICS.has(metric)) {
    return null;
  }

  // Handle FPS calculation specially as it can be derived from different frametime metrics
  if (metric === 'FPS') {
    // Try standard format first
    if (typeof row['FrameTime'] === 'number' && row['FrameTime'] > 0) {
      return 1000.0 / row['FrameTime'];
    }
    // Try PresentMon format (case insensitive)
    else {
      // Check for MsBetweenPresents or msBetweenPresents
      const mbpKey = Object.keys(row).find(key => 
        key.toLowerCase() === 'msbetweenpresents');
      
      if (mbpKey && typeof row[mbpKey] === 'number' && row[mbpKey] > 0) {
        return 1000.0 / row[mbpKey];
      }
    }
    return null;
  }
  
  // For other metrics, try case-insensitive match
  if (typeof row[metric] === 'number') {
    return row[metric];
  }
  
  // Try case-insensitive matching
  const matchingKey = Object.keys(row).find(key => 
    key.toLowerCase() === metric.toLowerCase());
  
  return (matchingKey && typeof row[matchingKey] === 'number') ? row[matchingKey] : null;
}

function calculateStatistics(arr, metricName = '', options = {}) {
  if (!arr.length) {
    return {
      max: NaN, min: NaN, avg: NaN, median: NaN, mode: NaN, stdev: NaN,
      p1: NaN, p01: NaN, p001: NaN,
      low1: NaN, low01: NaN, low001: NaN,
      high1: NaN, high01: NaN
    };
  }

  // Frametime-derived aggregate metrics
  if (isAggregateMetric(metricName)) {
    const aggregate = calculateAggregateMetric(arr, metricName);
    return {
      max: aggregate, min: aggregate, avg: aggregate, median: aggregate, mode: aggregate, stdev: 0,
      p1: aggregate, p01: aggregate, p001: aggregate,
      low1: aggregate, low01: aggregate, low001: aggregate,
      high1: aggregate, high01: aggregate
    };
  }

  /* -------- basic aggregates --------------------------------------- */
  const sorted = Array.isArray(options.sorted)
    ? options.sorted
    : [...arr].sort((a, b) => a - b);  // ascending
  const n      = sorted.length;
  const maxVal = sorted[n - 1];
  const minVal = sorted[0];
  const sum    = sorted.reduce((a, b) => a + b, 0);
  const median = calculatePercentile(sorted, 50);
  const mode = calculateMode(sorted);

  /* -------- determine FPS vs Frame‑time ---------------------------- */
  let isFpsMetric =
        metricName.toUpperCase() === 'FPS' ||
        metricName === 'RenderedFPS' ||
        metricName === 'DisplayedFPS' ||
        metricName.toLowerCase().includes('fps');
  if (!metricName && sum / n > 30 && minVal > 20) isFpsMetric = true;

  // FPS metrics use the harmonic mean; everything else uses the arithmetic mean.
  const avg = isFpsMetric
      ? (() => {
          const positive = getPositiveValuesForHarmonicMean(sorted);
          if (!positive.length) return NaN;
          return positive.length / positive.reduce((s, v) => s + 1 / v, 0);
        })()
      : sum / n;

  // STDEV is always sample stdev around the arithmetic mean (never the harmonic
  // Avg). Labels call this out for FPS so Avg and STDEV are not read as a pair.
  const arithmeticMean = sum / n;
  const stdev = (typeof window.jStat?.stdev === 'function')
      ? window.jStat.stdev(sorted, true)
      : Math.sqrt(sorted.reduce((s, v) => s + (v - arithmeticMean) ** 2, 0) / (n - 1));

  /* -------- percentiles (single‑frame cut‑off) --------------------- */
  const p1   = calculatePercentile(sorted,  isFpsMetric ? 1     : 99);
  const p01  = calculatePercentile(sorted,  isFpsMetric ? 0.1   : 99.9);
  const p001 = calculatePercentile(sorted,  isFpsMetric ? 0.01  : 99.99);

  /* -------- “X % Low” (average of worst frames) -------------------- */
  const c1   = Math.max(1, Math.ceil(n * 0.01));     // 1 %
  const c01  = Math.max(1, Math.ceil(n * 0.001));    // 0.1 %
  const c001 = Math.max(1, Math.ceil(n * 0.0001));   // 0.01 %

  let low1, low01, low001, high1, high01;

  if (isFpsMetric) {
    // Worst FPS = smallest values; best FPS = largest values.
    low1   = sorted.slice(0, c1).  reduce((s, v) => s + v, 0) / c1;
    low01  = sorted.slice(0, c01). reduce((s, v) => s + v, 0) / c01;
    low001 = sorted.slice(0, c001).reduce((s, v) => s + v, 0) / c001;
    high1  = sorted.slice(-c1).    reduce((s, v) => s + v, 0) / c1;
    high01 = sorted.slice(-c01).   reduce((s, v) => s + v, 0) / c01;
  } else {
    // Worst frame times = largest values; best frame times = smallest values.
    const desc = [...sorted].reverse();
    low1   = desc.slice(0, c1).  reduce((s, v) => s + v, 0) / c1;
    low01  = desc.slice(0, c01). reduce((s, v) => s + v, 0) / c01;
    low001 = desc.slice(0, c001).reduce((s, v) => s + v, 0) / c001;
    high1  = sorted.slice(0, c1).  reduce((s, v) => s + v, 0) / c1;
    high01 = sorted.slice(0, c01). reduce((s, v) => s + v, 0) / c01;
  }

  /* -------- return -------------------------------------------------- */
  return {
    max: maxVal,
    min: minVal,
    avg,
    median,
    mode,
    stdev,
    p1,  p01,  p001,
    low1, low01, low001,
    high1, high01
  };
}



function calculatePercentile(sortedArr, percentile) {
  // percentile expressed as 1 → 1 %, 0.1 → 0.1 %
  if (!sortedArr.length) return NaN;

  const idx = (percentile / 100) * (sortedArr.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.min(sortedArr.length - 1, Math.ceil(idx));

  if (lower === upper) return sortedArr[lower];

  const w = idx - lower;               // linear interpolation weight
  return sortedArr[lower] * (1 - w) + sortedArr[upper] * w;
}

/**
 * Continuous unimodal mode (peak of the density), not raw most-frequent value.
 * Uses the half-sample mode (HSM): repeatedly take the shortest interval that
 * still holds half the points. Avoids arbitrary histogram bin counts.
 * @see https://en.wikipedia.org/wiki/Mode_(statistics)
 * @param {number[]} values
 * @returns {number}
 */
function calculateMode(values) {
  const sorted = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return NaN;
  if (n === 1) return sorted[0];
  if (n === 2) return (sorted[0] + sorted[1]) / 2;

  let lo = 0;
  let hi = n - 1;

  while (hi - lo + 1 >= 4) {
    const len = hi - lo + 1;
    const half = Math.ceil(len / 2);
    let best = lo;
    let bestWidth = sorted[lo + half - 1] - sorted[lo];
    for (let i = lo + 1; i <= hi - half + 1; i++) {
      const width = sorted[i + half - 1] - sorted[i];
      if (width < bestWidth) {
        bestWidth = width;
        best = i;
      }
    }
    lo = best;
    hi = best + half - 1;
  }

  // 2 or 3 remaining points
  if (hi === lo) return sorted[lo];
  if (hi - lo === 1) return (sorted[lo] + sorted[hi]) / 2;

  const leftGap = sorted[lo + 1] - sorted[lo];
  const rightGap = sorted[hi] - sorted[lo + 1];
  if (leftGap < rightGap) return (sorted[lo] + sorted[lo + 1]) / 2;
  if (rightGap < leftGap) return (sorted[lo + 1] + sorted[hi]) / 2;
  return sorted[lo + 1];
}

function isTimingMetric(metric) {
  return metric === 'FrameTime' || metric === 'DisplayedFrameTime' || /^Ms/i.test(metric || '');
}

/**
 * Shared validity rule for every metric consumer (Statistics, Reliability,
 * and charts). All metrics reject NaN/Infinity; timing values must be > 0.
 */
function isValidMetricSample(metric, value) {
  if (!Number.isFinite(value)) return false;
  if (isTimingMetric(metric) || isFpsLikeMetric(metric)) return value > 0;
  return true;
}

function getColumn(dataset, ...candidates) {
  if (typeof window.getDatasetColumn === 'function') {
    return window.getDatasetColumn(dataset, ...candidates);
  }
  const columns = dataset?.columns;
  if (!columns) return null;
  for (const candidate of candidates) {
    if (columns[candidate]) return columns[candidate];
    const target = String(candidate).toLowerCase();
    const match = Object.keys(columns).find(key => key.toLowerCase() === target);
    if (match) return columns[match];
  }
  return null;
}

function collectColumnValues(column, metric, transform = null) {
  if (!column?.length) return [];
  const values = [];
  for (let i = 0; i < column.length; i++) {
    const source = column[i];
    const value = transform ? transform(source) : source;
    if (isValidMetricSample(metric, value)) values.push(value);
  }
  return values;
}

function collectFrametimeSeries(dataset) {
  const source = window.getDatasetRenderedTimingSource?.(dataset);
  if (source?.column) {
    return collectColumnValues(source.column, 'FrameTime', source.toMilliseconds);
  }
  const column = getColumn(dataset, 'MsBetweenPresents', 'FrameTime');
  if (column) return collectColumnValues(column, 'FrameTime');
  return (dataset?.rows || [])
    .map(row => getMetricValue(row, 'FrameTime'))
    .filter(value => isValidMetricSample('FrameTime', value));
}

function collectDisplayedFrametimeSeries(dataset) {
  const column = getColumn(
    dataset,
    'MsBetweenDisplayChange',
    'MsBetweenDisplayChanges',
    'DisplayedFrameTime'
  );
  if (column) return collectColumnValues(column, 'DisplayedFrameTime');
  return (dataset?.rows || [])
    .map(row => getMetricValue(row, 'DisplayedFrameTime'))
    .filter(value => isValidMetricSample('DisplayedFrameTime', value));
}

function collectAggregateMetricSeries(dataset, metric) {
  if (metric.startsWith('Displayed_') && AGGREGATE_FRAMETIME_METRICS.has(metric)) {
    return collectDisplayedFrametimeSeries(dataset);
  }
  if (AGGREGATE_FRAMETIME_METRICS.has(metric)) {
    return collectFrametimeSeries(dataset);
  }
  return [];
}

/**
 * Collects the numeric series used to compute stats for a metric on a dataset.
 * Columnar typed arrays are used directly so the application does not rebuild
 * a JavaScript row object for every frame.
 */
function collectMetricValues(dataset, metric) {
  if (AGGREGATE_FRAMETIME_METRICS.has(metric)) {
    return collectAggregateMetricSeries(dataset, metric);
  }

  if (metric === 'FrameTime') return collectFrametimeSeries(dataset);
  if (metric === 'DisplayedFrameTime') return collectDisplayedFrametimeSeries(dataset);

  if (metric === 'RenderedFPS' || metric === 'FPS') {
    // The Present() cadence is authoritative for rendered/presented FPS.
    // Generic captures containing only FPS retain the previous compatibility
    // behavior without allocating a duplicate derived frame-time column.
    const source = window.getDatasetRenderedTimingSource?.(dataset);
    if (source?.column) {
      return collectColumnValues(source.column, metric, value => {
        const milliseconds = source.toMilliseconds(value);
        return milliseconds > 0 ? 1000 / milliseconds : NaN;
      });
    }
    const timing = getColumn(dataset, 'MsBetweenPresents', 'FrameTime');
    if (timing) {
      return collectColumnValues(timing, metric, value => value > 0 ? 1000 / value : NaN);
    }
    const direct = getColumn(dataset, metric, metric === 'FPS' ? 'RenderedFPS' : 'FPS');
    return collectColumnValues(direct, metric);
  }

  if (metric === 'DisplayedFPS') {
    // Displayed FPS must follow actual display changes. Never substitute
    // rendered timing when display-change data is unavailable.
    const timing = getColumn(dataset, 'MsBetweenDisplayChange', 'MsBetweenDisplayChanges');
    if (timing) {
      return collectColumnValues(timing, metric, value => value > 0 ? 1000 / value : NaN);
    }
    return collectColumnValues(getColumn(dataset, 'DisplayedFPS'), metric);
  }

  if (metric === 'MsGPUBusy') {
    return collectColumnValues(getColumn(dataset, 'MsGPUBusy', 'GPUBusy', 'MsGpuBusy'), metric);
  }
  if (metric === 'MsUntilDisplayed') {
    return collectColumnValues(
      getColumn(dataset, 'MsUntilDisplayed', 'MsUntilDisplayComplete'),
      metric
    );
  }

  const direct = getColumn(dataset, metric);
  if (direct) return collectColumnValues(direct, metric);

  // Compatibility fallback for a legacy in-memory row dataset.
  return (dataset?.rows || [])
    .map(row => getMetricValue(row, metric))
    .filter(value => isValidMetricSample(metric, value));
}

const PERCENT_AGGREGATE_METRICS = new Set([
  'Coefficient_of_Variation',
  'Stepwise_Relative_SD',
  'Rendered_Coefficient_of_Variation',
  'Displayed_Coefficient_of_Variation',
  'Rendered_Stepwise_Relative_SD',
  'Displayed_Stepwise_Relative_SD'
]);

function formatAggregateDisplayValue(metric, value) {
  if (!Number.isFinite(value)) return 'N/A';
  if (PERCENT_AGGREGATE_METRICS.has(metric)) return `${(value * 100).toFixed(2)}%`;
  return formatStatValue(metric, 'avg', value);
}

function getPositiveValuesForHarmonicMean(values) {
  return (values || []).filter(v => Number.isFinite(v) && v > 0);
}

/**
 * Returns the harmonic mean for FPS metrics, arithmetic mean otherwise.
 */
function averageForMetric(values, metric) {
  if (!values.length) return NaN;
  if (isFpsLikeMetric(metric)) {
    const positive = getPositiveValuesForHarmonicMean(values);
    if (!positive.length) return NaN;
    return positive.length / positive.reduce((s, v) => s + 1 / v, 0);
  }
  return values.reduce((s, v) => s + v, 0) / values.length;
}

const PERCENTILE_SUPPORT_DIAGNOSTICS = [
  { key: 'p1', fraction: 0.01 },
  { key: 'p01', fraction: 0.001 },
  { key: 'p001', fraction: 0.0001 },
  { key: 'low1', fraction: 0.01 },
  { key: 'low01', fraction: 0.001 },
  { key: 'low001', fraction: 0.0001 },
  { key: 'high1', fraction: 0.01 },
  { key: 'high01', fraction: 0.001 }
];

/**
 * Standard lag-k sample autocorrelation using the full-series centered sum
 * of squares as the denominator.
 */
function calculateLagAutocorrelation(values, lag = 1) {
  const series = (values || []).filter(Number.isFinite);
  const n = series.length;
  if (lag < 1 || n <= lag) return NaN;

  const mean = series.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < n; i++) {
    const centered = series[i] - mean;
    denominator += centered * centered;
    if (i + lag < n) {
      numerator += centered * (series[i + lag] - mean);
    }
  }

  return denominator > 0 ? numerator / denominator : NaN;
}

/**
 * Deterministic PRNG used so exported bootstrap intervals are reproducible for
 * the same data, metric, block length, and replicate count.
 */
function createSeededRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapSeed(values, metric, blockLength, replicates) {
  let seed = 2166136261;
  const text = `${metric}|${values.length}|${blockLength}|${replicates}`;
  for (let i = 0; i < text.length; i++) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  const sampleStep = Math.max(1, Math.floor(values.length / 64));
  for (let i = 0; i < values.length; i += sampleStep) {
    const scaled = Math.round(values[i] * 1000000);
    seed ^= scaled;
    seed = Math.imul(seed, 16777619);
  }
  return seed >>> 0;
}

function quantileFromSorted(sorted, probability) {
  if (!sorted.length) return NaN;
  const index = Math.max(0, Math.min(sorted.length - 1, probability * (sorted.length - 1)));
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function chooseMovingBlockLength(sampleCount) {
  if (sampleCount < 2) return 1;
  // A cube-root rule is a stable automatic default for moving-block bootstrap
  // means. It grows with the capture while retaining enough resampled blocks.
  return Math.max(2, Math.min(sampleCount, Math.round(Math.cbrt(sampleCount))));
}

/**
 * Percentile moving-block bootstrap interval for a metric mean. Consecutive
 * blocks preserve local frame-to-frame dependence. FPS-family metrics use the
 * harmonic mean; time and other metrics use the arithmetic mean.
 */
function calculateBlockBootstrapCI(values, metric = 'FrameTime', options = {}) {
  const series = (values || []).filter(Number.isFinite);
  const n = series.length;
  if (n < 2) return null;

  const mean = averageForMetric(series, metric);
  if (!Number.isFinite(mean)) return null;

  const confidence = Number.isFinite(options.confidence) ? options.confidence : 0.95;
  const replicates = Math.max(200, Math.min(5000, Math.round(options.replicates || 1200)));
  const blockLength = Math.max(1, Math.min(
    n,
    Math.round(options.blockLength || chooseMovingBlockLength(n))
  ));
  const isFps = isFpsLikeMetric(metric);
  const transformed = isFps ? series.map(value => 1 / value) : series;
  const startCount = Math.max(1, n - blockLength + 1);
  const blockSums = new Float64Array(startCount);

  let rolling = 0;
  for (let i = 0; i < blockLength; i++) rolling += transformed[i];
  blockSums[0] = rolling;
  for (let start = 1; start < startCount; start++) {
    rolling += transformed[start + blockLength - 1] - transformed[start - 1];
    blockSums[start] = rolling;
  }

  const fullBlocks = Math.floor(n / blockLength);
  const remainder = n - fullBlocks * blockLength;
  const random = createSeededRandom(
    Number.isFinite(options.seed)
      ? options.seed
      : bootstrapSeed(series, metric, blockLength, replicates)
  );
  const estimates = new Float64Array(replicates);

  for (let replicate = 0; replicate < replicates; replicate++) {
    let total = 0;
    for (let block = 0; block < fullBlocks; block++) {
      total += blockSums[Math.floor(random() * startCount)];
    }
    if (remainder) {
      const maxStart = Math.max(1, n - remainder + 1);
      const start = Math.floor(random() * maxStart);
      for (let offset = 0; offset < remainder; offset++) {
        total += transformed[start + offset];
      }
    }
    estimates[replicate] = isFps ? n / total : total / n;
  }

  const sortedEstimates = Array.from(estimates).sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  return {
    n,
    mean,
    meanKind: isFps ? 'harmonic' : 'arithmetic',
    r1: calculateLagAutocorrelation(series, 1),
    blockLength,
    replicates,
    confidence,
    interval: [
      quantileFromSorted(sortedEstimates, alpha),
      quantileFromSorted(sortedEstimates, 1 - alpha)
    ],
    method: 'moving-block-bootstrap-percentile'
  };
}

// Backwards-compatible function name for external callers. The returned method
// is now a moving-block bootstrap, not a normal/AR(1) approximation.
function calculateAutocorrelationCorrectedCI(values, metric = 'FrameTime', options = {}) {
  return calculateBlockBootstrapCI(values, metric, options);
}

function workerPercentile(sorted, percentile) {
  if (!sorted.length) return NaN;
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function workerMode(sortedInput) {
  const sorted = sortedInput.slice();
  const n = sorted.length;
  if (!n) return NaN;
  if (n === 1) return sorted[0];
  if (n === 2) return (sorted[0] + sorted[1]) / 2;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo + 1 >= 4) {
    const length = hi - lo + 1;
    const half = Math.ceil(length / 2);
    let best = lo;
    let bestWidth = sorted[lo + half - 1] - sorted[lo];
    for (let i = lo + 1; i <= hi - half + 1; i++) {
      const width = sorted[i + half - 1] - sorted[i];
      if (width < bestWidth) {
        bestWidth = width;
        best = i;
      }
    }
    lo = best;
    hi = best + half - 1;
  }
  if (hi === lo) return sorted[lo];
  if (hi - lo === 1) return (sorted[lo] + sorted[hi]) / 2;
  const leftGap = sorted[lo + 1] - sorted[lo];
  const rightGap = sorted[hi] - sorted[lo + 1];
  if (leftGap < rightGap) return (sorted[lo] + sorted[lo + 1]) / 2;
  if (rightGap < leftGap) return (sorted[lo + 1] + sorted[hi]) / 2;
  return sorted[lo + 1];
}

function workerCalculateStatistics(values, metricName) {
  const sorted = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) {
    return {
      max: NaN, min: NaN, avg: NaN, median: NaN, mode: NaN, stdev: NaN,
      p1: NaN, p01: NaN, p001: NaN,
      low1: NaN, low01: NaN, low001: NaN, high1: NaN, high01: NaN
    };
  }
  const isFps = isFpsLikeMetric(metricName);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const arithmeticMean = sum / n;
  const avg = isFps
    ? n / sorted.reduce((total, value) => total + 1 / value, 0)
    : arithmeticMean;
  const stdev = n > 1
    ? Math.sqrt(sorted.reduce((total, value) => total + (value - arithmeticMean) ** 2, 0) / (n - 1))
    : 0;
  const c1 = Math.max(1, Math.ceil(n * 0.01));
  const c01 = Math.max(1, Math.ceil(n * 0.001));
  const c001 = Math.max(1, Math.ceil(n * 0.0001));
  const meanSlice = slice => slice.reduce((total, value) => total + value, 0) / slice.length;
  const worst = isFps ? sorted : sorted.slice().reverse();
  const best = isFps ? sorted.slice().reverse() : sorted;
  return {
    max: sorted[n - 1],
    min: sorted[0],
    avg,
    median: workerPercentile(sorted, 50),
    mode: workerMode(sorted),
    stdev,
    p1: workerPercentile(sorted, isFps ? 1 : 99),
    p01: workerPercentile(sorted, isFps ? 0.1 : 99.9),
    p001: workerPercentile(sorted, isFps ? 0.01 : 99.99),
    low1: meanSlice(worst.slice(0, c1)),
    low01: meanSlice(worst.slice(0, c01)),
    low001: meanSlice(worst.slice(0, c001)),
    high1: meanSlice(best.slice(0, c1)),
    high01: meanSlice(best.slice(0, c01))
  };
}

function workerCalculateAggregate(values, metricName) {
  const series = (values || []).filter(value => Number.isFinite(value) && value > 0);
  const n = series.length;
  if (n < 2) return NaN;
  const mean = series.reduce((total, value) => total + value, 0) / n;
  if (metricName.endsWith('_FTSD')) {
    return Math.sqrt(series.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1));
  }
  if (metricName.includes('Coefficient_of_Variation') || metricName === 'Coefficient_of_Variation') {
    if (!mean) return NaN;
    const stdev = Math.sqrt(series.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1));
    return stdev / mean;
  }
  if (metricName.includes('RMSSD')) {
    let sumSq = 0;
    for (let i = 1; i < n; i++) sumSq += (series[i] - series[i - 1]) ** 2;
    return Math.sqrt(sumSq / (n - 1));
  }
  if (metricName.includes('Stepwise_Relative_SD') || metricName === 'Stepwise_Relative_SD') {
    let sumSq = 0;
    for (let i = 1; i < n; i++) {
      const relative = (series[i] - series[i - 1]) / series[i - 1];
      sumSq += relative * relative;
    }
    return Math.sqrt(sumSq / (n - 1));
  }
  const variance = series.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1);
  const stdev = Math.sqrt(variance);
  if (!stdev) return NaN;
  if (metricName === 'Nonparametric_Skew') {
    const sorted = series.slice().sort((a, b) => a - b);
    return (mean - workerPercentile(sorted, 50)) / stdev;
  }
  let sumZ3 = 0;
  let sumZ4 = 0;
  for (const value of series) {
    const z = (value - mean) / stdev;
    sumZ3 += z ** 3;
    sumZ4 += z ** 4;
  }
  if (metricName === 'Skewness') {
    return n >= 3 ? (n / ((n - 1) * (n - 2))) * sumZ3 : NaN;
  }
  if (metricName === 'Kurtosis') {
    return n >= 4
      ? (n * (n + 1) / ((n - 1) * (n - 2) * (n - 3))) * sumZ4
        - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3))
      : NaN;
  }
  return NaN;
}

let statsWorker = null;
let statsWorkerUrl = null;
let statsWorkerRequestId = 0;
const statsWorkerRequests = new Map();

function getStatsWorkerSource() {
  return [
    isFpsLikeMetric.toString(),
    getPositiveValuesForHarmonicMean.toString(),
    averageForMetric.toString(),
    calculateLagAutocorrelation.toString(),
    createSeededRandom.toString(),
    bootstrapSeed.toString(),
    quantileFromSorted.toString(),
    chooseMovingBlockLength.toString(),
    calculateBlockBootstrapCI.toString(),
    workerPercentile.toString(),
    workerMode.toString(),
    workerCalculateStatistics.toString(),
    workerCalculateAggregate.toString(),
    `self.onmessage = function (event) {
      const { id, task, items, options } = event.data;
      try {
        let results;
        if (task === 'statistics') {
          results = items.map(item => ({
            key: item.key,
            result: item.aggregate
              ? workerCalculateAggregate(item.values, item.metric)
              : workerCalculateStatistics(item.values, item.metric)
          }));
        } else {
          results = items.map(item => ({
            key: item.key,
            result: calculateBlockBootstrapCI(item.values, item.metric, options || {})
          }));
        }
        self.postMessage({ id, results });
      } catch (error) {
        self.postMessage({ id, error: error && error.message ? error.message : String(error) });
      }
    };`
  ].join('\n\n');
}

function resetStatsWorker(error) {
  if (statsWorker) statsWorker.terminate();
  if (statsWorkerUrl) URL.revokeObjectURL(statsWorkerUrl);
  statsWorker = null;
  statsWorkerUrl = null;
  if (error) {
    statsWorkerRequests.forEach(({ reject }) => reject(error));
    statsWorkerRequests.clear();
  }
}

function getStatsWorker() {
  if (statsWorker) return statsWorker;
  if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') {
    return null;
  }
  statsWorkerUrl = URL.createObjectURL(new Blob([getStatsWorkerSource()], { type: 'text/javascript' }));
  statsWorker = new Worker(statsWorkerUrl);
  statsWorker.onmessage = event => {
    const { id, results, error } = event.data || {};
    const request = statsWorkerRequests.get(id);
    if (!request) return;
    statsWorkerRequests.delete(id);
    if (error) request.reject(new Error(error));
    else request.resolve(results);
  };
  statsWorker.onerror = event => {
    resetStatsWorker(new Error(event.message || 'The statistics worker failed.'));
  };
  return statsWorker;
}

async function calculateBootstrapBatch(items, options = {}) {
  if (!items.length) return [];
  const worker = getStatsWorker();
  if (!worker) {
    return items.map(item => ({
      key: item.key,
      result: calculateBlockBootstrapCI(item.values, item.metric, options)
    }));
  }
  const id = ++statsWorkerRequestId;
  return new Promise((resolve, reject) => {
    statsWorkerRequests.set(id, { resolve, reject });
    worker.postMessage({ id, task: 'bootstrap', items, options });
  });
}

async function calculateStatisticsBatch(items) {
  if (!items.length) return [];
  const worker = getStatsWorker();
  if (!worker) {
    return items.map(item => ({
      key: item.key,
      result: item.aggregate
        ? calculateAggregateMetric(item.values, item.metric)
        : calculateStatistics(item.values, item.metric)
    }));
  }
  const id = ++statsWorkerRequestId;
  return new Promise((resolve, reject) => {
    statsWorkerRequests.set(id, { resolve, reject });
    worker.postMessage({ id, task: 'statistics', items });
  });
}

function getPercentileSupportStatus(expectedTailFrames) {
  if (expectedTailFrames >= 50) {
    return { label: 'Strong sample support', className: 'reliable' };
  }
  if (expectedTailFrames >= 30) {
    return { label: 'Limited sample support', className: 'low-confidence' };
  }
  return { label: 'Very low sample support', className: 'insufficient' };
}

function formatSupportCount(value) {
  if (value >= 10) return value.toFixed(1);
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(3);
}

function interpretAutocorrelation(r1) {
  if (!Number.isFinite(r1)) return 'no variance';
  if (r1 >= 0.5) return 'strong clustering';
  if (r1 >= 0.25) return 'moderate clustering';
  if (r1 >= 0.1) return 'mild clustering';
  if (r1 <= -0.1) return 'alternating';
  return 'independent';
}

function makeDiagnosticsElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderPercentileSupport(container, frameCount, metric = 'FrameTime') {
  const section = makeDiagnosticsElement('section', 'stats-diagnostic-section');
  section.appendChild(makeDiagnosticsElement('h4', '', 'Percentile sample support'));

  const table = makeDiagnosticsElement('table', 'diag-table');
  const thead = document.createElement('thead');
  thead.innerHTML =
    '<tr><th scope="col">Percentile</th><th scope="col" class="diag-num">Tail frames</th><th scope="col">Status</th></tr>';
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  PERCENTILE_SUPPORT_DIAGNOSTICS.forEach(({ key, fraction }) => {
    const label = getStatDisplayName(key, [metric]);
    const expected = frameCount * fraction;
    const status = getPercentileSupportStatus(expected);
    const row = document.createElement('tr');

    const statusCell = makeDiagnosticsElement('td', 'diag-status');
    statusCell.append(
      makeDiagnosticsElement('span', `diag-dot ${status.className}`),
      makeDiagnosticsElement('span', 'diag-status-text', status.label)
    );

    row.append(
      makeDiagnosticsElement('td', 'diag-name', label),
      makeDiagnosticsElement('td', 'diag-num', formatSupportCount(expected)),
      statusCell
    );
    tbody.appendChild(row);
  });
  table.appendChild(tbody);

  section.appendChild(table);
  container.appendChild(section);
}

function renderAutocorrelationDiagnostics(container, frametimes) {
  const section = makeDiagnosticsElement('section', 'stats-diagnostic-section');
  const head = makeDiagnosticsElement('div', 'stats-diagnostic-head');
  head.append(
    makeDiagnosticsElement('h4', '', 'Autocorrelation'),
    makeDiagnosticsElement('span', 'stats-diagnostic-tag', interpretAutocorrelation(calculateLagAutocorrelation(frametimes, 1)))
  );
  section.appendChild(head);

  const acfValues = [1, 2, 3].map(lag => ({
    lag,
    value: calculateLagAutocorrelation(frametimes, lag)
  }));

  const acf = makeDiagnosticsElement('div', 'stats-acf');
  acfValues.forEach(({ lag, value }) => {
    const row = makeDiagnosticsElement('div', 'stats-acf-row');
    row.appendChild(makeDiagnosticsElement('span', 'stats-acf-label', `Lag ${lag}`));

    const track = makeDiagnosticsElement('div', 'stats-acf-track');
    track.appendChild(makeDiagnosticsElement('span', 'stats-acf-center'));
    if (Number.isFinite(value)) {
      const bar = makeDiagnosticsElement(
        'span',
        `stats-acf-bar ${value >= 0 ? 'positive' : 'negative'}`
      );
      bar.style.width = `${Math.min(50, Math.abs(value) * 50)}%`;
      track.appendChild(bar);
    }
    row.appendChild(track);
    row.appendChild(makeDiagnosticsElement(
      'span',
      'stats-acf-value',
      Number.isFinite(value) ? value.toFixed(3) : 'N/A'
    ));
    acf.appendChild(row);
  });

  section.appendChild(acf);
  container.appendChild(section);
}

function formatMetricInterval(interval, metric) {
  const lo = interval[0];
  const hi = interval[1];
  if (isFpsLikeMetric(metric || '')) {
    return `[${lo.toFixed(2)}, ${hi.toFixed(2)}] FPS`;
  }
  if (!metric || metric === 'FrameTime' || /^Ms/i.test(metric) || /time|latency|ms/i.test(metric)) {
    return `[${lo.toFixed(3)}, ${hi.toFixed(3)}] ms`;
  }
  return `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`;
}

function formatMetricMean(mean, metric, meanKind) {
  const kind = meanKind || (isFpsLikeMetric(metric || '') ? 'harmonic' : 'arithmetic');
  const label = kind === 'harmonic' ? 'Harmonic mean' : 'Mean';
  if (isFpsLikeMetric(metric || '')) {
    return `${label}: ${mean.toFixed(2)} FPS`;
  }
  if (!metric || metric === 'FrameTime' || /^Ms/i.test(metric) || /time|latency|ms/i.test(metric)) {
    return `${label}: ${mean.toFixed(3)} ms`;
  }
  return `${label}: ${mean.toFixed(3)}`;
}

function formatFrametimeInterval(interval) {
  return formatMetricInterval(interval, 'FrameTime');
}

function renderBootstrapIntervalDiagnostics(container, result, metric = 'FrameTime') {
  const section = makeDiagnosticsElement('section', 'stats-diagnostic-section');
  section.appendChild(makeDiagnosticsElement('h4', '', 'Mean uncertainty (95%)'));

  if (!result) {
    section.appendChild(makeDiagnosticsElement(
      'p',
      'stats-diagnostic-explanation',
      'Need at least two samples.'
    ));
    container.appendChild(section);
    return;
  }

  section.appendChild(makeDiagnosticsElement(
    'div',
    'stats-diagnostic-primary',
    formatMetricMean(result.mean, metric, result.meanKind)
  ));

  const explanation = makeDiagnosticsElement(
    'p',
    'stats-diagnostic-explanation',
    'Percentile moving-block bootstrap. Consecutive blocks preserve local frame-to-frame dependence.'
  );
  section.appendChild(explanation);

  const ciGrid = makeDiagnosticsElement('div', 'stats-ci-grid');
  const intervalCard = makeDiagnosticsElement('div', 'stats-ci-card corrected');
  intervalCard.append(
    makeDiagnosticsElement('span', 'stats-ci-label', 'Moving-block bootstrap'),
    makeDiagnosticsElement('strong', 'stats-ci-value', formatMetricInterval(result.interval, metric)),
    makeDiagnosticsElement(
      'span',
      'stats-ci-note',
      `${result.replicates.toLocaleString()} resamples · block length ${result.blockLength.toLocaleString()}`
    )
  );

  const sampleCard = makeDiagnosticsElement('div', 'stats-ci-card');
  sampleCard.append(
    makeDiagnosticsElement('span', 'stats-ci-label', 'Observed sample'),
    makeDiagnosticsElement('strong', 'stats-ci-value', `${result.n.toLocaleString()} valid samples`),
    makeDiagnosticsElement(
      'span',
      'stats-ci-note',
      Number.isFinite(result.r1) ? `lag-1 = ${result.r1.toFixed(3)}` : 'lag-1 unavailable'
    )
  );

  ciGrid.append(intervalCard, sampleCard);
  section.appendChild(ciGrid);
  container.appendChild(section);
}

async function renderReliabilityDiagnostics(selectedDatasets, metric = 'FrameTime', precomputedSeries = null) {
  const content = document.getElementById('reliabilityDiagnosticsContent');
  if (!content) return;

  const metricLabel = typeof window.getMetricDisplayName === 'function'
    ? window.getMetricDisplayName(metric)
    : metric;
  const renderToken = String((Number(content.dataset.renderToken) || 0) + 1);
  content.dataset.renderToken = renderToken;
  content.innerHTML = '';

  const heading = document.getElementById('reliabilityDiagnosticsHeading')
    || document.querySelector('.reliability-diagnostics > h2');
  if (heading) heading.textContent = `Dataset diagnostics (${metricLabel})`;

  const entries = selectedDatasets.map((dataset, index) => {
    const key = String(dataset.id ?? index);
    const precomputed = precomputedSeries instanceof Map
      ? precomputedSeries.get(key)
      : precomputedSeries?.[key];
    return {
      dataset,
      index,
      series: Array.isArray(precomputed) ? precomputed : collectMetricValues(dataset, metric)
    };
  });

  entries.forEach(({ dataset, index, series }) => {
    const card = makeDiagnosticsElement('article', 'stats-diagnostics-card');
    card.dataset.datasetId = String(dataset.id ?? index);
    card.style.setProperty('--stripe', getStatsDatasetColor(dataset, index));

    const header = makeDiagnosticsElement('header', 'stats-diagnostics-card-header');
    header.append(
      makeDiagnosticsElement('h3', '', getStatsDatasetLabel(dataset)),
      makeDiagnosticsElement('span', 'stats-frame-count', `${series.length.toLocaleString()} samples`)
    );
    card.appendChild(header);

    if (series.length < 2) {
      card.appendChild(makeDiagnosticsElement('p', 'stats-diagnostic-explanation', 'Need at least two samples.'));
    } else {
      renderPercentileSupport(card, series.length, metric);
      renderAutocorrelationDiagnostics(card, series);
      const pending = makeDiagnosticsElement('section', 'stats-diagnostic-section stats-bootstrap-pending');
      pending.append(
        makeDiagnosticsElement('h4', '', 'Mean uncertainty (95%)'),
        makeDiagnosticsElement('p', 'stats-diagnostic-explanation', 'Calculating moving-block bootstrap interval…')
      );
      card.appendChild(pending);
    }
    content.appendChild(card);
  });

  const items = entries
    .filter(entry => entry.series.length >= 2)
    .map(entry => ({
      key: String(entry.dataset.id ?? entry.index),
      metric,
      values: entry.series
    }));
  if (!items.length) return;

  try {
    const results = await calculateBootstrapBatch(items);
    if (content.dataset.renderToken !== renderToken) return;
    const resultMap = new Map(results.map(entry => [String(entry.key), entry.result]));
    entries.forEach(({ dataset, index, series }) => {
      if (series.length < 2) return;
      const card = content.querySelector(`[data-dataset-id="${CSS.escape(String(dataset.id ?? index))}"]`);
      if (!card) return;
      card.querySelector('.stats-bootstrap-pending')?.remove();
      renderBootstrapIntervalDiagnostics(card, resultMap.get(String(dataset.id ?? index)), metric);
    });
  } catch (error) {
    console.error('Bootstrap diagnostics failed:', error);
    if (content.dataset.renderToken !== renderToken) return;
    content.querySelectorAll('.stats-bootstrap-pending .stats-diagnostic-explanation').forEach(element => {
      element.textContent = 'Could not calculate the bootstrap interval.';
    });
    window.notify?.(`Reliability interval calculation failed: ${error.message}`, 'warning');
  }
}

let latestStatsExportState = null;
let statsCalculationToken = 0;

function getMetricExportUnit(metric) {
  if (['FPS', 'RenderedFPS', 'DisplayedFPS'].includes(metric)) return 'fps';
  if (metric === 'FrameTime' || metric === 'DisplayedFrameTime' || /^Ms/i.test(metric)) return 'ms';
  if (['Rendered_FTSD', 'Displayed_FTSD', 'Rendered_RMSSD', 'Displayed_RMSSD'].includes(metric)) return 'ms';
  if (PERCENT_AGGREGATE_METRICS.has(metric)) return 'ratio';
  if (metric.includes('Util')) return 'percent';
  return 'value';
}

function buildExportReliabilityDiagnostics(
  dataset,
  selectedStats,
  metric = 'FrameTime',
  seriesOverride = null,
  bootstrapOverride = null
) {
  const series = Array.isArray(seriesOverride)
    ? seriesOverride
    : collectMetricValues(dataset, metric);
  const lag1 = calculateLagAutocorrelation(series, 1);
  const percentileSupport = {};

  PERCENTILE_SUPPORT_DIAGNOSTICS.forEach(({ key, fraction }) => {
    const label = getStatDisplayName(key, [metric]);
    const expectedFrames = series.length * fraction;
    const status = getPercentileSupportStatus(expectedFrames);
    percentileSupport[label] = {
      expectedTailFrameCount: expectedFrames,
      support: status.label
    };
  });

  return {
    basedOnMetric: typeof window.getMetricDisplayName === 'function'
      ? window.getMetricDisplayName(metric)
      : metric,
    basedOnMetricKey: metric,
    validSampleCount: series.length,
    lagOneAutocorrelationCoefficient: Number.isFinite(lag1) ? lag1 : null,
    autocorrelationInterpretation: interpretAutocorrelation(lag1),
    percentileSampleSupport: percentileSupport,
    movingBlockBootstrap95PercentInterval: bootstrapOverride
      ? {
          unit: getMetricExportUnit(metric),
          mean: bootstrapOverride.mean,
          meanKind: bootstrapOverride.meanKind,
          lower: bootstrapOverride.interval[0],
          upper: bootstrapOverride.interval[1],
          blockLength: bootstrapOverride.blockLength,
          resamples: bootstrapOverride.replicates,
          method: bootstrapOverride.method
        }
      : null
  };
}

function exportNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function buildStatsJsonExport(state = latestStatsExportState) {
  if (!state) return null;

  const metricDescriptions = {};
  state.metrics.forEach(metric => {
    const metricLabel = typeof window.getMetricDisplayName === 'function'
      ? window.getMetricDisplayName(metric)
      : metric;
    const description = typeof window.getMetricDescription === 'function'
      ? window.getMetricDescription(metric)
      : '';
    metricDescriptions[metricLabel] = description;
  });

  const statisticDescriptions = {};
  state.selectedStats.forEach(stat => {
    const label = getStatDisplayName(stat, state.regularMetrics);
    statisticDescriptions[label] = getStatDescription(stat, state.regularMetrics);
  });

  return {
    exportSource: 'Frame Timing Analyzer',
    generatedAt: state.generatedAt,
    diagnosticsMetric: state.diagnosticsMetric || null,
    datasets: state.datasets.map(entry => {
      const stats = {};
      state.metrics.forEach(metric => {
        const metricLabel = typeof window.getMetricDisplayName === 'function'
          ? window.getMetricDisplayName(metric)
          : metric;
        const metricStats = entry.stats[metric] || {};
        stats[metricLabel] = {};

        Object.entries(metricStats).forEach(([stat, value]) => {
          const statLabel = stat === 'aggregateValue'
            ? 'Aggregate Value'
            : getStatDisplayName(stat, [metric]);
          stats[metricLabel][statLabel] = exportNumber(value);
        });
      });

      return {
        name: getStatsDatasetLabel(entry.dataset),
        rowCount: typeof window.getDatasetRowCount === 'function'
          ? window.getDatasetRowCount(entry.dataset)
          : entry.dataset.rows.length,
        stats,
        reliabilityDiagnostics: entry.reliabilityDiagnostics
      };
    }),
    metricDescriptions,
    statisticDescriptions
  };
}

function escapeMarkdown(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function buildStatsMarkdownExport(state = latestStatsExportState) {
  if (!state) return '';

  const lines = [
    'This is frame timing data exported from a Frame Timing Analyzer. Compare the datasets and explain which run performs better and why.',
    '',
    '## Datasets'
  ];

  state.datasets.forEach(entry => {
    lines.push(`- ${escapeMarkdown(getStatsDatasetLabel(entry.dataset))}: ${(typeof window.getDatasetRowCount === 'function' ? window.getDatasetRowCount(entry.dataset) : entry.dataset.rows.length).toLocaleString()} rows/frames`);
  });

  lines.push('', '## Statistics');
  const headers = ['Metric', ...state.datasets.map(entry => escapeMarkdown(getStatsDatasetLabel(entry.dataset)))];
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);

  state.metrics.forEach(metric => {
    const metricLabel = typeof window.getMetricDisplayName === 'function'
      ? window.getMetricDisplayName(metric)
      : metric;
    const cells = state.datasets.map(entry => {
      const metricStats = entry.stats[metric] || {};
      return Object.entries(metricStats).map(([stat, value]) => {
        const statLabel = stat === 'aggregateValue'
          ? 'Value'
          : getStatDisplayName(stat, [metric]);
        const formatted = stat === 'aggregateValue'
          ? formatAggregateDisplayValue(metric, value)
          : formatStatValue(metric, stat, value);
        return `${escapeMarkdown(statLabel)}: ${formatted}`;
      }).join('; ');
    });
    lines.push(`| ${escapeMarkdown(metricLabel)} | ${cells.join(' | ')} |`);
  });

  const glossary = [];
  state.metrics.forEach(metric => {
    const metricLabel = typeof window.getMetricDisplayName === 'function'
      ? window.getMetricDisplayName(metric)
      : metric;
    const description = typeof window.getMetricDescription === 'function'
      ? window.getMetricDescription(metric)
      : '';
    if (description) {
      glossary.push(`- **${escapeMarkdown(metricLabel)}:** ${escapeMarkdown(description)}`);
    }
  });
  state.selectedStats.forEach(stat => {
    const description = getStatDescription(stat, state.regularMetrics);
    if (description) {
      glossary.push(`- **${escapeMarkdown(getStatDisplayName(stat, state.regularMetrics))}:** ${escapeMarkdown(description)}`);
    }
  });

  if (glossary.length) {
    lines.push('', '## Glossary', ...glossary);
  }

  lines.push('', '## Reliability notes');
  state.datasets.forEach(entry => {
    const diagnostics = entry.reliabilityDiagnostics;
    const lag1 = diagnostics.lagOneAutocorrelationCoefficient;
    const lagText = Number.isFinite(lag1) ? lag1.toFixed(3) : 'N/A';
    lines.push(
      `- **${escapeMarkdown(getStatsDatasetLabel(entry.dataset))}:** ${diagnostics.validSampleCount.toLocaleString()} valid ${escapeMarkdown(diagnostics.basedOnMetric)} samples; lag-1 autocorrelation ${lagText}. ${escapeMarkdown(diagnostics.autocorrelationInterpretation)}`
    );

    Object.entries(diagnostics.percentileSampleSupport).forEach(([label, support]) => {
      lines.push(
        `  - ${escapeMarkdown(label)} support: ${formatSupportCount(support.expectedTailFrameCount)} tail frames, ${support.support}.`
      );
    });
    const bootstrap = diagnostics.movingBlockBootstrap95PercentInterval;
    if (bootstrap) {
      lines.push(
        `  - Moving-block bootstrap 95% interval: ${formatMetricInterval([bootstrap.lower, bootstrap.upper], diagnostics.basedOnMetricKey)}; block length ${bootstrap.blockLength}, ${bootstrap.resamples.toLocaleString()} resamples.`
      );
    }
  });

  return lines.join('\n');
}

async function copyStatsAsMarkdown() {
  const markdown = buildStatsMarkdownExport();
  if (!markdown) {
    window.notify?.('Calculate statistics before exporting.', 'warning');
    return;
  }

  try {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(markdown);
        copied = true;
      } catch (error) {
        copied = false;
      }
    }

    if (!copied) {
      const textarea = document.createElement('textarea');
      textarea.value = markdown;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      copied = document.execCommand('copy');
      textarea.remove();
      if (!copied) throw new Error('Clipboard copy was not available.');
    }
    window.notify?.('Statistics copied as Markdown.', 'success');
  } catch (error) {
    window.notify?.(`Could not copy statistics: ${error.message}`, 'error');
  }
}

function downloadStatsAsJson() {
  const exportData = buildStatsJsonExport();
  if (!exportData) {
    window.notify?.('Calculate statistics before exporting.', 'warning');
    return;
  }

  const json = JSON.stringify(exportData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.href = url;
  link.download = `frametime-stats-export-${timestamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  window.notify?.('Statistics JSON downloaded.', 'success');
}

function resolveCssColor(customProperty, fallback = '#1a1a1a') {
  const probe = document.createElement('div');
  probe.style.cssText = `position:fixed;left:-9999px;visibility:hidden;background:var(${customProperty})`;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent' ? color : fallback;
}

async function exportStatsAsPng() {
  const toPng = window.htmlToImage?.toPng;
  if (typeof toPng !== 'function') {
    window.notify?.('PNG export library failed to load. Check your connection and reload.', 'error');
    return;
  }
  const target = document.querySelector('.stats-tables-stack');
  if (!target || !latestStatsExportState) {
    window.notify?.('Calculate statistics before exporting.', 'warning');
    return;
  }

  window.notify?.('Rendering PNG…', 'info');

  try {
    const bg = resolveCssColor('--bg', '#1a1a1a');
    const url = await toPng(target, {
      backgroundColor: bg,
      pixelRatio: 2,
      cacheBust: true
    });

    const link = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.href = url;
    link.download = `frametime-stats-export-${timestamp}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();

    window.notify?.('Statistics exported as PNG.', 'success');
  } catch (error) {
    window.notify?.(`Could not export PNG: ${error.message}`, 'error');
  }
}

/**
 * Resets the Statistics panel to its empty state (used on clear-all).
 */
function resetStatsPanel() {
  statsCalculationToken++;
  const statsContent = document.getElementById('statistics');
  if (statsContent) statsContent.classList.add('empty-stats');
  const statusLine = document.getElementById('statsStatusLine');
  if (statusLine) statusLine.textContent = '';

  const statsTable = document.getElementById('statsTable');
  if (statsTable) {
    const thead = statsTable.querySelector('thead');
    const tbody = statsTable.querySelector('tbody');
    if (thead) thead.innerHTML = '';
    if (tbody) tbody.innerHTML = '';
  }

  const aggregateWrap = document.getElementById('statsAggregateWrap');
  const aggregateTable = document.getElementById('statsAggregateTable');
  if (aggregateWrap) aggregateWrap.classList.add('hidden');
  if (aggregateTable) {
    const thead = aggregateTable.querySelector('thead');
    const tbody = aggregateTable.querySelector('tbody');
    if (thead) thead.innerHTML = '';
    if (tbody) tbody.innerHTML = '';
  }
  syncStatsTablesSeparation();

  latestStatsExportState = null;
  window.latestStatsExportData = null;
  setStatsExportVisible(false);
}

function setStatsExportVisible(visible) {
  const el = document.getElementById('statsExportBanner');
  if (!el) return;
  el.classList.toggle('hidden', !visible);
  el.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

async function updateStatsTable() {
  const calculationToken = ++statsCalculationToken;
  const calcBtn = document.getElementById('calculateStatsBtn');
  const statsContent = document.getElementById('statistics');
  const statusLine = document.getElementById('statsStatusLine');
  if (calcBtn) {
    calcBtn.disabled = true;
    calcBtn.setAttribute('aria-busy', 'true');
  }
  statsContent?.setAttribute('aria-busy', 'true');
  if (statusLine) statusLine.textContent = 'Calculating statistics.';

  try {
    await updateStatsTableCore(calculationToken);
  } catch (error) {
    console.error('Statistics calculation failed:', error);
    if (statusLine) statusLine.textContent = 'Statistics calculation failed.';
    window.notify?.(`Statistics calculation failed: ${error.message}`, 'error');
  } finally {
    if (calcBtn) {
      calcBtn.disabled = false;
      calcBtn.removeAttribute('aria-busy');
    }
    statsContent?.removeAttribute('aria-busy');
  }
}

/**
 * Updates the Statistics table (#statsTable) by computing stats for each selected metric,
 * for all selected datasets in the statDatasetSelect dropdown.
 */
async function updateStatsTableCore(calculationToken = statsCalculationToken) {
  const statsContent = document.getElementById('statistics');
  const selectedDatasetIndices = (typeof window.getDatasetPickerIndices === 'function'
    ? window.getDatasetPickerIndices('statDatasetSelect')
    : []);
  const selectedDatasets = selectedDatasetIndices.map(idx => window.allDatasets[idx]).filter(Boolean);
  if (!selectedDatasets.length) {
    window.notify?.('Select at least one dataset to calculate statistics.', 'warning');
    resetStatsPanel();
    return;
  }

  const selectedMetrics = Array.from(document.querySelectorAll('#statMetricsGroup .toggle-button.active'))
    .map(btn => btn.dataset.metric);
  if (!selectedMetrics.length) {
    window.notify?.('Select at least one metric.', 'warning');
    resetStatsPanel();
    return;
  }

  const selectedStats = Array.from(document.querySelectorAll('#statsTypeGroup .toggle-button.active'))
    .map(btn => btn.dataset.stat);

  const regularMetrics = selectedMetrics.filter(m => !isAggregateMetric(m));
  const aggregateMetrics = selectedMetrics.filter(m => isAggregateMetric(m));

  if (regularMetrics.length && !selectedStats.length) {
    window.notify?.('Select at least one statistic.', 'warning');
    resetStatsPanel();
    return;
  }

  statsContent.classList.remove('empty-stats');
  latestStatsExportState = null;
  window.latestStatsExportData = null;
  setStatsExportVisible(false);

  // Diagnostics metric is explicit from Statistics context: prefer FrameTime,
  // else the first regular metric selected - never the Reliability-tab control.
  const diagnosticsMetric = regularMetrics.includes('RenderedFPS')
    ? 'RenderedFPS'
    : (regularMetrics[0] || selectedMetrics[0] || 'RenderedFPS');

  const exportState = {
    generatedAt: new Date().toISOString(),
    metrics: selectedMetrics.slice(),
    regularMetrics: regularMetrics.slice(),
    aggregateMetrics: aggregateMetrics.slice(),
    diagnosticsMetric,
    selectedStats: selectedStats.slice(),
    datasets: selectedDatasets.map(dataset => ({
      dataset,
      stats: {},
      reliabilityDiagnostics: null
    }))
  };

  const metricSeriesCache = new Map();
  const cacheKey = (dataset, metric) => `${dataset.id ?? dataset.name}::${metric}`;
  const cachedCollect = (dataset, metric) => {
    const key = cacheKey(dataset, metric);
    if (!metricSeriesCache.has(key)) {
      metricSeriesCache.set(key, collectMetricValues(dataset, metric));
    }
    return metricSeriesCache.get(key);
  };

  // Collect only the requested series, then hand sorting, descriptive
  // statistics, aggregate metrics, and bootstrap resampling to a Web Worker.
  const requiredMetrics = new Set([...selectedMetrics, diagnosticsMetric]);
  for (const dataset of selectedDatasets) {
    for (const metric of requiredMetrics) {
      cachedCollect(dataset, metric);
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  const statisticsItems = [];
  selectedDatasets.forEach(dataset => {
    regularMetrics.forEach(metric => {
      statisticsItems.push({
        key: cacheKey(dataset, metric),
        metric,
        aggregate: false,
        values: cachedCollect(dataset, metric)
      });
    });
    aggregateMetrics.forEach(metric => {
      statisticsItems.push({
        key: cacheKey(dataset, metric),
        metric,
        aggregate: true,
        values: cachedCollect(dataset, metric)
      });
    });
  });

  const [statisticsResults, bootstrapResults] = await Promise.all([
    calculateStatisticsBatch(statisticsItems),
    calculateBootstrapBatch(selectedDatasets.map(dataset => ({
      key: String(dataset.id ?? dataset.name),
      metric: diagnosticsMetric,
      values: cachedCollect(dataset, diagnosticsMetric)
    })))
  ]);
  const statisticsResultMap = new Map(statisticsResults.map(entry => [entry.key, entry.result]));
  const bootstrapResultMap = new Map(bootstrapResults.map(entry => [String(entry.key), entry.result]));

  if (calculationToken !== statsCalculationToken) return;

  const mainWrap = document.getElementById('statsMainTableWrap');
  const statsTable = document.getElementById('statsTable');
  const thead = statsTable.querySelector('thead');
  const tbody = statsTable.querySelector('tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  if (regularMetrics.length) {
    if (mainWrap) mainWrap.classList.remove('hidden');

    const headerRow = document.createElement('tr');
    headerRow.innerHTML = '<th class="stats-corner" scope="col">Metric</th><th scope="col">Dataset</th>';
    selectedStats.forEach(stat => {
      headerRow.innerHTML += `<th scope="col">${getStatDisplayName(stat, regularMetrics)}</th>`;
    });
    thead.appendChild(headerRow);

    let rowIndex = 0;

    regularMetrics.forEach(metric => {
      const datasetStats = selectedDatasets.map((dataset, dsIdx) => {
        const values = cachedCollect(dataset, metric);
        return {
          name: getStatsDatasetLabel(dataset),
          color: getStatsDatasetColor(dataset, dsIdx),
          stats: statisticsResultMap.get(cacheKey(dataset, metric)) || calculateStatistics(values, metric)
        };
      });
      datasetStats.forEach((datasetResult, datasetIndex) => {
        exportState.datasets[datasetIndex].stats[metric] = {};
        selectedStats.forEach(stat => {
          exportState.datasets[datasetIndex].stats[metric][stat] = datasetResult.stats[stat];
        });
      });
      const isFpsMetric = isFpsLikeMetric(metric);
      const metricLabel = typeof window.getMetricChipLabel === 'function'
        ? window.getMetricChipLabel(metric)
        : getMetricDisplayName(metric);

      datasetStats.forEach((dsStats, dsIndex) => {
        const row = document.createElement('tr');
        row.className = 'stats-data-row';
        if (rowIndex % 2 === 1) row.classList.add('stats-row-alt');
        rowIndex++;

        if (dsIndex === 0) {
          const metricCell = document.createElement('th');
          metricCell.className = 'stats-metric-cell';
          metricCell.scope = 'rowgroup';
          metricCell.rowSpan = datasetStats.length;
          metricCell.textContent = metricLabel;
          metricCell.title = getMetricDisplayName(metric);
          metricCell.setAttribute('aria-label', getMetricDisplayName(metric));
          row.appendChild(metricCell);
        }

        const nameCell = document.createElement('th');
        nameCell.className = 'dataset-name-cell stats-row-stripe';
        nameCell.scope = 'row';
        nameCell.style.setProperty('--stripe', dsStats.color || getDatasetColor(dsIndex));
        nameCell.textContent = dsStats.name;
        nameCell.setAttribute('aria-label', dsStats.name);
        row.appendChild(nameCell);

        selectedStats.forEach(stat => {
          const value = dsStats.stats[stat];
          const cell = document.createElement('td');
          cell.textContent = formatStatValue(metric, stat, value);

          if (datasetStats.length > 1 && Number.isFinite(value)) {
            const allValues = datasetStats.map(ds => ds.stats[stat]).filter(Number.isFinite);
            const higherIsBetter = isFpsMetric && stat !== 'stdev';
            const best = higherIsBetter ? Math.max(...allValues) : Math.min(...allValues);
            const worst = higherIsBetter ? Math.min(...allValues) : Math.max(...allValues);
            if (value === best) {
              cell.classList.add('dataset-better-value');
              cell.title = 'Best value in this comparison';
              cell.setAttribute('aria-label', `${cell.textContent}, best value in this comparison`);
            } else if (value === worst) {
              cell.classList.add('dataset-worse-value');
              cell.title = 'Worst value in this comparison';
              cell.setAttribute('aria-label', `${cell.textContent}, worst value in this comparison`);
            }
          }

          row.appendChild(cell);
        });

        tbody.appendChild(row);
      });
    });
  } else if (mainWrap) {
    mainWrap.classList.add('hidden');
  }

  renderAggregateStatsTable(aggregateMetrics, selectedDatasets, exportState, statisticsResultMap, cacheKey);
  syncStatsTablesSeparation();

  try {
    exportState.datasets.forEach(entry => {
      entry.reliabilityDiagnostics = buildExportReliabilityDiagnostics(
        entry.dataset,
        selectedStats,
        diagnosticsMetric,
        cachedCollect(entry.dataset, diagnosticsMetric),
        bootstrapResultMap.get(String(entry.dataset.id ?? entry.dataset.name)) || null
      );
    });
    latestStatsExportState = exportState;
    window.latestStatsExportData = buildStatsJsonExport(exportState);
  } catch (error) {
    console.error('Failed to prepare statistics export:', error);
    latestStatsExportState = exportState;
    window.latestStatsExportData = null;
    window.notify?.('Statistics calculated, but export prep failed.', 'warning');
  }

  setStatsExportVisible(true);
  const statusLine = document.getElementById('statsStatusLine');
  if (statusLine) {
    const metricLabel = selectedMetrics.length === 1 ? 'metric' : 'metrics';
    const datasetLabel = selectedDatasets.length === 1 ? 'dataset' : 'datasets';
    statusLine.textContent =
      `Statistics updated: ${selectedMetrics.length} ${metricLabel} across ` +
      `${selectedDatasets.length} ${datasetLabel}.`;
  }
}

/**
 * Compact pivot table for aggregate frametime metrics - one row per metric,
 * one column per dataset (no empty stat columns).
 */
function syncStatsTablesSeparation() {
  const statsPage = document.getElementById('statistics');
  const aggregateWrap = document.getElementById('statsAggregateWrap');
  const mainWrap = document.getElementById('statsMainTableWrap');
  const divider = document.getElementById('statsTablesDivider');

  const aggregateVisible = !!(aggregateWrap && !aggregateWrap.classList.contains('hidden'));
  const mainVisible = !!(mainWrap && !mainWrap.classList.contains('hidden')
    && mainWrap.style.display !== 'none');
  const bothVisible = aggregateVisible && mainVisible;

  if (statsPage) statsPage.classList.toggle('stats-has-both-tables', bothVisible);
  if (divider) {
    divider.classList.toggle('hidden', !bothVisible);
    divider.setAttribute('aria-hidden', 'true');
  }
}

function renderAggregateStatsTable(aggregateMetrics, selectedDatasets, exportState = null, resultMap = null, keyFor = null) {
  const wrap = document.getElementById('statsAggregateWrap');
  const table = document.getElementById('statsAggregateTable');
  if (!wrap || !table) return;

  if (!aggregateMetrics.length) {
    wrap.classList.add('hidden');
    return;
  }

  wrap.classList.remove('hidden');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th class="stats-corner" scope="col">Metric</th>';
  selectedDatasets.forEach((ds, i) => {
    const th = document.createElement('th');
    th.className = 'stats-dataset-header';
    th.scope = 'col';
    th.setAttribute('aria-label', ds.name);

    const stripe = document.createElement('span');
    stripe.className = 'stats-header-stripe';
    stripe.style.setProperty('--stripe', getStatsDatasetColor(ds, i));

    const name = document.createElement('span');
    name.className = 'stats-header-name';
    name.textContent = ds.name;

    th.append(stripe, name);
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);

  aggregateMetrics.forEach((metric, metricIndex) => {
    const row = document.createElement('tr');
    row.className = 'stats-data-row';
    if (metricIndex % 2 === 1) row.classList.add('stats-row-alt');

    const metricLabel = typeof window.getMetricChipLabel === 'function'
      ? window.getMetricChipLabel(metric)
      : getMetricDisplayName(metric);
    const desc = getMetricDescription(metric);

    const metricCell = document.createElement('th');
    metricCell.className = 'stats-metric-cell stats-aggregate-metric';
    metricCell.scope = 'row';
    metricCell.setAttribute('aria-label', getMetricDisplayName(metric));
    const nameSpan = document.createElement('span');
    nameSpan.className = 'stats-aggregate-name';
    nameSpan.textContent = metricLabel;
    metricCell.appendChild(nameSpan);
    if (desc) {
      const hint = document.createElement('span');
      hint.className = 'stats-aggregate-hint';
      hint.textContent = desc;
      metricCell.appendChild(hint);
    }
    row.appendChild(metricCell);

    const values = selectedDatasets.map(ds => {
      const key = typeof keyFor === 'function' ? keyFor(ds, metric) : null;
      if (key && resultMap?.has(key)) return resultMap.get(key);
      return calculateAggregateMetric(collectAggregateMetricSeries(ds, metric), metric);
    });
    values.forEach((value, datasetIndex) => {
      if (!exportState?.datasets[datasetIndex]) return;
      exportState.datasets[datasetIndex].stats[metric] = {
        aggregateValue: value
      };
    });

    values.forEach((value, dsIndex) => {
      const cell = document.createElement('td');
      cell.className = 'stats-aggregate-value';
      cell.textContent = formatAggregateDisplayValue(metric, value);

      if (selectedDatasets.length > 1 && Number.isFinite(value)) {
        const useLowerIsBetter = !['Skewness', 'Kurtosis', 'Nonparametric_Skew'].includes(metric);
        if (useLowerIsBetter) {
          const finite = values.filter(Number.isFinite);
          const best = Math.min(...finite);
          const worst = Math.max(...finite);
          if (value === best) {
            cell.classList.add('dataset-better-value');
            cell.title = 'Best value in this comparison';
            cell.setAttribute('aria-label', `${cell.textContent}, best value in this comparison`);
          } else if (value === worst) {
            cell.classList.add('dataset-worse-value');
            cell.title = 'Worst value in this comparison';
            cell.setAttribute('aria-label', `${cell.textContent}, worst value in this comparison`);
          }
        }
      }

      row.appendChild(cell);
    });

    tbody.appendChild(row);
  });
}

/**
 * Returns a display name for a statistic key
 * @param {string} stat - Statistic key (e.g., 'avg', 'p1', 'stdev')
 * @returns {string} - Human readable name
 */
function getStatDisplayName(stat, metrics = []) {
  const selected = metrics.filter(Boolean);
  const allFps = selected.length > 0 && selected.every(isFpsLikeMetric);
  const allNonFps = selected.length > 0 && selected.every(metric => !isFpsLikeMetric(metric));
  const percentileLabels = allFps
    ? {
        p1: '1%ile',
        p01: '0.1%ile',
        p001: '0.01%ile'
      }
    : allNonFps
      ? {
          p1: '1%ile',
          p01: '0.1%ile',
          p001: '0.01%ile'
        }
      : {
          p1: '1%ile',
          p01: '0.1%ile',
          p001: '0.01%ile'
        };

  const displayNames = {
    max: 'Maximum',
    min: 'Minimum',
    avg: getAverageDisplayLabel(metrics),
    median: 'Median',
    mode: 'Mode',
    stdev: getStdevDisplayLabel(metrics),
    ...percentileLabels,
    low1: '1% Low',
    low01: '0.1% Low',
    low001: '0.01% Low',
    high1: 'Best 1% mean',
    high01: 'Best 0.1% mean'
  };

  return displayNames[stat] || stat;
}

function getStdevDisplayLabel(metrics = []) {
  // When Avg is harmonic (FPS), STDEV still uses the arithmetic mean. Say so.
  if (getAverageMeanKind(metrics) === 'harmonic' || getAverageMeanKind(metrics) === 'mixed') {
    return 'STDEV (arith.)';
  }
  return 'STDEV';
}

function getStatDescription(stat, metrics = []) {
  const descriptions = {
    'avg': 'Mean value. Harmonic for FPS metrics, arithmetic for time-based metrics.',
    'median': 'Middle value after sorting the samples.',
    'mode': 'Most common value: peak of the density for continuous data (half-sample mode), not raw value frequency.',
    'stdev': 'Sample standard deviation around the arithmetic mean. Not paired with harmonic Avg on FPS.',
    'p1': isFpsLikeMetric(metrics[0] || '') ? '1st-percentile FPS cutoff for the worst 1% of samples.' : '99th-percentile cutoff for the worst 1% of time-based samples.',
    'p01': isFpsLikeMetric(metrics[0] || '') ? '0.1-percentile FPS cutoff for the worst 0.1% of samples.' : '99.9th-percentile cutoff for the worst 0.1% of time-based samples.',
    'p001': isFpsLikeMetric(metrics[0] || '') ? '0.01-percentile FPS cutoff for the worst 0.01% of samples.' : '99.99th-percentile cutoff for the worst 0.01% of time-based samples.',
    'low1': 'Average of the worst 1% of samples.',
    'low01': 'Average of the worst 0.1% of samples.',
    'low001': 'Average of the worst 0.01% of samples.',
    'high1': 'Average of the best 1% of samples (fastest frames / highest FPS).',
    'high01': 'Average of the best 0.1% of samples (fastest frames / highest FPS).'
  };
  return descriptions[stat] || '';
}

// Expose these to the global scope:
window.collectMetricValues = collectMetricValues;
window.isValidMetricSample = isValidMetricSample;
window.getMetricValue = getMetricValue;
window.calculateStepwiseRelativeSD = calculateStepwiseRelativeSD;
window.calculateCoefficientOfVariation = calculateCoefficientOfVariation;
window.calculateRMSSD = calculateRMSSD;
window.calculateFrameTimeSD = calculateFrameTimeSD;
window.collectDisplayedFrametimeSeries = collectDisplayedFrametimeSeries;
window.formatAggregateDisplayValue = formatAggregateDisplayValue;
window.calculateDistributionShape = calculateDistributionShape;
window.calculateStatistics = calculateStatistics;
window.calculatePercentile = calculatePercentile;
window.calculateMode = calculateMode;
window.calculateLagAutocorrelation = calculateLagAutocorrelation;
window.calculateAutocorrelationCorrectedCI = calculateAutocorrelationCorrectedCI;
window.calculateBlockBootstrapCI = calculateBlockBootstrapCI;
window.calculateBootstrapBatch = calculateBootstrapBatch;
window.renderReliabilityDiagnostics = renderReliabilityDiagnostics;
window.updateStatsTable = updateStatsTable;
window.resetStatsPanel = resetStatsPanel;
window.formatStatValue = formatStatValue;
window.getDatasetColor = getDatasetColor;
window.getStatDisplayName = getStatDisplayName;
window.getStatDescription = getStatDescription;
window.updateStatsAverageLabel = updateStatsAverageLabel;
window.buildStatsMarkdownExport = buildStatsMarkdownExport;
window.buildStatsJsonExport = buildStatsJsonExport;
window.copyStatsAsMarkdown = copyStatsAsMarkdown;
window.downloadStatsAsJson = downloadStatsAsJson;
window.exportStatsAsPng = exportStatsAsPng;
