let reliabilityChart = null;

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
  const el = document.getElementById('reliabilitySkipNotice');
  if (!el) return;
  if (!message) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  el.textContent = message;
  el.classList.remove('hidden');
}

function renderReliabilityCdf(datasets, metric) {
  const canvas = document.getElementById('reliabilityChart');
  const container = document.getElementById('reliabilityChartContainer');
  if (!canvas || !container) return;

  const skipped = [];
  const chartDatasets = [];

  datasets.forEach((dataset, index) => {
    const values = collectReliabilityMetricValues(dataset, metric);
    const cdf = buildEmpiricalCdf(values);
    if (!cdf.length) {
      skipped.push(dataset.name);
      return;
    }
    const color = getReliabilityDatasetColor(dataset, index);
    chartDatasets.push({
      label: dataset.name,
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

  if (reliabilityChart) {
    reliabilityChart.destroy();
    reliabilityChart = null;
  }

  const metricLabel = getReliabilityMetricLabel(metric);
  if (skipped.length) {
    setReliabilitySkipNotice(
      `Skipped (no finite ${metricLabel} values): ${skipped.join(', ')}`
    );
  } else {
    setReliabilitySkipNotice('');
  }

  const isEmpty = chartDatasets.length === 0;
  container.classList.toggle('empty', isEmpty);
  if (isEmpty) {
    const emptyMsg = container.querySelector('.empty-chart-message p');
    if (emptyMsg) {
      emptyMsg.textContent = datasets.length
        ? `No finite ${metricLabel} values in the selected datasets`
        : 'Select datasets in the sidebar to compare reliability';
    }
    return;
  }

  reliabilityChart = new Chart(canvas.getContext('2d'), {
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
            usePointStyle: true,
            pointStyle: 'line'
          }
        },
        tooltip: {
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
            text: metricLabel
          },
          grid: {
            color: 'rgba(70,70,70,0.45)'
          }
        },
        y: {
          min: 0,
          max: 1,
          title: {
            display: true,
            text: 'Cumulative share'
          },
          ticks: {
            callback: value => `${Math.round(value * 100)}%`
          },
          grid: {
            color: 'rgba(70,70,70,0.45)'
          }
        }
      }
    }
  });
}

function renderReliabilityPage() {
  const datasets = getSelectedReliabilityDatasets();
  const metricSelect = document.getElementById('reliabilityMetricSelect');
  const metric = metricSelect?.value || 'FrameTime';

  renderReliabilityCdf(datasets, metric);
  window.renderReliabilityDiagnostics?.(datasets, metric);
}

function resetReliabilityPanel() {
  if (reliabilityChart) {
    reliabilityChart.destroy();
    reliabilityChart = null;
  }

  document.getElementById('reliabilityChartContainer')?.classList.add('empty');
  setReliabilitySkipNotice('');
  const diagnostics = document.getElementById('reliabilityDiagnosticsContent');
  if (diagnostics) diagnostics.innerHTML = '';
  const heading = document.getElementById('reliabilityDiagnosticsHeading');
  if (heading) heading.textContent = 'Dataset diagnostics';
}

window.buildEmpiricalCdf = buildEmpiricalCdf;
window.renderReliabilityPage = renderReliabilityPage;
window.resetReliabilityPanel = resetReliabilityPanel;
