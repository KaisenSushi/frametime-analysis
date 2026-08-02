const APP_THEME_LABELS = Object.freeze({
  graphite: 'Graphite',
  light: 'Light',
  nord: 'Nord',
  gruvbox: 'Gruvbox',
  catppuccin: 'Catppuccin',
  purple: 'Purple'
});

const APP_THEMES = Object.freeze(Object.keys(APP_THEME_LABELS));

function syncThemeMenu(theme) {
  const value = document.getElementById('themeMenuValue');
  if (value) value.textContent = APP_THEME_LABELS[theme] || APP_THEME_LABELS.graphite;

  document.querySelectorAll('[data-theme-option]').forEach(option => {
    const selected = option.dataset.themeOption === theme;
    option.setAttribute('aria-selected', String(selected));
    option.classList.toggle('is-selected', selected);
  });
}

function applyAppTheme(theme, { persist = true } = {}) {
  const nextTheme = APP_THEMES.includes(theme) ? theme : 'graphite';
  document.documentElement.dataset.theme = nextTheme;
  syncThemeMenu(nextTheme);

  if (persist) {
    try { localStorage.setItem('fta-theme', nextTheme); }
    catch (error) { /* Storage may be unavailable. */ }
  }

  requestAnimationFrame(() => {
    window.refreshChartTheme?.();
    window.refreshReliabilityTheme?.();
  });

  document.dispatchEvent(new CustomEvent('appThemeChanged', {
    detail: { theme: nextTheme }
  }));
}

function setupThemeSelector() {
  const button = document.getElementById('themeMenuButton');
  const menu = document.getElementById('themeMenu');
  if (!button || !menu) return;

  const options = Array.from(menu.querySelectorAll('[data-theme-option]'));
  const initial = APP_THEMES.includes(document.documentElement.dataset.theme)
    ? document.documentElement.dataset.theme
    : (window.__ftaInitialTheme || 'graphite');

  const selectedIndex = () => Math.max(0, options.findIndex(option =>
    option.dataset.themeOption === document.documentElement.dataset.theme
  ));

  const focusOption = index => {
    if (!options.length) return;
    const nextIndex = (index + options.length) % options.length;
    options[nextIndex].focus();
  };

  const openMenu = ({ focusSelected = false } = {}) => {
    menu.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    if (focusSelected) requestAnimationFrame(() => focusOption(selectedIndex()));
  };

  const closeMenu = ({ restoreFocus = false } = {}) => {
    menu.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button.focus({ preventScroll: true });
  };

  const chooseTheme = option => {
    const theme = option?.dataset.themeOption;
    if (!APP_THEMES.includes(theme)) return;
    applyAppTheme(theme);
    closeMenu({ restoreFocus: true });
  };

  applyAppTheme(initial, { persist: false });

  button.addEventListener('click', () => {
    const expanded = button.getAttribute('aria-expanded') === 'true';
    if (expanded) closeMenu();
    else openMenu();
  });

  button.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu({ focusSelected: true });
    }
  });

  options.forEach((option, index) => {
    option.addEventListener('click', () => chooseTheme(option));
    option.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        chooseTheme(option);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusOption(index + 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusOption(index - 1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        focusOption(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        focusOption(options.length - 1);
      } else if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        closeMenu({ restoreFocus: event.key === 'Escape' });
      }
    });
  });

  document.addEventListener('pointerdown', event => {
    if (!menu.classList.contains('hidden') && !event.target.closest('.theme-control')) {
      closeMenu();
    }
  });
}

window.applyAppTheme = applyAppTheme;
window.APP_THEMES = APP_THEMES;

