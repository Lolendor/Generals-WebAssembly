// GeneralsX Web - brotli decompression pool worker.
//
// One member of the unpack pool. Receives whole compressed segments from the
// dispatcher (unpack-worker) as transferable ArrayBuffers, decompresses each
// with its own brotli-wasm instance, and transfers the decompressed bytes
// back. Keeping the instance per-worker (instead of one shared across the
// whole 2 GB job) plus diligent res.free()/ds.free() keeps the wasm heap
// bounded — the old single-instance design leaked result objects until the
// heap hit ~2 GB and threw a spurious "offset is out of bounds".
//
// Protocol (dispatcher → pool worker):
//   {type:'init', wasmUrl}
//   {type:'seg', idx, buf(ArrayBuffer, transferred), usize}
// Protocol (pool worker → dispatcher):
//   {type:'ready'}
//   {type:'seg', idx, buf(ArrayBuffer of exactly usize, transferred)}
//   {type:'error', idx, message}
//
// GeneralsX @build web-port packer-v2 09/07/2026

import init, * as brotli from './node_modules/brotli-wasm/pkg.web/brotli_wasm.js';

const OUT_CHUNK = 1 * 1024 * 1024;
let CODE_MORE_OUTPUT, CODE_MORE_INPUT;

// Decompress one complete segment. The entire compressed segment is in `input`,
// so input-position accounting is exact: we advance by the decoder's reported
// input_offset each call (never assume a slice was fully consumed — that
// assumption in the old streaming feed() lost bytes and wedged the stream).
function decompressSegment(input, usize) {
  const out = new Uint8Array(usize);
  let outPos = 0;
  let inPos = 0;
  const ds = new brotli.DecompressStream();
  try {
    for (;;) {
      const res = ds.decompress(input.subarray(inPos), OUT_CHUNK);
      const buf = res.buf;           // NOTE: getter slices AND frees — read once
      const code = res.code;
      const consumed = res.input_offset;
      if (res.free) res.free();

      if (buf.length) {
        if (outPos + buf.length > usize)
          throw new Error('сегмент распаковался больше ожидаемого (' +
            (outPos + buf.length) + ' > ' + usize + ')');
        out.set(buf, outPos);
        outPos += buf.length;
      }
      inPos += consumed;

      if (code === CODE_MORE_OUTPUT) continue;       // pull remaining output
      if (code === CODE_MORE_INPUT) {
        if (inPos >= input.length)
          throw new Error('декодер требует ввода за концом сегмента (@' + inPos + ')');
        continue;                                     // feed the rest of the buffer
      }
      break;                                          // Success
    }
  } finally {
    if (ds.free) ds.free();
  }
  if (outPos !== usize)
    throw new Error('сегмент распаковался в ' + outPos + ' байт, ожидалось ' + usize);
  return out;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      await init(new URL(msg.wasmUrl));
      CODE_MORE_OUTPUT = brotli.BrotliStreamResultCode.NeedsMoreOutput;
      CODE_MORE_INPUT = brotli.BrotliStreamResultCode.NeedsMoreInput;
      postMessage({ type: 'ready' });
    } else if (msg.type === 'seg') {
      const out = decompressSegment(new Uint8Array(msg.buf), msg.usize);
      postMessage({ type: 'seg', idx: msg.idx, buf: out.buffer }, [out.buffer]);
    }
  } catch (e) {
    postMessage({ type: 'error', idx: msg && msg.idx, message: e && e.message ? e.message : String(e) });
  }
};
