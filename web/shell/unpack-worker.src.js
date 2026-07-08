// GeneralsX Web - unpack dispatcher (segmented brotli, format v2).
//
// Pipeline (this worker orchestrates, never decompresses):
//   network reader ──slice at segment boundaries──▶ pool of brotli sub-workers
//        │  (compressed segments, transferable)         │ (parallel decompress)
//        ▼                                              ▼ (decompressed, transferable)
//   retry w/ Range on drop                    in-order writer → OPFS sync handles
//                                                        │
//                                             journal per completed segment → loader
//
// Design notes:
// - Segments are independent brotli streams (packer.py v2), so they
//   decompress in parallel and are the unit of resume.
// - The writer consumes decompressed segments strictly in order (files span
//   segment boundaries); out-of-order results are parked until their turn.
//   OPFS writes are much faster than decompression, so a single writer is
//   never the bottleneck.
// - Back-pressure: at most POOL+2 segments in flight (dispatched or parked),
//   keeping peak memory bounded (~(POOL+2) × segment size).
// - Byte-exact input accounting lives in the pool worker (whole segments in,
//   whole buffers out) — the old streaming feed() lost unconsumed tail bytes
//   on NeedsMoreInput and wedged the stream. There is no such path anymore.
// - Resume: the loader passes {startSeg, journal etag/total}; we Range-fetch
//   from that segment's absolute compressed offset, never truncate existing
//   files, and overwrite the incomplete segment's byte range idempotently.
//
// Protocol (loader → dispatcher):
//   {type:'start', url, wasmUrl, mode, resume?:{startSeg,total,headerBuf?}}
// Protocol (dispatcher → loader):
//   {type:'download', received, total}          absolute compressed progress
//   {type:'index', entries}
//   {type:'progress', done, total}              files fully written
//   {type:'journal', seg, etag, total}          segment completed+flushed
//   {type:'reconnect', attempt, waitMs}         network drop, retrying
//   {type:'complete', files, entries}
//   {type:'error', message}
//
// GeneralsX @build web-port packer-v2 09/07/2026

'use strict';

// ── small utils ───────────────────────────────────────────────────────────────

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

// Condition gate without lost-wakeup races. Supports MULTIPLE concurrent
// waiters (the net task and the writer both wait on the pool gate): wake()
// releases every current waiter; a wake() with no waiters is remembered
// (pending) and consumed by the next wait(). Callers re-check their condition
// in a while loop after every wait, so spurious wakeups are harmless.
class Gate {
  constructor() { this._waiters = []; this._pending = false; }
  wake() {
    if (this._waiters.length) {
      const ws = this._waiters; this._waiters = [];
      for (const r of ws) r();
    } else {
      this._pending = true;
    }
  }
  wait() {
    if (this._pending) { this._pending = false; return Promise.resolve(); }
    return new Promise((r) => { this._waiters.push(r); });
  }
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.byteLength; }
  return out;
}

// Parse the full v2 header. Returns null if buf doesn't yet hold all of it.
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

// ── OPFS writer ───────────────────────────────────────────────────────────────

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
// Open a sync access handle. Truncates only when asked (fresh install), so
// resume never clobbers already-written earlier parts of a spanning file.
async function opfsOpen(path, truncate) {
  const parts = storagePath(path).split('/').filter(Boolean);
  const name = parts.pop();
  const dir = await opfsDir(parts, true);
  const fh = await dir.getFileHandle(name, { create: true });
  const h = await fh.createSyncAccessHandle();
  if (truncate) h.truncate(0);
  return h;
}
async function opfsGetSize(path) {
  const parts = storagePath(path).split('/').filter(Boolean);
  const name = parts.pop();
  const dir = await opfsDir(parts, false);
  const fh = await dir.getFileHandle(name);
  const h = await fh.createSyncAccessHandle();
  const sz = h.getSize();
  h.close();
  return sz;
}

// ── IndexedDB writer (fallback; no resume in this mode) ───────────────────────

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

// ── Decompression pool ────────────────────────────────────────────────────────

