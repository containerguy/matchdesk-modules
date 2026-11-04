package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPostSendsOnlyGames(t *testing.T) {
	var gotPath, gotAuth, gotMethod string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth, gotMethod = r.URL.Path, r.Header.Get("Authorization"), r.Method
		b, _ := io.ReadAll(r.Body)
		if len(b) > 0 {
			_ = json.Unmarshal(b, &body)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	r := Report{Host: "DESKTOP-M4PJL0I", Launcher: []string{"steam"}, Playing: []Detection{
		{Title: "Counter-Strike 2", Launcher: "steam", AppID: "730", Source: "steam-registry"},
		{Title: "Battlefield™ 2042", Launcher: "ea", Exe: "bf2042.exe", Source: "install-dir"},
	}}
	if err := post(srv.URL+"/", "hm_at_x", r); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/m/presence/game" || gotAuth != "Bearer hm_at_x" || gotMethod != http.MethodPost {
		t.Fatalf("request: %s %s %s", gotMethod, gotPath, gotAuth)
	}
	raw, _ := json.Marshal(body)
	want := `{"playing":[{"appId":"730","launcher":"steam","title":"Counter-Strike 2"},{"launcher":"ea","title":"Battlefield™ 2042"}]}`
	if string(raw) != want {
		t.Fatalf("body:\n got %s\nwant %s", raw, want)
	}

	if err := clearPresence(srv.URL, "hm_at_x"); err != nil || gotMethod != http.MethodDelete {
		t.Fatalf("clear: %v %s", err, gotMethod)
	}
}

func TestPostIncludesSteamAccount(t *testing.T) {
	var raw []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	r := Report{Steam: &SteamAccount{SteamID: "76561198000000001", PersonaName: "René"}}
	if err := post(srv.URL, "k", r); err != nil {
		t.Fatal(err)
	}
	want := `{"playing":[],"steamAccount":{"steamId":"76561198000000001","personaName":"René"}}`
	if string(raw) != want {
		t.Fatalf("body:\n got %s\nwant %s", raw, want)
	}
}
