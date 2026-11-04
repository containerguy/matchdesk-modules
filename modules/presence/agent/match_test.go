package main

import "testing"

func TestDetectInstallDirAndIgnoresLaunchers(t *testing.T) {
	procs := []Process{
		{Name: "steam.exe", Path: `C:\Program Files (x86)\Steam\steam.exe`},
		{Name: "cs2.exe", Path: `D:\SteamLibrary\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe`},
		{Name: "FortniteClient-Win64-Shipping.exe", Path: `C:\Program Files\Epic Games\Fortnite\FortniteGame\Binaries\Win64\FortniteClient-Win64-Shipping.exe`},
		{Name: "EpicGamesLauncher.exe", Path: `C:\Program Files (x86)\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe`},
		{Name: "UnityCrashHandler64.exe", Path: `C:\Games\Valheim\UnityCrashHandler64.exe`},
		{Name: "chrome.exe", Path: `C:\Program Files\Google\Chrome\Application\chrome.exe`},
	}
	installed := []InstalledGame{
		{Title: "Counter-Strike 2", Launcher: "steam", AppID: "730", Dir: `D:/SteamLibrary/steamapps/common/Counter-Strike Global Offensive`},
		{Title: "Fortnite", Launcher: "epic", Dir: `C:\Program Files\Epic Games\Fortnite\`},
		{Title: "Valheim", Launcher: "steam", Dir: `C:\Games\Valheim`},
	}
	got := Detect(procs, installed, nil, "0", nil)
	if len(got) != 2 || got[0].Title != "Counter-Strike 2" || got[1].Title != "Fortnite" {
		t.Fatalf("unexpected: %+v", got)
	}
	if got[1].Launcher != "epic" || got[1].Source != "install-dir" {
		t.Fatalf("unexpected fortnite detection: %+v", got[1])
	}
}

func TestDetectSteamRegistryDeduplicates(t *testing.T) {
	procs := []Process{{Name: "cs2.exe", Path: `D:\S\steamapps\common\CS\cs2.exe`}}
	installed := []InstalledGame{{Title: "Counter-Strike 2", Launcher: "steam", AppID: "730", Dir: `D:\S\steamapps\common\CS`}}
	got := Detect(procs, installed, nil, "730", map[string]string{"730": "Counter-Strike 2"})
	if len(got) != 1 || got[0].Source != "steam-registry" {
		t.Fatalf("unexpected: %+v", got)
	}
}

func TestDetectKnownExeFallbackAndPrefixSafety(t *testing.T) {
	procs := []Process{
		{Name: "factorio.exe", Path: `C:\Portable\Factorio\bin\x64\factorio.exe`},
		{Name: "tool.exe", Path: `C:\Games\Valheim2\tool.exe`}, // must not match C:\Games\Valheim
	}
	installed := []InstalledGame{{Title: "Valheim", Launcher: "steam", Dir: `C:\Games\Valheim`}}
	known := []KnownExe{{Exe: "Factorio.exe", Title: "Factorio"}}
	got := Detect(procs, installed, known, "", nil)
	if len(got) != 1 || got[0].Title != "Factorio" || got[0].Source != "exe-list" {
		t.Fatalf("unexpected: %+v", got)
	}
}

func TestSteamVDF(t *testing.T) {
	lib := `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"apps" { "228980" "0" }
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
	}
}`
	paths := SteamLibraryPaths(lib)
	if len(paths) != 2 || paths[0] != `C:\Program Files (x86)\Steam` || paths[1] != `D:\SteamLibrary` {
		t.Fatalf("paths: %q", paths)
	}
	acf := `"AppState"
{
	"appid"		"730"
	"name"		"Counter-Strike 2"
	"installdir"		"Counter-Strike Global Offensive"
	"UserConfig" { "name" "ignored" }
}`
	id, name, dir := SteamManifest(acf)
	if id != "730" || name != "Counter-Strike 2" || dir != "Counter-Strike Global Offensive" {
		t.Fatalf("manifest: %s %s %s", id, name, dir)
	}
}

// Cases seen on a real PC (DESKTOP-M4PJL0I, 2026-11-03).
func TestDetectSharedAndCrossLauncherFolders(t *testing.T) {
	installed := []InstalledGame{
		{Title: "Half-Life", Launcher: "steam", AppID: "70", Dir: `D:\SteamLibrary\steamapps\common\Half-Life`},
		{Title: "Counter-Strike", Launcher: "steam", AppID: "10", Dir: `D:\SteamLibrary\steamapps\common\Half-Life`},
		{Title: "Counter-Strike: Condition Zero", Launcher: "steam", AppID: "80", Dir: `D:\SteamLibrary\steamapps\common\Half-Life`},
		{Title: "Titanfall® 2", Launcher: "steam", AppID: "1237970", Dir: `E:\SteamLibrary\steamapps\common\Titanfall2`},
		{Title: "Titanfall™ 2", Launcher: "ea", Dir: `E:\SteamLibrary\steamapps\common\Titanfall2`},
		{Title: "Battle.net", Launcher: "battlenet", Dir: `C:\Program Files (x86)\Battle.net`},
		{Title: "Steamworks Common Redistributables", Launcher: "steam", AppID: "228980", Dir: `C:\Steam\steamapps\common\Steamworks Shared`},
	}
	procs := []Process{
		{Name: "hl.exe", Path: `D:\SteamLibrary\steamapps\common\Half-Life\hl.exe`},
		{Name: "Titanfall2.exe", Path: `E:\SteamLibrary\steamapps\common\Titanfall2\Titanfall2.exe`},
		{Name: "Battle.net Update Helper.exe", Path: `C:\Program Files (x86)\Battle.net\Battle.net Update Helper.exe`},
		{Name: "DXSETUP.exe", Path: `C:\Steam\steamapps\common\Steamworks Shared\_CommonRedist\DXSETUP.exe`},
	}

	// Without Steam registry: one detection per folder, Steam preferred.
	got := Detect(procs, installed, nil, "0", nil)
	if len(got) != 2 || got[0].Title != "Counter-Strike" || got[1].Title != "Titanfall® 2" || got[1].Launcher != "steam" {
		t.Fatalf("unexpected: %+v", got)
	}

	// With Steam registry the running app ID decides which game in the shared folder it is.
	got = Detect(procs[:1], installed, nil, "80", map[string]string{"80": "Counter-Strike: Condition Zero"})
	if len(got) != 1 || got[0].Title != "Counter-Strike: Condition Zero" || got[0].Source != "steam-registry" {
		t.Fatalf("unexpected: %+v", got)
	}
}

// Seen on DESKTOP-M4PJL0I: Battlefield 2042 matched via its anti-cheat launcher.
func TestDetectIgnoresAntiCheatHelpers(t *testing.T) {
	installed := []InstalledGame{{Title: "Battlefield™ 2042", Launcher: "ea", Dir: `C:\Program Files\EA Games\Battlefield 2042\`}}
	helper := Process{Name: "EAAntiCheat.GameServiceLauncher.exe", Path: `C:\Program Files\EA Games\Battlefield 2042\EAAntiCheat.GameServiceLauncher.exe`}
	game := Process{Name: "BF2042.exe", Path: `C:\Program Files\EA Games\Battlefield 2042\BF2042.exe`}

	if got := Detect([]Process{helper}, installed, nil, "", nil); len(got) != 0 {
		t.Fatalf("helper alone must not count: %+v", got)
	}
	got := Detect([]Process{helper, game}, installed, nil, "", nil)
	if len(got) != 1 || got[0].Exe != "bf2042.exe" {
		t.Fatalf("unexpected: %+v", got)
	}
}

func TestDetectIgnoresBroadInstallFolders(t *testing.T) {
	installed := []InstalledGame{
		{Title: "Some EA Game", Launcher: "ea", Dir: `C:\Program Files\EA Games\`},
		{Title: "Root", Launcher: "ea", Dir: `D:\`},
		{Title: "Battlefield™ 6", Launcher: "ea", Dir: `E:\Battlefield 6\`},
	}
	procs := []Process{
		{Name: "notepad++.exe", Path: `C:\Program Files\EA Games\Tools\notepad++.exe`},
		{Name: "anything.exe", Path: `D:\Tools\anything.exe`},
		{Name: "bf6.exe", Path: `E:\Battlefield 6\bf6.exe`},
	}
	got := Detect(procs, installed, nil, "", nil)
	if len(got) != 1 || got[0].Title != "Battlefield™ 6" {
		t.Fatalf("unexpected: %+v", got)
	}
	for _, d := range []string{`C:\Program Files (x86)\`, `D:/SteamLibrary/steamapps/common`, `C:`} {
		if !isTooBroadDir(d) {
			t.Errorf("%s should be too broad", d)
		}
	}
	for _, d := range []string{`D:/UplayLibrary/Anno 1800/`, `D:\Battle.net\Diablo III`} {
		if isTooBroadDir(d) {
			t.Errorf("%s should be fine", d)
		}
	}
}

func TestSteamAccountFromLoginUsers(t *testing.T) {
	vdf := `"users"
{
	"76561198000000001"
	{
		"AccountName"		"rene_login"
		"PersonaName"		"René"
		"RememberPassword"		"1"
		"MostRecent"		"0"
	}
	"76561198000000002"
	{
		"AccountName"		"zweit"
		"PersonaName"		"Zweitkonto"
		"MostRecent"		"1"
	}
}`
	if id := SteamIDFromAccountID(39734273); id != "76561198000000001" {
		t.Fatalf("id: %s", id)
	}
	if SteamIDFromAccountID(0) != "" {
		t.Fatal("0 means not signed in")
	}
	got := PickSteamAccount(vdf, "76561198000000001")
	if got == nil || got.SteamID != "76561198000000001" || got.PersonaName != "René" {
		t.Fatalf("active: %+v", got)
	}
	got = PickSteamAccount(vdf, "")
	if got == nil || got.SteamID != "76561198000000002" || got.PersonaName != "Zweitkonto" {
		t.Fatalf("most recent: %+v", got)
	}
	got = PickSteamAccount("", "76561198000000009")
	if got == nil || got.SteamID != "76561198000000009" || got.PersonaName != "" {
		t.Fatalf("active without file: %+v", got)
	}
	if PickSteamAccount("", "") != nil {
		t.Fatal("nothing known")
	}
}
