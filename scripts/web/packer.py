#!/opt/homebrew/bin/python3.11
"""
GeneralsX Web - pack a directory into a single segmented-brotli .data file.

Format v2 (segment-parallel):
  uint32  magic         0x47415844 ('GAXD')
  uint32  version       2
  uleb128 file_count
  [file_entry] * file_count
  uleb128 segment_count
  [segment_entry] * segment_count
  <segment 0 brotli><segment 1 brotli>...

  file_entry:    uleb128 path_len, path, uleb128 u_offset, uleb128 u_size
  segment_entry: uleb128 uncompressed_size, uleb128 compressed_size

Segments are independent brotli streams: they compress in parallel across CPU
cores, decompress in parallel in the browser, and are the unit of resumable
download. Segment boundaries are aligned to the starts of files larger than
ALIGN_THRESHOLD, so editing one big file only re-compresses its own segments —
combined with the content-hash segment cache (web/.pack-cache/), a typical
repack where a couple of files changed takes seconds instead of minutes.
Workers read their spans directly from the source files (no temp blob copy).

Also emits <output>.meta.json {headerSize, segmentCount, fileCount, rawSize,
contentHash} used by the client for resumable downloads.

Usage:
  packer.py <input_dir> <output.data> [segment_mb]

GeneralsX @build web-port packer-v2 09/07/2026
"""
import os, sys, json, struct, time, hashlib
from concurrent.futures import ProcessPoolExecutor
import brotli

BROTLI_QUALITY = 11
BROTLI_LGWIN = 24
MAGIC = 0x47415844
VERSION = 2
DEFAULT_SEGMENT = 32 * 1024 * 1024
ALIGN_THRESHOLD = 8 * 1024 * 1024   # files >= this start on a segment boundary

def uleb128(n):
    buf = []
    while True:
        b = n & 0x7f
        n >>= 7
        if n: b |= 0x80
        buf.append(b)
        if not n: break
    return bytes(buf)

def fmt_time(s):
    return f"{s:.0f}s" if s < 60 else f"{int(s)//60}m{int(s)%60:02d}s"

def fmt_size(n):
    if n > 1024**3: return f"{n/1024**3:.2f} GB"
    if n > 1024**2: return f"{n/1024**2:.0f} MB"
    if n > 1024: return f"{n//1024} KB"
    return f"{n} B"

# ── segment planning ───────────────────────────────────────────────────────────

def collect_files(input_dir):
    files = []
    for root, _, filenames in os.walk(input_dir):
        for f in sorted(filenames):
            if f in ('.DS_Store', 'Thumbs.db', 'desktop.ini') or f.startswith('._'):
                continue
            fp = os.path.join(root, f)
            files.append((os.path.relpath(fp, input_dir), fp, os.path.getsize(fp)))
    files.sort(key=lambda x: x[0])
    return files

def plan_segments(files, segment_size):
    """Return (index, segments). index: [(rel, u_offset, size)].
    segments: [[(abs_path, file_offset, length), ...]] — the source spans that
    make up each segment's raw bytes. Boundaries: fixed segment_size, but a
    file >= ALIGN_THRESHOLD always begins a new segment (so its edit doesn't
    shift/invalidate unrelated segments' content)."""
    index = []
    segments = []
    cur = []           # spans of the segment being built
    cur_len = 0
    u = 0

    def close():
        nonlocal cur, cur_len
        if cur_len > 0:
            segments.append(cur)
            cur = []
            cur_len = 0

    for rel, fp, sz in files:
        index.append((rel, u, sz))
        u += sz
        if sz >= ALIGN_THRESHOLD:
            close()                      # big file starts its own segment run
        remaining = sz
        fofs = 0
        while remaining > 0:
            room = segment_size - cur_len
            take = min(room, remaining)
            cur.append((fp, fofs, take))
            cur_len += take
            fofs += take
            remaining -= take
            if cur_len >= segment_size:
                close()
    close()
    return index, segments

# ── worker: hash + compress one segment (reads sources directly) ──────────────

def segment_raw(spans):
    parts = []
    for path, ofs, length in spans:
        with open(path, 'rb') as f:
            f.seek(ofs)
            parts.append(f.read(length))
    return b''.join(parts)

