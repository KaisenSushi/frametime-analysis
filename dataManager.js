// We'll store multiple datasets in memory
window.allDatasets = [];

/**
 * Clears all dataset data from memory and refreshes UI elements.
 */
function clearAllDatasets() {
  window.allDatasets.length = 0;

  // Reset chart state so stale series do not remain visible after clearing datasets.
  if (typeof window.clearChart === 'function') {
    window.clearChart();
  }

  // Reset Statistics panel to its empty state.
  if (typeof window.resetStatsPanel === 'function') {
    window.resetStatsPanel();
  }

  refreshDatasetLists();
  console.log("All datasets cleared.");
}

const FRAME_ALIASES = [
  { key:'frametime',             scale:1     },
  { key:'frametime(ms)',         scale:1     },
  { key:'frametime(us)',         scale:0.001 },
  { key:'msbetweenpresents',     scale:1     },
  { key:'frame delta time(ms)',  scale:1     }
];

function canonKey(str){          // lower‑case & strip spaces
  return str.toLowerCase().replace(/\s+/g,'');
}

const METRIC_BLACKLIST = new Set([
  'Application','GPU','CPU','Resolution','Runtime','ProcessID','SwapChainAddress',
  'PresentFlags','FlipToken', 'AllowsTearing', 'SyncInterval', 'Dropped', 'TimeInSeconds',
  'CPUStartTime', 'PresentMode',
]);

const DERIVED_METRICS = [
  'RenderedFPS',
  'DisplayedFPS',
  'Stepwise_Relative_SD',
  'Coefficient_of_Variation',
  'RMSSD'
];

const FRAMETIME_DERIVED_METRICS = new Set([
  'Stepwise_Relative_SD',
  'Coefficient_of_Variation',
  'RMSSD'
]);

const CORE_METRICS = [
  'FPS', 'FrameTime', 'RenderedFPS', 'DisplayedFPS',
  'MsGPUBusy', 'MsUntilDisplayed',
  'Stepwise_Relative_SD', 'Coefficient_of_Variation', 'RMSSD'
];

const STATS_DEFAULT_ACTIVE = new Set(CORE_METRICS);

// Grouping for the Statistics sidebar metric chips.
const STATS_METRIC_GROUPS = [
  { label: 'Frame timing', metrics: ['FPS', 'FrameTime'] },
  { label: 'Display pipeline', metrics: ['RenderedFPS', 'DisplayedFPS'] },
  { label: 'GPU / latency', metrics: ['MsGPUBusy', 'MsUntilDisplayed'] },
  { label: 'Stability', metrics: ['Stepwise_Relative_SD', 'Coefficient_of_Variation', 'RMSSD'], hint: 'Derived from frametime. Lower is smoother.' }
];

// global UI flag (default = basic mode)
window.showAdvancedMetrics = false;


/**
 * Ensures row.FrameTime and row.FPS exist, creating them from aliases when
 * necessary.
 */
function normaliseRow(row){
  const map = {};
  Object.keys(row).forEach(k => map[ canonKey(k) ] = k);

  /* FrameTime ----------------------------------------------------------- */
  if (row.FrameTime == null){
    for (const {key,scale} of FRAME_ALIASES){
      const m = map[key];
      if (m){
        const v = Number(row[m]);
        if (Number.isFinite(v)){
          row.FrameTime = v * scale;
          break;
        }
      }
    }
  }

  /* FPS ----------------------------------------------------------------- */
  if (row.FPS == null){
    const fpsKey = map['fps'];
    if (fpsKey && Number.isFinite(row[fpsKey])){
      row.FPS = Number(row[fpsKey]);
    } else if (Number.isFinite(row.FrameTime) && row.FrameTime > 0){
      row.FPS = 1000 / row.FrameTime;           // derive from FT
    }
  }

  /* Back‑fill FrameTime from FPS if still missing ---------------------- */
  if (row.FrameTime == null && Number.isFinite(row.FPS) && row.FPS > 0){
    row.FrameTime = 1000 / row.FPS;
  }
}


