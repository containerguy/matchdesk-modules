package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Config is stored in the user's profile (Windows: %LocalAppData%\Mitspielzentrale\Agent).
// The agent key is encrypted for the signed-in Windows user (DPAPI), never stored as plain text.
type Config struct {
	Server string `json:"server,omitempty"`
	User   string `json:"user,omitempty"`
	Paused bool   `json:"paused,omitempty"`
	// NoSteamAccount: do not send the signed-in Steam account (set by hand in agent.json).
	NoSteamAccount bool `json:"noSteamAccount,omitempty"`
	// KeyProtected is the DPAPI-encrypted agent key (base64 in the file).
	KeyProtected []byte `json:"key,omitempty"`

	key string
}

func (c Config) Connected() bool { return c.Server != "" && c.key != "" }
func (c Config) Key() string     { return c.key }

func (c *Config) SetKey(key string) error {
	if key == "" {
		c.key, c.KeyProtected = "", nil
		return nil
	}
	enc, err := protect([]byte(key))
	if err != nil {
		return err
	}
	c.key, c.KeyProtected = key, enc
	return nil
}

func configFile(dir string) string { return filepath.Join(dir, "agent.json") }

// LoadConfig returns an empty config if there is none yet. A key that cannot be decrypted
// (profile copied to another PC or user) counts as not connected.
func LoadConfig(dir string) (Config, error) {
	var c Config
	b, err := os.ReadFile(configFile(dir))
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return Config{}, err
	}
	if len(c.KeyProtected) > 0 {
		if key, err := unprotect(c.KeyProtected); err == nil {
			c.key = string(key)
		} else {
			c.KeyProtected = nil
		}
	}
	return c, nil
}

// SaveConfig writes atomically so a crash never leaves half a file.
func SaveConfig(dir string, c Config) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := configFile(dir) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, configFile(dir))
}

// loadKnown reads the optional list of extra exe names (known.json next to agent.json).
func loadKnown(dir string) []KnownExe {
	var known []KnownExe
	if b, err := os.ReadFile(filepath.Join(dir, "known.json")); err == nil {
		_ = json.Unmarshal(b, &known)
	}
	return known
}
