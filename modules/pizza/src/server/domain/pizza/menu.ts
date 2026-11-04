import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DatabaseContext } from "../../db/client";
import { pizzaMenuItems, pizzaMenuVariants } from "../../db/schema";
import { getCategoryById, listCategories } from "./categories";
import { AppError } from "../../http/errors";

export interface PizzaMenuVariantRow {
  id: string;
  itemId: string;
  sizeLabel: string | null;
  priceCents: number;
  sortOrder: number;
  active: boolean;
}

export interface PizzaMenuItemRow {
  id: string;
  number: string | null;
  name: string;
  ingredients: string | null;
  allergens: string | null;
  categoryId: string;
  active: boolean;
  sortOrder: number;
  variants: PizzaMenuVariantRow[];
}

function nowIso() {
  return new Date().toISOString();
}

export class PizzaMenuError extends AppError {
  constructor(code: string, message: string, status: number) {
    super(code, message, status);
  }
}

export type PizzaMenuRemovalResult = "deleted" | "deactivated";

/** Artikel nach Kategorie-Reihenfolge, dann Artikel-Sortierung und Name. */
function sortByCategory<T extends { categoryId: string; sortOrder: number; name: string }>(
  context: DatabaseContext,
  items: T[]
) {
  const categoryOrder = new Map(listCategories(context).map((category, index) => [category.id, index]));
  return [...items].sort(
    (a, b) =>
      (categoryOrder.get(a.categoryId) ?? Number.MAX_SAFE_INTEGER) -
        (categoryOrder.get(b.categoryId) ?? Number.MAX_SAFE_INTEGER) ||
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name, "de")
  );
}

export function listActiveMenu(context: DatabaseContext): PizzaMenuItemRow[] {
  const activeCategories = new Set(
    listCategories(context)
      .filter((category) => category.active)
      .map((category) => category.id)
  );
  // Inaktive Kategorien sind für Gäste unsichtbar, samt ihren Artikeln.
  const items = sortByCategory(
    context,
    context.db
      .select()
      .from(pizzaMenuItems)
      .where(eq(pizzaMenuItems.active, true))
      .all()
      .filter((item) => activeCategories.has(item.categoryId))
  );

  if (items.length === 0) return [];

  const variants = context.db
    .select()
    .from(pizzaMenuVariants)
    .orderBy(asc(pizzaMenuVariants.sortOrder))
    .all();

  const variantsByItem = new Map<string, PizzaMenuVariantRow[]>();
  for (const variant of variants) {
    const list = variantsByItem.get(variant.itemId) ?? [];
    list.push(variant);
    variantsByItem.set(variant.itemId, list);
  }

  // Bestellbar ist nur, was aktiv ist und mindestens eine aktive Variante hat.
  return items
    .map((item) => ({
      ...item,
      variants: (variantsByItem.get(item.id) ?? []).filter((variant) => variant.active)
    }))
    .filter((item) => item.variants.length > 0);
}

export function listAllMenu(context: DatabaseContext): PizzaMenuItemRow[] {
  const items = sortByCategory(context, context.db.select().from(pizzaMenuItems).all());

  const variants = context.db
    .select()
    .from(pizzaMenuVariants)
    .orderBy(asc(pizzaMenuVariants.sortOrder))
    .all();

  const variantsByItem = new Map<string, PizzaMenuVariantRow[]>();
  for (const variant of variants) {
    const list = variantsByItem.get(variant.itemId) ?? [];
    list.push(variant);
    variantsByItem.set(variant.itemId, list);
  }

  return items.map((item) => ({
    ...item,
    variants: variantsByItem.get(item.id) ?? []
  }));
}

export function getVariantById(context: DatabaseContext, variantId: string) {
  return context.db
    .select()
    .from(pizzaMenuVariants)
    .where(eq(pizzaMenuVariants.id, variantId))
    .get();
}

export function getVariantWithItem(context: DatabaseContext, variantId: string) {
  const variant = getVariantById(context, variantId);
  if (!variant) return null;
  const item = context.db
    .select()
    .from(pizzaMenuItems)
    .where(eq(pizzaMenuItems.id, variant.itemId))
    .get();
  if (!item || !item.active || !variant.active) return null;
  const category = getCategoryById(context, item.categoryId);
  if (!category || !category.active) return null;
  return { variant, item };
}

/** Anzahl bestellbarer Artikel (aktiv und mit mindestens einer aktiven Variante). */
export function countActiveItems(context: DatabaseContext): number {
  return listActiveMenu(context).length;
}

export function getItemById(context: DatabaseContext, itemId: string) {
  return context.db.select().from(pizzaMenuItems).where(eq(pizzaMenuItems.id, itemId)).get();
}

export interface UpsertItemInput {
  id?: string;
  number?: string | null;
  name: string;
  ingredients?: string | null;
  allergens?: string | null;
  categoryId: string;
  active?: boolean;
  sortOrder?: number;
}

