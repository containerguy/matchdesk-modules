import { requestJson } from "../api/request";
import type {
  PizzaArchivedSession,
  PizzaCategory,
  PizzaExtra,
  PizzaItem,
  PizzaPanelState,
  PizzaPaymentMethod,
  PizzaPaymentMode,
  PizzaSessionTransition
} from "./types";

export type PizzaRemovalResult = "deleted" | "deactivated";

/**
 * Bestellrunden-Bereich der Pizza-Seite: Event-ID, `null` = Runde ohne Event,
 * `undefined` = Server nimmt das aktuelle Event des Benutzers.
 */
let pizzaScope: string | null | undefined;

export function setPizzaScope(mainEventId: string | null | undefined) {
  pizzaScope = mainEventId;
}

/** Query-Parameter für die Bestellrunde des gewählten Bereichs. */
export function pizzaScopeQuery(prefix: "?" | "&" = "?") {
  if (pizzaScope === undefined) return "";
  return `${prefix}mainEventId=${encodeURIComponent(pizzaScope ?? "none")}`;
}

export async function fetchPizzaState(): Promise<PizzaPanelState> {
  return requestJson<PizzaPanelState>(`/api/m/pizza/state${pizzaScopeQuery()}`);
}

export async function transitionPizzaSession(
  transition: PizzaSessionTransition,
  label?: string | null
) {
  return requestJson<{ session: unknown }>(`/api/m/pizza/transitions${pizzaScopeQuery()}`, {
    method: "POST",
    body: JSON.stringify({ transition, ...(label !== undefined ? { label } : {}) })
  });
}

export async function addPizzaLine(input: {
  variantId: string;
  qty: number;
  customNote?: string | null;
  extraIds?: string[];
}) {
  return requestJson<{ lineId: string; orderId: string }>(`/api/m/pizza/lines${pizzaScopeQuery()}`, {
    method: "POST",
    body: JSON.stringify({
      variantId: input.variantId,
      qty: input.qty,
      customNote: input.customNote ?? null,
      ...(input.extraIds && input.extraIds.length > 0 ? { extraIds: input.extraIds } : {})
    })
  });
}

export async function updatePizzaLine(
  lineId: string,
  patch: { qty?: number; customNote?: string | null; extraIds?: string[] }
) {
  await requestJson<void>(`/api/m/pizza/lines/${encodeURIComponent(lineId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
}

export async function deletePizzaLine(lineId: string) {
  await requestJson<void>(`/api/m/pizza/lines/${encodeURIComponent(lineId)}`, {
    method: "DELETE"
  });
}

export async function markPizzaPayment(orderId: string, method: "paypal" | "cash" | "unpaid") {
  return requestJson<unknown>(`/api/m/pizza/orders/${encodeURIComponent(orderId)}/payment`, {
    method: "POST",
    body: JSON.stringify({ method })
  });
}

export async function choosePizzaPaymentMethod(method: PizzaPaymentMethod) {
  await requestJson<void>(`/api/m/pizza/orders/mine/payment-method${pizzaScopeQuery()}`, {
    method: "POST",
    body: JSON.stringify({ method })
  });
}

export async function archivePizzaSession(sessionId: string) {
  return requestJson<{ session: unknown }>(
    `/api/m/pizza/sessions/${encodeURIComponent(sessionId)}/archive`,
    { method: "POST", body: JSON.stringify({}) }
  );
}

export async function fetchArchivedPizzaSessions() {
  const response = await requestJson<{ sessions: PizzaArchivedSession[] }>(
    `/api/m/pizza/sessions/archived`
  );
  return response.sessions;
}

export async function deleteArchivedPizzaSession(sessionId: string) {
  await requestJson<void>(`/api/m/pizza/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE"
  });
}

export interface PizzaAdminMenu {
  items: PizzaItem[];
  categories: PizzaCategory[];
  extras: PizzaExtra[];
}

export async function fetchPizzaAdminMenu(): Promise<PizzaAdminMenu> {
  const response = await requestJson<Partial<PizzaAdminMenu>>(`/api/m/pizza/admin/menu`);
  return {
    items: response.items ?? [],
    categories: response.categories ?? [],
    extras: response.extras ?? []
  };
}

export interface PizzaExtraInput {
  id?: string;
  name: string;
  priceCents: number;
  categoryIds: string[];
  active?: boolean;
}

