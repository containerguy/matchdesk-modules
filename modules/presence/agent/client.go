package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Everything the agent says to Matchdesk. Only these endpoints exist for the agent key:
// POST/DELETE /game, GET /agent/version, GET /agent/download, plus the key-less POST
// /agent/pair that trades the one-time code from the browser for the key.

const apiBase = "/api/m/presence"

var httpClient = &http.Client{Timeout: 15 * time.Second}

// errRejected: the server no longer accepts the key (disconnected on the website or
// connected again from another PC).
var errRejected = errors.New("agent key rejected")

func endpoint(server, path string) string {
	return strings.TrimRight(server, "/") + apiBase + path
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
	_, err := send(server, token, http.MethodPost, "/game", body)
	return err
}

// clearPresence removes this user's entry right away (agent stops or pauses).
func clearPresence(server, token string) error {
	_, err := send(server, token, http.MethodDelete, "/game", nil)
	return err
}

func send(server, token, method, path string, body []byte) ([]byte, error) {
	req, err := http.NewRequest(method, endpoint(server, path), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mitspielzentrale-Agent/"+version)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusUnauthorized {
		return out, errRejected
	}
	if resp.StatusCode >= 300 {
		return out, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return out, nil
}

// PairRequest comes from the link the website opens: matchdesk-agent://pair?server=…&code=…
type PairRequest struct {
	Server string // e.g. https://lan.example:8443, without trailing slash
	Code   string // 8 characters, normalised
}

// Host is what the confirmation dialog shows.
func (p PairRequest) Host() string {
	u, err := url.Parse(p.Server)
	if err != nil {
		return p.Server
	}
	return u.Host
}

// FormattedCode: "K7MX-2QPD", like the website shows it.
func (p PairRequest) FormattedCode() string {
	if len(p.Code) == 8 {
		return p.Code[:4] + "-" + p.Code[4:]
	}
	return p.Code
}

func normalizeCode(code string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(code) {
		if (r >= '0' && r <= '9') || (r >= 'A' && r <= 'Z') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// ParsePairURL accepts only our scheme, the pair action, an http(s) server without
// credentials, path or query, and an 8-character code.
func ParsePairURL(raw string) (PairRequest, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !strings.EqualFold(u.Scheme, protocolScheme) {
		return PairRequest{}, errors.New("kein Verbindungslink")
	}
	action := u.Host
	if action == "" {
		action = strings.Trim(u.Opaque, "/")
	}
	if !strings.EqualFold(strings.Trim(action+u.Path, "/"), "pair") {
		return PairRequest{}, errors.New("unbekannte Aktion")
	}
	q := u.Query()
	server, err := url.Parse(q.Get("server"))
	if err != nil || (server.Scheme != "https" && server.Scheme != "http") || server.Host == "" ||
		server.User != nil || strings.Trim(server.Path, "/") != "" || server.RawQuery != "" || server.Fragment != "" {
		return PairRequest{}, errors.New("ungültige Serveradresse")
	}
	code := normalizeCode(q.Get("code"))
	if len(code) != 8 {
		return PairRequest{}, errors.New("ungültiger Code")
	}
	return PairRequest{Server: server.Scheme + "://" + server.Host, Code: code}, nil
}

type pairResult struct {
	Key         string `json:"key"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
}

// Name to show: display name if set, otherwise the user name.
func (r pairResult) Name() string {
	if r.DisplayName != "" {
		return r.DisplayName
	}
	return r.Username
}

// Pair trades the one-time code for the agent key. The key never passes through the browser.
func Pair(p PairRequest) (pairResult, error) {
	body, _ := json.Marshal(map[string]string{"code": p.Code})
	out, err := send(p.Server, "", http.MethodPost, "/agent/pair", body)
	var res pairResult
	if err != nil {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(out, &e)
		switch e.Error {
		case "code_ungueltig":
			return res, errors.New("Der Code ist abgelaufen oder wurde schon benutzt. Bitte auf der Seite noch einmal auf „Agent verbinden“ klicken.")
		case "zu_viele_versuche":
			return res, errors.New("Zu viele Versuche. Bitte eine Minute warten.")
		}
		return res, fmt.Errorf("Die Mitspielzentrale ist nicht erreichbar (%v).", err)
	}
	if err := json.Unmarshal(out, &res); err != nil || !strings.HasPrefix(res.Key, "md_ga_") {
		return pairResult{}, errors.New("Unerwartete Antwort der Mitspielzentrale.")
	}
	return res, nil
}

// LatestVersion asks Matchdesk which agent version it ships ("" if it ships none).
func LatestVersion(server, token string) (string, error) {
	out, err := send(server, token, http.MethodGet, "/agent/version", nil)
	if err != nil {
		return "", err
	}
	var v struct {
		Version   string `json:"version"`
		Available bool   `json:"available"`
	}
	if err := json.Unmarshal(out, &v); err != nil {
		return "", err
	}
	if !v.Available {
		return "", nil
	}
	return v.Version, nil
}

// DownloadInstaller stores the installer Matchdesk ships under dst.
func DownloadInstaller(server, token, dst string) error {
	req, err := http.NewRequest(http.MethodGet, endpoint(server, "/agent/download"), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", "Mitspielzentrale-Agent/"+version)
	c := http.Client{Timeout: 5 * time.Minute}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, io.LimitReader(resp.Body, 200<<20))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil && n < 2 {
		err = errors.New("leere Datei")
	}
	if err != nil {
		_ = os.Remove(dst)
	}
	return err
}

// NewerVersion reports whether candidate (x.y.z, optional -suffix) is newer than current.
// A development build ("dev") never offers updates.
func NewerVersion(candidate, current string) bool {
	if current == "dev" || candidate == "" {
		return false
	}
	a, b := versionParts(candidate), versionParts(current)
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

func versionParts(v string) [3]int {
	var out [3]int
	v = strings.TrimPrefix(v, "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	for i, p := range strings.SplitN(v, ".", 3) {
		out[i], _ = strconv.Atoi(p)
	}
	return out
}
