//go:build !windows

package main

// Non-Windows stubs so the matching logic builds and tests everywhere.

func Processes() ([]Process, error)               { return nil, nil }
func InstalledGames() ([]InstalledGame, []string) { return nil, nil }
func SteamRunningAppID() string                   { return "" }
func CurrentSteamAccount() *SteamAccount          { return nil }