function checkApplicationDependencies() {
  const missing = new Set(window.__ftaDependencyFailures || []);
  if (!window.Chart) missing.add('Chart.js');
  if (!window.jStat) missing.add('jStat');
  if (!window.htmlToImage) missing.add('PNG export');

  const chartUnavailable = !window.Chart;
  ['addToChartBtn', 'updateReliabilityBtn', 'resetZoomBtn', 'exportChartPngBtn', 'exportReliabilityPngBtn']
    .forEach(id => {
      const button = document.getElementById(id);
      if (button && chartUnavailable) {
        button.disabled = true;
        button.title = 'Chart.js did not load.';
      }
    });

  if (!window.htmlToImage) {
    const button = document.getElementById('exportStatsPngBtn');
    if (button) {
      button.disabled = true;
      button.title = 'The PNG export dependency did not load.';
    }
  }

  if (window.Chart) {
    const isRegistered = (registry, name) => {
      try { return Boolean(registry?.get?.(name)); }
      catch (error) { return false; }
    };
    const hasBoxplot = isRegistered(window.Chart.registry?.controllers, 'boxplot');
    const hasViolin = isRegistered(window.Chart.registry?.controllers, 'violin');
    const hasZoom = isRegistered(window.Chart.registry?.plugins, 'zoom');
    if (!hasBoxplot || !hasViolin) missing.add('Box/violin charts');
    if (!hasZoom) missing.add('Chart zoom');

    const chartType = document.getElementById('chartTypeSelect');
    [['boxplot', hasBoxplot], ['violin', hasViolin]].forEach(([value, available]) => {
      const option = chartType?.querySelector(`option[value="${value}"]`);
      if (option && !available) {
        option.disabled = true;
        option.title = 'The chart extension did not load.';
      }
    });
    if (!hasZoom) {
      const resetButton = document.getElementById('resetZoomBtn');
      if (resetButton) {
        resetButton.disabled = true;
        resetButton.title = 'The chart zoom extension did not load.';
      }
    }
  }

  if (missing.size) {
    window.notify?.(
      `Some optional components did not load: ${Array.from(missing).join(', ')}. Affected features were disabled where possible.`,
      'warning'
    );
  }
}

