// GeneralsX Web - serverless P2P signaling.
//
// Ported from the author's battle-tested tunnel project
// (https://github.com/Lolendor/localhost): a minimal MQTT 3.1.1 client over
// public WebSocket brokers with automatic broker failover, used purely as a
// signaling rendezvous. Players share a short room key (XXXX-XXXX); SDP
// offers/answers and trickle ICE flow over topics derived from the key:
//     p2pt/{key}/req         - broadcast (join requests / host discovery)
//     p2pt/{key}/to/{peer}   - unicast
// After the WebRTC DataChannels connect, the brokers are out of the loop -
// all game traffic is P2P (or via the TURN relays from ice.json).
//
// Used by Phase 5 multiplayer (the WebUDP bridge). No backend required.
//
// GeneralsX @build web-port 05/07/2026

'use strict';

// Filled by loader.js from ice.json (with these as fallback defaults).
window.gxNetConfig = window.gxNetConfig || {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'turn:a.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:a.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:a.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
  mqttBrokers: [
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
    'wss://broker.emqx.io:8084/mqtt',
  ],
};

const gxRndId = () =>
  Math.random().toString(36).slice(2, 7) + Math.random().toString(36).slice(2, 7);

// Room key: 8 chars from an unambiguous alphabet, XXXX-XXXX.
function gxGenRoomKey() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let k = '';
  for (let i = 0; i < 4; i++) k += c[(Math.random() * c.length) | 0];
  k += '-';
  for (let i = 0; i < 4; i++) k += c[(Math.random() * c.length) | 0];
  return k;
}

function gxNormalizeRoomKey(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 8) return null;
  return clean.slice(0, 4) + '-' + clean.slice(4);
}

// ---------------------------------------------------------------------------
// Minimal MQTT 3.1.1 over WebSocket (CONNECT/SUBSCRIBE/PUBLISH/PING only)
// ---------------------------------------------------------------------------

const gxEnc = (s) => new TextEncoder().encode(s);
const gxU16 = (n) => [n >> 8, n & 0xff];
function gxVarLen(n) {
  const r = [];
  do {
    let b = n & 0x7f;
    n >>= 7;
    if (n > 0) b |= 0x80;
    r.push(b);
  } while (n > 0);
  return r;
}

class GxMqttClient {
  constructor(brokers) {
    this.brokers = brokers && brokers.length ? brokers : window.gxNetConfig.mqttBrokers;
    this.ws = null;
    this.clientId = 'gxgen_' + gxRndId();
    this._subCallbacks = new Map();
    this._connected = false;
    this._queue = [];
    this._pingTimer = null;
    this._brokerIdx = 0;
    this._closed = false;
    this._connectPromise = null;
  }

  connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._tryBroker();
    return this._connectPromise;
  }

  _tryBroker() {
    const url = this.brokers[this._brokerIdx % this.brokers.length];
    console.log('[mqtt] connecting to', url);
    return new Promise((res, rej) => {
      const ws = new WebSocket(url, ['mqtt']);
      const timer = setTimeout(() => {
        ws.close();
        this._nextBroker(rej);
      }, 8000);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        this.ws = ws;
        clearTimeout(timer);
        this._sendConnect();
      };
      ws.onmessage = (e) => {
        this._handlePacket(new Uint8Array(e.data), res, rej);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        if (!this._connected) this._nextBroker(rej);
      };
      ws.onclose = () => {
        this._connected = false;
        clearInterval(this._pingTimer);
        if (!this._closed) {
          setTimeout(() => {
            this._brokerIdx++;
            this._connectPromise = null;
            this.connect();
          }, 3000);
        }
      };
    });
  }

  _nextBroker(rej) {
    this._brokerIdx++;
    if (this._brokerIdx >= this.brokers.length) {
      rej(new Error('Все MQTT-брокеры недоступны'));
      return;
    }
    this._connectPromise = null;
    this._tryBroker().then(() => {}, rej);
  }

  _sendConnect() {
    const c = gxEnc(this.clientId);
    const p = new Uint8Array([0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 2, 0, 60, ...gxU16(c.length), ...c]);
    this._send(new Uint8Array([0x10, ...gxVarLen(p.length), ...p]));
  }

  _handlePacket(buf, res, rej) {
    const t = buf[0] >> 4;
    if (t === 2) { // CONNACK
      if (buf[3] === 0) {
        this._connected = true;
        this._startPing();
        // Re-establish every subscription on this (possibly new) connection.
        // Without this, a broker failover reconnects us deaf: SUBSCRIBE was
        // only ever sent on the original socket, so signaling goes silent and
        // peer (re)connects become impossible.
        for (const topic of this._subCallbacks.keys()) this._sendSubscribe(topic);
        this._flush();
        if (res) res(this);
        res = null;
      } else if (rej) {
        rej(new Error('CONNACK ' + buf[3]));
      }
    } else if (t === 3) { // PUBLISH
      this._handlePublish(buf);
    }
  }

  _handlePublish(buf) {
    let pos = 1, rl = 0, m = 1;
    while (pos < buf.length) {
      const b = buf[pos++];
      rl += (b & 0x7f) * m;
      m <<= 7;
      if (!(b & 0x80)) break;
    }
    const tl = (buf[pos] << 8) | buf[pos + 1];
    pos += 2;
    const topic = new TextDecoder().decode(buf.slice(pos, pos + tl));
    pos += tl;
    const payload = new TextDecoder().decode(buf.slice(pos));
    this._subCallbacks.forEach((cb, pat) => {
      if (this._match(pat, topic)) {
        try { cb(topic, JSON.parse(payload)); } catch {}
      }
    });
  }

  _match(pat, topic) {
    if (pat === topic) return true;
    const pp = pat.split('/'), tp = topic.split('/');
    for (let i = 0; i < pp.length; i++) {
      if (pp[i] === '#') return true;
      if (pp[i] !== '+' && pp[i] !== tp[i]) return false;
    }
    return pp.length === tp.length;
  }

  _sendSubscribe(topic) {
    const t = gxEnc(topic);
    const p = new Uint8Array([0, ((Math.random() * 255) | 0) + 1, ...gxU16(t.length), ...t, 0]);
    this._send(new Uint8Array([0x82, ...gxVarLen(p.length), ...p]));
  }

  subscribe(topic, cb) {
    this._subCallbacks.set(topic, cb);
    if (this._connected) this._sendSubscribe(topic);
    // else: sent on CONNACK by the resubscribe loop in _handlePacket.
  }

  publish(topic, data) {
    const t = gxEnc(topic);
    const d = gxEnc(typeof data === 'string' ? data : JSON.stringify(data));
    const p = new Uint8Array([...gxU16(t.length), ...t, ...d]);
    const pkt = new Uint8Array([0x30, ...gxVarLen(p.length), ...p]);
    if (this._connected) this._send(pkt);
    else this._queue.push(pkt);
  }

  _send(buf) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(buf.buffer);
  }

  _flush() {
    while (this._queue.length && this._connected) this._send(this._queue.shift());
  }

  _startPing() {
    clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => this._send(new Uint8Array([0xc0, 0])), 30000);
  }

  destroy() {
    this._closed = true;
    clearInterval(this._pingTimer);
    try { this.ws && this.ws.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Room signaling on top of MQTT
// ---------------------------------------------------------------------------

class GxSignaling {
  constructor() {
    this.mqtt = new GxMqttClient(window.gxNetConfig.mqttBrokers);
    this.myId = gxRndId();
    this.key = null;
  }

  async init(roomKey, onMsg) {
    this.key = roomKey;
    await this.mqtt.connect();
    this.mqtt.subscribe(`p2pt/${roomKey}/to/${this.myId}`, (t, m) => {
      if (m && m._from !== this.myId) onMsg(m);
    });
    this.mqtt.subscribe(`p2pt/${roomKey}/req`, (t, m) => {
      if (m && m._from !== this.myId) onMsg(m);
    });
  }

  sendTo(peerId, data) {
    data._from = this.myId;
    this.mqtt.publish(`p2pt/${this.key}/to/${peerId}`, data);
  }

  broadcast(data) {
    data._from = this.myId;
    this.mqtt.publish(`p2pt/${this.key}/req`, data);
  }

  destroy() {
    this.mqtt.destroy();
  }
}

// ---------------------------------------------------------------------------
// One WebRTC peer connection with a DataChannel
// ---------------------------------------------------------------------------

// Keepalive frame: 8 bytes [magic 'GXKA'|u8 kind|u24 seq-ish time bits].
// Sent inside the same DataChannel; receivers recognize it by the magic and
// never hand it to the game. kind: 0 = ping, 1 = pong (echoes the timestamp).
const GX_KA_MAGIC = 0x474b4158; // 'GXKA' little-endian-ish tag
const GX_KA_INTERVAL_MS = 2000;
const GX_KA_DEAD_MISSES = 3;
// Send-side buffer cap: if SCTP is backed up past this, drop like UDP would.
const GX_MAX_BUFFERED = 512 * 1024;
// Reconnect queue cap: keep only the freshest frames while a channel re-opens.
const GX_MAX_QUEUE = 64;

class GxRtcPeer {
  /**
   * @param sig       GxSignaling
   * @param remoteId  peer id on the other side
   * @param initiator true = we create the DataChannel + offer
   * @param opts      DataChannel options; game traffic uses
   *                  {ordered:false, maxPacketLifeTime:150} — bounded-latency
   *                  partial reliability: SCTP retransmits within 150 ms, then
   *                  gives up. Near-UDP latency, an order less effective loss.
   */
  constructor(sig, remoteId, initiator, opts) {
    this.sig = sig;
    this.rid = remoteId;
    this.initiator = initiator;
    this.dcOpts = opts || { ordered: true };
    this.pc = null;
    this.dc = null;
    this._open = false;
    this._q = [];
    this.onOpen = null;
    this.onClose = null;
    this.onMsg = null;  // (dataOrObj) - binary frames arrive as ArrayBuffer
    this.onDead = null; // keepalive misses / ICE failed — candidate for reconnect
    this.onRtt = null;  // (ms) smoothed RTT updates
    // stats
    this.rttMs = -1;
    this.dropsQueue = 0;    // frames dropped by queue/buffer caps
    this._kaTimer = null;
    this._kaMisses = 0;
    this._kaAwait = 0;      // timestamp of the ping we're waiting on (0 = none)
  }

  async start() {
    this.pc = new RTCPeerConnection({ iceServers: window.gxNetConfig.iceServers });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.sig.sendTo(this.rid, { t: 'ice', c: e.candidate });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed') this._reportDead('ice failed');
      else if (s === 'closed') this.onClose && this.onClose();
      // 'disconnected' is transient — keepalive decides if it's real.
    };
    if (this.initiator) {
      this.dc = this.pc.createDataChannel('gx', this.dcOpts);
      this._bindDC(this.dc);
      const o = await this.pc.createOffer();
      await this.pc.setLocalDescription(o);
      this.sig.sendTo(this.rid, { t: 'offer', sdp: o });
    } else {
      this.pc.ondatachannel = (e) => {
        this.dc = e.channel;
        this._bindDC(e.channel);
      };
    }
  }

  // ICE restart: renegotiate candidate pairs on the SAME connection — survives
  // a network/IP change without tearing down the DataChannel. Initiator only.
  async restartIce() {
    if (!this.pc || !this.initiator) return false;
    try {
      this.pc.restartIce();
      const o = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(o);
      this.sig.sendTo(this.rid, { t: 'offer', sdp: o });
      return true;
    } catch (e) {
      console.warn('[rtc] restartIce:', e);
      return false;
    }
  }

  _bindDC(dc) {
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      this._open = true;
      this._kaMisses = 0;
      this._startKeepalive();
      this._flush();
      this.onOpen && this.onOpen();
    };
    dc.onclose = () => {
      this._open = false;
      this._stopKeepalive();
      this.onClose && this.onClose();
    };
    dc.onmessage = (e) => {
      if (typeof e.data === 'string') {
        if (!this.onMsg) return;
        try { this.onMsg(JSON.parse(e.data)); } catch {}
        return;
      }
      // Binary: intercept keepalive frames, pass everything else to the game.
      if (e.data.byteLength === 12) {
        const dv = new DataView(e.data);
        if (dv.getUint32(0, true) === GX_KA_MAGIC) {
          const kind = dv.getUint32(4, true);
          const ts = dv.getFloat32(8, true);
          if (kind === 0) {                       // ping → answer with pong
            this._sendKA(1, ts);
          } else {                                // pong → RTT sample
            this._kaMisses = 0;
            this._kaAwait = 0;
            const rtt = (performance.now() % 8388608) - ts;
            const sample = rtt >= 0 ? rtt : rtt + 8388608;
            this.rttMs = this.rttMs < 0 ? sample : this.rttMs * 0.7 + sample * 0.3;
            this.onRtt && this.onRtt(this.rttMs);
          }
          return;
        }
      }
      this.onMsg && this.onMsg(e.data);
    };
  }

  _sendKA(kind, ts) {
    if (!this._open || !this.dc || this.dc.readyState !== 'open') return;
    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, GX_KA_MAGIC, true);
    dv.setUint32(4, kind, true);
    dv.setFloat32(8, ts, true);
    try { this.dc.send(buf); } catch {}
  }

  _startKeepalive() {
    this._stopKeepalive();
    this._kaTimer = setInterval(() => {
      if (!this._open) return;
      if (this._kaAwait) {
        this._kaMisses++;
        if (this._kaMisses >= GX_KA_DEAD_MISSES) {
          this._stopKeepalive();
          this._reportDead('keepalive: ' + this._kaMisses + ' misses');
          return;
        }
      }
      this._kaAwait = performance.now() % 8388608;
      this._sendKA(0, this._kaAwait);
    }, GX_KA_INTERVAL_MS);
  }

  _stopKeepalive() {
    if (this._kaTimer) { clearInterval(this._kaTimer); this._kaTimer = null; }
    this._kaAwait = 0;
  }

  _reportDead(why) {
    console.warn('[rtc] peer dead (' + why + '):', this.rid);
    if (this.onDead) this.onDead(why);
    else this.onClose && this.onClose();
  }

  async signal(msg) {
    if (!this.pc) return;
    try {
      if (msg.t === 'offer') {
        await this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const a = await this.pc.createAnswer();
        await this.pc.setLocalDescription(a);
        this.sig.sendTo(this.rid, { t: 'answer', sdp: a });
      } else if (msg.t === 'answer') {
        await this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      } else if (msg.t === 'ice') {
        await this.pc.addIceCandidate(new RTCIceCandidate(msg.c));
      }
    } catch (e) {
      console.warn('[rtc]', e);
    }
  }

  send(data) {
    // Binary passthrough for the game's datagram bridge; JSON for control.
    const payload = data instanceof ArrayBuffer || ArrayBuffer.isView(data)
      ? data : JSON.stringify(data);
    if (this._open && this.dc && this.dc.readyState === 'open') {
      // UDP semantics under congestion: if SCTP's send buffer is backed up,
      // drop instead of queueing latency (the game's own resends recover).
      if (typeof payload !== 'string' && this.dc.bufferedAmount > GX_MAX_BUFFERED) {
        this.dropsQueue++;
        return;
      }
      try { this.dc.send(payload); } catch { this.dropsQueue++; }
      return;
    }
    // Channel down (opening/reconnecting): keep only the freshest frames.
    this._q.push(payload);
    if (this._q.length > GX_MAX_QUEUE) { this._q.shift(); this.dropsQueue++; }
  }

  _flush() {
    while (this._q.length && this._open) this.dc.send(this._q.shift());
  }

  destroy() {
    this._stopKeepalive();
    this.onDead = null;
    try { this.dc && this.dc.close(); } catch {}
    try { this.pc && this.pc.close(); } catch {}
  }
}

window.GxMqttClient = GxMqttClient;
window.GxSignaling = GxSignaling;
window.GxRtcPeer = GxRtcPeer;
window.gxGenRoomKey = gxGenRoomKey;
window.gxNormalizeRoomKey = gxNormalizeRoomKey;