class BrotliPool {
  constructor(size, wasmUrl) {
    this.size = size;
    this.wasmUrl = wasmUrl;
    this.workers = [];
    this.results = new Map();   // segIdx -> Uint8Array (parked out-of-order)
    this.gate = new Gate();     // woken on every result
    this.errors = [];
  }
  async start() {
    const readies = [];
    for (let i = 0; i < this.size; i++) {
      const w = new Worker('unpack-brotli-worker.js?v=' + (self.gxVer || 'dev'));
      readies.push(new Promise((resolve, reject) => {
        const h = (ev) => {
          if (ev.data.type === 'ready') { w.removeEventListener('message', h); resolve(); }
          else if (ev.data.type === 'error') { w.removeEventListener('message', h); reject(new Error(ev.data.message)); }
        };
        w.addEventListener('message', h);
      }));
      w.addEventListener('message', (ev) => {
        const m = ev.data;
        if (m.type === 'seg') {
          this.results.set(m.idx, new Uint8Array(m.buf));
          w._busy = false;
          this.gate.wake();
        } else if (m.type === 'error') {
          this.errors.push(new Error('Сегмент ' + m.idx + ': ' + m.message));
          w._busy = false;
          this.gate.wake();
        }
      });
      w.addEventListener('error', (e) => {
        this.errors.push(new Error('brotli-воркер: ' + (e.message || 'crash')));
        this.gate.wake();
      });
      w._busy = false;
      w.postMessage({ type: 'init', wasmUrl: this.wasmUrl });
      this.workers.push(w);
    }
    await Promise.all(readies);
  }
  idle() { return this.workers.find((w) => !w._busy) || null; }
  dispatch(idx, buf, usize) {
    const w = this.idle();
    if (!w) throw new Error('dispatch on full pool');
    w._busy = true;
    w.postMessage({ type: 'seg', idx, buf, usize }, [buf]);
  }
  take(idx) {
    const r = this.results.get(idx);
    if (r) this.results.delete(idx);
    return r || null;
  }
  throwIfFailed() { if (this.errors.length) throw this.errors[0]; }
  terminate() { for (const w of this.workers) { try { w.terminate(); } catch {} } }
}

// ── Main run ──────────────────────────────────────────────────────────────────

let mode = 'opfs';
let entries = null;
let segments = null;
let segCAbs = null;   // absolute compressed offset of each segment in the file
let segUAbs = null;   // absolute decompressed offset of each segment
let indexEnd = 0;
let writtenFiles = 0;

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type !== 'start') return;
  try {
    mode = msg.mode;
    self.gxVer = msg.ver || 'dev';
    if (mode === 'opfs') opfsRoot = await navigator.storage.getDirectory();
    else idb = await idbOpen();
    await run(msg.url, msg.wasmUrl, msg.resume || null);
  } catch (e) {
    postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
};

