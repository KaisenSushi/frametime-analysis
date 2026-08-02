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



/** Columnar dataset helpers ------------------------------------------------- */
function getDatasetRowCount(dataset) {
  if (!dataset) return 0;
  if (Number.isFinite(dataset.rowCount)) return dataset.rowCount;
  if (dataset.columns) {
    const first = Object.values(dataset.columns)[0];
    if (first && Number.isFinite(first.length)) return first.length;
  }
  return dataset.rows?.length || 0;
}

function getDatasetColumn(dataset, ...candidates) {
  const columns = dataset?.columns;
  if (!columns) return null;

  let lookup = dataset.__columnLookup;
  if (!lookup) {
    lookup = new Map();
    Object.keys(columns).forEach(name => {
      lookup.set(name.toLowerCase(), name);
      lookup.set(canonKey(name), name);
    });
    Object.defineProperty(dataset, '__columnLookup', {
      value: lookup,
      configurable: true,
      enumerable: false
    });
  }

  for (const candidate of candidates) {
    if (columns[candidate]) return columns[candidate];
    const candidateText = String(candidate);
    const match = lookup.get(candidateText.toLowerCase()) || lookup.get(canonKey(candidateText));
    if (match) return columns[match];
  }
  return null;
}

function getDatasetColumnNames(dataset) {
  return dataset?.columns ? Object.keys(dataset.columns) : [];
}

/**
 * Locate the source used for rendered/presented frame time without allocating
 * another full-size derived column. Values are converted to milliseconds by
 * the returned toMilliseconds function.
 */
function getDatasetRenderedTimingSource(dataset) {
  for (const alias of FRAME_ALIASES) {
    const column = getDatasetColumn(dataset, alias.key);
    if (column) {
      return {
        column,
        source: 'timing',
        scale: alias.scale,
        toMilliseconds: value => value * alias.scale
      };
    }
  }

  // Legacy captures sometimes contain only FPS. Preserve the old behavior of
  // back-filling frame time from a positive FPS sample.
  const fpsColumn = getDatasetColumn(dataset, 'RenderedFPS', 'FPS');
  if (fpsColumn) {
    return {
      column: fpsColumn,
      source: 'fps',
      scale: 1,
      toMilliseconds: value => value > 0 ? 1000 / value : NaN
    };
  }
  return null;
}

function createColumnarRowProxy(dataset, index) {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === Symbol.toStringTag) return 'ColumnarRow';
      if (typeof property !== 'string') return undefined;
      const column = getDatasetColumn(dataset, property);
      if (!column) return undefined;
      const value = column[index];
      return Number.isFinite(value) ? value : null;
    },
    ownKeys() { return getDatasetColumnNames(dataset); },
    getOwnPropertyDescriptor(_target, property) {
      if (typeof property === 'string' && getDatasetColumn(dataset, property)) {
        return { enumerable: true, configurable: true };
      }
      return undefined;
    }
  });
}

function attachDatasetCompatibility(dataset) {
  if (!dataset || dataset.__columnarCompatibilityAttached) return dataset;
  dataset.rowCount = getDatasetRowCount(dataset);
  const rowArray = new Proxy([], {
    get(target, property, receiver) {
      if (property === 'length') return dataset.rowCount;
      if (typeof property === 'string' && /^(?:0|[1-9]\d*)$/.test(property)) {
        const index = Number(property);
        return index < dataset.rowCount ? createColumnarRowProxy(dataset, index) : undefined;
      }
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      if (typeof property === 'string' && /^(?:0|[1-9]\d*)$/.test(property)) {
        return Number(property) < dataset.rowCount;
      }
      return Reflect.has(target, property);
    }
  });
  Object.defineProperty(dataset, 'rows', {
    configurable: true,
    enumerable: false,
    get() { return rowArray; }
  });
  Object.defineProperty(dataset, '__columnarCompatibilityAttached', {
    value: true,
    configurable: true,
    enumerable: false
  });
  return dataset;
}

function rowsToColumnar(rows, sourceColumns = []) {
  const names = sourceColumns.length
    ? sourceColumns.slice()
    : Array.from(new Set((rows || []).flatMap(row => Object.keys(row || {}))));
  const columns = Object.create(null);
  names.forEach(name => {
    const values = new Float64Array(rows.length);
    values.fill(NaN);
    let finiteCount = 0;
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i]?.[name];
      const value = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isFinite(value)) {
        values[i] = value;
        finiteCount++;
      }
    }
    if (finiteCount) columns[name] = values;
  });
  return { columns, rowCount: rows.length };
}

function hydrateColumnarResult(result) {
  if (!result) return result;
  if (Array.isArray(result.columns)) {
    const columns = Object.create(null);
    result.columns.forEach(entry => {
      columns[entry.name] = new Float64Array(entry.buffer, 0, entry.length);
    });
    result.columns = columns;
  }
  if (!result.columns && Array.isArray(result.rows)) {
    const converted = rowsToColumnar(result.rows, result.metadata?.sourceColumns || []);
    result.columns = converted.columns;
    result.rowCount = converted.rowCount;
    delete result.rows;
  }
  result.rowCount = Number.isFinite(result.rowCount)
    ? result.rowCount
    : (Object.values(result.columns || {})[0]?.length || 0);
  return result;
}

const LARGE_FILE_BYTES = 50 * 1024 * 1024;
const SUPPORTED_CAPTURE_EXTENSION = /\.(csv|txt|json)$/i;

const FRAME_ALIASES = [
  { key:'frametime',             scale:1     },
  { key:'frametime(ms)',         scale:1     },
  { key:'frametimems',           scale:1     },
  { key:'frametime(us)',         scale:0.001 },
  { key:'frametimeus',           scale:0.001 },
  { key:'msbetweenpresents',     scale:1     },
  { key:'frame delta time(ms)',  scale:1     },
  { key:'framedeltatimems',      scale:1     }
];

