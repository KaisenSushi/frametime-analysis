// We'll store multiple datasets in memory
window.allDatasets = [];
window.nextDatasetId = window.nextDatasetId || 1;

/**
 * Resolve a stable dataset ID to its current array position. UI controls store
 * IDs so removing another dataset cannot silently change their selection.
 */
function getDatasetIndexById(datasetId) {
  const id = String(datasetId);
  return (window.allDatasets || []).findIndex(dataset => String(dataset.id) === id);
}

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
  if (typeof window.resetReliabilityPanel === 'function') {
    window.resetReliabilityPanel();
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
  'DisplayedFrameTime',
  'Stepwise_Relative_SD',
  'Coefficient_of_Variation',
  'RMSSD',
  'Rendered_FTSD',
  'Displayed_FTSD',
  'Rendered_Coefficient_of_Variation',
  'Displayed_Coefficient_of_Variation',
  'Rendered_RMSSD',
  'Displayed_RMSSD',
  'Rendered_Stepwise_Relative_SD',
  'Displayed_Stepwise_Relative_SD',
  'Skewness',
  'Kurtosis',
  'Nonparametric_Skew'
];

const FRAMETIME_DERIVED_METRICS = new Set([
  'Stepwise_Relative_SD',
  'Coefficient_of_Variation',
  'RMSSD',
  'Rendered_FTSD',
  'Displayed_FTSD',
  'Rendered_Coefficient_of_Variation',
  'Displayed_Coefficient_of_Variation',
  'Rendered_RMSSD',
  'Displayed_RMSSD',
  'Rendered_Stepwise_Relative_SD',
  'Displayed_Stepwise_Relative_SD',
  'Skewness',
  'Kurtosis',
  'Nonparametric_Skew'
]);

const ADVANCED_ONLY_METRICS = new Set([
  'Skewness',
  'Kurtosis',
  'Nonparametric_Skew'
]);

const CORE_METRICS = [
  'RenderedFPS', 'DisplayedFPS',
  'MsBetweenPresents', 'MsBetweenDisplayChange',
  'MsGPUBusy', 'MsUntilDisplayed',
  'Rendered_FTSD', 'Displayed_FTSD',
  'Rendered_Coefficient_of_Variation', 'Displayed_Coefficient_of_Variation',
  'Rendered_RMSSD', 'Displayed_RMSSD',
  'Rendered_Stepwise_Relative_SD', 'Displayed_Stepwise_Relative_SD'
];

const STATS_DEFAULT_ACTIVE = new Set([
  'RenderedFPS', 'DisplayedFPS',
  'Rendered_FTSD', 'Displayed_FTSD',
  'Rendered_Coefficient_of_Variation', 'Displayed_Coefficient_of_Variation',
  'Rendered_RMSSD', 'Displayed_RMSSD',
  'Rendered_Stepwise_Relative_SD', 'Displayed_Stepwise_Relative_SD'
]);
const noCommonMetricsNotifiedSelections = new Set();