async function fetchWithRetry(url, fromByte, onReconnect) {
  let attempt = 0;
  for (;;) {
    try {
      const headers = {};
      if (fromByte > 0) headers['Range'] = 'bytes=' + fromByte + '-';
      const resp = await fetch(url, { headers });
      if (!resp.ok && resp.status !== 206)
        throw new Error('HTTP ' + resp.status);
      // If we asked for a Range but the server ignored it (200), the caller
      // must skip fromByte bytes manually.
      const honored = fromByte === 0 || resp.status === 206;
      return { resp, honored };
    } catch (e) {
      attempt++;
      if (attempt > 5) throw new Error('Сеть недоступна после ' + (attempt - 1) + ' попыток: ' + (e && e.message ? e.message : e));
      const waitMs = Math.min(1000 * Math.pow(2, attempt - 1), 15000);
      onReconnect && onReconnect(attempt, waitMs);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function run(url, wasmUrl, resume) {
  // ── Phase 0: header ──────────────────────────────────────────────────────
  // Fresh install: stream from byte 0 and parse the header from the first
  // chunks (they arrive immediately). Resume: same, but we throw the stream
  // away after the header and re-fetch from the resume offset — the header is
  // tiny (<64 KB) so this costs nothing.
  let headChunks = [], headLen = 0;
  let parsed = null;
  let firstResp = await fetchWithRetry(url, 0, sendReconnect);
  let reader = firstResp.resp.body.getReader();
  const totalCompressed = parseInt(firstResp.resp.headers.get('Content-Length') || '0') || (resume && resume.total) || 0;
  const etag = firstResp.resp.headers.get('ETag') || firstResp.resp.headers.get('Last-Modified') || ('len:' + totalCompressed);

  while (!parsed) {
    const { done, value } = await reader.read();
    if (done) throw new Error('Файл данных повреждён: заголовок не найден');
    headChunks.push(value); headLen += value.byteLength;
    const head = headChunks.length === 1 ? headChunks[0] : concat(headChunks, headLen);
    parsed = tryParseIndex(head);
    if (!parsed && headLen > 8 * 1024 * 1024) throw new Error('Заголовок слишком большой или повреждён');
    if (parsed) headChunks = [head];   // keep the merged buffer
  }
  entries = parsed.entries;
  segments = parsed.segments;
  indexEnd = parsed.indexEnd;
  postMessage({ type: 'index', entries });

  // Absolute offsets per segment.
  segCAbs = new Array(segments.length);
  segUAbs = new Array(segments.length);
  {
    let c = indexEnd, u = 0;
    for (let i = 0; i < segments.length; i++) {
      segCAbs[i] = c; segUAbs[i] = u;
      c += segments[i].csize; u += segments[i].usize;
    }
  }

  // ── Resume decision ─────────────────────────────────────────────────────
  let startSeg = 0;
  if (resume && mode === 'opfs' &&
      resume.etag === etag && resume.total === totalCompressed &&
      Number.isInteger(resume.startSeg) && resume.startSeg > 0 && resume.startSeg < segments.length) {
    startSeg = resume.startSeg;
  }
  const freshInstall = startSeg === 0;

  // Position the network stream at startSeg's compressed offset.
  let netAbs;              // absolute compressed position of next byte we'll consume
  let acc = [], accLen = 0; // compressed accumulator (post-header bytes)
  if (startSeg === 0) {
    // Continue on the already-open stream: carve off what we have past the header.
    const head = headChunks[0];
    const rest = head.subarray(indexEnd);
    if (rest.length) { acc.push(rest); accLen = rest.length; }
    netAbs = indexEnd + rest.length;
  } else {
    // Drop the header stream; Range-fetch from the segment boundary.
    try { reader.cancel(); } catch {}
    const r2 = await fetchWithRetry(url, segCAbs[startSeg], sendReconnect);
    reader = r2.resp.body.getReader();
    netAbs = segCAbs[startSeg];
    if (!r2.honored) {
      // Server ignored Range: skip bytes until segCAbs[startSeg].
      let skip = segCAbs[startSeg];
      while (skip > 0) {
        const { done, value } = await reader.read();
        if (done) throw new Error('Поток закончился до точки докачки');
        if (value.byteLength <= skip) { skip -= value.byteLength; }
        else { acc.push(value.subarray(skip)); accLen += value.byteLength - skip; skip = 0; }
      }
    }
    postMessage({ type: 'download', received: segCAbs[startSeg], total: totalCompressed });
  }

  // ── Pool ────────────────────────────────────────────────────────────────
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  const isApple = /iPhone|iPad|Macintosh/.test((typeof navigator !== 'undefined' && navigator.userAgent) || '');
  const POOL = Math.max(2, Math.min(isApple ? 3 : 6, cores - 2));
  const MAX_INFLIGHT = POOL + 2;
  const pool = new BrotliPool(POOL, wasmUrl);
  await pool.start();

  // ── Writer state (in-order) ─────────────────────────────────────────────
  let writeSeg = startSeg;    // next segment index the writer needs
  let curIdx = 0;             // file cursor
  let curHandle = null;
  let curWritten = 0;
  writtenFiles = 0;

  if (startSeg > 0) {
    // Fast-forward the file cursor to the resume point. Files fully before
    // segUAbs[startSeg] were completed by earlier segments (their journal
    // entries were only written after flush) — count them as written.
    const uStart = segUAbs[startSeg];
    while (curIdx < entries.length && entries[curIdx].offset + entries[curIdx].size <= uStart) {
      curIdx++; writtenFiles++;
    }
    if (curIdx < entries.length && entries[curIdx].offset < uStart) {
      // Spanning file: its head was written by the previous segments. Reopen
      // WITHOUT truncate and continue at the boundary.
      curHandle = await opfsOpen(entries[curIdx].path, false);
      curWritten = uStart - entries[curIdx].offset;
    }
    postMessage({ type: 'progress', done: writtenFiles, total: entries.length });
  }

  async function finishCurrent() {
    if (curHandle) { curHandle.flush(); curHandle.close(); curHandle = null; }
    curIdx++;
    writtenFiles++;
    if (writtenFiles % 2 === 0 || writtenFiles === entries.length)
      postMessage({ type: 'progress', done: writtenFiles, total: entries.length });
  }

  // Write one decompressed segment at its absolute offset, walking the file table.
  async function writeSegment(segIdx, data) {
    if (mode === 'idb') { await writeSegmentIdb(segIdx, data); return; }
    let off = 0;
    while (off < data.length) {
      while (curHandle === null) {
        if (curIdx >= entries.length) return;
        const e = entries[curIdx];
        curHandle = await opfsOpen(e.path, freshInstall || e.offset >= segUAbs[startSeg]);
        curWritten = 0;
        if (e.size === 0) await finishCurrent();
      }
      const e = entries[curIdx];
      const take = Math.min(e.size - curWritten, data.length - off);
      let w = 0;
      while (w < take) {
        let wrote;
        try {
          wrote = curHandle.write(data.subarray(off + w, off + take), { at: curWritten + w });
        } catch (err) {
          throw new Error('Запись ' + e.path + ' @' + (curWritten + w) + '/' + e.size + ': ' +
            (err && err.message ? err.message : err));
        }
        if (!(wrote > 0)) throw new Error('Запись ' + e.path + ': нулевая запись');
        w += wrote;
      }
      curWritten += take;
      off += take;
      if (curWritten >= e.size) await finishCurrent();
    }
  }

  // IDB fallback: accumulate decompressed bytes per file (no partial writes).
  let idbParts = [];
  async function writeSegmentIdb(segIdx, data) {
    let off = 0;
    while (off < data.length) {
      if (curIdx >= entries.length) return;
      const e = entries[curIdx];
      if (e.size === 0) { await idbWrite(e.path, new Uint8Array(0)); curIdx++; writtenFiles++; continue; }
      const take = Math.min(e.size - curWritten, data.length - off);
      idbParts.push(data.slice(off, off + take));
      curWritten += take;
      off += take;
      if (curWritten >= e.size) {
        const whole = concat(idbParts, e.size);
        idbParts = [];
        await idbWrite(e.path, whole);
        curIdx++; curWritten = 0; writtenFiles++;
        if (writtenFiles % 2 === 0) postMessage({ type: 'progress', done: writtenFiles, total: entries.length });
      }
    }
  }

  // ── Network → slicer → pool dispatch loop ───────────────────────────────
  let recvSeg = startSeg;       // next segment to finish receiving
  let dispatched = 0, written = 0; // counts for back-pressure (in-flight = dispatched - written)
  let netDone = false;
  let netError = null;

  function sendReconnect(attempt, waitMs) {
    postMessage({ type: 'reconnect', attempt, waitMs });
  }

  function accTake(n) {
    // Remove exactly n bytes from the front of acc, return as one buffer.
    const out = new Uint8Array(n);
    let pos = 0;
    while (pos < n) {
      const c = acc[0];
      const take = Math.min(c.byteLength, n - pos);
      out.set(c.subarray(0, take), pos);
      pos += take;
      if (take === c.byteLength) acc.shift();
      else acc[0] = c.subarray(take);
    }
    accLen -= n;
    return out;
  }

  const netTask = (async () => {
    try {
      while (recvSeg < segments.length) {
        // Assemble the next segment from the accumulator.
        const need = segments[recvSeg].csize;
        while (accLen < need) {
          let r;
          try {
            r = await reader.read();
          } catch (e) {
            // Connection dropped mid-stream: retry with Range from netAbs.
            const rr = await fetchWithRetry(url, netAbs, sendReconnect);
            reader = rr.resp.body.getReader();
            if (!rr.honored) {
              let skip = netAbs;
              while (skip > 0) {
                const s = await reader.read();
                if (s.done) throw new Error('Поток закончился при докачке');
                if (s.value.byteLength <= skip) skip -= s.value.byteLength;
                else { acc.push(s.value.subarray(skip)); accLen += s.value.byteLength - skip; skip = 0; }
              }
            }
            continue;
          }
          if (r.done) throw new Error('Поток закончился раньше конца архива (сегмент ' + recvSeg + ')');
          acc.push(r.value);
          accLen += r.value.byteLength;
          netAbs += r.value.byteLength;
          postMessage({ type: 'download', received: netAbs, total: totalCompressed });
        }
        const segBuf = accTake(need);
        const idx = recvSeg;
        recvSeg++;

        // Back-pressure: wait until pool has an idle worker AND in-flight cap ok.
        for (;;) {
          pool.throwIfFailed();
          if (pool.idle() && (dispatched - written) < MAX_INFLIGHT) break;
          await pool.gate.wait();
        }
        pool.dispatch(idx, segBuf.buffer, segments[idx].usize);
        dispatched++;
      }
      try { reader.cancel(); } catch {}
    } catch (e) {
      netError = e;
    } finally {
      netDone = true;
      pool.gate.wake();
    }
  })();

  // ── In-order writer loop ────────────────────────────────────────────────
  while (writeSeg < segments.length) {
    // Wait for the next-needed segment to be decompressed.
    let data;
    for (;;) {
      pool.throwIfFailed();
      if (netError) throw netError;
      data = pool.take(writeSeg);
      if (data) break;
      if (netDone && (dispatched - written) === 0 && recvSeg <= writeSeg) {
        // Nothing in flight and network finished — the segment can never arrive.
        throw netError || new Error('Сегмент ' + writeSeg + ' не получен (обрыв данных)');
      }
      await pool.gate.wait();
    }
    await writeSegment(writeSeg, data);
    written++;
    // Journal AFTER the segment's bytes are written AND flushed. A file that
    // spans into the next segment keeps its handle open — flush it now so the
    // journaled "segment complete" claim is durable (resume starts at the NEXT
    // segment and will not rewrite this one's bytes).
    if (curHandle) curHandle.flush();
    postMessage({ type: 'journal', seg: writeSeg, etag, total: totalCompressed });
    writeSeg++;
    pool.gate.wake();  // free in-flight slot for the network task
  }
  await netTask;
  if (netError) throw netError;

  // Close a trailing open handle (file ending exactly at archive end).
  if (curHandle) { curHandle.flush(); curHandle.close(); curHandle = null; curIdx++; writtenFiles++; }
  // Trailing zero-byte files.
  while (curIdx < entries.length && entries[curIdx].size === 0) {
    if (mode === 'opfs') { const h = await opfsOpen(entries[curIdx].path, true); h.flush(); h.close(); }
    else await idbWrite(entries[curIdx].path, new Uint8Array(0));
    curIdx++; writtenFiles++;
  }

  pool.terminate();

  if (writtenFiles !== entries.length)
    throw new Error('Распаковка неполная: записано ' + writtenFiles + ' из ' + entries.length + ' файлов.');

  // Verify on-disk sizes (OPFS): catches any truncated/short write.
  if (mode === 'opfs') {
    postMessage({ type: 'progress', done: entries.length, total: entries.length, verifying: true });
    for (const e of entries) {
      const sz = await opfsGetSize(e.path);
      if (sz !== e.size)
        throw new Error('Проверка не пройдена: ' + e.path + ' на диске ' + sz + ' байт, ожидалось ' + e.size);
    }
  }

  postMessage({ type: 'complete', files: writtenFiles, entries });
}
