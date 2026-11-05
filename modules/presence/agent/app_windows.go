//go:build windows

package main

import (
	_ "embed"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"fyne.io/systray"
)

var (
	//go:embed icons/tray-active.ico
	iconActive []byte
	//go:embed icons/tray-paused.ico
	iconPaused []byte
	//go:embed icons/tray-off.ico
	iconOff []byte
)

// runApp: started by autostart, from the Start menu or by a matchdesk-agent:// link.
// Only one instance runs; a second one connects (if it got a link), tells the running
// one to reload and exits.
func runApp(dir, pairLink string, background bool) {
	first := acquireInstance()
	if pairLink != "" && !handlePairLink(dir, pairLink) {
		if !first {
			return
		}
		pairLink = "" // cancelled or failed: keep running with the old connection
	}
	if !first {
		if pairLink != "" {
			signalRunningInstance()
		} else if !background {
			inform("Der Agent läuft bereits. Du findest ihn im Infobereich unten rechts neben der Uhr.")
		}
		return
	}
	if err := registerProtocol(); err != nil {
		log.Printf("protocol: %v", err)
	}
	t := &tray{dir: dir, background: background, justPaired: pairLink != ""}
	systray.Run(t.ready, t.exit)
}

// handlePairLink asks before connecting: a link can come from any web page, so the user
// confirms the server and the code the website showed.
func handlePairLink(dir, link string) bool {
	req, err := ParsePairURL(link)
	if err != nil {
		fail("Dieser Link ist kein gültiger Verbindungslink der Mitspielzentrale.")
		return false
	}
	note := ""
	if strings.HasPrefix(req.Server, "http://") {
		note = "\n\nHinweis: Die Verbindung ist nicht verschlüsselt (http). Das ist im LAN üblich, im Internet aber nicht."
	}
	if !confirm(fmt.Sprintf("Mit der Mitspielzentrale auf %s verbinden?\n\nCode: %s\n\nNur bestätigen, wenn du gerade selbst auf „Agent verbinden“ geklickt hast und die Seite denselben Code zeigt.%s",
		req.Host(), req.FormattedCode(), note)) {
		return false
	}
	if err := connect(dir, req); err != nil {
		log.Printf("pair: %v", err)
		fail("Verbinden hat nicht geklappt.\n\n" + err.Error())
		return false
	}
	return true
}

type tray struct {
	dir        string
	background bool
	justPaired bool
	agent      *Agent

	mu                                         sync.Mutex
	status, playing, open, pause, autostart    *systray.MenuItem
	update, reconnect, disconnect, quit, title *systray.MenuItem
	lastIcon                                   string
	updating                                   bool
}

func (t *tray) ready() {
	systray.SetIcon(iconOff)
	t.lastIcon = "off"
	systray.SetTooltip(appName)

	t.title = systray.AddMenuItem(appName+" "+version, "")
	t.title.Disable()
	t.status = systray.AddMenuItem("Nicht verbunden", "")
	t.status.Disable()
	t.playing = systray.AddMenuItem("", "")
	t.playing.Disable()
	t.playing.Hide()
	systray.AddSeparator()
	t.update = systray.AddMenuItem("", "Lädt den neuen Installer aus der Mitspielzentrale und installiert ihn")
	t.update.Hide()
	t.open = systray.AddMenuItem("Mitspielzentrale öffnen", "")
	t.reconnect = systray.AddMenuItem("So verbindest du den Agenten …", "")
	t.pause = systray.AddMenuItemCheckbox("Pausieren", "Meldet nichts, bis du wieder fortsetzt", false)
	t.autostart = systray.AddMenuItemCheckbox("Mit Windows starten", "", autostartEnabled())
	systray.AddSeparator()
	t.disconnect = systray.AddMenuItem("Verbindung trennen", "Vergisst Server und Schlüssel auf diesem PC")
	t.quit = systray.AddMenuItem("Beenden", "")

	t.agent = NewAgent(t.dir, t.render)
	onReload(func() {
		t.agent.Reload()
		t.connectedNotice()
	})
	go t.agent.Run()
	go t.loop()

	if t.justPaired {
		t.connectedNotice()
	} else if !t.background && !t.agent.Config().Connected() {
		go inform("Der Agent läuft jetzt im Infobereich unten rechts neben der Uhr.\n\nZum Verbinden in der Mitspielzentrale die Seite „Spielt gerade“ öffnen und auf „Agent verbinden“ klicken.")
	}
}

func (t *tray) connectedNotice() {
	cfg, err := LoadConfig(t.dir)
	if err != nil || !cfg.Connected() {
		return
	}
	go inform(fmt.Sprintf("Verbunden mit %s als %s.\n\nDer Agent läuft im Infobereich neben der Uhr und meldet, was du gerade spielst. Über sein Symbol kannst du ihn pausieren oder trennen.",
		PairRequest{Server: cfg.Server}.Host(), cfg.User))
}

func (t *tray) exit() {
	if t.agent != nil {
		t.agent.Stop()
	}
}

