import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import express, { type Express, type Request } from "express";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type {
  ModuleContext,
  ModuleNotification,
  ModuleNotificationChannel,
  ModuleRegister,
  ModuleUser,
  PushPayload,
  UserRole
} from "./index";
import type { ModuleManifest } from "./manifest";

/**
 * Testhilfe: führt ein Modul gegen einen nachgebauten Kern aus.
 *
 * - SQLite im Speicher mit den Kerntabellen, auf die Module verweisen dürfen (users, main_events,
 *   game_events) und den Migrationen des Moduls
 * - Express-App mit dem Modul-Router unter /api/m/<id>
 * - angemeldeter Benutzer über den Header `x-test-user` (Benutzername aus `users`)
 * - Rechte wie im Kern: niedrigste Rolle aus `defaultRoles` und darüber, Admin darf alles,
 *   zusätzliche Vergaben über `grant()`
 *
 * Es prüft nicht CSRF; das übernimmt im echten Kern der Verteiler.
 */

const ROLE_RANK: Record<UserRole, number> = { user: 0, organizer: 1, manager: 2, admin: 3 };

const CORE_SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  email TEXT NOT NULL,
  phone_number TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  locale TEXT,
  current_main_event_id TEXT REFERENCES main_events(id) ON DELETE SET NULL,
  notifications_enabled INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE main_events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  visibility TEXT NOT NULL DEFAULT 'public',
  planned_start_at TEXT,
  planned_end_at TEXT,
  started_at TEXT,
  ended_at TEXT
);
CREATE TABLE main_event_participants (
  id TEXT PRIMARY KEY,
  main_event_id TEXT NOT NULL REFERENCES main_events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL
);
CREATE TABLE main_event_invites (
  id TEXT PRIMARY KEY,
  main_event_id TEXT NOT NULL REFERENCES main_events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by_user_id TEXT,
  created_at TEXT
);
CREATE TABLE game_events (id TEXT PRIMARY KEY, title TEXT NOT NULL, main_event_id TEXT REFERENCES main_events(id) ON DELETE SET NULL);
`;

export type TestModuleOptions = {
  /** Modulordner mit module.json, migrations/ usw. */
  moduleDir: string;
  register?: ModuleRegister;
  settings?: Record<string, unknown>;
  secrets?: Record<string, string>;
  users?: Array<{ id?: string; username: string; role?: UserRole; displayName?: string; phoneNumber?: string }>;
  /** Simuliert einen Kern ohne `ctx.rawBody` (Matchdesk bis einschließlich 0.21.0). */
  withoutRawBody?: boolean;
};

export type TestModule = {
  app: Express;
  ctx: ModuleContext;
  db: Database.Database;
  manifest: Pick<ModuleManifest, "id" | "permissions" | "tables" | "secrets">;
  /** Push-Aufrufe; `to` ist "users", "all" oder "event:<id>". */
  pushes: Array<{ userIds: string[]; payload: PushPayload; to?: string }>;
  broadcasts: Array<{ event: string; data: unknown }>;
  audits: Array<Record<string, unknown>>;
  /** Mit ctx.notifications.registerChannel angemeldete Kanäle (nach ID). */
  channels: Map<string, ModuleNotificationChannel>;
  /**
   * Stellt eine Nachricht wie der Kern über einen Modulkanal zu: prüft isAvailable und ruft send.
   * Gibt "sent", "unavailable" oder den Fehlertext zurück.
   */
  notify: (channelId: string, username: string, message?: Partial<ModuleNotification>) => Promise<string>;
  grant: (username: string, permission: string, mainEventId?: string | null) => void;
  /** Legt ein Event an (für ctx.events). */
  addEvent: (event: { id: string; name: string; status?: "planned" | "running" | "ended"; visibility?: "public" | "private" }) => void;
  /** Meldet einen Benutzer zu einem Event an (Standard: „dabei“). */
  join: (username: string, mainEventId: string, status?: "joined" | "interested" | "waitlisted" | "declined") => void;
  /** Lädt einen Benutzer zu einem privaten Event ein. */
  invite: (username: string, mainEventId: string) => void;
  /** Setzt das aktuelle Event eines Benutzers (globaler Umschalter). */
  setCurrentEvent: (username: string, mainEventId: string | null) => void;
  setSettings: (settings: Record<string, unknown>) => void;
  stop: () => Promise<void>;
  userId: (username: string) => string;
};

function defaultsFromSchema(schema: unknown) {
  const properties = ((schema as { properties?: Record<string, { default?: unknown }> } | undefined)?.properties ?? {}) as Record<
    string,
    { default?: unknown }
  >;
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([, property]) => property && "default" in property)
      .map(([key, property]) => [key, property.default])
  );
}

/**
 * SQLite im Speicher mit den Kerntabellen und den Migrationen des Moduls, ohne Benutzer.
 * Für Tests des Domain-Codes, die keinen Router brauchen.
 */
export function createTestDatabase(moduleDir: string): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(CORE_SCHEMA);
  const migrationsDir = path.join(moduleDir, "migrations");
  if (fs.existsSync(migrationsDir)) {
    for (const file of fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
      db.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
    }
  }
  return db;
}

export async function createTestModule(options: TestModuleOptions): Promise<TestModule> {
  const moduleJson = JSON.parse(fs.readFileSync(path.join(options.moduleDir, "module.json"), "utf8")) as {
    id: string;
    permissions?: Array<{ key: string; defaultRoles?: UserRole[]; scopable?: boolean }>;
    tables?: string[];
    secrets?: string[];
    settings?: unknown;
  };
  const id = moduleJson.id;
  const permissions = moduleJson.permissions ?? [];
  const db = createTestDatabase(options.moduleDir);

  for (const user of options.users ?? [
    { username: "admin", role: "admin" as const },
    { username: "anna", role: "user" as const },
    { username: "max", role: "manager" as const }
  ]) {
    db.prepare("INSERT INTO users (id, username, display_name, email, phone_number, role) VALUES (?, ?, ?, ?, ?, ?)").run(
      user.id ?? `u-${user.username}`,
      user.username,
      user.displayName ?? null,
      `${user.username}@example.test`,
      user.phoneNumber ?? "",
      user.role ?? "user"
    );
  }

  const grants: Array<{ userId: string; permission: string; mainEventId: string | null }> = [];
  let settingsSchema = moduleJson.settings;
  let settingsZod: z.ZodType | undefined;
  for (const ext of [".ts", ".mts", ".js", ".mjs"]) {
    const file = path.join(options.moduleDir, "src", `settings${ext}`);
    if (fs.existsSync(file)) {
      const loaded = (await import(pathToFileURL(file).href)) as { settings?: z.ZodType };
      if (loaded.settings) {
        settingsZod = loaded.settings;
        settingsSchema = z.toJSONSchema(loaded.settings, { io: "input" });
      }
      break;
    }
  }
  let settings = { ...defaultsFromSchema(settingsSchema), ...(options.settings ?? {}) };
  const pushes: TestModule["pushes"] = [];
  const broadcasts: TestModule["broadcasts"] = [];
  const audits: TestModule["audits"] = [];
  const channels = new Map<string, ModuleNotificationChannel>();
  const timers = new Set<NodeJS.Timeout>();
  const cleanups: Array<() => unknown> = [];
  const router = express.Router();
  const rawBodies = new WeakMap<object, Buffer>();

  function findUser(username: string) {
    return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
      | {
          id: string;
          username: string;
          display_name: string | null;
          email: string;
          phone_number: string;
          role: UserRole;
          locale: string | null;
        }
      | undefined;
  }

  function toModuleUser(row: NonNullable<ReturnType<typeof findUser>>): ModuleUser {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      email: row.email,
      phoneNumber: row.phone_number,
      role: row.role,
      locale: row.locale
    };
  }

  const ctx: ModuleContext = {
    id,
    version: "0.0.0-test",
    matchdeskApi: 1,
    router,
    log: { info: () => undefined, warn: () => undefined, error: (...args) => console.error(`[${id}]`, ...args) },
    currentUser: (request) => {
      const name = request.get("x-test-user");
      const row = name ? findUser(name) : undefined;
      return row ? toModuleUser(row) : undefined;
    },
    ...(options.withoutRawBody ? {} : { rawBody: (request: Request) => rawBodies.get(request) }),
    requireWrite: (request, response) => {
      if (!request.get("x-test-user")) {
        response.status(401).json({ error: "nicht_angemeldet" });
        return false;
      }
      return true;
    },
    can: (actor, key, canOptions = {}) => {
      if (!actor) return false;
      const role = actor.role as UserRole;
      if (role === "admin") return true;
      const def = permissions.find((permission) => permission.key === key);
      const roles = def?.defaultRoles ?? [];
      if (roles.length > 0 && ROLE_RANK[role] >= Math.min(...roles.map((entry) => ROLE_RANK[entry]))) return true;
      return grants.some(
        (grant) =>
          grant.userId === actor.id &&
          grant.permission === key &&
          (grant.mainEventId === null || (def?.scopable && grant.mainEventId === (canOptions.mainEventId ?? null)))
      );
    },
    scopedEventIds: (actor, key) =>
      actor
        ? grants.filter((grant) => grant.userId === actor.id && grant.permission === key && grant.mainEventId).map((grant) => grant.mainEventId!)
        : [],
    settings: {
      get: () => ({ ...settings }),
      set: (values) => {
        const next = { ...settings, ...values };
        settings = (settingsZod ? settingsZod.parse(next) : next) as Record<string, unknown>;
        audits.push({ action: `${id}.settings_updated`, keys: Object.keys(values) });
        return { ...settings };
      }
    },
    events: {
      get: (mainEventId) => {
        const row = db.prepare("SELECT * FROM main_events WHERE id = ?").get(mainEventId) as
          | Record<string, string | null>
          | undefined;
        return row
          ? {
              id: row.id!,
              name: row.name!,
              status: row.status as "planned" | "running" | "ended",
              visibility: row.visibility as "public" | "private",
              plannedStartAt: row.planned_start_at,
              plannedEndAt: row.planned_end_at,
              startedAt: row.started_at,
              endedAt: row.ended_at
            }
          : null;
      },
      currentIdOf: (user) => {
        const row = db
          .prepare("SELECT e.id, e.status FROM users u JOIN main_events e ON e.id = u.current_main_event_id WHERE u.id = ?")
          .get(user.id) as { id: string; status: string } | undefined;
        return row && row.status !== "ended" ? row.id : null;
      },
      canSee: (user, mainEventId) => {
        if (!user) return false;
        const event = db.prepare("SELECT visibility FROM main_events WHERE id = ?").get(mainEventId) as { visibility: string } | undefined;
        if (!event) return false;
        if (event.visibility === "public" || user.role === "admin" || user.role === "manager") return true;
        return Boolean(db.prepare("SELECT 1 FROM main_event_invites WHERE main_event_id = ? AND user_id = ?").get(mainEventId, user.id));
      },
      participantStatus: (mainEventId, userId) =>
        ((db.prepare("SELECT status FROM main_event_participants WHERE main_event_id = ? AND user_id = ?").get(mainEventId, userId) as
          | { status: "joined" | "interested" | "waitlisted" | "declined" }
          | undefined)?.status ?? null)
    },
    env: (name) => {
      if (!(moduleJson.secrets ?? []).includes(name)) throw new Error(`Geheimnis ${name} nicht im Manifest angemeldet`);
      return options.secrets?.[name];
    },
    db,
    audit: (entry) => {
      audits.push({ ...entry, action: `${id}.${entry.action}` });
    },
    push: {
      toUsers: async (userIds, payload) => {
        pushes.push({ userIds, payload, to: "users" });
      },
      toAll: async (payload) => {
        pushes.push({ userIds: [], payload, to: "all" });
      },
      toEventParticipants: async (mainEventId, payload) => {
        const userIds = (
          db.prepare("SELECT user_id FROM main_event_participants WHERE main_event_id = ? AND status = 'joined'").all(mainEventId) as Array<{
            user_id: string;
          }>
        ).map((row) => row.user_id);
        pushes.push({ userIds, payload, to: `event:${mainEventId}` });
      }
    },
    notifications: {
      registerChannel: (channel) => {
        // Gleiche Regeln wie im Kern (src/server/notifications/dispatcher.ts, modules/module-context.ts)
        if (!/^[a-z][a-z0-9]{1,31}$/.test(channel.id) || channel.id === "mail" || channel.id === "push") {
          throw new Error(`Ungültige Kanal-ID: ${channel.id}`);
        }
        if (!channel.id.startsWith(id)) throw new Error(`Kanal-ID ${channel.id} muss mit der Modul-ID ${id} beginnen.`);
        channels.set(channel.id, channel);
        cleanups.push(() => channels.delete(channel.id));
      }
    },
    realtime: { broadcast: (event, data) => broadcasts.push({ event, data }) },
    http: { fetch: (...args) => fetch(...args) },
    schedule: (intervalMs, task) => {
      const timer = setInterval(() => void task(), Math.max(1000, intervalMs));
      timer.unref?.();
      timers.add(timer);
      return () => {
        clearInterval(timer);
        timers.delete(timer);
      };
    },
    on: () => undefined,
    onStop: (cleanup) => {
      cleanups.push(cleanup);
    }
  };

  const app = express();
  // Wie im Kern: 1 MB, roher Body bleibt für Modul-Routen erhalten.
  app.use(
    express.json({
      limit: "1mb",
      verify: (request, _response, buffer) => {
        rawBodies.set(request, Buffer.from(buffer));
      }
    })
  );
  app.use(`/api/m/${id}`, router);

  if (options.register) {
    const cleanup = await options.register(ctx);
    if (typeof cleanup === "function") cleanups.push(cleanup as () => unknown);
  }

  return {
    app,
    ctx,
    db,
    manifest: { id, permissions: permissions as ModuleManifest["permissions"], tables: moduleJson.tables ?? [], secrets: moduleJson.secrets ?? [] },
    pushes,
    broadcasts,
    audits,
    channels,
    notify: async (channelId, username, message = {}) => {
      const channel = channels.get(channelId);
      if (!channel) throw new Error(`Kanal ${channelId} ist nicht angemeldet`);
      const row = findUser(username);
      if (!row) throw new Error(`Unbekannter Benutzer ${username}`);
      const user = toModuleUser(row);
      if (!channel.isAvailable(user)) return "unavailable";
      try {
        await channel.send(user, {
          mainEventId: "event-1",
          eventName: "Test-LAN",
          subject: "Betreff",
          body: "Text",
          path: "#main-events",
          url: "https://matchdesk.example.test/#main-events",
          unsubscribeUrl: "https://matchdesk.example.test/api/notifications/unsubscribe/token",
          ...message
        });
        return "sent";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    grant: (username, permission, mainEventId = null) => {
      const user = findUser(username);
      if (!user) throw new Error(`Unbekannter Benutzer ${username}`);
      grants.push({ userId: user.id, permission, mainEventId });
    },
    addEvent: (event) => {
      db.prepare("INSERT INTO main_events (id, name, status, visibility) VALUES (?, ?, ?, ?)").run(
        event.id,
        event.name,
        event.status ?? "running",
        event.visibility ?? "public"
      );
    },
    join: (username, mainEventId, status = "joined") => {
      const user = findUser(username);
      if (!user) throw new Error(`Unbekannter Benutzer ${username}`);
      db.prepare(
        "INSERT INTO main_event_participants (id, main_event_id, user_id, status) VALUES (?, ?, ?, ?)"
      ).run(`p-${mainEventId}-${user.id}`, mainEventId, user.id, status);
    },
    invite: (username, mainEventId) => {
      const user = findUser(username);
      if (!user) throw new Error(`Unbekannter Benutzer ${username}`);
      db.prepare("INSERT INTO main_event_invites (id, main_event_id, user_id) VALUES (?, ?, ?)").run(`i-${mainEventId}-${user.id}`, mainEventId, user.id);
    },
    setCurrentEvent: (username, mainEventId) => {
      db.prepare("UPDATE users SET current_main_event_id = ? WHERE username = ?").run(mainEventId, username);
    },
    setSettings: (next) => {
      settings = { ...settings, ...next };
    },
    userId: (username) => {
      const user = findUser(username);
      if (!user) throw new Error(`Unbekannter Benutzer ${username}`);
      return user.id;
    },
    stop: async () => {
      for (const timer of timers) clearInterval(timer);
      for (const cleanup of cleanups.reverse()) await cleanup();
      db.close();
    }
  };
}