function canonKey(str){
  return String(str ?? '').toLowerCase().replace(/\s+/g,'');
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

const STATS_METRIC_GROUPS = [
  { label: 'Performance - Rendered', metrics: ['RenderedFPS', 'MsBetweenPresents'] },
  { label: 'Performance - Displayed', metrics: ['DisplayedFPS', 'MsBetweenDisplayChange'] },
  {
    label: 'Smoothness - Rendered',
    metrics: [
      'Rendered_FTSD', 'Rendered_Coefficient_of_Variation',
      'Rendered_RMSSD', 'Rendered_Stepwise_Relative_SD'
    ]
  },
  {
    label: 'Smoothness - Displayed',
    metrics: [
      'Displayed_FTSD', 'Displayed_Coefficient_of_Variation',
      'Displayed_RMSSD', 'Displayed_Stepwise_Relative_SD'
    ]
  },
  { label: 'Distribution shape', metrics: ['Skewness', 'Kurtosis', 'Nonparametric_Skew'] },
  { label: 'GPU / latency', metrics: ['MsGPUBusy', 'MsUntilDisplayed'] }
];

window.showAdvancedMetrics = false;

function findCaseInsensitiveKey(row, candidate) {
  const target = String(candidate).toLowerCase();
  return Object.keys(row).find(key => key.toLowerCase() === target) || null;
}

/**
 * Adds legacy FrameTime/FPS aliases without conflating displayed timing with
 * presented timing. Displayed metrics are always sourced exclusively from
 * MsBetweenDisplayChange.
 */
function normaliseRow(row){
  const map = {};
  Object.keys(row).forEach(k => map[canonKey(k)] = k);

  if (row.FrameTime == null){
    for (const {key,scale} of FRAME_ALIASES){
      const match = map[canonKey(key)];
      if (!match) continue;
      const value = Number(row[match]);
      if (Number.isFinite(value) && value > 0){
        row.FrameTime = value * scale;
        break;
      }
    }
  }

  if (row.FPS == null){
    const fpsKey = map.fps;
    const fpsValue = fpsKey ? Number(row[fpsKey]) : NaN;
    if (Number.isFinite(fpsValue) && fpsValue > 0){
      row.FPS = fpsValue;
    } else if (Number.isFinite(row.FrameTime) && row.FrameTime > 0){
      row.FPS = 1000 / row.FrameTime;
    }
  }

  if (row.FrameTime == null && Number.isFinite(row.FPS) && row.FPS > 0){
    row.FrameTime = 1000 / row.FPS;
  }
}

function splitCsvRecords(text) {
  const records = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      current += char;
      if (inQuotes && text[i + 1] === '"') {
        current += text[++i];
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      records.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  if (inQuotes) throw new Error('CSV contains an unterminated quoted field.');
  if (current || !records.length) records.push(current);
  return records;
}

function countUnquotedDelimiter(record, delimiter) {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < record.length; i++) {
    const char = record[i];
    if (char === '"') {
      if (inQuotes && record[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && char === delimiter) {
      count++;
    }
  }
  return count;
}

function detectCsvDelimiter(headerRecord) {
  return [',', '\t', ';'].reduce((best, delimiter) => {
    const count = countUnquotedDelimiter(headerRecord, delimiter);
    return count > best.count ? { delimiter, count } : best;
  }, { delimiter: ',', count: -1 }).delimiter;
}

function parseCSVLine(line, delimiter) {
  const result = [];
  let inQuotes = false;
  let currentValue = '';

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        currentValue += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(currentValue);
      currentValue = '';
    } else {
      currentValue += char;
    }
  }
  if (inQuotes) throw new Error('CSV contains an unterminated quoted field.');
  result.push(currentValue);
  return result;
}

function makeUniqueHeaders(rawHeaders) {
  const counts = new Map();
  const duplicates = [];
  const headers = rawHeaders.map((value, index) => {
    const base = String(value ?? '').trim() || `Column ${index + 1}`;
    const key = base.toLowerCase();
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    if (count === 1) return base;
    duplicates.push(base);
    return `${base} (${count})`;
  });
  return { headers, duplicates: [...new Set(duplicates)] };
}

function parseNumericCsvValue(raw, delimiter) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const normalized = delimiter === ';' && /^[+-]?(?:\d+),(?:\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)
    ? trimmed.replace(',', '.')
    : trimmed;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : raw;
}

function isRecognisedTimingHeader(header) {
  const key = String(header).toLowerCase().replace(/[\s_()\[\]-]+/g, '');
  return /^(frametime|frametimems|frametimeus|framedeltatimems|msbetweenpresents|msbetweendisplaychange|msinpresentapi|msuntilrendercomplete|msuntilpresented|displayedframetime|renderedfps|displayedfps|fps)$/.test(key);
}

function parseCSVDetailed(text, fileName = 'capture') {
  const warnings = [];
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const records = splitCsvRecords(source).filter((record, index) => index === 0 || record.trim() !== '');
  if (!records.length || !records[0].trim()) {
    return { rows: [], warnings, metadata: { format: 'csv', sourceColumns: [] } };
  }

  const delimiter = detectCsvDelimiter(records[0]);
  const rawHeaders = parseCSVLine(records[0], delimiter);
  const { headers, duplicates } = makeUniqueHeaders(rawHeaders);
  if (duplicates.length) {
    warnings.push(`Duplicate column name(s) were disambiguated in ${fileName}: ${duplicates.join(', ')}.`);
  }
  if (!headers.some(isRecognisedTimingHeader)) {
    warnings.push(`No recognised timing column was found in ${fileName}. Detected: ${headers.slice(0, 8).join(', ') || 'none'}.`);
  }

  const rows = [];
  let malformedRows = 0;
  for (let i = 1; i < records.length; i++) {
    const values = parseCSVLine(records[i], delimiter);
    if (values.length !== headers.length) {
      malformedRows++;
      continue;
    }
    const row = {};
    for (let column = 0; column < headers.length; column++) {
      row[headers[column]] = parseNumericCsvValue(values[column], delimiter);
    }
    normaliseRow(row);
    rows.push(row);
  }

  if (malformedRows) {
    warnings.push(`Skipped ${malformedRows.toLocaleString()} malformed row(s) in ${fileName} because their column counts did not match the header.`);
  }

  return {
    rows,
    warnings,
    metadata: {
      format: 'csv',
      delimiter: delimiter === '\t' ? 'tab' : delimiter,
      sourceColumns: headers,
      malformedRows
    }
  };
}

function parseCSV(text) {
  return parseCSVDetailed(text).rows;
}

