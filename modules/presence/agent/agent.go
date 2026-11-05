package main

import (
	"errors"
	"log"
	"os"
	"sync"
	"time"
)

const (
	reportInterval = 30 * time.Second
	versionEvery   = 6 * time.Hour
)

// Report is one detection run. Only Playing (title, launcher, app ID) and Steam are sent.
type Report struct {
	Host     string        `json:"host"`
	Time     time.Time     `json:"time"`
	Playing  []Detection   `json:"playing"`
	Launcher []string      `json:"launchersFound"`
	Steam    *SteamAccount `json:"steamAccount,omitempty"`
}

// Status is what the tray shows.
type Status struct {
	Connected     bool
	Rejected      bool // server no longer accepts the key: connect again on the website
	Paused        bool
	Server        string
	User          string
	Playing       []string
	LastError     string
	UpdateVersion string // newer agent available from Matchdesk
}

// Agent runs detection and reporting in the background; the tray only reads Status and
// calls the setters.
type Agent struct {
	dir      string
	onChange func(Status)

	mu          sync.Mutex
	cfg         Config
	status      Status
	lastVersion time.Time

	wake chan struct{}
	stop chan struct{}
	done chan struct{}
}

func NewAgent(dir string, onChange func(Status)) *Agent {
	return &Agent{dir: dir, onChange: onChange, wake: make(chan struct{}, 1), stop: make(chan struct{}), done: make(chan struct{})}
}

// Reload reads the config again (after connecting from a second instance) and reports at once.
func (a *Agent) Reload() {
	a.load()
	a.poke()
}

func (a *Agent) load() {
	cfg, err := LoadConfig(a.dir)
	if err != nil {
		log.Printf("config: %v", err)
	}
	a.mu.Lock()
	a.cfg = cfg
	a.status = Status{}
	a.lastVersion = time.Time{}
	a.mu.Unlock()
}

func (a *Agent) poke() {
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

func (a *Agent) Status() Status {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.snapshot()
}

func (a *Agent) snapshot() Status {
	s := a.status
	s.Connected = a.cfg.Connected()
	s.Paused = a.cfg.Paused
	s.Server = a.cfg.Server
	s.User = a.cfg.User
	return s
}

func (a *Agent) changed() {
	s := a.Status()
	if a.onChange != nil {
		a.onChange(s)
	}
}

func (a *Agent) SetPaused(paused bool) {
	a.mu.Lock()
	a.cfg.Paused = paused
	cfg := a.cfg
	a.mu.Unlock()
	if err := SaveConfig(a.dir, cfg); err != nil {
		log.Printf("config: %v", err)
	}
	if paused && cfg.Connected() {
		_ = clearPresence(cfg.Server, cfg.Key())
	}
	a.poke()
	a.changed()
}

// Disconnect forgets server and key on this PC and removes the entry right away.
func (a *Agent) Disconnect() {
	a.mu.Lock()
	cfg := a.cfg
	a.cfg = Config{}
	a.status = Status{}
	a.mu.Unlock()
	if cfg.Connected() {
		_ = clearPresence(cfg.Server, cfg.Key())
	}
	if err := os.Remove(configFile(a.dir)); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("config: %v", err)
	}
	a.changed()
}

// Config returns server and key for actions like the update download.
func (a *Agent) Config() Config {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg
}

// Run reports every 30 s until Stop. Paused or not connected: nothing is detected or sent.
func (a *Agent) Run() {
	defer close(a.done)
	a.load()
	for {
		a.tick()
		select {
		case <-a.stop:
			cfg := a.Config()
			if cfg.Connected() && !cfg.Paused {
				if err := clearPresence(cfg.Server, cfg.Key()); err != nil {
					log.Printf("clear: %v", err)
				}
			}
			return
		case <-a.wake:
		case <-time.After(reportInterval):
		}
	}
}

func (a *Agent) Stop() {
	close(a.stop)
	select {
	case <-a.done:
	case <-time.After(5 * time.Second):
	}
}

func (a *Agent) tick() {
	cfg := a.Config()
	if !cfg.Connected() || cfg.Paused {
		a.mu.Lock()
		a.status.Playing = nil
		a.mu.Unlock()
		a.changed()
		return
	}
	r := DetectOnce(loadKnown(a.dir), !cfg.NoSteamAccount)
	err := post(cfg.Server, cfg.Key(), r)

	a.mu.Lock()
	a.status.Playing = a.status.Playing[:0]
	for _, d := range r.Playing {
		a.status.Playing = append(a.status.Playing, d.Title)
	}
	a.status.Rejected = errors.Is(err, errRejected)
	a.status.LastError = ""
	if err != nil {
		a.status.LastError = err.Error()
		log.Printf("report: %v", err)
	}
	checkVersion := err == nil && time.Since(a.lastVersion) >= versionEvery
	if checkVersion {
		a.lastVersion = time.Now()
	}
	a.mu.Unlock()

	if checkVersion {
		if latest, err := LatestVersion(cfg.Server, cfg.Key()); err == nil {
			a.mu.Lock()
			a.status.UpdateVersion = ""
			if NewerVersion(latest, version) {
				a.status.UpdateVersion = latest
			}
			a.mu.Unlock()
		}
	}
	a.changed()
}

// DetectOnce runs one detection. withAccount adds the signed-in Steam account.
func DetectOnce(known []KnownExe, withAccount bool) Report {
	installed, launchers := InstalledGames()
	appID, steamNames := SteamRunningAppID(), map[string]string{}
	for _, g := range installed {
		if g.Launcher == "steam" {
			steamNames[g.AppID] = g.Title
		}
	}
	procs, err := Processes()
	if err != nil {
		log.Printf("process list: %v", err)
	}
	host, _ := os.Hostname()
	r := Report{Host: host, Time: time.Now().UTC(), Playing: Detect(procs, installed, known, appID, steamNames), Launcher: launchers}
	if withAccount {
		r.Steam = CurrentSteamAccount()
	}
	if r.Playing == nil {
		r.Playing = []Detection{}
	}
	return r
}
