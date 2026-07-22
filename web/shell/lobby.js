// GeneralsX Web - multiplayer lobby (room rendezvous → WebRTC mesh → gxNet).
//
// Wires the signaling layer (GxSignaling over MQTT) and WebRTC peers
// (GxRtcPeer) into the UDP bridge (gxNet).
//
// Topology: full mesh with the host as coordinator and relay fallback. The
// host is 10.77.0.1 and assigns 10.77.0.N to joiners; it also introduces
// joiners to each other ({t:'meet'}), and each pair dials a direct DataChannel
// (the lower vip initiates). While a direct channel is down, unicast rides the
// host relay (gxNet falls back automatically), so the mesh upgrade is pure
// win: lower latency, host uplink relieved.
//
// Resilience: every peer channel runs keepalive (2s ping/pong, RTT). On death
// (3 misses / ICE failed) the initiator first tries an ICE restart (survives a
// network/IP change on the same connection), then a full re-dial through
// signaling — keeping the SAME vip, so the game never sees the player change
// address; it just experiences a lag spike. The host reserves a dropped
// joiner's vip for a grace period before declaring it gone for real.
//
// Rendezvous handshake (over MQTT topics p2pt/{key}/...):
//   joiner --broadcast--> {t:'join'}                 (host listens on /req)
//   host   --unicast----> {t:'welcome', vip, hostId} (assigns a virtual IP)
//   host   --unicast----> {t:'meet', peers:[{sig,vip}]} (mesh introductions)
//   {t:'offer'|'answer'|'ice'} route to the matching GxRtcPeer by _from.
//   joiner --broadcast--> {t:'rejoin', vip}          (reconnect with old vip)
//
// GeneralsX @build web-port netcode 09/07/2026

'use strict';

const GX_REDIAL_AFTER_MS = 8000;    // ICE-restart window before full re-dial
const GX_VIP_GRACE_MS = 60000;      // host keeps a dead joiner's vip this long

class GxLobby {
  constructor() {
    this.sig = null;
    this.key = null;
    this.role = null;             // 'host' | 'join'
    this.peersBySig = new Map();  // signaling id -> { peer, vip }
    this.pending = new Map();     // signaling id -> [buffered signal msgs]
    this.nextHostId = 2;          // host is .1; joiners start at .2
    this.reserved = new Map();    // vip -> {sigId, timer} (host: grace holds)
    this.onStatus = null;         // (text) UI callback
    this.onPeers = null;          // (count) UI callback
    this.onQuality = null;        // (list of {vip, rtt, drops}) UI callback
    this._qualTimer = null;
  }

  _status(t) { console.log('[lobby]', t); if (this.onStatus) this.onStatus(t); }
  _peersChanged() { if (this.onPeers) this.onPeers(this.peersBySig.size); }

  // ── Public: host / join / leave ─────────────────────────────────────────────

  async host(roomKey) {
    this.role = 'host';
    this.key = roomKey;
    gxNet.reset();
    gxNet.setSelf(gxVip(1), true, 0);
    this.sig = new GxSignaling();
    await this.sig.init(roomKey, (m) => this._onSignal(m));
    this._saveIdentity();
    this._startQuality();
    this._status('Комната ' + roomKey + ' создана. Ваш IP 10.77.0.1. Ожидание игроков…');
  }

  async join(roomKey) {
    this.role = 'join';
    this.key = roomKey;
    gxNet.reset();
    this.sig = new GxSignaling();
    await this.sig.init(roomKey, (m) => this._onSignal(m));
    // Reconnect path: if this tab already had a vip in this room, ask for it
    // back — the host holds it in grace and the game sees the same address.
    const saved = this._loadIdentity();
    if (saved && saved.key === roomKey && saved.role === 'join' && saved.vip) {
      this.sig.broadcast({ t: 'rejoin', vip: saved.vip });
      this._status('Переподключение к комнате ' + roomKey + '…');
    } else {
      this.sig.broadcast({ t: 'join' });
      this._status('Подключение к комнате ' + roomKey + '…');
    }
    this._startQuality();
  }

  leave() {
    this._stopQuality();
    for (const { peer, vip } of this.peersBySig.values()) {
      try { peer.destroy(); } catch {}
      gxNet.removePeer(vip);
    }
    for (const r of this.reserved.values()) clearTimeout(r.timer);
    this.reserved.clear();
    this.peersBySig.clear();
    this.pending.clear();
    if (this.sig) { try { this.sig.destroy(); } catch {} this.sig = null; }
    gxNet.reset();
    try { sessionStorage.removeItem('gx-mp-identity'); } catch {}
    this._status('Отключено.');
    this._peersChanged();
  }

  // ── Identity (per-tab; survives reloads within the session) ────────────────