/**
 * Generic JSON‑table reader (CapFrameX today, other tools tomorrow)
 * ---------------------------------------------------------------
 *  • Detects the “per‑frame array” length (taken from MsBetweenPresents).
 *  • Copies *all* CaptureData fields that are arrays of that length.
 *  • Still runs normaliseRow() to create FrameTime / FPS aliases.
 *  • Returns an [] of plain row objects that plug into the rest of
 *    your pipeline unchanged.
 */
function parseCfxJson(text, fileName){
  let json;
  try{
    json = JSON.parse(text);
  }catch(e){
    console.warn('Not valid JSON:', fileName);
    return [];
  }
  if (!json?.Runs?.length){
    console.warn('No Runs[] array in file:', fileName);
    return [];
  }

  const rows = [];

  json.Runs.forEach(run=>{
    const cd = run.CaptureData ?? {};

    // Determine how many frames we have – fall back to longest array
    let frames = Array.isArray(cd.MsBetweenPresents) ? cd.MsBetweenPresents.length : 0;
    if (!frames){
      // grab the first array length we can find
      for (const v of Object.values(cd)){
        if (Array.isArray(v)){ frames = v.length; break; }
      }
    }
    if (!frames){ return; }   // nothing useful in this run

    for (let i=0; i<frames; i++){
      const r = {};

      // copy every per‑frame column
      Object.entries(cd).forEach(([key,val])=>{
        if (Array.isArray(val) && i < val.length){
          r[key] = val[i];
        }
      });

      // un‑alias MsBetweenPresents → FrameTime (ms)
      if (r.MsBetweenPresents != null && r.FrameTime == null){
        r.FrameTime = r.MsBetweenPresents;      // already in ms
      }

      normaliseRow(r);          // adds FPS / fills aliases & gaps
      rows.push(r);
    }
  });

  return rows;
}





/**
 * Reads CSV text into an array of objects, handling quoted strings, multiple delimiters, and line endings.
 * @param {string} text - The CSV file contents as a string.
 * @returns {Array<Object>} The parsed rows as an array of objects.
 */
function parseCSV(text) {
  text = text.replace(/\r\n|\r|\n/g, '\n').trim();
  const lines = text.split('\n');
  if (!lines.length || !lines[0].trim()) return [];

  const delimiter = [',','\t',';'].sort(
    (a,b)=> lines[0].split(b).length - lines[0].split(a).length
  )[0];

  const headers = parseCSVLine(lines[0], delimiter);
  return lines
    .slice(1)
    .filter(line => line.trim() !== '')
    .map(line => {
      const vals = parseCSVLine(line, delimiter);
      const obj  = {};
      headers.forEach((h,i)=>{
        const raw = vals[i]?.trim() ?? '';
        const num = Number(raw);
        obj[h] = Number.isFinite(num) ? num : raw || null;
      });
      normaliseRow(obj);
      return obj;
    });
}


/**
 * Parse a single CSV line, handling quoted fields with commas
 * @param {string} line - Single line from CSV
 * @param {string} delimiter - Delimiter character
 * @returns {string[]} Array of field values
 */
function parseCSVLine(line, delimiter) {
  const result = [];
  let inQuotes = false;
  let currentValue = '';

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote inside a quoted field
        currentValue += '"';
        i++; // Skip the next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(currentValue.trim());
      currentValue = '';
    } else {
      currentValue += char;
    }
  }

  // Add the last field
  result.push(currentValue.trim());

  // Remove outer quotes and unescape inner quotes
  return result.map(val => {
    val = val.trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.substring(1, val.length - 1).replace(/""/g, '"');
    }
    return val;
  });
}

/**
 * Handles file selection event for CSV/TXT uploads,
 * reads each file, parses the data, and stores it in allDatasets.
 */
