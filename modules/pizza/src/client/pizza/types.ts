export type PizzaSessionState = "draft" | "open" | "locked" | "delivered";
export type PizzaSessionTransition = "open" | "lock" | "deliver" | "reopen";
/** Frei pflegbare Menü-Kategorie (v0.15.0). `itemCount` liefert nur die Menüverwaltung. */
export interface PizzaCategory {
  id: string;
  name: string;
  sortOrder: number;
  active?: boolean;
  itemCount?: number;
}
export type PizzaPaymentStatus = "unpaid" | "paid_paypal" | "paid_cash";
export type PizzaPaymentMethod = "cash" | "paypal";

export interface PizzaVariant {
  id: string;
  itemId: string;
  sizeLabel: string | null;
  priceCents: number;
  sortOrder: number;
  active: boolean;
}

export interface PizzaItem {
  id: string;
  number: string | null;
  name: string;
  ingredients: string | null;
  allergens: string | null;
  categoryId: string;
  active: boolean;
  sortOrder: number;
  variants: PizzaVariant[];
}

/** Extra mit festem Aufpreis, angeboten für die genannten Kategorien. */
export interface PizzaExtra {
  id: string;
  name: string;
  priceCents: number;
  active: boolean;
  sortOrder: number;
  categoryIds: string[];
}

/** Extra an einer Bestellposition mit Name- und Preis-Snapshot. */
export interface PizzaOrderLineExtra {
  extraId: string;
  name: string;
  priceCentsSnapshot: number;
}

export interface PizzaSession {
  id: string;
  state: PizzaSessionState;
  label: string | null;
  openedAt: string | null;
  lockedAt: string | null;
  deliveredAt: string | null;
  archivedAt?: string | null;
}

export interface PizzaArchivedSession {
  id: string;
  state: PizzaSessionState;
  label: string | null;
  mainEventId?: string | null;
  mainEventName?: string | null;
  createdAt: string;
  openedAt: string | null;
  deliveredAt: string | null;
  archivedAt: string;
  orderCount: number;
  unpaidCount: number;
  totalCents: number;
}

export interface PizzaOrderLine {
  id: string;
  orderId: string;
  variantId: string;
  qty: number;
  priceCentsSnapshot: number;
  customNote: string | null;
  createdAt: string;
  /** Extras der Position (seit v0.15.0); der Positionspreis enthält sie. */
  extras?: PizzaOrderLineExtra[];
  /** Kategorie des Artikels, für die Auswahl passender Extras. */
  itemId?: string | null;
  categoryId?: string | null;
  /** Vom Server aufgelöste Bezeichnung (auch für deaktivierte Artikel/Varianten). */
  itemNumber?: string | null;
  itemName?: string;
  sizeLabel?: string | null;
}

export interface PizzaOrder {
  id: string;
  sessionId: string;
  userId: string;
  paymentStatus: PizzaPaymentStatus;
  paymentMethod: PizzaPaymentMethod | null;
  paidAt: string | null;
  paidByAdminId: string | null;
  lines: PizzaOrderLine[];
}

export interface PizzaOrderWithUser extends PizzaOrder {
  user: { username: string; displayName: string | null };
}

export interface PizzaGuestTotal {
  userId: string;
  totalCents: number;
}

export type PizzaPaymentMode = "cash_and_paypal" | "cash_only" | "paypal_only";

export interface PizzaPanelState {
  /** Event der angezeigten Bestellrunde (null = Runde ohne Event). */
  mainEventId?: string | null;
  mainEventName?: string | null;
  /** Darf in dieser Runde bestellen (Event-Runden: nur Teilnehmer). */
  canOrder?: boolean;
  /** Darf diese Bestellrunde verwalten (global oder per Event-Vergabe). */
  canManage?: boolean;
  /** Darf Speisekarte und Bezahlarten pflegen (nur global). */
  canManageMenu?: boolean;
  session: PizzaSession | null;
  /** Aktive Kategorien in Sortierreihenfolge. */
  categories?: PizzaCategory[];
  menu: PizzaItem[];
  /** Aktive Extras; je Artikel gelten die seiner Kategorie. */
  extras?: PizzaExtra[];
  /** Aktuell angebotene Bezahlarten (serverseitig aus Settings abgeleitet). */
  paymentMethods: PizzaPaymentMethod[];
  /** Einstellung hinter `paymentMethods` (ab manager änderbar). */
  paymentMode?: PizzaPaymentMode;
  /** Empfänger für Bargeld/PayPal (Moduleinstellungen). */
  payment?: { paypalHandle: string; paypalName: string; cashRecipient: string };
  myOrder: PizzaOrder | null;
  orders: PizzaOrderWithUser[];
  guestTotals: PizzaGuestTotal[];
}
