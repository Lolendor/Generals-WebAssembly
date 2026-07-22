// GeneralsX Web - load-screen frame receiver (main thread).
//
// During map load the game pthread is blocked and OffscreenCanvas frames are
// never composited (browsers only push them when the worker yields). The
// engine-side pump (LoadScreen.cpp, gxWebPumpLoadFrame) glReadPixels() the
// just-rendered ORIGINAL load-screen frame — non-destructively, the game
// canvas is never touched — and hands the RGBA pixels here via
// MAIN_THREAD_EM_ASM. We paint them onto a fullscreen overlay canvas, so the
// player sees the real load screen (background art, portraits, per-player
// progress bars) exactly as the engine rendered it.
//
// GL rows are bottom-up; the overlay flips via ctx.scale(1,-1) so the frame
// lands upright without a CPU flip pass.
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
    this.ctx = cv.getContext('2d');
  },

  begin() {
    this._ensure();
    this.active = true;
    this.canvas.style.display = 'block';
  },

  // px: Uint8Array RGBA, bottom-up (GL readback). w/h in pixels.
  frameRGBA(px, w, h) {
    if (!this.active) return;
    this._ensure();
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const img = new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, w * h * 4), w, h);
    // putImageData ignores transforms — draw via an ImageBitmap-less flip:
    // put the (upside-down) frame, then flip it in place with drawImage.
    this.ctx.putImageData(img, 0, 0);
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'copy';
    this.ctx.scale(1, -1);
    this.ctx.drawImage(this.canvas, 0, -h);
    this.ctx.restore();
  },

  end() {
    this.active = false;
    if (this.canvas) this.canvas.style.display = 'none';
  },
};

window.gxLoadScreen = gxLoadScreen;
