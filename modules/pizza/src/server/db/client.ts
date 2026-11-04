import type Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

/** Wie im Kern: rohe better-sqlite3-Verbindung (ctx.db) plus Drizzle mit dem Modul-Schema. */
export type DatabaseContext = {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
};

export function createDatabaseContext(sqlite: Database.Database): DatabaseContext {
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
