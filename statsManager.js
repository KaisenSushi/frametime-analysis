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

  const stdev = (typeof jStat?.stdev === 'function')
    ? jStat.stdev(series, true)
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
  'Nonparametric_Skew'
]);

function calculateAggregateMetric(values, metricName) {
  switch (metricName) {
    case 'Stepwise_Relative_SD': return calculateStepwiseRelativeSD(values);
    case 'Coefficient_of_Variation': return calculateCoefficientOfVariation(values);
    case 'RMSSD': return calculateRMSSD(values);
    case 'Skewness': return calculateDistributionShape(values).skewness;
    case 'Kurtosis': return calculateDistributionShape(values).kurtosis;
    case 'Nonparametric_Skew': return calculateDistributionShape(values).nonparametricSkew;
    default: return NaN;
  }
}
// Fall back to the shared visualization palette so colors match across tabs.
function getDatasetColor(index) {
  if (typeof window.getBenchmarkColor === 'function') {
    return window.getBenchmarkColor(index);
  }
  const fallback = [
    '#38bdf8', '#ff8c00', '#c084fc', '#fbbf24', '#2dd4bf', '#f472b6',
    '#a3e635', '#818cf8', '#e879f9', '#5eead4', '#fb923c', '#60a5fa',
    '#f9a8d4', '#deb887'
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
    default: return 'Mean';
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
  avgButton.title = selectedMetrics.length
    ? `${label}; the formula is selected per metric.`
    : 'Select a metric to see which mean is used.';
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
  if (metric === 'RMSSD') return value.toFixed(2);
  if (
    metric === 'Stepwise_Relative_SD' ||
    metric === 'Coefficient_of_Variation' ||
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
    // Try standard format first
    if (typeof row['FrameTime'] === 'number') {
      return row['FrameTime'];
    }
    // Try PresentMon format (case insensitive)
    const mbpKey = Object.keys(row).find(key => 
      key.toLowerCase() === 'msbetweenpresents');
    
    if (mbpKey && typeof row[mbpKey] === 'number') {
      return row[mbpKey]; // Return MsBetweenPresents as FrameTime
    }
    return null;
  }
  
  // Rendered FPS from MsBetweenPresents (GPU submit → present)
  if (metric === 'RenderedFPS') {
    const ms = findNumericKey(row, 'MsBetweenPresents', 'FrameTime');
    return (ms && ms > 0) ? 1000.0 / ms : null;
  }

  // Displayed FPS from MsBetweenDisplayChange (actual screen refresh)
  if (metric === 'DisplayedFPS') {
    const ms = findNumericKey(row, 'MsBetweenDisplayChange', 'MsBetweenDisplayChanges');
    return (ms && ms > 0) ? 1000.0 / ms : null;
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

function calculateStatistics(arr, metricName = '') {
  if (!arr.length) {
    return {
      max: NaN, min: NaN, avg: NaN, median: NaN, mode: NaN, stdev: NaN,
      p1: NaN, p01: NaN, p001: NaN,
      low1: NaN, low01: NaN, low001: NaN
    };
  }

  // Frametime-derived aggregate metrics
  if (isAggregateMetric(metricName)) {
    const aggregate = calculateAggregateMetric(arr, metricName);
    return {
      max: aggregate, min: aggregate, avg: aggregate, median: aggregate, mode: aggregate, stdev: 0,
      p1: aggregate, p01: aggregate, p001: aggregate,
      low1: aggregate, low01: aggregate, low001: aggregate
    };
  }

  /* -------- basic aggregates --------------------------------------- */
  const sorted = [...arr].sort((a, b) => a - b);  // ascending
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
  const stdev = (typeof jStat?.stdev === 'function')
      ? jStat.stdev(sorted, true)
      : Math.sqrt(sorted.reduce((s, v) => s + (v - arithmeticMean) ** 2, 0) / (n - 1));

  /* -------- percentiles (single‑frame cut‑off) --------------------- */
  const p1   = calculatePercentile(sorted,  isFpsMetric ? 1     : 99);
  const p01  = calculatePercentile(sorted,  isFpsMetric ? 0.1   : 99.9);
  const p001 = calculatePercentile(sorted,  isFpsMetric ? 0.01  : 99.99);

  /* -------- “X % Low” (average of worst frames) -------------------- */
  const c1   = Math.max(1, Math.ceil(n * 0.01));     // 1 %
  const c01  = Math.max(1, Math.ceil(n * 0.001));    // 0.1 %
  const c001 = Math.max(1, Math.ceil(n * 0.0001));   // 0.01 %

  let low1, low01, low001;

  if (isFpsMetric) {
    // worst FPS = smallest values (array head)
    low1   = sorted.slice(0, c1).  reduce((s, v) => s + v, 0) / c1;
    low01  = sorted.slice(0, c01). reduce((s, v) => s + v, 0) / c01;
    low001 = sorted.slice(0, c001).reduce((s, v) => s + v, 0) / c001;
  } else {
    // worst frame‑times = largest values (array tail)
    const desc = [...sorted].reverse();
    low1   = desc.slice(0, c1).  reduce((s, v) => s + v, 0) / c1;
    low01  = desc.slice(0, c01). reduce((s, v) => s + v, 0) / c01;
    low001 = desc.slice(0, c001).reduce((s, v) => s + v, 0) / c001;
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
    low1, low01, low001
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

function collectFrametimeSeries(dataset) {
  return dataset.rows
    .map(r => getMetricValue(r, 'FrameTime'))
    .filter(v => typeof v === 'number' && v > 0);
}

/**
 * Collects the numeric series used to compute stats for a metric on a dataset.
 */
function collectMetricValues(dataset, metric) {
  if (AGGREGATE_FRAMETIME_METRICS.has(metric)) {
    return collectFrametimeSeries(dataset);
  }
  return dataset.rows
    .map(r => getMetricValue(r, metric))
    .filter(v => typeof v === 'number');
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

/**
 * Builds the summary cards shown above the results table.
 * @param {Array} selectedDatasets
 */
function renderStatsSummary(selectedDatasets) {
  const summaryEl = document.getElementById('statsSummary');
  if (!summaryEl) return;

  const cards = selectedDatasets.map((dataset, index) => {
    const rendered = collectMetricValues(dataset, 'RenderedFPS');
    const displayed = collectMetricValues(dataset, 'DisplayedFPS');
    const gpuBusy = collectMetricValues(dataset, 'MsGPUBusy');
    const untilDisplayed = collectMetricValues(dataset, 'MsUntilDisplayed');
    const frametimes = collectMetricValues(dataset, 'Stepwise_Relative_SD');

    const renderedAvg = averageForMetric(rendered, 'RenderedFPS');
    const displayedAvg = averageForMetric(displayed, 'DisplayedFPS');
    const gpuAvg = averageForMetric(gpuBusy, 'MsGPUBusy');
    const untilAvg = averageForMetric(untilDisplayed, 'MsUntilDisplayed');
    const srsd = calculateStepwiseRelativeSD(frametimes);

    const color = getStatsDatasetColor(dataset, index);

    return `
      <div class="stats-summary-card" style="--card-accent:${color}">
        <div class="stats-summary-name" title="${dataset.name}">${dataset.name}</div>
        <div class="stats-summary-metrics">
          ${summaryMetric('Rendered FPS', Number.isFinite(renderedAvg) ? renderedAvg.toFixed(1) : 'N/A')}
          ${summaryMetric('Displayed FPS', Number.isFinite(displayedAvg) ? displayedAvg.toFixed(1) : 'N/A')}
          ${summaryMetric('MsGPUBusy', Number.isFinite(gpuAvg) ? gpuAvg.toFixed(2) : 'N/A', 'ms')}
          ${summaryMetric('MsUntilDisplayed', Number.isFinite(untilAvg) ? untilAvg.toFixed(2) : 'N/A', 'ms')}
          ${summaryMetric('Stepwise Rel. SD', Number.isFinite(srsd) ? srsd.toFixed(4) : 'N/A')}
        </div>
        ${renderFPSGapNote(renderedAvg, displayedAvg)}
      </div>
    `;
  }).join('');

  summaryEl.innerHTML = cards;
}

function summaryMetric(label, value, unit = '') {
  return `
    <div class="stats-summary-metric">
      <span class="stats-summary-label">${label}</span>
      <span class="stats-summary-value">${value}${unit ? `<span class="stats-summary-unit"> ${unit}</span>` : ''}</span>
    </div>
  `;
}

/**
 * Describes the gap between rendered and displayed FPS, which flags GPU/driver
 * frame processing overhead rather than a CPU bottleneck.
 */
function renderFPSGapNote(renderedAvg, displayedAvg) {
  if (!Number.isFinite(renderedAvg) || !Number.isFinite(displayedAvg)) return '';

  const gap = renderedAvg - displayedAvg;
  let cls = 'neutral';
  let text = 'Rendered and displayed FPS are closely matched.';

  if (gap > 2) {
    cls = 'warn';
    text = `Rendered exceeds displayed by ${gap.toFixed(1)} FPS. Possible GPU/driver processing overhead.`;
  } else if (gap < -0.5) {
    cls = 'good';
    text = `Displayed exceeds rendered by ${Math.abs(gap).toFixed(1)} FPS.`;
  }

  return `<div class="stats-gap-note ${cls}">${text}</div>`;
}

const PERCENTILE_SUPPORT_DIAGNOSTICS = [
  { key: 'p1', label: '1%ile', fraction: 0.01 },
  { key: 'p01', label: '0.1%ile', fraction: 0.001 },
  { key: 'p001', label: '0.01%ile', fraction: 0.0001 },
  { key: 'low1', label: '1% Low', fraction: 0.01 },
  { key: 'low01', label: '0.1% Low', fraction: 0.001 },
  { key: 'low001', label: '0.01% Low', fraction: 0.0001 }
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
 * Computes the usual normal-approximation CI and a conservative AR(1)
 * effective-sample-size correction based on lag-1 autocorrelation.
 */
function calculateAutocorrelationCorrectedCI(values) {
  const series = (values || []).filter(Number.isFinite);
  const n = series.length;
  if (n < 2) return null;

  const mean = series.reduce((sum, value) => sum + value, 0) / n;
  const variance = series.reduce((sum, value) => {
    const diff = value - mean;
    return sum + diff * diff;
  }, 0) / (n - 1);
  const stdev = Math.sqrt(variance);
  const r1 = calculateLagAutocorrelation(series, 1);

  // Avoid a singular denominator at r1 = -1 while retaining the requested AR(1) formula.
  const boundedR1 = Number.isFinite(r1) ? Math.max(-0.99, Math.min(0.99, r1)) : 0;
  const rawEffectiveN = n * (1 - boundedR1) / (1 + boundedR1);
  // Preserve the requested AR(1) correction. Negative correlation can yield
  // n_eff > n; only clamp the lower bound to keep the interval finite.
  const effectiveN = Math.max(1, rawEffectiveN);
  const z95 = 1.96;
  const naiveMargin = z95 * stdev / Math.sqrt(n);
  const correctedMargin = z95 * stdev / Math.sqrt(effectiveN);

  return {
    n,
    mean,
    stdev,
    r1,
    effectiveN,
    naive: [mean - naiveMargin, mean + naiveMargin],
    corrected: [mean - correctedMargin, mean + correctedMargin]
  };
}

function getPercentileSupportStatus(expectedTailFrames) {
  if (expectedTailFrames >= 50) {
    return { label: 'Reliable', className: 'reliable' };
  }
  if (expectedTailFrames >= 30) {
    return { label: 'Low confidence', className: 'low-confidence' };
  }
  return { label: 'Insufficient', className: 'insufficient' };
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

function renderPercentileSupport(container, frameCount) {
  const section = makeDiagnosticsElement('section', 'stats-diagnostic-section');
  section.appendChild(makeDiagnosticsElement('h4', '', 'Percentile sample support'));

  const table = makeDiagnosticsElement('table', 'diag-table');
  const thead = document.createElement('thead');
  thead.innerHTML =
    '<tr><th scope="col">Percentile</th><th scope="col" class="diag-num">Tail frames</th><th scope="col">Status</th></tr>';
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  PERCENTILE_SUPPORT_DIAGNOSTICS.forEach(({ label, fraction }) => {
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

function formatMetricMean(mean, metric) {
  if (isFpsLikeMetric(metric || '')) {
    return `Mean: ${mean.toFixed(2)} FPS`;
  }
  if (!metric || metric === 'FrameTime' || /^Ms/i.test(metric) || /time|latency|ms/i.test(metric)) {
    return `Mean: ${mean.toFixed(3)} ms`;
  }
  return `Mean: ${mean.toFixed(3)}`;
}

function formatFrametimeInterval(interval) {
  return formatMetricInterval(interval, 'FrameTime');
}

function renderConfidenceIntervalDiagnostics(container, series, metric = 'FrameTime') {
  const section = makeDiagnosticsElement('section', 'stats-diagnostic-section');
  section.appendChild(makeDiagnosticsElement('h4', '', 'Mean (95% CI)'));

  const result = calculateAutocorrelationCorrectedCI(series);
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
    formatMetricMean(result.mean, metric)
  ));

  const ciGrid = makeDiagnosticsElement('div', 'stats-ci-grid');
  const naive = makeDiagnosticsElement('div', 'stats-ci-card');
  naive.append(
    makeDiagnosticsElement('span', 'stats-ci-label', 'raw'),
    makeDiagnosticsElement('strong', 'stats-ci-value', formatMetricInterval(result.naive, metric)),
    makeDiagnosticsElement('span', 'stats-ci-note', `n = ${result.n.toLocaleString()}`)
  );

  const corrected = makeDiagnosticsElement('div', 'stats-ci-card corrected');
  const nEff = Math.round(result.effectiveN);
  let correctedNote = `n_eff = ${nEff.toLocaleString()}`;
  let correctedLabel = 'Adjusted (lag-1)';
  if (result.effectiveN > result.n) {
    correctedNote += ' · n_eff > n (tighter)';
    corrected.title = 'Negative lag-1 raises n_eff above n, so this interval is tighter than raw.';
  } else if (result.effectiveN < result.n) {
    correctedNote += ' · n_eff < n (wider)';
    corrected.title = 'Positive lag-1 lowers n_eff, so this interval is wider than raw.';
  }

  corrected.append(
    makeDiagnosticsElement('span', 'stats-ci-label', correctedLabel),
    makeDiagnosticsElement('strong', 'stats-ci-value', formatMetricInterval(result.corrected, metric)),
    makeDiagnosticsElement('span', 'stats-ci-note', correctedNote)
  );

  ciGrid.append(naive, corrected);
  section.appendChild(ciGrid);
  container.appendChild(section);
}

function renderReliabilityDiagnostics(selectedDatasets, metric = 'FrameTime') {
  const content = document.getElementById('reliabilityDiagnosticsContent');
  if (!content) return;

  const metricLabel = typeof window.getMetricDisplayName === 'function'
    ? window.getMetricDisplayName(metric)
    : metric;

  content.innerHTML = '';

  const heading = document.getElementById('reliabilityDiagnosticsHeading')
    || document.querySelector('.reliability-diagnostics > h2');
  if (heading) {
    heading.textContent = `Dataset diagnostics (${metricLabel})`;
  }

  selectedDatasets.forEach((dataset, index) => {
    const series = typeof collectMetricValues === 'function'
      ? collectMetricValues(dataset, metric)
      : collectFrametimeSeries(dataset);
    const card = makeDiagnosticsElement('article', 'stats-diagnostics-card');
    card.style.setProperty('--stripe', getStatsDatasetColor(dataset, index));

    const header = makeDiagnosticsElement('header', 'stats-diagnostics-card-header');
    header.append(
      makeDiagnosticsElement('h3', '', dataset.name),
      makeDiagnosticsElement(
        'span',
        'stats-frame-count',
        `${series.length.toLocaleString()} samples`
      )
    );
    card.appendChild(header);

    if (series.length < 2) {
      card.appendChild(makeDiagnosticsElement(
        'p',
        'stats-diagnostic-explanation',
        'Need at least two samples.'
      ));
    } else {
      renderPercentileSupport(card, series.length);
      renderAutocorrelationDiagnostics(card, series);
      renderConfidenceIntervalDiagnostics(card, series, metric);
    }

    content.appendChild(card);
  });
}

let latestStatsExportState = null;

function getMetricExportUnit(metric) {
  if (metric === 'FPS' || metric === 'RenderedFPS' || metric === 'DisplayedFPS') return 'fps';
  if (metric === 'FrameTime' || /^Ms/i.test(metric)) return 'ms';
  if (metric.includes('Util')) return 'percent';
  return 'value';
}

function buildExportReliabilityDiagnostics(dataset, selectedStats, metric = 'FrameTime') {
  const series = collectMetricValues(dataset, metric);
  const lag1 = calculateLagAutocorrelation(series, 1);
  const confidenceInterval = calculateAutocorrelationCorrectedCI(series);
  const selectedStatSet = new Set(selectedStats);
  const percentileSupport = {};

  PERCENTILE_SUPPORT_DIAGNOSTICS.forEach(({ key, label, fraction }) => {
    if (!selectedStatSet.has(key)) return;
    const expectedFrames = series.length * fraction;
    const status = getPercentileSupportStatus(expectedFrames);
    percentileSupport[label] = {
      expectedTailFrameCount: expectedFrames,
      confidence: status.label
    };
  });

  return {
    basedOnMetric: typeof window.getMetricDisplayName === 'function'
      ? window.getMetricDisplayName(metric)
      : metric,
    validSampleCount: series.length,
    validFrametimeCount: series.length,
    lagOneAutocorrelationCoefficient: Number.isFinite(lag1) ? lag1 : null,
    autocorrelationInterpretation: interpretAutocorrelation(lag1),
    percentileSampleSupport: percentileSupport,
    autocorrelationCorrected95PercentConfidenceInterval: confidenceInterval
      ? {
          unit: getMetricExportUnit(metric),
          lower: confidenceInterval.corrected[0],
          upper: confidenceInterval.corrected[1],
          effectiveSampleSize: confidenceInterval.effectiveN
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
    statisticDescriptions[label] = getStatDescription(stat);
  });

  return {
    exportSource: 'Frame Timing Analyzer',
    generatedAt: state.generatedAt,
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
        name: entry.dataset.name,
        rowCount: entry.dataset.rows.length,
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
    lines.push(`- ${escapeMarkdown(entry.dataset.name)}: ${entry.dataset.rows.length.toLocaleString()} rows/frames`);
  });

  lines.push('', '## Statistics');
  const headers = ['Metric', ...state.datasets.map(entry => escapeMarkdown(entry.dataset.name))];
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
        return `${escapeMarkdown(statLabel)}: ${formatStatValue(metric, stat, value)}`;
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
    const description = getStatDescription(stat);
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
      `- **${escapeMarkdown(entry.dataset.name)}:** ${diagnostics.validSampleCount.toLocaleString()} valid ${escapeMarkdown(diagnostics.basedOnMetric)} samples; lag-1 autocorrelation ${lagText}. ${escapeMarkdown(diagnostics.autocorrelationInterpretation)}`
    );

    Object.entries(diagnostics.percentileSampleSupport).forEach(([label, support]) => {
      lines.push(
        `  - ${escapeMarkdown(label)} support: ${formatSupportCount(support.expectedTailFrameCount)} tail frames, ${support.confidence}.`
      );
    });
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

/**
 * Resets the Statistics panel to its empty state (used on clear-all).
 */
function resetStatsPanel() {
  const statsContent = document.getElementById('statistics');
  if (statsContent) statsContent.classList.add('empty-stats');

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

/**
 * Updates the Statistics table (#statsTable) by computing stats for each selected metric,
 * for all selected datasets in the statDatasetSelect dropdown.
 */
function updateStatsTable() {
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
  setStatsExportVisible(true);

  const exportState = {
    generatedAt: new Date().toISOString(),
    metrics: selectedMetrics.slice(),
    regularMetrics: regularMetrics.slice(),
    aggregateMetrics: aggregateMetrics.slice(),
    reliabilityMetric: document.getElementById('reliabilityMetricSelect')?.value || 'FrameTime',
    selectedStats: selectedStats.slice(),
    datasets: selectedDatasets.map(dataset => ({
      dataset,
      stats: {},
      reliabilityDiagnostics: null
    }))
  };

  const mainWrap = document.getElementById('statsMainTableWrap');
  const statsTable = document.getElementById('statsTable');
  const thead = statsTable.querySelector('thead');
  const tbody = statsTable.querySelector('tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  if (regularMetrics.length) {
    if (mainWrap) mainWrap.classList.remove('hidden');

    const headerRow = document.createElement('tr');
    headerRow.innerHTML = '<th class="stats-corner">Metric</th><th>Dataset</th>';
    selectedStats.forEach(stat => {
      headerRow.innerHTML += `<th>${getStatDisplayName(stat, regularMetrics)}</th>`;
    });
    thead.appendChild(headerRow);

    let rowIndex = 0;

    regularMetrics.forEach(metric => {
      const datasetStats = selectedDatasets.map((dataset, dsIdx) => {
        const values = collectMetricValues(dataset, metric);
        return {
          name: dataset.name,
          color: getStatsDatasetColor(dataset, dsIdx),
          stats: calculateStatistics(values, metric)
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
          const metricCell = document.createElement('td');
          metricCell.className = 'stats-metric-cell';
          metricCell.rowSpan = datasetStats.length;
          metricCell.textContent = metricLabel;
          metricCell.title = getMetricDisplayName(metric);
          row.appendChild(metricCell);
        }

        const nameCell = document.createElement('td');
        nameCell.className = 'dataset-name-cell stats-row-stripe';
        nameCell.style.setProperty('--stripe', dsStats.color || getDatasetColor(dsIndex));
        nameCell.textContent = dsStats.name;
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
            if (value === best) cell.classList.add('dataset-better-value');
            else if (value === worst) cell.classList.add('dataset-worse-value');
          }

          row.appendChild(cell);
        });

        tbody.appendChild(row);
      });
    });
  } else if (mainWrap) {
    mainWrap.classList.add('hidden');
  }

  renderAggregateStatsTable(aggregateMetrics, selectedDatasets, exportState);
  syncStatsTablesSeparation();

  try {
    exportState.datasets.forEach(entry => {
      entry.reliabilityDiagnostics = buildExportReliabilityDiagnostics(
        entry.dataset,
        selectedStats,
        exportState.reliabilityMetric
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
    divider.setAttribute('aria-hidden', bothVisible ? 'false' : 'true');
  }
}

function renderAggregateStatsTable(aggregateMetrics, selectedDatasets, exportState = null) {
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
  headerRow.innerHTML = '<th class="stats-corner">Metric</th>';
  selectedDatasets.forEach((ds, i) => {
    const th = document.createElement('th');
    th.className = 'stats-dataset-header';
    th.title = ds.name;
    th.innerHTML = `<span class="stats-header-stripe" style="--stripe:${getStatsDatasetColor(ds, i)}"></span><span class="stats-header-name">${ds.name}</span>`;
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

    const metricCell = document.createElement('td');
    metricCell.className = 'stats-metric-cell stats-aggregate-metric';
    metricCell.innerHTML = `<span class="stats-aggregate-name">${metricLabel}</span>${desc ? `<span class="stats-aggregate-hint">${desc}</span>` : ''}`;
    row.appendChild(metricCell);

    const values = selectedDatasets.map(ds =>
      calculateAggregateMetric(collectFrametimeSeries(ds), metric)
    );
    values.forEach((value, datasetIndex) => {
      if (!exportState?.datasets[datasetIndex]) return;
      exportState.datasets[datasetIndex].stats[metric] = {
        aggregateValue: value
      };
    });

    values.forEach((value, dsIndex) => {
      const cell = document.createElement('td');
      cell.className = 'stats-aggregate-value';
      cell.textContent = formatStatValue(metric, 'avg', value);

      if (selectedDatasets.length > 1 && Number.isFinite(value)) {
        const useLowerIsBetter = !['Skewness', 'Kurtosis', 'Nonparametric_Skew'].includes(metric);
        if (useLowerIsBetter) {
          const finite = values.filter(Number.isFinite);
          const best = Math.min(...finite);
          const worst = Math.max(...finite);
          if (value === best) cell.classList.add('dataset-better-value');
          else if (value === worst) cell.classList.add('dataset-worse-value');
        }
      }

      row.appendChild(cell);
    });

    tbody.appendChild(row);
  });
}

// Chart.js instance for statistics visualization
let statsChart = null;

/**
 * Visualizes selected statistics in a simple bar chart.
 * Uses the first enabled statistic across chosen metrics and datasets.
 */
function visualizeStatistics() {
  const container = document.getElementById('statsVisualizationContainer');
  const canvas = document.getElementById('statsChart');
  if (!container || !canvas) return;

  const datasetIndices = typeof window.getDatasetPickerIndices === 'function'
    ? window.getDatasetPickerIndices('statDatasetSelect')
    : [];
  if (!datasetIndices.length) {
    window.notify?.('Select datasets to visualize statistics', 'warning');
    return;
  }

  const metrics = Array.from(document.querySelectorAll('#statMetricsGroup .toggle-button.active')).map(btn => btn.dataset.metric);
  const stats = Array.from(document.querySelectorAll('#statsTypeGroup .toggle-button.active')).map(btn => btn.dataset.stat);

  if (!metrics.length || !stats.length) {
    window.notify?.('Select metrics and stats', 'warning');
    return;
  }

  const statKey = stats[0];
  const chartLabels = metrics.slice();
  const chartDatasets = datasetIndices.map((idx, i) => {
    const ds = window.allDatasets[idx];
    const data = metrics.map(metric => {
      const values = ds.rows.map(r => getMetricValue(r, metric)).filter(v => typeof v === 'number');
      const statObj = calculateStatistics(values, metric);
      return statObj[statKey];
    });
    const color = typeof randomColor === 'function' ? randomColor() : `hsl(${(i * 70) % 360},70%,50%)`;
    return { label: `${ds.name} (${statKey})`, data, backgroundColor: color };
  });

  container.classList.remove('hidden');

  if (statsChart) statsChart.destroy();

  statsChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: chartLabels,
      datasets: chartDatasets
    },
    options: {
      responsive: true,
      scales: {
        x: { title: { display: true, text: 'Metric' } },
        y: { title: { display: true, text: getStatDisplayName(statKey, metrics) } }
      }
    }
  });
}

/**
 * Returns a display name for a statistic key
 * @param {string} stat - Statistic key (e.g., 'avg', 'p1', 'stdev')
 * @returns {string} - Human readable name
 */
function getStatDisplayName(stat, metrics = []) {
  const displayNames = {
    'max': 'Maximum',
    'min': 'Minimum',
    'avg': getAverageDisplayLabel(metrics),
    'median': 'Median',
    'mode': 'Mode',
    'stdev': getStdevDisplayLabel(metrics),
    'p1': '1% Percentile',
    'p01': '0.1% Percentile',
    'p001': '0.01% Percentile',
    'low1': '1% Low',
    'low01': '0.1% Low',
    'low001': '0.01% Low'
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

function getStatDescription(stat) {
  const descriptions = {
    'avg': 'Mean value. Harmonic for FPS metrics, arithmetic for time-based metrics.',
    'median': 'Middle value after sorting the samples.',
    'mode': 'Most common value: peak of the density for continuous data (half-sample mode), not raw value frequency.',
    'stdev': 'Sample standard deviation around the arithmetic mean. Not paired with harmonic Avg on FPS.',
    'p1': 'Tail percentile cutoff for the worst 1% of samples.',
    'p01': 'Tail percentile cutoff for the worst 0.1% of samples.',
    'p001': 'Tail percentile cutoff for the worst 0.01% of samples.',
    'low1': 'Average of the worst 1% of samples.',
    'low01': 'Average of the worst 0.1% of samples.',
    'low001': 'Average of the worst 0.01% of samples.'
  };
  return descriptions[stat] || '';
}

// Expose these to the global scope:
window.collectMetricValues = collectMetricValues;
window.getMetricValue = getMetricValue;
window.calculateStepwiseRelativeSD = calculateStepwiseRelativeSD;
window.calculateCoefficientOfVariation = calculateCoefficientOfVariation;
window.calculateRMSSD = calculateRMSSD;
window.calculateDistributionShape = calculateDistributionShape;
window.calculateStatistics = calculateStatistics;
window.calculatePercentile = calculatePercentile;
window.calculateMode = calculateMode;
window.calculateLagAutocorrelation = calculateLagAutocorrelation;
window.calculateAutocorrelationCorrectedCI = calculateAutocorrelationCorrectedCI;
window.renderReliabilityDiagnostics = renderReliabilityDiagnostics;
window.updateStatsTable = updateStatsTable;
window.resetStatsPanel = resetStatsPanel;
window.formatStatValue = formatStatValue;
window.getDatasetColor = getDatasetColor;
window.visualizeStatistics = visualizeStatistics;
window.getStatDisplayName = getStatDisplayName;
window.getStatDescription = getStatDescription;
window.updateStatsAverageLabel = updateStatsAverageLabel;
window.buildStatsMarkdownExport = buildStatsMarkdownExport;
window.buildStatsJsonExport = buildStatsJsonExport;
window.copyStatsAsMarkdown = copyStatsAsMarkdown;
window.downloadStatsAsJson = downloadStatsAsJson;
