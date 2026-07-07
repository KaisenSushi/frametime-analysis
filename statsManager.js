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
 * Stepwise Relative SD — measures frame-to-frame relative variability.
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

// Palette used to give each dataset a stable colour stripe in the stats table.
const STATS_DATASET_COLORS = [
  '#4bc0c0', '#c084fc', '#f97316', '#38bdf8', '#f472b6',
  '#a3e635', '#fbbf24', '#818cf8', '#2dd4bf', '#fb7185'
];

function getDatasetColor(index) {
  return STATS_DATASET_COLORS[index % STATS_DATASET_COLORS.length];
}

// Stepwise Relative SD is a single aggregate; other metrics vary per stat column.
function isAggregateMetric(metric) {
  return metric === 'Stepwise_Relative_SD';
}

function isFpsLikeMetric(metric) {
  return metric === 'FPS' ||
         metric === 'RenderedFPS' ||
         metric === 'DisplayedFPS' ||
         metric.toLowerCase().includes('fps');
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
  if (metric === 'Stepwise_Relative_SD') return value.toFixed(4);
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

  // GPU busy time — critical for input lag even when FPS looks fine
  if (metric === 'MsGPUBusy') {
    return findNumericKey(row, 'MsGPUBusy', 'GPUBusy', 'MsGpuBusy');
  }

  // Time from CPU frame completion to display output
  if (metric === 'MsUntilDisplayed') {
    return findNumericKey(row, 'MsUntilDisplayed', 'MsUntilDisplayComplete');
  }

  // Aggregate-only metric — not meaningful per row
  if (metric === 'Stepwise_Relative_SD') {
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

function percentileNearestRank(sortedAsc, p) {
  if (!sortedAsc.length) return NaN;
  const rank = Math.ceil((p / 100) * sortedAsc.length) - 1;   // 0‑based
  return sortedAsc[Math.max(0, Math.min(rank, sortedAsc.length - 1))];
}

function calculateStatistics(arr, metricName = '') {
  if (!arr.length) {
    return {
      max: NaN, min: NaN, avg: NaN, stdev: NaN,
      p1: NaN, p01: NaN, p001: NaN,
      low1: NaN, low01: NaN, low001: NaN
    };
  }

  // Stepwise Relative SD is a single aggregate over the full series
  if (metricName === 'Stepwise_Relative_SD') {
    const srsd = calculateStepwiseRelativeSD(arr);
    return {
      max: srsd, min: srsd, avg: srsd, stdev: 0,
      p1: srsd, p01: srsd, p001: srsd,
      low1: srsd, low01: srsd, low001: srsd
    };
  }

  /* -------- basic aggregates --------------------------------------- */
  const sorted = [...arr].sort((a, b) => a - b);  // ascending
  const n      = sorted.length;
  const maxVal = sorted[n - 1];
  const minVal = sorted[0];
  const sum    = sorted.reduce((a, b) => a + b, 0);

  /* -------- determine FPS vs Frame‑time ---------------------------- */
  let isFpsMetric =
        metricName.toUpperCase() === 'FPS' ||
        metricName === 'RenderedFPS' ||
        metricName === 'DisplayedFPS' ||
        metricName.toLowerCase().includes('fps');
  if (!metricName && sum / n > 30 && minVal > 20) isFpsMetric = true;

  // FPS metrics use the harmonic mean; everything else uses the arithmetic mean.
  const avg = isFpsMetric
      ? n / sorted.reduce((s, v) => s + 1 / v, 0)   // harmonic mean
      : sum / n;

  const stdev = (typeof jStat?.stdev === 'function')
      ? jStat.stdev(sorted, true)
      : Math.sqrt(sorted.reduce((s, v) => s + (v - avg) ** 2, 0) / (n - 1));

  /* -------- percentiles (single‑frame cut‑off) --------------------- */
  const p1   = percentileNearestRank(sorted,  isFpsMetric ? 1     : 99);
  const p01  = percentileNearestRank(sorted,  isFpsMetric ? 0.1   : 99.9);
  const p001 = percentileNearestRank(sorted,  isFpsMetric ? 0.01  : 99.99);

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
    stdev,
    p1,  p01,  p001,
    low1, low01, low001
  };
}



function calculatePercentile(sortedArr, percentile) {
  // percentile expressed as 1 → 1 %, 0.1 → 0.1 %
  if (!sortedArr.length) return NaN;

  const idx = (percentile / 100) * (sortedArr.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.min(sortedArr.length - 1, Math.ceil(idx));

  if (lower === upper) return sortedArr[lower];

  const w = idx - lower;               // linear interpolation weight
  return sortedArr[lower] * (1 - w) + sortedArr[upper] * w;
}

/**
 * Analyzes stuttering frames, defining a stutter as a frame 1.5x longer than median.
 * Returns the total stutter count, % of total, and avg severity beyond threshold.
 * @param {number[]} frametimes
 * @returns {{count:number, percentage:number, severity:number}}
 */
function analyzeStuttering(frametimes) {
  if (!frametimes.length) {
    return { count: 0, percentage: 0, severity: 0 };
  }
  const sorted = [...frametimes].sort((a, b) => a - b);
  const median = calculatePercentile(sorted, 50);
  const stutterThreshold = median * 1.5;

  let stutterCount = 0;
  let totalSeverity = 0;

  frametimes.forEach(ft => {
    if (ft > stutterThreshold) {
      stutterCount++;
      totalSeverity += (ft - stutterThreshold) / median;
    }
  });

  return {
    count: stutterCount,
    percentage: (stutterCount / frametimes.length) * 100,
    severity: stutterCount > 0 ? (totalSeverity / stutterCount) : 0
  };
}

/**
 * Analyzes frame pacing in a general, robust way using median-based statistics.
 * Works reliably across any framerate (30, 60, 144, 250, etc.) without bias.
 * 
 * @param {number[]} frametimes - Array of per-frame durations (ms)
 * @returns {{consistency:number, medianFrametime:number, madFrametime:number, 
 *            medianTransition:number, madTransition:number, badTransitions:Array}}
 */
function analyzeFramePacing(frametimes) {
  if (frametimes.length < 3) {
    return {
      consistency: 0,
      medianFrametime: 0,
      madFrametime: 0,
      medianTransition: 0, 
      madTransition: 0,
      stdevTransition: 0, // keep for backward compatibility
      avgTransition: 0,   // keep for backward compatibility
      badTransitions: []
    };
  }

  // 1. Calculate median frametime (robust measure of "typical" performance)
  const sorted = [...frametimes].sort((a, b) => a - b);
  const medianFT = calculatePercentile(sorted, 50);

  // 2. Compute relative deviations: (|t - median| / median)
  const relDeviations = frametimes.map(t => Math.abs(t - medianFT) / medianFT);

  // 3. Get the median of these relative deviations
  const medianRelDev = calculatePercentile([...relDeviations].sort((a, b) => a - b), 50);

  // 4. Calculate MAD of the raw frametimes
  const absDeviationsFromMedian = frametimes.map(t => Math.abs(t - medianFT));
  const sortedDevs = [...absDeviationsFromMedian].sort((a, b) => a - b);
  const madFT = calculatePercentile(sortedDevs, 50);

  // 5. Compute consecutive diffs, then median + MAD for transitions
  const diffs = [];
  for (let i = 1; i < frametimes.length; i++) {
    diffs.push(Math.abs(frametimes[i] - frametimes[i - 1]));
  }
  
  const sortedDiffs = [...diffs].sort((a, b) => a - b);
  const medianDiff = calculatePercentile(sortedDiffs, 50);
  
  const absDeviationsDiff = diffs.map(d => Math.abs(d - medianDiff));
  const sortedDiffDevs = [...absDeviationsDiff].sort((a, b) => a - b);
  const madDiff = calculatePercentile(sortedDiffDevs, 50);

  // Also calculate standard stats for backward compatibility
  const avgDiff = (typeof jStat !== 'undefined' && typeof jStat.mean === 'function')
    ? jStat.mean(diffs)
    : diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const stdevDiff = (typeof jStat !== 'undefined' && typeof jStat.stdev === 'function')
    ? jStat.stdev(diffs, true)
    : Math.sqrt(diffs.reduce((s, v) => s + (v - avgDiff) ** 2, 0) / (diffs.length - 1));

  // 6. Define consistency as a function of medianRelDev
  // Tuned with alpha parameter for sensitivity
  const alpha = 3.0; 
  let consistency = 100 * (1 - Math.min(1, alpha * medianRelDev));
  consistency = Math.max(0, Math.min(100, consistency)); // clamp to [0, 100]

  // 7. Identify large transitions if diff is > K * medianDiff
  const K = 2.5;
  const badTransitions = [];
  diffs.forEach((diff, i) => {
    if (diff > K * medianDiff) {
      badTransitions.push({
        index: i + 1,  // i+1 -> transition from frame i to frame i+1
        value: diff,
        ratio: diff / medianDiff  // keep same property name for compatibility
      });
    }
  });

  return {
    consistency: Math.round(consistency * 100) / 100, // round to 2 decimal places
    medianFrametime: medianFT,
    madFrametime: madFT,
    medianTransition: medianDiff,
    madTransition: madDiff,
    avgTransition: avgDiff,      // keep for backward compatibility
    stdevTransition: stdevDiff,  // keep for backward compatibility
    badTransitions
  };
}

/**
 * Collects the numeric series used to compute stats for a metric on a dataset.
 * Stepwise Relative SD is derived from the frametime series.
 */
function collectMetricValues(dataset, metric) {
  if (metric === 'Stepwise_Relative_SD') {
    return dataset.rows
      .map(r => getMetricValue(r, 'FrameTime'))
      .filter(v => typeof v === 'number' && v > 0);
  }
  return dataset.rows
    .map(r => getMetricValue(r, metric))
    .filter(v => typeof v === 'number');
}

/**
 * Returns the harmonic mean for FPS metrics, arithmetic mean otherwise.
 */
function averageForMetric(values, metric) {
  if (!values.length) return NaN;
  if (isFpsLikeMetric(metric)) {
    return values.length / values.reduce((s, v) => s + 1 / v, 0);
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

    const color = getDatasetColor(index);

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
    text = `Rendered exceeds displayed by ${gap.toFixed(1)} FPS — possible GPU/driver processing overhead.`;
  } else if (gap < -0.5) {
    cls = 'good';
    text = `Displayed exceeds rendered by ${Math.abs(gap).toFixed(1)} FPS.`;
  }

  return `<div class="stats-gap-note ${cls}">${text}</div>`;
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
}

/**
 * Updates the Statistics table (#statsTable) by computing stats for each selected metric,
 * for all selected datasets in the statDatasetSelect dropdown.
 */
function updateStatsTable() {
  const statsContent = document.getElementById('statistics');
  const statDatasetSelect = document.getElementById('statDatasetSelect');
  const selectedDatasetIndices = Array.from(statDatasetSelect.selectedOptions).map(opt => parseInt(opt.value));

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
  if (!selectedStats.length) {
    window.notify?.('Select at least one statistic.', 'warning');
    resetStatsPanel();
    return;
  }

  statsContent.classList.remove('empty-stats');

  const statsTable = document.getElementById('statsTable');
  const thead = statsTable.querySelector('thead');
  const tbody = statsTable.querySelector('tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  // Flat table: one row per metric × dataset — no section headers or spacers.
  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th class="stats-corner">Metric</th><th>Dataset</th>';
  selectedStats.forEach(stat => {
    headerRow.innerHTML += `<th>${getStatDisplayName(stat)}</th>`;
  });
  thead.appendChild(headerRow);

  let rowIndex = 0;

  selectedMetrics.forEach(metric => {
    const aggregate = isAggregateMetric(metric);
    const datasetStats = selectedDatasets.map(dataset => ({
      name: dataset.name,
      stats: calculateStatistics(collectMetricValues(dataset, metric), metric)
    }));
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
      nameCell.style.setProperty('--stripe', getDatasetColor(dsIndex));
      nameCell.textContent = dsStats.name;
      row.appendChild(nameCell);

      if (aggregate) {
        selectedStats.forEach((stat, statIndex) => {
          const cell = document.createElement('td');
          if (statIndex === 0) {
            cell.textContent = formatStatValue(metric, 'avg', dsStats.stats.avg);
          } else {
            cell.textContent = '—';
            cell.classList.add('stats-na-cell');
          }
          row.appendChild(cell);
        });
      } else {
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
      }

      tbody.appendChild(row);
    });
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

  const statDatasetSelect = document.getElementById('statDatasetSelect');
  const datasetIndices = Array.from(statDatasetSelect.selectedOptions).map(opt => parseInt(opt.value));
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
        y: { title: { display: true, text: getStatDisplayName(statKey) } }
      }
    }
  });
}

