import { z } from "zod";
import { steamAccountSchema } from "./accounts";

/** Wie im Kern (shared/game-title): Kleinschreibung, nur `[a-z0-9]`. */
export function normalizeGameTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * „Spielt gerade“: Der Windows-Agent (agent/) meldet regelmäßig, welche Spiele auf dem
 * PC laufen. Matchdesk hält das bewusst nur im Speicher: kein Verlauf, nach einem Neustart oder
 * nach PRESENCE_TTL_MS ohne neue Meldung ist der Eintrag weg.
 */

/** Ohne neue Meldung gilt ein Eintrag nach dieser Zeit als beendet (Agent meldet alle 30 s). */
export const PRESENCE_TTL_MS = 2 * 60 * 1000;
export const PRESENCE_MAX_GAMES = 5;

const launcherSchema = z.enum(["steam", "epic", "gog", "ubisoft", "ea", "battlenet", "other"]);

const reportedGameSchema = z.object({
  title: z.string().trim().min(1).max(160),
  launcher: launcherSchema.catch("other"),
  appId: z.string().trim().max(64).optional()
});

/**
 * Bericht des Agenten. Weitere Felder (z. B. Rechnername) werden verworfen, nicht gespeichert.
 * `playing: []` heißt: gerade kein Spiel. Einzelne ungültige Einträge (z. B. leerer Titel aus
 * einem kaputten Launcher-Manifest) fallen weg, statt den ganzen Bericht abzulehnen.
 */
export const presenceReportSchema = z.object({
  playing: z
    .array(z.unknown())
    .max(20)
    .transform((items) =>
      items.flatMap((item) => {
        const parsed = reportedGameSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    ),
  /** Angemeldetes Steam-Konto auf dem PC (optional). Ungültig → ignoriert, nicht abgelehnt. */
  steamAccount: steamAccountSchema.optional().catch(undefined)
});

export type PresenceGame = {
  title: string;
  launcher: z.infer<typeof launcherSchema>;
  appId?: string;
  /** Seit wann dieses Spiel ununterbrochen gemeldet wird. */
  since: string;
};

export type PresenceEntry = {
  userId: string;
  games: PresenceGame[];
  updatedAt: string;
};

export type PresenceStore = ReturnType<typeof createPresenceStore>;

function gameKey(game: { title: string; launcher: string }) {
  return `${game.launcher}|${normalizeGameTitle(game.title)}`;
}

export function createPresenceStore(options?: { ttlMs?: number; now?: () => number }) {
  const ttlMs = options?.ttlMs ?? PRESENCE_TTL_MS;
  const now = options?.now ?? (() => Date.now());
  const entries = new Map<string, PresenceEntry>();

  function isFresh(entry: PresenceEntry) {
    return now() - Date.parse(entry.updatedAt) <= ttlMs;
  }

  return {
    /** Übernimmt einen Bericht. Rückgabe `true`, wenn sich für andere sichtbar etwas geändert hat. */
    report(userId: string, playing: z.infer<typeof presenceReportSchema>["playing"]): boolean {
      const stamp = new Date(now()).toISOString();
      const previous = entries.get(userId);
      const previousGames = previous && isFresh(previous) ? previous.games : [];
      const previousByKey = new Map(previousGames.map((game) => [gameKey(game), game]));

      const games: PresenceGame[] = [];
      const seen = new Set<string>();
      for (const game of playing) {
        const key = gameKey(game);
        if (seen.has(key) || games.length >= PRESENCE_MAX_GAMES) {
          continue;
        }
        seen.add(key);
        games.push({
          title: game.title,
          launcher: game.launcher,
          ...(game.appId ? { appId: game.appId } : {}),
          since: previousByKey.get(key)?.since ?? stamp
        });
      }

      const changed =
        games.length !== previousGames.length || games.some((game) => !previousByKey.has(gameKey(game)));

      if (games.length === 0) {
        entries.delete(userId);
      } else {
        entries.set(userId, { userId, games, updatedAt: stamp });
      }
      return changed;
    },

    clear(userId: string): boolean {
      const existing = entries.get(userId);
      entries.delete(userId);
      return Boolean(existing && isFresh(existing));
    },

    /** Alle aktuellen Einträge; abgelaufene werden übersprungen (entfernt erst `sweep()`). */
    list(): PresenceEntry[] {
      return Array.from(entries.values()).filter((entry) => isFresh(entry));
    },

    /** Entfernt abgelaufene Einträge. Rückgabe `true`, wenn dabei etwas verschwunden ist. */
    sweep(): boolean {
      let removed = false;
      for (const [userId, entry] of entries) {
        if (!isFresh(entry)) {
          entries.delete(userId);
          removed = true;
        }
      }
      return removed;
    },

    clearAll() {
      entries.clear();
    }
  };
}
