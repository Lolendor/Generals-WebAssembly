// GeneralsX Web - unpack worker (segmented brotli, format v2).
//
// Fetches build.data itself and runs the whole pipeline on its own thread:
//   fetch → parse index + segment table → per-segment brotli decompress
//   → concat decompressed output → slice files → write OPFS / IndexedDB.
//
// The blob is split into independent brotli segments (packer.py compresses them
// in parallel across cores). Here they decompress sequentially, each with its
// own DecompressStream; concatenating every segment's output rebuilds the blob,
// from which files are sliced by absolute offset/size (unchanged from v1).
//
// Format v2:
//   u32 'GAXD' | u32 version=2 | uleb file_count | [uleb plen,path,uleb off,uleb size]*
//   | uleb seg_count | [uleb usize, uleb csize]* | <seg0 brotli><seg1 brotli>...
//
// GeneralsX @build web-port 07/07/2026

import init, * as brotli from './node_modules/brotli-wasm/pkg.web/brotli_wasm.js';

function readUleb(buf, off) {
  let val = 0, mul = 1;
  while (off < buf.length) {
    const b = buf[off++];
    val += (b & 0x7f) * mul;
    mul *= 128;
    if (!(b & 0x80)) break;
  }
  return [val, off];
}

// Parse the full v2 header (file index + segment table). Returns null if the
// buffer does not yet hold the whole header, else {entries, segments, indexEnd}.
function tryParseIndex(buf) {
  if (buf.length < 8) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x47415844) throw new Error('Bad GAXD magic');
  if (dv.getUint32(4, true) !== 2) throw new Error('Unsupported GAXD version (need 2)');
  let off = 8, count;
  [count, off] = readUleb(buf, off);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (off >= buf.length) return null;
    let plen; [plen, off] = readUleb(buf, off);
    if (off + plen > buf.length) return null;
    const path = new TextDecoder().decode(buf.subarray(off, off + plen)).replace(/\\/g, '/');
    off += plen;
    let offset; [offset, off] = readUleb(buf, off);
    let size; [size, off] = readUleb(buf, off);
    entries.push({ path, offset, size });
  }
  if (off >= buf.length) return null;
  let segCount; [segCount, off] = readUleb(buf, off);
  const segments = [];
  for (let i = 0; i < segCount; i++) {
    if (off >= buf.length) return null;
    let usize; [usize, off] = readUleb(buf, off);
    let csize; [csize, off] = readUleb(buf, off);
    segments.push({ usize, csize });
  }
  return { entries, segments, indexEnd: off };
}

function storagePath(path) {
  return path.startsWith('GameDataGenerals/') ? path : 'GameData/' + path;
}

// ── OPFS writer ─────────────────────────────────────────────────────────────
let opfsRoot = null;
const dirCache = new Map();
async function opfsDir(parts, create) {
  let key = '', dir = opfsRoot;
  for (const part of parts) {
    key += part + '/';
    let next = dirCache.get(key);
    if (!next) { next = await dir.getDirectoryHandle(part, { create }); dirCache.set(key, next); }
    dir = next;
  }
  return dir;
}
// Open a sync access handle for one file entry (truncated, ready at offset 0).
async function opfsOpen(path) {
  const parts = storagePath(path).split('/').filter(Boolean);
  const name = parts.pop();
  const dir = await opfsDir(parts, true);
  const fh = await dir.getFileHandle(name, { create: true });
  const h = await fh.createSyncAccessHandle();
  h.truncate(0);
  return h;
}

