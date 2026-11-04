/**
 * Import und Export des Pizza-Menüs als YAML (komplett: Kategorien → Artikel → Varianten, dazu
 * Extras) und als CSV (Menü und Extras getrennt, `;`, UTF-8 mit BOM).
 *
 * Ablauf wie beim JSON-Import: Die Datei beschreibt den Soll-Stand. Fehlende Artikel und
 * Kategorien werden deaktiviert, fehlende Varianten und Extras entfernt bzw. nur deaktiviert,
 * wenn sie schon bestellt wurden. Preis-Snapshots alter Bestellungen bleiben unberührt.
 * Zuordnung über Namen (ohne Groß-/Kleinschreibung) bzw. Artikelnummer, nicht über IDs.
 */
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { LineCounter, parseDocument, Scalar, stringify, type Node } from "yaml";
import { z } from "zod";
import type { DatabaseContext } from "../../db/client";
import { pizzaMenuCategories, pizzaMenuExtraCategories, pizzaMenuExtras, pizzaMenuItems, pizzaMenuVariants } from "../../db/schema";
import { listCategories, nameKey, PIZZA_CATEGORY_NAME_MAX_LEN } from "./categories";
import { parseCsv, toCsv, unguardCell } from "./csv";
import { listExtras, PIZZA_EXTRA_NAME_MAX_LEN, removeExtra } from "./extras";
import { listAllMenu, removeVariant } from "./menu";

export type MenuTransferFormat = "yaml" | "csv" | "extras_csv";

/** 256 KiB Zeichen: bleibt auch mit Umlauten unter dem JSON-Limit von 1 MB. */
export const MENU_TRANSFER_MAX_CHARS = 256 * 1024;
const MAX_CATEGORIES = 100;
const MAX_ITEMS = 1000;
const MAX_VARIANTS_PER_ITEM = 8;
const MAX_EXTRAS = 200;
const MAX_CSV_ROWS = 5000;

/** Menü-CSV: getrennte Spalten für Artikel- und Varianten-Status, damit der Roundtrip verlustfrei ist. */
export const MENU_CSV_HEADER = [
  "kategorie",
  "nummer",
  "artikel",
  "zutaten",
  "allergene",
  "artikel_aktiv",
  "variante",
  "preis_eur",
  "variante_aktiv"
];
/** Älteres Format mit einer `aktiv`-Spalte; sie gilt beim Import für die Variante. */
export const LEGACY_MENU_CSV_HEADER = ["kategorie", "nummer", "artikel", "zutaten", "allergene", "variante", "preis_eur", "aktiv"];
/** Ab so vielen bzw. diesem Anteil entfernter Einträge verlangt „Übernehmen“ eine Bestätigung. */
const REMOVAL_WARN_COUNT = 10;
const REMOVAL_WARN_SHARE = 0.2;
export const EXTRAS_CSV_HEADER = ["extra", "preis_eur", "kategorien", "aktiv"];

// --- Dokumentmodell ------------------------------------------------------------------------------

export interface DocVariant {
  label: string | null;
  priceCents: number;
  active: boolean;
  line: number | null;
}

export interface DocItem {
  number: string | null;
  name: string;
  ingredients: string | null;
  allergens: string | null;
  /** undefined = Status bestehender Artikel unverändert lassen (altes CSV ohne artikel_aktiv). */
  active: boolean | undefined;
  /** Status, falls der Artikel neu angelegt wird und `active` fehlt. */
  activeIfNew?: boolean;
  line: number | null;
  variants: DocVariant[];
}

export interface DocCategory {
  name: string;
  /** undefined = unverändert lassen (CSV kennt keinen Kategorie-Status). */
  active: boolean | undefined;
  line: number | null;
  items: DocItem[];
}

export interface DocExtra {
  name: string;
  priceCents: number;
  categories: string[];
  active: boolean;
  line: number | null;
}

export interface MenuDocument {
  categories?: DocCategory[];
  extras?: DocExtra[];
  /**
   * Nur YAML bildet alle Kategorien ab (auch leere). CSV kennt nur Kategorien mit Artikeln,
   * deshalb deaktiviert ein CSV-Import keine Kategorien.
   */
  deactivateMissingCategories?: boolean;
}

export interface TransferIssue {
  line: number | null;
  code: string;
  params?: Record<string, string | number>;
}

export interface TransferCounts {
  new: number;
  changed: number;
  unchanged: number;
  /** Deaktiviert oder gelöscht, weil in der Datei nicht mehr enthalten. */
  removed: number;
}

export interface TransferResult {
  format: MenuTransferFormat;
  sections: { menu: boolean; extras: boolean };
  counts: {
    categories: TransferCounts;
    items: TransferCounts;
    variants: TransferCounts;
    extras: TransferCounts;
  };
  errors: TransferIssue[];
  /** Hinweise, z. B. viele Entfernungen („Teil-Datei?“); Übernehmen braucht dann eine Bestätigung. */
  warnings: TransferIssue[];
  /** Fingerabdruck des Menüs zum Zeitpunkt der Vorschau; Übernehmen lehnt bei Abweichung ab. */
  menuVersion: string;
}

// --- Preise und Flags ----------------------------------------------------------------------------

/** "1,50", "1.5", "2", "1,50 €" oder Zahl 1.5 → Cent. Komma und Punkt sind erlaubt. */
export function parsePriceToCents(input: unknown): number | null {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    input = String(input);
  }
  if (typeof input !== "string") return null;
  const normalized = input.trim().replace(/\s|€/g, "").replace(",", ".");
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  if (!Number.isFinite(cents) || cents < 0 || cents > 100_000) return null;
  return cents;
}