// Grouping for the Statistics sidebar metric chips.
const STATS_METRIC_GROUPS = [
  { label: 'Performance — Rendered', metrics: ['RenderedFPS', 'MsBetweenPresents'] },
  { label: 'Performance — Displayed', metrics: ['DisplayedFPS', 'MsBetweenDisplayChange'] },
  {
    label: 'Smoothness — Rendered',
    metrics: [
      'Rendered_FTSD', 'Rendered_Coefficient_of_Variation',
      'Rendered_RMSSD', 'Rendered_Stepwise_Relative_SD'
    ]
  },
  {
    label: 'Smoothness — Displayed',
    metrics: [
      'Displayed_FTSD', 'Displayed_Coefficient_of_Variation',
      'Displayed_RMSSD', 'Displayed_Stepwise_Relative_SD'
    ]
  },
  { label: 'Distribution shape', metrics: ['Skewness', 'Kurtosis', 'Nonparametric_Skew'] },
  { label: 'GPU / latency', metrics: ['MsGPUBusy', 'MsUntilDisplayed'] }
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
    return { error: 'invalid_json', message: e.message };
  }
  if (!json?.Runs?.length){
    console.warn('No Runs[] array in file:', fileName);
    return [];
  }

  const rows = [];

  json.Runs.forEach(run=>{
    const cd = run.CaptureData ?? {};

    const arrayFields = Object.entries(cd).filter(([, value]) => Array.isArray(value));
    if (!arrayFields.length) return;

    const lengths = arrayFields.map(([, value]) => value.length);
    const frames = Math.min(...lengths);
    if (new Set(lengths).size > 1) {
      const message = `CaptureData arrays have mismatched lengths in ${fileName}; trimming this run to ${frames} frame(s).`;
      console.warn(message);
      window.notify?.(message, 'warning');
    }
    if (!frames) return;

    // Mismatched CaptureData arrays are trimmed to the shortest length.
    for (let i=0; i<frames; i++){
      const r = {};

      // copy every per‑frame column
      arrayFields.forEach(([key, val]) => {
        r[key] = val[i];
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
        if (raw === '') {
          obj[h] = null;
          return;
        }
        const num = Number(raw);
        obj[h] = Number.isFinite(num) ? num : raw;
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
function makeUniqueDatasetName(originalName) {
  const dotIndex = originalName.lastIndexOf('.');
  const hasExtension = dotIndex > 0;
  const base = hasExtension ? originalName.slice(0, dotIndex) : originalName;
  const extension = hasExtension ? originalName.slice(dotIndex) : '';
  const existingNames = new Set((window.allDatasets || []).map(dataset => dataset.name));

  let suffix = 2;
  let candidate = `${base} (${suffix})${extension}`;
  while (existingNames.has(candidate)) {
    suffix++;
    candidate = `${base} (${suffix})${extension}`;
  }
  return candidate;
}

function resolveDuplicateDataset(fileName) {
  const existingIndex = (window.allDatasets || [])
    .findIndex(dataset => dataset.name === fileName);
  if (existingIndex === -1) {
    return Promise.resolve({ action: 'add', name: fileName, existingIndex: -1 });
  }

  if (typeof HTMLDialogElement === 'undefined') {
    return Promise.resolve({
      action: 'rename',
      name: makeUniqueDatasetName(fileName),
      existingIndex
    });
  }

  return new Promise(resolve => {
    const previouslyFocused = document.activeElement;
    const dialog = document.createElement('dialog');
    const title = document.createElement('h2');
    const description = document.createElement('p');
    const actions = document.createElement('div');
    const replaceButton = document.createElement('button');
    const keepBothButton = document.createElement('button');
    const cancelButton = document.createElement('button');
    const titleId = 'duplicate-dataset-dialog-title';

    dialog.className = 'duplicate-dataset-dialog';
    dialog.setAttribute('aria-labelledby', titleId);
    title.id = titleId;
    title.textContent = 'Duplicate dataset';
    description.textContent = `"${fileName}" is already loaded. Choose how to handle it.`;
    replaceButton.type = 'button';
    replaceButton.textContent = 'Replace';
    keepBothButton.type = 'button';
    keepBothButton.textContent = 'Keep both';
    cancelButton.type = 'button';
    cancelButton.textContent = 'Cancel';
    actions.append(replaceButton, keepBothButton, cancelButton);
    dialog.append(title, description, actions);
    document.body.appendChild(dialog);

    let action = 'cancel';
    const closeDialog = (nextAction) => {
      action = nextAction;
      dialog.close();
    };
    replaceButton.addEventListener('click', () => closeDialog('replace'));
    keepBothButton.addEventListener('click', () => closeDialog('rename'));
    cancelButton.addEventListener('click', () => closeDialog('cancel'));
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      closeDialog('cancel');
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      previouslyFocused?.focus?.();
      resolve({
        action,
        name: action === 'rename' ? makeUniqueDatasetName(fileName) : fileName,
        existingIndex
      });
    }, { once: true });

    dialog.showModal();
    replaceButton.focus();
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => resolve(event.target.result);
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsText(file);
  });
}

async function handleFileUpload(e) {
  const files = e.target.files;
  if (!files.length) return;

  const inputElement = e.target;
  const totalFiles = files.length;
  let processedCount = 0;
  let successCount = 0;
  let errorCount = 0;
  let renamedCount = 0;
  let replacedCount = 0;
  let skippedCount = 0;

  function finishOneFile() {
    processedCount++;
    if (processedCount !== totalFiles) return;

    if (replacedCount > 0) {
      window.clearChart?.();
      window.resetStatsPanel?.();
      window.resetReliabilityPanel?.();
    }
    refreshDatasetLists();

    const summaryParts = [`Loaded ${successCount} file(s).`];
    if (renamedCount > 0) summaryParts.push(`Renamed ${renamedCount} duplicate(s).`);
    if (replacedCount > 0) summaryParts.push(`Replaced ${replacedCount} existing dataset(s).`);
    if (skippedCount > 0) summaryParts.push(`Skipped ${skippedCount} duplicate(s).`);
    if (errorCount > 0) summaryParts.push(`${errorCount} file(s) had errors.`);
    const summary = summaryParts.join(' ');
    if (typeof window.notify === 'function') {
      window.notify(summary, errorCount > 0 || skippedCount > 0 ? 'warning' : 'success');
    } else {
      console.log(summary);
    }

    // Allow selecting the same file(s) again in the native file input.
    if (inputElement && 'value' in inputElement) {
      inputElement.value = '';
    }
  }

  for (const file of Array.from(files)) {
    try {
      const text = await readFileAsText(file);
      const parsedRows = file.name.toLowerCase().endsWith('.json')
        ? parseCfxJson(text, file.name)
        : parseCSV(text);

      if (parsedRows?.error === 'invalid_json') {
        window.notify?.(`Invalid JSON in ${file.name}: ${parsedRows.message}`, 'error');
        errorCount++;
        finishOneFile();
        continue;
      }
      if (parsedRows.length === 0) {
        const message = `No valid data rows found in ${file.name}`;
        if (typeof window.notify === 'function') {
          window.notify(message, 'warning');
        } else {
          console.warn(message);
        }
        errorCount++;
        finishOneFile();
        continue;
      }

      const duplicate = await resolveDuplicateDataset(file.name);
      if (duplicate.action === 'cancel') {
        skippedCount++;
        finishOneFile();
        continue;
      }

      const datasetObj = {
        id: duplicate.action === 'replace'
          ? (window.allDatasets[duplicate.existingIndex]?.id ?? window.nextDatasetId++)
          : window.nextDatasetId++,
        name: duplicate.name,
        rows: parsedRows
      };

      if (duplicate.action === 'replace') {
        const existing = window.allDatasets[duplicate.existingIndex];
        if (existing?.color) datasetObj.color = existing.color;
        window.allDatasets[duplicate.existingIndex] = datasetObj;
        replacedCount++;
      } else {
        window.allDatasets.push(datasetObj);
        if (duplicate.action === 'rename') renamedCount++;
      }
      successCount++;
    } catch (error) {
      console.error(`Error parsing ${file.name}:`, error);
      window.notify?.(`Error parsing ${file.name}: ${error.message}`, 'error');
      errorCount++;
    }
    finishOneFile();
  }
}

/**
 * Refreshes the displayed list of datasets and updates all <select> elements
 * that let users pick datasets in other tabs (Visualization, Statistics, Reliability, etc.).
 */
/**
 * Removes a single dataset by index and refreshes dependent UI. Visualization
 * selections use stable IDs, while rendered chart series still store current
 * array positions, so the chart is reset to avoid stale series after reindexing.
 */
function removeUploadedDataset(index) {
  if (index < 0 || index >= window.allDatasets.length) return;

  const [removed] = window.allDatasets.splice(index, 1);

  window.clearChart?.();
  window.resetStatsPanel?.();

  if (!window.allDatasets.length) {
    window.resetReliabilityPanel?.();
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
      removeBtn.addEventListener('click', () => removeUploadedDataset(index));
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

/**
 * Collect numeric/derived metric keys present in one dataset.
 */
function numericColumnsForDataset(ds) {
  if (!ds?.rows?.length) return new Set();
  const cols = Object.keys(ds.rows[0] || {});
  const numeric = new Set();
  cols.forEach(col => {
    if (METRIC_BLACKLIST.has(col)) return;
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
  if (ds.rows.some(r => Number.isFinite(r.FrameTime))) numeric.add('FrameTime');
  if (ds.rows.some(r => Number.isFinite(r.FPS))) numeric.add('FPS');

  const hasPresents = ds.rows.some(r => getMetricValue(r, 'RenderedFPS') != null);
  const hasDisplay = ds.rows.some(r => getMetricValue(r, 'DisplayedFPS') != null);
  const hasGpuBusy = ds.rows.some(r => getMetricValue(r, 'MsGPUBusy') != null);
  const hasUntilDisplayed = ds.rows.some(r => getMetricValue(r, 'MsUntilDisplayed') != null);
  const hasFrametimes = ds.rows.some(r => Number.isFinite(r.FrameTime) && r.FrameTime > 0);
  const hasDisplayedFrametimes = ds.rows.some(r => {
    const v = getMetricValue(r, 'DisplayedFrameTime');
    return Number.isFinite(v) && v > 0;
  });

  if (hasPresents) numeric.add('RenderedFPS');
  if (hasDisplay) numeric.add('DisplayedFPS');
  if (hasGpuBusy) numeric.add('MsGPUBusy');
  if (hasUntilDisplayed) numeric.add('MsUntilDisplayed');
  if (hasDisplayedFrametimes) numeric.add('DisplayedFrameTime');
  if (hasFrametimes) {
    numeric.add('Rendered_FTSD');
    numeric.add('Rendered_Coefficient_of_Variation');
    numeric.add('Rendered_RMSSD');
    numeric.add('Rendered_Stepwise_Relative_SD');
    FRAMETIME_DERIVED_METRICS.forEach(m => {
      if (!m.startsWith('Displayed_')) numeric.add(m);
    });
  }
  if (hasDisplayedFrametimes) {
    numeric.add('Displayed_FTSD');
    numeric.add('Displayed_Coefficient_of_Variation');
    numeric.add('Displayed_RMSSD');
    numeric.add('Displayed_Stepwise_Relative_SD');
  }

  return numeric;
}

/**
 * Build metric list based on selected datasets.
 * - If no dataset selected: union of all numeric columns (still respects basic vs advanced).
 * - If ≥1 selected: intersection of numeric columns across them.
 */
function computeAvailableMetrics(selectedIdxs) {
  let metrics;

  if (!selectedIdxs.length) {
    const union = new Set();
    (window.allDatasets || []).forEach(ds => {
      numericColumnsForDataset(ds).forEach(c => union.add(c));
    });
    metrics = Array.from(union);
  } else {
    let inter = null;
    selectedIdxs.forEach(idx => {
      const cols = numericColumnsForDataset(window.allDatasets[idx]);
      if (inter == null) {
        inter = new Set(cols);
      } else {
        inter = new Set([...inter].filter(c => cols.has(c)));
      }
    });
    metrics = inter ? Array.from(inter) : [];
  }

  const pool = selectedIdxs.length
    ? selectedIdxs.map(idx => window.allDatasets[idx]).filter(Boolean)
    : (window.allDatasets || []);

  if (!window.showAdvancedMetrics) {
    metrics = metrics.filter(m => CORE_METRICS.includes(m));
    if (!metrics.length) {
      metrics = ['RenderedFPS', 'DisplayedFPS'].filter(m =>
        pool.some(ds => ds.rows?.some(r => getMetricValue(r, m) != null))
      );
    }
  }

  metrics.sort((a, b) => a.localeCompare(b));
  return metrics;
}

function getTabDatasetIndices(tab) {
  if (tab === 'viz' && typeof window.getDatasetPickerIndices === 'function') {
    return window.getDatasetPickerIndices('datasetSelect');
  }
  if (tab === 'stats' && typeof window.getDatasetPickerIndices === 'function') {
    return window.getDatasetPickerIndices('statDatasetSelect');
  }
  if (tab === 'reliability' && typeof window.getDatasetPickerIndices === 'function') {
    return window.getDatasetPickerIndices('reliabilityDatasetSelect');
  }
  return [];
}

function populateMetricSelect(select, metrics, previousValue) {
  if (!select) return;
  select.innerHTML = '';
  const selectMetrics = select.id === 'reliabilityMetricSelect'
    ? metrics.filter(m => !FRAMETIME_DERIVED_METRICS.has(m))
    : metrics;
  selectMetrics.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = getMetricDisplayName(m);
    select.appendChild(opt);
  });
  const availableMetrics = Array.from(select.options).map(option => option.value);
  if (previousValue && availableMetrics.includes(previousValue)) {
    select.value = previousValue;
  } else if (availableMetrics.includes('RenderedFPS')) {
    select.value = 'RenderedFPS';
  } else if (availableMetrics.includes('DisplayedFPS')) {
    select.value = 'DisplayedFPS';
  } else if (availableMetrics.includes('FrameTime')) {
    select.value = 'FrameTime';
  } else if (availableMetrics.includes('FPS')) {
    select.value = 'FPS';
  }
  select.disabled = select.options.length === 0;
}

/**
 * Build metric dropdowns/chips from each tab's active dataset selection.
 */
function updateMetricDropdowns() {
  const metricSelect = document.getElementById('metricSelect');
  const reliabilityMetricSelect = document.getElementById('reliabilityMetricSelect');
  const statsMetricGroup = document.getElementById('statMetricsGroup');

  const vizMetrics = computeAvailableMetrics(getTabDatasetIndices('viz'));
  const statsMetrics = computeAvailableMetrics(getTabDatasetIndices('stats'));
  const reliabilityMetrics = computeAvailableMetrics(getTabDatasetIndices('reliability'));

  populateMetricSelect(metricSelect, vizMetrics, metricSelect?.value);
  populateMetricSelect(reliabilityMetricSelect, reliabilityMetrics, reliabilityMetricSelect?.value);

  if (statsMetricGroup) {
    renderStatsMetricGroups(statsMetricGroup, statsMetrics);
  }

  const statsSelected = getTabDatasetIndices('stats');
  const selectionKey = statsSelected.slice().sort((a, b) => a - b).join('|');
  if (
    statsMetrics.length === 0 &&
    statsSelected.length > 1 &&
    !noCommonMetricsNotifiedSelections.has(selectionKey)
  ) {
    noCommonMetricsNotifiedSelections.add(selectionKey);
    window.notify?.('No common numeric metrics across selected datasets.', 'warning');
  }
}

// Short chip labels for the compact stats sidebar.
const STATS_CHIP_LABELS = {
  'FPS': 'FPS (Present)',
  'FrameTime': 'Frame Time (Present)',
  'RenderedFPS': 'Rendered FPS',
  'DisplayedFPS': 'Displayed FPS',
  'DisplayedFrameTime': 'Displayed Frame Time',
  'Rendered_FTSD': 'Rendered FTSD',
  'Displayed_FTSD': 'Displayed FTSD',
  'Rendered_Coefficient_of_Variation': 'Rendered CoV',
  'Displayed_Coefficient_of_Variation': 'Displayed CoV',
  'Rendered_RMSSD': 'Rendered RMSSD',
  'Displayed_RMSSD': 'Displayed RMSSD',
  'Rendered_Stepwise_Relative_SD': 'Rendered Stepwise-Rel.',
  'Displayed_Stepwise_Relative_SD': 'Displayed Stepwise-Rel.',
  'MsBetweenPresents': 'MsBetweenPresents',
  'MsBetweenDisplayChange': 'MsBetweenDisplayChange',
  'MsInPresentAPI': 'MsInPresentAPI',
  'MsRenderPresentLatency': 'MsRenderPresentLatency',
  'MsGPUBusy': 'MsGPUBusy',
  'MsUntilDisplayed': 'MsUntilDisplayed',
  'MsPCLatency': 'MsPCLatency',
  'Stepwise_Relative_SD': 'Stepwise Rel. SD',
  'Coefficient_of_Variation': 'CV (σ/μ)',
  'RMSSD': 'RMSSD',
  'Skewness': 'Skewness (bias-corr.)',
  'Kurtosis': 'Kurtosis (bias-corr.)',
  'Nonparametric_Skew': 'Nonparametric Skew'
};

function getMetricChipLabel(metric) {
  if (STATS_CHIP_LABELS[metric]) return STATS_CHIP_LABELS[metric];
  return getMetricDisplayName(metric)
    .replace(/ \(ms\)$/i, '')
    .replace(/ \(%\)$/i, '');
}

/** Flat list of metrics in the fixed chip display order (group order, then extras). */
function getStatsChipDisplayOrder(availableMetrics) {
  const available = new Set(availableMetrics);
  const ordered = [];
  const grouped = new Set();

  STATS_METRIC_GROUPS.forEach(group => {
    group.metrics.forEach(metric => {
      if (!available.has(metric)) return;
      ordered.push(metric);
      grouped.add(metric);
    });
  });

  availableMetrics.forEach(metric => {
    if (!grouped.has(metric)) ordered.push(metric);
  });

  return ordered;
}

/**
 * Renders the Statistics sidebar metric chips grouped into labeled sections.
 * Chips always appear in STATS_METRIC_GROUPS order; toggling only changes .active.
 * @param {HTMLElement} container - #statMetricsGroup
 * @param {string[]} metrics - available metric keys
 */
function renderStatsMetricGroups(container, metrics) {
  const displayOrder = getStatsChipDisplayOrder(metrics);
  const metricsKey = displayOrder.join('|');
  if (container.dataset.metricsKey === metricsKey && container.querySelector('.toggle-button')) {
    return;
  }
  container.dataset.metricsKey = metricsKey;

  const existingChips = container.querySelectorAll('.toggle-button');
  const previouslyActive = new Set(
    Array.from(existingChips).filter(b => b.classList.contains('active')).map(b => b.dataset.metric)
  );
  const firstRender = existingChips.length === 0;

  container.replaceChildren();

  const makeChip = (metric) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toggle-button';
    btn.dataset.metric = metric;
    btn.textContent = getMetricChipLabel(metric);
    btn.title = getMetricDisplayName(metric);
    btn.setAttribute('aria-label', getMetricDisplayName(metric));
    const active = firstRender ? STATS_DEFAULT_ACTIVE.has(metric) : previouslyActive.has(metric);
    if (active) btn.classList.add('active');
    btn.setAttribute('aria-pressed', String(active));
    btn.addEventListener('click', () => {
      const isActive = btn.classList.toggle('active');
      btn.setAttribute('aria-pressed', String(isActive));
      window.updateStatsAverageLabel?.();
    });
    return btn;
  };

  const grouped = new Set();
  const appendMetricGroup = (labelText, groupMetrics, hint, groupIndex) => {
    if (!groupMetrics.length) return;

    const section = document.createElement('section');
    const label = document.createElement('div');
    const chips = document.createElement('div');
    const labelId = `${container.id}-metric-group-${groupIndex}`;

    section.className = 'stats-metric-group';
    if (labelText.includes('Rendered')) {
      section.classList.add('stats-metric-group--rendered');
    } else if (labelText.includes('Displayed')) {
      section.classList.add('stats-metric-group--displayed');
    }
    section.setAttribute('role', 'group');
    section.setAttribute('aria-labelledby', labelId);
    label.id = labelId;
    label.className = 'stats-metric-group-label';
    label.textContent = labelText;
    if (hint) {
      const hintElement = document.createElement('span');
      hintElement.className = 'stats-hint';
      hintElement.textContent = hint;
      label.appendChild(hintElement);
    }
    chips.className = 'stats-metric-chips';
    groupMetrics.forEach(metric => chips.appendChild(makeChip(metric)));
    section.append(label, chips);
    container.appendChild(section);
  };

  STATS_METRIC_GROUPS.forEach((group, index) => {
    const groupMetrics = group.metrics.filter(metric => metrics.includes(metric));
    groupMetrics.forEach(metric => grouped.add(metric));
    appendMetricGroup(group.label, groupMetrics, group.hint, index);
  });

  const advancedMetrics = displayOrder.filter(metric => !grouped.has(metric));
  appendMetricGroup('Advanced', advancedMetrics, null, STATS_METRIC_GROUPS.length);

  window.updateStatsAverageLabel?.();
}


/**
 * Returns a user-friendly display name for a metric
 */
function getMetricDisplayName(metric) {
  const displayNames = {
    'FrameTime': 'Rendered Frame Time (ms)',
    'FPS': 'FPS (Present / MsBetweenPresents)',
    'DisplayedFrameTime': 'Displayed Frame Time (ms)',
    'RenderedFPS': 'Rendered FPS (MsBetweenPresents)',
    'DisplayedFPS': 'Displayed FPS (MsBetweenDisplayChange)',
    'Rendered_FTSD': 'Rendered Frame Time SD (FTSD)',
    'Displayed_FTSD': 'Displayed Frame Time SD (FTSD)',
    'Rendered_Coefficient_of_Variation': 'Rendered CoV (σ/μ)',
    'Displayed_Coefficient_of_Variation': 'Displayed CoV (σ/μ)',
    'Rendered_RMSSD': 'Rendered RMSSD (ms)',
    'Displayed_RMSSD': 'Displayed RMSSD (ms)',
    'Rendered_Stepwise_Relative_SD': 'Rendered Stepwise Relative SD',
    'Displayed_Stepwise_Relative_SD': 'Displayed Stepwise Relative SD',
    'Stepwise_Relative_SD': 'Stepwise Relative SD',
    'Coefficient_of_Variation': 'Coefficient of Variation (σ/μ)',
    'RMSSD': 'RMSSD (ms)',
    'Skewness': 'Skewness (bias-corrected)',
    'Kurtosis': 'Excess Kurtosis (bias-corrected)',
    'Nonparametric_Skew': 'Nonparametric Skew',
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
    'FrameTime': 'Time between app present calls (MsBetweenPresents). Not the same as display cadence — use Displayed FPS for on-screen timing.',
    'FPS': 'Frames per second from present timing (MsBetweenPresents, harmonic mean). Not display-based — use Displayed FPS for what appears on screen.',
    'RenderedFPS': 'Frames the GPU submitted for presentation.',
    'DisplayedFPS': 'Frames actually shown on screen. Reveals smoothness loss.',
    'DisplayedFrameTime': 'Time between actual screen refreshes (MsBetweenDisplayChange).',
    'Rendered_FTSD': 'Standard deviation of rendered (present) frame times. Lower is smoother.',
    'Displayed_FTSD': 'Standard deviation of displayed (on-screen) frame times. Lower is smoother.',
    'Rendered_Coefficient_of_Variation': 'CoV of rendered frame times. Lower is more consistent.',
    'Displayed_Coefficient_of_Variation': 'CoV of displayed frame times. Lower is more consistent.',
    'Rendered_RMSSD': 'RMSSD of rendered frame times. Lower is smoother.',
    'Displayed_RMSSD': 'RMSSD of displayed frame times. Lower is smoother.',
    'Rendered_Stepwise_Relative_SD': 'Frame-to-frame relative variability of rendered timing.',
    'Displayed_Stepwise_Relative_SD': 'Frame-to-frame relative variability of displayed timing.',
    'MsGPUBusy': 'GPU work time per frame. Key for input lag even at stable FPS.',
    'MsUntilDisplayed': 'Time from CPU frame completion to display output.',
    'Stepwise_Relative_SD': 'Frame-to-frame relative variability. Lower is smoother.',
    'Coefficient_of_Variation': 'Stdev divided by mean of frametimes. Lower is more consistent.',
    'RMSSD': 'Root mean square of successive frametime differences (ms). Lower is smoother.',
    'Skewness': 'Bias-corrected sample skewness (Excel SKEW / SciPy bias=False). Positive = slow/spiky tail. Negative = fast-frame tail.',
    'Kurtosis': 'Bias-corrected excess kurtosis (Excel KURT / SciPy bias=False). Positive = heavier tails than normal.',
    'Nonparametric_Skew': 'Robust skew. Same sign meaning as skewness, less moved by single spikes.'
  };
  return descriptions[metric] || '';
}

// Expose them globally (so main.js or others can call them):
window.getMetricChipLabel = getMetricChipLabel;
window.STATS_DEFAULT_ACTIVE = STATS_DEFAULT_ACTIVE;
window.getMetricDescription = getMetricDescription;
window.removeUploadedDataset = removeUploadedDataset;
window.clearAllDatasets = clearAllDatasets;
window.parseCSV = parseCSV;
window.handleFileUpload = handleFileUpload;
window.refreshDatasetLists = refreshDatasetLists;
window.getDatasetIndexById = getDatasetIndexById;
window.updateMetricDropdowns = updateMetricDropdowns;
window.getMetricDisplayName = getMetricDisplayName;
window.parseCSVLine = parseCSVLine;
