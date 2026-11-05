package main

// connect trades the one-time code for the key and stores server, user and key.
func connect(dir string, req PairRequest) error {
	res, err := Pair(req)
	if err != nil {
		return err
	}
	cfg, _ := LoadConfig(dir)
	cfg.Server, cfg.User, cfg.Paused = req.Server, res.Name(), false
	if err := cfg.SetKey(res.Key); err != nil {
		return err
	}
	return SaveConfig(dir, cfg)
}