export async function savePizzaExtra(input: PizzaExtraInput) {
  return requestJson<{ id: string }>(`/api/m/pizza/admin/extras`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function setPizzaExtraActive(extraId: string, active: boolean) {
  await requestJson<void>(`/api/m/pizza/admin/extras/${encodeURIComponent(extraId)}/active`, {
    method: "POST",
    body: JSON.stringify({ active })
  });
}

export async function removePizzaExtra(extraId: string) {
  const response = await requestJson<{ result: PizzaRemovalResult }>(
    `/api/m/pizza/admin/extras/${encodeURIComponent(extraId)}`,
    { method: "DELETE" }
  );
  return response.result;
}

export interface PizzaItemInput {
  id?: string;
  number: string | null;
  name: string;
  ingredients: string | null;
  allergens: string | null;
  categoryId: string;
  sortOrder?: number;
}

export interface PizzaCategoryInput {
  id?: string;
  name: string;
  sortOrder?: number;
  active?: boolean;
}

export async function savePizzaCategory(input: PizzaCategoryInput) {
  return requestJson<{ id: string }>(`/api/m/pizza/admin/categories`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function setPizzaCategoryActive(categoryId: string, active: boolean) {
  await requestJson<void>(`/api/m/pizza/admin/categories/${encodeURIComponent(categoryId)}/active`, {
    method: "POST",
    body: JSON.stringify({ active })
  });
}

export async function reorderPizzaCategories(ids: string[]) {
  await requestJson<void>(`/api/m/pizza/admin/categories/order`, {
    method: "POST",
    body: JSON.stringify({ ids })
  });
}

export async function deletePizzaCategory(categoryId: string) {
  await requestJson<void>(`/api/m/pizza/admin/categories/${encodeURIComponent(categoryId)}`, {
    method: "DELETE"
  });
}

export async function savePizzaItem(input: PizzaItemInput) {
  return requestJson<{ id: string }>(`/api/m/pizza/admin/items`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function setPizzaItemActive(itemId: string, active: boolean) {
  await requestJson<void>(`/api/m/pizza/admin/items/${encodeURIComponent(itemId)}/active`, {
    method: "POST",
    body: JSON.stringify({ active })
  });
}

export async function removePizzaItem(itemId: string) {
  const response = await requestJson<{ result: PizzaRemovalResult }>(
    `/api/m/pizza/admin/items/${encodeURIComponent(itemId)}`,
    { method: "DELETE" }
  );
  return response.result;
}

export interface PizzaVariantInput {
  id?: string;
  itemId: string;
  sizeLabel: string | null;
  priceCents: number;
  sortOrder?: number;
}

export async function savePizzaVariant(input: PizzaVariantInput) {
  return requestJson<{ id: string }>(`/api/m/pizza/admin/variants`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function setPizzaVariantActive(variantId: string, active: boolean) {
  await requestJson<void>(`/api/m/pizza/admin/variants/${encodeURIComponent(variantId)}/active`, {
    method: "POST",
    body: JSON.stringify({ active })
  });
}

export async function removePizzaVariant(variantId: string) {
  const response = await requestJson<{ result: PizzaRemovalResult }>(
    `/api/m/pizza/admin/variants/${encodeURIComponent(variantId)}`,
    { method: "DELETE" }
  );
  return response.result;
}

export async function setPizzaPaymentMode(mode: PizzaPaymentMode) {
  return requestJson<{ paymentMode: PizzaPaymentMode; paymentMethods: PizzaPaymentMethod[] }>(
    `/api/m/pizza/payment-mode`,
    { method: "PUT", body: JSON.stringify({ pizzaPaymentMethods: mode }) }
  );
}

export type PizzaMenuTransferFormat = "yaml" | "csv" | "extras_csv";

export interface PizzaMenuTransferIssue {
  line: number | null;
  code: string;
  params?: Record<string, string | number>;
}

export interface PizzaMenuTransferCounts {
  new: number;
  changed: number;
  unchanged: number;
  removed: number;
}

export interface PizzaMenuTransferResult {
  format: PizzaMenuTransferFormat;
  sections: { menu: boolean; extras: boolean };
  counts: Record<"categories" | "items" | "variants" | "extras", PizzaMenuTransferCounts>;
  errors: PizzaMenuTransferIssue[];
  /** z. B. viele Entfernungen; Übernehmen braucht dann `confirmRemovals`. */
  warnings: PizzaMenuTransferIssue[];
  /** Fingerabdruck des Menüs zum Zeitpunkt der Vorschau. */
  menuVersion: string;
}

export async function previewPizzaMenuTransfer(format: PizzaMenuTransferFormat, content: string) {
  return requestJson<PizzaMenuTransferResult>(`/api/m/pizza/admin/menu/transfer/preview`, {
    method: "POST",
    body: JSON.stringify({ format, content })
  });
}

export async function applyPizzaMenuTransfer(
  format: PizzaMenuTransferFormat,
  content: string,
  options: { expectedVersion?: string; confirmRemovals?: boolean } = {}
) {
  return requestJson<PizzaMenuTransferResult>(`/api/m/pizza/admin/menu/transfer/apply`, {
    method: "POST",
    body: JSON.stringify({
      format,
      content,
      ...(options.expectedVersion ? { expectedVersion: options.expectedVersion } : {}),
      ...(options.confirmRemovals ? { confirmRemovals: true } : {})
    })
  });
}