export function formatPriceCsv(cents: number) {
  return (cents / 100).toFixed(2).replace(".", ",");
}

const ACTIVE_TRUE = new Set(["", "ja", "j", "yes", "y", "true", "wahr", "1", "x", "aktiv"]);
const ACTIVE_FALSE = new Set(["nein", "n", "no", "false", "falsch", "0", "inaktiv"]);

export function parseActiveFlag(input: string): boolean | null {
  const value = input.trim().toLowerCase();
  if (ACTIVE_TRUE.has(value)) return true;
  if (ACTIVE_FALSE.has(value)) return false;
  return null;
}

function emptyToNull(value: string | null | undefined) {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

// --- Export --------------------------------------------------------------------------------------

export function buildMenuDocument(context: DatabaseContext): Required<MenuDocument> {
  const categories = listCategories(context);
  const items = listAllMenu(context);
  return {
    deactivateMissingCategories: true,
    categories: categories.map((category) => ({
      name: category.name,
      active: category.active,
      line: null,
      items: items
        .filter((item) => item.categoryId === category.id)
        .map((item) => ({
          number: item.number,
          name: item.name,
          ingredients: item.ingredients,
          allergens: item.allergens,
          active: item.active,
          line: null,
          variants: item.variants.map((variant) => ({
            label: variant.sizeLabel,
            priceCents: variant.priceCents,
            active: variant.active,
            line: null
          }))
        }))
    })),
    extras: listExtras(context).map((extra) => ({
      name: extra.name,
      priceCents: extra.priceCents,
      // in Kategorie-Reihenfolge, damit der Export stabil und lesbar bleibt
      categories: categories.filter((category) => extra.categoryIds.includes(category.id)).map((category) => category.name),
      active: extra.active,
      line: null
    }))
  };
}

function yamlPrice(cents: number) {
  const scalar = new Scalar(cents / 100);
  scalar.minFractionDigits = 2;
  return scalar;
}

export function menuToYaml(doc: Required<MenuDocument>): string {
  const data = {
    format: "matchdesk-pizza-menu",
    version: 1,
    kategorien: doc.categories.map((category) => ({
      name: category.name,
      aktiv: category.active ?? true,
      artikel: category.items.map((item) => ({
        ...(item.number ? { nummer: item.number } : {}),
        name: item.name,
        ...(item.ingredients ? { zutaten: item.ingredients } : {}),
        ...(item.allergens ? { allergene: item.allergens } : {}),
        aktiv: item.active,
        varianten: item.variants.map((variant) => ({
          ...(variant.label ? { bezeichnung: variant.label } : {}),
          preis_eur: yamlPrice(variant.priceCents),
          aktiv: variant.active
        }))
      }))
    })),
    extras: doc.extras.map((extra) => ({
      name: extra.name,
      preis_eur: yamlPrice(extra.priceCents),
      kategorien: extra.categories,
      aktiv: extra.active
    }))
  };
  const header =
    "# Matchdesk Pizza-Menü (YAML). Preise in Euro, Komma oder Punkt.\n" +
    "# Zuordnung beim Import über Kategorie-/Artikelnamen bzw. Artikelnummer.\n";
  return header + stringify(data, { lineWidth: 0 });
}

function yesNo(value: boolean) {
  return value ? "ja" : "nein";
}

export function menuToCsv(doc: Required<MenuDocument>): string {
  const rows: string[][] = [MENU_CSV_HEADER];
  for (const category of doc.categories) {
    for (const item of category.items) {
      const base = [
        category.name,
        item.number ?? "",
        item.name,
        item.ingredients ?? "",
        item.allergens ?? "",
        yesNo(item.active !== false)
      ];
      if (item.variants.length === 0) {
        rows.push([...base, "", "", ""]);
        continue;
      }
      for (const variant of item.variants) {
        rows.push([...base, variant.label ?? "", formatPriceCsv(variant.priceCents), yesNo(variant.active)]);
      }
    }
  }
  return toCsv(rows);
}

export function extrasToCsv(doc: Required<MenuDocument>): string {
  const rows: string[][] = [EXTRAS_CSV_HEADER];
  for (const extra of doc.extras) {
    rows.push([extra.name, formatPriceCsv(extra.priceCents), extra.categories.join("|"), yesNo(extra.active)]);
  }
  return toCsv(rows);
}

// --- Parser: YAML --------------------------------------------------------------------------------

const textOrNumber = z.union([z.string(), z.number()]).transform((value) => String(value).trim());
const optionalText = (max: number) =>
  z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((value) => emptyToNull(value === null || value === undefined ? null : String(value)))
    .pipe(z.string().max(max).nullable());
const priceInput = z.union([z.number(), z.string()]);

// strictObject: Unbekannte Schlüssel (Tippfehler wie `artikl:`) sind ein Fehler, statt still
// ignoriert zu werden und dabei Artikel zu deaktivieren.
const yamlVariantSchema = z.strictObject({
  bezeichnung: optionalText(32),
  preis_eur: priceInput,
  aktiv: z.boolean().optional()
});

const yamlItemSchema = z.strictObject({
  nummer: optionalText(16),
  name: textOrNumber.pipe(z.string().min(1).max(120)),
  zutaten: optionalText(500),
  allergene: optionalText(120),
  aktiv: z.boolean().optional(),
  varianten: z.array(yamlVariantSchema).max(MAX_VARIANTS_PER_ITEM).optional()
});

const yamlCategorySchema = z.strictObject({
  name: textOrNumber.pipe(z.string().min(1).max(PIZZA_CATEGORY_NAME_MAX_LEN)),
  aktiv: z.boolean().optional(),
  artikel: z.array(yamlItemSchema).max(MAX_ITEMS).optional()
});

const yamlExtraSchema = z.strictObject({
  name: textOrNumber.pipe(z.string().min(1).max(PIZZA_EXTRA_NAME_MAX_LEN)),
  preis_eur: priceInput,
  kategorien: z.array(textOrNumber.pipe(z.string().min(1).max(PIZZA_CATEGORY_NAME_MAX_LEN))).max(MAX_CATEGORIES).optional(),
  aktiv: z.boolean().optional()
});

const yamlDocumentSchema = z.strictObject({
  // "hermes-pizza-menu": Exporte vor der Umbenennung bleiben importierbar.
  format: z.enum(["matchdesk-pizza-menu", "hermes-pizza-menu"]).optional(),
  version: z.literal(1).optional(),
  kategorien: z.array(yamlCategorySchema).max(MAX_CATEGORIES).optional(),
  extras: z.array(yamlExtraSchema).max(MAX_EXTRAS).optional()
});

function lineOfPath(
  document: ReturnType<typeof parseDocument>,
  counter: LineCounter,
  path: ReadonlyArray<PropertyKey>
): number | null {
  for (let length = path.length; length >= 0; length -= 1) {
    const node = document.getIn(path.slice(0, length) as Array<string | number>, true) as Node | undefined;
    if (node && typeof node === "object" && "range" in node && node.range) {
      return counter.linePos(node.range[0]).line;
    }
  }
  return null;
}

export function parseMenuYaml(text: string): { doc: MenuDocument; errors: TransferIssue[] } {
  const counter = new LineCounter();
  const document = parseDocument(text, { lineCounter: counter, prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    return {
      doc: {},
      errors: document.errors.slice(0, 20).map((error) => ({
        line: error.linePos?.[0]?.line ?? null,
        code: "yaml_syntax",
        params: { message: error.message.split("\n")[0].slice(0, 200) }
      }))
    };
  }
  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 50 });
  } catch {
    return { doc: {}, errors: [{ line: null, code: "yaml_syntax", params: { message: "alias" } }] };
  }
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return { doc: {}, errors: [{ line: 1, code: "empty" }] };
  }
  const parsed = yamlDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      doc: {},
      errors: parsed.error.issues.slice(0, 20).map((issue) =>
        issue.code === "unrecognized_keys"
          ? {
              line: lineOfPath(document, counter, [...issue.path, issue.keys[0]]),
              code: "unknown_field",
              params: { field: issue.keys.join(", ") }
            }
          : {
              line: lineOfPath(document, counter, issue.path),
              code: "invalid_field",
              params: { field: String([...issue.path].reverse().find((part) => typeof part === "string") ?? "") }
            }
      )
    };
  }

  const errors: TransferIssue[] = [];
  const data = parsed.data;
  const doc: MenuDocument = { deactivateMissingCategories: true };
  if (data.kategorien) {
    doc.categories = data.kategorien.map((category, categoryIndex) => ({
      name: category.name,
      active: category.aktiv ?? true,
      line: lineOfPath(document, counter, ["kategorien", categoryIndex]),
      items: (category.artikel ?? []).map((item, itemIndex) => {
        const itemPath = ["kategorien", categoryIndex, "artikel", itemIndex];
        return {
          number: item.nummer,
          name: item.name,
          ingredients: item.zutaten,
          allergens: item.allergene,
          active: item.aktiv ?? true,
          line: lineOfPath(document, counter, itemPath),
          variants: (item.varianten ?? []).map((variant, variantIndex) => {
            const variantPath = [...itemPath, "varianten", variantIndex];
            const priceCents = parsePriceToCents(variant.preis_eur);
            if (priceCents === null) {
              errors.push({
                line: lineOfPath(document, counter, [...variantPath, "preis_eur"]),
                code: "invalid_price",
                params: { value: String(variant.preis_eur) }
              });
            }
            return {
              label: variant.bezeichnung,
              priceCents: priceCents ?? 0,
              active: variant.aktiv ?? true,
              line: lineOfPath(document, counter, variantPath)
            };
          })
        };
      })
    }));
  }
  if (data.extras) {
    doc.extras = data.extras.map((extra, index) => {
      const priceCents = parsePriceToCents(extra.preis_eur);
      if (priceCents === null) {
        errors.push({
          line: lineOfPath(document, counter, ["extras", index, "preis_eur"]),
          code: "invalid_price",
          params: { value: String(extra.preis_eur) }
        });
      }
      return {
        name: extra.name,
        priceCents: priceCents ?? 0,
        categories: extra.kategorien ?? [],
        active: extra.aktiv ?? true,
        line: lineOfPath(document, counter, ["extras", index])
      };
    });
  }
  if (!doc.categories && !doc.extras) errors.push({ line: 1, code: "empty" });
  return { doc, errors };
}

