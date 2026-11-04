package main

import (
	"path/filepath"
	"sort"
	"strings"
)

// Process is one running process as seen by the OS layer.
type Process struct {
	PID  uint32 `json:"pid"`
	Name string `json:"name"` // e.g. "cs2.exe"
	Path string `json:"path"` // full image path, may be empty if access was denied
}

// InstalledGame is a game a launcher knows about, with its install folder.
type InstalledGame struct {
	Title    string `json:"title"`
	Launcher string `json:"launcher"` // steam, epic, gog, ubisoft, ea, battlenet, other
	AppID    string `json:"appId,omitempty"`
	Dir      string `json:"dir"`
}

// KnownExe maps an executable name to a game title (from the Hermes catalog
// or a curated list). Used when no launcher install folder matches.
type KnownExe struct {
	Exe   string `json:"exe"`
	Title string `json:"title"`
}

// Detection is what the agent reports. It never contains the full process list.
type Detection struct {
	Title    string `json:"title"`
	Launcher string `json:"launcher"`
	AppID    string `json:"appId,omitempty"`
	Exe      string `json:"exe"`
	Source   string `json:"source"` // steam-registry, install-dir, exe-list
}

// Launcher clients, overlays, crash handlers and anti-cheat services live
// inside game or launcher folders but are not "playing".
var ignoredExe = map[string]bool{
	"steam.exe": true, "steamwebhelper.exe": true, "steamservice.exe": true, "gameoverlayui.exe": true,
	"epicgameslauncher.exe": true, "epicwebhelper.exe": true, "epiconlineservicesuserhelper.exe": true,
	"eadesktop.exe": true, "eabackgroundservice.exe": true, "ealocalhostsvc.exe": true, "eaconnect_microsoft.exe": true,
	"ubisoftconnect.exe": true, "upc.exe": true, "uplaywebcore.exe": true, "ubisoftgamelauncher.exe": true, "ubisoftgamelauncher64.exe": true,
	"battle.net.exe": true, "agent.exe": true, "blizzard battle.net helper.exe": true,
	"galaxyclient.exe": true, "galaxyclient helper.exe": true, "galaxycommunication.exe": true, "goggalaxynotifications.exe": true,
	"unitycrashhandler64.exe": true, "unitycrashhandler32.exe": true, "crashreportclient.exe": true, "crashpad_handler.exe": true,
	"easyanticheat.exe": true, "easyanticheat_eos.exe": true, "beservice.exe": true, "beservice_x64.exe": true,
	"vcredist_x64.exe": true, "vcredist_x86.exe": true, "dxsetup.exe": true, "dxwebsetup.exe": true,
}

