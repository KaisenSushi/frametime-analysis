document.addEventListener('DOMContentLoaded', () => {
  updateMetricDropdowns();

  const histogramAsPercentChk = document.getElementById('histogramAsPercent');
  if (histogramAsPercentChk) {
    histogramAsPercentChk.addEventListener('change', () => {
      if (window.mainChart &&
          window.currentChartType === 'histogram' &&
          typeof window.rebuildCurrentHistogramDatasets === 'function') {
        window.rebuildCurrentHistogramDatasets();
        window.renderChart('histogram', { incremental: true });
      }
    });
  }

  // Advanced metrics toggle (shared across all tabs via sidebar footer)
  const advBtn = document.getElementById('toggleAdvancedBtn');
  if (advBtn) {
    advBtn.addEventListener('click', () => {
      window.showAdvancedMetrics = !window.showAdvancedMetrics;
      advBtn.textContent = window.showAdvancedMetrics ? 'Advanced metrics ON' : 'Advanced metrics OFF';
      updateMetricDropdowns();
    });
  }

  // Sidebar navigation
  const navItems = document.querySelectorAll('.nav-item');
  const tabContents = document.querySelectorAll('.tab-content');
  const sidebarPanels = document.querySelectorAll('.sidebar-panel');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(n => n.classList.remove('active'));
      tabContents.forEach(tc => tc.classList.add('hidden'));
      sidebarPanels.forEach(sp => sp.classList.add('hidden'));

      item.classList.add('active');
      const tab = item.dataset.tab;
      const target = document.getElementById(tab);
      const sidebar = document.getElementById(tab + 'Sidebar');
      if (target) target.classList.remove('hidden');
      if (sidebar) sidebar.classList.remove('hidden');
      if (tab === 'reliability') {
        window.renderReliabilityPage?.();
      }
    });
  });

  // 3. File input handling
  const fileInput = document.getElementById('fileInput');
  if (fileInput) {
    fileInput.addEventListener('change', handleFileUpload);  // from dataManager.js
    setupDragAndDrop(); // if you have a function for drag-and-drop
  }

  // 4. "Clear All" datasets
  const clearBtn = document.getElementById('clearAllDatasets');
  if (clearBtn) {
    clearBtn.addEventListener('click', clearAllDatasets); // from dataManager.js
  }

  // 5. Add to chart, clear chart
  const addToChartBtn = document.getElementById('addToChartBtn');
  if (addToChartBtn) {
    addToChartBtn.addEventListener('click', addToChart); // from chartManager.js
  }

  const clearChartBtn = document.getElementById('clearChartBtn');
  if (clearChartBtn) {
    clearChartBtn.addEventListener('click', clearChart); // from chartManager.js
    clearChartBtn.disabled = true;  // initially disabled until user adds a dataset
  }

  // 6. Palette color for selected dataset(s)
  const randomColorBtn = document.getElementById('randomColorBtn');
  if (randomColorBtn) {
    randomColorBtn.addEventListener('click', () => {
      const colorSelect = document.getElementById('colorSelect');
      if (!colorSelect) return;
      colorSelect.value = pickUnusedColor();
      applyColorToSelectedDatasets();
    });
  }

  // 7. Chart height range
  const chartHeightRange = document.getElementById('chartHeight');
  if (chartHeightRange) {
    chartHeightRange.addEventListener('input', onChartHeightChange);
  }

  // 8. Reset zoom
  const resetZoomBtn = document.getElementById('resetZoomBtn');
  if (resetZoomBtn) {
    resetZoomBtn.addEventListener('click', resetChartZoom);
  }

  // 9. Statistics
  const calcStatsBtn = document.getElementById('calculateStatsBtn');
  if (calcStatsBtn) {
    calcStatsBtn.addEventListener('click', updateStatsTable); // from statsManager.js
  }

  document.getElementById('copyStatsMarkdownBtn')
    ?.addEventListener('click', () => window.copyStatsAsMarkdown?.());
  document.getElementById('downloadStatsJsonBtn')
    ?.addEventListener('click', () => window.downloadStatsAsJson?.());

  setupStatsSidebarControls();
  setupVizChartTypeControls();

  const updateReliabilityBtn = document.getElementById('updateReliabilityBtn');
  const reliabilityMetricSelect = document.getElementById('reliabilityMetricSelect');
  updateReliabilityBtn?.addEventListener('click', () => window.renderReliabilityPage?.());
  reliabilityMetricSelect?.addEventListener('change', () => window.renderReliabilityPage?.());

  // 10. Toggle buttons
  document.querySelectorAll('.toggle-button').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('active'));
  });

  // 12. Color preview updates
  const colorSelect = document.getElementById('colorSelect');
  if (colorSelect) {
    // Live drag only updates the swatch preview; the color is committed (and
    // checked for duplicates) once the user finishes picking.
    colorSelect.addEventListener('input', updateColorPreview);
    colorSelect.addEventListener('change', applyColorToSelectedDatasets);
    updateColorPreview();
  }

  // 13. Initialize chart height
  if (chartHeightRange) {
    onChartHeightChange({ target: chartHeightRange });
  }

  // 14. Register for dataset updates
  document.addEventListener('datasetsUpdated', function() {
    populateAllDatasetSelects();
    if (typeof window.updateMetricDropdowns === 'function') {
      window.updateMetricDropdowns();
    }
    syncColorPickerFromSelection();
    window.renderReliabilityPage?.();
  });

  // 17. Any other initialization logic you need
  console.log("main.js: All event listeners set up.");

  // Initialize dataset selects on page load
  populateAllDatasetSelects();

  const datasetSelect = document.getElementById('datasetSelect');
  if (datasetSelect) {
    datasetSelect.addEventListener('change', () => {
      updateMetricDropdowns();
      syncColorPickerFromSelection();
    });
  }

  const chartContainer = document.getElementById('chartContainer');
  if (chartContainer) {
    if (!window.chartDatasets || window.chartDatasets.length === 0) {
      chartContainer.classList.add('empty');
    }
    chartContainer.addEventListener('dblclick', resetChartZoom);
  }

  // Initialize statistics tab with empty state
  const statsContent = document.getElementById('statistics');
  if (statsContent) {
    statsContent.classList.add('empty-stats');
  }
});