function handleFileUpload(e) {
  const files = e.target.files;
  if (!files.length) return;

  const inputElement = e.target;
  const totalFiles = files.length;
  let processedCount = 0;
  let successCount = 0;
  let errorCount = 0;

  function finishOneFile() {
    processedCount++;
    if (processedCount !== totalFiles) return;

    refreshDatasetLists();
    const summary = `Loaded ${successCount} file(s). ${errorCount > 0 ? `${errorCount} file(s) had errors.` : ''}`.trim();
    if (typeof window.notify === 'function') {
      window.notify(summary, errorCount > 0 ? 'warning' : 'success');
    } else {
      console.log(summary);
    }

    // Allow selecting the same file(s) again in the native file input.
    if (inputElement && 'value' in inputElement) {
      inputElement.value = '';
    }
  }

  Array.from(files).forEach(file => {
    const reader = new FileReader();
    
    reader.onload = ev => {
      try {
        const text = ev.target.result;
        const parsedRows = file.name.toLowerCase().endsWith('.json')
                                    ? parseCfxJson(text, file.name)
                                    : parseCSV(text);
        
        if (parsedRows.length === 0) {
          // Check if notify function exists before calling it
          if (typeof window.notify === 'function') {
            window.notify(`No valid data rows found in ${file.name}`, 'warning');
          } else {
            console.warn(`No valid data rows found in ${file.name}`);
          }
          errorCount++;
          finishOneFile();
          return;
        }

        const datasetObj = {
          name: file.name,
          rows: parsedRows
        };
        window.allDatasets.push(datasetObj);
        successCount++;
        finishOneFile();
      } catch (error) {
        console.error(`Error parsing ${file.name}:`, error);
        if (typeof window.notify === 'function') {
          window.notify(`Error parsing ${file.name}: ${error.message}`, 'error');
        }
        errorCount++;
        finishOneFile();
      }
    };
    
    reader.onerror = () => {
      if (typeof window.notify === 'function') {
        window.notify(`Failed to read ${file.name}`, 'error');
      } else {
        console.error(`Failed to read ${file.name}`);
      }
      errorCount++;
      finishOneFile();
    };
    
    reader.readAsText(file);
  });
}

/**
 * Refreshes the displayed list of datasets and updates all <select> elements
 * that let users pick datasets in other tabs (Visualization, Statistics, Tests, etc.).
 */
/**
 * Removes a single dataset by index and refreshes dependent UI. Because charts
 * and selects reference datasets by index, the chart is reset to avoid stale
 * series pointing at re-indexed datasets.
 */
function removeDataset(index) {
  if (index < 0 || index >= window.allDatasets.length) return;

  const [removed] = window.allDatasets.splice(index, 1);

  if (typeof window.clearChart === 'function') {
    window.clearChart();
  }

  if (!window.allDatasets.length && typeof window.resetStatsPanel === 'function') {
    window.resetStatsPanel();
  }

  refreshDatasetLists();

  if (removed && typeof window.notify === 'function') {
    window.notify(`Removed "${removed.name}".`, 'info');
  }
}

function refreshDatasetLists() {
  if (typeof window.assignDatasetColors === 'function') {
    window.assignDatasetColors();
  }

  // Show list in the "Uploaded Datasets" panel
  const ul = document.getElementById('datasetList');
  if (ul) {
    ul.innerHTML = '';
    window.allDatasets.forEach((ds, index) => {
      const li = document.createElement('li');

      const stripe = document.createElement('span');
      stripe.className = 'dataset-list-stripe';
      stripe.style.backgroundColor = ds.color || '#888';
      li.appendChild(stripe);

      const label = document.createElement('span');
      label.className = 'dataset-list-name';
      label.textContent = `${ds.name} (${ds.rows.length} rows)`;
      li.appendChild(label);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'dataset-remove-btn';
      removeBtn.textContent = '\u00d7';
      removeBtn.title = `Remove ${ds.name}`;
      removeBtn.setAttribute('aria-label', `Remove ${ds.name}`);
      removeBtn.addEventListener('click', () => removeDataset(index));
      li.appendChild(removeBtn);

      ul.appendChild(li);
    });
  }

  // Enable or disable "Clear All" button
  const clearAllBtn = document.getElementById('clearAllDatasets');
  if (clearAllBtn) {
    clearAllBtn.disabled = (window.allDatasets.length === 0);
  }

  // Toggle the "No datasets" info message
  const emptyMessage = document.getElementById('datasetsEmpty');
  if (emptyMessage) {
    emptyMessage.classList.toggle('hidden', window.allDatasets.length > 0);
  }

  // Use the centralized function from main.js to update all selects
  if (typeof window.populateAllDatasetSelects === 'function') {
    window.populateAllDatasetSelects();
  }
  
  // Dispatch a custom event to notify that datasets have been updated
  document.dispatchEvent(new CustomEvent('datasetsUpdated'));
}