// --- Parser: CSV ---------------------------------------------------------------------------------

interface CsvTable {
  rows: Array<{ line: number; cells: string[] }>;
  errors: TransferIssue[];
  /** Index der erkannten Kopfzeile in `headers`. */
  headerIndex?: number;
}

function readCsvTable(text: string, headers: string[][]): CsvTable {
  const errors: TransferIssue[] = [];
  const parsed = parseCsv(text);
  if (!parsed.ok) {
    return { rows: [], errors: [{ line: parsed.line, code: "csv_quote" }] };
  }
  const nonEmpty = parsed.rows.filter((row) => row.cells.some((cell) => cell.trim() !== ""));
  if (nonEmpty.length === 0) return { rows: [], errors: [{ line: 1, code: "empty" }] };
  const [head, ...rows] = nonEmpty;
  const normalizedHead = head.cells.map((cell) => cell.trim().toLowerCase());
  while (normalizedHead.length > 0 && normalizedHead.at(-1) === "") normalizedHead.pop();
  // Unbekannte oder fehlende Spalten sind ein Fehler (keine stille Zuordnung).
  const headerIndex = headers.findIndex((candidate) => candidate.join(";") === normalizedHead.join(";"));
  if (headerIndex === -1) {
    if (normalizedHead.length === 1 && /[,\t]/.test(normalizedHead[0])) {
      return { rows: [], errors: [{ line: head.line, code: "csv_delimiter" }] };
    }
    return { rows: [], errors: [{ line: head.line, code: "csv_header", params: { expected: headers[0].join(";") } }] };
  }
  const header = headers[headerIndex];
  if (rows.length > MAX_CSV_ROWS) {
    return { rows: [], errors: [{ line: null, code: "too_many_rows", params: { max: MAX_CSV_ROWS } }] };
  }
  const result: Array<{ line: number; cells: string[] }> = [];
  for (const row of rows) {
    const cells = [...row.cells];
    while (cells.length > header.length && cells.at(-1)?.trim() === "") cells.pop();
    if (cells.length !== header.length) {
      errors.push({ line: row.line, code: "csv_columns", params: { expected: header.length, actual: cells.length } });
      continue;
    }
    result.push({ line: row.line, cells: cells.map((cell) => unguardCell(cell.trim())) });
  }
  return { rows: result, errors, headerIndex };
}

