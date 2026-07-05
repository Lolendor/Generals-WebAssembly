// Self-signed TLS for IP-only deployments.
//
// SharedArrayBuffer (pthreads) and OPFS both require a SECURE CONTEXT.
// http://<ip>:<port> is not one - the game cannot start there at all.
// -tls-self-signed generates a persistent self-signed certificate (stored
// next to the assets dir) so operators without a domain can serve
// https://<ip>:<port>; players accept the browser warning once.
//
// GeneralsX @build web-port 05/07/2026 - Web port Phase 1
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"log"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// loadOrCreateSelfSigned returns a TLS certificate, generating and persisting
// one (valid 10 years, for all local interface IPs + localhost) if missing.
func loadOrCreateSelfSigned(dir string) (tls.Certificate, error) {
	certPath := filepath.Join(dir, "gx-selfsigned.crt")
	keyPath := filepath.Join(dir, "gx-selfsigned.key")

	if c, err := tls.LoadX509KeyPair(certPath, keyPath); err == nil {
		return c, nil
	}

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}

	tmpl := x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "GeneralsX Web"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}

	// Cover every non-loopback interface address so https://<lan-ip> matches.
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && ipn.IP.To16() != nil {
				tmpl.IPAddresses = append(tmpl.IPAddresses, ipn.IP)
			}
		}
	}

	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyDer, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return tls.Certificate{}, err
	}

	certPem := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPem := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDer})
	if err := os.WriteFile(certPath, certPem, 0644); err != nil {
		log.Printf("WARNING: cannot persist self-signed cert: %v", err)
	}
	if err := os.WriteFile(keyPath, keyPem, 0600); err != nil {
		log.Printf("WARNING: cannot persist self-signed key: %v", err)
	}
	log.Printf("Generated self-signed TLS certificate: %s", certPath)

	return tls.X509KeyPair(certPem, keyPem)
}
