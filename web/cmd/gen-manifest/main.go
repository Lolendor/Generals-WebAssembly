// gen-manifest walks an asset tree and writes manifest.json for the web
// loader: {version, totalBytes, files:[{path,size,sha256}]}.
//
// Usage: gen-manifest -dir web/assets/files -out web/assets/manifest.json -version <tag>
//
// GeneralsX @build web-port 05/07/2026 - Web port Phase 1
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type manifestFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	Sha256 string `json:"sha256"`
}

type manifest struct {
	Version    string         `json:"version"`
	TotalBytes int64          `json:"totalBytes"`
	Files      []manifestFile `json:"files"`
}

func main() {
	dir := flag.String("dir", "", "asset files directory (required)")
	out := flag.String("out", "", "output manifest.json path (required)")
	version := flag.String("version", "", "version tag (default: current date)")
	flag.Parse()

	if *dir == "" || *out == "" {
		flag.Usage()
		os.Exit(2)
	}
	if *version == "" {
		*version = time.Now().UTC().Format("2006-01-02T15:04:05Z")
	}

	var m manifest
	m.Version = *version

	err := filepath.WalkDir(*dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") || name == "manifest.json" {
			return nil
		}
		rel, err := filepath.Rel(*dir, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)

		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		h := sha256.New()
		size, err := io.Copy(h, f)
		if err != nil {
			return err
		}

		m.Files = append(m.Files, manifestFile{
			Path:   rel,
			Size:   size,
			Sha256: hex.EncodeToString(h.Sum(nil)),
		})
		m.TotalBytes += size
		return nil
	})
	if err != nil {
		log.Fatalf("walk failed: %v", err)
	}

	sort.Slice(m.Files, func(i, j int) bool { return m.Files[i].Path < m.Files[j].Path })

	data, err := json.MarshalIndent(&m, "", "  ")
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(*out, data, 0644); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("manifest: %d files, %.1f MB -> %s\n", len(m.Files), float64(m.TotalBytes)/1024/1024, *out)
}