def compress_segment(args):
    idx, spans, cache_dir = args
    data = segment_raw(spans)
    h = hashlib.sha256(data).hexdigest()
    cpath = os.path.join(cache_dir, h + '.br') if cache_dir else None
    if cpath and os.path.exists(cpath):
        with open(cpath, 'rb') as f:
            comp = f.read()
        return idx, len(data), comp, h, True
    comp = brotli.compress(data, mode=0, quality=BROTLI_QUALITY, lgwin=BROTLI_LGWIN)
    if cpath:
        tmp = cpath + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(comp)
        os.replace(tmp, cpath)
    return idx, len(data), comp, h, False

# ── main ───────────────────────────────────────────────────────────────────────

def pack(input_dir, output_file, segment_size=DEFAULT_SEGMENT):
    files = collect_files(input_dir)
    total_raw = sum(sz for _, _, sz in files)
    index, seg_spans = plan_segments(files, segment_size)
    print(f"Files: {len(files)},  Raw: {fmt_size(total_raw)},  Segments: {len(seg_spans)}"
          f" (~{fmt_size(segment_size)}, big files aligned)")

    # Segment cache location: $GX_PACK_CACHE, else .pack-cache next to the output.
    cache_dir = os.environ.get('GX_PACK_CACHE') or \
        os.path.join(os.path.dirname(os.path.abspath(output_file)), '.pack-cache')
    os.makedirs(cache_dir, exist_ok=True)

    workers = os.cpu_count() or 4
    print(f"Brotli q{BROTLI_QUALITY} across {workers} cores, cache: {cache_dir}")

    t0 = time.time()
    results = [None] * len(seg_spans)
    done = cached = 0
    total_comp = 0
    jobs = [(i, seg_spans[i], cache_dir) for i in range(len(seg_spans))]
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for idx, usize, comp, h, from_cache in ex.map(compress_segment, jobs):
            results[idx] = (usize, comp, h)
            done += 1
            cached += 1 if from_cache else 0
            total_comp += len(comp)
            elapsed = time.time() - t0
            eta = (elapsed / done) * (len(seg_spans) - done)
            print(f"\r  {done*100//len(seg_spans)}%  ({done}/{len(seg_spans)} segments, {cached} cached)  "
                  f"elapsed {fmt_time(elapsed)}  ETA {fmt_time(eta)}", end='', flush=True)
    elapsed = time.time() - t0
    ratio = total_comp * 100 // max(total_raw, 1)
    print(f"\n  Done in {fmt_time(elapsed)} — {fmt_size(total_comp)} ({ratio}%), {cached}/{len(seg_spans)} from cache")

    # Header
    header = bytearray()
    header += struct.pack('<II', MAGIC, VERSION)
    header += uleb128(len(index))
    for rel, offset, size in index:
        pb = rel.encode('utf-8')
        header += uleb128(len(pb)); header += pb
        header += uleb128(offset); header += uleb128(size)
    header += uleb128(len(results))
    for usize, comp, _ in results:
        header += uleb128(usize); header += uleb128(len(comp))

    with open(output_file, 'wb') as out:
        out.write(header)
        for _, comp, _ in results:
            out.write(comp)

    # Content hash of the whole build = hash of segment hashes (order matters).
    build_hash = hashlib.sha256(('|'.join(h for _, _, h in results)).encode()).hexdigest()[:16]
    meta = {
        'headerSize': len(header),
        'segmentCount': len(results),
        'fileCount': len(index),
        'rawSize': total_raw,
        'contentHash': build_hash,
    }
    with open(output_file + '.meta.json', 'w') as f:
        json.dump(meta, f)

    sz = os.path.getsize(output_file)
    print(f"\nWritten: {output_file}  ({fmt_size(sz)})")
    print(f"Meta:    {output_file}.meta.json  (header {len(header)} B, hash {build_hash})")

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: packer.py <input_dir> <output.data> [segment_mb]")
        sys.exit(1)
    seg = int(sys.argv[3]) * 1024 * 1024 if len(sys.argv) > 3 else DEFAULT_SEGMENT
    pack(sys.argv[1], sys.argv[2], seg)