const csvMenuRowSchema = z.object({
  kategorie: z.string().min(1).max(PIZZA_CATEGORY_NAME_MAX_LEN),
  nummer: z.string().max(16),
  artikel: z.string().min(1).max(120),
  zutaten: z.string().max(500),
  allergene: z.string().max(120),
  variante: z.string().max(32)
});

export function parseMenuCsv(text: string): { doc: MenuDocument; errors: TransferIssue[] } {
  const { rows, errors, headerIndex } = readCsvTable(text, [MENU_CSV_HEADER, LEGACY_MENU_CSV_HEADER]);
  const legacy = headerIndex === 1;
  const categories: DocCategory[] = [];
  const categoryByKey = new Map<string, DocCategory>();
  const itemByKey = new Map<string, { item: DocItem; category: DocCategory; hadEmptyVariant: boolean }>();

  for (const { line, cells } of rows) {
    const [kategorie, nummer, artikel, zutaten, allergene] = cells;
    const [itemAktiv, variante, preis, variantAktiv] = legacy
      ? [null, cells[5], cells[6], cells[7]]
      : [cells[5], cells[6], cells[7], cells[8]];
    const checked = csvMenuRowSchema.safeParse({ kategorie, nummer, artikel, zutaten, allergene, variante });
    if (!checked.success) {
      for (const issue of checked.error.issues.slice(0, 3)) {
        errors.push({ line, code: issue.code === "too_small" ? "required" : "invalid_field", params: { field: String(issue.path[0]) } });
      }
      continue;
    }
    const emptyVariant = variante === "" && preis === "";
    const active = parseActiveFlag(variantAktiv);
    if (active === null) {
      errors.push({ line, code: "invalid_active", params: { value: variantAktiv } });
      continue;
    }
    const itemActive = itemAktiv === null ? undefined : parseActiveFlag(itemAktiv);
    if (itemActive === null) {
      errors.push({ line, code: "invalid_active", params: { value: itemAktiv ?? "" } });
      continue;
    }
    const priceCents = emptyVariant ? 0 : parsePriceToCents(preis);
    if (priceCents === null) {
      errors.push({ line, code: "invalid_price", params: { value: preis } });
      continue;
    }

    const categoryKey = nameKey(kategorie);
    let category = categoryByKey.get(categoryKey);
    if (!category) {
      category = { name: kategorie, active: undefined, line, items: [] };
      categoryByKey.set(categoryKey, category);
      categories.push(category);
    }

    const itemKey = nummer ? `#${nameKey(nummer)}` : `${categoryKey}|${nameKey(artikel)}`;
    const fields = { number: emptyToNull(nummer), name: artikel, ingredients: emptyToNull(zutaten), allergens: emptyToNull(allergene) };
    const existing = itemByKey.get(itemKey);
    if (existing) {
      if (existing.category !== category) {
        errors.push({ line, code: "duplicate_number", params: { number: nummer } });
        continue;
      }
      const conflict = (Object.keys(fields) as Array<keyof typeof fields>).find(
        (field) => (existing.item[field] ?? "") !== (fields[field] ?? "")
      );
      if (conflict) {
        errors.push({ line, code: "item_conflict", params: { name: artikel, field: conflict } });
        continue;
      }
      if (existing.item.active !== itemActive) {
        errors.push({ line, code: "item_conflict", params: { name: artikel, field: "artikel_aktiv" } });
        continue;
      }
      if (emptyVariant || existing.hadEmptyVariant) {
        errors.push({ line, code: "invalid_price", params: { value: preis } });
        continue;
      }
      existing.item.activeIfNew = existing.item.activeIfNew || active;
      existing.item.variants.push({ label: emptyToNull(variante), priceCents, active, line });
      continue;
    }
    const item: DocItem = {
      ...fields,
      // Altes Format: Artikel-Status bestehender Artikel bleibt; neue sind aktiv, wenn eine Zeile aktiv ist.
      active: itemActive,
      activeIfNew: emptyVariant ? true : active,
      line,
      variants: emptyVariant ? [] : [{ label: emptyToNull(variante), priceCents, active, line }]
    };
    itemByKey.set(itemKey, { item, category, hadEmptyVariant: emptyVariant });
    category.items.push(item);
  }
  if (rows.length === 0 && errors.length === 0) errors.push({ line: 1, code: "empty" });
  return { doc: { categories, deactivateMissingCategories: false }, errors };
}