function parseCfxJsonDetailed(text, fileName = 'capture.json') {
  const warnings = [];
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { error: 'invalid_json', message: error.message, rows: [], warnings, metadata: { format: 'json' } };
  }
  if (!json?.Runs?.length) {
    return { rows: [], warnings: [`No Runs[] array was found in ${fileName}.`], metadata: { format: 'json', sourceColumns: [] } };
  }

  const rows = [];
  const sourceColumns = new Set();
  json.Runs.forEach((run, runIndex) => {
    const captureData = run?.CaptureData ?? {};
    const arrayFields = Object.entries(captureData).filter(([, value]) => Array.isArray(value));
    if (!arrayFields.length) return;
    arrayFields.forEach(([key]) => sourceColumns.add(key));

    const lengths = arrayFields.map(([, value]) => value.length);
    const frames = Math.min(...lengths);
    if (new Set(lengths).size > 1) {
      warnings.push(`CaptureData arrays in run ${runIndex + 1} of ${fileName} had different lengths and were trimmed to ${frames.toLocaleString()} frame(s).`);
    }
    for (let i = 0; i < frames; i++) {
      const row = {};
      arrayFields.forEach(([key, values]) => { row[key] = values[i]; });
      normaliseRow(row);
      rows.push(row);
    }
  });

  return {
    rows,
    warnings,
    metadata: { format: 'json', sourceColumns: [...sourceColumns] }
  };
}

function parseCfxJson(text, fileName) {
  const result = parseCfxJsonDetailed(text, fileName);
  return result.error ? { error: result.error, message: result.message } : result.rows;
}

let dataWorker = null;
let dataWorkerUrl = null;
let dataWorkerRequestId = 0;
let dataWorkerChunkSequence = 0;
const dataWorkerRequests = new Map();
const dataWorkerChunkAcks = new Map();

