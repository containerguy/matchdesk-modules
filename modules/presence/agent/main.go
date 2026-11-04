// matchdesk-game-agent: prototype that detects which game is running on a
// Windows PC and (optionally) reports it to Matchdesk ("Spielt gerade").
//
// Privacy: only matched games are reported, never the process list.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

type Report struct {
	Host     string        `json:"host"`
	Time     time.Time     `json:"time"`
	Playing  []Detection   `json:"playing"`
	Launcher []string      `json:"launchersFound"`
	Steam    *SteamAccount `json:"steamAccount,omitempty"`
}

func main() {
	interval := flag.Duration("interval", 0, "repeat every interval (e.g. 30s); 0 = run once")
	server := flag.String("server", "", "Matchdesk base URL to report to (POST /api/m/presence/game)")
	token := flag.String("token", os.Getenv("MATCHDESK_AGENT_KEY"), "agent key from the \"Spielt gerade\" page (default: env MATCHDESK_AGENT_KEY)")
	knownFile := flag.String("known", "", "optional JSON file [{\"exe\":\"factorio.exe\",\"title\":\"Factorio\"}]")
	noAccount := flag.Bool("no-account", false, "do not send the signed-in Steam account (SteamID64 + display name)")
	verbose := flag.Bool("v", false, "also print installed games found per launcher (local only, never sent)")
	flag.Parse()
	// Double-clicked without arguments: show one detection and keep the window open.
	interactive := len(os.Args) == 1

	var known []KnownExe
	if *knownFile != "" {
		b, err := os.ReadFile(*knownFile)
		if err == nil {
			err = json.Unmarshal(b, &known)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "known list:", err)
			os.Exit(2)
		}
	}

	// Ctrl+C or window closed: the loop finishes a report that is in flight,
	// then removes the entry in Matchdesk instead of waiting for it to expire.
	stop := make(chan os.Signal, 1)
	if *server != "" && *interval > 0 {
		signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	}

	for {
		installed, launchers := InstalledGames()
		if *verbose {
			for _, g := range installed {
				fmt.Fprintf(os.Stderr, "installed [%s] %s -> %s\n", g.Launcher, g.Title, g.Dir)
			}
		}
		appID, steamNames := SteamRunningAppID(), map[string]string{}
		for _, g := range installed {
			if g.Launcher == "steam" {
				steamNames[g.AppID] = g.Title
			}
		}
		procs, err := Processes()
		if err != nil {
			fmt.Fprintln(os.Stderr, "process list:", err)
		}
		host, _ := os.Hostname()
		r := Report{Host: host, Time: time.Now().UTC(), Playing: Detect(procs, installed, known, appID, steamNames), Launcher: launchers}
		if !*noAccount {
			r.Steam = CurrentSteamAccount()
		}
		if r.Playing == nil {
			r.Playing = []Detection{}
		}
		out, _ := json.MarshalIndent(r, "", "  ")
		fmt.Println(string(out))

		if *server != "" {
			if err := post(*server, *token, r); err != nil {
				fmt.Fprintln(os.Stderr, "post:", err)
			}
		}
		if *interval <= 0 {
			if interactive {
				fmt.Println("\nNur ein Testlauf, nichts wurde gemeldet. Zum Melden die Startdatei aus")
				fmt.Println("der Mitspielzentrale (Seite \"Spielt gerade\" -> \"Agent einrichten\") verwenden.")
				fmt.Print("\nEnter zum Beenden ...")
				_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
			}
			return
		}
		select {
		case <-stop:
			if err := clearPresence(*server, *token); err != nil {
				fmt.Fprintln(os.Stderr, "clear:", err)
			}
			return
		case <-time.After(*interval):
		}
	}
}

// post sends only the detected games and the public Steam account (SteamID64,
// display name) to Matchdesk: no host name, no launcher list, no exe names,
// no login names.
func post(server, token string, r Report) error {
	type game struct {
		Title    string `json:"title"`
		Launcher string `json:"launcher"`
		AppID    string `json:"appId,omitempty"`
	}
	playing := make([]game, 0, len(r.Playing))
	for _, d := range r.Playing {
		playing = append(playing, game{Title: d.Title, Launcher: d.Launcher, AppID: d.AppID})
	}
	payload := map[string]any{"playing": playing}
	if r.Steam != nil {
		payload["steamAccount"] = r.Steam
	}
	body, _ := json.Marshal(payload)
	return send(server, token, http.MethodPost, body)
}

// clearPresence removes this user's entry right away (agent stops).
func clearPresence(server, token string) error {
	return send(server, token, http.MethodDelete, nil)
}

func send(server, token, method string, body []byte) error {
	req, err := http.NewRequest(method, strings.TrimRight(server, "/")+"/api/m/presence/game", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	c := http.Client{Timeout: 10 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}