// Populate all dataset selection dropdowns
function populateAllDatasetSelects() {
  const nativeSelectors = [
    document.getElementById('datasetSelect')
  ];
  const pickers = [
    document.getElementById('statDatasetSelect'),
    document.getElementById('reliabilityDatasetSelect')
  ];

  nativeSelectors.forEach(selector => {
    if (!selector) return;

    const currentValues = selector.multiple
      ? Array.from(selector.selectedOptions).map(option => option.value)
      : [selector.value];

    selector.innerHTML = '';

    (window.allDatasets || []).forEach((dataset, id) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = dataset.name;
      selector.appendChild(option);
    });

    if (selector.multiple) {
      Array.from(selector.options).forEach(option => {
        option.selected = currentValues.includes(option.value);
      });
      fitMultiSelectHeight(selector);
    } else {
      const currentValue = currentValues[0];
      if (currentValue && selector.querySelector(`option[value="${currentValue}"]`)) {
        selector.value = currentValue;
      }
    }
  });

  pickers.forEach(picker => {
    if (!picker) return;
    const currentValues = getDatasetPickerValues(picker);
    const hadSelection = currentValues.length > 0;
    const autoSelectAll = !hadSelection;

    picker.innerHTML = '';
    (window.allDatasets || []).forEach((dataset, id) => {
      const label = document.createElement('label');
      label.className = 'stats-dataset-option';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = String(id);
      input.checked = autoSelectAll || currentValues.includes(String(id));

      const name = document.createElement('span');
      name.textContent = dataset.name;

      label.classList.toggle('is-selected', input.checked);
      input.addEventListener('change', () => {
        label.classList.toggle('is-selected', input.checked);
        if (picker.id === 'reliabilityDatasetSelect') {
          window.renderReliabilityPage?.();
        }
      });

      label.appendChild(input);
      label.appendChild(name);
      picker.appendChild(label);
    });
  });
}

/** Selected values from a Stats/Reliability checkbox picker. */
function getDatasetPickerValues(picker) {
  if (!picker) return [];
  return Array.from(picker.querySelectorAll('input[type="checkbox"]:checked'))
    .map(input => input.value);
}

/** Selected dataset indices from a Stats/Reliability checkbox picker. */
function getDatasetPickerIndices(pickerOrId) {
  const picker = typeof pickerOrId === 'string'
    ? document.getElementById(pickerOrId)
    : pickerOrId;
  return getDatasetPickerValues(picker)
    .map(v => parseInt(v, 10))
    .filter(Number.isInteger);
}