export function parseExtrasCsv(text: string): { doc: MenuDocument; errors: TransferIssue[] } {
  const { rows, errors } = readCsvTable(text, [EXTRAS_CSV_HEADER]);
  const extras: DocExtra[] = [];
  for (const { line, cells } of rows) {
    const [name, preis, kategorien, aktiv] = cells;
    if (!name || name.length > PIZZA_EXTRA_NAME_MAX_LEN) {
      errors.push({ line, code: name ? "invalid_field" : "required", params: { field: "extra" } });
      continue;
    }
    const priceCents = parsePriceToCents(preis);
    if (priceCents === null) {
      errors.push({ line, code: "invalid_price", params: { value: preis } });
      continue;
    }
    const active = parseActiveFlag(aktiv);
    if (active === null) {
      errors.push({ line, code: "invalid_active", params: { value: aktiv } });
      continue;
    }
    const categories = kategorien
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean);
    if (categories.some((category) => category.length > PIZZA_CATEGORY_NAME_MAX_LEN)) {
      errors.push({ line, code: "invalid_field", params: { field: "kategorien" } });
      continue;
    }
    extras.push({ name, priceCents, categories, active, line });
  }
  if (extras.length > MAX_EXTRAS) errors.push({ line: null, code: "too_many_rows", params: { max: MAX_EXTRAS } });
  if (rows.length === 0 && errors.length === 0) errors.push({ line: 1, code: "empty" });
  return { doc: { extras }, errors };
}

export function parseMenuTransfer(format: MenuTransferFormat, text: string) {
  if (text.length > MENU_TRANSFER_MAX_CHARS) {
    return { doc: {} as MenuDocument, errors: [{ line: null, code: "too_large" } as TransferIssue] };
  }
  if (format === "yaml") return parseMenuYaml(text);
  if (format === "csv") return parseMenuCsv(text);
  return parseExtrasCsv(text);
}

// --- Abgleich mit der Datenbank ------------------------------------------------------------------

function emptyCounts(): TransferCounts {
  return { new: 0, changed: 0, unchanged: 0, removed: 0 };
}

/** Namensvergleich wie SQLite `ORDER BY name` (BINARY). */
function binaryCompare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function germanCompare(a: string, b: string) {
  return a.localeCompare(b, "de");
}

/**
 * Sortierwerte in Dateireihenfolge: bestehende Werte bleiben, solange sie nicht fallen. Gleiche
 * Werte (z. B. mehrfach 0) bleiben, wenn die Datei sie in der Reihenfolge des Namens-Tiebreaks
 * der Anzeige führt; sonst gibt es den nächsten Wert. So ändert ein unveränderter Export beim
 * Re-Import nichts, und eine geänderte Reihenfolge in der Datei kommt trotzdem an.
 */
function assignSortOrders(
  existing: Array<number | null>,
  names: string[] = [],
  compare?: (a: string, b: string) => number
): number[] {
  let previous: number | null = null;
  let previousName: string | null = null;
  return existing.map((value, index) => {
    const name = names[index] ?? "";
    const tieOk = !compare || previousName === null || compare(previousName, name) <= 0;
    const fits = value !== null && (previous === null || value > previous || (value === previous && tieOk));
    const assigned: number = fits ? value! : (previous ?? 0) + 1;
    previous = assigned;
    previousName = name;
    return assigned;
  });
}

function labelKey(label: string | null) {
  return nameKey(label ?? "");
}