/**
 * Returns a display name for a statistic key
 * @param {string} stat - Statistic key (e.g., 'avg', 'p1', 'stdev')
 * @returns {string} - Human readable name
 */
function getStatDisplayName(stat) {
  const displayNames = {
    'max': 'Maximum',
    'min': 'Minimum',
    'avg': 'Average',
    'stdev': 'Std Deviation',
    'p1': '1% Percentile',
    'p01': '0.1% Percentile',
    'p001': '0.01% Percentile',
    'low1': '1% Low',
    'low01': '0.1% Low',
    'low001': '0.01% Low'
  };
  
  return displayNames[stat] || stat;
}

// Expose these to the global scope:
window.getMetricValue = getMetricValue;
window.calculateStepwiseRelativeSD = calculateStepwiseRelativeSD;
window.calculateStatistics = calculateStatistics;
window.calculatePercentile = calculatePercentile;
window.analyzeStuttering = analyzeStuttering;
window.analyzeFramePacing = analyzeFramePacing;
window.updateStatsTable = updateStatsTable;
window.resetStatsPanel = resetStatsPanel;
window.formatStatValue = formatStatValue;
window.getDatasetColor = getDatasetColor;
window.visualizeStatistics = visualizeStatistics;
window.getStatDisplayName = getStatDisplayName;
