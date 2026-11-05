//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

// runApp without a tray (development on Linux/macOS): connect if a link was given, then
// report in the foreground until Ctrl+C.
func runApp(dir, pairLink string, _ bool) {
	if pairLink != "" {
		req, err := ParsePairURL(pairLink)
		if err == nil {
			err = connect(dir, req)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	a := NewAgent(dir, func(s Status) {
		fmt.Printf("verbunden=%v pausiert=%v spielt=%v fehler=%q\n", s.Connected, s.Paused, s.Playing, s.LastError)
	})
	go a.Run()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	a.Stop()
}