/** Prüfungen, die nur das Dokument betreffen (Dubletten, unbekannte Kategorien bei Extras). */
function validateDocument(context: DatabaseContext, doc: MenuDocument): TransferIssue[] {
  const errors: TransferIssue[] = [];
  if (doc.categories) {
    const seenCategories = new Set<string>();
    const seenNumbers = new Set<string>();
    let itemCount = 0;
    for (const category of doc.categories) {
      const key = nameKey(category.name);
      if (seenCategories.has(key)) errors.push({ line: category.line, code: "duplicate_category", params: { name: category.name } });
      seenCategories.add(key);
      const seenNames = new Set<string>();
      for (const item of category.items) {
        itemCount += 1;
        if (item.number) {
          const numberKey = nameKey(item.number);
          if (seenNumbers.has(numberKey)) errors.push({ line: item.line, code: "duplicate_number", params: { number: item.number } });
          seenNumbers.add(numberKey);
        } else {
          const itemKey = nameKey(item.name);
          if (seenNames.has(itemKey)) errors.push({ line: item.line, code: "duplicate_item", params: { name: item.name } });
          seenNames.add(itemKey);
        }
        if (item.variants.length > MAX_VARIANTS_PER_ITEM) {
          errors.push({ line: item.line, code: "too_many_variants", params: { name: item.name, max: MAX_VARIANTS_PER_ITEM } });
        }
        const seenLabels = new Set<string>();
        for (const variant of item.variants) {
          const key = labelKey(variant.label);
          if (seenLabels.has(key)) {
            errors.push({ line: variant.line, code: "duplicate_variant", params: { name: item.name, label: variant.label ?? "" } });
          }
          seenLabels.add(key);
        }
      }
    }
    if (doc.categories.length > MAX_CATEGORIES || itemCount > MAX_ITEMS) {
      errors.push({ line: null, code: "too_many_rows", params: { max: MAX_ITEMS } });
    }
  }
  if (doc.extras) {
    const known = new Set(
      (doc.categories ? doc.categories.map((category) => category.name) : listCategories(context).map((category) => category.name)).map(
        nameKey
      )
    );
    const seenExtras = new Set<string>();
    for (const extra of doc.extras) {
      const key = nameKey(extra.name);
      if (seenExtras.has(key)) errors.push({ line: extra.line, code: "duplicate_extra", params: { name: extra.name } });
      seenExtras.add(key);
      for (const category of extra.categories) {
        if (!known.has(nameKey(category))) errors.push({ line: extra.line, code: "unknown_category", params: { name: category } });
      }
    }
  }
  return errors;
}

/**
 * Gleicht das Dokument mit der Datenbank ab. Mit `apply = false` wird nur gezählt (Vorschau),
 * mit `apply = true` wird geschrieben; der Aufrufer stellt die Transaktion.
 */
