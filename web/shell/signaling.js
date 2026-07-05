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

  subscribe(topic, cb) {
    this._subCallbacks.set(topic, cb);
    const t = gxEnc(topic);
    const p = new Uint8Array([0, ((Math.random() * 255) | 0) + 1, ...gxU16(t.length), ...t, 0]);
    const pkt = new Uint8Array([0x82, ...gxVarLen(p.length), ...p]);
    if (this._connected) this._send(pkt);
    else this._queue.push(pkt);
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

class GxRtcPeer {
  /**
   * @param sig       GxSignaling
   * @param remoteId  peer id on the other side
   * @param initiator true = we create the DataChannel + offer
   * @param opts      DataChannel options; game traffic uses
   *                  {ordered:false, maxRetransmits:0} (UDP semantics)
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
    this.onMsg = null; // (dataOrObj) - binary frames arrive as ArrayBuffer
  }

  async start() {
    this.pc = new RTCPeerConnection({ iceServers: window.gxNetConfig.iceServers });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.sig.sendTo(this.rid, { t: 'ice', c: e.candidate });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (['failed', 'disconnected', 'closed'].includes(s)) this.onClose && this.onClose();
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

  _bindDC(dc) {
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      this._open = true;
      this._flush();
      this.onOpen && this.onOpen();
    };
    dc.onclose = () => {
      this._open = false;
      this.onClose && this.onClose();
    };
    dc.onmessage = (e) => {
      if (!this.onMsg) return;
      if (typeof e.data === 'string') {
        try { this.onMsg(JSON.parse(e.data)); } catch {}
      } else {
        this.onMsg(e.data);
      }
    };
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
    if (this._open && this.dc && this.dc.readyState === 'open') this.dc.send(payload);
    else this._q.push(payload);
  }

  _flush() {
    while (this._q.length && this._open) this.dc.send(this._q.shift());
  }

  destroy() {
    try { this.dc && this.dc.close(); } catch {}
    try { this.pc && this.pc.close(); } catch {}
  }
}

window.GxMqttClient = GxMqttClient;
window.GxSignaling = GxSignaling;
window.GxRtcPeer = GxRtcPeer;
window.gxGenRoomKey = gxGenRoomKey;
window.gxNormalizeRoomKey = gxNormalizeRoomKey;
