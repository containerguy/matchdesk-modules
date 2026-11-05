//go:build !windows

package main

import (
	"os"
	"path/filepath"
)

// Non-Windows stubs so the matching logic builds and tests everywhere.

func Processes() ([]Process, error)               { return nil, nil }
func InstalledGames() ([]InstalledGame, []string) { return nil, nil }
func SteamRunningAppID() string                   { return "" }
func CurrentSteamAccount() *SteamAccount          { return nil }

// Without DPAPI the key is stored as is; only used for tests and local development.
func protect(b []byte) ([]byte, error)   { return b, nil }
func unprotect(b []byte) ([]byte, error) { return b, nil }

func appDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "mitspielzentrale-agent")
}