function reconcile(context: DatabaseContext, doc: MenuDocument, apply: boolean) {
  const counts = { categories: emptyCounts(), items: emptyCounts(), variants: emptyCounts(), extras: emptyCounts() };
  const now = new Date().toISOString();
  const dbCategories = listCategories(context);
  const categoryIdByKey = new Map(dbCategories.map((category) => [nameKey(category.name), category.id]));

  if (doc.categories) {
    const matchedCategories = new Set<string>();
    const dbItems = listAllMenu(context);
    const matchedItems = new Set<string>();
    const categorySorts = assignSortOrders(
      doc.categories.map((category) => {
        const id = categoryIdByKey.get(nameKey(category.name));
        return id ? (dbCategories.find((row) => row.id === id)?.sortOrder ?? null) : null;
      }),
      doc.categories.map((category) => category.name),
      binaryCompare
    );

    doc.categories.forEach((docCategory, categoryIndex) => {
      const existing = dbCategories.find((row) => row.id === categoryIdByKey.get(nameKey(docCategory.name)));
      const sortOrder = categorySorts[categoryIndex];
      let categoryId: string;
      if (existing) {
        categoryId = existing.id;
        matchedCategories.add(existing.id);
        const active = docCategory.active ?? existing.active;
        const changed = existing.name !== docCategory.name || existing.active !== active || existing.sortOrder !== sortOrder;
        counts.categories[changed ? "changed" : "unchanged"] += 1;
        if (apply && changed) {
          context.db
            .update(pizzaMenuCategories)
            .set({ name: docCategory.name, active, sortOrder, updatedAt: now })
            .where(eq(pizzaMenuCategories.id, existing.id))
            .run();
        }
      } else {
        categoryId = randomUUID();
        categoryIdByKey.set(nameKey(docCategory.name), categoryId);
        counts.categories.new += 1;
        if (apply) {
          context.db
            .insert(pizzaMenuCategories)
            .values({ id: categoryId, name: docCategory.name, active: docCategory.active ?? true, sortOrder, createdAt: now, updatedAt: now })
            .run();
        }
      }

      // Artikel: zuerst über die Nummer, sonst über den Namen; jeweils bevorzugt in derselben Kategorie.
      const resolved = docCategory.items.map((docItem) => {
        const free = dbItems.filter((row) => !matchedItems.has(row.id));
        const prefer = (rows: typeof free) => rows.find((row) => row.categoryId === categoryId) ?? rows[0];
        const byNumber = docItem.number
          ? prefer(free.filter((row) => row.number && nameKey(row.number) === nameKey(docItem.number!)))
          : undefined;
        const match = byNumber ?? prefer(free.filter((row) => nameKey(row.name) === nameKey(docItem.name)));
        if (match) matchedItems.add(match.id);
        return { docItem, match };
      });
      const itemSorts = assignSortOrders(
        resolved.map(({ match }) => (match && match.categoryId === categoryId ? match.sortOrder : null)),
        resolved.map(({ docItem }) => docItem.name),
        germanCompare
      );

      resolved.forEach(({ docItem, match }, itemIndex) => {
        const sortOrder = itemSorts[itemIndex];
        // Artikel-Status nur aus der Datei, wenn sie ihn enthält; Varianten nie wegen des Artikels anfassen.
        const itemActive = docItem.active ?? match?.active ?? docItem.activeIfNew ?? true;
        let itemId: string;
        if (match) {
          itemId = match.id;
          const changed =
            match.number !== docItem.number ||
            match.name !== docItem.name ||
            match.ingredients !== docItem.ingredients ||
            match.allergens !== docItem.allergens ||
            match.active !== itemActive ||
            match.categoryId !== categoryId ||
            match.sortOrder !== sortOrder;
          counts.items[changed ? "changed" : "unchanged"] += 1;
          if (apply && changed) {
            context.db
              .update(pizzaMenuItems)
              .set({
                number: docItem.number,
                name: docItem.name,
                ingredients: docItem.ingredients,
                allergens: docItem.allergens,
                active: itemActive,
                categoryId,
                sortOrder,
                updatedAt: now
              })
              .where(eq(pizzaMenuItems.id, match.id))
              .run();
          }
        } else {
          itemId = randomUUID();
          counts.items.new += 1;
          if (apply) {
            context.db
              .insert(pizzaMenuItems)
              .values({
                id: itemId,
                number: docItem.number,
                name: docItem.name,
                ingredients: docItem.ingredients,
                allergens: docItem.allergens,
                active: itemActive,
                categoryId,
                sortOrder,
                createdAt: now,
                updatedAt: now
              })
              .run();
          }
        }

        // Varianten: über die Bezeichnung (leer = Standard).
        const dbVariants = match?.variants ?? [];
        const matchedVariants = new Set<string>();
        const variantMatches = docItem.variants.map((docVariant) => {
          const found = dbVariants.find(
            (row) => !matchedVariants.has(row.id) && labelKey(row.sizeLabel) === labelKey(docVariant.label)
          );
          if (found) matchedVariants.add(found.id);
          return found;
        });
        const variantSorts = assignSortOrders(variantMatches.map((found) => found?.sortOrder ?? null));
        docItem.variants.forEach((docVariant, variantIndex) => {
          const found = variantMatches[variantIndex];
          const sortOrder = variantSorts[variantIndex];
          if (found) {
            const changed =
              found.sizeLabel !== docVariant.label ||
              found.priceCents !== docVariant.priceCents ||
              found.active !== docVariant.active ||
              found.sortOrder !== sortOrder;
            counts.variants[changed ? "changed" : "unchanged"] += 1;
            if (apply && changed) {
              // Bestehende Bestellzeilen behalten ihren priceCentsSnapshot.
              context.db
                .update(pizzaMenuVariants)
                .set({ sizeLabel: docVariant.label, priceCents: docVariant.priceCents, active: docVariant.active, sortOrder })
                .where(eq(pizzaMenuVariants.id, found.id))
                .run();
            }
          } else {
            counts.variants.new += 1;
            if (apply) {
              context.db
                .insert(pizzaMenuVariants)
                .values({
                  id: randomUUID(),
                  itemId,
                  sizeLabel: docVariant.label,
                  priceCents: docVariant.priceCents,
                  active: docVariant.active,
                  sortOrder
                })
                .run();
            }
          }
        });
        for (const dbVariant of dbVariants) {
          if (matchedVariants.has(dbVariant.id)) continue;
          if (apply) {
            // Bestellte Varianten nur deaktivieren (FK RESTRICT), unbestellte löschen.
            const result = removeVariant(context, dbVariant.id);
            if (result === "deleted" || dbVariant.active) counts.variants.removed += 1;
          } else if (dbVariant.active || !hasOrderLines(context, dbVariant.id)) {
            counts.variants.removed += 1;
          }
        }
      });
    });

    // Nicht mehr enthaltene Artikel und Kategorien deaktivieren (Varianten bleiben unverändert).
    for (const dbItem of dbItems) {
      if (matchedItems.has(dbItem.id) || !dbItem.active) continue;
      counts.items.removed += 1;
      if (apply) {
        context.db.update(pizzaMenuItems).set({ active: false, updatedAt: now }).where(eq(pizzaMenuItems.id, dbItem.id)).run();
      }
    }
    for (const dbCategory of dbCategories) {
      if (!doc.deactivateMissingCategories) break;
      if (matchedCategories.has(dbCategory.id) || !dbCategory.active) continue;
      counts.categories.removed += 1;
      if (apply) {
        context.db
          .update(pizzaMenuCategories)
          .set({ active: false, updatedAt: now })
          .where(eq(pizzaMenuCategories.id, dbCategory.id))
          .run();
      }
    }
  }

  if (doc.extras) {
    const dbExtras = listExtras(context);
    const matched = new Set<string>();
    const resolved = doc.extras.map((docExtra) => {
      const found = dbExtras.find((row) => !matched.has(row.id) && nameKey(row.name) === nameKey(docExtra.name));
      if (found) matched.add(found.id);
      return found;
    });
    const sorts = assignSortOrders(
      resolved.map((found) => found?.sortOrder ?? null),
      doc.extras.map((extra) => extra.name),
      binaryCompare
    );
    doc.extras.forEach((docExtra, index) => {
      const found = resolved[index];
      const sortOrder = sorts[index];
      // Neue Kategorien derselben Datei haben in der Vorschau noch keine ID; der Schlüssel genügt.
      const categoryIds = [
        ...new Set(docExtra.categories.map((name) => categoryIdByKey.get(nameKey(name)) ?? `new:${nameKey(name)}`))
      ].sort();
      let extraId: string;
      if (found) {
        extraId = found.id;
        const changed =
          found.name !== docExtra.name ||
          found.priceCents !== docExtra.priceCents ||
          found.active !== docExtra.active ||
          found.sortOrder !== sortOrder ||
          found.categoryIds.join(",") !== categoryIds.join(",");
        counts.extras[changed ? "changed" : "unchanged"] += 1;
        if (!apply || !changed) return;
        context.db
          .update(pizzaMenuExtras)
          .set({ name: docExtra.name, priceCents: docExtra.priceCents, active: docExtra.active, sortOrder, updatedAt: now })
          .where(eq(pizzaMenuExtras.id, found.id))
          .run();
        context.db.delete(pizzaMenuExtraCategories).where(eq(pizzaMenuExtraCategories.extraId, found.id)).run();
      } else {
        extraId = randomUUID();
        counts.extras.new += 1;
        if (!apply) return;
        context.db
          .insert(pizzaMenuExtras)
          .values({ id: extraId, name: docExtra.name, priceCents: docExtra.priceCents, active: docExtra.active, sortOrder, createdAt: now, updatedAt: now })
          .run();
      }
      for (const categoryId of categoryIds) {
        context.db.insert(pizzaMenuExtraCategories).values({ extraId, categoryId }).run();
      }
    });
    for (const dbExtra of dbExtras) {
      if (matched.has(dbExtra.id)) continue;
      if (apply) {
        const result = removeExtra(context, dbExtra.id);
        if (result === "deleted" || dbExtra.active) counts.extras.removed += 1;
      } else if (dbExtra.active || !extraHasOrders(context, dbExtra.id)) {
        counts.extras.removed += 1;
      }
    }
  }
  return counts;
}

