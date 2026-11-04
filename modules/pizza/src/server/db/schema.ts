import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/*
 * Tabellen des Moduls (Präfix pizza_) und die Kern-Tabellen, auf die es nur lesend verweist.
 * Die Pizza-Tabellen entstehen in migrations/0001_pizza.sql; bis Matchdesk-Migration 0036 lagen sie im Kern.
 */

/** Kern-Tabelle (nur lesen). */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  displayName: text("display_name"),
  deletedAt: text("deleted_at")
});

/** Kern-Tabelle (nur lesen). */
export const mainEvents = sqliteTable("main_events", {
  id: text("id").primaryKey(),
  name: text("name").notNull()
});

/** 0024: Frei pflegbare Menü-Kategorien (vorher fest „pizza“/„pasta“). */
export const pizzaMenuCategories = sqliteTable(
  "pizza_menu_categories",
  {
    id: text("id").primaryKey(),
    /** Eindeutig ohne Groß-/Kleinschreibung (Index mit COLLATE NOCASE, Domain prüft Unicode). */
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  }
);

export const pizzaMenuItems = sqliteTable(
  "pizza_menu_items",
  {
    id: text("id").primaryKey(),
    number: text("number"),
    name: text("name").notNull(),
    ingredients: text("ingredients"),
    allergens: text("allergens"),
    /** 0024: ersetzt das frühere Enum `category`. */
    categoryId: text("category_id")
      .notNull()
      .references(() => pizzaMenuCategories.id, { onDelete: "restrict" }),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    index("pizza_menu_items_active_sort_idx").on(table.active, table.sortOrder),
    index("pizza_menu_items_category_idx").on(table.categoryId)
  ]
);

export const pizzaMenuVariants = sqliteTable(
  "pizza_menu_variants",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => pizzaMenuItems.id, { onDelete: "cascade" }),
    sizeLabel: text("size_label"),
    priceCents: integer("price_cents").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    /** 0022: Varianten mit Bestellhistorie werden deaktiviert statt gelöscht. */
    active: integer("active", { mode: "boolean" }).notNull().default(true)
  },
  (table) => [index("pizza_menu_variants_item_idx").on(table.itemId)]
);

export const pizzaSessions = sqliteTable(
  "pizza_sessions",
  {
    id: text("id").primaryKey(),
    state: text("state", { enum: ["draft", "open", "locked", "delivered"] })
      .notNull()
      .default("draft"),
    /** 0036: Event der Bestellrunde (null = Runde ohne Event). */
    mainEventId: text("main_event_id").references(() => mainEvents.id, { onDelete: "set null" }),
    label: text("label"),
    openedAt: text("opened_at"),
    openedByUserId: text("opened_by_user_id").references(() => users.id, { onDelete: "set null" }),
    lockedAt: text("locked_at"),
    lockedByUserId: text("locked_by_user_id").references(() => users.id, { onDelete: "set null" }),
    deliveredAt: text("delivered_at"),
    deliveredByUserId: text("delivered_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    /** 0022: Archivierte Runden verschwinden aus der aktuellen Ansicht. */
    archivedAt: text("archived_at"),
    archivedByUserId: text("archived_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [index("pizza_sessions_archived_created_idx").on(table.archivedAt, table.createdAt)]
);

export const pizzaOrders = sqliteTable(
  "pizza_orders",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => pizzaSessions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    paymentStatus: text("payment_status", {
      enum: ["unpaid", "paid_paypal", "paid_cash"]
    })
      .notNull()
      .default("unpaid"),
    /** 0022: Gewählte Bezahlart; null = noch nicht gewählt. */
    paymentMethod: text("payment_method", { enum: ["cash", "paypal"] }),
    paidAt: text("paid_at"),
    paidByAdminId: text("paid_by_admin_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("pizza_orders_session_user_unique").on(table.sessionId, table.userId)]
);

export const pizzaOrderLines = sqliteTable(
  "pizza_order_lines",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => pizzaOrders.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
      .notNull()
      .references(() => pizzaMenuVariants.id, { onDelete: "restrict" }),
    qty: integer("qty").notNull(),
    priceCentsSnapshot: integer("price_cents_snapshot").notNull(),
    customNote: text("custom_note"),
    createdAt: text("created_at").notNull()
  },
  (table) => [index("pizza_order_lines_order_idx").on(table.orderId)]
);

/**
 * 0024: Extras mit festem Aufpreis je Extra. Ein späterer Preis pro Variante kommt als eigene
 * Tabelle (z. B. `pizza_extra_variant_prices`) hinzu; die Preisauflösung steckt an einer Stelle
 * (`resolveExtraPriceCents` in domain/pizza/extras.ts).
 */
export const pizzaMenuExtras = sqliteTable("pizza_menu_extras", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

/** 0024: Für welche Kategorien ein Extra angeboten wird (n:m). */
export const pizzaMenuExtraCategories = sqliteTable(
  "pizza_menu_extra_categories",
  {
    extraId: text("extra_id")
      .notNull()
      .references(() => pizzaMenuExtras.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => pizzaMenuCategories.id, { onDelete: "cascade" })
  },
  (table) => [
    primaryKey({ columns: [table.extraId, table.categoryId] }),
    index("pizza_menu_extra_categories_category_idx").on(table.categoryId)
  ]
);

/** 0024: Extras je Bestellposition mit Name- und Preis-Snapshot. */
export const pizzaOrderLineExtras = sqliteTable(
  "pizza_order_line_extras",
  {
    lineId: text("line_id")
      .notNull()
      .references(() => pizzaOrderLines.id, { onDelete: "cascade" }),
    extraId: text("extra_id")
      .notNull()
      .references(() => pizzaMenuExtras.id, { onDelete: "restrict" }),
    nameSnapshot: text("name_snapshot").notNull(),
    priceCentsSnapshot: integer("price_cents_snapshot").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.lineId, table.extraId] }),
    index("pizza_order_line_extras_extra_idx").on(table.extraId)
  ]
);
