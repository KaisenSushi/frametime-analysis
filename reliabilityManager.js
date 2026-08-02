let reliabilityChart = null;

function getReliabilityDatasetLabel(dataset) {
  return window.getDatasetDisplayName?.(dataset) || dataset?.displayName || dataset?.name || 'Dataset';
}
let reliabilityRenderToken = 0;
let reliabilityWorker = null;
let reliabilityWorkerUrl = null;
let reliabilityWorkerRequestId = 0;
const reliabilityWorkerRequests = new Map();

function makeReliabilityAbortError(message = 'Reliability calculation was replaced by a newer request.') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function compactReliabilityLabel(value, maxLength = 52) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  const left = Math.ceil((maxLength - 1) * 0.62);
  const right = Math.max(5, maxLength - 1 - left);
  return `${text.slice(0, left)}…${text.slice(-right)}`;
}

function generateReliabilityLegendLabels(chart) {
  const generator = Chart.defaults?.plugins?.legend?.labels?.generateLabels;
  const labels = typeof generator === 'function' ? generator(chart) : [];
  return labels.map(item => ({ ...item, text: compactReliabilityLabel(item.text, 56) }));
}

function getReliabilityThemeColors() {
  const root = getComputedStyle(document.documentElement);
  const read = (name, fallback) => root.getPropertyValue(name).trim() || fallback;
  return {
    text: read('--chart-text', 'rgba(245,245,245,0.9)'),
    grid: read('--chart-grid', 'rgba(255,255,255,0.16)'),
    border: read('--chart-border', 'rgba(255,255,255,0.28)'),
    tooltipBg: read('--chart-tooltip-bg', 'rgba(10,10,10,0.96)'),
    tooltipTitle: read('--chart-tooltip-title', 'rgba(245,245,245,0.95)'),
    tooltipBody: read('--chart-tooltip-body', 'rgba(245,245,245,0.88)')
  };
}

function buildEmpiricalCdf(values, maxPoints = 5000) {
  const sorted = (values || [])
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const n = sorted.length;
  if (!n) return [];

  if (n <= maxPoints) {
    return sorted.map((value, index) => ({
      x: value,
      y: (index + 1) / n
    }));
  }

  const points = [];
  let previousIndex = -1;
  for (let i = 0; i < maxPoints; i++) {
    const index = Math.round(i * (n - 1) / (maxPoints - 1));
    if (index === previousIndex) continue;
    points.push({
      x: sorted[index],
      y: (index + 1) / n
    });
    previousIndex = index;
  }
  return points;
}

function getReliabilityWorkerSource() {
  return `
    ${buildEmpiricalCdf.toString()}
    self.onmessage = function (event) {
      const { id, items, maxPoints } = event.data || {};
      try {
        const results = (items || []).map(item => ({
          key: item.key,
          points: buildEmpiricalCdf(item.values || [], maxPoints || 5000)
        }));
        self.postMessage({ id, results });
      } catch (error) {
        self.postMessage({ id, error: error && error.message ? error.message : String(error) });
      }
    };
  `;
}

function resetReliabilityWorker(error = null) {
  if (reliabilityWorker) reliabilityWorker.terminate();
  if (reliabilityWorkerUrl) URL.revokeObjectURL(reliabilityWorkerUrl);
  reliabilityWorker = null;
  reliabilityWorkerUrl = null;
  if (error) {
    reliabilityWorkerRequests.forEach(({ reject }) => reject(error));
    reliabilityWorkerRequests.clear();
  }
}

function getReliabilityWorker() {
  if (reliabilityWorker) return reliabilityWorker;
  if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') {
    return null;
  }

  reliabilityWorkerUrl = URL.createObjectURL(new Blob([getReliabilityWorkerSource()], { type: 'text/javascript' }));
  reliabilityWorker = new Worker(reliabilityWorkerUrl);
  reliabilityWorker.onmessage = event => {
    const { id, results, error } = event.data || {};
    const request = reliabilityWorkerRequests.get(id);
    if (!request) return;
    reliabilityWorkerRequests.delete(id);
    if (error) request.reject(new Error(error));
    else request.resolve(results || []);
  };
  reliabilityWorker.onerror = event => {
    resetReliabilityWorker(new Error(event.message || 'The reliability worker failed.'));
  };
  return reliabilityWorker;
}