// ── IndexedDB writer (fallback) ────────────────────────────────────────────────
let idb = null;
function idbOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('gx-assets', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// ── Streaming state ─────────────────────────────────────────────────────────────
let mode = 'opfs';
let CODE_MORE_OUTPUT;
const OUT_CHUNK = 1 * 1024 * 1024;

let entries = null;
let segments = null;
let ds = null;            // current segment's DecompressStream
let segIdx = 0;
let segRemaining = 0;     // compressed bytes left in the current segment

// The decompressed stream is a contiguous concatenation of the files in `entries`
// order. We walk a single cursor through it; each decompressed chunk is routed
// into whichever file(s) it covers. Peak RAM is one output chunk (~8 MB), not a
// whole file — critical for iOS where a 318 MB Textures.big would otherwise sit
// in memory until fully decompressed.
let decPos = 0;           // absolute position reached in the decompressed stream
let curIdx = 0;           // index of the file the cursor is inside
let curHandle = null;     // open OPFS sync access handle for entries[curIdx]
let curWritten = 0;       // bytes written into entries[curIdx] so far

// IDB fallback keeps the accumulator (partial writes are awkward there).
let accChunks = [];
let accBase = 0, accSize = 0;
let scheduledIdx = 0;
let writtenIdx = 0;       // files completed (progress)

// ── OPFS streaming route ────────────────────────────────────────────────────
// Write a decompressed chunk directly into the current file's handle, opening
// the next file (and closing the finished one) as the cursor crosses boundaries.
async function routeOpfs(chunk) {
  let off = 0;
  while (off < chunk.length) {
    // Ensure the current file is open, skipping any zero-byte entries.
    while (curHandle === null) {
      if (curIdx >= entries.length) return;        // beyond last file (shouldn't happen)
      const e = entries[curIdx];
      curHandle = await opfsOpen(e.path);
      curWritten = 0;
      if (e.size === 0) { await finishCurrent(); }  // empty file: close immediately
    }
    const e = entries[curIdx];
    const remain = e.size - curWritten;
    const take = Math.min(remain, chunk.length - off);
    // FileSystemSyncAccessHandle.write() may write FEWER bytes than requested
    // (large writes, quota pressure). Loop on the return value so the file is
    // never left with a garbage tail — a short write into a .big archive
    // silently corrupts it and hangs the engine's INI parser later.
    let w = 0;
    while (w < take) {
      let wrote;
      try {
        wrote = curHandle.write(chunk.subarray(off + w, off + take), { at: curWritten + w });
      } catch (err) {
        throw new Error('Запись ' + e.path + ' @' + (curWritten + w) + '/' + e.size +
          ': ' + (err && err.message ? err.message : err));
      }
      if (!(wrote > 0))
        throw new Error('Запись ' + e.path + ': нулевая запись @' + (curWritten + w) + '/' + e.size);
      w += wrote;
    }
    curWritten += take;
    off += take;
    decPos += take;
    if (curWritten >= e.size) await finishCurrent();
  }
}
async function finishCurrent() {
  if (curHandle) { curHandle.flush(); curHandle.close(); curHandle = null; }
  curIdx++;
  writtenIdx++;
  if (writtenIdx % 2 === 0 || writtenIdx === entries.length)
    postMessage({ type: 'progress', done: writtenIdx, total: entries.length });
}
// Handle trailing zero-byte files after the stream ends.
async function finishTrailingEmpties() {
  while (curIdx < entries.length && entries[curIdx].size === 0) {
    curHandle = await opfsOpen(entries[curIdx].path);
    await finishCurrent();
  }
}
// Re-open every file and check its on-disk size against the index. Catches any
// truncated/short write before the engine boots on a corrupt .big (which hangs
// its INI parser). Only for OPFS (the streamed path).
async function verifyOpfsSizes() {
  for (const e of entries) {
    const parts = storagePath(e.path).split('/').filter(Boolean);
    const name = parts.pop();
    const dir = await opfsDir(parts, false);
    const fh = await dir.getFileHandle(name);
    const h = await fh.createSyncAccessHandle();
    const sz = h.getSize();
    h.close();
    if (sz !== e.size)
      throw new Error('Проверка не пройдена: ' + e.path + ' на диске ' + sz +
        ' байт, ожидалось ' + e.size + ' — повторите загрузку.');
  }
}

// ── IDB accumulator route (fallback) ────────────────────────────────────────
function accAppend(chunk) { if (chunk.byteLength) { accChunks.push(chunk); accSize += chunk.byteLength; } }
function accRead(offset, size) {
  const out = new Uint8Array(size);
  let need = size, pos = 0, walk = offset - accBase;
  for (const c of accChunks) {
    if (walk >= c.byteLength) { walk -= c.byteLength; continue; }
    const take = Math.min(need, c.byteLength - walk);
    out.set(c.subarray(walk, walk + take), pos);
    pos += take; need -= take; walk = 0;
    if (need <= 0) break;
  }
  accTrim(offset + size);
  return out;
}
function accTrim(absUpTo) {
  let drop = absUpTo - accBase;
  while (accChunks.length && drop >= accChunks[0].byteLength) {
    drop -= accChunks[0].byteLength;
    accBase += accChunks[0].byteLength;
    accSize -= accChunks[0].byteLength;
    accChunks.shift();
  }
  if (drop > 0 && accChunks.length) {
    accChunks[0] = accChunks[0].subarray(drop);
    accBase += drop; accSize -= drop;
  }
}
function idbWrite(path, data) {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('files', 'readwrite');
    tx.objectStore('files').put(new Blob([data]), path);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function drainIdb() {
  while (scheduledIdx < entries.length) {
    const e = entries[scheduledIdx];
    if (accBase + accSize < e.offset + e.size) break;
    const data = accRead(e.offset, e.size);
    await idbWrite(e.path, data);
    scheduledIdx++;
    writtenIdx++;
    postMessage({ type: 'progress', done: writtenIdx, total: entries.length });
  }
}

// One decompressed chunk → storage (streamed for OPFS, accumulated for IDB).
async function onDecompressed(chunk) {
  if (mode === 'opfs') await routeOpfs(chunk);
  else { accAppend(chunk); await drainIdb(); }
}

function startSegment() {
  ds = new brotli.DecompressStream();
  segRemaining = segments[segIdx].csize;
}

// Feed a buffer of compressed bytes, routing them across segment boundaries.
// Each segment has its own DecompressStream; a segment ends once exactly its
// csize compressed bytes have been consumed, then the next stream begins.
async function feed(input) {
  let inOff = 0;
  while (inOff < input.length && segIdx < segments.length) {
    const avail = Math.min(input.length - inOff, segRemaining);
    const slice = input.subarray(inOff, inOff + avail);
    let sOff = 0;
    for (;;) {
      const res = ds.decompress(slice.subarray(sOff), OUT_CHUNK);
      // Capture fields, then free the wasm-side result immediately. brotli-wasm
      // shares one wasm instance across all segments; leaking DecompressStream
      // and BrotliStreamResult objects grows its heap monotonically until it
      // dies near ~2 GB of cumulative output (segment ~31/33) with a spurious
      // "offset is out of bounds". Freeing keeps the heap bounded.
      // NOTE: the `buf` getter slices AND frees the wasm buffer, so read it once.
      const out = res.buf;
      const code = res.code;
      const inc = res.input_offset;
      if (out.length) await onDecompressed(out);
      if (res.free) res.free();
      sOff += inc;
      if (code === CODE_MORE_OUTPUT) {
        if (out.length === 0 && inc === 0)
          throw new Error('Декомпрессия застряла в сегменте ' + segIdx + ' (no progress)');
        continue;   // buffered output — keep pulling
      }
      break;                                          // MORE_INPUT or SUCCESS — slice done
    }
    inOff += avail;
    segRemaining -= avail;
    if (segRemaining === 0) {                         // segment fully consumed
      if (ds && ds.free) ds.free();                   // release the decoder state
      ds = null;
      segIdx++;
      if (segIdx < segments.length) startSegment();
    }
  }
}

// Producer/consumer: network fills a bounded queue while the decompressor drains
// it, so downloading later bytes overlaps decompress+write of earlier ones. The
// queue is capped for back-pressure (never buffer the whole payload in RAM).
async function run(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('build.data недоступен: HTTP ' + resp.status);
  const total = parseInt(resp.headers.get('Content-Length') || '0') || 0;

  const reader = resp.body.getReader();
  const QUEUE_MAX_BYTES = 96 * 1024 * 1024;

  let queue = [];
  let queuedBytes = 0;
  let readerDone = false;
  let notify = null, space = null;
  const wake = (which) => { if (which === 'consumer' && notify) { notify(); notify = null; }
                            if (which === 'producer' && space) { space(); space = null; } };

  const producer = (async () => {
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      postMessage({ type: 'download', received, total });
      queue.push(value);
      queuedBytes += value.byteLength;
      wake('consumer');
      while (queuedBytes >= QUEUE_MAX_BYTES) await new Promise((r) => { space = r; });
    }
    readerDone = true;
    wake('consumer');
  })();

  const consumer = (async () => {
    let parsing = true;
    let headChunks = [], headLen = 0;
    for (;;) {
      if (queue.length === 0) {
        if (readerDone) break;
        await new Promise((r) => { notify = r; });
        continue;
      }
      const value = queue.shift();
      queuedBytes -= value.byteLength;
      wake('producer');

      if (parsing) {
        headChunks.push(value); headLen += value.byteLength;
        const head = headChunks.length === 1 ? headChunks[0] : concat(headChunks, headLen);
        const parsed = tryParseIndex(head);
        if (!parsed) continue;                       // need more bytes for the header
        parsing = false;
        entries = parsed.entries;
        segments = parsed.segments;
        segIdx = 0;
        startSegment();
        postMessage({ type: 'index', entries });
        headChunks = null;
        await feed(head.subarray(parsed.indexEnd));  // remainder is segment blob
      } else {
        await feed(value);
      }
    }
  })();

  await Promise.all([producer, consumer]);
  // Flush any trailing zero-byte files (OPFS) — non-empty ones are already
  // written as the cursor crossed their boundaries. (IDB drains inline.)
  if (mode === 'opfs') await finishTrailingEmpties();

  // Integrity guard: every file must be fully written. If the stream ended
  // early (truncated download, decompress abort) some files are missing or
  // half-written — fail loudly so the loader does NOT mark the build installed
  // and boot the engine on corrupt data (which hangs it in loadFileDirectory).
  if (curHandle) { try { curHandle.flush(); curHandle.close(); } catch {} curHandle = null; }
  if (writtenIdx !== entries.length) {
    throw new Error('Распаковка неполная: записано ' + writtenIdx + ' из ' +
      entries.length + ' файлов (оборванная загрузка). Повторите.');
  }
  // Verify every file's on-disk size matches the index before declaring success.
  if (mode === 'opfs') {
    postMessage({ type: 'progress', done: entries.length, total: entries.length, verifying: true });
    await verifyOpfsSizes();
  }
  postMessage({ type: 'complete', files: writtenIdx, entries });
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.byteLength; }
  return out;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'start') {
      mode = msg.mode;
      await init(new URL(msg.wasmUrl));
      CODE_MORE_OUTPUT = brotli.BrotliStreamResultCode.NeedsMoreOutput;
      if (mode === 'opfs') opfsRoot = await navigator.storage.getDirectory();
      else idb = await idbOpen();
      await run(msg.url);
    }
  } catch (e) {
    postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
};
