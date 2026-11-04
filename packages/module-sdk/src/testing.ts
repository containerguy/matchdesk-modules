import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import express, { type Express } from "express";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { ModuleContext, ModuleRegister, ModuleUser, PushPayload, UserRole } from "./index";
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
  role TEXT NOT NULL DEFAULT 'user',
  locale TEXT,
  deleted_at TEXT
);
CREATE TABLE main_events (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planned');
CREATE TABLE game_events (id TEXT PRIMARY KEY, title TEXT NOT NULL, main_event_id TEXT REFERENCES main_events(id) ON DELETE SET NULL);
`;

export type TestModuleOptions = {
  /** Modulordner mit module.json, migrations/ usw. */
  moduleDir: string;
  register?: ModuleRegister;
  settings?: Record<string, unknown>;
  secrets?: Record<string, string>;
  users?: Array<{ id?: string; username: string; role?: UserRole; displayName?: string }>;
};

export type TestModule = {
  app: Express;
  ctx: ModuleContext;
  db: Database.Database;
  manifest: Pick<ModuleManifest, "id" | "permissions" | "tables" | "secrets">;
  pushes: Array<{ userIds: string[]; payload: PushPayload }>;
  broadcasts: Array<{ event: string; data: unknown }>;
  audits: Array<Record<string, unknown>>;
  grant: (username: string, permission: string, mainEventId?: string | null) => void;
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
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(CORE_SCHEMA);

  const migrationsDir = path.join(options.moduleDir, "migrations");
  if (fs.existsSync(migrationsDir)) {
    for (const file of fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
      db.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
    }
  }

  for (const user of options.users ?? [
    { username: "admin", role: "admin" as const },
    { username: "anna", role: "user" as const },
    { username: "max", role: "manager" as const }
  ]) {
    db.prepare("INSERT INTO users (id, username, display_name, email, role) VALUES (?, ?, ?, ?, ?)").run(
      user.id ?? `u-${user.username}`,
      user.username,
      user.displayName ?? null,
      `${user.username}@example.test`,
      user.role ?? "user"
    );
  }

  const grants: Array<{ userId: string; permission: string; mainEventId: string | null }> = [];
  let settingsSchema = moduleJson.settings;
  for (const ext of [".ts", ".mts", ".js", ".mjs"]) {
    const file = path.join(options.moduleDir, "src", `settings${ext}`);
    if (fs.existsSync(file)) {
      const loaded = (await import(pathToFileURL(file).href)) as { settings?: z.ZodType };
      if (loaded.settings) settingsSchema = z.toJSONSchema(loaded.settings, { io: "input" });
      break;
    }
  }
  let settings = { ...defaultsFromSchema(settingsSchema), ...(options.settings ?? {}) };
  const pushes: TestModule["pushes"] = [];
  const broadcasts: TestModule["broadcasts"] = [];
  const audits: TestModule["audits"] = [];
  const timers = new Set<NodeJS.Timeout>();
  const cleanups: Array<() => unknown> = [];
  const router = express.Router();

  function findUser(username: string) {
    return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
      | { id: string; username: string; display_name: string | null; email: string; role: UserRole; locale: string | null }
      | undefined;
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
      if (!row) return undefined;
      const user: ModuleUser = {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        email: row.email,
        role: row.role,
        locale: row.locale
      };
      return user;
    },
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
    settings: { get: () => ({ ...settings }) },
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
        pushes.push({ userIds, payload });
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
  app.use(express.json());
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
    grant: (username, permission, mainEventId = null) => {
      const user = findUser(username);
      if (!user) throw new Error(`Unbekannter Benutzer ${username}`);
      grants.push({ userId: user.id, permission, mainEventId });
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
