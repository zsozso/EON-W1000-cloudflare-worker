import PostalMime from 'postal-mime';

export interface Env {
  HA_URL: string;
  HA_TOKEN: string;
  UPDATE_INPUT_NUMBERS?: string;
  WORKER_SECRET?: string;
}

// ── Data structures (based on the Go code) ──────────────────────────

interface RowPiece {
  /** Hour-truncated timestamp (unix ms) */
  startMs: number;
  ap: number | null;
  am: number | null;
  m180: number | null;
  m280: number | null;
}

interface AggregatedHour {
  startMs: number;
  ap: number;
  am: number;
  m180: number | null;
  m280: number | null;
}

interface CalculatedRow {
  startISO: string;
  ap: number;
  am: number;
  m180: number;
  m280: number;
}

// ── HA entity IDs ───────────────────────────────────────────────────

const ENTITY_IMPORT_STAT_ID = 'eon:grid_energy_import';
const ENTITY_EXPORT_STAT_ID = 'eon:grid_energy_export';
const INPUT_NUMBER_IMPORT = 'input_number.grid_import_meter';
const INPUT_NUMBER_EXPORT = 'input_number.grid_export_meter';

// ── Timestamp parsing ───────────────────────────────────────────────

/**
 * Parse the EON timestamp format.
 *
 * The Go code does:
 *   strings.ReplaceAll(value, ".", "-") + ":00"
 *   then time.ParseInLocation(time.DateTime, ..., time.Local)
 *   then subtracts 1 hour
 *
 * EON format examples:
 *   "2024.01.15 08:30"  → after Go transform → "2024-01-15 08:30:00"
 *   "2024.01.15. 08:30" → after Go transform → "2024-01-15- 08:30:00" (invalid, skipped)
 *
 * We handle the trailing dot/dash gracefully.
 */
function parsePossibleTime(value: string): number | null {
  value = value.trim();
  if (!value) return null;

  // Try parsing as numeric Excel serial date (e.g. 46207 or 46207.01042)
  const num = Number(value);
  if (!isNaN(num) && num > 30000 && num < 60000) {
    const utcDays = num - 25569;
    const ms = utcDays * 86400 * 1000;
    // Apply the -1 hour offset from the Go code (3,600,000 ms)
    return ms - 3_600_000;
  }

  // Otherwise, try parsing as string date: YYYY.MM.DD. HH:MM
  const normalized = value
    .replace(/\./g, '-')
    .replace(/-\s/, ' ')     // "2024-01-15- 08:30" → "2024-01-15 08:30"
    .replace(/-$/, '')       // trailing dash at end of string
    .trim();

  // Expect: "2024-01-15 08:30" or "2024-01-15 08:30:00"
  // We parse this as a local-time string by appending a known offset-free format
  // that Date.parse treats deterministically.
  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!match) return null;

  const [, y, mo, d, h, mi] = match;
  // Build an ISO-like string. We treat the timestamp as UTC for consistency,
  // matching the Go "-1 hour" offset behavior: the Go code parses in local
  // time and then subtracts 1 hour. We parse as-is and subtract 1 hour.
  const date = new Date(
    Date.UTC(
      parseInt(y), parseInt(mo) - 1, parseInt(d),
      parseInt(h) - 1, // apply the -1h DST offset from the Go code
      parseInt(mi), 0
    )
  );
  if (isNaN(date.getTime())) return null;

  return date.getTime();
}

/**
 * Truncate a unix-ms timestamp to the start of its hour.
 */
function truncateToHour(ms: number): number {
  return ms - (ms % 3_600_000);
}

// ── Dependency-free XLSX parsing (DecompressionStream + XML regex) ──

function colLetterToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) {
    n = n * 26 + ch.charCodeAt(0) - 64;
  }
  return n - 1;
}

async function unzip(buffer: ArrayBuffer): Promise<Record<string, Uint8Array>> {
  const u8 = new Uint8Array(buffer);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const entries: Record<string, Uint8Array> = {};

  // Find EOCD (End of Central Directory)
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP');

  const cdOffset = view.getUint32(eocd + 16, true);
  const cdSize = view.getUint32(eocd + 12, true);

  // Parse central directory
  let pos = cdOffset;
  while (pos < cdOffset + cdSize) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;

    const method = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);

    const name = new TextDecoder().decode(u8.slice(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    if (!name.endsWith('.xml')) continue;

    // Read local file header
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compData = u8.slice(dataStart, dataStart + compSize);

    if (method === 0) {
      // Stored
      entries[name] = compData;
    } else if (method === 8) {
      // Deflate
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      await writer.write(compData);
      await writer.close();
      entries[name] = new Uint8Array(await new Response(ds.readable).arrayBuffer());
    }
  }

  return entries;
}

