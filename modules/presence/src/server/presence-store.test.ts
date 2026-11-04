import { describe, expect, it } from "vitest";
import { createPresenceStore, normalizeGameTitle, presenceReportSchema } from "./presence-store";

describe("game presence store", () => {
  it("keeps since across reports and reports changes only when games change", () => {
    let now = Date.parse("2026-11-03T18:00:00Z");
    const store = createPresenceStore({ now: () => now });

    expect(store.report("u1", [{ title: "Counter-Strike 2", launcher: "steam", appId: "730" }])).toBe(true);
    now += 30_000;
    expect(store.report("u1", [{ title: "Counter-Strike 2", launcher: "steam", appId: "730" }])).toBe(false);

    const [entry] = store.list();
    expect(entry.games[0].since).toBe("2026-11-03T18:00:00.000Z");
    expect(entry.updatedAt).toBe("2026-11-03T18:00:30.000Z");

    now += 30_000;
    expect(store.report("u1", [{ title: "Battlefield™ 2042", launcher: "ea" }])).toBe(true);
    expect(store.list()[0].games[0].since).toBe("2026-11-03T18:01:00.000Z");
  });

  it("expires entries without new reports and removes them on an empty report", () => {
    let now = 0;
    const store = createPresenceStore({ ttlMs: 1000, now: () => now });
    store.report("u1", [{ title: "Valheim", launcher: "steam" }]);
    store.report("u2", [{ title: "Factorio", launcher: "other" }]);

    expect(store.report("u2", [])).toBe(true);
    expect(store.list().map((entry) => entry.userId)).toEqual(["u1"]);

    now = 1500;
    expect(store.list()).toEqual([]);
    expect(store.sweep()).toBe(true);
    expect(store.sweep()).toBe(false);
  });

  it("deduplicates and caps games", () => {
    const store = createPresenceStore();
    store.report(
      "u1",
      Array.from({ length: 8 }, (_, index) => ({ title: `Spiel ${index % 6}`, launcher: "other" as const }))
    );
    expect(store.list()[0].games).toHaveLength(5);
  });

  it("drops unknown fields such as the host name", () => {
    const parsed = presenceReportSchema.parse({
      host: "DESKTOP-M4PJL0I",
      launchersFound: ["steam"],
      playing: [{ title: "Counter-Strike 2", launcher: "steam", appId: "730", exe: "cs2.exe", source: "x" }]
    });
    expect(parsed).toEqual({ playing: [{ title: "Counter-Strike 2", launcher: "steam", appId: "730" }] });
  });

  it("drops invalid games one by one instead of rejecting the report", () => {
    const parsed = presenceReportSchema.parse({
      playing: [{ title: "", launcher: "gog" }, { title: "x".repeat(200) }, "kaputt", { title: "Valheim", launcher: "steam" }]
    });
    expect(parsed.playing).toEqual([{ title: "Valheim", launcher: "steam" }]);
  });

  it("treats an unknown launcher as other", () => {
    const parsed = presenceReportSchema.parse({ playing: [{ title: "X", launcher: "itch" }] });
    expect(parsed.playing[0].launcher).toBe("other");
  });

  it("normalizes titles for catalog matching", () => {
    expect(normalizeGameTitle("Battlefield™ 2042")).toBe("battlefield2042");
    expect(normalizeGameTitle("Titanfall® 2")).toBe(normalizeGameTitle("Titanfall™ 2"));
  });
});