function detectAvailableMetrics() {
  const metrics = new Set(['FPS', 'FrameTime']);      // always keep these

  window.allDatasets.forEach(ds => {
    if (!ds.rows?.length) return;
    const sample = ds.rows[0];
    Object.keys(sample).forEach(k => {
      if (
        typeof sample[k] === 'number' &&
        !METRIC_BLACKLIST.has(k)
      ) {
        metrics.add(k);
      }
    });
  });

  // basic ⇄ advanced toggle
  if (!window.showAdvancedMetrics) {
    return ['FPS', 'FrameTime'];
  }
  return Array.from(metrics);
}

/**
 * Build metric list based on selected datasets.
 * - If no dataset selected: union of all numeric columns (still respects basic vs advanced).
 * - If ≥1 selected: intersection of numeric columns across them.
 * - Always ensure FrameTime / FPS present if derivable.
 */
function updateMetricDropdowns() {
  const metricSelects = [
    document.getElementById('metricSelect')
  ];
  const statsMetricGroup = document.getElementById('statMetricsGroup');
  const dsSelect = document.getElementById('datasetSelect');

  // Helper: collect numeric columns from a dataset (looking across a few rows)
  function numericColumns(ds) {
    if (!ds?.rows?.length) return new Set();
    const cols = Object.keys(ds.rows[0] || {});
    const numeric = new Set();
    cols.forEach(col => {
      // skip blacklisted
      if (METRIC_BLACKLIST.has(col)) return;
      // probe up to first 15 rows to see if any numeric value appears
      for (let i = 0; i < Math.min(15, ds.rows.length); i++) {
        const v = ds.rows[i][col];
        if (v === null || v === '' || v === undefined) continue;
        const num = Number(v);
        if (Number.isFinite(num)) {
          numeric.add(col);
          break;
        }
      }
    });
    // Make sure FrameTime / FPS appear if derived
    if (ds.rows.some(r => Number.isFinite(r.FrameTime))) numeric.add('FrameTime');
    if (ds.rows.some(r => Number.isFinite(r.FPS)))       numeric.add('FPS');

    // Add derived metrics when source columns exist
    const hasPresents = ds.rows.some(r => getMetricValue(r, 'RenderedFPS') != null);
    const hasDisplay = ds.rows.some(r => getMetricValue(r, 'DisplayedFPS') != null);
    const hasGpuBusy = ds.rows.some(r => getMetricValue(r, 'MsGPUBusy') != null);
    const hasUntilDisplayed = ds.rows.some(r => getMetricValue(r, 'MsUntilDisplayed') != null);
    const hasFrametimes = ds.rows.some(r => Number.isFinite(r.FrameTime) && r.FrameTime > 0);

    if (hasPresents) numeric.add('RenderedFPS');
    if (hasDisplay) numeric.add('DisplayedFPS');
    if (hasGpuBusy) numeric.add('MsGPUBusy');
    if (hasUntilDisplayed) numeric.add('MsUntilDisplayed');
    if (hasFrametimes) {
      FRAMETIME_DERIVED_METRICS.forEach(m => numeric.add(m));
    }

    return numeric;
  }

  // Determine selection
  const selectedIdxs = dsSelect
    ? Array.from(dsSelect.selectedOptions).map(o => +o.value)
    : [];

  let metrics;

  if (!selectedIdxs.length) {
    // UNION
    const union = new Set();
    (window.allDatasets || []).forEach(ds => {
      numericColumns(ds).forEach(c => union.add(c));
    });
    metrics = Array.from(union);
  } else {
    // INTERSECTION
    let inter = null;
    selectedIdxs.forEach(idx => {
      const cols = numericColumns(window.allDatasets[idx]);
      if (inter == null) {
        inter = new Set(cols);
      } else {
        inter = new Set([...inter].filter(c => cols.has(c)));
      }
    });
    metrics = inter ? Array.from(inter) : [];
  }

  // Basic vs advanced mode
  if (!window.showAdvancedMetrics) {
    metrics = metrics.filter(m => CORE_METRICS.includes(m));
    if (!metrics.length) {
      metrics = ['FrameTime', 'FPS'].filter(m =>
        (window.allDatasets || []).some(ds => ds.rows?.some(r => getMetricValue(r, m) != null))
      );
    }
  }

  // Ensure derived metrics are included when advanced
  DERIVED_METRICS.forEach(dm => {
    const available = (window.allDatasets || []).some(ds =>
      ds.rows?.length && (
        FRAMETIME_DERIVED_METRICS.has(dm)
          ? ds.rows.some(r => Number.isFinite(r.FrameTime))
          : ds.rows.some(r => getMetricValue(r, dm) != null)
      )
    );
    if (available && !metrics.includes(dm)) metrics.push(dm);
  });

  // Sort alpha for stability
  metrics.sort((a,b) => a.localeCompare(b));

  // --- Populate dropdowns ---
  const previousValues = metricSelects.map(sel => sel && sel.value);

  metricSelects.forEach(sel => {
    if (!sel) return;
    sel.innerHTML = '';
    metrics.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = getMetricDisplayName(m);
      sel.appendChild(opt);
    });
  });

  // Try restore old selection
  metricSelects.forEach((sel,i) => {
    if (!sel) return;
    const prev = previousValues[i];
    if (prev && metrics.includes(prev)) {
      sel.value = prev;
    } else if (metrics.includes('FrameTime')) {
      sel.value = 'FrameTime';
    } else if (metrics.includes('FPS')) {
      sel.value = 'FPS';
    }
  });

  // Statistics tab grouped metric chips
  if (statsMetricGroup) {
    renderStatsMetricGroups(statsMetricGroup, metrics);
  }

  // Disable selects if empty
  metricSelects.forEach(sel => {
    if (!sel) return;
    sel.disabled = metrics.length === 0;
  });

  if (metrics.length === 0 && selectedIdxs.length > 1) {
    if (typeof window.notify === 'function') {
      window.notify('No common numeric metrics across selected datasets.', 'warning');
    }
  }
}