func (t *tray) loop() {
	for {
		select {
		case <-t.open.ClickedCh:
			if s := t.agent.Status(); s.Server != "" {
				openURL(s.Server + "/")
			}
		case <-t.reconnect.ClickedCh:
			s := t.agent.Status()
			if s.Server != "" {
				openURL(s.Server + "/")
			}
			go inform("Zum (Neu-)Verbinden in der Mitspielzentrale die Seite „Spielt gerade“ öffnen, „Selbst mitmachen“ aufklappen und auf „Agent verbinden“ klicken.")
		case <-t.pause.ClickedCh:
			t.agent.SetPaused(!t.agent.Status().Paused)
		case <-t.autostart.ClickedCh:
			on := !autostartEnabled()
			if err := setAutostart(on); err != nil {
				log.Printf("autostart: %v", err)
			}
			if autostartEnabled() {
				t.autostart.Check()
			} else {
				t.autostart.Uncheck()
			}
		case <-t.update.ClickedCh:
			go t.installUpdate()
		case <-t.disconnect.ClickedCh:
			if confirm("Verbindung zur Mitspielzentrale auf diesem PC trennen?\n\nDein Eintrag bei „Spielt gerade“ verschwindet sofort. Zum erneuten Verbinden auf der Seite auf „Agent verbinden“ klicken.") {
				t.agent.Disconnect()
			}
		case <-t.quit.ClickedCh:
			systray.Quit()
			return
		}
	}
}

// render updates icon, tooltip and menu from the agent status (called from any goroutine).
func (t *tray) render(s Status) {
	t.mu.Lock()
	defer t.mu.Unlock()
	host := PairRequest{Server: s.Server}.Host()

	icon, iconName, tip := iconOff, "off", appName+": nicht verbunden"
	switch {
	case !s.Connected:
		t.status.SetTitle("Nicht verbunden")
	case s.Rejected:
		t.status.SetTitle("Verbindung abgelehnt, bitte neu verbinden")
		tip = appName + ": bitte neu verbinden"
	case s.Paused:
		icon, iconName, tip = iconPaused, "paused", appName+": pausiert"
		t.status.SetTitle(fmt.Sprintf("Pausiert · %s", host))
	case s.LastError != "":
		t.status.SetTitle(fmt.Sprintf("%s nicht erreichbar", host))
		tip = appName + ": Server nicht erreichbar"
	default:
		icon, iconName, tip = iconActive, "active", fmt.Sprintf("%s: verbunden mit %s", appName, host)
		t.status.SetTitle(fmt.Sprintf("Verbunden als %s · %s", s.User, host))
	}

	if s.Connected && !s.Paused && !s.Rejected && s.LastError == "" {
		label := "Kein Spiel erkannt"
		if len(s.Playing) > 0 {
			label = "Spielt: " + strings.Join(s.Playing, ", ")
			tip += "\n" + label
		}
		t.playing.SetTitle(label)
		t.playing.Show()
	} else {
		t.playing.Hide()
	}

	if s.Connected {
		t.open.Show()
		t.disconnect.Show()
		t.pause.Show()
		t.reconnect.SetTitle("Neu verbinden …")
	} else {
		t.open.Hide()
		t.disconnect.Hide()
		t.pause.Hide()
		t.reconnect.SetTitle("So verbindest du den Agenten …")
	}
	if s.Rejected || !s.Connected {
		t.reconnect.Show()
	} else {
		t.reconnect.Hide()
	}
	if s.Paused {
		t.pause.Check()
	} else {
		t.pause.Uncheck()
	}

	if s.UpdateVersion != "" && !t.updating {
		t.update.SetTitle(fmt.Sprintf("Update auf %s installieren", s.UpdateVersion))
		t.update.Show()
		tip += "\nUpdate verfügbar: " + s.UpdateVersion
	} else if !t.updating {
		t.update.Hide()
	}

	if len(tip) > 120 { // Windows cuts tooltips at 128 characters
		tip = tip[:117] + "…"
	}
	systray.SetTooltip(tip)
	if iconName != t.lastIcon {
		systray.SetIcon(icon)
		t.lastIcon = iconName
	}
}

// installUpdate downloads the installer from Matchdesk and runs it silently; the installer
// closes this agent and starts the new one.
func (t *tray) installUpdate() {
	t.mu.Lock()
	if t.updating {
		t.mu.Unlock()
		return
	}
	t.updating = true
	t.update.SetTitle("Update wird geladen …")
	t.update.Disable()
	t.mu.Unlock()

	done := func(err error) {
		t.mu.Lock()
		t.updating = false
		t.update.Enable()
		t.mu.Unlock()
		log.Printf("update: %v", err)
		fail("Das Update hat nicht geklappt.\n\n" + err.Error())
		t.render(t.agent.Status())
	}
	cfg := t.agent.Config()
	s := t.agent.Status()
	dst := filepath.Join(os.TempDir(), fmt.Sprintf("Mitspielzentrale-Agent-Setup-%s.exe", s.UpdateVersion))
	if err := DownloadInstaller(cfg.Server, cfg.Key(), dst); err != nil {
		done(err)
		return
	}
	if err := startProgram(dst, "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS"); err != nil {
		done(err)
		return
	}
	systray.Quit()
}
