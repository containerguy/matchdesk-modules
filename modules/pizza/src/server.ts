import type { ModuleContext } from "@matchdesk/module-sdk";
import { bindCore } from "./server/core";
import { createDatabaseContext } from "./server/db/client";
import { createPizzaRouter } from "./server/http/pizza-routes";

/** Pizzabestellung: Bestellrunden je Event, Speisekarte mit Kategorien und Extras, Kassenliste. */
export function register(ctx: ModuleContext) {
  bindCore(ctx);
  ctx.router.use(createPizzaRouter(createDatabaseContext(ctx.db)));
}