// Short chip labels for the compact stats sidebar.
const STATS_CHIP_LABELS = {
  'FPS': 'FPS',
  'FrameTime': 'Frame Time',
  'RenderedFPS': 'Rendered FPS',
  'DisplayedFPS': 'Displayed FPS',
  'MsGPUBusy': 'MsGPUBusy',
  'MsUntilDisplayed': 'MsUntilDisplayed',
  'Stepwise_Relative_SD': 'Stepwise Rel. SD',
  'Coefficient_of_Variation': 'CV (σ/μ)',
  'RMSSD': 'RMSSD'
};

function getMetricChipLabel(metric) {
  return STATS_CHIP_LABELS[metric] || getMetricDisplayName(metric);
}

/**
 * Renders the Statistics sidebar metric chips grouped into labeled sections.
 * Metrics not covered by a named group land in an "Advanced" section.
 * @param {HTMLElement} container - #statMetricsGroup
 * @param {string[]} metrics - available metric keys
 */
function renderStatsMetricGroups(container, metrics) {
  const existingChips = container.querySelectorAll('.toggle-button');
  const previouslyActive = new Set(
    Array.from(existingChips).filter(b => b.classList.contains('active')).map(b => b.dataset.metric)
  );
  // Apply default-active metrics until chips have actually been rendered once.
  const firstRender = existingChips.length === 0;

  container.innerHTML = '';

  const grouped = new Set();
  const makeChip = (metric) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toggle-button';
    btn.dataset.metric = metric;
    btn.textContent = getMetricChipLabel(metric);
    const active = firstRender ? STATS_DEFAULT_ACTIVE.has(metric) : previouslyActive.has(metric);
    if (active) btn.classList.add('active');
    btn.addEventListener('click', () => btn.classList.toggle('active'));
    return btn;
  };

  STATS_METRIC_GROUPS.forEach(group => {
    const groupMetrics = group.metrics.filter(m => metrics.includes(m));
    if (!groupMetrics.length) return;

    const section = document.createElement('div');
    section.className = 'stats-metric-group';

    const label = document.createElement('div');
    label.className = 'stats-metric-group-label';
    label.innerHTML = group.hint
      ? `${group.label}<span class="stats-hint">${group.hint}</span>`
      : group.label;
    section.appendChild(label);

    const chips = document.createElement('div');
    chips.className = 'stats-metric-chips';
    groupMetrics.forEach(m => {
      grouped.add(m);
      chips.appendChild(makeChip(m));
    });
    section.appendChild(chips);
    container.appendChild(section);
  });

  const advanced = metrics.filter(m => !grouped.has(m));
  if (advanced.length) {
    const section = document.createElement('div');
    section.className = 'stats-metric-group';
    const label = document.createElement('div');
    label.className = 'stats-metric-group-label';
    label.textContent = 'Advanced';
    section.appendChild(label);
    const chips = document.createElement('div');
    chips.className = 'stats-metric-chips';
    advanced.forEach(m => chips.appendChild(makeChip(m)));
    section.appendChild(chips);
    container.appendChild(section);
  }
}


