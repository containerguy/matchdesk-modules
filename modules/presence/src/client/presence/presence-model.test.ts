import { describe, expect, it } from "vitest";
import { groupByGame, type PresencePlayer } from "./presence-model";

const player = (userId: string, username: string, games: PresencePlayer["games"]): PresencePlayer => ({
  userId,
  username,
  displayName: null,
  games,
  updatedAt: "2026-11-03T18:00:00Z"
});

describe("groupByGame", () => {
  it("merges the same game across launchers and sorts by group size", () => {
    const groups = groupByGame([
      player("1", "rene", [{ title: "Titanfall® 2", launcher: "steam", since: "2026-11-03T18:00:00Z" }]),
      player("2", "anna", [{ title: "Titanfall™ 2", launcher: "ea", since: "2026-11-03T18:01:00Z" }]),
      player("3", "ben", [{ title: "Counter-Strike 2", launcher: "steam", since: "2026-11-03T18:02:00Z" }])
    ]);
    expect(groups.map((group) => group.title)).toEqual(["Titanfall 2", "Counter-Strike 2"]);
    expect(groups[0].players.map((entry) => entry.name)).toEqual(["anna", "rene"]);
  });
});
