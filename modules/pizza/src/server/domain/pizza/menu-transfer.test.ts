import path from "node:path";
import { createTestDatabase } from "@matchdesk/module-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseContext, type DatabaseContext } from "../../db/client";
import { csvCell, parseCsv, unguardCell, UTF8_BOM } from "./csv";
import { listExtras, upsertExtra } from "./extras";
import { listAllMenu, setItemActive, setVariantActive, upsertItem, upsertVariant } from "./menu";
import {
  applyMenuTransfer,
  buildMenuDocument,
  extrasToCsv,
  menuToCsv,
  menuToYaml,
  parseMenuYaml,
  parsePriceToCents,
  previewMenuTransfer
} from "./menu-transfer";
import { listCategories, upsertCategory } from "./categories";

let context: DatabaseContext;

beforeEach(() => {
  context = createDatabaseContext(createTestDatabase(path.resolve(import.meta.dirname, "../../../..")));
});

afterEach(() => {
  context.sqlite.close();
});

const ts = "2026-10-01T18:00:00.000Z";

function seedOrderFor(variantId: string, priceCents: number) {
  context.sqlite
    .prepare("INSERT INTO users (id, phone_number, username, email, role, created_at, updated_at) VALUES ('u1', '+49', 'gast', 'g@example.test', 'user', ?, ?)")
    .run(ts, ts);
  context.sqlite.prepare("INSERT INTO pizza_sessions (id, state, created_at, updated_at) VALUES ('s1', 'open', ?, ?)").run(ts, ts);
  context.sqlite
    .prepare("INSERT INTO pizza_orders (id, session_id, user_id, payment_status, created_at, updated_at) VALUES ('o1', 's1', 'u1', 'unpaid', ?, ?)")
    .run(ts, ts);
  context.sqlite
    .prepare("INSERT INTO pizza_order_lines (id, order_id, variant_id, qty, price_cents_snapshot, created_at) VALUES ('l1', 'o1', ?, 2, ?, ?)")
    .run(variantId, priceCents, ts);
}

function variantCount() {
  return listAllMenu(context).reduce((sum, item) => sum + item.variants.length, 0);
}