function setupTopbarHeightSync() {
  const topbar = document.querySelector('.v2-topbar') || document.querySelector('.app-topbar');
  if (!topbar) return;

  const updateTopbarHeight = () => {
    const height = Math.ceil(topbar.getBoundingClientRect().height);
    if (height > 0) {
      document.documentElement.style.setProperty('--topbar-height', `${height}px`);
    }
  };

  updateTopbarHeight();
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(updateTopbarHeight);
    observer.observe(topbar);
  } else {
    window.addEventListener('resize', updateTopbarHeight);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  setupThemeSelector();
  setupTopbarHeightSync();
  checkApplicationDependencies();
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

  // Advanced metrics toggle
  const advBtn = document.getElementById('toggleAdvancedBtn');
  if (advBtn) {
    advBtn.addEventListener('click', () => {
      window.showAdvancedMetrics = !window.showAdvancedMetrics;
      advBtn.textContent = window.showAdvancedMetrics ? 'Advanced metrics ON' : 'Advanced metrics OFF';
      advBtn.setAttribute('aria-pressed', String(window.showAdvancedMetrics));
      updateMetricDropdowns();
      window.markReliabilityStale?.('Available metrics changed. Update reliability to refresh the results.');
    });
  }

  // Classic sidebar tab nav removed - mode switching lives in v2-shell.js.

  // 3. File input handling
  const fileInput = document.getElementById('fileInput');
  if (fileInput) {
    fileInput.addEventListener('change', handleFileUpload);  // from dataManager.js
    setupDragAndDrop(); // if you have a function for drag-and-drop
  }
  document.getElementById('cancelImportBtn')
    ?.addEventListener('click', () => window.cancelCaptureImport?.());

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

  // 6. Dataset color swatch + popover
  setupColorPicker();

  // 7. Chart height range
  const chartHeightRange = document.getElementById('chartHeight');
  if (chartHeightRange) {
    chartHeightRange.addEventListener('input', event => {
      chartHeightRange.dataset.userSet = 'true';
      onChartHeightChange(event);
    });
  }

  // 8. Reset zoom
  const resetZoomBtn = document.getElementById('resetZoomBtn');
  if (resetZoomBtn) {
    resetZoomBtn.addEventListener('click', resetChartZoom);
  }

  document.getElementById('exportChartPngBtn')
    ?.addEventListener('click', () => window.exportChartPng?.(window.mainChart, 'frame-timing-chart'));

  document.getElementById('exportReliabilityPngBtn')
    ?.addEventListener('click', () => window.exportReliabilityChartPng?.());

  // 9. Statistics
  const calcStatsBtn = document.getElementById('calculateStatsBtn');
  if (calcStatsBtn) {
    calcStatsBtn.addEventListener('click', updateStatsTable); // from statsManager.js
  }

  document.getElementById('copyStatsMarkdownBtn')
    ?.addEventListener('click', () => window.copyStatsAsMarkdown?.());
  document.getElementById('downloadStatsJsonBtn')
    ?.addEventListener('click', () => window.downloadStatsAsJson?.());
  document.getElementById('exportStatsPngBtn')
    ?.addEventListener('click', () => window.exportStatsAsPng?.());

  setupStatsSidebarControls();
  setupVizChartTypeControls();
  setupVisualizationResultMode();

  const updateReliabilityBtn = document.getElementById('updateReliabilityBtn');
  const reliabilityMetricSelect = document.getElementById('reliabilityMetricSelect');
  updateReliabilityBtn?.addEventListener('click', async () => {
    if (updateReliabilityBtn.getAttribute('aria-busy') === 'true') return;

    const selectedCount = getDatasetPickerIndices('reliabilityDatasetSelect').length;
    if (!selectedCount) {
      window.notify?.('Select at least one dataset to update reliability.', 'warning');
      window.markReliabilityStale?.('Select at least one dataset.');
      return;
    }
    if (!reliabilityMetricSelect?.value) {
      window.notify?.('Select a metric to update reliability.', 'warning');
      window.markReliabilityStale?.('Select a metric.');
      return;
    }

    updateReliabilityBtn.disabled = true;
    updateReliabilityBtn.setAttribute('aria-busy', 'true');
    updateReliabilityBtn.textContent =
      selectedCount === 1 ? 'Updating 1 dataset…' : `Updating ${selectedCount} datasets…`;

    try {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const result = await window.renderReliabilityPage?.();
      if (result?.ok) {
        window.setV2Step?.('results', { focusPanel: true });
      }
    } catch (error) {
      console.error('Reliability update failed:', error);
      window.notify?.(`Reliability update failed: ${error.message}`, 'error');
    } finally {
      updateReliabilityBtn.disabled = false;
      updateReliabilityBtn.removeAttribute('aria-busy');
      updateReliabilityBtn.textContent = 'Update reliability';
    }
  });
  reliabilityMetricSelect?.addEventListener('change', () => {
    window.markReliabilityStale?.('Metric changed. Update reliability to refresh the results.');
  });

  // 10. Toggle buttons (metric chips manage their own click handlers)
  document.querySelectorAll('.toggle-button').forEach(btn => {
    if (btn.closest('#statMetricsGroup')) return;
    btn.addEventListener('click', () => {
      const active = btn.classList.toggle('active');
      btn.setAttribute('aria-pressed', String(active));
    });
  });

  // 13. Initialize chart height from the available viewport. The user can
  // override this at any time with the height slider.
  if (chartHeightRange) {
    applyAdaptiveChartHeight(chartHeightRange);
    onChartHeightChange({ target: chartHeightRange });
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      if (chartHeightRange.dataset.userSet === 'true' || window.currentChartType === 'summarybar') return;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        applyAdaptiveChartHeight(chartHeightRange);
        onChartHeightChange({ target: chartHeightRange });
      }, 120);
    });
  }

  // 14. Register for dataset updates
  document.addEventListener('datasetsUpdated', function() {
    populateAllDatasetSelects();
    if (typeof window.updateMetricDropdowns === 'function') {
      window.updateMetricDropdowns();
    }
    syncColorPickerFromSelection();
    window.markReliabilityStale?.('Datasets changed. Update reliability to refresh the results.');
  });

  // 17. Any other initialization logic you need
  console.log("main.js: All event listeners set up.");

  // Initialize dataset selects on page load
  populateAllDatasetSelects();

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