function getDataWorkerSource() {
  return `
const states = new Map();
const FRAME_ALIASES = ${JSON.stringify(FRAME_ALIASES)};
function canonKey(str){ return String(str ?? '').toLowerCase().replace(/\\s+/g,''); }
function countUnquotedDelimiter(record, delimiter) {
  let count = 0, inQuotes = false;
  for (let i = 0; i < record.length; i++) {
    const char = record[i];
    if (char === '"') {
      if (inQuotes && record[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && char === delimiter) count++;
  }
  return count;
}
function detectCsvDelimiter(headerRecord) {
  return [',', '\\t', ';'].reduce((best, delimiter) => {
    const count = countUnquotedDelimiter(headerRecord, delimiter);
    return count > best.count ? { delimiter, count } : best;
  }, { delimiter: ',', count: -1 }).delimiter;
}
function parseCSVLine(line, delimiter) {
  const result = []; let inQuotes = false, currentValue = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { currentValue += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) { result.push(currentValue); currentValue = ''; }
    else currentValue += char;
  }
  if (inQuotes) throw new Error('CSV contains an unterminated quoted field.');
  result.push(currentValue); return result;
}
function makeUniqueHeaders(rawHeaders) {
  const counts = new Map(), duplicates = [];
  const headers = rawHeaders.map((value, index) => {
    const base = String(value ?? '').trim() || ('Column ' + (index + 1));
    const key = base.toLowerCase(), count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    if (count === 1) return base;
    duplicates.push(base); return base + ' (' + count + ')';
  });
  return { headers, duplicates: [...new Set(duplicates)] };
}
function parseNumericCsvValue(raw, delimiter) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return NaN;
  const normalized = delimiter === ';' && /^[+-]?(?:\\d+),(?:\\d+)(?:[eE][+-]?\\d+)?$/.test(trimmed)
    ? trimmed.replace(',', '.') : trimmed;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : NaN;
}
function isRecognisedTimingHeader(header) {
  const key = String(header).toLowerCase().replace(/[\\s_()\\[\\]-]+/g, '');
  return /^(frametime|frametimems|frametimeus|framedeltatimems|msbetweenpresents|msbetweendisplaychange|msinpresentapi|msuntilrendercomplete|msuntilpresented|displayedframetime|renderedfps|displayedfps|fps)$/.test(key);
}
const COLUMN_CHUNK_SIZE = 65536;
class ColumnBuilder {
  constructor(initialLength = 0) {
    this.chunks = [];
    this.current = new Float64Array(COLUMN_CHUNK_SIZE);
    this.current.fill(NaN);
    this.used = 0;
    this.length = 0;
    if (initialLength) this.fill(NaN, initialLength);
  }
  sealCurrent() {
    if (this.used !== COLUMN_CHUNK_SIZE) return;
    this.chunks.push(this.current);
    this.current = new Float64Array(COLUMN_CHUNK_SIZE);
    this.current.fill(NaN);
    this.used = 0;
  }
  push(value) {
    this.sealCurrent();
    this.current[this.used++] = value;
    this.length++;
  }
  fill(value, count) {
    let remaining = Math.max(0, count | 0);
    while (remaining > 0) {
      this.sealCurrent();
      const available = COLUMN_CHUNK_SIZE - this.used;
      const take = Math.min(available, remaining);
      this.current.fill(value, this.used, this.used + take);
      this.used += take;
      this.length += take;
      remaining -= take;
    }
  }
  toTyped(targetLength = this.length) {
    const result = new Float64Array(targetLength);
    result.fill(NaN);
    let offset = 0;
    for (const chunk of this.chunks) {
      const take = Math.min(chunk.length, targetLength - offset);
      if (take <= 0) break;
      result.set(take === chunk.length ? chunk : chunk.subarray(0, take), offset);
      offset += take;
    }
    if (offset < targetLength && this.used) {
      const take = Math.min(this.used, targetLength - offset);
      result.set(this.current.subarray(0, take), offset);
    }
    return result;
  }
}
function makeState(id, fileName) {
  return { id, fileName, decoder: new TextDecoder('utf-8'), record: '', inQuotes: false,
    pendingQuote: false, skipLf: false, headerReady: false, delimiter: ',', headers: [],
    builders: [], numericCounts: [], rowCount: 0, malformedRows: 0, warnings: [], bytesRead: 0 };
}
function acceptRecord(state, record) {
  if (!state.headerReady) {
    record = record.replace(/^\\uFEFF/, '');
    if (!record.trim()) return;
    state.delimiter = detectCsvDelimiter(record);
    const unique = makeUniqueHeaders(parseCSVLine(record, state.delimiter));
    state.headers = unique.headers;
    state.builders = state.headers.map(() => null);
    state.numericCounts = state.headers.map(() => 0);
    if (unique.duplicates.length) state.warnings.push('Duplicate column name(s) were disambiguated in ' + state.fileName + ': ' + unique.duplicates.join(', ') + '.');
    if (!state.headers.some(isRecognisedTimingHeader)) state.warnings.push('No recognised timing column was found in ' + state.fileName + '. Detected: ' + (state.headers.slice(0, 8).join(', ') || 'none') + '.');
    state.headerReady = true; return;
  }
  if (!record.trim()) return;
  const values = parseCSVLine(record, state.delimiter);
  if (values.length !== state.headers.length) { state.malformedRows++; return; }
  for (let i = 0; i < state.headers.length; i++) {
    const value = parseNumericCsvValue(values[i], state.delimiter);
    if (Number.isFinite(value)) {
      if (!state.builders[i]) state.builders[i] = new ColumnBuilder(state.rowCount);
      state.builders[i].push(value);
      state.numericCounts[i]++;
    } else if (state.builders[i]) {
      state.builders[i].push(NaN);
    }
  }
  state.rowCount++;
}
function feedText(state, text, final = false) {
  for (let i = 0; i < text.length; i++) {
    let char = text[i];
    if (state.skipLf) { state.skipLf = false; if (char === '\\n') continue; }
    if (state.pendingQuote) {
      if (char === '"') { state.record += '""'; state.pendingQuote = false; continue; }
      state.record += '"'; state.inQuotes = false; state.pendingQuote = false;
    }
    if (char === '"') {
      if (state.inQuotes) state.pendingQuote = true;
      else { state.record += char; state.inQuotes = true; }
      continue;
    }
    if ((char === '\\n' || char === '\\r') && !state.inQuotes) {
      acceptRecord(state, state.record); state.record = '';
      if (char === '\\r') state.skipLf = true;
      continue;
    }
    state.record += char;
  }
  if (final) {
    if (state.pendingQuote) { state.record += '"'; state.pendingQuote = false; state.inQuotes = false; }
    if (state.inQuotes) throw new Error('CSV contains an unterminated quoted field.');
    if (state.record || !state.headerReady) acceptRecord(state, state.record);
  }
}
function finishCsv(state) {
  const columns = [], transfers = [];
  for (let i = 0; i < state.headers.length; i++) {
    if (!state.numericCounts[i] || !state.builders[i]) continue;
    if (state.builders[i].length < state.rowCount) state.builders[i].fill(NaN, state.rowCount - state.builders[i].length);
    const typed = state.builders[i].toTyped(state.rowCount);
    columns.push({ name: state.headers[i], buffer: typed.buffer, length: typed.length });
    transfers.push(typed.buffer);
  }
  if (state.malformedRows) state.warnings.push('Skipped ' + state.malformedRows.toLocaleString() + ' malformed row(s) in ' + state.fileName + ' because their column counts did not match the header.');
  return { result: { columns, rowCount: state.rowCount, warnings: state.warnings,
    metadata: { format: 'csv', delimiter: state.delimiter === '\\t' ? 'tab' : state.delimiter,
      sourceColumns: state.headers, malformedRows: state.malformedRows, storage: 'columnar-float64' } }, transfers };
}
function jsonToColumns(text, fileName) {
  const warnings = []; let json;
  try { json = JSON.parse(text); } catch (error) { return { result: { error: 'invalid_json', message: error.message, columns: [], rowCount: 0, warnings, metadata: { format: 'json' } }, transfers: [] }; }
  if (!json?.Runs?.length) return { result: { columns: [], rowCount: 0, warnings: ['No Runs[] array was found in ' + fileName + '.'], metadata: { format: 'json', sourceColumns: [] } }, transfers: [] };
  const sourceColumns = new Set();
  const runs = [];
  let totalRows = 0;
  json.Runs.forEach((run, runIndex) => {
    const fields = Object.entries(run?.CaptureData ?? {}).filter(([, value]) => Array.isArray(value));
    if (!fields.length) return;
    fields.forEach(([key]) => sourceColumns.add(key));
    const lengths = fields.map(([, value]) => value.length), frames = Math.min(...lengths);
    if (new Set(lengths).size > 1) warnings.push('CaptureData arrays in run ' + (runIndex + 1) + ' of ' + fileName + ' had different lengths and were trimmed to ' + frames.toLocaleString() + ' frame(s).');
    runs.push({ fields, frames, offset: totalRows });
    totalRows += frames;
  });
  const typedColumns = new Map();
  const numericCounts = new Map();
  for (const name of sourceColumns) {
    const typed = new Float64Array(totalRows);
    typed.fill(NaN);
    typedColumns.set(name, typed);
    numericCounts.set(name, 0);
  }
  runs.forEach(({ fields, frames, offset }) => {
    fields.forEach(([name, values]) => {
      const target = typedColumns.get(name);
      let count = numericCounts.get(name) || 0;
      for (let i = 0; i < frames; i++) {
        const value = Number(values[i]);
        if (Number.isFinite(value)) { target[offset + i] = value; count++; }
      }
      numericCounts.set(name, count);
    });
  });
  const columns = [], transfers = [];
  for (const [name, typed] of typedColumns) {
    if (!numericCounts.get(name)) continue;
    columns.push({ name, buffer: typed.buffer, length: typed.length });
    transfers.push(typed.buffer);
  }
  return { result: { columns, rowCount: totalRows, warnings, metadata: { format: 'json', sourceColumns: [...sourceColumns], storage: 'columnar-float64' } }, transfers };
}
self.onmessage = function(event) {
  const data = event.data || {};
  try {
    if (data.type === 'startCsv') { states.set(data.id, makeState(data.id, data.fileName)); self.postMessage({ id: data.id, type: 'started' }); return; }
    if (data.type === 'csvChunk') {
      const state = states.get(data.id); if (!state) throw new Error('CSV stream state is unavailable.');
      const text = state.decoder.decode(data.buffer, { stream: !data.final });
      state.bytesRead = data.bytesRead || state.bytesRead; feedText(state, text, Boolean(data.final));
      if (data.final) { const finished = finishCsv(state); states.delete(data.id); self.postMessage({ id: data.id, type: 'result', result: finished.result }, finished.transfers); }
      else self.postMessage({ id: data.id, type: 'chunkAck', sequence: data.sequence, rowCount: state.rowCount, bytesRead: state.bytesRead });
      return;
    }
    if (data.type === 'fullCsv') {
      const text = new TextDecoder('utf-8').decode(data.buffer);
      const state = makeState(data.id, data.fileName);
      feedText(state, text, true);
      const finished = finishCsv(state);
      self.postMessage({ id: data.id, type: 'result', result: finished.result }, finished.transfers);
      return;
    }
    if (data.type === 'json') {
      const text = new TextDecoder('utf-8').decode(data.buffer); const finished = jsonToColumns(text, data.fileName);
      self.postMessage({ id: data.id, type: 'result', result: finished.result }, finished.transfers); return;
    }
  } catch (error) { states.delete(data.id); self.postMessage({ id: data.id, type: 'error', error: error?.message || String(error) }); }
};`;
}