async function calculateCdfBatch(items, maxPoints = 5000) {
  const worker = getReliabilityWorker();
  if (!worker) {
    const results = [];
    for (const item of items) {
      results.push({ key: item.key, points: buildEmpiricalCdf(item.values, maxPoints) });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return results;
  }

  const id = ++reliabilityWorkerRequestId;
  return new Promise((resolve, reject) => {
    reliabilityWorkerRequests.set(id, { resolve, reject });
    worker.postMessage({ id, items, maxPoints });
  });
}

function getReliabilityMetricLabel(metric) {
  return typeof window.getMetricDisplayName === 'function'
    ? window.getMetricDisplayName(metric)
    : metric;
}

function getReliabilityDatasetColor(dataset, index) {
  if (dataset?.color) return dataset.color;
  const globalIndex = (window.allDatasets || []).findIndex(ds =>
    (dataset?.id != null && ds.id === dataset.id) || ds.name === dataset.name
  );
  const colorIndex = globalIndex >= 0 ? globalIndex : index;
  if (typeof window.getBenchmarkColor === 'function') {
    return window.getBenchmarkColor(colorIndex);
  }
  if (typeof window.getDatasetColor === 'function') {
    return window.getDatasetColor(colorIndex);
  }
  return `hsl(${(colorIndex * 67) % 360}, 70%, 55%)`;
}

function collectReliabilityMetricValues(dataset, metric) {
  if (typeof window.collectMetricValues === 'function') {
    return window.collectMetricValues(dataset, metric);
  }
  return (dataset?.rows || [])
    .map(row => window.getMetricValue?.(row, metric))
    .filter(Number.isFinite);
}

function getSelectedReliabilityDatasets() {
  const all = window.allDatasets || [];
  const indices = typeof window.getDatasetPickerIndices === 'function'
    ? window.getDatasetPickerIndices('reliabilityDatasetSelect')
    : [];
  if (!indices.length) return [];

  return indices
    .filter(i => Number.isInteger(i) && i >= 0 && i < all.length)
    .map(i => all[i]);
}

function setReliabilitySkipNotice(message) {
  const element = document.getElementById('reliabilitySkipNotice');
  if (!element) return;
  element.textContent = message || '';
  element.classList.toggle('hidden', !message);
}

function setReliabilityUpdateStatus(message, type = 'info') {
  const element = document.getElementById('reliabilityUpdateStatus');
  if (!element) return;
  element.textContent = message || '';
  element.dataset.type = type;
  element.classList.toggle('hidden', !message);
}

function destroyReliabilityChart() {
  const canvas = document.getElementById('reliabilityChart');
  const existing = canvas ? window.Chart?.getChart?.(canvas) : null;
  if (existing && existing !== reliabilityChart) {
    try { existing.destroy(); } catch (_) {}
  }
  if (reliabilityChart) {
    try { reliabilityChart.destroy(); } catch (_) {}
    reliabilityChart = null;
  }
}

function renderReliabilityCdfResults(datasets, metric, cdfResults) {
  const canvas = document.getElementById('reliabilityChart');
  const container = document.getElementById('reliabilityChartContainer');
  if (!canvas || !container) return;

  destroyReliabilityChart();

  if (!window.Chart) {
    container.classList.add('empty');
    canvas.setAttribute('aria-hidden', 'true');
    setReliabilitySkipNotice('Chart.js did not load, so the CDF overlay is unavailable.');
    throw new Error('Chart.js is unavailable.');
  }

  const byKey = new Map((cdfResults || []).map(result => [String(result.key), result.points || []]));
  const skipped = [];
  const chartDatasets = [];

  datasets.forEach((dataset, index) => {
    const key = String(dataset.id ?? index);
    const cdf = byKey.get(key) || [];
    if (!cdf.length) {
      skipped.push(getReliabilityDatasetLabel(dataset));
      return;
    }
    const color = getReliabilityDatasetColor(dataset, index);
    chartDatasets.push({
      label: getReliabilityDatasetLabel(dataset),
      data: cdf,
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 3,
      showLine: true,
      stepped: 'after'
    });
  });

  const metricLabel = getReliabilityMetricLabel(metric);
  setReliabilitySkipNotice(skipped.length
    ? `Skipped (no finite ${metricLabel} values): ${skipped.join(', ')}`
    : '');

  const isEmpty = chartDatasets.length === 0;
  container.classList.toggle('empty', isEmpty);
  canvas.setAttribute('aria-hidden', String(isEmpty));
  if (isEmpty) {
    canvas.setAttribute('aria-label', 'Reliability cumulative distribution chart. Select datasets with finite values to compare runs.');
    const emptyMessage = container.querySelector('.empty-chart-message p');
    if (emptyMessage) {
      emptyMessage.textContent = datasets.length
        ? `No finite ${metricLabel} values in the selected datasets`
        : 'Select datasets, then update reliability.';
    }
    return;
  }

  const theme = getReliabilityThemeColors();
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The reliability chart canvas is unavailable.');

  reliabilityChart = new window.Chart(context, {
    type: 'line',
    data: { datasets: chartDatasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      interaction: {
        mode: 'nearest',
        intersect: false
      },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            color: theme.text,
            usePointStyle: true,
            pointStyle: 'line',
            generateLabels: generateReliabilityLegendLabels
          }
        },
        tooltip: {
          enabled: false,
          backgroundColor: theme.tooltipBg,
          titleColor: theme.tooltipTitle,
          bodyColor: theme.tooltipBody,
          borderColor: theme.border,
          borderWidth: 1,
          callbacks: {
            label(context) {
              const point = context.parsed;
              return `${context.dataset.label}: ${point.x.toFixed(3)} (${(point.y * 100).toFixed(2)}%)`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: {
            display: true,
            text: metricLabel,
            color: theme.text
          },
          ticks: { color: theme.text },
          border: { color: theme.border },
          grid: { color: theme.grid }
        },
        y: {
          min: 0,
          max: 1,
          title: {
            display: true,
            text: 'Cumulative share',
            color: theme.text
          },
          ticks: {
            color: theme.text,
            callback: value => `${Math.round(value * 100)}%`
          },
          border: { color: theme.border },
          grid: { color: theme.grid }
        }
      }
    }
  });

  canvas.setAttribute(
    'aria-label',
    `Reliability cumulative distribution chart for ${metricLabel}. ${chartDatasets.length} datasets shown.`
  );
}