func normDir(p string) string {
	p = strings.ReplaceAll(p, "/", `\`)
	p = strings.TrimRight(strings.ToLower(p), `\`)
	return p + `\`
}

func baseName(p string) string {
	p = strings.ReplaceAll(p, `\`, "/")
	return strings.ToLower(filepath.Base(p))
}

// Detect combines the three signals. steamRunningAppID is "" or "0" when no Steam game runs.
func Detect(procs []Process, installed []InstalledGame, known []KnownExe, steamRunningAppID string, steamNames map[string]string) []Detection {
	out := map[string]Detection{}
	add := func(d Detection) {
		key := strings.ToLower(d.Launcher + "|" + d.Title)
		if _, ok := out[key]; !ok {
			out[key] = d
		}
	}

	// One entry per install folder. Several games can share a folder
	// (Half-Life, Counter-Strike, CS: Condition Zero) and one game can be
	// listed by two launchers (Titanfall 2 in Steam and EA). Prefer Steam
	// (it has an app ID), then the alphabetically first title, so the
	// result is stable. Launcher and redistributable folders are dropped.
	dirs := uniqueDirs(installed)

	// 1) Steam tells us directly. Its folder is then already covered.
	steamDir := ""
	if steamRunningAppID != "" && steamRunningAppID != "0" {
		title := steamNames[steamRunningAppID]
		if title == "" {
			title = "Steam App " + steamRunningAppID
		}
		add(Detection{Title: title, Launcher: "steam", AppID: steamRunningAppID, Source: "steam-registry"})
		for _, g := range installed {
			if g.Launcher == "steam" && g.AppID == steamRunningAppID && g.Dir != "" {
				steamDir = normDir(g.Dir)
			}
		}
	}

	knownByExe := map[string]string{}
	for _, k := range known {
		knownByExe[strings.ToLower(k.Exe)] = k.Title
	}

	for _, p := range procs {
		exe := strings.ToLower(p.Name)
		if exe == "" {
			exe = baseName(p.Path)
		}
		if isIgnored(exe) {
			continue
		}
		matched := false
		// 2) Process runs from a launcher's install folder.
		if p.Path != "" {
			pp := strings.ToLower(strings.ReplaceAll(p.Path, "/", `\`))
			for _, g := range dirs {
				if strings.HasPrefix(pp, normDir(g.Dir)) {
					matched = true
					if normDir(g.Dir) == steamDir {
						break
					}
					add(Detection{Title: g.Title, Launcher: g.Launcher, AppID: g.AppID, Exe: exe, Source: "install-dir"})
					matched = true
					break
				}
			}
		}
		// 3) Known executable name (catalog / curated list).
		if !matched {
			if t, ok := knownByExe[exe]; ok {
				add(Detection{Title: t, Launcher: "other", Exe: exe, Source: "exe-list"})
			}
		}
	}

	res := make([]Detection, 0, len(out))
	for _, d := range out {
		res = append(res, d)
	}
	sort.Slice(res, func(i, j int) bool { return res[i].Title < res[j].Title })
	return res
}

// Entries that are launchers or shared runtimes, not games.
var notAGame = map[string]bool{
	"battle.net":                         true,
	"steamworks common redistributables": true,
	"steamvr":                            true,
	"ea app":                             true,
	"origin":                             true,
	"ubisoft connect":                    true,
	"epic games launcher":                true,
}

var launcherRank = map[string]int{"steam": 0, "epic": 1, "gog": 2, "ubisoft": 3, "ea": 4, "battlenet": 5}

func uniqueDirs(installed []InstalledGame) []InstalledGame {
	best := map[string]InstalledGame{}
	for _, g := range installed {
		if strings.TrimSpace(g.Dir) == "" || isTooBroadDir(g.Dir) || notAGame[strings.ToLower(strings.TrimSpace(g.Title))] || (g.Launcher == "steam" && g.AppID == "228980") {
			continue
		}
		d := normDir(g.Dir)
		cur, ok := best[d]
		if !ok {
			best[d] = g
			continue
		}
		ri, rc := launcherRank[g.Launcher], launcherRank[cur.Launcher]
		if ri < rc || (ri == rc && g.Title < cur.Title) {
			best[d] = g
		}
	}
	dirs := make([]InstalledGame, 0, len(best))
	for _, g := range best {
		dirs = append(dirs, g)
	}
	// Longest install dir first, so nested folders win.
	sort.Slice(dirs, func(i, j int) bool {
		if len(dirs[i].Dir) != len(dirs[j].Dir) {
			return len(dirs[i].Dir) > len(dirs[j].Dir)
		}
		return dirs[i].Title < dirs[j].Title
	})
	return dirs
}

// Helper processes that sit in game folders but are not the game itself.
// Anti-cheat launchers can start before or outlive the game, so they must
// not count; the real game exe in the same folder still matches.
var ignoredPrefixes = []string{
	"eaanticheat", "easyanticheat", "battleye", "beservice", "beclient",
	"crashreport", "crashhandler", "unitycrashhandler", "crashpad", "bugreport",
	"vc_redist", "vcredist", "dxsetup", "dotnet", "uninst", "unins0",
}

func isIgnored(exe string) bool {
	if ignoredExe[exe] {
		return true
	}
	for _, p := range ignoredPrefixes {
		if strings.HasPrefix(exe, p) {
			return true
		}
	}
	return false
}

// Shared roots that some uninstall entries (EA, Battle.net) report as their
// InstallLocation. Matching against them would turn every program in there
// into "playing".
var genericDirNames = map[string]bool{
	"program files": true, "program files (x86)": true, "programdata": true, "windows": true, "users": true,
	"electronic arts": true, "ea games": true, "origin games": true, "ea app": true, "ea desktop": true,
	"battle.net": true, "blizzard entertainment": true, "games": true, "spiele": true,
	"steam": true, "steamlibrary": true, "steamapps": true, "common": true,
	"epic games": true, "epiclibrary": true, "ubisoft": true, "ubisoft game launcher": true, "gog galaxy": true,
}

func isTooBroadDir(dir string) bool {
	parts := strings.Split(strings.Trim(strings.ToLower(strings.ReplaceAll(dir, "/", `\`)), `\`), `\`)
	if len(parts) > 0 && strings.HasSuffix(parts[0], ":") {
		parts = parts[1:]
	}
	if len(parts) == 0 || parts[0] == "" {
		return true
	}
	return genericDirNames[parts[len(parts)-1]]
}