export function upsertItem(context: DatabaseContext, input: UpsertItemInput) {
  if (!getCategoryById(context, input.categoryId)) {
    throw new PizzaMenuError("pizza_kategorie_nicht_gefunden", "Kategorie nicht gefunden", 404);
  }
  const id = input.id ?? randomUUID();
  const existing = context.db
    .select()
    .from(pizzaMenuItems)
    .where(eq(pizzaMenuItems.id, id))
    .get();

  if (existing) {
    context.db
      .update(pizzaMenuItems)
      .set({
        number: input.number ?? null,
        name: input.name,
        ingredients: input.ingredients ?? null,
        allergens: input.allergens ?? null,
        categoryId: input.categoryId,
        active: input.active ?? existing.active,
        sortOrder: input.sortOrder ?? existing.sortOrder,
        updatedAt: nowIso()
      })
      .where(eq(pizzaMenuItems.id, id))
      .run();
  } else {
    context.db
      .insert(pizzaMenuItems)
      .values({
        id,
        number: input.number ?? null,
        name: input.name,
        ingredients: input.ingredients ?? null,
        allergens: input.allergens ?? null,
        categoryId: input.categoryId,
        active: input.active ?? true,
        sortOrder: input.sortOrder ?? 0,
        createdAt: nowIso(),
        updatedAt: nowIso()
      })
      .run();
  }
  return id;
}

export interface UpsertVariantInput {
  id?: string;
  itemId: string;
  sizeLabel: string | null;
  priceCents: number;
  sortOrder?: number;
  active?: boolean;
}

export function upsertVariant(context: DatabaseContext, input: UpsertVariantInput) {
  const id = input.id ?? randomUUID();
  const existing = context.db
    .select()
    .from(pizzaMenuVariants)
    .where(eq(pizzaMenuVariants.id, id))
    .get();

  if (existing) {
    // Preisänderungen wirken nur auf neue Bestellzeilen; bestehende Zeilen behalten ihren
    // priceCentsSnapshot.
    context.db
      .update(pizzaMenuVariants)
      .set({
        sizeLabel: input.sizeLabel,
        priceCents: input.priceCents,
        sortOrder: input.sortOrder ?? existing.sortOrder,
        active: input.active ?? existing.active
      })
      .where(eq(pizzaMenuVariants.id, id))
      .run();
  } else {
    if (!getItemById(context, input.itemId)) {
      throw new PizzaMenuError("pizza_artikel_nicht_gefunden", "Menüeintrag nicht gefunden", 404);
    }
    context.db
      .insert(pizzaMenuVariants)
      .values({
        id,
        itemId: input.itemId,
        sizeLabel: input.sizeLabel,
        priceCents: input.priceCents,
        sortOrder: input.sortOrder ?? 0,
        active: input.active ?? true
      })
      .run();
  }
  return id;
}

function countLinesForVariants(context: DatabaseContext, variantIds: string[]) {
  if (variantIds.length === 0) return 0;
  const placeholders = variantIds.map(() => "?").join(", ");
  const row = context.sqlite
    .prepare(`SELECT COUNT(*) AS count FROM pizza_order_lines WHERE variant_id IN (${placeholders})`)
    .get(...variantIds) as { count: number };
  return row.count;
}

/**
 * Entfernt eine Variante. Ist sie in einer (auch archivierten) Bestellung referenziert, wird
 * sie nur deaktiviert, damit vergangene Bestellungen vollständig bleiben (FK RESTRICT).
 */
export function removeVariant(
  context: DatabaseContext,
  variantId: string
): PizzaMenuRemovalResult | null {
  const variant = getVariantById(context, variantId);
  if (!variant) return null;
  if (countLinesForVariants(context, [variantId]) > 0) {
    setVariantActive(context, variantId, false);
    return "deactivated";
  }
  context.db.delete(pizzaMenuVariants).where(eq(pizzaMenuVariants.id, variantId)).run();
  return "deleted";
}

/**
 * Entfernt einen Menüeintrag samt Varianten. Hat eine seiner Varianten Bestellhistorie, wird
 * der Eintrag nur deaktiviert.
 */
export function removeItem(context: DatabaseContext, itemId: string): PizzaMenuRemovalResult | null {
  const item = getItemById(context, itemId);
  if (!item) return null;
  const variantIds = listVariantsForItem(context, itemId).map((variant) => variant.id);
  if (countLinesForVariants(context, variantIds) > 0) {
    setItemActive(context, itemId, false);
    return "deactivated";
  }
  context.db.delete(pizzaMenuItems).where(eq(pizzaMenuItems.id, itemId)).run();
  return "deleted";
}

export function setVariantActive(context: DatabaseContext, variantId: string, active: boolean) {
  context.db
    .update(pizzaMenuVariants)
    .set({ active })
    .where(eq(pizzaMenuVariants.id, variantId))
    .run();
}

export function setItemActive(context: DatabaseContext, itemId: string, active: boolean) {
  context.db
    .update(pizzaMenuItems)
    .set({ active, updatedAt: nowIso() })
    .where(eq(pizzaMenuItems.id, itemId))
    .run();
}

export function listVariantsForItem(context: DatabaseContext, itemId: string) {
  return context.db
    .select()
    .from(pizzaMenuVariants)
    .where(eq(pizzaMenuVariants.itemId, itemId))
    .orderBy(asc(pizzaMenuVariants.sortOrder))
    .all();
}

export { and, eq };