function setDatasetPickerAll(pickerOrId, selected) {
  const picker = typeof pickerOrId === 'string'
    ? document.getElementById(pickerOrId)
    : pickerOrId;
  if (!picker) return;
  picker.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.checked = selected;
    input.closest('.stats-dataset-option')?.classList.toggle('is-selected', selected);
  });
}

/**
 * Native <select multiple> ignores content height in CSS; set height from
 * option count × row height, capped at max-height (120px).
 */
function fitMultiSelectHeight(select) {
  if (!select || !select.multiple) return;

  const maxHeight = 120;
  const rowHeight = 24;
  const padding = 8;
  const count = select.options.length;
  const height = count === 0
    ? rowHeight + padding
    : Math.min(maxHeight, count * rowHeight + padding);

  select.style.height = `${height}px`;
  select.style.overflowY = height >= maxHeight && count > 0 ? 'auto' : 'hidden';
  select.size = Math.max(1, Math.min(count || 1, Math.floor(maxHeight / rowHeight)));
}

// Show/hide visualization controls based on chart type.
function setupVizChartTypeControls() {
  const chartTypeSelect = document.getElementById('chartTypeSelect');
  if (!chartTypeSelect) return;

  const update = () => updateVizControlsForChartType();
  chartTypeSelect.addEventListener('change', update);
  update();
}

function updateVizControlsForChartType() {
  const type = document.getElementById('chartTypeSelect')?.value;
  const isSummary = type === 'summarybar';
  const isHistogram = type === 'histogram';

  document.getElementById('vizBarStatsPanel')?.classList.toggle('hidden', !isSummary);
  document.querySelector('.viz-color-row')?.classList.toggle('hidden', isSummary);
  document.getElementById('histogramDensityWrap')?.classList.toggle('hidden', !isHistogram);

  const hint = document.querySelector('.viz-chart-hint');
  if (hint) {
    hint.textContent = isSummary
      ? 'Rounded bars with values shown on each bar. Pick stats above, then Build summary bar.'
      : isHistogram
        ? 'Shared bins across overlays. Use “% of frames” when capture lengths differ.'
        : 'Drag to pan. Ctrl+scroll or Ctrl+drag to zoom. Double-click chart to reset. Click legend to toggle series.';
  }

  const addBtn = document.getElementById('addToChartBtn');
  if (addBtn) {
    addBtn.textContent = isSummary ? 'Build summary bar' : 'Add to chart';
  }
}

// Wire the Statistics / Reliability sidebar helper links.
function setupStatsSidebarControls() {
  const wireDatasetPicker = (pickerId, selectAllId, clearId, onChange) => {
    const picker = document.getElementById(pickerId);
    const selectAllBtn = document.getElementById(selectAllId);
    const clearSelBtn = document.getElementById(clearId);
    if (selectAllBtn && picker) {
      selectAllBtn.addEventListener('click', () => {
        setDatasetPickerAll(picker, true);
        onChange?.();
      });
    }
    if (clearSelBtn && picker) {
      clearSelBtn.addEventListener('click', () => {
        setDatasetPickerAll(picker, false);
        onChange?.();
      });
    }
  };

  wireDatasetPicker('statDatasetSelect', 'statsSelectAll', 'statsClearSel');
  wireDatasetPicker(
    'reliabilityDatasetSelect',
    'reliabilitySelectAll',
    'reliabilityClearSel',
    () => window.renderReliabilityPage?.()
  );

  const metricGroup = document.getElementById('statMetricsGroup');

  // Presets toggle metric chips: Core activates default metrics, All activates every chip.
  const setChips = (predicate) => {
    if (!metricGroup) return;
    metricGroup.querySelectorAll('.toggle-button').forEach(btn => {
      btn.classList.toggle('active', predicate(btn.dataset.metric));
    });
    window.updateStatsAverageLabel?.();
  };

  const coreBtn = document.getElementById('statsPresetCore');
  if (coreBtn) {
    coreBtn.addEventListener('click', () => setChips(m => window.STATS_DEFAULT_ACTIVE?.has(m)));
  }

  const allBtn = document.getElementById('statsPresetAll');
  if (allBtn) {
    allBtn.addEventListener('click', () => setChips(() => true));
  }
}

/**
 * Below are some helper functions that might live in main.js 
 * or in their own file; adjust as you prefer.
 */

// Update color preview
function updateColorPreview() {
  const colorInput = document.getElementById('colorSelect');
  const preview = document.getElementById('colorPreview');
  if (colorInput && preview) {
    preview.style.backgroundColor = colorInput.value;
  }
}

