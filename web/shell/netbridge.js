// GeneralsX Web - UDP-over-WebRTC bridge (gxNet).
//
// The C++ WebUDP class (game pthread) calls into this object on the main thread
// via MAIN_THREAD_EM_ASM. gxNet presents a virtual UDP layer over a peer mesh:
//
//   bind(handle, ip, port)            → register a virtual socket, return the
//                                        assigned virtual IP (host byte order)
//   close(handle)
//   send(handle, dstIP, dstPort, ptr, len)   → route a datagram (HEAPU8[ptr..])
//   recv(handle, dstPtr, maxLen, ipPtr, portPtr) → pop one datagram into the
//                                        wasm heap, return its length (0 = empty)
//
// Topology: a star with the host as relay. Every player gets a virtual IPv4
// 10.77.0.N (host order int); the host is 10.77.0.1. Each joiner holds a single
// DataChannel to the host; the host forwards unicast between joiners and fans
// broadcasts out to everyone. This makes the game's LAN lobby (which discovers
// hosts via 255.255.255.255 broadcast and then unicasts game packets by IP)
// work unchanged for N players, with no full mesh.
//
// Wire frame on a DataChannel (little-endian) — 12-byte header + payload:
//   u32 srcIP | u16 srcPort | u32 dstIP | u16 dstPort | <payload...>
// dstIP lets the host route/forward; dstPort selects the receiver's local
// virtual socket queue; srcIP/srcPort fill the game's `from` address.
//
// GeneralsX @build web-port 5b 08/07/2026

'use strict';

const GX_BROADCAST = 0xffffffff >>> 0;
const GX_VNET_BASE = (10 << 24) | (77 << 16); // 10.77.0.0
const GX_HDR = 12;

class GxNet {
  constructor() {
    this.sockets = new Map();      // handle -> { port, queue: [{ip,port,bytes}] }
    this.portToHandle = new Map(); // dstPort -> handle (inbound routing)
    this.peers = new Map();        // vip(host int) -> GxRtcPeer
    this.myVip = 0;                // our assigned virtual IP (host int)
    this.hostVip = 0;              // the relay's virtual IP (0 if we are host)
    this.isHost = false;
    this.meshEpoch = 0;            // bumps on peer connect/disconnect; the engine
                                   // polls this to force an instant LAN re-announce
  }

  // ── C++-facing API (called via MAIN_THREAD_EM_ASM) ──────────────────────────

  bind(handle, ip, port) {
    this.sockets.set(handle, { port, queue: [] });
    if (port) this.portToHandle.set(port, handle);
    return this.myVip || (ip >>> 0);
  }

  close(handle) {
    const s = this.sockets.get(handle);
    if (s && s.port) this.portToHandle.delete(s.port);
    this.sockets.delete(handle);
  }

  // Send a datagram. dstIP/dstPort host order; ptr/len point into HEAPU8.
  send(handle, dstIP, dstPort, ptr, len) {
    const src = this.sockets.get(handle);
    const srcPort = src ? src.port : 0;
    dstIP = dstIP >>> 0;
    // Copy out of the (shared) wasm heap immediately — the pthread reuses it.
    const payload = HEAPU8.slice(ptr, ptr + len);
    const frame = this._frame(this.myVip, srcPort, dstIP, dstPort, payload);

    if (dstIP === GX_BROADCAST) {
      // Deliver to every peer we hold a channel to. The host reaches all
      // joiners directly; a joiner reaches only the host, which re-fans below.
      for (const peer of this.peers.values()) peer.send(frame);
      return;
    }
    // Unicast: direct channel if we have one, else route via the host relay.
    const direct = this.peers.get(dstIP);
    if (direct) { direct.send(frame); return; }
    if (!this.isHost && this.hostVip) {
      const relay = this.peers.get(this.hostVip);
      if (relay) relay.send(frame);
    }
    // else: unknown destination, dropped (UDP semantics).
  }