const DATASET_PICKER_COUNT_IDS = Object.freeze({
  datasetSelect: 'vizDatasetCount',
  statDatasetSelect: 'statsDatasetCount',
  reliabilityDatasetSelect: 'reliabilityDatasetCount'
});

function updateDatasetPickerCount(pickerOrId) {
  const picker = typeof pickerOrId === 'string'
    ? document.getElementById(pickerOrId)
    : pickerOrId;
  if (!picker) return;

  const inputs = Array.from(picker.querySelectorAll('input[type="checkbox"]'));
  const selectedCount = inputs.reduce((count, input) => count + Number(input.checked), 0);
  const totalCount = inputs.length;
  const countElement = document.getElementById(DATASET_PICKER_COUNT_IDS[picker.id]);
  if (!countElement) return;

  countElement.textContent = `${selectedCount}/${totalCount} selected`;
  countElement.setAttribute(
    'aria-label',
    `${selectedCount} of ${totalCount} dataset${totalCount === 1 ? '' : 's'} selected`
  );
}

// Populate all dataset checkbox pickers.
function populateAllDatasetSelects() {
  window.assignDatasetColors?.();

  const pickers = [
    document.getElementById('datasetSelect'),
    document.getElementById('statDatasetSelect'),
    document.getElementById('reliabilityDatasetSelect')
  ];

  pickers.forEach(picker => {
    if (!picker) return;
    const datasets = window.allDatasets || [];
    const currentValues = getDatasetPickerValues(picker);
    const hasInitializedSelection = picker.dataset.selectionInitialized === 'true';
    const autoSelectAll = !hasInitializedSelection && currentValues.length === 0;
    let knownDatasetIds = new Set();
    try {
      const parsedKnownIds = JSON.parse(picker.dataset.knownDatasetIds || '[]');
      if (Array.isArray(parsedKnownIds)) knownDatasetIds = new Set(parsedKnownIds.map(String));
    } catch (_) {
      knownDatasetIds = new Set();
    }
    const focusedCheckboxValue = document.activeElement instanceof HTMLInputElement &&
      document.activeElement.type === 'checkbox' &&
      picker.contains(document.activeElement)
      ? document.activeElement.value
      : null;

    picker.innerHTML = '';
    datasets.forEach((dataset, id) => {
      const label = document.createElement('label');
      label.className = 'stats-dataset-option';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = String(dataset.id ?? dataset.name ?? id);
      const isNewDataset = !knownDatasetIds.has(input.value);
      input.checked = autoSelectAll || currentValues.includes(input.value) || isNewDataset;
      const datasetLabel = window.getDatasetDisplayName?.(dataset) || dataset.name;
      input.setAttribute('aria-label', `Select ${datasetLabel}`);

      const colorDot = document.createElement('span');
      colorDot.className = 'dataset-option-color';
      colorDot.setAttribute('aria-hidden', 'true');
      colorDot.style.backgroundColor = dataset.color || window.getBenchmarkColor?.(id) || '#888888';

      const name = document.createElement('span');
      name.className = 'dataset-option-name';
      name.textContent = datasetLabel;
      name.title = dataset.name;

      label.classList.toggle('is-selected', input.checked);
      label.setAttribute('data-selected', String(input.checked));
      input.addEventListener('change', () => {
        label.classList.toggle('is-selected', input.checked);
        label.setAttribute('data-selected', String(input.checked));
        updateDatasetPickerCount(picker);
        if (picker.id === 'reliabilityDatasetSelect') {
          if (typeof window.updateMetricDropdowns === 'function') {
            window.updateMetricDropdowns();
          }
          window.markReliabilityStale?.('Selection changed. Update reliability to refresh the results.');
        }
        if (picker.id === 'statDatasetSelect' && typeof window.updateMetricDropdowns === 'function') {
          window.updateMetricDropdowns();
        }
        if (picker.id === 'datasetSelect') {
          window.updateMetricDropdowns?.();
          syncColorPickerFromSelection();
        }
      });

      label.appendChild(colorDot);
      label.appendChild(name);
      label.appendChild(input);
      picker.appendChild(label);
    });
    updateDatasetPickerCount(picker);
    if (datasets.length) {
      picker.dataset.selectionInitialized = 'true';
      picker.dataset.knownDatasetIds = JSON.stringify(
        datasets.map((dataset, index) => String(dataset.id ?? dataset.name ?? index))
      );
    } else {
      delete picker.dataset.selectionInitialized;
      delete picker.dataset.knownDatasetIds;
    }

    if (focusedCheckboxValue !== null) {
      Array.from(picker.querySelectorAll('input[type="checkbox"]'))
        .find(input => input.value === focusedCheckboxValue)
        ?.focus({ preventScroll: true });
    }
  });
}

