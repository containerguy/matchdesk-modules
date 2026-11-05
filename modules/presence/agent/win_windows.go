//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	runKeyPath      = `Software\Microsoft\Windows\CurrentVersion\Run`
	runValueName    = appName
	protocolKeyPath = `Software\Classes\` + protocolScheme
	instanceMutex   = `Local\MitspielzentraleAgent`
	reloadEventName = `Local\MitspielzentraleAgentReload`
)

func appDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "Mitspielzentrale", "Agent")
}

func exePath() string {
	p, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		return resolved
	}
	return p
}

// --- DPAPI: the key is only readable by the same Windows user on this PC ---

var dpapiEntropy = []byte("Mitspielzentrale Agent key v1")

func blob(b []byte) *windows.DataBlob {
	if len(b) == 0 {
		return &windows.DataBlob{}
	}
	return &windows.DataBlob{Size: uint32(len(b)), Data: &b[0]}
}

func blobBytes(b *windows.DataBlob) []byte {
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(b.Data)))
	return append([]byte(nil), unsafe.Slice(b.Data, b.Size)...)
}

func protect(data []byte) ([]byte, error) {
	var out windows.DataBlob
	name, _ := windows.UTF16PtrFromString(appName)
	if err := windows.CryptProtectData(blob(data), name, blob(dpapiEntropy), 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, err
	}
	return blobBytes(&out), nil
}

func unprotect(data []byte) ([]byte, error) {
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(blob(data), nil, blob(dpapiEntropy), 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, err
	}
	return blobBytes(&out), nil
}

// --- one instance per user; a second start (e.g. from the link) hands over via an event ---

// acquireInstance returns false if the agent already runs for this user.
func acquireInstance() bool {
	name, _ := windows.UTF16PtrFromString(instanceMutex)
	h, err := windows.CreateMutex(nil, false, name)
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		if h != 0 {
			_ = windows.CloseHandle(h)
		}
		return false
	}
	return h != 0 // the handle stays open until the process ends
}

func reloadEvent() (windows.Handle, error) {
	name, _ := windows.UTF16PtrFromString(reloadEventName)
	return windows.CreateEvent(nil, 0, 0, name)
}

// signalRunningInstance tells the running agent to read its config again.
func signalRunningInstance() {
	h, err := reloadEvent()
	if err != nil {
		return
	}
	_ = windows.SetEvent(h)
	_ = windows.CloseHandle(h)
}

// onReload calls f whenever another instance signals the event.
func onReload(f func()) {
	h, err := reloadEvent()
	if err != nil {
		return
	}
	go func() {
		for {
			if ev, err := windows.WaitForSingleObject(h, windows.INFINITE); err != nil || ev != windows.WAIT_OBJECT_0 {
				return
			}
			f()
		}
	}()
}

// --- autostart (per user, like Steam and Discord; also visible in Task Manager › Autostart) ---

func autostartEnabled() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKeyPath, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue(runValueName)
	return err == nil
}

func setAutostart(on bool) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKeyPath, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if !on {
		if err := k.DeleteValue(runValueName); err != nil && !errors.Is(err, registry.ErrNotExist) {
			return err
		}
		return nil
	}
	return k.SetStringValue(runValueName, `"`+exePath()+`" -background`)
}

// registerProtocol makes matchdesk-agent:// links open this exe (per user, no admin rights).
// The installer does the same; doing it on start also covers a moved or portable exe.
func registerProtocol() error {
	exe := exePath()
	if exe == "" {
		return errors.New("exe path unknown")
	}
	set := func(path, name, value string) error {
		k, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.SET_VALUE)
		if err != nil {
			return err
		}
		defer k.Close()
		return k.SetStringValue(name, value)
	}
	for _, v := range [][3]string{
		{protocolKeyPath, "", "URL:" + appName},
		{protocolKeyPath, "URL Protocol", ""},
		{protocolKeyPath + `\DefaultIcon`, "", `"` + exe + `",0`},
		{protocolKeyPath + `\shell\open\command`, "", `"` + exe + `" "%1"`},
	} {
		if err := set(v[0], v[1], v[2]); err != nil {
			return err
		}
	}
	return nil
}

// --- small UI helpers ---

func openURL(u string) {
	verb, _ := windows.UTF16PtrFromString("open")
	target, _ := windows.UTF16PtrFromString(u)
	_ = windows.ShellExecute(0, verb, target, nil, nil, windows.SW_SHOWNORMAL)
}

func startProgram(path, args string) error {
	verb, _ := windows.UTF16PtrFromString("open")
	file, _ := windows.UTF16PtrFromString(path)
	params, _ := windows.UTF16PtrFromString(args)
	return windows.ShellExecute(0, verb, file, params, nil, windows.SW_SHOWNORMAL)
}

const (
	mbOK          = 0x0
	mbYesNo       = 0x4
	mbIconError   = 0x10
	mbIconQuest   = 0x20
	mbIconWarning = 0x30
	mbIconInfo    = 0x40
	mbDefButton2  = 0x100
	mbSetFg       = 0x10000
	mbTopmost     = 0x40000
	idYes         = 6
)

func messageBox(text string, flags uint32) int32 {
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString(appName)
	ret, _ := windows.MessageBox(0, t, c, flags|mbSetFg|mbTopmost)
	return ret
}

func confirm(text string) bool {
	return messageBox(text, mbYesNo|mbIconQuest|mbDefButton2) == idYes
}

func inform(text string) { messageBox(text, mbOK|mbIconInfo) }
func warn(text string)   { messageBox(text, mbOK|mbIconWarning) }
func fail(text string)   { messageBox(text, mbOK|mbIconError) }
