import { describe, expect, it } from "vitest";
import {
  buildPaypalMeUrl,
  formatEuro,
  guestTotals,
  lineTotalCents,
  lineUnitCents,
  orderTotalCents,
  sessionTotalCents
} from "./totals";

describe("pizza totals math", () => {
  it("multiplies qty by snapshot price for one line", () => {
    expect(lineTotalCents({ qty: 2, priceCentsSnapshot: 750 })).toBe(1500);
  });

  it("sums multiple lines per order", () => {
    expect(
      orderTotalCents([
        { qty: 1, priceCentsSnapshot: 700 },
        { qty: 2, priceCentsSnapshot: 850 }
      ])
    ).toBe(2400);
  });

  it("adds extras to the unit price before multiplying by qty", () => {
    const line = {
      qty: 3,
      priceCentsSnapshot: 700,
      extras: [{ priceCentsSnapshot: 150 }, { priceCentsSnapshot: 50 }]
    };
    expect(lineUnitCents(line)).toBe(900);
    expect(lineTotalCents(line)).toBe(2700);
    expect(lineTotalCents({ qty: 1, priceCentsSnapshot: 700, extras: [] })).toBe(700);
    expect(orderTotalCents([line, { qty: 1, priceCentsSnapshot: 650 }])).toBe(3350);
  });

  it("returns zero for empty order", () => {
    expect(orderTotalCents([])).toBe(0);
  });

  it("aggregates totals per guest", () => {
    const totals = guestTotals([
      { userId: "u1", lines: [{ qty: 1, priceCentsSnapshot: 700 }] },
      {
        userId: "u2",
        lines: [
          { qty: 3, priceCentsSnapshot: 600 },
          { qty: 1, priceCentsSnapshot: 1000 }
        ]
      }
    ]);
    expect(totals).toEqual([
      { userId: "u1", totalCents: 700 },
      { userId: "u2", totalCents: 2800 }
    ]);
  });

  it("aggregates session-wide total", () => {
    expect(
      sessionTotalCents([
        { userId: "u1", lines: [{ qty: 1, priceCentsSnapshot: 700 }] },
        { userId: "u2", lines: [{ qty: 2, priceCentsSnapshot: 800 }] }
      ])
    ).toBe(2300);
  });
});

describe("formatEuro", () => {
  it("formats euro amounts with German locale", () => {
    expect(formatEuro(750)).toMatch(/7,50/);
    expect(formatEuro(1500)).toMatch(/15,00/);
  });
});

describe("buildPaypalMeUrl", () => {
  it("builds a paypal.me URL from a bare handle", () => {
    expect(buildPaypalMeUrl("renekeller", 1450)).toBe("https://www.paypal.me/renekeller/14.50EUR");
  });

  it("strips @ prefix", () => {
    expect(buildPaypalMeUrl("@renekeller", 700)).toBe("https://www.paypal.me/renekeller/7.00EUR");
  });

  it("strips full paypal.me URL", () => {
    expect(buildPaypalMeUrl("https://paypal.me/renekeller", 900)).toBe(
      "https://www.paypal.me/renekeller/9.00EUR"
    );
  });

  it("returns null for empty handle", () => {
    expect(buildPaypalMeUrl("", 100)).toBeNull();
    expect(buildPaypalMeUrl("   ", 100)).toBeNull();
  });
});
