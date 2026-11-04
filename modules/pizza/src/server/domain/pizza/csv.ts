/**
 * Kleines CSV-Werkzeug für den Menü-Import/-Export: Trennzeichen `;`, UTF-8 mit BOM (damit Excel
 * Umlaute erkennt), Zeilenende CRLF, Anführungszeichen nach RFC 4180.
 */

export const CSV_DELIMITER = ";";
export const UTF8_BOM = "﻿";

/** Zeichen, mit denen Excel/LibreOffice eine Zelle als Formel auswerten (OWASP: CSV-Injection). */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** Zelle für den Export: Formel-Präfixe mit `'` entschärfen, bei Bedarf in Anführungszeichen. */
export function csvCell(value: string): string {
  const guarded = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  if (/[;"\r\n]/.test(guarded) || guarded !== guarded.trim()) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

export function toCsv(rows: string[][]): string {
  return UTF8_BOM + rows.map((row) => row.map(csvCell).join(CSV_DELIMITER)).join("\r\n") + "\r\n";
}

/** Gegenstück zu `csvCell`: ein vom Export gesetztes `'` vor einem Formel-Präfix wieder entfernen. */
export function unguardCell(value: string): string {
  return value.startsWith("'") && FORMULA_PREFIX.test(value.slice(1)) ? value.slice(1) : value;
}

export interface CsvRow {
  /** Zeilennummer (1-basiert) in der Datei, an der der Datensatz beginnt. */
  line: number;
  cells: string[];
}

export type CsvParseResult = { ok: true; rows: CsvRow[] } | { ok: false; line: number };

/** Parst CSV mit `;`; Zeilenumbrüche in Anführungszeichen sind erlaubt. */
export function parseCsv(input: string): CsvParseResult {
  const text = input.startsWith(UTF8_BOM) ? input.slice(1) : input;
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let atCellStart = true;
  let line = 1;
  let rowStart = 1;

  const endCell = () => {
    cells.push(cell);
    cell = "";
    atCellStart = true;
  };
  const endRow = () => {
    endCell();
    rows.push({ line: rowStart, cells });
    cells = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === "\n") line += 1;
        cell += char;
      }
      continue;
    }
    if (char === '"' && atCellStart) {
      quoted = true;
      atCellStart = false;
    } else if (char === CSV_DELIMITER) {
      endCell();
    } else if (char === "\r" && text[index + 1] === "\n") {
      // CRLF: das \n schließt die Zeile ab
    } else if (char === "\n" || char === "\r") {
      endRow();
      line += 1;
      rowStart = line;
    } else {
      cell += char;
      atCellStart = false;
    }
  }
  if (quoted) return { ok: false, line: rowStart };
  if (cell !== "" || cells.length > 0) endRow();
  return { ok: true, rows };
}
