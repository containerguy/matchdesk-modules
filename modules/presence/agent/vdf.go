package main

import (
	"regexp"
	"strconv"
	"strings"
)

// Minimal readers for Steam's KeyValues text files. Enough for
// libraryfolders.vdf ("path") and appmanifest_*.acf ("appid", "name", "installdir").

var kvLine = regexp.MustCompile(`^\s*"([^"]+)"\s+"((?:[^"\\]|\\.)*)"\s*$`)

func unescapeVDF(s string) string {
	return strings.ReplaceAll(s, `\\`, `\`)
}

// VDFValues returns all key/value pairs on single lines, in order.
func VDFValues(text string) [][2]string {
	var out [][2]string
	for _, line := range strings.Split(text, "\n") {
		m := kvLine.FindStringSubmatch(strings.TrimRight(line, "\r"))
		if m != nil {
			out = append(out, [2]string{strings.ToLower(m[1]), unescapeVDF(m[2])})
		}
	}
	return out
}

// SteamLibraryPaths reads every "path" entry of libraryfolders.vdf.
func SteamLibraryPaths(libraryfolders string) []string {
	var out []string
	for _, kv := range VDFValues(libraryfolders) {
		if kv[0] == "path" {
			out = append(out, kv[1])
		}
	}
	return out
}

// SteamManifest returns appid, name and installdir of an appmanifest file.
func SteamManifest(acf string) (appID, name, installDir string) {
	for _, kv := range VDFValues(acf) {
		switch kv[0] {
		case "appid":
			if appID == "" {
				appID = kv[1]
			}
		case "name":
			if name == "" {
				name = kv[1]
			}
		case "installdir":
			if installDir == "" {
				installDir = kv[1]
			}
		}
	}
	return
}

// SteamAccount is the Steam account signed in on this PC. Only the public
// SteamID64 and display name are kept; the login name (AccountName) never is.
type SteamAccount struct {
	SteamID     string `json:"steamId"`
	PersonaName string `json:"personaName,omitempty"`
}

const steamID64Base = 76561197960265728

// SteamIDFromAccountID turns the 32-bit account ID from
// HKCU\Software\Valve\Steam\ActiveProcess\ActiveUser into a SteamID64.
func SteamIDFromAccountID(accountID uint64) string {
	if accountID == 0 || accountID > 0xFFFFFFFF {
		return ""
	}
	return strconv.FormatUint(steamID64Base+accountID, 10)
}

var steamID64 = regexp.MustCompile(`^7656119\d{10}$`)

// PickSteamAccount reads config\loginusers.vdf. With activeID set (Steam is
// running and signed in) it returns that user; otherwise the "MostRecent" one.
func PickSteamAccount(loginusers, activeID string) *SteamAccount {
	type entry struct{ id, persona, mostRecent string }
	var users []entry
	var cur *entry
	depth := 0
	pendingKey := ""
	for _, raw := range strings.Split(loginusers, "\n") {
		line := strings.TrimSpace(strings.TrimRight(raw, "\r"))
		switch {
		case line == "{":
			depth++
			if depth == 2 && steamID64.MatchString(pendingKey) {
				users = append(users, entry{id: pendingKey})
				cur = &users[len(users)-1]
			}
		case line == "}":
			if depth == 2 {
				cur = nil
			}
			depth--
		default:
			if m := kvLine.FindStringSubmatch(line); m != nil {
				if cur != nil && depth == 2 {
					switch strings.ToLower(m[1]) {
					case "personaname":
						cur.persona = unescapeVDF(m[2])
					case "mostrecent":
						cur.mostRecent = m[2]
					}
				}
			} else if strings.HasPrefix(line, `"`) && strings.HasSuffix(line, `"`) && len(line) >= 2 {
				pendingKey = strings.Trim(line, `"`)
			}
		}
	}
	pick := func(e entry) *SteamAccount { return &SteamAccount{SteamID: e.id, PersonaName: e.persona} }
	if activeID != "" {
		for _, u := range users {
			if u.id == activeID {
				return pick(u)
			}
		}
		if steamID64.MatchString(activeID) {
			return &SteamAccount{SteamID: activeID}
		}
	}
	for _, u := range users {
		if u.mostRecent == "1" {
			return pick(u)
		}
	}
	if len(users) == 1 {
		return pick(users[0])
	}
	return nil
}