  recv(handle, dstPtr, maxLen, ipPtr, portPtr) {
    const s = this.sockets.get(handle);
    if (!s || s.queue.length === 0) return 0;
    const dg = s.queue.shift();
    const n = Math.min(dg.bytes.length, maxLen);
    HEAPU8.set(dg.bytes.subarray(0, n), dstPtr);
    HEAP32[ipPtr >> 2] = dg.ip | 0;
    HEAP32[portPtr >> 2] = dg.port | 0;
    return n;
  }

  // ── Mesh plumbing ───────────────────────────────────────────────────────────

  // A frame arrived on a peer's DataChannel. Deliver locally and/or forward.
  _onFrame(buf) {
    if (buf.byteLength < GX_HDR) return;
    const dv = new DataView(buf);
    const srcIP = dv.getUint32(0, true) >>> 0;
    const srcPort = dv.getUint16(4, true);
    const dstIP = dv.getUint32(6, true) >>> 0;
    const dstPort = dv.getUint16(10, true);

    const isBroadcast = dstIP === GX_BROADCAST;
    const forMe = isBroadcast || dstIP === this.myVip;

    if (forMe) this._deliverLocal(srcIP, srcPort, dstPort, new Uint8Array(buf, GX_HDR));

    // Host relays: re-fan broadcasts to other joiners; forward unicast onward.
    if (this.isHost) {
      if (isBroadcast) {
        for (const [vip, peer] of this.peers) {
          if (vip !== srcIP) peer.send(buf);   // don't echo to the sender
        }
      } else if (!forMe) {
        const dest = this.peers.get(dstIP);
        if (dest) dest.send(buf);
      }
    }
  }

  _deliverLocal(srcIP, srcPort, dstPort, payload) {
    const handle = this.portToHandle.get(dstPort);
    if (handle === undefined) return;            // no socket bound to that port
    const s = this.sockets.get(handle);
    if (s) s.queue.push({ ip: srcIP, port: srcPort, bytes: payload });
  }

  _frame(srcIP, srcPort, dstIP, dstPort, payload) {
    const out = new Uint8Array(GX_HDR + payload.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, srcIP >>> 0, true);
    dv.setUint16(4, srcPort, true);
    dv.setUint32(6, dstIP >>> 0, true);
    dv.setUint16(10, dstPort, true);
    out.set(payload, GX_HDR);
    return out.buffer;
  }

  // ── Lobby-facing API ────────────────────────────────────────────────────────

  reset() {
    for (const p of this.peers.values()) { try { p.destroy(); } catch {} }
    this.peers.clear();
    this.myVip = 0; this.hostVip = 0; this.isHost = false;
  }

  setSelf(vip, isHost, hostVip) {
    this.myVip = vip >>> 0;
    this.isHost = !!isHost;
    this.hostVip = (hostVip || 0) >>> 0;
  }

  addPeer(vip, peer) {
    vip = vip >>> 0;
    this.peers.set(vip, peer);
    const prev = peer.onMsg;
    peer.onMsg = (data) => {
      if (data instanceof ArrayBuffer) this._onFrame(data);
      else if (prev) prev(data);
    };
  }

  removePeer(vip) {
    vip = vip >>> 0;
    const p = this.peers.get(vip);
    if (p) { try { p.destroy(); } catch {} this.peers.delete(vip); }
  }
}

// Host-order virtual IP → dotted-quad (for logs/UI).
function gxVipToString(vip) {
  vip = vip >>> 0;
  return ((vip >>> 24) & 0xff) + '.' + ((vip >>> 16) & 0xff) + '.' +
         ((vip >>> 8) & 0xff) + '.' + (vip & 0xff);
}
// Build a 10.77.0.N virtual IP (host order int).
function gxVip(n) { return (GX_VNET_BASE | (n & 0xffff)) >>> 0; }

window.gxNet = new GxNet();
window.gxVipToString = gxVipToString;
window.gxVip = gxVip;
window.GX_BROADCAST = GX_BROADCAST;
