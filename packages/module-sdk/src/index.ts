/**
 * @matchdesk/module-sdk – Schnittstelle zwischen Matchdesk-Kern und Modulen (matchdeskApi 1).
 *
 * Ein Modul besteht aus:
 * - `module.json`: Manifest ohne Version (die Version kommt aus package.json)
 * - `src/server.ts`: exportiert `register(ctx)` (optional)
 * - `src/client.tsx`: exportiert als default `(host) => ({ Page, Admin })` (optional)
 * - `src/settings.ts`: exportiert `settings` als zod-Schema (optional)
 * - `migrations/0001_….sql`, `uninstall.sql`, `i18n/de.json`, `i18n/en.json`, `assets/` (optional)
 *
 * `matchdesk-module build modules/<id>` baut daraus das Paket `<id>-<version>.tgz`.
 */
import type { Request, Response, Router } from "express";
import type { ComponentType } from "react";
import type ReactNamespace from "react";
import type BetterSqlite3 from "better-sqlite3";

export { MATCHDESK_MODULE_API, moduleManifestSchema, sourceIndexSchema, compareVersions } from "./manifest";
export type { ModuleManifest, ModulePermissionDef, SourceIndex, LocalizedText } from "./manifest";

export type UserRole = "user" | "organizer" | "manager" | "admin";

/** Öffentliche Sicht auf einen Benutzer, wie `ctx.currentUser` sie liefert. */
export type ModuleUser = {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  /** Telefonnummer aus dem Profil (kann leer sein). */
  phoneNumber: string;
  role: UserRole;
  locale: string | null;
};

/** Nachricht an einen Modulkanal, schon in der Sprache des Empfängers. */
export type ModuleNotification = {
  mainEventId: string;
  eventName: string;
  subject: string;
  /** Klartext (Markdown erlaubt). */
  body: string;
  /** Pfad in der App, z. B. `#main-events`. */
  path: string;
  /** Absoluter Link in die App, wenn MATCHDESK_PUBLIC_URL gesetzt ist. */
  url: string | null;
  /** Persönlicher Abmeldelink des Empfängers, wenn MATCHDESK_PUBLIC_URL gesetzt ist. */
  unsubscribeUrl: string | null;
};

/** Benachrichtigungskanal eines Moduls (Opt-in im Profil der Benutzer). */
export type ModuleNotificationChannel = {
  /** Beginnt mit der Modul-ID, z. B. `sms` im Modul `sms`. Erlaubt: [a-z][a-z0-9]{1,31}, nicht mail/push. */
  id: string;
  label: { de: string; en: string };
  /** Kann der Kanal diesen Benutzer erreichen (Telefonnummer, verknüpftes Konto)? */
  isAvailable: (user: ModuleUser) => boolean;
  /** Steht im Profil, solange der Kanal den Benutzer nicht erreichen kann. */
  unavailableHint?: { de: string; en: string };
  /** Wirft bei Fehlern; der Kern protokolliert die Zustellung als fehlgeschlagen. */
  send: (user: ModuleUser, message: ModuleNotification) => Promise<void>;
};

export type PermissionActor = { id: string; role: string } | null | undefined;

export type CoreEventMap = {
  "user.deleted": { userId: string };
  "mainEvent.created": { mainEventId: string };
  "mainEvent.started": { mainEventId: string };
  "mainEvent.ended": { mainEventId: string };
  "round.created": { eventId: string };
  "round.started": { eventId: string };
  "round.ended": { eventId: string };
};

export type PushPayload = { title: string; body: string; url?: string; requireInteraction?: boolean };

