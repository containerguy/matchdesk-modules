// Standalone-Build: bringt die Standardschriften mit (der normale Build liest sie zur Laufzeit aus node_modules).
import PDFDocument from "pdfkit/js/pdfkit.standalone.js";
import { formatEuro, lineTotalCents } from "../domain/pizza/totals";

export interface PizzeriaLineRow {
  number: string | null;
  name: string;
  sizeLabel: string | null;
  /** Namen der Extras (gleiche Variante mit anderen Extras = eigene Zeile). */
  extras?: string[];
  qty: number;
  customNote: string | null;
}

export interface PizzeriaPrintInput {
  eventTitle: string;
  printedAt: Date;
  rows: PizzeriaLineRow[];
}

export interface KassenlisteGuestRow {
  username: string;
  displayName: string | null;
  totalCents: number;
  paymentStatus: "unpaid" | "paid_paypal" | "paid_cash";
  /** Vom Gast gewählte Bezahlart; null/undefined = noch nicht gewählt. */
  paymentMethod?: "cash" | "paypal" | null;
  lines: Array<{
    number: string | null;
    name: string;
    sizeLabel: string | null;
    qty: number;
    priceCentsSnapshot: number;
    /** Extras mit Aufpreis-Snapshot; der Positionspreis enthält sie. */
    extras?: Array<{ name: string; priceCentsSnapshot: number }>;
    customNote: string | null;
  }>;
}

export interface KassenlistePrintInput {
  eventTitle: string;
  printedAt: Date;
  paypalName: string | null;
  paypalHandle: string | null;
  cashRecipient: string | null;
  guests: KassenlisteGuestRow[];
}

function formatDateDe(date: Date): string {
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
    // Der Container läuft in UTC; gedruckt wird für die LAN in Deutschland.
    timeZone: "Europe/Berlin"
  }).format(date);
}

function streamToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

export async function buildPizzeriaPdf(input: PizzeriaPrintInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 36 });
  const result = streamToBuffer(doc);

  doc.fontSize(18).text("Pizzeria-Bestellung", { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(11).text(`Event: ${input.eventTitle}`);
  doc.text(`Gedruckt: ${formatDateDe(input.printedAt)}`);
  doc.text(`Positionen: ${input.rows.length}`);
  doc.moveDown(0.6);

  doc.fontSize(11).text("Nr.   Menge   Artikel", { continued: false });
  doc.moveTo(36, doc.y).lineTo(559, doc.y).stroke();
  doc.moveDown(0.2);

  for (const row of input.rows) {
    const number = row.number ?? "—";
    const size = row.sizeLabel ? ` (${row.sizeLabel})` : "";
    const line = `${number.padEnd(6)} ${String(row.qty).padStart(3)}×    ${row.name}${size}`;
    doc.fontSize(11).text(line);
    for (const extra of row.extras ?? []) {
      doc.fontSize(10).text(`               + ${extra}`);
    }
    if (row.customNote) {
      doc.fontSize(9).fillColor("#444").text(`     Sonderwunsch: ${row.customNote}`);
      doc.fillColor("black");
    }
  }

  doc.end();
  return result;
}

export async function buildKassenlistePdf(input: KassenlistePrintInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 36 });
  const result = streamToBuffer(doc);

  doc.fontSize(18).text("Kassenliste – Pizzabestellung", { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(11).text(`Event: ${input.eventTitle}`);
  doc.text(`Gedruckt: ${formatDateDe(input.printedAt)}`);
  if (input.paypalName) doc.text(`PayPal an: ${input.paypalName}`);
  if (input.paypalHandle) doc.text(`PayPal-Handle: ${input.paypalHandle}`);
  if (input.cashRecipient) doc.text(`Bargeld an: ${input.cashRecipient}`);
  doc.moveDown(0.6);

  const total = input.guests.reduce((sum, guest) => sum + guest.totalCents, 0);
  const paid = input.guests
    .filter((g) => g.paymentStatus !== "unpaid")
    .reduce((sum, g) => sum + g.totalCents, 0);
  doc.fontSize(11).text(`Gesamt: ${formatEuro(total)}    Bezahlt: ${formatEuro(paid)}`);
  doc.moveDown(0.5);

  for (const guest of input.guests) {
    const heading = `${guest.displayName ?? guest.username} — ${formatEuro(guest.totalCents)}`;
    doc.fontSize(13).text(heading);
    // Nur WinAnsi-Zeichen: Helvetica kann ☑/☐ nicht darstellen.
    const status =
      guest.paymentStatus === "paid_paypal"
        ? "[x] bezahlt (PayPal)"
        : guest.paymentStatus === "paid_cash"
          ? "[x] bezahlt (Bar)"
          : guest.paymentMethod === "cash"
            ? "[ ] offen – Bar gewählt"
            : guest.paymentMethod === "paypal"
              ? "[ ] offen – PayPal gewählt"
              : "[ ] offen – PayPal oder Bar";
    doc.fontSize(10).fillColor("#555").text(`Status: ${status}`);
    doc.fillColor("black");
    for (const line of guest.lines) {
      const number = line.number ?? "—";
      const size = line.sizeLabel ? ` (${line.sizeLabel})` : "";
      doc
        .fontSize(10)
        .text(
          `  ${number.padEnd(6)} ${String(line.qty).padStart(2)}×  ${line.name}${size}  ${formatEuro(lineTotalCents(line))}`
        );
      for (const extra of line.extras ?? []) {
        doc.fontSize(9).text(`             + ${extra.name} (${formatEuro(extra.priceCentsSnapshot)})`);
      }
      if (line.customNote) {
        doc.fontSize(9).fillColor("#666").text(`      Notiz: ${line.customNote}`);
        doc.fillColor("black");
      }
    }
    doc.moveDown(0.5);
  }

  doc.end();
  return result;
}