/** Selected stable IDs from a dataset checkbox picker. */
function getDatasetPickerValues(picker) {
  if (!picker) return [];
  return Array.from(picker.querySelectorAll('input[type="checkbox"]:checked'))
    .map(input => input.value);
}

/** Selected dataset indices from a checkbox picker. */
function getDatasetPickerIndices(pickerOrId) {
  const picker = typeof pickerOrId === 'string'
    ? document.getElementById(pickerOrId)
    : pickerOrId;
  const selectedIds = new Set(getDatasetPickerValues(picker));
  return (window.allDatasets || [])
    .map((dataset, index) => ({ dataset, index }))
    .filter(({ dataset, index }) => {
      const stableId = String(dataset?.id ?? dataset?.name ?? index);
      return selectedIds.has(stableId);
    })
    .map(({ index }) => index);
}

function setDatasetPickerAll(pickerOrId, selected) {
  const picker = typeof pickerOrId === 'string'
    ? document.getElementById(pickerOrId)
    : pickerOrId;
  if (!picker) return;
  picker.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.checked = selected;
    const option = input.closest('.stats-dataset-option');
    option?.classList.toggle('is-selected', selected);
    option?.setAttribute('data-selected', String(selected));
  });
  updateDatasetPickerCount(picker);
}

function setupVisualizationResultMode() {
  const select = document.getElementById('vizResultMode');
  const singleControls = document.getElementById('singleChartBuilderControls');
  const boardHint = document.getElementById('analysisBoardSetupHint');
  const addButton = document.getElementById('addToChartBtn');
  if (!select || !singleControls || !boardHint || !addButton) return;

  const sync = ({ changed = false } = {}) => {
    const boardMode = select.value === 'board';
    singleControls.classList.toggle('hidden', boardMode);
    boardHint.classList.toggle('hidden', !boardMode);
    addButton.textContent = boardMode ? 'Build analysis board' : 'Add to chart';
    addButton.setAttribute('aria-label', boardMode ? 'Build analysis board' : 'Add selected datasets to chart');
    if (changed) window.setVisualizationResultMode?.(select.value);
  };

  select.addEventListener('change', () => sync({ changed: true }));
  sync();
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
        ? 'Shared bins across overlays. Use "% of frames" when capture lengths differ.'
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

  wireDatasetPicker('statDatasetSelect', 'statsSelectAll', 'statsClearSel', () => {
    window.updateMetricDropdowns?.();
  });
  wireDatasetPicker('datasetSelect', 'vizSelectAll', 'vizClearSel', () => {
    window.updateMetricDropdowns?.();
    syncColorPickerFromSelection();
  });
  wireDatasetPicker(
    'reliabilityDatasetSelect',
    'reliabilitySelectAll',
    'reliabilityClearSel',
    () => {
      window.updateMetricDropdowns?.();
      window.markReliabilityStale?.('Selection changed. Update reliability to refresh the results.');
    }
  );

  const metricGroup = document.getElementById('statMetricsGroup');

  // Presets toggle metric chips: Core activates default metrics, All activates every chip.
  const setChips = (predicate) => {
    if (!metricGroup) return;
    metricGroup.querySelectorAll('.toggle-button').forEach(btn => {
      const active = predicate(btn.dataset.metric);
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
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

// Keep the visible swatch face in sync with #colorSelect.
function updateColorPreview() {
  const colorInput = document.getElementById('colorSelect');
  const face = document.getElementById('colorSwatchFace');
  if (colorInput && face) {
    face.style.backgroundColor = colorInput.value;
  }
}

function getPaletteColors() {
  if (Array.isArray(window.BENCHMARK_COLORS) && window.BENCHMARK_COLORS.length) {
    return window.BENCHMARK_COLORS.slice();
  }
  return ['#3B82F6', '#EF4444', '#F59E0B', '#22C55E', '#A855F7', '#06B6D4', '#F97316', '#EC4899', '#84CC16', '#6366F1'];
}

function closeColorPopover() {
  const popover = document.getElementById('colorPopover');
  const swatchBtn = document.getElementById('colorSwatchBtn');
  const wasOpen = popover && !popover.classList.contains('hidden');
  if (popover) popover.classList.add('hidden');
  swatchBtn?.setAttribute('aria-expanded', 'false');
  if (wasOpen) swatchBtn?.focus();
}

function openColorPopover() {
  const popover = document.getElementById('colorPopover');
  const swatches = document.getElementById('colorPopoverSwatches');
  const swatchBtn = document.getElementById('colorSwatchBtn');
  const colorInput = document.getElementById('colorSelect');
  if (!popover || !swatches || !colorInput) return;

  const current = (colorInput.value || '').toLowerCase();
  swatches.innerHTML = '';
  getPaletteColors().forEach(color => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-popover-swatch';
    btn.style.backgroundColor = color;
    btn.title = color;
    btn.setAttribute('aria-label', `Use palette color ${color}`);
    if (color.toLowerCase() === current) btn.classList.add('is-current');
    btn.addEventListener('click', () => {
      colorInput.value = color;
      updateColorPreview();
      applyColorToSelectedDatasets();
      closeColorPopover();
    });
    swatches.appendChild(btn);
  });

  popover.classList.remove('hidden');
  swatchBtn?.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => {
    popover.querySelector('button:not([disabled])')?.focus();
  });
}

function trapColorPopoverFocus(event) {
  const popover = document.getElementById('colorPopover');
  if (!popover || popover.classList.contains('hidden')) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeColorPopover();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = Array.from(
    popover.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')
  ).filter(element => !element.hidden && element.getClientRects().length > 0);
  if (!focusable.length) {
    event.preventDefault();
    popover.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !popover.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !popover.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

function setupColorPicker() {
  const colorInput = document.getElementById('colorSelect');
  const swatchBtn = document.getElementById('colorSwatchBtn');
  const customBtn = document.getElementById('colorCustomBtn');
  const container = document.querySelector('.color-picker-container');
  if (!colorInput || !swatchBtn) return;

  updateColorPreview();

  // Live drag updates the swatch; commit (and duplicate checks) happen on change.
  colorInput.addEventListener('input', updateColorPreview);
  colorInput.addEventListener('change', () => {
    applyColorToSelectedDatasets();
    closeColorPopover();
  });

  swatchBtn.addEventListener('click', () => {
    const popover = document.getElementById('colorPopover');
    if (popover && !popover.classList.contains('hidden')) {
      closeColorPopover();
      return;
    }
    openColorPopover();
  });

  customBtn?.addEventListener('click', () => {
    closeColorPopover();
    colorInput.click();
  });

  document.addEventListener('pointerdown', (event) => {
    if (!container?.contains(event.target)) closeColorPopover();
  });

  document.addEventListener('keydown', trapColorPopoverFocus);
}

function syncColorPickerFromSelection() {
  const picker = document.getElementById('datasetSelect');
  const colorInput = document.getElementById('colorSelect');
  const selectedValues = getDatasetPickerValues(picker);
  if (!colorInput || !selectedValues.length) return;
  const index = window.getDatasetIndexById?.(selectedValues[0]) ?? -1;
  const ds = index >= 0 ? window.allDatasets?.[index] : null;
  if (ds?.color) {
    colorInput.value = ds.color;
    updateColorPreview();
  }
}

function applyColorToSelectedDatasets() {
  const colorInput = document.getElementById('colorSelect');
  const picker = document.getElementById('datasetSelect');
  if (!colorInput) return;
  updateColorPreview();
  if (!picker) return;
  const color = colorInput.value.toLowerCase();
  const selectedIdx = getDatasetPickerIndices(picker);
  if (!selectedIdx.length) return;
  if (selectedIdx.length > 1) {
    window.notify?.('Pick one dataset at a time when assigning a manual color, so colors stay unique.', 'warning');
    syncColorPickerFromSelection();
    return;
  }

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

// Random color generator (fallback if a custom path needs a distinct color)
function randomColor() {
  const randomComponent = () => Math.floor(30 + Math.random() * 190).toString(16).padStart(2, '0');
  return `#${randomComponent()}${randomComponent()}${randomComponent()}`;
}

// Choose a sensible chart height for short or unusual desktop viewports.
// This avoids scaling the entire interface, which would blur text and break hit
// targets. Summary bars still use their content-aware height calculation.
function applyAdaptiveChartHeight(range) {
  if (!range || range.dataset.userSet === 'true') return;
  const topbar = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--topbar-height')
  ) || 72;
  const available = Math.max(280, window.innerHeight - topbar - 190);
  const target = Math.round(Math.min(520, Math.max(300, available)));
  const min = Number(range.min) || 280;
  const max = Number(range.max) || 900;
  range.value = String(Math.min(max, Math.max(min, target)));
}

// Chart height change
function onChartHeightChange(e) {
  const chartContainer = document.getElementById('chartContainer');
  const heightValSpan = document.getElementById('chartHeightValue');

  if (!e || !e.target) return;
  
  const val = e.target.value;
  if (heightValSpan) heightValSpan.textContent = val + 'px';
  e.target.setAttribute('aria-valuetext', `${val} pixels`);
  if (chartContainer) {
    chartContainer.style.height = val + 'px';
    if (window.mainChart) {
      window.mainChart.resize();
    }
  }
}

// Reset chart zoom
function resetChartZoom() {
  if (window.currentChartType === 'summarybar') return;
  if (window.mainChart && window.mainChart.resetZoom) {
    window.mainChart.resetZoom();
    window.setResetZoomEnabled?.(false);
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
  notification.setAttribute('role', type === 'error' ? 'alert' : 'status');
  notification.setAttribute('aria-atomic', 'true');

  const message = document.createElement('span');
  message.textContent = msg;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'notification-close';
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Dismiss notification');
  notification.append(message, close);
  
  container.appendChild(notification);
  
  const dismiss = () => {
    notification.style.animation = 'slide-out 0.3s forwards';
    setTimeout(() => notification.remove(), 300);
  };
  const scheduleDismiss = () => {
    setTimeout(() => {
      if (notification.matches(':focus-within')) {
        scheduleDismiss();
        return;
      }
      dismiss();
    }, 5000);
  };
  scheduleDismiss();
  
  // Add close button functionality
  close.addEventListener('click', dismiss);
}

// Export notify to the global scope
window.notify = notify;
window.populateAllDatasetSelects = populateAllDatasetSelects;
window.updateDatasetPickerCount = updateDatasetPickerCount;
window.getDatasetPickerValues = getDatasetPickerValues;
window.getDatasetPickerIndices = getDatasetPickerIndices;
window.setDatasetPickerAll = setDatasetPickerAll;