  _saveIdentity() {
    try {
      sessionStorage.setItem('gx-mp-identity', JSON.stringify({
        key: this.key, role: this.role, vip: gxNet.myVip,
      }));
    } catch {}
  }
  _loadIdentity() {
    try { return JSON.parse(sessionStorage.getItem('gx-mp-identity') || 'null'); }
    catch { return null; }
  }

  // ── Signaling dispatch ──────────────────────────────────────────────────────

  _onSignal(m) {
    const from = m._from;
    if (!from) return;
    switch (m.t) {
      case 'join':    if (this.role === 'host') this._onJoin(from, 0); break;
      case 'rejoin':  if (this.role === 'host') this._onJoin(from, (m.vip >>> 0) || 0); break;
      case 'welcome': if (this.role === 'join') this._onWelcome(m, from); break;
      case 'meet':    if (this.role === 'join') this._onMeet(m); break;
      case 'offer':
      case 'answer':
      case 'ice':     this._routeSignal(from, m); break;
    }
  }

  // Host: a joiner announced itself → assign (or restore) a vip, welcome, dial.
  _onJoin(joinerSig, wantVip) {
    if (this.peersBySig.has(joinerSig)) return;   // already connecting

    let vip = 0;
    if (wantVip && this.reserved.has(wantVip)) {
      // Grace reservation: same player back after a drop — restore the vip.
      const r = this.reserved.get(wantVip);
      clearTimeout(r.timer);
      this.reserved.delete(wantVip);
      vip = wantVip;
      this._status('Игрок ' + gxVipToString(vip) + ' переподключается…');
    } else if (wantVip) {
      // Rejoin for a vip we still think is connected (e.g. the player reloaded
      // the page before keepalive noticed): replace the stale channel.
      for (const [sid, e] of this.peersBySig) {
        if (e.vip === wantVip) { this._dropPeer(sid, e.vip); break; }
      }
      vip = wantVip;
      this._status('Игрок ' + gxVipToString(vip) + ' переподключается…');
    } else {
      vip = gxVip(this.nextHostId++);
      this._status('Игрок ' + gxVipToString(vip) + ' подключается…');
    }

    this.sig.sendTo(joinerSig, { t: 'welcome', vip: vip, hostId: this.sig.myId });
    const peer = this._makePeer(joinerSig, vip, true);
    peer.start();

    // Mesh introductions: tell the newcomer about every existing joiner, and
    // each existing joiner about the newcomer. Lower vip initiates the dial.
    const others = [];
    for (const [sid, e] of this.peersBySig) {
      if (sid === joinerSig || e.vip === vip) continue;
      others.push({ sig: sid, vip: e.vip });
      this.sig.sendTo(sid, { t: 'meet', peers: [{ sig: joinerSig, vip: vip }] });
    }
    if (others.length) this.sig.sendTo(joinerSig, { t: 'meet', peers: others });
  }

  // Joiner: host assigned us a vip and told us its signaling id.
  _onWelcome(m, hostSig) {
    const vip = m.vip >>> 0;
    const sigId = m.hostId || hostSig;
    if (gxNet.myVip && gxNet.myVip !== vip) return;     // stray welcome
    if (gxNet.myVip === vip && this.peersBySig.has(sigId)) return; // duplicate
    // Fresh join OR host-reconnect (rejoin answered with our old vip).
    gxNet.setSelf(vip, false, gxVip(1));
    this._saveIdentity();
    this._status('Подключено. Ваш IP ' + gxVipToString(vip) + '. Установка канала…');
    const peer = this._makePeer(sigId, gxVip(1), false);
    peer.start();
    this._flushPending(sigId);
  }

  // Joiner: host introduced other joiners — dial direct channels (mesh).
  _onMeet(m) {
    if (!Array.isArray(m.peers)) return;
    for (const p of m.peers) {
      if (!p || !p.sig || !p.vip) continue;
      if (this.peersBySig.has(p.sig)) continue;
      const theirVip = p.vip >>> 0;
      // Deterministic initiator: lower vip dials, so both sides agree.
      const initiator = gxNet.myVip < theirVip;
      const peer = this._makePeer(p.sig, theirVip, initiator);
      peer.start();
      this._flushPending(p.sig);
    }
  }

  // ── Peer lifecycle: create, keepalive-death, reconnect ─────────────────────