/** Sicht eines Moduls auf ein Event des Kerns. */
export type ModuleMainEvent = {
  id: string;
  name: string;
  status: "planned" | "running" | "ended";
  visibility: "public" | "private";
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

export type ModuleParticipantStatus = "joined" | "interested" | "waitlisted" | "declined";

/** better-sqlite3-Verbindung des Kerns (synchron). */
export type ModuleDatabase = BetterSqlite3.Database;

/** Alles, was ein Modul auf dem Server vom Kern bekommt (`register(ctx)`). */
export type ModuleContext = {
  id: string;
  version: string;
  matchdeskApi: number;
  /** Eingehängt unter /api/m/<id>. Schreibende Anfragen mit Sitzung prüft der Kern auf CSRF. */
  router: Router;
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  currentUser: (request: Request) => ModuleUser | undefined;
  requireWrite: (request: Request, response: Response) => boolean;
  /**
   * Unveränderter JSON-Body der Anfrage als Buffer, z. B. um Webhook-Signaturen (HMAC) zu prüfen.
   * Gesetzt nur für Anfragen unter /api/m/<id> mit JSON-Body, sonst undefined.
   * Optional, weil Matchdesk-Kerne bis einschließlich 0.21.0 die Funktion nicht haben: Module prüfen
   * `typeof ctx.rawBody === "function"` und lehnen signierte Anfragen ohne sie ab.
   */
  rawBody?: (request: Request) => Buffer | undefined;
  can: (user: PermissionActor, key: string, options?: { mainEventId?: string | null }) => boolean;
  /** Events, für die der Benutzer `key` nur per Event-Vergabe hat. Nur eigene Rechte (`<id>.…`). */
  scopedEventIds: (user: PermissionActor, key: string) => string[];
  settings: {
    get: () => Record<string, unknown>;
    /** Einzelne Werte ändern (gegen das Schema geprüft, im Audit-Log). Wirft bei ungültigen Werten. */
    set: (values: Record<string, unknown>, actor: { id: string; username: string; role: string }) => Record<string, unknown>;
  };
  /** Events des Kerns, nur lesend. */
  events: {
    get: (mainEventId: string) => ModuleMainEvent | null;
    /** Aktuelles Event des Benutzers (globaler Umschalter); null, wenn keins gewählt oder beendet. */
    currentIdOf: (user: { id: string }) => string | null;
    /** Öffentlich, eingeladen oder Event-Verwalter. */
    canSee: (user: PermissionActor, mainEventId: string) => boolean;
    participantStatus: (mainEventId: string, userId: string) => ModuleParticipantStatus | null;
  };
  /** Nur im Manifest unter `secrets` genannte Namen, gelesen als MATCHDESK_<NAME>. */
  env: (name: string) => string | undefined;
  /** Nur eigene Tabellen (Präfix `<id>_`) beschreiben. */
  db: ModuleDatabase;
  audit: (entry: {
    actor?: { id: string; username: string } | null;
    action: string;
    summary: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
  }) => void;
  push: {
    toUsers: (userIds: string[], payload: PushPayload) => Promise<void>;
    /** Alle Benutzer mit eingeschalteten Benachrichtigungen. */
    toAll: (payload: PushPayload) => Promise<void>;
    /** Teilnehmer („dabei“) eines Events. */
    toEventParticipants: (mainEventId: string, payload: PushPayload) => Promise<void>;
  };
  /**
   * Eigener Benachrichtigungskanal. Der Kern meldet ihn beim Ausschalten, Aktualisieren und
   * Herunterfahren selbst wieder ab.
   */
  notifications: { registerChannel: (channel: ModuleNotificationChannel) => void };
  realtime: { broadcast: (event: string, data?: unknown) => void };
  http: { fetch: typeof fetch };
  schedule: (intervalMs: number, task: () => unknown) => () => void;
  on: <K extends keyof CoreEventMap>(name: K, handler: (payload: CoreEventMap[K]) => unknown) => void;
  onStop: (cleanup: () => unknown) => void;
};

export type ModuleRegister = (ctx: ModuleContext) => unknown;

/** Hilfsfunktion nur für Typen: `export const register = defineServer((ctx) => { … })`. */
export function defineServer(register: ModuleRegister): ModuleRegister {
  return register;
}

// ---------- Client ----------

export type ModuleClientHost = {
  id: string;
  version: string;
  matchdeskApi: number;
  React: typeof ReactNamespace;
  locale: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  api: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  onRealtime: (event: string, handler: (data: unknown) => void) => () => void;
};

export type ModuleClientUser = { id: string; username: string; role: UserRole; displayName?: string | null };

export type ModulePageProps = {
  path: string;
  subPath: string;
  user: ModuleClientUser;
  permissions: string[];
};

export type ModuleAdminProps = {
  user: ModuleClientUser;
  settings: Record<string, unknown>;
  reloadSettings: () => void;
};

export type ModuleProfileProps = { user: ModuleClientUser };

export type ModuleNoticeProps = { user: ModuleClientUser };

export type ModuleClientDefinition = {
  Page?: ComponentType<ModulePageProps>;
  Admin?: ComponentType<ModuleAdminProps>;
  /** Bereich im Profil (Manifest `profile`), erreichbar unter `#login/m-<id>`. */
  Profile?: ComponentType<ModuleProfileProps>;
  /** Hinweis oben auf der Startseite (Manifest `startNotice`); `null`, wenn nichts zu sagen ist. */
  Notice?: ComponentType<ModuleNoticeProps>;
};

export type ModuleClientFactory = (host: ModuleClientHost) => ModuleClientDefinition;

/** Hilfsfunktion nur für Typen: `export default defineClient((host) => ({ Page }))`. */
export function defineClient(factory: ModuleClientFactory): ModuleClientFactory {
  return factory;
}
