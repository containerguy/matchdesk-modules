import { normalizeGameTitle } from "../shared/game-title";

export type PresenceLauncher = "steam" | "epic" | "gog" | "ubisoft" | "ea" | "battlenet" | "other";

export type PresenceGame = {
  title: string;
  launcher: PresenceLauncher;
  appId?: string;
  since: string;
};

export type PresencePlayer = {
  userId: string;
  username: string;
  displayName: string | null;
  games: PresenceGame[];
  updatedAt: string;
};

export type PresenceGroup = {
  title: string;
  launcher: PresenceLauncher;
  players: Array<{ userId: string; name: string; since: string }>;
};

export const LAUNCHER_LABELS: Record<PresenceLauncher, string> = {
  steam: "Steam",
  epic: "Epic",
  gog: "GOG",
  ubisoft: "Ubisoft",
  ea: "EA",
  battlenet: "Battle.net",
  other: ""
};

/** Spieler nach Spiel gruppieren; größte Gruppe zuerst, dann alphabetisch. */
export function groupByGame(players: PresencePlayer[]): PresenceGroup[] {
  const groups = new Map<string, PresenceGroup>();
  for (const player of players) {
    for (const game of player.games) {
      const key = normalizeGameTitle(game.title);
      let group = groups.get(key);
      if (!group) {
        group = { title: game.title.replace(/[™®©]/g, ""), launcher: game.launcher, players: [] };
        groups.set(key, group);
      }
      if (!group.players.some((entry) => entry.userId === player.userId)) {
        group.players.push({ userId: player.userId, name: player.displayName || player.username, since: game.since });
      }
    }
  }
  return Array.from(groups.values())
    .map((group) => ({ ...group, players: group.players.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => b.players.length - a.players.length || a.title.localeCompare(b.title));
}