  _makePeer(sigId, vip, initiator) {
    const peer = new GxRtcPeer(this.sig, sigId, initiator,
      { ordered: false, maxPacketLifeTime: 150 }); // bounded-latency partial reliability
    this.peersBySig.set(sigId, { peer, vip });
    gxNet.addPeer(vip, peer);

    peer.onOpen = () => {
      gxNet.meshEpoch++;                            // force an instant LAN re-announce
      this._status('Канал с ' + gxVipToString(vip) + ' открыт.');
      this._peersChanged();
    };
    peer.onDead = () => this._onPeerDead(sigId, vip, initiator);
    peer.onClose = () => {
      // Explicit close (peer left / we tore down) — no reconnect dance.
      if (this.peersBySig.get(sigId) && this.peersBySig.get(sigId).peer === peer) {
        this._dropPeer(sigId, vip);
      }
    };
    return peer;
  }

  // Keepalive/ICE declared the channel dead: try to recover before dropping.
  async _onPeerDead(sigId, vip, initiator) {
    const entry = this.peersBySig.get(sigId);
    if (!entry) return;
    this._status('Связь с ' + gxVipToString(vip) + ' потеряна — восстановление…');

    // Phase 1: ICE restart on the same connection (survives IP/network change).
    let recovered = false;
    if (initiator && await entry.peer.restartIce()) {
      recovered = await this._waitOpen(entry.peer, GX_REDIAL_AFTER_MS);
    }

    // Phase 2: full re-dial via signaling with the same vip.
    if (!recovered && this.peersBySig.get(sigId) === entry) {
      try { entry.peer.destroy(); } catch {}
      gxNet.removePeer(vip);
      this.peersBySig.delete(sigId);
      const fresh = this._makePeer(sigId, vip, initiator);
      fresh.start();
      recovered = await this._waitOpen(fresh, GX_REDIAL_AFTER_MS);
    }

    if (recovered) {
      gxNet.meshEpoch++;
      this._status('Связь с ' + gxVipToString(vip) + ' восстановлена.');
      this._peersChanged();
      return;
    }

    // Give up on the channel. Host: hold the vip in grace for a while — the
    // player may come back with {t:'rejoin'} (their identity survives).
    if (this.role === 'host') {
      this._dropPeer(sigId, vip);
      const timer = setTimeout(() => { this.reserved.delete(vip); }, GX_VIP_GRACE_MS);
      this.reserved.set(vip, { sigId, timer });
      this._status('Игрок ' + gxVipToString(vip) + ' отключился (место сохранено ' +
        (GX_VIP_GRACE_MS / 1000) + 'с).');
    } else if (vip === gxVip(1)) {
      // Lost the HOST and could not recover: try the whole rendezvous again
      // (rejoin with our saved vip) — the room may still be alive.
      this._dropPeer(sigId, vip);
      this._status('Связь с хостом потеряна — попытка переподключения к комнате…');
      try {
        this.sig.broadcast({ t: 'rejoin', vip: gxNet.myVip });
      } catch {}
    } else {
      this._dropPeer(sigId, vip);
    }
  }

  _dropPeer(sigId, vip) {
    const e = this.peersBySig.get(sigId);
    if (e) { try { e.peer.destroy(); } catch {} }
    this.peersBySig.delete(sigId);
    gxNet.removePeer(vip);
    gxNet.meshEpoch++;
    this._peersChanged();
  }

  _waitOpen(peer, ms) {
    return new Promise((resolve) => {
      if (peer._open) return resolve(true);
      const t = setTimeout(() => { peer.onOpen = prevOpen; resolve(false); }, ms);
      const prevOpen = peer.onOpen;
      peer.onOpen = () => {
        clearTimeout(t);
        prevOpen && prevOpen();
        peer.onOpen = prevOpen;
        resolve(true);
      };
    });
  }

  // ── Signal routing ──────────────────────────────────────────────────────────

  _routeSignal(from, m) {
    const entry = this.peersBySig.get(from);
    if (entry) { entry.peer.signal(m); return; }
    if (!this.pending.has(from)) this.pending.set(from, []);
    const q = this.pending.get(from);
    q.push(m);
    if (q.length > 64) q.shift();
  }

  _flushPending(sigId) {
    const q = this.pending.get(sigId);
    const entry = this.peersBySig.get(sigId);
    if (!q || !entry) return;
    for (const m of q) entry.peer.signal(m);
    this.pending.delete(sigId);
  }

  // ── Link quality reporting (RTT / drops per peer) ───────────────────────────

  _startQuality() {
    this._stopQuality();
    this._qualTimer = setInterval(() => {
      if (!this.onQuality) return;
      const list = [];
      for (const { peer, vip } of this.peersBySig.values()) {
        list.push({
          vip: gxVipToString(vip),
          rtt: peer.rttMs >= 0 ? Math.round(peer.rttMs) : -1,
          drops: peer.dropsQueue,
          open: peer._open,
        });
      }
      this.onQuality(list);
    }, 2000);
  }
  _stopQuality() {
    if (this._qualTimer) { clearInterval(this._qualTimer); this._qualTimer = null; }
  }
}

window.gxLobby = new GxLobby();
