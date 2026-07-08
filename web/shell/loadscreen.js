// GeneralsX Web - DOM load-screen overlay (map/game loading progress).
//
// Why this exists: the engine's own LoadScreen draws with WebGL into the
// OffscreenCanvas from the blocked game pthread — but browsers only composite
// OffscreenCanvas frames when the worker returns to its event loop, which the
// synchronous map load never does. So the in-game load screen renders into the
// void and the player stares at a frozen frame. (Verified empirically: a
// worker that clears red, blocks, clears green, blocks — only green ever
// appears, after the worker finishes. gl.commit() no longer exists.)
//
// Instead, the engine's LoadScreen hooks (init / per-player progress /
// teardown) proxy tiny MAIN_THREAD_EM_ASM calls to this overlay, which lives
// on the main thread and always paints: one bar in singleplayer, one bar per
// player (with names) in multiplayer. Same data the engine feeds its own
// gadget bars — we just draw where the compositor can see it.
//
// API (called from C++ via MAIN_THREAD_EM_ASM):
//   gxLoadScreen.begin(kindStr)                  kind: 'single'|'multi'|'shell'
//   gxLoadScreen.setPlayer(slot, nameStr)        declare a row (multi)
//   gxLoadScreen.progress(slot, pct)             0..100 for one row
//   gxLoadScreen.end()
//
// GeneralsX @build web-port loadscreen 09/07/2026

'use strict';

const gxLoadScreen = {
  root: null,
  rows: new Map(),   // slot -> {bar, label, nameEl}
  kind: null,

  _ensureRoot() {
    if (this.root) return;
    const el = document.createElement('div');
    el.id = 'gx-loadscreen';
    el.innerHTML =
      '<div class="gx-ls-box">' +
      '  <div class="gx-ls-title">ЗАГРУЗКА КАРТЫ</div>' +
      '  <div class="gx-ls-rows"></div>' +
      '</div>';
    const style = document.createElement('style');
    style.textContent = `
      #gx-loadscreen {
        position: fixed; inset: 0; z-index: 15;
        display: flex; align-items: flex-end; justify-content: center;
        pointer-events: none;
        background: transparent;
        padding-bottom: 8vh;
        font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
      }
      #gx-loadscreen .gx-ls-box {
        min-width: min(560px, 86vw); max-width: 86vw;
        padding: 16px 22px; border-radius: 10px;
        background: rgba(11,14,17,.88); border: 1px solid #2c3a4a;
        box-shadow: 0 10px 40px rgba(0,0,0,.6);
      }
      #gx-loadscreen .gx-ls-title {
        font-size: 13px; letter-spacing: 3px; color: #e8b64c;
        text-align: center; margin-bottom: 12px;
      }
      #gx-loadscreen .gx-ls-row { margin-bottom: 10px; }
      #gx-loadscreen .gx-ls-row:last-child { margin-bottom: 0; }
      #gx-loadscreen .gx-ls-head {
        display: flex; justify-content: space-between;
        font-size: 12px; color: #d8dee6; margin-bottom: 4px;
      }
      #gx-loadscreen .gx-ls-val { opacity: .7; font-variant-numeric: tabular-nums; }
      #gx-loadscreen .gx-ls-track {
        height: 10px; border-radius: 5px; overflow: hidden;
        background: #1d2733; border: 1px solid #2c3a4a;
      }
      #gx-loadscreen .gx-ls-bar {
        width: 0%; height: 100%;
        background: linear-gradient(90deg, #b9821f, #e8b64c);
        transition: width .2s linear;
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(el);
    this.root = el;
  },

  begin(kind) {
    this._ensureRoot();
    this.kind = kind;
    this.rows.clear();
    this.root.querySelector('.gx-ls-rows').innerHTML = '';
    this.root.style.display = 'flex';
    if (kind !== 'multi') this.setPlayer(0, '');   // single: one anonymous bar
  },

  setPlayer(slot, name) {
    this._ensureRoot();
    if (this.rows.has(slot)) {
      const r = this.rows.get(slot);
      if (name) r.nameEl.textContent = name;
      return;
    }
    const row = document.createElement('div');
    row.className = 'gx-ls-row';
    row.innerHTML =
      '<div class="gx-ls-head"><span class="gx-ls-name"></span><span class="gx-ls-val">0%</span></div>' +
      '<div class="gx-ls-track"><div class="gx-ls-bar"></div></div>';
    row.querySelector('.gx-ls-name').textContent = name || '';
    this.root.querySelector('.gx-ls-rows').appendChild(row);
    this.rows.set(slot, {
      bar: row.querySelector('.gx-ls-bar'),
      label: row.querySelector('.gx-ls-val'),
      nameEl: row.querySelector('.gx-ls-name'),
    });
  },

  progress(slot, pct) {
    const r = this.rows.get(slot) || (this.kind !== 'multi' ? this.rows.get(0) : null);
    if (!r) { this.setPlayer(slot, ''); return this.progress(slot, pct); }
    pct = Math.max(0, Math.min(100, pct | 0));
    r.bar.style.width = pct + '%';
    r.label.textContent = pct + '%';
  },

  end() {
    if (this.root) this.root.style.display = 'none';
    this.rows.clear();
    this.kind = null;
  },
};

window.gxLoadScreen = gxLoadScreen;