function resetDataWorker(error) {
  if (dataWorker) dataWorker.terminate();
  if (dataWorkerUrl) URL.revokeObjectURL(dataWorkerUrl);
  dataWorker = null; dataWorkerUrl = null;
  if (error) {
    dataWorkerRequests.forEach(({ reject, cleanup }) => { cleanup?.(); reject(error); });
    dataWorkerRequests.clear();
    dataWorkerChunkAcks.forEach(({ reject }) => reject(error));
    dataWorkerChunkAcks.clear();
  }
}

function getDataWorker() {
  if (dataWorker) return dataWorker;
  if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') return null;
  dataWorkerUrl = URL.createObjectURL(new Blob([getDataWorkerSource()], { type: 'text/javascript' }));
  dataWorker = new Worker(dataWorkerUrl);
  dataWorker.onmessage = event => {
    const { id, type, result, error, sequence, rowCount, bytesRead } = event.data || {};
    if (type === 'chunkAck') {
      const ack = dataWorkerChunkAcks.get(sequence); if (!ack) return;
      dataWorkerChunkAcks.delete(sequence); ack.resolve({ rowCount, bytesRead }); return;
    }
    if (type === 'started') return;
    if (type === 'error' || error) {
      resetDataWorker(new Error(error || 'The capture parser worker failed.'));
      return;
    }
    const request = dataWorkerRequests.get(id); if (!request) return;
    dataWorkerRequests.delete(id); request.cleanup?.();
    request.resolve(hydrateColumnarResult(result));
  };
  dataWorker.onerror = event => resetDataWorker(new Error(event.message || 'The capture parser worker failed.'));
  return dataWorker;
}

let activeImportSession = null;

function makeImportAbortError(message = 'Import cancelled.') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function setImportUiBusy(busy) {
  const fileInput = document.getElementById('fileInput');
  const dropZone = document.getElementById('dropZone');
  const cancelButton = document.getElementById('cancelImportBtn');
  if (fileInput) fileInput.disabled = busy;
  dropZone?.classList.toggle('is-busy', busy);
  dropZone?.setAttribute('aria-busy', String(busy));
  if (cancelButton) cancelButton.disabled = !busy;
}

function updateImportProgress(session, {
  fileIndex = Math.max(0, session.completedFiles),
  fileName = '',
  stage = 'Preparing import…',
  fileProgress = 0,
  rowCount = null,
  forcePercent = null,
  visible = true
} = {}) {
  const panel = document.getElementById('importProgressPanel');
  const bar = document.getElementById('importProgressBar');
  const files = document.getElementById('importProgressFiles');
  const currentFile = document.getElementById('importProgressFile');
  const percentLabel = document.getElementById('importProgressPercent');
  const stageLabel = document.getElementById('importProgressStage');
  if (!panel || !bar) return;

  panel.classList.toggle('hidden', !visible);
  panel.setAttribute('aria-hidden', String(!visible));
  if (!visible) return;

  const total = Math.max(1, session.totalFiles || 1);
  const boundedFileProgress = Math.min(1, Math.max(0, Number(fileProgress) || 0));
  const rawPercent = forcePercent == null
    ? ((Math.min(fileIndex, total - 1) + boundedFileProgress) / total) * 100
    : forcePercent;
  const percent = Math.min(100, Math.max(0, Math.round(rawPercent)));

  bar.value = percent;
  bar.setAttribute('aria-valuetext', `${percent}% — ${stage}`);
  if (files) files.textContent = `${Math.min(fileIndex + 1, total)} of ${total} files`;
  if (currentFile) currentFile.textContent = fileName || 'Preparing…';
  if (percentLabel) percentLabel.textContent = `${percent}%`;
  if (stageLabel) {
    const rows = Number.isFinite(rowCount) ? ` · ${rowCount.toLocaleString()} rows` : '';
    stageLabel.textContent = `${stage}${rows}`;
  }
}

function finishImportProgress(session, message, { cancelled = false } = {}) {
  const panel = document.getElementById('importProgressPanel');
  const title = document.getElementById('importProgressTitle');
  const stage = document.getElementById('importProgressStage');
  const file = document.getElementById('importProgressFile');
  const bar = document.getElementById('importProgressBar');
  const percent = document.getElementById('importProgressPercent');
  const files = document.getElementById('importProgressFiles');
  if (!panel) return;

  panel.classList.remove('hidden');
  panel.setAttribute('aria-hidden', 'false');
  if (title) title.textContent = cancelled ? 'Import cancelled' : 'Import complete';
  if (stage) stage.textContent = message;
  if (file) file.textContent = cancelled ? 'Completed datasets were kept.' : 'All requested files were processed.';
  if (files) files.textContent = `${session.completedFiles} of ${session.totalFiles} files`;
  if (bar) bar.value = cancelled
    ? Math.round((session.completedFiles / Math.max(1, session.totalFiles)) * 100)
    : 100;
  if (percent) percent.textContent = `${bar?.value ?? 100}%`;

  window.setTimeout(() => {
    if (activeImportSession === session) return;
    panel.classList.add('hidden');
    panel.setAttribute('aria-hidden', 'true');
    if (title) title.textContent = 'Importing captures';
  }, 1800);
}

