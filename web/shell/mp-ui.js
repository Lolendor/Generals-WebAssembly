// GeneralsX Web - multiplayer panel wiring (host/join UI ↔ gxLobby).
//
// The floating #gx-mp panel is revealed once the game is running (loader calls
// gxShowMultiplayer()). Host generates a room key; Join enters one. Status and
// peer count reflect gxLobby callbacks. The actual game lobby/host/join happens
// inside the engine's LAN menu — this panel only brings up the WebRTC mesh that
// the LAN traffic rides on.
//
// GeneralsX @build web-port 5b 08/07/2026

'use strict';

function gxShowMultiplayer() {
  const root = document.getElementById('gx-mp');
  if (root) root.hidden = false;
}

// Hide the room panel (leaving the LAN lobby). The mesh itself stays up so an
// in-progress game keeps its connections; only the shell UI is hidden.
function gxHideMultiplayer() {
  const root = document.getElementById('gx-mp');
  const panel = document.getElementById('gx-mp-panel');
  if (panel) panel.hidden = true;
  if (root) root.hidden = true;
}

window.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('gx-mp-toggle');
  const panel = document.getElementById('gx-mp-panel');
  const hostBtn = document.getElementById('gx-mp-host');
  const joinBtn = document.getElementById('gx-mp-join');
  const hostBox = document.getElementById('gx-mp-hostbox');
  const joinBox = document.getElementById('gx-mp-joinbox');
  const keyEl = document.getElementById('gx-mp-key');
  const keyInput = document.getElementById('gx-mp-keyinput');
  const connectBtn = document.getElementById('gx-mp-connect');
  const statusEl = document.getElementById('gx-mp-status');
  const peersEl = document.getElementById('gx-mp-peers');

  gxLobby.onStatus = (t) => { statusEl.textContent = t; };
  gxLobby.onPeers = (n) => {
    peersEl.textContent = n > 0 ? ('Подключено игроков: ' + n) : '';
  };

  toggle.addEventListener('click', () => { panel.hidden = !panel.hidden; });

  hostBtn.addEventListener('click', async () => {
    const key = gxGenRoomKey();
    keyEl.textContent = key;
    hostBox.hidden = false;
    joinBox.hidden = true;
    try {
      await gxLobby.host(key);
    } catch (e) {
      statusEl.textContent = 'Ошибка: ' + (e && e.message ? e.message : e);
    }
  });

  joinBtn.addEventListener('click', () => {
    joinBox.hidden = false;
    hostBox.hidden = true;
    keyInput.focus();
  });

  keyInput.addEventListener('input', () => {
    // Auto-insert the dash: XXXX-XXXX
    let v = keyInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (v.length > 4) v = v.slice(0, 4) + '-' + v.slice(4, 8);
    keyInput.value = v;
  });

  connectBtn.addEventListener('click', async () => {
    const key = gxNormalizeRoomKey(keyInput.value);
    if (!key) { statusEl.textContent = 'Неверный код (нужно XXXX-XXXX).'; return; }
    try {
      await gxLobby.join(key);
    } catch (e) {
      statusEl.textContent = 'Ошибка: ' + (e && e.message ? e.message : e);
    }
  });

  // Copy the room key on click.
  keyEl.addEventListener('click', () => {
    if (keyEl.textContent && keyEl.textContent !== '—') {
      navigator.clipboard && navigator.clipboard.writeText(keyEl.textContent).catch(() => {});
    }
  });
});

window.gxShowMultiplayer = gxShowMultiplayer;
window.gxHideMultiplayer = gxHideMultiplayer;