function syncColorPickerFromSelection() {
  const sel = document.getElementById('datasetSelect');
  const colorInput = document.getElementById('colorSelect');
  if (!sel || !colorInput || !sel.selectedOptions.length) return;
  const ds = window.allDatasets?.[+sel.selectedOptions[0].value];
  if (ds?.color) {
    colorInput.value = ds.color;
    updateColorPreview();
  }
}

function applyColorToSelectedDatasets() {
  const colorInput = document.getElementById('colorSelect');
  const sel = document.getElementById('datasetSelect');
  if (!colorInput) return;
  updateColorPreview();
  if (!sel || !sel.selectedOptions.length) return;
  const color = colorInput.value.toLowerCase();
  const selectedIdx = Array.from(sel.selectedOptions).map(opt => +opt.value);

  // Every dataset must keep a unique color so they stay distinguishable across
  // the Visualization, Statistics and Reliability tabs.
  const clash = (window.allDatasets || []).some(
    (ds, i) => !selectedIdx.includes(i) && (ds.color || '').toLowerCase() === color
  );
  if (clash) {
    window.notify?.('That color is already used by another dataset. Pick a different one.', 'warning');
    syncColorPickerFromSelection();
    return;
  }

  selectedIdx.forEach(i => {
    const ds = window.allDatasets?.[i];
    if (ds) ds.color = colorInput.value;
  });
  if (typeof window.syncLiveChartColors === 'function') {
    window.syncLiveChartColors();
  }
  if (typeof window.refreshDatasetLists === 'function') {
    window.refreshDatasetLists();
  }
}

// Pick the first palette color not already used by a dataset, falling back to a
// random distinct color if every palette slot is taken.
function pickUnusedColor() {
  const used = new Set(
    (window.allDatasets || []).map(ds => (ds.color || '').toLowerCase())
  );
  if (typeof window.getBenchmarkColor === 'function') {
    for (let i = 0; i < 14; i++) {
      const candidate = window.getBenchmarkColor(i);
      if (!used.has(candidate.toLowerCase())) return candidate;
    }
  }
  let candidate = randomColor();
  let guard = 0;
  while (used.has(candidate.toLowerCase()) && guard++ < 50) {
    candidate = randomColor();
  }
  return candidate;
}

// Random color generator
function randomColor() {
  // Helper function to generate a random color component between 30-220
  const randomComponent = () => Math.floor(30 + Math.random() * 190).toString(16).padStart(2, '0');
  return `#${randomComponent()}${randomComponent()}${randomComponent()}`;
}

// Chart height change
function onChartHeightChange(e) {
  const chartContainer = document.getElementById('chartContainer');
  const heightValSpan = document.getElementById('chartHeightValue');

  if (!e || !e.target) return;
  
  const val = e.target.value;
  if (heightValSpan) heightValSpan.textContent = val + 'px';
  if (chartContainer) {
    chartContainer.style.height = val + 'px';
    if (window.mainChart) {
      window.mainChart.resize();
    }
  }
}

// Reset chart zoom
function resetChartZoom() {
  if (window.mainChart && window.mainChart.resetZoom) {
    window.mainChart.resetZoom();
  }
}

function setupDragAndDrop() {
  const dropZone = document.getElementById('dropZone');
  if (!dropZone) return;

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length) {
      handleFileUpload({ target: { files } });
    }
  });
}

// If you have a notify() function for user messages, define it here:
function notify(msg, type = 'info') {
  console.log(`[${type.toUpperCase()}] ${msg}`);
  
  // Create UI notification
  const container = document.getElementById('notification-container');
  if (!container) return;
  
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.innerHTML = `
    <span>${msg}</span>
    <span class="notification-close">&times;</span>
  `;
  
  container.appendChild(notification);
  
  // Auto-remove after 5 seconds
  setTimeout(() => {
    notification.style.animation = 'slide-out 0.3s forwards';
    setTimeout(() => notification.remove(), 300);
  }, 5000);
  
  // Add close button functionality
  notification.querySelector('.notification-close').addEventListener('click', () => {
    notification.style.animation = 'slide-out 0.3s forwards';
    setTimeout(() => notification.remove(), 300);
  });
}

// Export notify to the global scope
window.notify = notify;
window.populateAllDatasetSelects = populateAllDatasetSelects;
window.getDatasetPickerValues = getDatasetPickerValues;
window.getDatasetPickerIndices = getDatasetPickerIndices;
window.setDatasetPickerAll = setDatasetPickerAll;