function readFileAsArrayBuffer(file, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(makeImportAbortError()); return; }
    const reader = new FileReader();
    if (activeImportSession) activeImportSession.reader = reader;
    let settled = false;
    const cleanup = () => { signal?.removeEventListener('abort', abort); if (activeImportSession?.reader === reader) activeImportSession.reader = null; };
    const finish = (callback, value) => { if (settled) return; settled = true; cleanup(); callback(value); };
    const abort = () => { try { reader.abort(); } catch (_) {} finish(reject, makeImportAbortError()); };
    signal?.addEventListener('abort', abort, { once: true });
    reader.onprogress = event => { if (event.lengthComputable) onProgress?.(event.loaded, event.total); };
    reader.onerror = () => finish(reject, reader.error || new Error(`Could not read ${file.name}.`));
    reader.onabort = () => finish(reject, makeImportAbortError());
    reader.onload = () => finish(resolve, reader.result);
    reader.readAsArrayBuffer(file);
  });
}

function postWorkerChunk(worker, payload, transfer) {
  const sequence = ++dataWorkerChunkSequence;
  payload.sequence = sequence;
  return new Promise((resolve, reject) => {
    dataWorkerChunkAcks.set(sequence, { resolve, reject });
    worker.postMessage(payload, transfer);
  });
}

async function parseCsvStream(file, { signal, onReadProgress, onParseProgress } = {}) {
  const worker = getDataWorker();
  if (!worker || typeof file.stream !== 'function') return null;
  const id = ++dataWorkerRequestId;
  const resultPromise = new Promise((resolve, reject) => {
    const abort = () => resetDataWorker(makeImportAbortError());
    const cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    dataWorkerRequests.set(id, { resolve, reject, cleanup });
  });
  // The current chunk acknowledgement may reject before this final-result
  // promise is awaited during cancellation. Register a handler immediately so
  // an intentional abort never surfaces as an unhandled rejection.
  resultPromise.catch(() => {});
  worker.postMessage({ type: 'startCsv', id, fileName: file.name });
  const reader = file.stream().getReader();
  if (activeImportSession) activeImportSession.streamReader = reader;
  let bytesRead = 0;
  let lastProgressAt = 0;
  let lastProgressBytes = 0;
  try {
    while (true) {
      if (signal?.aborted) throw makeImportAbortError();
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      const buffer = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
        ? value.buffer
        : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      const ack = await postWorkerChunk(worker, { type: 'csvChunk', id, buffer, final: false, bytesRead }, [buffer]);

      // Updating several DOM nodes for every small stream chunk can become a
      // measurable cost on low-end systems. Report at most about ten times per
      // second, while still forcing updates after meaningful byte progress.
      const now = Date.now();
      const shouldReport = bytesRead >= file.size ||
        now - lastProgressAt >= 100 ||
        bytesRead - lastProgressBytes >= 2 * 1024 * 1024;
      if (shouldReport) {
        if (onParseProgress) onParseProgress(ack.rowCount, bytesRead, file.size);
        else onReadProgress?.(bytesRead, file.size);
        lastProgressAt = now;
        lastProgressBytes = bytesRead;
      }
    }
    const empty = new ArrayBuffer(0);
    worker.postMessage({ type: 'csvChunk', id, buffer: empty, final: true, bytesRead }, [empty]);
    return await resultPromise;
  } catch (error) {
    try { await reader.cancel(); } catch (_) {}
    if (dataWorkerRequests.has(id)) resetDataWorker(error?.name === 'AbortError' ? error : new Error(error.message));
    throw error;
  } finally {
    if (activeImportSession?.streamReader === reader) activeImportSession.streamReader = null;
  }
}

async function parseCaptureFile(file, { signal, onReadProgress, onStage, onParseProgress } = {}) {
  const isJson = file.name.toLowerCase().endsWith('.json');
  if (!isJson) {
    onStage?.('Streaming and parsing rows');
    const streamed = await parseCsvStream(file, { signal, onReadProgress, onParseProgress });
    if (streamed) return streamed;
  }

  onStage?.('Reading file');
  const buffer = await readFileAsArrayBuffer(file, { signal, onProgress: onReadProgress });
  if (signal?.aborted) throw makeImportAbortError();
  onStage?.('Parsing rows');
  const worker = getDataWorker();
  if (worker) {
    const id = ++dataWorkerRequestId;
    return new Promise((resolve, reject) => {
      const abort = () => { if (dataWorkerRequests.has(id)) resetDataWorker(makeImportAbortError()); };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      signal?.addEventListener('abort', abort, { once: true });
      dataWorkerRequests.set(id, { resolve, reject, cleanup });
      worker.postMessage({ type: isJson ? 'json' : 'fullCsv', id, buffer, fileName: file.name }, [buffer]);
    });
  }
  const text = new TextDecoder('utf-8').decode(buffer);
  return hydrateColumnarResult(isJson ? parseCfxJsonDetailed(text, file.name) : parseCSVDetailed(text, file.name));
}

function cancelCaptureImport() {
  const session = activeImportSession;
  if (!session || session.cancelled) return false;
  session.cancelled = true;
  session.controller?.abort();
  try { session.reader?.abort?.(); } catch (_) {}
  try {
    const cancellation = session.streamReader?.cancel?.();
    cancellation?.catch?.(() => {});
  } catch (_) {}
  resetDataWorker(makeImportAbortError());
  updateImportProgress(session, {
    fileIndex: Math.min(session.completedFiles, Math.max(0, session.totalFiles - 1)),
    fileName: session.currentFileName || '',
    stage: 'Cancelling import…',
    fileProgress: 0
  });
  return true;
}

function yieldToMainThread() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

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

