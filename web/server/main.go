// GeneralsX Web - OPTIONAL convenience server.
//
// The web port is static-first: the dist/ bundle (shell + wasm + assets +
// ice.json) works on ANY web server or static hosting - COOP/COEP headers
// are injected client-side by coi-serviceworker.js when the host doesn't
// send them, signaling for multiplayer rides public MQTT-over-WebSocket
// brokers (see shell/signaling.js), and STUN/TURN come from the editable
// ice.json. No backend logic is required to play.
//
// This binary exists for two conveniences:
//   - local development (proper headers, no service-worker reload dance);
//   - IP-only deployments: -tls-self-signed provides the HTTPS secure
//     context without which browsers refuse SharedArrayBuffer and OPFS.
//
// GeneralsX @build web-port 05/07/2026 - Web port Phase 1
package main

import (
	"crypto/tls"
	"flag"
	"log"
	"net/http"
	"strings"
)

func main() {
	listen := flag.String("listen", ":8080", "listen address")
	dir := flag.String("dir", "./dist", "static bundle directory (see scripts/web/make-dist.sh)")
	tlsSelfSigned := flag.Bool("tls-self-signed", false, "serve HTTPS with an auto-generated self-signed certificate (required for IP-only access: SharedArrayBuffer/OPFS need a secure context)")
	tlsCert := flag.String("tls-cert", "", "TLS certificate file (real cert; overrides -tls-self-signed)")
	tlsKey := flag.String("tls-key", "", "TLS key file")
	flag.Parse()

	files := http.FileServer(http.Dir(*dir))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		// Cross-origin isolation for SharedArrayBuffer (pthreads).
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Embedder-Policy", "require-corp")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")

		p := r.URL.Path
		switch {
		case strings.HasSuffix(p, ".wasm"):
			// no-cache = revalidate every load (304 when unchanged): a deploy
			// must never pair a cached old .js with a new .wasm.
			h.Set("Content-Type", "application/wasm")
			h.Set("Cache-Control", "no-cache")
		case strings.HasSuffix(p, "GeneralsXZH.js"):
			h.Set("Cache-Control", "no-cache")
		case strings.HasPrefix(p, "/assets/files/"):
			// The loader appends ?v=<sha> - long cache is safe.
			h.Set("Cache-Control", "public, max-age=31536000, immutable")
		case p == "/" || strings.HasSuffix(p, ".html") ||
			strings.HasSuffix(p, "manifest.json") || strings.HasSuffix(p, "ice.json"):
			h.Set("Cache-Control", "no-cache")
		default:
			h.Set("Cache-Control", "public, max-age=300")
		}
		files.ServeHTTP(w, r)
	})

	log.Printf("GeneralsX Web (optional static server) on %s, dir=%s", *listen, *dir)

	switch {
	case *tlsCert != "" && *tlsKey != "":
		log.Printf("  tls: %s", *tlsCert)
		log.Fatal(http.ListenAndServeTLS(*listen, *tlsCert, *tlsKey, handler))
	case *tlsSelfSigned:
		cert, err := loadOrCreateSelfSigned(*dir)
		if err != nil {
			log.Fatalf("self-signed TLS setup failed: %v", err)
		}
		srv := &http.Server{
			Addr:      *listen,
			Handler:   handler,
			TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}},
		}
		log.Printf("  tls: self-signed (players accept the browser warning once)")
		log.Fatal(srv.ListenAndServeTLS("", ""))
	default:
		log.Printf("  tls: OFF - browsers only run the game over localhost or HTTPS")
		log.Fatal(http.ListenAndServe(*listen, handler))
	}
}