async function readXlsxRows(buffer: ArrayBuffer): Promise<(string | number)[][]> {
  const entries = await unzip(buffer);

  // Parse shared strings
  const sharedStrings: string[] = [];
  if (entries['xl/sharedStrings.xml']) {
    const xml = new TextDecoder().decode(entries['xl/sharedStrings.xml']);
    for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) {
      const text = m[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"');
      sharedStrings.push(text);
    }
  }

  // Find sheet (prefer sheet1.xml, else first match)
  const sheetKey = entries['xl/worksheets/sheet1.xml']
    ? 'xl/worksheets/sheet1.xml'
    : Object.keys(entries).find(k => k.match(/worksheets\/sheet/));

  if (!sheetKey) throw new Error('No worksheet found');

  const sheetXml = new TextDecoder().decode(entries[sheetKey]);
  const rows: (string | number)[][] = [];

  // Parse rows and cells
  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: (string | number)[] = [];
    let colIdx = 0;

    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2];

      // Get column index from r="A1" style reference
      const rMatch = attrs.match(/\br="([A-Z]+)\d+"/);
      if (rMatch) colIdx = colLetterToIndex(rMatch[1]);

      // Pad row with empty strings up to column index
      while (row.length < colIdx) row.push('');

      // Parse cell value
      const tMatch = attrs.match(/\bt="(\w+)"/);
      const vMatch = inner.match(/<v>([^<]*)<\/v>/);
      const v = vMatch ? vMatch[1] : '';

      if (tMatch && tMatch[1] === 's') {
        // Shared string reference
        row.push(sharedStrings[parseInt(v)] ?? '');
      } else if (tMatch && tMatch[1] === 'inlineStr') {
        // Inline string
        const tVal = inner.match(/<t>([^<]*)<\/t>/);
        row.push(tVal ? tVal[1] : '');
      } else {
        // Number or other
        row.push(v);
      }

      colIdx++;
    }
    rows.push(row);
  }

  return rows;
}

async function parseEonExcel(buffer: ArrayBuffer): Promise<RowPiece[]> {
  const rows = await readXlsxRows(buffer);

  if (rows.length < 2) throw new Error('Sheet has no data');

  // Find column indices
  const header = rows[0];
  let timeCol = -1;
  const valueCols: number[] = [];

  for (let i = 0; i < header.length; i++) {
    const name = String(header[i] ?? '').trim();
    if (name === 'Időbélyeg') timeCol = i;
    if (name === 'Érték') valueCols.push(i);
  }

  if (timeCol < 0) throw new Error('No Időbélyeg column found');
  if (valueCols.length !== 4) {
    throw new Error(`Expected 4 'Érték' columns, found ${valueCols.length}`);
  }

  // valueCols: [0]=+A, [1]=-A, [2]=1.8.0, [3]=2.8.0
  const pieces: RowPiece[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length <= timeCol) continue;

    const rawTime = String(row[timeCol] ?? '').trim();
    if (!rawTime) continue;

    const ms = parsePossibleTime(rawTime);
    if (ms === null) continue;

    const startMs = truncateToHour(ms);

    const parseValue = (col: number): number | null => {
      if (col >= row.length) return null;
      const v = String(row[col] ?? '').trim();
      if (!v) return null;
      const f = parseFloat(v.replace(',', '.'));
      return isNaN(f) ? null : f;
    };

    const ap = parseValue(valueCols[0]);
    const am = parseValue(valueCols[1]);
    const m180 = parseValue(valueCols[2]);
    const m280 = parseValue(valueCols[3]);

    if (ap !== null || am !== null || m180 !== null || m280 !== null) {
      pieces.push({ startMs, ap, am, m180, m280 });
    }
  }

  if (pieces.length === 0) throw new Error('No valid data rows found');
  return pieces;
}

// ── Aggregation ─────────────────────────────────────────────────────

function mergeRowsAndAggregate(pieces: RowPiece[]): AggregatedHour[] {
  const m = new Map<number, AggregatedHour>();

  for (const p of pieces) {
    let a = m.get(p.startMs);
    if (!a) {
      a = { startMs: p.startMs, ap: 0, am: 0, m180: null, m280: null };
      m.set(p.startMs, a);
    }
    if (p.ap !== null) a.ap += p.ap;
    if (p.am !== null) a.am += p.am;
    if (p.m180 !== null) a.m180 = p.m180;
    if (p.m280 !== null) a.m280 = p.m280;
  }

  // Sort by timestamp
  return Array.from(m.values()).sort((a, b) => a.startMs - b.startMs);
}