function resolveDuplicateDataset(fileName, signal = null) {
  if (signal?.aborted) return Promise.resolve({ action: 'cancel', name: fileName, existingIndex: -1 });
  const existingIndex = (window.allDatasets || []).findIndex(dataset => dataset.name === fileName);
  if (existingIndex === -1) return Promise.resolve({ action: 'add', name: fileName, existingIndex: -1 });

  if (typeof HTMLDialogElement === 'undefined') {
    return Promise.resolve({ action: 'rename', name: makeUniqueDatasetName(fileName), existingIndex });
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
    replaceButton.type = keepBothButton.type = cancelButton.type = 'button';
    replaceButton.textContent = 'Replace';
    keepBothButton.textContent = 'Keep both';
    cancelButton.textContent = 'Cancel';
    actions.append(replaceButton, keepBothButton, cancelButton);
    dialog.append(title, description, actions);
    document.body.appendChild(dialog);

    let action = 'cancel';
    const closeDialog = nextAction => {
      action = nextAction;
      if (dialog.open) dialog.close();
    };
    const abortDialog = () => closeDialog('cancel');
    signal?.addEventListener('abort', abortDialog, { once: true });
    replaceButton.addEventListener('click', () => closeDialog('replace'));
    keepBothButton.addEventListener('click', () => closeDialog('rename'));
    cancelButton.addEventListener('click', () => closeDialog('cancel'));
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog('cancel'); });
    dialog.addEventListener('close', () => {
      signal?.removeEventListener('abort', abortDialog);
      dialog.remove();
      previouslyFocused?.focus?.();
      resolve({ action, name: action === 'rename' ? makeUniqueDatasetName(fileName) : fileName, existingIndex });
    }, { once: true });

    dialog.showModal();
    replaceButton.focus();
  });
}

