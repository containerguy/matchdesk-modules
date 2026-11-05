// Mitspielzentrale Agent ("Spielt gerade"): detects which game is running on a Windows PC
// and reports it to Matchdesk. Runs as a tray app without a console window; connected via
// a matchdesk-agent:// link from the website, which hands over a one-time code.
//
// Privacy: only matched games are reported, never the process list.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// version is set by the release pipeline (-ldflags "-X main.version=1.1.0").
var version = "dev"

const (
	appName        = "Mitspielzentrale Agent"
	protocolScheme = "matchdesk-agent"
)

func main() {
	once := flag.Bool("once", false, "detect once, print JSON to stdout and exit (nothing is sent)")
	verbose := flag.Bool("v", false, "with -once: also list installed games per launcher (local only)")
	knownFile := flag.String("known", "", "with -once: optional JSON file [{\"exe\":\"factorio.exe\",\"title\":\"Factorio\"}]")
	background := flag.Bool("background", false, "start quietly (Windows autostart)")
	flag.Parse()

	if *once {
		runOnce(*knownFile, *verbose)
		return
	}

	dir := appDir()
	setupLog(dir)

	var pairLink string
	for _, arg := range flag.Args() {
		if strings.HasPrefix(strings.ToLower(arg), protocolScheme+":") {
			pairLink = arg
		}
	}
	runApp(dir, pairLink, *background)
}

func runOnce(knownFile string, verbose bool) {
	var known []KnownExe
	if knownFile != "" {
		b, err := os.ReadFile(knownFile)
		if err == nil {
			err = json.Unmarshal(b, &known)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "known list:", err)
			os.Exit(2)
		}
	}
	if verbose {
		installed, _ := InstalledGames()
		for _, g := range installed {
			fmt.Fprintf(os.Stderr, "installed [%s] %s -> %s\n", g.Launcher, g.Title, g.Dir)
		}
	}
	out, _ := json.MarshalIndent(DetectOnce(known, true), "", "  ")
	fmt.Println(string(out))
}

// setupLog writes to agent.log next to the config; it is cut when it grows beyond 1 MB.
func setupLog(dir string) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return
	}
	path := filepath.Join(dir, "agent.log")
	if fi, err := os.Stat(path); err == nil && fi.Size() > 1<<20 {
		_ = os.Remove(path)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		log.SetOutput(io.Discard)
		return
	}
	log.SetOutput(f)
	log.Printf("%s %s gestartet", appName, version)
}
