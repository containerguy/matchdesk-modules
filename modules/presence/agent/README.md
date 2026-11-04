# matchdesk-game-agent (Prototyp)

Kleines Windows-Programm, das erkennt, welches Spiel auf dem PC gerade läuft. Meldet an Matchdesk (`POST /api/m/presence/game`), wenn dort das Modul „Spielt gerade“ eingeschaltet ist. Getestet am 3.11.2026 auf einem Windows-PC mit Steam, Epic, Ubisoft, EA und Battle.net.

## Wie erkannt wird

1. **Steam:** `HKCU\Software\Valve\Steam\RunningAppID` (App-ID des laufenden Spiels, 0 = keins). Spielname aus `appmanifest_*.acf`.
2. **Installationsordner der Launcher:** Läuft ein Prozess aus dem Ordner eines installierten Spiels, gilt das Spiel als gestartet.
   - Steam: `libraryfolders.vdf` + `appmanifest_*.acf`
   - Epic: `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item` (JSON)
   - GOG: `HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<id>`
   - Ubisoft Connect: `HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\<id>`
   - EA app, Battle.net: Uninstall-Einträge in der Registry nach Publisher
3. **Bekannte Exe-Namen** (`-known liste.json`), z. B. für portable Spiele oder den Spielekatalog.

Launcher, Overlays, Crash-Handler und Anti-Cheat-Dienste werden ignoriert. Prozesse werden nur mit `PROCESS_QUERY_LIMITED_INFORMATION` geöffnet (kein Speicherzugriff, keine Injection), das verträgt sich mit Anti-Cheat.

## Datenschutz

An Matchdesk gehen nur Titel, Launcher und ggf. Steam-App-ID der erkannten Spiele, dazu das angemeldete Steam-Konto (SteamID64 aus `HKCU\Software\Valve\Steam\ActiveProcess\ActiveUser`, Anzeigename aus `config\loginusers.vdf`; nie der Login-Name). Matchdesk trägt es in die Spielkonten ein. `-no-account` schaltet das ab. Konfigurationsdateien von Battle.net & Co. werden nicht gelesen. Nie die Prozessliste, nie der Rechnername, nie die Liste installierter Spiele. `-v` zeigt die gefundenen installierten Spiele nur lokal an. Beim Beenden mit Strg+C löscht der Agent seinen Eintrag sofort, sonst verschwindet er nach zwei Minuten.

## Auslieferung

Die Release-Pipeline von matchdesk-modules baut den Agenten beim Veröffentlichen des Moduls „presence“ mit und legt ihn ins Modulpaket (`assets/`). Matchdesk liefert ihn unter `GET /api/m/presence/agent/download` aus. Symbol, Versionsangaben und Manifest kommen aus `rsrc_windows_amd64.syso`, erzeugt mit [go-winres](https://github.com/tc-hib/go-winres) aus `winres/`:

```sh
go-winres make --in winres/winres.json --arch amd64
```

Ohne Argumente gestartet (Doppelklick) macht der Agent einen Testlauf, meldet nichts und wartet auf Enter.

## Bauen und starten

```sh
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o matchdesk-game-agent.exe .
go test ./...        # Erkennungslogik, läuft auf jedem OS
```

```
matchdesk-game-agent.exe -v                     # einmal erkennen, JSON ausgeben
matchdesk-game-agent.exe -interval 30s          # alle 30 s
set MATCHDESK_AGENT_KEY=md_ga_…        (Schlüssel von der Seite „Spielt gerade“)
matchdesk-game-agent.exe -server https://matchdesk.example -interval 30s
```
