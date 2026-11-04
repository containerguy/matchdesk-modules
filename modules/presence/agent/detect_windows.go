//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// Processes lists running processes with their full image path. Uses only
// PROCESS_QUERY_LIMITED_INFORMATION: no memory access, no injection, so it
// does not conflict with anti-cheat systems.
func Processes() ([]Process, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snap)

	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	if err := windows.Process32First(snap, &e); err != nil {
		return nil, err
	}
	var out []Process
	for {
		p := Process{PID: e.ProcessID, Name: windows.UTF16ToString(e.ExeFile[:])}
		if h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, e.ProcessID); err == nil {
			buf := make([]uint16, windows.MAX_LONG_PATH)
			n := uint32(len(buf))
			if windows.QueryFullProcessImageName(h, 0, &buf[0], &n) == nil {
				p.Path = windows.UTF16ToString(buf[:n])
			}
			windows.CloseHandle(h)
		}
		out = append(out, p)
		if err := windows.Process32Next(snap, &e); err != nil {
			break
		}
	}
	return out, nil
}

func regString(root registry.Key, path, name string) string {
	k, err := registry.OpenKey(root, path, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return ""
	}
	defer k.Close()
	s, _, err := k.GetStringValue(name)
	if err != nil {
		return ""
	}
	return s
}

// SteamRunningAppID reads HKCU\Software\Valve\Steam\RunningAppID, which the
// Steam client sets to the app ID of the running game (0 = none).
func SteamRunningAppID() string {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Valve\Steam`, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("RunningAppID")
	if err != nil {
		return ""
	}
	return fmt.Sprint(v)
}

// CurrentSteamAccount returns the Steam account signed in on this PC, or nil.
// Sources: ActiveProcess\ActiveUser (32-bit account ID while Steam runs) and
// config\loginusers.vdf for the display name. Login names are not read out.
func CurrentSteamAccount() *SteamAccount {
	activeID := ""
	if k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Valve\Steam\ActiveProcess`, registry.QUERY_VALUE); err == nil {
		if v, _, err := k.GetIntegerValue("ActiveUser"); err == nil {
			activeID = SteamIDFromAccountID(v)
		}
		k.Close()
	}
	root := regString(registry.CURRENT_USER, `Software\Valve\Steam`, "SteamPath")
	if root == "" {
		return nil
	}
	b, _ := os.ReadFile(filepath.Join(root, "config", "loginusers.vdf"))
	return PickSteamAccount(string(b), activeID)
}

// InstalledGames collects install folders from all launchers it finds.
func InstalledGames() ([]InstalledGame, []string) {
	var games []InstalledGame
	var launchers []string
	for _, src := range []struct {
		name string
		fn   func() []InstalledGame
	}{
		{"steam", steamGames}, {"epic", epicGames}, {"gog", gogGames},
		{"ubisoft", ubisoftGames}, {"ea", eaGames}, {"battlenet", battlenetGames},
	} {
		g := src.fn()
		if g != nil {
			launchers = append(launchers, src.name)
			games = append(games, g...)
		}
	}
	return games, launchers
}

func steamGames() []InstalledGame {
	root := regString(registry.CURRENT_USER, `Software\Valve\Steam`, "SteamPath")
	if root == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(root, "steamapps", "libraryfolders.vdf"))
	if err != nil {
		return []InstalledGame{}
	}
	out := []InstalledGame{}
	for _, lib := range SteamLibraryPaths(string(b)) {
		files, _ := filepath.Glob(filepath.Join(lib, "steamapps", "appmanifest_*.acf"))
		for _, f := range files {
			acf, err := os.ReadFile(f)
			if err != nil {
				continue
			}
			id, name, dir := SteamManifest(string(acf))
			if dir != "" {
				out = append(out, InstalledGame{Title: name, Launcher: "steam", AppID: id, Dir: filepath.Join(lib, "steamapps", "common", dir)})
			}
		}
	}
	return out
}

// Epic: JSON manifests in %ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item
func epicGames() []InstalledGame {
	dir := filepath.Join(os.Getenv("ProgramData"), `Epic\EpicGamesLauncher\Data\Manifests`)
	files, err := filepath.Glob(filepath.Join(dir, "*.item"))
	if err != nil || files == nil {
		if _, err := os.Stat(dir); err != nil {
			return nil
		}
		return []InstalledGame{}
	}
	out := []InstalledGame{}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var m struct{ DisplayName, InstallLocation, AppName string }
		if json.Unmarshal(b, &m) == nil && m.InstallLocation != "" {
			out = append(out, InstalledGame{Title: m.DisplayName, Launcher: "epic", AppID: m.AppName, Dir: m.InstallLocation})
		}
	}
	return out
}

func subkeys(root registry.Key, path string) (registry.Key, []string, bool) {
	k, err := registry.OpenKey(root, path, registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE)
	if err != nil {
		return 0, nil, false
	}
	names, _ := k.ReadSubKeyNames(-1)
	return k, names, true
}

// GOG: HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<id> {gameName, path}
func gogGames() []InstalledGame {
	k, ids, ok := subkeys(registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\GOG.com\Games`)
	if !ok {
		return nil
	}
	defer k.Close()
	out := []InstalledGame{}
	for _, id := range ids {
		p := `SOFTWARE\WOW6432Node\GOG.com\Games\` + id
		out = append(out, InstalledGame{Title: regString(registry.LOCAL_MACHINE, p, "gameName"), Launcher: "gog", AppID: id, Dir: regString(registry.LOCAL_MACHINE, p, "path")})
	}
	return out
}

// Ubisoft Connect: HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\<id> {InstallDir}
func ubisoftGames() []InstalledGame {
	k, ids, ok := subkeys(registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs`)
	if !ok {
		return nil
	}
	defer k.Close()
	out := []InstalledGame{}
	for _, id := range ids {
		dir := regString(registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\`+id, "InstallDir")
		out = append(out, InstalledGame{Title: filepath.Base(strings.TrimRight(dir, `\/`)), Launcher: "ubisoft", AppID: id, Dir: dir})
	}
	return out
}

// EA app and Battle.net have no simple per-game list we can read without
// parsing private formats. Use the Windows uninstall entries instead.
func uninstallByPublisher(launcher string, publishers ...string) []InstalledGame {
	var out []InstalledGame
	found := false
	for _, base := range []string{`SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`, `SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`} {
		k, names, ok := subkeys(registry.LOCAL_MACHINE, base)
		if !ok {
			continue
		}
		for _, n := range names {
			p := base + `\` + n
			pub := strings.ToLower(regString(registry.LOCAL_MACHINE, p, "Publisher"))
			for _, want := range publishers {
				if strings.Contains(pub, want) {
					found = true
					dir := regString(registry.LOCAL_MACHINE, p, "InstallLocation")
					if dir != "" {
						out = append(out, InstalledGame{Title: regString(registry.LOCAL_MACHINE, p, "DisplayName"), Launcher: launcher, Dir: dir})
					}
					break
				}
			}
		}
		k.Close()
	}
	if !found {
		return nil
	}
	return out
}

func eaGames() []InstalledGame { return uninstallByPublisher("ea", "electronic arts") }
func battlenetGames() []InstalledGame {
	return uninstallByPublisher("battlenet", "blizzard entertainment")
}
