import { describe, expect, it } from "vitest";
import { buildKassenlistePdf, buildPizzeriaPdf } from "./pizza-print";

const FIXED_DATE = new Date("2026-05-01T18:30:00Z");

describe("buildPizzeriaPdf", () => {
  it("renders a non-empty PDF buffer with %PDF header for a small order", async () => {
    const buffer = await buildPizzeriaPdf({
      eventTitle: "LAN Mai 2026",
      printedAt: FIXED_DATE,
      rows: [
        { number: "01", name: "Margherita", sizeLabel: "30cm", qty: 5, customNote: null },
        {
          number: "07",
          name: "Parmá",
          sizeLabel: "45cm",
          qty: 2,
          customNote: "extra Rucola"
        }
      ]
    });

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(500);
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("renders an empty rows table without throwing", async () => {
    const buffer = await buildPizzeriaPdf({
      eventTitle: "Leerlauf",
      printedAt: FIXED_DATE,
      rows: []
    });
    expect(buffer.length).toBeGreaterThan(200);
  });
});

describe("buildKassenlistePdf", () => {
  it("renders a PDF with multiple guests, totals and payment markers", async () => {
    const buffer = await buildKassenlistePdf({
      eventTitle: "LAN Mai 2026",
      printedAt: FIXED_DATE,
      paypalName: "Rene Keller",
      paypalHandle: "renekeller",
      cashRecipient: "Rene",
      guests: [
        {
          username: "stefan",
          displayName: "Stefan",
          totalCents: 1450,
          paymentStatus: "unpaid",
          lines: [
            {
              number: "01",
              name: "Margherita",
              sizeLabel: "30cm",
              qty: 1,
              priceCentsSnapshot: 700,
              customNote: null
            },
            {
              number: "07",
              name: "Parmá",
              sizeLabel: "30cm",
              qty: 1,
              priceCentsSnapshot: 850,
              customNote: "extra Rucola"
            }
          ]
        },
        {
          username: "rene",
          displayName: null,
          totalCents: 800,
          paymentStatus: "paid_paypal",
          lines: [
            {
              number: "16",
              name: "Diavolo",
              sizeLabel: "30cm",
              qty: 1,
              priceCentsSnapshot: 800,
              customNote: null
            }
          ]
        }
      ]
    });
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
    expect(buffer.length).toBeGreaterThan(800);
  });

  it("omits payment hints when settings are empty", async () => {
    const buffer = await buildKassenlistePdf({
      eventTitle: "LAN ohne PayPal",
      printedAt: FIXED_DATE,
      paypalName: null,
      paypalHandle: null,
      cashRecipient: null,
      guests: []
    });
    expect(buffer.length).toBeGreaterThan(200);
  });
});

describe("PDFs mit Extras", () => {
  it("druckt Extras in Pizzeria-Liste und Kassenliste", async () => {
    const pizzeria = await buildPizzeriaPdf({
      eventTitle: "Extras",
      printedAt: FIXED_DATE,
      rows: [
        { number: "01", name: "Margherita", sizeLabel: "30cm", extras: ["extra Schinken", "Knoblauch"], qty: 2, customNote: null }
      ]
    });
    expect(pizzeria.subarray(0, 4).toString()).toBe("%PDF");
    const kasse = await buildKassenlistePdf({
      eventTitle: "Extras",
      printedAt: FIXED_DATE,
      paypalName: null,
      paypalHandle: null,
      cashRecipient: null,
      guests: [
        {
          username: "gast",
          displayName: "Gäst Ümlaut",
          totalCents: 1700,
          paymentStatus: "unpaid",
          paymentMethod: "cash",
          lines: [
            {
              number: "01",
              name: "Margherita",
              sizeLabel: "30cm",
              qty: 2,
              priceCentsSnapshot: 700,
              extras: [{ name: "extra Schinken", priceCentsSnapshot: 150 }],
              customNote: null
            }
          ]
        }
      ]
    });
    expect(kasse.subarray(0, 4).toString()).toBe("%PDF");
  });
});