function hasOrderLines(context: DatabaseContext, variantId: string) {
  return Boolean(context.sqlite.prepare("SELECT 1 FROM pizza_order_lines WHERE variant_id = ? LIMIT 1").get(variantId));
}

function extraHasOrders(context: DatabaseContext, extraId: string) {
  return Boolean(context.sqlite.prepare("SELECT 1 FROM pizza_order_line_extras WHERE extra_id = ? LIMIT 1").get(extraId));
}

function sortIssues(errors: TransferIssue[]) {
  return [...errors].sort((a, b) => (a.line ?? 0) - (b.line ?? 0)).slice(0, 50);
}

/** Fingerabdruck des gesamten Menüs (Kategorien, Artikel, Varianten, Extras). */
export function menuVersion(context: DatabaseContext): string {
  const snapshot = JSON.stringify({ c: listCategories(context), i: listAllMenu(context), e: listExtras(context) });
  return createHash("sha256").update(snapshot).digest("hex").slice(0, 16);
}

/** Warnung, wenn ein Import viele Einträge entfernen würde (vermutlich eine Teil-Datei). */
function removalWarnings(counts: TransferResult["counts"]): TransferIssue[] {
  const warnings: TransferIssue[] = [];
  for (const kind of ["categories", "items", "variants", "extras"] as const) {
    const { changed, unchanged, removed } = counts[kind];
    const total = changed + unchanged + removed;
    if (removed > REMOVAL_WARN_COUNT || (total > 0 && removed / total > REMOVAL_WARN_SHARE)) {
      warnings.push({ line: null, code: "many_removed", params: { kind, count: removed, total } });
    }
  }
  return warnings;
}

/** Vorschau: zählt neue, geänderte und unveränderte Einträge und meldet Fehler mit Zeilennummer. */
export function previewMenuTransfer(context: DatabaseContext, format: MenuTransferFormat, text: string): TransferResult {
  const { doc, errors } = parseMenuTransfer(format, text);
  const allErrors = errors.length > 0 ? errors : validateDocument(context, doc);
  const counts =
    allErrors.length > 0
      ? { categories: emptyCounts(), items: emptyCounts(), variants: emptyCounts(), extras: emptyCounts() }
      : reconcile(context, doc, false);
  return {
    format,
    sections: { menu: Boolean(doc.categories), extras: Boolean(doc.extras) },
    counts,
    errors: sortIssues(allErrors),
    warnings: allErrors.length > 0 ? [] : removalWarnings(counts),
    menuVersion: menuVersion(context)
  };
}

export interface ApplyMenuTransferOptions {
  /** `menuVersion` der Vorschau; weicht das Menü inzwischen ab, wird nichts übernommen. */
  expectedVersion?: string;
  /** Bestätigung für Warnungen (viele Entfernungen). */
  confirmRemovals?: boolean;
}

export type ApplyMenuTransferOutcome = "applied" | "errors" | "stale" | "confirm";

/** Übernehmen: parst und prüft erneut und schreibt alles in einer Transaktion (oder gar nichts). */
export function applyMenuTransfer(
  context: DatabaseContext,
  format: MenuTransferFormat,
  text: string,
  options: ApplyMenuTransferOptions = {}
): { outcome: ApplyMenuTransferOutcome; result: TransferResult } {
  return context.sqlite.transaction(() => {
    const preview = previewMenuTransfer(context, format, text);
    if (preview.errors.length > 0) return { outcome: "errors" as const, result: preview };
    if (options.expectedVersion && options.expectedVersion !== preview.menuVersion) {
      return { outcome: "stale" as const, result: preview };
    }
    if (preview.warnings.length > 0 && !options.confirmRemovals) {
      return { outcome: "confirm" as const, result: preview };
    }
    const { doc } = parseMenuTransfer(format, text);
    const counts = reconcile(context, doc, true);
    return { outcome: "applied" as const, result: { ...preview, counts, menuVersion: menuVersion(context) } };
  })();
}
