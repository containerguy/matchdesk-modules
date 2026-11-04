/**
 * Normalisierung von Spieltiteln (Phase 15): Kleinschreibung, nur `[a-z0-9]`.
 * Server (Bindungen) und Client (Formular-Hinweis, isCod4Game) müssen dieselbe Regel nutzen.
 * "Counter-Strike 1.6" -> "counterstrike16".
 */
export function normalizeGameTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, "");
}