// ── Cumulative calculation ──────────────────────────────────────────

function calculateHourlyCumulative(hours: AggregatedHour[]): CalculatedRow[] {
  let last180 = 0;
  let last280 = 0;
  const out: CalculatedRow[] = [];

  for (const h of hours) {
    if (h.m180 !== null) last180 = h.m180;
    if (h.m280 !== null) last280 = h.m280;

    const start180 = last180;
    const start280 = last280;

    last180 = start180 + h.ap;
    last280 = start280 + h.am;

    out.push({
      startISO: new Date(h.startMs).toISOString(),
      ap: h.ap,
      am: h.am,
      m180: start180,
      m280: start280,
    });
  }
  return out;
}

// ── HA stats builder ────────────────────────────────────────────────

function buildStatsList(calculated: CalculatedRow[], meterKey: '1_8_0' | '2_8_0') {
  return calculated.map(r => {
    const state = meterKey === '1_8_0' ? r.m180 : r.m280;
    // Format timestamp as whole-hour (replace milliseconds with +00:00 offset)
    const start = r.startISO.replace(/\.\d{3}Z$/, '+00:00');
    return { start, state: Number(state), sum: Number(state) };
  });
}

// ── HA HTTP helpers ─────────────────────────────────────────────────

/**
 * Common headers for Home Assistant API requests
 */
function haHeaders(token: string, secret?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  
  if (secret) {
    headers['X-Worker-Secret'] = secret;
  }
  
  return headers;
}

async function callHomeAssistantService(
  env: Env, domain: string, service: string, body: unknown
): Promise<void> {
  const url = `${env.HA_URL.replace(/\/$/, '')}/api/services/${domain}/${service}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: haHeaders(env.HA_TOKEN, env.WORKER_SECRET),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`HA ${domain}/${service} failed: ${response.status} ${txt}`);
  }
}

/**
 * Check whether recorder.import_statistics exists on this HA instance.
 * Core HA does NOT ship this service — it is added by the Spook custom
 * integration (HACS). Without it, every call returns a bare
 * "400: Bad Request" (HA's REST API swallows the ServiceNotFound detail).
 */
async function importServiceExists(env: Env): Promise<boolean> {
  try {
    const url = `${env.HA_URL.replace(/\/$/, '')}/api/services`;
    const r = await fetch(url, { headers: haHeaders(env.HA_TOKEN, env.WORKER_SECRET) });
    if (!r.ok) return true; // can't tell — let the original error surface
    const domains = (await r.json()) as { domain: string; services: Record<string, unknown> }[];
    const recorder = domains.find(d => d.domain === 'recorder');
    return !!recorder?.services?.['import_statistics'];
  } catch {
    return true;
  }
}

/**
 * Push one statistics payload via Spook's recorder.import_statistics.
 * Confirmed working schema (Spook rejects unknown keys like unit_class):
 * statistic_id, source, name, unit_of_measurement, has_mean, has_sum, stats.
 */
async function importStatistics(
  env: Env, statId: string, stats: ReturnType<typeof buildStatsList>
): Promise<void> {
  const payload = {
    statistic_id: statId,
    source: statId.split(':')[0],
    name: statId.split(':')[1].replace(/_/g, ' '),
    unit_of_measurement: 'kWh',
    has_mean: false,
    has_sum: true,
    stats,
  };

  try {
    await callHomeAssistantService(env, 'recorder', 'import_statistics', payload);
  } catch (err) {
    if (!(await importServiceExists(env))) {
      throw new Error(
        'recorder.import_statistics service not found on this HA — ' +
        'install the Spook integration (HACS), restart HA, then retry'
      );
    }
    throw err;
  }
}

async function updateInputNumber(env: Env, entityID: string, value: number): Promise<void> {
  const url = `${env.HA_URL.replace(/\/$/, '')}/api/states/${entityID}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: haHeaders(env.HA_TOKEN, env.WORKER_SECRET),
    body: JSON.stringify({ state: value.toFixed(3) }),
  });
  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`HA update ${entityID} failed: ${response.status} ${txt}`);
  }
}

// ── Main processing pipeline ────────────────────────────────────────

