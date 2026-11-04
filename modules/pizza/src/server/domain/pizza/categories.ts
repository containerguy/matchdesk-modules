import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DatabaseContext } from "../../db/client";
import { pizzaMenuCategories } from "../../db/schema";
import { AppError } from "../../http/errors";

export const PIZZA_CATEGORY_NAME_MAX_LEN = 60;

export interface PizzaCategoryRow {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
  /** Anzahl Artikel (auch inaktive); löschen geht nur bei 0. */
  itemCount: number;
}

export class PizzaCategoryError extends AppError {
  constructor(code: string, message: string, status: number) {
    super(code, message, status);
  }
}

function nowIso() {
  return new Date().toISOString();
}

/** Vergleichsschlüssel für Namen: getrimmt, Unicode-kleingeschrieben (auch Ä/ä). */
export function nameKey(name: string) {
  return name.trim().normalize("NFC").toLocaleLowerCase("de-DE");
}

export function listCategories(context: DatabaseContext): PizzaCategoryRow[] {
  const counts = new Map(
    (
      context.sqlite
        .prepare("SELECT category_id AS categoryId, COUNT(*) AS count FROM pizza_menu_items GROUP BY category_id")
        .all() as Array<{ categoryId: string; count: number }>
    ).map((row) => [row.categoryId, row.count])
  );
  return context.db
    .select()
    .from(pizzaMenuCategories)
    .orderBy(asc(pizzaMenuCategories.sortOrder), asc(pizzaMenuCategories.name))
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      sortOrder: row.sortOrder,
      active: row.active,
      itemCount: counts.get(row.id) ?? 0
    }));
}

export function listActiveCategories(context: DatabaseContext) {
  return listCategories(context).filter((category) => category.active);
}

export function getCategoryById(context: DatabaseContext, id: string) {
  return context.db.select().from(pizzaMenuCategories).where(eq(pizzaMenuCategories.id, id)).get();
}

export function findCategoryByName(context: DatabaseContext, name: string) {
  const key = nameKey(name);
  return context.db
    .select()
    .from(pizzaMenuCategories)
    .all()
    .find((category) => nameKey(category.name) === key);
}

export interface UpsertCategoryInput {
  id?: string;
  name: string;
  sortOrder?: number;
  active?: boolean;
}

/** Legt an oder benennt um/sortiert/(de)aktiviert. Namen sind ohne Groß-/Kleinschreibung eindeutig. */
export function upsertCategory(context: DatabaseContext, input: UpsertCategoryInput) {
  const name = input.name.trim();
  if (!name || name.length > PIZZA_CATEGORY_NAME_MAX_LEN) {
    throw new PizzaCategoryError("pizza_kategorie_ungueltig", "Kategoriename ist ungültig", 400);
  }
  const existing = input.id ? getCategoryById(context, input.id) : undefined;
  if (input.id && !existing) {
    throw new PizzaCategoryError("pizza_kategorie_nicht_gefunden", "Kategorie nicht gefunden", 404);
  }
  const clash = findCategoryByName(context, name);
  if (clash && clash.id !== existing?.id) {
    throw new PizzaCategoryError("pizza_kategorie_existiert", "Eine Kategorie mit diesem Namen gibt es schon", 409);
  }
  const now = nowIso();
  if (existing) {
    context.db
      .update(pizzaMenuCategories)
      .set({
        name,
        sortOrder: input.sortOrder ?? existing.sortOrder,
        active: input.active ?? existing.active,
        updatedAt: now
      })
      .where(eq(pizzaMenuCategories.id, existing.id))
      .run();
    return existing.id;
  }
  const id = randomUUID();
  const maxSort = (
    context.sqlite.prepare("SELECT COALESCE(MAX(sort_order), 0) AS max FROM pizza_menu_categories").get() as {
      max: number;
    }
  ).max;
  context.db
    .insert(pizzaMenuCategories)
    .values({
      id,
      name,
      sortOrder: input.sortOrder ?? maxSort + 1,
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now
    })
    .run();
  return id;
}

export function setCategoryActive(context: DatabaseContext, id: string, active: boolean) {
  context.db
    .update(pizzaMenuCategories)
    .set({ active, updatedAt: nowIso() })
    .where(eq(pizzaMenuCategories.id, id))
    .run();
}

/** Setzt die Reihenfolge entsprechend der übergebenen IDs (1, 2, 3 …); nicht genannte folgen danach. */
export function reorderCategories(context: DatabaseContext, orderedIds: string[]) {
  const all = listCategories(context);
  const known = new Set(all.map((category) => category.id));
  for (const id of orderedIds) {
    if (!known.has(id)) {
      throw new PizzaCategoryError("pizza_kategorie_nicht_gefunden", "Kategorie nicht gefunden", 404);
    }
  }
  const rest = all.map((category) => category.id).filter((id) => !orderedIds.includes(id));
  const now = nowIso();
  const update = context.sqlite.prepare(
    "UPDATE pizza_menu_categories SET sort_order = ?, updated_at = ? WHERE id = ? AND sort_order <> ?"
  );
  context.sqlite.transaction(() => {
    [...orderedIds, ...rest].forEach((id, index) => update.run(index + 1, now, id, index + 1));
  })();
}

/** Löscht nur leere Kategorien (ohne Artikel, auch ohne inaktive); sonst bitte deaktivieren. */
export function deleteCategory(context: DatabaseContext, id: string) {
  const category = getCategoryById(context, id);
  if (!category) {
    throw new PizzaCategoryError("pizza_kategorie_nicht_gefunden", "Kategorie nicht gefunden", 404);
  }
  const count = (
    context.sqlite.prepare("SELECT COUNT(*) AS count FROM pizza_menu_items WHERE category_id = ?").get(id) as {
      count: number;
    }
  ).count;
  if (count > 0) {
    throw new PizzaCategoryError(
      "pizza_kategorie_nicht_leer",
      "Kategorie enthält noch Artikel und kann nur deaktiviert werden",
      409
    );
  }
  // Zuordnungen zu Extras hängen per ON DELETE CASCADE an der Kategorie.
  context.db.delete(pizzaMenuCategories).where(eq(pizzaMenuCategories.id, id)).run();
  return category;
}
