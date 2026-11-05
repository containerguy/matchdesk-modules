# Mitspielzentrale Agent („Spielt gerade“)

Windows-Programm, das erkennt, welches Spiel auf dem PC gerade läuft, und es an Matchdesk meldet (`POST /api/m/presence/game`), wenn dort das Modul „Spielt gerade“ eingeschaltet ist. Es läuft wie Steam oder Discord unauffällig im Infobereich neben der Uhr: kein Konsolenfenster, keine Startdatei.

## So sieht es für Spieler aus

1. Auf der Seite „Spielt gerade“ unter „Selbst mitmachen“ den Installer herunterladen und starten. Er installiert pro Benutzer nach `%LocalAppData%\Programs\Mitspielzentrale Agent`, ohne Adminrechte, mit Startmenü-Eintrag, Eintrag unter „Apps“ zum Deinstallieren und (abwählbar) „Mit Windows starten“.
2. Auf „Agent verbinden“ klicken. Der Browser öffnet `matchdesk-agent://pair?server=…&code=…`, Windows fragt „Öffnen?“, der Agent fragt nach, ob er sich mit diesem Server verbinden soll, und zeigt den Code, den auch die Seite zeigt.
3. Fertig. Das Symbol im Infobereich zeigt den Zustand (farbig = verbunden, grau = pausiert, grau mit Punkt = nicht verbunden); das Menü zeigt das erkannte Spiel und bietet Pausieren, Mit Windows starten, Verbindung trennen, Beenden und, falls Matchdesk eine neuere Version mitbringt, „Update auf x.y.z installieren“.

## Verbinden und Schlüssel

- Die Seite holt einen Einmalcode (`POST /agent/pair-code`, 8 Zeichen, 5 Minuten gültig, nur der neueste gilt). Der Agent tauscht ihn ohne Anmeldung gegen seinen Agent-Schlüssel `md_ga_…` (`POST /agent/pair`). Falsche Codes werden nach 20 pro Minute mit 429 abgewiesen.
- Der Schlüssel erscheint nie im Browser, nicht in der Befehlszeile und nicht in einer Datei im Klartext: Er liegt mit Windows-DPAPI für den angemeldeten Benutzer verschlüsselt in `%LocalAppData%\Mitspielzentrale\Agent\agent.json`.
- Der Schlüssel taugt nur für `/game`, `/agent/version` und `/agent/download`. Neu verbinden oder „Agent trennen“ auf der Seite macht den alten Schlüssel ungültig; der Agent zeigt dann „bitte neu verbinden“.
- Weil ein Link von jeder Webseite kommen kann, verbindet sich der Agent nie ohne Rückfrage mit Server und Code.

## Wie erkannt wird

1. **Steam:** `HKCU\Software\Valve\Steam\RunningAppID` (App-ID des laufenden Spiels, 0 = keins). Spielname aus `appmanifest_*.acf`.
2. **Installationsordner der Launcher:** Läuft ein Prozess aus dem Ordner eines installierten Spiels, gilt das Spiel als gestartet.
   - Steam: `libraryfolders.vdf` + `appmanifest_*.acf`
   - Epic: `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item` (JSON)
   - GOG: `HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<id>`
   - Ubisoft Connect: `HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\<id>`
   - EA app, Battle.net: Uninstall-Einträge in der Registry nach Publisher
3. **Bekannte Exe-Namen:** optional `known.json` neben `agent.json`, z. B. `[{"exe":"factorio.exe","title":"Factorio"}]`.

Launcher, Overlays, Crash-Handler und Anti-Cheat-Dienste werden ignoriert. Prozesse werden nur mit `PROCESS_QUERY_LIMITED_INFORMATION` geöffnet (kein Speicherzugriff, keine Injection), das verträgt sich mit Anti-Cheat.

## Datenschutz

An Matchdesk gehen nur Titel, Launcher und ggf. Steam-App-ID der erkannten Spiele, dazu das angemeldete Steam-Konto (SteamID64 aus `HKCU\Software\Valve\Steam\ActiveProcess\ActiveUser`, Anzeigename aus `config\loginusers.vdf`; nie der Login-Name). Matchdesk trägt es in die Spielkonten ein; `"noSteamAccount": true` in `agent.json` schaltet das ab. Konfigurationsdateien von Battle.net & Co. werden nicht gelesen. Nie die Prozessliste, nie der Rechnername, nie die Liste installierter Spiele. Pausieren, Trennen oder Beenden löscht den Eintrag sofort, sonst verschwindet er zwei Minuten nach der letzten Meldung. Protokoll: `agent.log` neben `agent.json` (ohne Schlüssel).

## Bauen

Die Release-Pipeline (`.github/workflows/agent-windows.yml`, Windows-Runner) baut bei jedem Release des Moduls Exe und Installer und legt `matchdesk-agent-setup.exe` ins Modulpaket (`assets/`); Matchdesk liefert ihn unter `GET /api/m/presence/agent/download` aus. Jeder PR baut dasselbe unsigniert als Artefakt „agent-assets“.

```sh
go test ./...                                   # Erkennung, Kopplung, Ablauf; läuft auf jedem OS
go install github.com/tc-hib/go-winres@v0.3.3
go-winres make --in winres/winres.json --arch amd64 --product-version 1.1.0.0 --file-version 1.1.0.0
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -H windowsgui -X main.version=1.1.0" -o dist/matchdesk-agent.exe .
iscc /DAppVersion=1.1.0 installer\agent.iss    # Windows, Inno Setup 6 -> dist/matchdesk-agent-setup.exe
```

`-H windowsgui` sorgt dafür, dass nie ein Konsolenfenster aufgeht. Zum Ausprobieren ohne Verbindung: `matchdesk-agent.exe -once -v > erkannt.json` erkennt einmal und schreibt JSON, ohne etwas zu melden.

Symbole: `winres/icon*.png` (Programm, alle Windows-Größen), `icons/app.ico` (Installer), `icons/tray-*.ico` (Infobereich: aktiv, pausiert, nicht verbunden).

## Signierung

Geplant über die [SignPath Foundation](https://signpath.org) (kostenlos für Open Source). Sobald das Projekt dort angenommen ist, im Repo die Variable `SIGNPATH_ORGANIZATION_ID` und das Secret `SIGNPATH_API_TOKEN` setzen (optional `SIGNPATH_PROJECT_SLUG`, Standard `matchdesk-modules`, und `SIGNPATH_POLICY_SLUG`, Standard `release-signing`; Artefakt-Konfigurationen `agent-exe` und `agent-setup`). Dann signiert die Release-Pipeline Exe und Installer automatisch. Bis dahin warnt SmartScreen beim Installieren.

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).
