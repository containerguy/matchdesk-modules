import type { ArenaSettings } from "./settings";

/**
 * Spiele, die das Modul anbinden kann. Jedes Spiel hat einen eigenen Server (eigenes Repo), der die
 * Schnittstelle `/api/integrations/v1` spricht: reservierte Tische, Platz-Links, signierte Ereignisse.
 */
export type GameDef = {
  id: string;
  name: { de: string; en: string };
  description: { de: string; en: string };
  /** Pfad unter derselben Adresse wie Matchdesk, für das eingebettete Spiel (iframe). */
  path: (settings: ArenaSettings) => string;
  /** Adresse des Spielservers für Aufrufe vom Matchdesk-Server. */
  apiUrl: (settings: ArenaSettings) => string;
  enabled: (settings: ArenaSettings) => boolean;
  apiKeySecret: string;
  webhookSecret: string;
  /** Stufen des Computergegners; das Spiel läuft dafür ohne Server im Browser (`?embed=1&solo=<stufe>`). */
  computerLevels: string[];
};

export const GAMES: GameDef[] = [
  {
    id: "billiard",
    name: { de: "Billard", en: "Billiards" },
    description: { de: "8-Ball für zwei, auch auf dem Handy.", en: "8-ball for two, phones included." },
    path: (s) => s.billiardPath,
    apiUrl: (s) => s.billiardApiUrl,
    enabled: (s) => s.billiardEnabled,
    apiKeySecret: "BILLIARD_API_KEY",
    webhookSecret: "BILLIARD_WEBHOOK_SECRET",
    computerLevels: ["easy", "medium", "hard"]
  },
  {
    id: "shift",
    name: { de: "Dreierschub", en: "Triple Shift" },
    description: { de: "Steine einschieben, Dreierreihen räumen. Für zwei, auch auf dem Handy.", en: "Push tiles in, clear lines of three. For two, phones included." },
    path: (s) => s.shiftPath,
    apiUrl: (s) => s.shiftApiUrl,
    enabled: (s) => s.shiftEnabled,
    apiKeySecret: "SHIFT_API_KEY",
    webhookSecret: "SHIFT_WEBHOOK_SECRET",
    computerLevels: ["easy", "medium", "hard"]
  },
  {
    id: "gnomes",
    name: { de: "Gartenfehde", en: "Garden Feud" },
    description: {
      de: "Gartenzwerge im Schrebergarten: laufen, zielen, nass machen. Für zwei, auch auf dem Handy.",
      en: "Garden gnomes in the allotment: move, aim, soak. For two, phones included."
    },
    path: (s) => s.gnomesPath,
    apiUrl: (s) => s.gnomesApiUrl,
    enabled: (s) => s.gnomesEnabled,
    apiKeySecret: "GNOMES_API_KEY",
    webhookSecret: "GNOMES_WEBHOOK_SECRET",
    computerLevels: ["easy", "medium", "hard"]
  }
];

export function findGame(id: string): GameDef | undefined {
  return GAMES.find((game) => game.id === id);
}

/** `<base>/` + Pfad, ohne doppelte Schrägstriche. */
export function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
