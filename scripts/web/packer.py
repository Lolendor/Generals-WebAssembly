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

  file_entry:
    uleb128 path_len
    path_bytes (UTF-8)
    uleb128 uncompressed_offset   (into the full concatenated blob)
    uleb128 uncompressed_size
  segment_entry:
    uleb128 uncompressed_size
    uleb128 compressed_size

The concatenated file blob is split into fixed-size segments; each segment is
compressed independently with brotli (so the N segments compress in parallel
across CPU cores). Concatenating every segment's decompressed output rebuilds
the blob, from which files are sliced by their offset/size. Because brotli's
window (lgwin=24 = 16 MB) is far smaller than a 64 MB segment, splitting costs
under ~1% ratio versus a single stream, but compresses ~Ncores faster.

Usage:
  packer.py <input_dir> <output.data> [segment_mb]

GeneralsX @build web-port 07/07/2026
"""
import os, sys, struct, time, tempfile
from concurrent.futures import ProcessPoolExecutor
import brotli

BROTLI_QUALITY = 11
BROTLI_LGWIN = 24
MAGIC = 0x47415844
VERSION = 2
DEFAULT_SEGMENT = 64 * 1024 * 1024

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

# Worker: read one segment [offset, offset+length) from the blob file and
# brotli-compress it. Runs in a separate process (spawned), so `brotli` is
# re-imported here at module scope. Returns (index, compressed_bytes).
def compress_segment(args):
    idx, blob_path, offset, length = args
    with open(blob_path, 'rb') as f:
        f.seek(offset)
        data = f.read(length)
    comp = brotli.compress(data, mode=0, quality=BROTLI_QUALITY, lgwin=BROTLI_LGWIN)
    return idx, len(data), comp

def pack(input_dir, output_file, segment_size=DEFAULT_SEGMENT):
    # Collect files (sorted, deterministic).
    files = []
    for root, _, filenames in os.walk(input_dir):
        for f in sorted(filenames):
            if f in ('.DS_Store', 'Thumbs.db', 'desktop.ini') or f.startswith('._'):
                continue
            fp = os.path.join(root, f)
            files.append((os.path.relpath(fp, input_dir), fp))
    files.sort(key=lambda x: x[0])

    # Stream the concatenated blob to a temp file (avoids holding 2 GB + the
    # compressed output in RAM at once); record the file index as we go.
    tmp = tempfile.NamedTemporaryFile(prefix='gaxd_blob_', delete=False)
    blob_path = tmp.name
    index = []
    total_raw = 0
    try:
        with tmp:
            for rel, fp in files:
                sz = os.path.getsize(fp)
                index.append((rel, total_raw, sz))
                with open(fp, 'rb') as src:
                    while True:
                        buf = src.read(8 * 1024 * 1024)
                        if not buf: break
                        tmp.write(buf)
                total_raw += sz

        print(f"Files: {len(files)},  Raw: {fmt_size(total_raw)}")

        # Segment boundaries over the blob.
        seg_ranges = []
        off = 0
        while off < total_raw:
            length = min(segment_size, total_raw - off)
            seg_ranges.append((len(seg_ranges), blob_path, off, length))
            off += length
        # Edge case: empty blob → one empty segment so the format stays valid.
        if not seg_ranges:
            seg_ranges.append((0, blob_path, 0, 0))

        workers = os.cpu_count() or 4
        print(f"Brotli q{BROTLI_QUALITY}: {len(seg_ranges)} segments "
              f"of {fmt_size(segment_size)} across {workers} cores...")

        t0 = time.time()
        results = [None] * len(seg_ranges)
        done = 0
        total_comp = 0
        with ProcessPoolExecutor(max_workers=workers) as ex:
            for idx, usize, comp in ex.map(compress_segment, seg_ranges):
                results[idx] = (usize, comp)
                done += 1
                total_comp += len(comp)
                elapsed = time.time() - t0
                eta = (elapsed / done) * (len(seg_ranges) - done)
                pct = done * 100 // len(seg_ranges)
                print(f"\r  {pct}%  ({done}/{len(seg_ranges)} segments)  "
                      f"elapsed {fmt_time(elapsed)}  ETA {fmt_time(eta)}",
                      end='', flush=True)
        elapsed = time.time() - t0
        ratio = total_comp * 100 // max(total_raw, 1)
        print(f"\n  Done in {fmt_time(elapsed)} — {fmt_size(total_comp)} ({ratio}%)")

        # Write output: header + file index + segment table + segment blobs.
        with open(output_file, 'wb') as out:
            out.write(struct.pack('<II', MAGIC, VERSION))
            out.write(uleb128(len(index)))
            for rel, offset, size in index:
                pb = rel.encode('utf-8')
                out.write(uleb128(len(pb)))
                out.write(pb)
                out.write(uleb128(offset))
                out.write(uleb128(size))
            out.write(uleb128(len(results)))
            for usize, comp in results:
                out.write(uleb128(usize))
                out.write(uleb128(len(comp)))
            for usize, comp in results:
                out.write(comp)

        sz = os.path.getsize(output_file)
        print(f"\nWritten: {output_file}  ({fmt_size(sz)})")
    finally:
        try: os.unlink(blob_path)
        except OSError: pass

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: packer.py <input_dir> <output.data> [segment_mb]")
        sys.exit(1)
    seg = int(sys.argv[3]) * 1024 * 1024 if len(sys.argv) > 3 else DEFAULT_SEGMENT
    pack(sys.argv[1], sys.argv[2], seg)
