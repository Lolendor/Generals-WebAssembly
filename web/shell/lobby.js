// GeneralsX Web - multiplayer lobby (room rendezvous → WebRTC mesh → gxNet).
//
// Wires the signaling layer (GxSignaling over MQTT) and WebRTC peers
// (GxRtcPeer) into the UDP bridge (gxNet). Star topology: the host is the relay
// and virtual IP 10.77.0.1; each joiner gets 10.77.0.N and one DataChannel to
// the host. Once connected, the game's LAN menu discovers players over the mesh
// (broadcast) and plays unchanged.
//
// Rendezvous handshake (over MQTT topics p2pt/{key}/...):
//   joiner --broadcast--> {t:'join'}                 (host listens on /req)
//   host   --unicast----> {t:'welcome', vip, hostId} (assigns a virtual IP)
//   host creates the WebRTC offer toward the joiner (host = initiator).
//   {t:'offer'|'answer'|'ice'} route to the matching GxRtcPeer by _from.
//
// GeneralsX @build web-port 5b 08/07/2026

'use strict';

class GxLobby {
  constructor() {
    this.sig = null;
    this.key = null;
    this.role = null;             // 'host' | 'join'
    this.peersBySig = new Map();  // signaling id -> { peer, vip }
    this.pending = new Map();     // signaling id -> [buffered signal msgs]
    this.nextHostId = 2;          // host is .1; joiners start at .2
    this.onStatus = null;         // (text) UI callback
    this.onPeers = null;          // (count) UI callback
  }

  _status(t) { console.log('[lobby]', t); if (this.onStatus) this.onStatus(t); }
  _peersChanged() { if (this.onPeers) this.onPeers(this.peersBySig.size); }

  // Host a room: become 10.77.0.1 and wait for joiners.
  async host(roomKey) {
    this.role = 'host';
    this.key = roomKey;
    gxNet.reset();
    gxNet.setSelf(gxVip(1), true, 0);
    this.sig = new GxSignaling();
    await this.sig.init(roomKey, (m) => this._onSignal(m));
    this._status('Комната ' + roomKey + ' создана. Ваш IP 10.77.0.1. Ожидание игроков…');
  }

  // Join a room: announce ourselves; the host assigns our virtual IP.
  async join(roomKey) {
    this.role = 'join';
    this.key = roomKey;
    gxNet.reset();
    this.sig = new GxSignaling();
    await this.sig.init(roomKey, (m) => this._onSignal(m));
    this.sig.broadcast({ t: 'join' });
    this._status('Подключение к комнате ' + roomKey + '…');
  }

  _onSignal(m) {
    const from = m._from;
    if (!from) return;
    switch (m.t) {
      case 'join':    if (this.role === 'host') this._onJoin(from); break;
      case 'welcome': if (this.role === 'join') this._onWelcome(m, from); break;
      case 'offer':
      case 'answer':
      case 'ice':     this._routeSignal(from, m); break;
    }
  }

  // Host: a joiner announced itself → assign a vip, welcome, and offer.
  _onJoin(joinerSig) {
    if (this.peersBySig.has(joinerSig)) return;   // already connecting
    const vip = gxVip(this.nextHostId++);
    this._status('Игрок ' + gxVipToString(vip) + ' подключается…');
    this.sig.sendTo(joinerSig, { t: 'welcome', vip: vip, hostId: this.sig.myId });
    // Host is the WebRTC initiator (creates the DataChannel toward the joiner).
    const peer = this._makePeer(joinerSig, vip, true);
    peer.start();
  }

  // Joiner: host assigned us a vip and told us its signaling id.
  _onWelcome(m, hostSig) {
    if (gxNet.myVip) return;                       // already welcomed
    gxNet.setSelf(m.vip >>> 0, false, gxVip(1));
    this._status('Подключено. Ваш IP ' + gxVipToString(m.vip >>> 0) + '. Установка канала…');
    const peer = this._makePeer(m.hostId || hostSig, gxVip(1), false);
    peer.start();
    this._flushPending(m.hostId || hostSig);
  }

  // Create a GxRtcPeer, register it with gxNet under its virtual IP, and hook
  // open/close status. `vip` is the remote peer's virtual IP.
  _makePeer(sigId, vip, initiator) {
    const peer = new GxRtcPeer(this.sig, sigId, initiator,
      { ordered: false, maxRetransmits: 0 });     // UDP semantics
    this.peersBySig.set(sigId, { peer, vip });
    gxNet.addPeer(vip, peer);
    peer.onOpen = () => {
      gxNet.meshEpoch++;                            // force an instant LAN re-announce
      this._status('Канал с ' + gxVipToString(vip) + ' открыт.');
      this._peersChanged();
    };
    peer.onClose = () => {
      this.peersBySig.delete(sigId);
      gxNet.removePeer(vip);
      gxNet.meshEpoch++;
      this._status('Игрок ' + gxVipToString(vip) + ' отключился.');
      this._peersChanged();
    };
    return peer;
  }

  // Route an offer/answer/ice to its peer; buffer if the peer isn't up yet
  // (the offer can beat the welcome that creates the joiner's peer).
  _routeSignal(from, m) {
    const entry = this.peersBySig.get(from);
    if (entry) { entry.peer.signal(m); return; }
    if (!this.pending.has(from)) this.pending.set(from, []);
    this.pending.get(from).push(m);
  }

  _flushPending(sigId) {
    const q = this.pending.get(sigId);
    const entry = this.peersBySig.get(sigId);
    if (!q || !entry) return;
    for (const m of q) entry.peer.signal(m);
    this.pending.delete(sigId);
  }

  leave() {
    for (const { peer, vip } of this.peersBySig.values()) {
      try { peer.destroy(); } catch {}
      gxNet.removePeer(vip);
    }
    this.peersBySig.clear();
    this.pending.clear();
    if (this.sig) { try { this.sig.destroy(); } catch {} this.sig = null; }
    gxNet.reset();
    this._status('Отключено.');
    this._peersChanged();
  }
}

window.gxLobby = new GxLobby();
