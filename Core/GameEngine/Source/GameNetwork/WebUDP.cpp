/*
**	Command & Conquer Generals Zero Hour(tm)
**	Copyright 2025 Electronic Arts Inc.
**
**	This program is free software: you can redistribute it and/or modify
**	it under the terms of the GNU General Public License as published by
**	the Free Software Foundation, either version 3 of the License, or
**	(at your option) any later version.
**
**	This program is distributed in the hope that it will be useful,
**	but WITHOUT ANY WARRANTY; without even the implied warranty of
**	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
**	GNU General Public License for more details.
**
**	You should have received a copy of the GNU General Public License
**	along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// FILE: WebUDP.cpp ////////////////////////////////////////////////////////////
// Emscripten replacement for udp.cpp. The browser has no UDP sockets, so the
// game's single UDP transport is bridged to a JavaScript peer mesh:
//
//   - Bind(ip,port)  registers a virtual socket with the JS bridge (gxNet).
//     The bound IP is the lobby-assigned virtual address (10.77.x.y); the port
//     is the game's chosen port. Each UDP object gets a unique handle so the
//     bridge can route inbound datagrams to the right socket's queue.
//   - Write(...)     hands one datagram to gxNet, which routes it: a broadcast
//     destination (255.255.255.255) goes to every peer in the room (this is how
//     the LAN lobby's host discovery works unchanged); a unicast destination
//     goes to the peer whose virtual IP matches, over its WebRTC DataChannel
//     (or the relay fallback). UDP semantics (unordered, lossy) match a
//     DataChannel opened with {ordered:false, maxRetransmits:0}.
//   - Read(...)      pops one queued datagram for this socket into the caller's
//     buffer and fills `from` with the sender's virtual address. Non-blocking:
//     returns 0 when the queue is empty (Transport polls in a while loop).
//
// The engine runs on a dedicated pthread (PROXY_TO_PTHREAD); WebRTC/WebSocket
// live on the main thread. MAIN_THREAD_EM_ASM proxies each call to the main
// thread, and because the wasm heap is a SharedArrayBuffer the JS side reads
// and writes the pthread's buffers directly (same pattern as WebMain.cpp).
//
// GeneralsX @build web-port 5b 08/07/2026
///////////////////////////////////////////////////////////////////////////////

#ifdef __EMSCRIPTEN__

// SYSTEM INCLUDES ////////////////////////////////////////////////////////////
#include "PreRTS.h"	// This must go first in EVERY cpp file in the GameEngine

// USER INCLUDES //////////////////////////////////////////////////////////////
#include "Common/GameEngine.h"
#include "GameNetwork/udp.h"

#include <emscripten.h>
#include <emscripten/threading.h>
#include <cstring>

//-------------------------------------------------------------------------
// Each UDP object owns a unique bridge handle so gxNet can keep a separate
// inbound queue per socket (Transport has one; FirewallHelper opens spares).
static Int gxNextUdpHandle = 1;

//-------------------------------------------------------------------------

UDP::UDP()
{
	// fd doubles as our bridge handle here (0 = unbound).
	fd = 0;
	myIP = 0;
	myPort = 0;
	m_lastError = 0;
	memset(&addr, 0, sizeof(addr));
}

UDP::~UDP()
{
	if (fd) {
		const Int handle = fd;
		MAIN_THREAD_EM_ASM({
			if (typeof gxNet !== 'undefined') gxNet.close($0);
		}, handle);
		fd = 0;
	}
}

// Host-name bind: the browser mesh addresses peers by virtual IPv4 only, so a
// numeric string is parsed and a name is unsupported (returns failure like the
// native path does when resolution fails).
Int UDP::Bind(const char *Host, UnsignedShort port)
{
	if (Host && isdigit((unsigned char)Host[0]))
		return Bind(ntohl(inet_addr(Host)), port);
	return UNKNOWN;
}

// Register a virtual socket. IP/port are in host byte order (same contract as
// the native UDP::Bind). A zero IP means "any" — the bridge fills in the
// lobby-assigned virtual IP.
Int UDP::Bind(UnsignedInt IP, UnsignedShort Port)
{
	myIP = IP;
	myPort = Port;
	fd = gxNextUdpHandle++;

	const Int handle = fd;
	// gxNet.bind returns the virtual IP actually assigned (host order) so a
	// wildcard bind still reports a concrete local address to getLocalAddr().
	const UnsignedInt assignedIP = (UnsignedInt)MAIN_THREAD_EM_ASM_INT({
		return (typeof gxNet !== 'undefined') ? (gxNet.bind($0, $1 >>> 0, $2) >>> 0) : ($1 >>> 0);
	}, handle, IP, (Int)Port);

	if (assignedIP) myIP = assignedIP;
	return OK;
}

Int UDP::getLocalAddr(UnsignedInt &ip, UnsignedShort &port)
{
	ip = myIP;
	port = myPort;
	return OK;
}

// private — no-op in the browser (sockets are always "non-blocking" queues).
Int UDP::SetBlocking(Int block)
{
	(void)block;
	return OK;
}

// Route one datagram to the mesh. IP/port are host byte order. Returns the
// number of bytes "sent" (== len) or a negative sockStat on error, matching the
// native contract Transport checks (>0 means success).
Int UDP::Write(const unsigned char *msg, UnsignedInt len, UnsignedInt IP, UnsignedShort port)
{
	if (IP == 0 || port == 0) return ADDRNOTAVAIL;
	if (fd == 0) return NOTSOCK;

	ClearStatus();
	const Int handle = fd;
	MAIN_THREAD_EM_ASM({
		if (typeof gxNet !== 'undefined')
			gxNet.send($0, $1 >>> 0, $2, $3, $4);
	}, handle, IP, (Int)port, (Int)msg, (Int)len);

	return (Int)len;
}

// Pop one queued datagram for this socket. Non-blocking: 0 when empty. Fills
// `from` in NETWORK byte order (Transport applies ntohl/ntohs to it).
Int UDP::Read(unsigned char *msg, UnsignedInt len, sockaddr_in *from)
{
	if (fd == 0) return 0;

	// Scratch cells the JS side writes the sender address into (shared heap).
	UnsignedInt srcIP = 0;
	Int srcPort = 0;
	const Int handle = fd;

	const Int n = MAIN_THREAD_EM_ASM_INT({
		return (typeof gxNet !== 'undefined')
			? gxNet.recv($0, $1, $2, $3, $4)
			: 0;
	}, handle, (Int)msg, (Int)len, (Int)&srcIP, (Int)&srcPort);

	if (n <= 0) return 0;

	if (from != nullptr) {
		memset(from, 0, sizeof(*from));
		from->sin_family = AF_INET;
		from->sin_addr.s_addr = htonl(srcIP);
		from->sin_port = htons((UnsignedShort)srcPort);
	}
	return n;
}

void UDP::ClearStatus()
{
	m_lastError = 0;
}

UDP::sockStat UDP::GetStatus()
{
	return (sockStat)m_lastError;
}

// Kernel buffer sizing is meaningless for a JS queue — report success/plausible
// values so callers that check them keep working.
Int UDP::SetInputBuffer(UnsignedInt bytes)  { (void)bytes; return TRUE; }
Int UDP::SetOutputBuffer(UnsignedInt bytes) { (void)bytes; return TRUE; }
int UDP::GetInputBuffer()  { return 65536; }
int UDP::GetOutputBuffer() { return 65536; }

// Broadcasts are always permitted by the mesh (the bridge decides routing per
// datagram from the destination address).
Int UDP::AllowBroadcasts(Bool status) { (void)status; return TRUE; }

#endif // __EMSCRIPTEN__
