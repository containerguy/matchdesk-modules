export function formatEuro(cents: number, locale = "de-DE"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(cents / 100);
}

/** Cent-Betrag als Eingabewert, z. B. 950 → "9,50". */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

/**
 * Parst eine Euro-Eingabe ("9,50", "9.5", "12") in Cent. Liefert null bei ungültigen,
 * negativen oder unrealistisch hohen Werten (> 1000 €).
 */
export function parseEuroToCents(input: string): number | null {
  const normalized = input.trim().replace(/\s|€/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  if (!Number.isFinite(cents) || cents < 0 || cents > 100_000) return null;
  return cents;
}

interface LineForTotal {
  qty: number;
  priceCentsSnapshot: number;
  extras?: Array<{ priceCentsSnapshot: number }>;
}

/** Positionspreis = (Variantenpreis + Summe der Extras) × Menge, wie auf dem Server. */
export function lineTotalCents(line: LineForTotal): number {
  const extras = (line.extras ?? []).reduce((sum, extra) => sum + extra.priceCentsSnapshot, 0);
  return line.qty * (line.priceCentsSnapshot + extras);
}