async function handleFileUpload(e) {
  const files = Array.from(e?.target?.files || []);
  if (!files.length) return;

  if (activeImportSession) {
    window.notify?.('An import is already running. Cancel it before starting another.', 'warning');
    return;
  }

  const inputElement = e.target;
  const session = {
    totalFiles: files.length,
    completedFiles: 0,
    currentFileName: '',
    cancelled: false,
    controller: null,
    reader: null,
    streamReader: null
  };
  activeImportSession = session;
  setImportUiBusy(true);
  updateImportProgress(session, { fileIndex: 0, stage: 'Preparing import…', fileProgress: 0 });

  let successCount = 0;
  let errorCount = 0;
  let renamedCount = 0;
  let replacedCount = 0;
  let skippedCount = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    if (session.cancelled) break;
    const file = files[fileIndex];
    session.currentFileName = file.name;
    session.controller = new AbortController();
    const signal = session.controller.signal;

    if (!SUPPORTED_CAPTURE_EXTENSION.test(file.name)) {
      window.notify?.(`Unsupported file type: ${file.name}`, 'warning');
      errorCount++;
      session.completedFiles = fileIndex + 1;
      updateImportProgress(session, {
        fileIndex,
        fileName: file.name,
        stage: 'Unsupported file type',
        fileProgress: 1
      });
      await yieldToMainThread();
      continue;
    }

    if (file.size >= LARGE_FILE_BYTES) {
      window.notify?.(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. It will be processed one file at a time in a background worker, but a capture this large can still use substantial memory.`, 'warning');
    }

    try {
      updateImportProgress(session, {
        fileIndex,
        fileName: file.name,
        stage: 'Reading file',
        fileProgress: 0
      });

      const parsed = await parseCaptureFile(file, {
        signal,
        onReadProgress(loaded, total) {
          const fraction = total > 0 ? loaded / total : 0;
          updateImportProgress(session, {
            fileIndex,
            fileName: file.name,
            stage: `Reading file — ${(loaded / 1024 / 1024).toFixed(1)} of ${(total / 1024 / 1024).toFixed(1)} MB`,
            fileProgress: Math.min(0.58, fraction * 0.58)
          });
        },
        onStage(stage) {
          if (stage === 'Parsing rows' || stage === 'Streaming and parsing rows') {
            updateImportProgress(session, {
              fileIndex,
              fileName: file.name,
              stage: stage === 'Streaming and parsing rows' ? 'Streaming and parsing rows' : 'Parsing rows in background worker',
              fileProgress: 0.68
            });
          }
        },
        onParseProgress(rowCount, loaded, total) {
          const fraction = total > 0 ? loaded / total : 0;
          updateImportProgress(session, {
            fileIndex, fileName: file.name,
            stage: `Streaming CSV — ${(loaded / 1024 / 1024).toFixed(1)} of ${(total / 1024 / 1024).toFixed(1)} MB`,
            fileProgress: Math.min(0.82, fraction * 0.82), rowCount
          });
        }
      });

      if (signal.aborted || session.cancelled) throw makeImportAbortError();
      updateImportProgress(session, {
        fileIndex,
        fileName: file.name,
        stage: 'Validating metrics',
        fileProgress: 0.84,
        rowCount: parsed?.rowCount ?? null
      });

      (parsed.warnings || []).forEach(message => window.notify?.(message, 'warning'));
      if (parsed?.error === 'invalid_json') {
        throw new Error(`Invalid JSON: ${parsed.message}`);
      }
      if (!parsed?.rowCount) {
        throw new Error('No valid data rows were found.');
      }

      const duplicate = await resolveDuplicateDataset(file.name, signal);
      if (signal.aborted || session.cancelled) throw makeImportAbortError();
      if (duplicate.action === 'cancel') {
        skippedCount++;
      } else {
        updateImportProgress(session, {
          fileIndex,
          fileName: file.name,
          stage: 'Finalizing dataset',
          fileProgress: 0.94,
          rowCount: parsed.rowCount
        });

        const datasetObj = attachDatasetCompatibility({
          id: duplicate.action === 'replace'
            ? (window.allDatasets[duplicate.existingIndex]?.id ?? window.nextDatasetId++)
            : window.nextDatasetId++,
          name: duplicate.name,
          columns: parsed.columns,
          rowCount: parsed.rowCount,
          source: parsed.metadata || null
        });

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

        // One controlled refresh per completed file keeps the UI responsive
        // without repeatedly rebuilding controls during parsing.
        refreshDatasetLists();
      }
    } catch (error) {
      if (error?.name === 'AbortError' || session.cancelled) {
        session.cancelled = true;
        break;
      }
      console.error(`Error parsing ${file.name}:`, error);
      window.notify?.(`Error parsing ${file.name}: ${error.message}`, 'error');
      errorCount++;
    } finally {
      session.controller = null;
      session.reader = null;
    }

    session.completedFiles = fileIndex + 1;
    updateImportProgress(session, {
      fileIndex,
      fileName: file.name,
      stage: 'File complete',
      fileProgress: 1
    });
    await yieldToMainThread();
  }

  if (replacedCount > 0) {
    window.clearChart?.();
    window.resetStatsPanel?.();
    window.resetReliabilityPanel?.();
  }
  if (!successCount) refreshDatasetLists();

  const summaryParts = [];
  if (successCount) summaryParts.push(`Loaded ${successCount} file(s).`);
  if (renamedCount) summaryParts.push(`Renamed ${renamedCount} duplicate(s).`);
  if (replacedCount) summaryParts.push(`Replaced ${replacedCount} existing dataset(s).`);
  if (skippedCount) summaryParts.push(`Skipped ${skippedCount} duplicate(s).`);
  if (errorCount) summaryParts.push(`${errorCount} file(s) had errors.`);

  const wasCancelled = session.cancelled;
  const summary = wasCancelled
    ? `Import cancelled. ${successCount} completed file(s) were kept.`
    : (summaryParts.join(' ') || 'No files were imported.');

  activeImportSession = null;
  setImportUiBusy(false);
  finishImportProgress(session, summary, { cancelled: wasCancelled });
  window.notify?.(summary, wasCancelled || errorCount || skippedCount ? 'warning' : 'success');

  if (inputElement && 'value' in inputElement) inputElement.value = '';
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
      label.textContent = `${ds.name} (${getDatasetRowCount(ds)} rows)`;
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
function columnHasFiniteValue(column, { positive = false } = {}) {
  if (!column?.length) return false;
  for (let i = 0; i < column.length; i++) {
    const value = column[i];
    if (Number.isFinite(value) && (!positive || value > 0)) return true;
  }
  return false;
}

function numericColumnsForDataset(ds) {
  if (!getDatasetRowCount(ds)) return new Set();

  const numeric = new Set();
  getDatasetColumnNames(ds).forEach(columnName => {
    if (METRIC_BLACKLIST.has(columnName)) return;
    if (columnHasFiniteValue(getDatasetColumn(ds, columnName))) numeric.add(columnName);
  });

  const renderedTimingSource = getDatasetRenderedTimingSource(ds);
  const renderedTiming = renderedTimingSource?.column || null;
  const displayedTiming = getDatasetColumn(
    ds,
    'MsBetweenDisplayChange',
    'MsBetweenDisplayChanges',
    'DisplayedFrameTime'
  );
  const renderedFps = getDatasetColumn(ds, 'RenderedFPS', 'FPS');
  const displayedFps = getDatasetColumn(ds, 'DisplayedFPS');
  const gpuBusy = getDatasetColumn(ds, 'MsGPUBusy', 'GPUBusy', 'MsGpuBusy');
  const untilDisplayed = getDatasetColumn(ds, 'MsUntilDisplayed', 'MsUntilDisplayComplete');

  const hasRenderedTiming = columnHasFiniteValue(renderedTiming, { positive: true });
  const hasDisplayedTiming = columnHasFiniteValue(displayedTiming, { positive: true });
  const hasRenderedFps = columnHasFiniteValue(renderedFps, { positive: true }) || hasRenderedTiming;
  const hasDisplayedFps = columnHasFiniteValue(displayedFps, { positive: true }) || hasDisplayedTiming;

  if (hasRenderedTiming) numeric.add('FrameTime');
  if (hasRenderedFps) {
    numeric.add('FPS');
    numeric.add('RenderedFPS');
  }
  if (hasDisplayedTiming) numeric.add('DisplayedFrameTime');
  if (hasDisplayedFps) numeric.add('DisplayedFPS');
  if (columnHasFiniteValue(gpuBusy)) numeric.add('MsGPUBusy');
  if (columnHasFiniteValue(untilDisplayed)) numeric.add('MsUntilDisplayed');

  if (hasRenderedTiming) {
    numeric.add('Rendered_FTSD');
    numeric.add('Rendered_Coefficient_of_Variation');
    numeric.add('Rendered_RMSSD');
    numeric.add('Rendered_Stepwise_Relative_SD');
    numeric.add('Skewness');
    numeric.add('Kurtosis');
    numeric.add('Nonparametric_Skew');
  }
  if (hasDisplayedTiming) {
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
      metrics = ['RenderedFPS', 'DisplayedFPS'].filter(metric =>
        pool.some(dataset => numericColumnsForDataset(dataset).has(metric))
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
  'FPS': 'Legacy FPS (Present)',
  'FrameTime': 'Frame Time (Present)',
  'RenderedFPS': 'Rendered FPS (Presented)',
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
    'FPS': 'Legacy FPS (Present timing)',
    'DisplayedFrameTime': 'Displayed Frame Time (ms)',
    'RenderedFPS': 'Rendered FPS (Presented / MsBetweenPresents)',
    'DisplayedFPS': 'Displayed FPS (On-screen / MsBetweenDisplayChange)',
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
    'FrameTime': 'Time between app present calls (MsBetweenPresents). Not the same as display cadence - use Displayed FPS for on-screen timing.',
    'FPS': 'Frames per second from present timing (MsBetweenPresents, harmonic mean). Not display-based - use Displayed FPS for what appears on screen.',
    'RenderedFPS': 'Application Present() rate derived from MsBetweenPresents (1000 / ms). This is rendered/presented cadence, not on-screen image-change cadence.',
    'DisplayedFPS': 'Actual on-screen image-change rate derived only from MsBetweenDisplayChange (1000 / ms).',
    'DisplayedFrameTime': 'Time between actual on-screen image changes (MsBetweenDisplayChange).',
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
window.parseCSVDetailed = parseCSVDetailed;
window.parseCfxJson = parseCfxJson;
window.parseCaptureFile = parseCaptureFile;
window.normaliseRow = normaliseRow;
window.handleFileUpload = handleFileUpload;
window.cancelCaptureImport = cancelCaptureImport;
window.refreshDatasetLists = refreshDatasetLists;
window.getDatasetIndexById = getDatasetIndexById;
window.getDatasetRowCount = getDatasetRowCount;
window.getDatasetColumn = getDatasetColumn;
window.getDatasetColumnNames = getDatasetColumnNames;
window.getDatasetRenderedTimingSource = getDatasetRenderedTimingSource;
window.attachDatasetCompatibility = attachDatasetCompatibility;
window.updateMetricDropdowns = updateMetricDropdowns;
window.getMetricDisplayName = getMetricDisplayName;
window.parseCSVLine = parseCSVLine;
