// GeneralsX Web - load-screen frame receiver (main thread).
//
// During map load the game pthread is blocked and OffscreenCanvas frames are
// never composited (browsers only push them when the worker yields). The
// engine-side pump (LoadScreen.cpp, gxWebPumpLoadFrame) grabs each finished
// load-screen frame with transferToImageBitmap() and posts it here over
// BroadcastChannel('gx-frames'). We paint those ORIGINAL engine frames onto a
// fullscreen overlay canvas (ImageBitmapRenderingContext = zero-copy), so the
// player sees the real load screen — background art, portraits, per-player
// progress bars — exactly as rendered.
//
// Protocol: {t:'begin'} → show overlay; {t:'frame', bmp} → paint; {t:'end'} →
// hide. The overlay sits above the (frozen) game canvas and below the shell UI.
//
// GeneralsX @build web-port loadscreen 09/07/2026

'use strict';

const gxLoadScreen = {
  canvas: null,
  ctx: null,
  active: false,

  _ensure() {
    if (this.canvas) return;
    const cv = document.createElement('canvas');
    cv.id = 'gx-loadframe';
    cv.style.cssText =
      'position:fixed;inset:0;width:100vw;height:100vh;z-index:9;' +
      'display:none;background:#000;pointer-events:none;';
    document.body.appendChild(cv);
    this.canvas = cv;
    this.ctx = cv.getContext('bitmaprenderer');
  },

  begin() {
    this._ensure();
    this.active = true;
    this.canvas.style.display = 'block';
  },

  frame(bmp) {
    if (!this.active) { try { bmp.close(); } catch {} return; }
    this._ensure();
    // Match the backing store to the frame once (bitmaprenderer scales via CSS).
    if (this.canvas.width !== bmp.width || this.canvas.height !== bmp.height) {
      this.canvas.width = bmp.width;
      this.canvas.height = bmp.height;
    }
    this.ctx.transferFromImageBitmap(bmp);   // zero-copy hand-off
  },

  end() {
    this.active = false;
    if (this.canvas) this.canvas.style.display = 'none';
  },
};

// Frames arrive from the game pthread over a BroadcastChannel.
const gxFrameCh = new BroadcastChannel('gx-frames');
gxFrameCh.onmessage = (e) => {
  const m = e.data;
  if (!m) return;
  if (m.t === 'frame' && m.bmp) gxLoadScreen.frame(m.bmp);
  else if (m.t === 'begin') gxLoadScreen.begin();
  else if (m.t === 'end') gxLoadScreen.end();
};

window.gxLoadScreen = gxLoadScreen;