async function renderReliabilityPage() {
  const token = ++reliabilityRenderToken;
  resetReliabilityWorker(makeReliabilityAbortError());

  const diagnostics = document.getElementById('reliabilityDiagnosticsContent');
  if (diagnostics) {
    diagnostics.dataset.renderToken = String((Number(diagnostics.dataset.renderToken) || 0) + 1);
  }

  const datasets = getSelectedReliabilityDatasets();
  const metricSelect = document.getElementById('reliabilityMetricSelect');
  const metric = metricSelect?.value || 'RenderedFPS';
  if (!datasets.length) {
    setReliabilityUpdateStatus('Select at least one dataset.', 'warning');
    window.notify?.('Select at least one dataset to update reliability.', 'warning');
    return { ok: false, reason: 'no-datasets' };
  }
  if (!metric) {
    setReliabilityUpdateStatus('Select a metric.', 'warning');
    window.notify?.('Select a metric to update reliability.', 'warning');
    return { ok: false, reason: 'no-metric' };
  }

  setReliabilityUpdateStatus('Preparing selected metric series…');
  const seriesByDataset = new Map();
  const items = [];
  for (let index = 0; index < datasets.length; index++) {
    if (token !== reliabilityRenderToken) throw makeReliabilityAbortError();
    const dataset = datasets[index];
    const values = collectReliabilityMetricValues(dataset, metric);
    seriesByDataset.set(String(dataset.id ?? index), values);
    items.push({ key: String(dataset.id ?? index), values });
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  setReliabilityUpdateStatus('Building distribution overlay and bootstrap diagnostics…');
  try {
    const cdfPromise = calculateCdfBatch(items);
    const diagnosticsPromise = window.renderReliabilityDiagnostics?.(datasets, metric, seriesByDataset);
    const [cdfResults] = await Promise.all([cdfPromise, diagnosticsPromise]);
    if (token !== reliabilityRenderToken) throw makeReliabilityAbortError();

    renderReliabilityCdfResults(datasets, metric, cdfResults);
    setReliabilityUpdateStatus(
      `Reliability updated for ${datasets.length} ${datasets.length === 1 ? 'dataset' : 'datasets'}.`,
      'success'
    );
    return { ok: true, datasets: datasets.length, metric };
  } catch (error) {
    if (error?.name === 'AbortError' || token !== reliabilityRenderToken) {
      return { ok: false, stale: true };
    }
    console.error('Reliability update failed:', error);
    setReliabilityUpdateStatus(`Update failed: ${error.message}`, 'error');
    throw error;
  }
}

function resetReliabilityPanel({ keepStatus = false } = {}) {
  reliabilityRenderToken++;
  resetReliabilityWorker(makeReliabilityAbortError());
  destroyReliabilityChart();

  document.getElementById('reliabilityChartContainer')?.classList.add('empty');
  document.getElementById('reliabilityChart')
    ?.setAttribute('aria-label', 'Reliability cumulative distribution chart. Select datasets to compare runs.');
  setReliabilitySkipNotice('');
  const diagnostics = document.getElementById('reliabilityDiagnosticsContent');
  if (diagnostics) {
    diagnostics.dataset.renderToken = String((Number(diagnostics.dataset.renderToken) || 0) + 1);
    diagnostics.innerHTML = '';
  }
  const heading = document.getElementById('reliabilityDiagnosticsHeading');
  if (heading) heading.textContent = 'Dataset diagnostics';
  if (!keepStatus) setReliabilityUpdateStatus('');
}

function markReliabilityStale(message = 'Selection changed. Update reliability to refresh the results.') {
  resetReliabilityPanel({ keepStatus: true });
  setReliabilityUpdateStatus(message, 'info');
}

function exportReliabilityChartPng() {
  window.exportChartPng?.(reliabilityChart, 'reliability-cdf');
}

function refreshReliabilityTheme() {
  if (!reliabilityChart) return;
  const theme = getReliabilityThemeColors();
  const legend = reliabilityChart.options.plugins?.legend?.labels;
  if (legend) legend.color = theme.text;
  if (reliabilityChart.options.plugins?.tooltip) {
    reliabilityChart.options.plugins.tooltip.backgroundColor = theme.tooltipBg;
    reliabilityChart.options.plugins.tooltip.titleColor = theme.tooltipTitle;
    reliabilityChart.options.plugins.tooltip.bodyColor = theme.tooltipBody;
    reliabilityChart.options.plugins.tooltip.borderColor = theme.border;
  }
  Object.values(reliabilityChart.options.scales || {}).forEach(scale => {
    if (scale.grid) scale.grid.color = theme.grid;
    if (scale.ticks) scale.ticks.color = theme.text;
    if (scale.title) scale.title.color = theme.text;
    if (scale.border) scale.border.color = theme.border;
  });
  reliabilityChart.update('none');
}

window.buildEmpiricalCdf = buildEmpiricalCdf;
window.renderReliabilityPage = renderReliabilityPage;
window.resetReliabilityPanel = resetReliabilityPanel;
window.markReliabilityStale = markReliabilityStale;
window.exportReliabilityChartPng = exportReliabilityChartPng;
window.refreshReliabilityTheme = refreshReliabilityTheme;
