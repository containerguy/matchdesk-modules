package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestParsePairURL(t *testing.T) {
	ok := []struct{ in, server, code string }{
		{"matchdesk-agent://pair?server=https%3A%2F%2Flan.example%3A8443&code=K7MX2QPD", "https://lan.example:8443", "K7MX2QPD"},
		{"MATCHDESK-AGENT://pair/?server=http://192.168.1.10/&code=k7mx-2qpd", "http://192.168.1.10", "K7MX2QPD"},
		{"matchdesk-agent:pair?server=https://lan.example&code=K7MX2QPD", "https://lan.example", "K7MX2QPD"},
	}
	for _, c := range ok {
		got, err := ParsePairURL(c.in)
		if err != nil || got.Server != c.server || got.Code != c.code {
			t.Errorf("%s: got %+v, %v", c.in, got, err)
		}
	}
	if got, _ := ParsePairURL(ok[0].in); got.Host() != "lan.example:8443" || got.FormattedCode() != "K7MX-2QPD" {
		t.Errorf("host/code: %s %s", got.Host(), got.FormattedCode())
	}
	bad := []string{
		"https://lan.example/pair?server=https://lan.example&code=K7MX2QPD",
		"matchdesk-agent://open?server=https://lan.example&code=K7MX2QPD",
		"matchdesk-agent://pair?server=file:///C:/x&code=K7MX2QPD",
		"matchdesk-agent://pair?server=https://user:pw@lan.example&code=K7MX2QPD",
		"matchdesk-agent://pair?server=https://lan.example/evil&code=K7MX2QPD",
		"matchdesk-agent://pair?server=https://lan.example&code=K7MX",
		"matchdesk-agent://pair?code=K7MX2QPD",
	}
	for _, in := range bad {
		if _, err := ParsePairURL(in); err == nil {
			t.Errorf("%s: accepted", in)
		}
	}
}

func TestNewerVersion(t *testing.T) {
	for _, c := range []struct {
		cand, cur string
		want      bool
	}{
		{"1.1.0", "1.0.9", true},
		{"1.10.0", "1.9.0", true},
		{"1.1.0", "1.1.0", false},
		{"1.0.0", "1.1.0", false},
		{"2.0.0-beta.1", "1.9.9", true},
		{"1.2.0", "dev", false},
		{"", "1.0.0", false},
	} {
		if got := NewerVersion(c.cand, c.cur); got != c.want {
			t.Errorf("NewerVersion(%q, %q) = %v", c.cand, c.cur, got)
		}
	}
}

func TestConfigRoundTrip(t *testing.T) {
	dir := t.TempDir()
	c, err := LoadConfig(dir)
	if err != nil || c.Connected() {
		t.Fatalf("empty: %+v %v", c, err)
	}
	c.Server, c.User = "https://lan.example", "René"
	if err := c.SetKey("md_ga_secret"); err != nil {
		t.Fatal(err)
	}
	if err := SaveConfig(dir, c); err != nil {
		t.Fatal(err)
	}
	back, err := LoadConfig(dir)
	if err != nil || !back.Connected() || back.Key() != "md_ga_secret" || back.User != "René" {
		t.Fatalf("back: %+v %v", back, err)
	}
}

// fakeServer behaves like the presence module for the agent's endpoints.
type fakeServer struct {
	mu      sync.Mutex
	key     string
	reports int
	deletes int
	version string
}

func (f *fakeServer) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		auth := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/m/presence/agent/pair":
			var body struct{ Code string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Code != "K7MX2QPD" {
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"error":"code_ungueltig"}`))
				return
			}
			f.key = "md_ga_paired"
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"key":"md_ga_paired","username":"rene","displayName":"René"}`))
		case "POST /api/m/presence/game", "DELETE /api/m/presence/game", "GET /api/m/presence/agent/version":
			if auth == "" || auth != f.key {
				w.WriteHeader(401)
				return
			}
			switch r.Method {
			case "POST":
				f.reports++
				w.WriteHeader(204)
			case "DELETE":
				f.deletes++
				w.WriteHeader(204)
			default:
				_, _ = w.Write([]byte(`{"version":"` + f.version + `","available":true}`))
			}
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	})
}

func TestPairAndReport(t *testing.T) {
	fake := &fakeServer{version: "9.0.0"}
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()
	dir := t.TempDir()

	if err := connect(dir, PairRequest{Server: srv.URL, Code: "AAAAAAAA"}); err == nil || !strings.Contains(err.Error(), "abgelaufen") {
		t.Fatalf("wrong code: %v", err)
	}
	if err := connect(dir, PairRequest{Server: srv.URL, Code: "K7MX2QPD"}); err != nil {
		t.Fatal(err)
	}
	cfg, _ := LoadConfig(dir)
	if cfg.User != "René" || cfg.Key() != "md_ga_paired" || cfg.Server != srv.URL {
		t.Fatalf("config: %+v", cfg)
	}

	oldVersion := version
	version = "1.0.0"
	defer func() { version = oldVersion }()

	statuses := make(chan Status, 16)
	a := NewAgent(dir, func(s Status) {
		select {
		case statuses <- s:
		default:
		}
	})
	go a.Run()
	s := waitStatus(t, statuses, func(s Status) bool { return s.Connected && s.UpdateVersion != "" })
	if s.User != "René" || s.UpdateVersion != "9.0.0" || s.LastError != "" {
		t.Fatalf("status: %+v", s)
	}

	a.SetPaused(true)
	waitStatus(t, statuses, func(s Status) bool { return s.Paused })

	// Disconnected on the website: the server rejects the key.
	fake.mu.Lock()
	fake.key = "md_ga_other"
	fake.mu.Unlock()
	a.SetPaused(false)
	waitStatus(t, statuses, func(s Status) bool { return s.Rejected })

	a.Disconnect()
	if a.Status().Connected {
		t.Fatal("still connected")
	}
	if c, _ := LoadConfig(dir); c.Connected() {
		t.Fatal("config still there")
	}
	a.Stop()

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.reports < 1 || fake.deletes < 1 {
		t.Fatalf("reports=%d deletes=%d", fake.reports, fake.deletes)
	}
}

func waitStatus(t *testing.T, ch <-chan Status, ok func(Status) bool) Status {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case s := <-ch:
			if ok(s) {
				return s
			}
		case <-deadline:
			t.Fatal("timeout waiting for status")
		}
	}
}
