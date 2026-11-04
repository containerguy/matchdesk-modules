import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DatabaseContext } from "../../db/client";
import { pizzaMenuExtraCategories, pizzaMenuExtras } from "../../db/schema";
import { AppError } from "../../http/errors";
import { getCategoryById, nameKey } from "./categories";

export const PIZZA_EXTRA_NAME_MAX_LEN = 80;
export const PIZZA_MAX_EXTRAS_PER_LINE = 20;

export interface PizzaExtraRow {
  id: string;
  name: string;
  priceCents: number;
  active: boolean;
  sortOrder: number;
  /** Kategorien, in denen das Extra angeboten wird. */
  categoryIds: string[];
}

export type PizzaExtraRemovalResult = "deleted" | "deactivated";

export class PizzaExtraError extends AppError {
  constructor(code: string, message: string, status: number) {
    super(code, message, status);
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function listExtras(context: DatabaseContext): PizzaExtraRow[] {
  const links = context.db.select().from(pizzaMenuExtraCategories).all();
  const categoriesByExtra = new Map<string, string[]>();
  for (const link of links) {
    const list = categoriesByExtra.get(link.extraId) ?? [];
    list.push(link.categoryId);
    categoriesByExtra.set(link.extraId, list);
  }
  return context.db
    .select()
    .from(pizzaMenuExtras)
    .orderBy(asc(pizzaMenuExtras.sortOrder), asc(pizzaMenuExtras.name))
    .all()
    .map((extra) => ({
      id: extra.id,
      name: extra.name,
      priceCents: extra.priceCents,
      active: extra.active,
      sortOrder: extra.sortOrder,
      categoryIds: (categoriesByExtra.get(extra.id) ?? []).sort()
    }));
}

export function listActiveExtras(context: DatabaseContext) {
  return listExtras(context).filter((extra) => extra.active);
}

export function getExtraById(context: DatabaseContext, id: string): PizzaExtraRow | undefined {
  return listExtras(context).find((extra) => extra.id === id);
}

export function findExtraByName(context: DatabaseContext, name: string) {
  const key = nameKey(name);
  return listExtras(context).find((extra) => nameKey(extra.name) === key);
}

/**
 * Preis eines Extras für eine Variante. Heute fest pro Extra; ein späterer Preis pro Variante
 * (Tabelle `pizza_extra_variant_prices`) wird nur hier ergänzt. Bestellpositionen speichern das
 * Ergebnis als Snapshot.
 */
export function resolveExtraPriceCents(extra: Pick<PizzaExtraRow, "priceCents">, _variantId: string): number {
  return extra.priceCents;
}

export interface UpsertExtraInput {
  id?: string;
  name: string;
  priceCents: number;
  categoryIds: string[];
  active?: boolean;
  sortOrder?: number;
}

export function upsertExtra(context: DatabaseContext, input: UpsertExtraInput) {
  const name = input.name.trim();
  if (!name || name.length > PIZZA_EXTRA_NAME_MAX_LEN) {
    throw new PizzaExtraError("pizza_extra_ungueltig", "Name des Extras ist ungültig", 400);
  }
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0 || input.priceCents > 100_000) {
    throw new PizzaExtraError("pizza_extra_ungueltig", "Preis des Extras ist ungültig", 400);
  }
  const existing = input.id ? getExtraById(context, input.id) : undefined;
  if (input.id && !existing) {
    throw new PizzaExtraError("pizza_extra_nicht_gefunden", "Extra nicht gefunden", 404);
  }
  const clash = findExtraByName(context, name);
  if (clash && clash.id !== existing?.id) {
    throw new PizzaExtraError("pizza_extra_existiert", "Ein Extra mit diesem Namen gibt es schon", 409);
  }
  const categoryIds = [...new Set(input.categoryIds)];
  for (const categoryId of categoryIds) {
    if (!getCategoryById(context, categoryId)) {
      throw new PizzaExtraError("pizza_kategorie_nicht_gefunden", "Kategorie nicht gefunden", 404);
    }
  }

  const now = nowIso();
  const id = existing?.id ?? randomUUID();
  context.sqlite.transaction(() => {
    if (existing) {
      // Preisänderungen wirken nur auf neue Positionen; bestellte Extras behalten ihren Snapshot.
      context.db
        .update(pizzaMenuExtras)
        .set({
          name,
          priceCents: input.priceCents,
          active: input.active ?? existing.active,
          sortOrder: input.sortOrder ?? existing.sortOrder,
          updatedAt: now
        })
        .where(eq(pizzaMenuExtras.id, id))
        .run();
      context.db.delete(pizzaMenuExtraCategories).where(eq(pizzaMenuExtraCategories.extraId, id)).run();
    } else {
      const maxSort = (
        context.sqlite.prepare("SELECT COALESCE(MAX(sort_order), 0) AS max FROM pizza_menu_extras").get() as {
          max: number;
        }
      ).max;
      context.db
        .insert(pizzaMenuExtras)
        .values({
          id,
          name,
          priceCents: input.priceCents,
          active: input.active ?? true,
          sortOrder: input.sortOrder ?? maxSort + 1,
          createdAt: now,
          updatedAt: now
        })
        .run();
    }
    for (const categoryId of categoryIds) {
      context.db.insert(pizzaMenuExtraCategories).values({ extraId: id, categoryId }).run();
    }
  })();
  return id;
}

export function setExtraActive(context: DatabaseContext, id: string, active: boolean) {
  context.db.update(pizzaMenuExtras).set({ active, updatedAt: nowIso() }).where(eq(pizzaMenuExtras.id, id)).run();
}

export function countLinesForExtra(context: DatabaseContext, id: string) {
  return (
    context.sqlite.prepare("SELECT COUNT(*) AS count FROM pizza_order_line_extras WHERE extra_id = ?").get(id) as {
      count: number;
    }
  ).count;
}

/** Entfernt ein Extra; wurde es schon bestellt (auch in archivierten Runden), wird es nur deaktiviert. */
export function removeExtra(context: DatabaseContext, id: string): PizzaExtraRemovalResult | null {
  const extra = getExtraById(context, id);
  if (!extra) return null;
  if (countLinesForExtra(context, id) > 0) {
    setExtraActive(context, id, false);
    return "deactivated";
  }
  // Kategorie-Zuordnungen hängen per ON DELETE CASCADE am Extra.
  context.db.delete(pizzaMenuExtras).where(eq(pizzaMenuExtras.id, id)).run();
  return "deleted";
}
