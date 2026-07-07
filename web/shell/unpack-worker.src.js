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

// ── OPFS writer (sync access handles) ──────────────────────────────────────────
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
async function opfsWrite(path, data) {
  const parts = storagePath(path).split('/').filter(Boolean);
  const name = parts.pop();
  const dir = await opfsDir(parts, true);
  const fh = await dir.getFileHandle(name, { create: true });
  const h = await fh.createSyncAccessHandle();
  try { h.truncate(0); h.write(data, { at: 0 }); h.flush(); }
  finally { h.close(); }
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
function idbWrite(path, data) {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('files', 'readwrite');
    tx.objectStore('files').put(new Blob([data]), path);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Streaming state ─────────────────────────────────────────────────────────────
let mode = 'opfs';
let CODE_MORE_OUTPUT;
const OUT_CHUNK = 8 * 1024 * 1024;

let entries = null;
let segments = null;
let ds = null;            // current segment's DecompressStream
let segIdx = 0;
let segRemaining = 0;     // compressed bytes left in the current segment

let accChunks = [];
let accBase = 0, accSize = 0;
let scheduledIdx = 0, writtenIdx = 0;

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

async function drainAndWrite() {
  while (scheduledIdx < entries.length) {
    const e = entries[scheduledIdx];
    if (accBase + accSize < e.offset + e.size) break;
    const data = accRead(e.offset, e.size);
    await (mode === 'opfs' ? opfsWrite : idbWrite)(e.path, data);
    scheduledIdx++;
    writtenIdx++;
    postMessage({ type: 'progress', done: writtenIdx, total: entries.length });
  }
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
      if (res.buf.length) accAppend(res.buf);
      sOff += res.input_offset;
      await drainAndWrite();
      if (res.code === CODE_MORE_OUTPUT) continue;   // buffered output — keep pulling
      break;                                          // MORE_INPUT or SUCCESS — slice done
    }
    inOff += avail;
    segRemaining -= avail;
    if (segRemaining === 0) {                         // segment fully consumed
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
