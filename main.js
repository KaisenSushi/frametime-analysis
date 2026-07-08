document.addEventListener('DOMContentLoaded', () => {
  updateMetricDropdowns();

  window.useValueX = false;
  const useValueXChk = document.getElementById('useValueX');
  if (useValueXChk) {
    useValueXChk.addEventListener('change', () => {
      window.useValueX = useValueXChk.checked;
      if (window.mainChart &&
          (window.currentChartType === 'line' || window.currentChartType === 'scatter') &&
          typeof window.rebuildCurrentLineScatterDatasets === 'function') {
        window.rebuildCurrentLineScatterDatasets();
        window.renderChart(window.currentChartType, { incremental: true });
      }
    });
  }

  // Advanced metrics toggle
  const advBtn = document.getElementById('toggleAdvancedBtn');
  if (advBtn) {
    advBtn.addEventListener('click', () => {
      window.showAdvancedMetrics = !window.showAdvancedMetrics;
      advBtn.textContent = window.showAdvancedMetrics ? 'Advanced Metrics ON' : 'Advanced Metrics OFF';
      updateMetricDropdowns();
    });
  }

  // Sidebar navigation
  const navItems = document.querySelectorAll('.nav-item');
  const tabContents = document.querySelectorAll('.tab-content');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(n => n.classList.remove('active'));
      tabContents.forEach(tc => tc.classList.add('hidden'));

      item.classList.add('active');
      const target = document.getElementById(item.dataset.tab);
      if (target) target.classList.remove('hidden');
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
      const idx = Math.floor(Math.random() * 14);
      colorSelect.value = typeof window.getBenchmarkColor === 'function'
        ? window.getBenchmarkColor(idx)
        : randomColor();
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

  setupStatsSidebarControls();
  setupVizChartTypeControls();

  // 10. Toggle buttons
  document.querySelectorAll('.toggle-button').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('active'));
  });

  // 12. Color preview updates
  const colorSelect = document.getElementById('colorSelect');
  if (colorSelect) {
    const previewUpdate = () => applyColorToSelectedDatasets();
    colorSelect.addEventListener('input', previewUpdate);
    colorSelect.addEventListener('change', previewUpdate);
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
  // Get all dataset selection dropdowns
  const selectors = [
    document.getElementById('datasetSelect'),
    document.getElementById('statDatasetSelect')
  ];
  
  // Clear and repopulate each select
  selectors.forEach(selector => {
    if (!selector) return;
    
    // Preserve current selection(s), including multi-select controls.
    const currentValues = selector.multiple
      ? Array.from(selector.selectedOptions).map(option => option.value)
      : [selector.value];
    
    // Clear existing options
    selector.innerHTML = '';
    
    // Add option for each dataset
    (window.allDatasets || []).forEach((dataset, id) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = dataset.name;
      selector.appendChild(option);
    });
    
    // Restore previous selection(s) when possible.
    if (selector.multiple) {
      // For the stats dataset picker, pre-select everything when nothing was
      // previously chosen so newly uploaded datasets are ready to compute.
      const hadSelection = currentValues.some(v => v !== '');
      const autoSelectAll = selector.id === 'statDatasetSelect' && !hadSelection;
      Array.from(selector.options).forEach(option => {
        option.selected = autoSelectAll || currentValues.includes(option.value);
      });
    } else {
      const currentValue = currentValues[0];
      if (currentValue && selector.querySelector(`option[value="${currentValue}"]`)) {
        selector.value = currentValue;
      }
    }
  });
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

  document.getElementById('vizBarStatsPanel')?.classList.toggle('hidden', !isSummary);
  document.querySelector('.viz-color-row')?.classList.toggle('hidden', isSummary);
  document.getElementById('useValueX')?.closest('.viz-check')?.classList.toggle('hidden', isSummary);

  const hint = document.querySelector('.viz-chart-hint');
  if (hint) {
    hint.textContent = isSummary
      ? 'Rounded bars with values shown on each bar. Pick stats above, then Build summary bar.'
      : 'Drag to pan. Ctrl+scroll or Ctrl+drag to zoom. Double-click chart to reset. Click legend to toggle series.';
  }

  const addBtn = document.getElementById('addToChartBtn');
  if (addBtn) {
    addBtn.textContent = isSummary ? 'Build summary bar' : 'Add to chart';
  }
}

// Wire the Statistics sidebar helper links (dataset select all/clear, metric presets).
function setupStatsSidebarControls() {
  const statDatasetSelect = document.getElementById('statDatasetSelect');
  const metricGroup = document.getElementById('statMetricsGroup');

  const selectAllBtn = document.getElementById('statsSelectAll');
  if (selectAllBtn && statDatasetSelect) {
    selectAllBtn.addEventListener('click', () => {
      Array.from(statDatasetSelect.options).forEach(opt => (opt.selected = true));
    });
  }

  const clearSelBtn = document.getElementById('statsClearSel');
  if (clearSelBtn && statDatasetSelect) {
    clearSelBtn.addEventListener('click', () => {
      Array.from(statDatasetSelect.options).forEach(opt => (opt.selected = false));
    });
  }

  // Presets toggle metric chips: Core activates default metrics, All activates every chip.
  const setChips = (predicate) => {
    if (!metricGroup) return;
    metricGroup.querySelectorAll('.toggle-button').forEach(btn => {
      btn.classList.toggle('active', predicate(btn.dataset.metric));
    });
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
  const color = colorInput.value;
  Array.from(sel.selectedOptions).forEach(opt => {
    const ds = window.allDatasets?.[+opt.value];
    if (ds) ds.color = color;
  });
  if (typeof window.refreshDatasetLists === 'function') {
    window.refreshDatasetLists();
  }
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