async function processXlsxAndPushToHA(buffer: ArrayBuffer, env: Env): Promise<void> {
  // 1. Parse & compute (CPU-intensive part – must be fast for Free tier)
  const pieces = await parseEonExcel(buffer);
  const aggregated = mergeRowsAndAggregate(pieces);
  const calculated = calculateHourlyCumulative(aggregated);
  console.log(`Computed ${calculated.length} hourly rows from ${pieces.length} data points`);
  if (calculated.length > 0) {
    const latest = calculated[calculated.length - 1];

    // Calculate sum of last 24 hours (or less if the file doesn't cover 24 hours yet)
    const hoursToSum = Math.min(calculated.length, 24);
    const last24 = calculated.slice(-hoursToSum);
    const dailyImport = last24.reduce((sum, r) => sum + r.ap, 0);
    const dailyExport = last24.reduce((sum, r) => sum + r.am, 0);
    const diff = dailyExport - dailyImport;
    const diffSign = diff >= 0 ? '+' : '';

    console.log(`Latest XLS Cumulative Meter Readings:`);
    console.log(`  - D-1.8.0 (Import Meter): ${latest.m180.toFixed(3)} kWh`);
    console.log(`  - D-2.8.0 (Export Meter): ${latest.m280.toFixed(3)} kWh`);
    console.log(`Last ${hoursToSum} hours stats:`);
    console.log(`  - 1 napi fogyasztás: ${dailyImport.toFixed(3)} kWh`);
    console.log(`  - 1 napi termelés: ${dailyExport.toFixed(3)} kWh`);
    console.log(`  - különbség = ${diffSign}${diff.toFixed(3)} kWh`);
  }

  // 2. Validate env
  if (!env.HA_URL || !env.HA_TOKEN) {
    console.log('HA_URL or HA_TOKEN not configured – skipping push');
    return;
  }

  // 3. Build payloads
  const statsImport = buildStatsList(calculated, '1_8_0');
  const statsExport = buildStatsList(calculated, '2_8_0');

  // 4. Push import + export stats in parallel
  console.log(`Pushing ${statsImport.length} import + ${statsExport.length} export stats`);
  await Promise.all([
    importStatistics(env, ENTITY_IMPORT_STAT_ID, statsImport),
    importStatistics(env, ENTITY_EXPORT_STAT_ID, statsExport),
  ]);

  // 5. Update input_number entities
  if (env.UPDATE_INPUT_NUMBERS !== 'false' && calculated.length > 0) {
    const lastImport = statsImport[statsImport.length - 1].state;
    const lastExport = statsExport[statsExport.length - 1].state;

    await Promise.all([
      updateInputNumber(env, INPUT_NUMBER_IMPORT, lastImport),
      updateInputNumber(env, INPUT_NUMBER_EXPORT, lastExport),
    ]);
    console.log(`Updated meters: import=${lastImport.toFixed(3)}, export=${lastExport.toFixed(3)}`);
  }
}

// ── Email Worker entry point ────────────────────────────────────────

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    console.log(`Email from: ${message.from}, to: ${message.to}`);

    // Read the raw email stream immediately (must happen in the handler,
    // not inside waitUntil, because the stream may not be available later)
    const rawEmail = await new Response(message.raw).arrayBuffer();

    // Parse email + process asynchronously so the email handler can return
    ctx.waitUntil((async () => {
      try {
        const parser = new PostalMime();
        const parsed = await parser.parse(rawEmail);

        // Find XLSX/XLS attachment
        const attachment = parsed.attachments.find(att =>
          att.filename &&
          (att.filename.toLowerCase().endsWith('.xlsx') ||
           att.filename.toLowerCase().endsWith('.xls'))
        );

        if (!attachment) {
          console.log('No XLSX/XLS attachment found – ignoring email');
          return;
        }

        // Ensure we have an ArrayBuffer regardless of postal-mime's return type
        const raw = attachment.content;
        const contentBuffer: ArrayBuffer =
          raw instanceof ArrayBuffer ? raw :
          raw instanceof Uint8Array ? new Uint8Array(raw).buffer as ArrayBuffer :
          new TextEncoder().encode(raw as string).buffer as ArrayBuffer;

        console.log(`Processing attachment: ${attachment.filename} (${contentBuffer.byteLength} bytes)`);
        await processXlsxAndPushToHA(contentBuffer, env);
        console.log('Done');
      } catch (err) {
        console.error('Processing failed:', err instanceof Error ? err.message : err);
      }
    })());
  },
};
