import { z } from "zod";
/** Rollen des Kerns (Matchdesk), für `defaultRoles`. */
export const userRoleSchema = z.enum(["user", "organizer", "manager", "admin"]);

/** Schnittstellen-Version zwischen Kern und Modulen. Eine inkompatible Änderung erhöht sie. */
export const MATCHDESK_MODULE_API = 1;

/** Modulkennung: auch Präfix für Tabellen (`pizza_…`), Rechte (`pizza.`) und API-Pfad (`/api/m/pizza`). */
export const moduleIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]{1,31}$/, "Kennung: 2–32 Zeichen, nur Kleinbuchstaben und Ziffern");

export const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Version im Format 1.2.3");

export const localizedTextSchema = z.union([
  z.string().trim().min(1).max(120),
  z.object({ de: z.string().trim().min(1).max(120), en: z.string().trim().min(1).max(120).optional() })
]);

export type LocalizedText = z.infer<typeof localizedTextSchema>;

export function localize(text: LocalizedText, locale: string | undefined) {
  if (typeof text === "string") return text;
  if (locale?.startsWith("en") && text.en) return text.en;
  return text.de;
}

const permissionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/, "Recht im Format modul.aktion"),
  label: localizedTextSchema,
  description: localizedTextSchema.optional(),
  /** Darf das Recht auch nur für ein einzelnes Event vergeben werden? */
  scopable: z.boolean().default(false),
  /** Vorschlag, welche mitgelieferten Rollen das Recht beim Installieren bekommen. */
  defaultRoles: z.array(userRoleSchema).default([])
});

const menuEntrySchema = z.object({
  /** Unterpfad der Modulseite: `#m/<id>/<path>`; leer = Startseite des Moduls. */
  path: z.string().regex(/^[a-z0-9-]{0,40}$/).default(""),
  label: localizedTextSchema,
  /** SVG-Pfad (24×24) für die mobile Tab-Leiste. */
  icon: z.string().max(2000).optional(),
  order: z.number().int().min(0).max(1000).default(50),
  /** Nur sichtbar mit diesem Recht; fehlt es, sehen alle Angemeldeten den Eintrag. */
  permission: z.string().optional()
});

export const moduleManifestSchema = z
  .object({
    id: moduleIdSchema,
    name: localizedTextSchema,
    version: semverSchema,
    matchdeskApi: z.number().int().positive(),
    description: localizedTextSchema.optional(),
    author: z.string().max(120).optional(),
    homepage: z.string().url().max(300).optional(),
    license: z.string().max(60).optional(),
    /** Einstiegspunkte im Paket. */
    server: z.string().regex(/^[a-zA-Z0-9_./-]+\.mjs$/).optional(),
    client: z.string().regex(/^[a-zA-Z0-9_./-]+\.mjs$/).optional(),
    permissions: z.array(permissionSchema).default([]),
    /** JSON-Schema (Objekt) der Einstellungen; Vorgaben über `default` je Eigenschaft. */
    settings: z.record(z.string(), z.unknown()).optional(),
    menu: z.array(menuEntrySchema).default([]),
    /** Hat das Modul eine eigene Admin-Unterseite (aus client.mjs)? */
    adminPage: z.boolean().default(false),
    /** Alle Tabellen des Moduls in FK-Reihenfolge (für Backup, Export und Deinstallation). */
    tables: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]),
    /** Namen von Umgebungsvariablen (ohne MATCHDESK_-Präfix), die das Modul lesen darf. */
    secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
    /** Hosts, die das Modul ansprechen will (Anzeige für den Admin). */
    network: z.array(z.string().max(200)).default([])
  })
  .superRefine((manifest, issue) => {
    const prefix = `${manifest.id}.`;
    for (const permission of manifest.permissions) {
      if (!permission.key.startsWith(prefix)) {
        issue.addIssue({ code: "custom", message: `Recht ${permission.key} muss mit ${prefix} beginnen` });
      }
    }
    for (const table of manifest.tables) {
      if (!table.startsWith(`${manifest.id}_`)) {
        issue.addIssue({ code: "custom", message: `Tabelle ${table} muss mit ${manifest.id}_ beginnen` });
      }
    }
    const keys = new Set(manifest.permissions.map((permission) => permission.key));
    for (const entry of manifest.menu) {
      if (entry.permission && !keys.has(entry.permission)) {
        issue.addIssue({ code: "custom", message: `Menüpunkt verweist auf unbekanntes Recht ${entry.permission}` });
      }
    }
    if (manifest.settings && manifest.settings.type !== "object") {
      issue.addIssue({ code: "custom", message: "settings muss ein JSON-Schema vom Typ object sein" });
    }
  });

export type ModuleManifest = z.infer<typeof moduleManifestSchema>;
export type ModulePermissionDef = ModuleManifest["permissions"][number];

/** Index-Datei einer Modul-Quelle (`matchdesk-source.json`). */
export const sourceIndexSchema = z.object({
  matchdeskSource: z.literal(1),
  name: z.string().max(120).optional(),
  modules: z
    .array(
      z.object({
        id: moduleIdSchema,
        name: localizedTextSchema,
        description: localizedTextSchema.optional(),
        versions: z
          .array(
            z.object({
              version: semverSchema,
              matchdeskApi: z.number().int().positive(),
              /** Absolute HTTPS-URL oder relativ zur Index-Datei. */
              url: z.string().min(1).max(1000),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
              publishedAt: z.string().optional(),
              changelog: z.string().max(4000).optional()
            })
          )
          .min(1)
      })
    )
    .default([])
});

export type SourceIndex = z.infer<typeof sourceIndexSchema>;

/** Vergleicht zwei Versionen wie 1.2.3 (Vorabversionen zählen kleiner als die fertige Version). */
export function compareVersions(a: string, b: string) {
  const [coreA, preA] = a.split("-", 2);
  const [coreB, preB] = b.split("-", 2);
  const partsA = coreA.split(".").map(Number);
  const partsB = coreB.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (preA === preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  return preA < preB ? -1 : 1;
}