/**
 * Returns a user-friendly display name for a metric
 */
function getMetricDisplayName(metric) {
  const displayNames = {
    'FrameTime': 'Frame Time (ms)',
    'FPS': 'FPS',
    'RenderedFPS': 'Rendered FPS (MsBetweenPresents)',
    'DisplayedFPS': 'Displayed FPS (MsBetweenDisplayChange)',
    'Stepwise_Relative_SD': 'Stepwise Relative SD',
    'Coefficient_of_Variation': 'Coefficient of Variation (σ/μ)',
    'RMSSD': 'RMSSD (ms)',
    'MsBetweenPresents': 'MsBetweenPresents (ms)',
    'MsBetweenDisplayChange': 'MsBetweenDisplayChange (ms)',
    'MsInPresentAPI': 'Time in Present API (ms)',
    'MsRenderPresentLatency': 'Render-Present Latency (ms)',
    'MsUntilDisplayed': 'MsUntilDisplayed (ms)',
    'MsGPUBusy': 'MsGPUBusy (ms)',
    'MsPCLatency': 'PC Latency (ms)',
    'CPUBusy': 'CPU Busy Time (ms)',
    'CPUWait': 'CPU Wait Time (ms)',
    'CPUUtil(%)': 'CPU Utilization (%)',
    'GPUBusy': 'GPU Busy Time (ms)',
    'GPUWait': 'GPU Wait Time (ms)',
    'GPU0Util(%)': 'GPU Utilization (%)'
  };

  return displayNames[metric] || metric;
}

/**
 * Short one-line description shown under each metric section in the stats table.
 * @param {string} metric
 * @returns {string}
 */
function getMetricDescription(metric) {
  const descriptions = {
    'FrameTime': 'Time between presented frames. Lower is smoother.',
    'FPS': 'Frames per second (harmonic mean). Higher is better.',
    'RenderedFPS': 'Frames the GPU submitted for presentation.',
    'DisplayedFPS': 'Frames actually shown on screen. Reveals smoothness loss.',
    'MsGPUBusy': 'GPU work time per frame. Key for input lag even at stable FPS.',
    'MsUntilDisplayed': 'Time from CPU frame completion to display output.',
    'Stepwise_Relative_SD': 'Frame-to-frame relative variability. Lower is smoother.',
    'Coefficient_of_Variation': 'Stdev divided by mean of frametimes. Lower is more consistent.',
    'RMSSD': 'Root mean square of successive frametime differences (ms). Lower is smoother.'
  };
  return descriptions[metric] || '';
}

// Expose them globally (so main.js or others can call them):
window.getMetricChipLabel = getMetricChipLabel;
window.STATS_DEFAULT_ACTIVE = STATS_DEFAULT_ACTIVE;
window.getMetricDescription = getMetricDescription;
window.removeDataset = removeDataset;
window.clearAllDatasets = clearAllDatasets;
window.parseCSV = parseCSV;
window.handleFileUpload = handleFileUpload;
window.refreshDatasetLists = refreshDatasetLists;
window.detectAvailableMetrics = detectAvailableMetrics;
window.updateMetricDropdowns = updateMetricDropdowns;
window.getMetricDisplayName = getMetricDisplayName;
window.parseCSVLine = parseCSVLine;