describe("Preise und CSV-Grundlagen", () => {
  it("akzeptiert Komma und Punkt", () => {
    expect(parsePriceToCents("1,50")).toBe(150);
    expect(parsePriceToCents("1.5")).toBe(150);
    expect(parsePriceToCents("12")).toBe(1200);
    expect(parsePriceToCents(" 7,00 € ")).toBe(700);
    expect(parsePriceToCents(4.5)).toBe(450);
    expect(parsePriceToCents("1,234")).toBeNull();
    expect(parsePriceToCents("-1")).toBeNull();
    expect(parsePriceToCents("abc")).toBeNull();
    expect(parsePriceToCents("1.000,00")).toBeNull();
    expect(parsePriceToCents("1001")).toBeNull();
  });

  it("entschärft Formeln beim Export und stellt sie beim Import wieder her", () => {
    for (const value of ["=SUMME(A1)", "+49 123", "-Spezial", "@cmd", "\tTab"]) {
      expect(csvCell(value).replace(/^"/, "").startsWith("'")).toBe(true);
      expect(unguardCell(`'${value}`)).toBe(value);
    }
    expect(csvCell("Käse; Schinken")).toBe('"Käse; Schinken"');
    expect(csvCell('sagt "hallo"')).toBe('"sagt ""hallo"""');
    expect(csvCell("normal")).toBe("normal");
    expect(unguardCell("'normal")).toBe("'normal");
  });

  it("parst Anführungszeichen, Zeilenumbrüche, BOM und CRLF mit Zeilennummern", () => {
    const parsed = parseCsv(`${UTF8_BOM}a;b\r\n"x;1";"zwei\r\nZeilen"\r\nc;d\r\n`);
    expect(parsed).toEqual({
      ok: true,
      rows: [
        { line: 1, cells: ["a", "b"] },
        { line: 2, cells: ["x;1", "zwei\r\nZeilen"] },
        { line: 4, cells: ["c", "d"] }
      ]
    });
    expect(parseCsv('a;"offen\nb')).toEqual({ ok: false, line: 1 });
  });
});

describe("Export und Roundtrip", () => {
  it("exportiert YAML und CSV, deren Re-Import nichts ändert (inkl. Umlaute und Formeln)", () => {
    upsertExtra(context, { name: "extra Käse", priceCents: 150, categoryIds: ["cat-pizza", "cat-pasta"] });
    upsertExtra(context, { name: "Knoblauchöl", priceCents: 50, categoryIds: ["cat-pizza"], active: false });
    const itemId = upsertItem(context, {
      number: "=99",
      name: "-Spezial @Haus",
      ingredients: "Tomaten; Käse, \"scharf\"",
      allergens: "1,AC",
      categoryId: "cat-pizza",
      sortOrder: 200
    });
    upsertVariant(context, { itemId, sizeLabel: "30cm", priceCents: 1050, sortOrder: 1 });

    const doc = buildMenuDocument(context);
    const yaml = menuToYaml(doc);
    expect(yaml).toContain("kategorien:");
    expect(yaml).toContain("preis_eur: 4.00");
    expect(yaml).toContain("Käse");

    const yamlPreview = previewMenuTransfer(context, "yaml", yaml);
    expect(yamlPreview.errors).toEqual([]);
    expect(yamlPreview.counts.categories).toEqual({ new: 0, changed: 0, unchanged: 2, removed: 0 });
    expect(yamlPreview.counts.items).toEqual({ new: 0, changed: 0, unchanged: 91, removed: 0 });
    expect(yamlPreview.counts.variants).toEqual({ new: 0, changed: 0, unchanged: variantCount(), removed: 0 });
    expect(yamlPreview.counts.extras).toEqual({ new: 0, changed: 0, unchanged: 2, removed: 0 });

    const csv = menuToCsv(doc);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv.split("\r\n")[0]).toBe(`${UTF8_BOM}kategorie;nummer;artikel;zutaten;allergene;artikel_aktiv;variante;preis_eur;variante_aktiv`);
    expect(csv).toContain("Pizza;01;Margherita;Tomatensauce & Oregano belegt mit Käse;1,AC;ja;24cm;4,00;ja");
    // Formel-Injection: Zellen mit = + - @ beginnen mit '
    expect(csv).toContain(`Pizza;'=99;'-Spezial @Haus;"Tomaten; Käse, ""scharf""";1,AC;ja;30cm;10,50;ja`);
    const csvPreview = previewMenuTransfer(context, "csv", csv);
    expect(csvPreview.errors).toEqual([]);
    expect(csvPreview.sections).toEqual({ menu: true, extras: false });
    expect(csvPreview.counts.items).toEqual({ new: 0, changed: 0, unchanged: 91, removed: 0 });
    expect(csvPreview.counts.variants.unchanged).toBe(variantCount());

    const extrasCsv = extrasToCsv(doc);
    expect(extrasCsv).toBe(`${UTF8_BOM}extra;preis_eur;kategorien;aktiv\r\nextra Käse;1,50;Pizza|Pasta;ja\r\nKnoblauchöl;0,50;Pizza;nein\r\n`);
    const extrasPreview = previewMenuTransfer(context, "extras_csv", extrasCsv);
    expect(extrasPreview.errors).toEqual([]);
    expect(extrasPreview.counts.extras).toEqual({ new: 0, changed: 0, unchanged: 2, removed: 0 });

    // Übernehmen eines unveränderten Exports ändert nichts
    const before = JSON.stringify(buildMenuDocument(context));
    applyMenuTransfer(context, "yaml", yaml);
    applyMenuTransfer(context, "csv", csv);
    expect(JSON.stringify(buildMenuDocument(context))).toBe(before);
  });
});

describe("Import", () => {
  it("meldet Fehler mit Zeilennummer und schreibt dann nichts", () => {
    const csv = [
      "kategorie;nummer;artikel;zutaten;allergene;variante;preis_eur;aktiv",
      "Pizza;01;Margherita;;;30cm;7,00;ja",
      "Pizza;02;Cipolla;;;30cm;sieben;ja",
      "Pizza;03;Salame;;;30cm;7.5;vielleicht",
      ";04;Ohne Kategorie;;;;5;ja",
      "Pizza;01;Margherita;;;30cm;8;ja",
      "Pizza;05;Kurz;;;30cm"
    ].join("\n");
    const preview = previewMenuTransfer(context, "csv", csv);
    expect(preview.errors).toEqual([
      { line: 3, code: "invalid_price", params: { value: "sieben" } },
      { line: 4, code: "invalid_active", params: { value: "vielleicht" } },
      { line: 5, code: "required", params: { field: "kategorie" } },
      { line: 7, code: "csv_columns", params: { expected: 8, actual: 6 } }
    ]);
    const result = applyMenuTransfer(context, "csv", csv);
    expect(result.outcome).toBe("errors");
    expect(result.result.errors.length).toBeGreaterThan(0);
    expect(listAllMenu(context).find((item) => item.id === "pi-001")?.variants[1].priceCents).toBe(700);

    const dup = previewMenuTransfer(context, "csv", "kategorie;nummer;artikel;zutaten;allergene;variante;preis_eur;aktiv\nPizza;01;Margherita;;;30cm;7;ja\nPizza;01;Margherita;;;30cm;8;ja");
    expect(dup.errors).toEqual([{ line: 3, code: "duplicate_variant", params: { name: "Margherita", label: "30cm" } }]);
    expect(previewMenuTransfer(context, "csv", "a,b,c\n1,2,3").errors[0].code).toBe("csv_delimiter");
    expect(previewMenuTransfer(context, "csv", "x;y\n1;2").errors[0].code).toBe("csv_header");
  });

  it("meldet YAML-Fehler mit Zeilennummer", () => {
    const yaml = [
      "kategorien:",
      "  - name: Pizza",
      "    artikel:",
      "      - name: Margherita",
      "        varianten:",
      "          - bezeichnung: 30cm",
      "            preis_eur: zehn"
    ].join("\n");
    expect(previewMenuTransfer(context, "yaml", yaml).errors).toEqual([
      { line: 7, code: "invalid_price", params: { value: "zehn" } }
    ]);
    const missing = previewMenuTransfer(context, "yaml", "kategorien:\n  - aktiv: true\n");
    expect(missing.errors[0]).toMatchObject({ line: 2, code: "invalid_field", params: { field: "name" } });
    expect(previewMenuTransfer(context, "yaml", "kategorien: [\n").errors[0].code).toBe("yaml_syntax");
    const unknown = previewMenuTransfer(context, "yaml", "kategorien:\n  - name: Pizza\nextras:\n  - name: Käse\n    preis_eur: 1\n    kategorien: [Pasta]\n");
    expect(unknown.errors).toEqual([{ line: 4, code: "unknown_category", params: { name: "Pasta" } }]);
  });

  it("übernimmt Änderungen: Preise, neue Kategorie, entfernte Artikel und bestellte Varianten", () => {
    seedOrderFor("v-001-30", 700);
    const yaml = [
      "kategorien:",
      "  - name: Salate",
      "    artikel:",
      "      - nummer: S1",
      "        name: Insalata Mista",
      "        zutaten: Blattsalat, Tomaten, Gurken",
      "        varianten:",
      "          - preis_eur: '6,50'",
      "  - name: pizza",
      "    artikel:",
      "      - nummer: '01'",
      "        name: Margherita",
      "        zutaten: Tomatensauce & Oregano belegt mit Käse",
      "        allergene: 1,AC",
      "        varianten:",
      "          - bezeichnung: 24cm",
      "            preis_eur: 4.5",
      "          - bezeichnung: 45cm",
      "            preis_eur: 15",
      "extras:",
      "  - name: extra Schinken",
      "    preis_eur: 1,50",
      "    kategorien: [Pizza]"
    ].join("\n");
    const preview = previewMenuTransfer(context, "yaml", yaml);
    expect(preview.errors).toEqual([]);
    expect(preview.counts.categories).toEqual({ new: 1, changed: 1, unchanged: 0, removed: 1 });
    expect(preview.counts.items).toEqual({ new: 1, changed: 0, unchanged: 1, removed: 89 });
    expect(preview.counts.variants).toEqual({ new: 1, changed: 1, unchanged: 1, removed: 1 });
    expect(preview.counts.extras).toEqual({ new: 1, changed: 0, unchanged: 0, removed: 0 });
    // Vorschau schreibt nichts
    expect(listCategories(context)).toHaveLength(2);

    // 89 entfernte Artikel: Übernehmen verlangt eine Bestätigung und schreibt vorher nichts
    expect(preview.warnings).toEqual([
      { line: null, code: "many_removed", params: { kind: "categories", count: 1, total: 2 } },
      { line: null, code: "many_removed", params: { kind: "items", count: 89, total: 90 } },
      { line: null, code: "many_removed", params: { kind: "variants", count: 1, total: 3 } }
    ]);
    expect(applyMenuTransfer(context, "yaml", yaml).outcome).toBe("confirm");
    expect(listCategories(context)).toHaveLength(2);
    // Menü inzwischen geändert → veraltete Vorschau wird abgelehnt
    expect(applyMenuTransfer(context, "yaml", yaml, { expectedVersion: "veraltet", confirmRemovals: true }).outcome).toBe("stale");
    expect(listCategories(context)).toHaveLength(2);

    const { outcome, result } = applyMenuTransfer(context, "yaml", yaml, {
      expectedVersion: preview.menuVersion,
      confirmRemovals: true
    });
    expect(outcome).toBe("applied");
    expect(result.counts).toEqual(preview.counts);

    const categories = listCategories(context);
    expect(categories.map((category) => [category.name, category.active, category.sortOrder])).toEqual([
      // gleicher Sortierwert, Reihenfolge über den Namen wie in der Datei
      ["Salate", true, 1],
      ["pizza", true, 1],
      ["Pasta", false, 2]
    ]);
    const margherita = listAllMenu(context).find((item) => item.id === "pi-001")!;
    expect(margherita.active).toBe(true);
    expect(margherita.variants.map((variant) => [variant.id, variant.priceCents, variant.active])).toEqual([
      ["v-001-24", 450, true],
      // bestellt → nur deaktiviert, Preis unverändert
      ["v-001-30", 700, false],
      ["v-001-45", 1500, true]
    ]);
    expect(listAllMenu(context).find((item) => item.id === "pi-002")?.active).toBe(false);
    expect(listExtras(context).map((extra) => [extra.name, extra.priceCents, extra.categoryIds])).toEqual([
      ["extra Schinken", 150, ["cat-pizza"]]
    ]);
    // Preis-Snapshot der Bestellung bleibt
    expect(context.sqlite.prepare("SELECT price_cents_snapshot AS p FROM pizza_order_lines WHERE id = 'l1'").get()).toEqual({ p: 700 });
    expect(context.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("importiert Extras per CSV mit Kategorien und Komma-Preisen", () => {
    const csv = `${UTF8_BOM}extra;preis_eur;kategorien;aktiv\r\nextra Käse;1,50;Pizza|Pasta;ja\r\nRucola;0.8;pizza;\r\nTrüffel;3;Pizza;nein\r\n`;
    const { result } = applyMenuTransfer(context, "extras_csv", csv);
    expect(result.errors).toEqual([]);
    expect(result.sections).toEqual({ menu: false, extras: true });
    expect(listExtras(context).map((extra) => [extra.name, extra.priceCents, extra.categoryIds, extra.active])).toEqual([
      ["extra Käse", 150, ["cat-pasta", "cat-pizza"], true],
      ["Rucola", 80, ["cat-pizza"], true],
      ["Trüffel", 300, ["cat-pizza"], false]
    ]);
    // Menü unberührt
    expect(listAllMenu(context).every((item) => item.active)).toBe(true);
    const bad = previewMenuTransfer(context, "extras_csv", "extra;preis_eur;kategorien;aktiv\nKäse;1;Desserts;ja\nKäse;2;Pizza;ja");
    expect(bad.errors).toEqual([
      { line: 2, code: "unknown_category", params: { name: "Desserts" } },
      { line: 3, code: "duplicate_extra", params: { name: "Käse" } }
    ]);
  });

  it("lehnt zu große Dateien ab", () => {
    expect(previewMenuTransfer(context, "yaml", "#".repeat(300 * 1024)).errors[0].code).toBe("too_large");
  });
});

describe("Roundtrip mit Sonderfällen (Review B1/N1)", () => {
  function prepareSpecialCases() {
    // deaktivierter Artikel mit aktiven Varianten (Knopf „Deaktivieren“ im Menü-Editor)
    setItemActive(context, "pi-007", false);
    // aktiver Artikel, dessen einzige Variante deaktiviert ist
    setVariantActive(context, "v-pa-058", false);
    // leere Kategorie
    upsertCategory(context, { name: "Getränke" });
    // neue Artikel mit Sortierung 0 (Standard des Artikel-Formulars), Gleichstand über den Namen
    for (const name of ["Zeta-Pizza", "Alpha-Pizza"]) {
      const id = upsertItem(context, { name, categoryId: "cat-pizza", sortOrder: 0 });
      upsertVariant(context, { itemId: id, sizeLabel: null, priceCents: 900 });
    }
    upsertExtra(context, { name: "Oliven", priceCents: 80, categoryIds: ["cat-pizza"], active: false });
  }

  function stateSnapshot() {
    return JSON.stringify({ menu: listAllMenu(context), categories: listCategories(context), extras: listExtras(context) });
  }

  const unchanged = (total: number) => ({ new: 0, changed: 0, unchanged: total, removed: 0 });

  for (const format of ["yaml", "csv"] as const) {
    it(`ändert beim ${format.toUpperCase()}-Roundtrip nichts`, () => {
      prepareSpecialCases();
      const doc = buildMenuDocument(context);
      const text = format === "yaml" ? menuToYaml(doc) : menuToCsv(doc);
      const before = stateSnapshot();
      const items = listAllMenu(context);
      const variants = items.reduce((sum, item) => sum + item.variants.length, 0);

      const preview = previewMenuTransfer(context, format, text);
      expect(preview.errors).toEqual([]);
      expect(preview.warnings).toEqual([]);
      // CSV kennt die leere Kategorie nicht, lässt sie aber unangetastet
      expect(preview.counts.categories).toEqual(unchanged(format === "yaml" ? 3 : 2));
      expect(preview.counts.items).toEqual(unchanged(items.length));
      expect(preview.counts.variants).toEqual(unchanged(variants));

      const { outcome } = applyMenuTransfer(context, format, text, { expectedVersion: preview.menuVersion });
      expect(outcome).toBe("applied");
      expect(stateSnapshot()).toBe(before);
      const after = listAllMenu(context);
      expect(after.find((item) => item.id === "pi-007")).toMatchObject({ active: false });
      expect(after.find((item) => item.id === "pi-007")!.variants.every((variant) => variant.active)).toBe(true);
      expect(after.find((item) => item.id === "pa-058")).toMatchObject({ active: true });
      expect(listCategories(context).find((category) => category.name === "Getränke")?.active).toBe(true);
    });
  }

  it("liest das alte CSV-Format mit einer aktiv-Spalte, ohne den Artikel-Status zu ändern", () => {
    setItemActive(context, "pi-007", false);
    const csv = ["kategorie;nummer;artikel;zutaten;allergene;variante;preis_eur;aktiv", "Pizza;07;Parmá;;;30cm;8,00;ja"].join("\n");
    const preview = previewMenuTransfer(context, "csv", csv);
    expect(preview.errors).toEqual([]);
    // Teil-Datei: Warnung statt stillem Entfernen
    expect(preview.warnings.map((warning) => warning.params?.kind)).toEqual(["items", "variants"]);
    applyMenuTransfer(context, "csv", csv, { confirmRemovals: true });
    const parma = listAllMenu(context).find((item) => item.id === "pi-007")!;
    expect(parma.active).toBe(false);
    expect(parma.variants.map((variant) => [variant.sizeLabel, variant.priceCents, variant.active])).toEqual([["30cm", 800, true]]);
    // Kategorien bleiben beim CSV-Import aktiv
    expect(listCategories(context).every((category) => category.active)).toBe(true);
  });

  it("lehnt unbekannte YAML-Schlüssel und CSV-Spalten ab (Review N2)", () => {
    const yaml = buildMenuDocument(context);
    const text = menuToYaml(yaml).replace("    artikel:\n", "    artikl:\n");
    const preview = previewMenuTransfer(context, "yaml", text);
    expect(preview.errors[0]).toMatchObject({ code: "unknown_field", params: { field: "artikl" } });
    expect(preview.errors[0].line).toBeGreaterThan(1);
    expect(previewMenuTransfer(context, "yaml", "kategorien:\n  - name: Pizza\n    farbe: rot\n").errors).toEqual([
      { line: 3, code: "unknown_field", params: { field: "farbe" } }
    ]);
    const csv = "kategorie;nummer;artikel;zutaten;allergene;artikel_aktiv;variante;preis_eur;variante_aktiv;notiz\nPizza;01;Margherita;;;ja;30cm;7;ja;x";
    expect(previewMenuTransfer(context, "csv", csv).errors[0].code).toBe("csv_header");
  });
});

describe("Formatkennung nach der Umbenennung", () => {
  const body = "version: 1\nkategorien:\n  - name: Pizza\n    artikel:\n      - name: Margherita\n        aktiv: true\n        varianten:\n          - preis_eur: 7.5\n            aktiv: true\n";

  it("schreibt matchdesk-pizza-menu und liest alte hermes-pizza-menu-Exporte", () => {
    expect(menuToYaml(buildMenuDocument(context))).toContain("format: matchdesk-pizza-menu");
    for (const format of ["matchdesk-pizza-menu", "hermes-pizza-menu"]) {
      const { errors, doc } = parseMenuYaml(`format: ${format}\n${body}`);
      expect(errors).toEqual([]);
      expect(doc.categories?.[0]?.items[0]?.name).toBe("Margherita");
    }
    expect(parseMenuYaml(`format: fremd\n${body}`).errors.length).toBeGreaterThan(0);
  });
});
