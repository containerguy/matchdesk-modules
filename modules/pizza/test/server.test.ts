import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestModule, type TestModule } from "@matchdesk/module-sdk/testing";
import { register } from "../src/server";

const moduleDir = path.resolve(import.meta.dirname, "..");
let mod: TestModule;

beforeEach(async () => {
  mod = await createTestModule({
    moduleDir,
    register,
    settings: { paypalHandle: "lanpizza" },
    users: [
      { username: "admin", role: "admin" },
      { username: "pizzachef", role: "manager" },
      { username: "orga", role: "organizer" },
      { username: "gast", role: "user" }
    ]
  });
});

afterEach(async () => {
  await mod.stop();
});

const as = (username: string) => ({
  get: (url: string) => request(mod.app).get(`/api/m/pizza${url}`).set("x-test-user", username),
  post: (url: string, body: unknown = {}) => request(mod.app).post(`/api/m/pizza${url}`).set("x-test-user", username).send(body as object),
  put: (url: string, body: unknown = {}) => request(mod.app).put(`/api/m/pizza${url}`).set("x-test-user", username).send(body as object),
  del: (url: string) => request(mod.app).delete(`/api/m/pizza${url}`).set("x-test-user", username)
});

describe("Pizza-Modul", () => {
  it("braucht eine Anmeldung und bringt das Startmenü mit", async () => {
    await request(mod.app).get("/api/m/pizza/state").expect(401);
    const state = (await as("gast").get("/state").expect(200)).body;
    expect(state).toMatchObject({ mainEventId: null, session: null, canManage: false, canOrder: true });
    expect(state.menu.length).toBeGreaterThan(50);
    expect(state.paymentMethods).toEqual(["cash", "paypal"]);
    expect(state.payment).toEqual({ paypalHandle: "lanpizza", paypalName: "", cashRecipient: "" });
  });

  it("öffnet eine Runde, nimmt Bestellungen an und rechnet ab", async () => {
    await as("gast").post("/transitions", { transition: "open" }).expect(403);
    await as("pizzachef").post("/transitions", { transition: "open" }).expect(200);
    expect(mod.pushes.at(-1)).toMatchObject({ to: "all", payload: { url: "/#m/pizza" } });
    expect(mod.broadcasts.at(-1)).toEqual({ event: "changed", data: { reason: "pizza_session_open" } });
    expect(mod.audits.at(-1)).toMatchObject({ action: "pizza.session.open" });

    await as("gast").post("/lines", { variantId: "v-001-30", qty: 2 }).expect(201);
    await as("pizzachef").post("/transitions", { transition: "lock" }).expect(200);
    const state = (await as("pizzachef").get("/state").expect(200)).body;
    expect(state.orders).toHaveLength(1);
    expect(state.orders[0].user.username).toBe("gast");
    await as("pizzachef").post(`/orders/${state.orders[0].id}/payment`, { method: "cash" }).expect(204);
    const pdf = await as("pizzachef").get("/print/kassenliste.pdf").expect(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    await as("pizzachef").get("/print/pizzeria.pdf").expect(200);
  });

  it("ändert die Bezahlarten über die Moduleinstellungen", async () => {
    await as("pizzachef").put("/payment-mode", { pizzaPaymentMethods: "cash_only" }).expect(200);
    expect(mod.ctx.settings.get()).toMatchObject({ paymentMethods: "cash_only", paypalHandle: "lanpizza" });
    const state = (await as("gast").get("/state").expect(200)).body;
    expect(state.paymentMethods).toEqual(["cash"]);
  });

  it("führt eine Runde je Event, nur Teilnehmer bestellen", async () => {
    mod.addEvent({ id: "lan", name: "LAN Herbst" });
    await as("pizzachef").post("/transitions?mainEventId=lan", { transition: "open" }).expect(200);
    expect(mod.pushes.at(-1)).toMatchObject({ to: "event:lan" });

    const before = (await as("gast").get("/state?mainEventId=lan").expect(200)).body;
    expect(before).toMatchObject({ mainEventId: "lan", mainEventName: "LAN Herbst", canOrder: false });
    const refused = await as("gast").post("/lines?mainEventId=lan", { variantId: "v-001-30", qty: 1 });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("pizza_nur_teilnehmer");

    mod.join("gast", "lan");
    await as("gast").post("/lines?mainEventId=lan", { variantId: "v-001-30", qty: 1 }).expect(201);
    const none = (await as("gast").get("/state?mainEventId=none").expect(200)).body;
    expect(none.session).toBeNull();

    // Ohne Angabe gilt das aktuelle Event des Benutzers.
    mod.setCurrentEvent("gast", "lan");
    const current = (await as("gast").get("/state").expect(200)).body;
    expect(current.mainEventId).toBe("lan");
    expect(current.myOrder.lines).toHaveLength(1);
  });

  it("lässt Event-Verwalter nur ihre Runde führen und versteckt private Events", async () => {
    mod.addEvent({ id: "lan", name: "LAN Herbst" });
    mod.addEvent({ id: "cup", name: "Turnier" });
    mod.addEvent({ id: "geheim", name: "Geheim", visibility: "private" });
    mod.grant("gast", "pizza.manage", "lan");

    await as("gast").post("/transitions?mainEventId=lan", { transition: "open" }).expect(200);
    await as("gast").post("/transitions?mainEventId=cup", { transition: "open" }).expect(403);
    await as("gast").post("/transitions?mainEventId=none", { transition: "open" }).expect(403);
    await as("gast").get("/admin/menu").expect(403);
    await as("gast").get("/state?mainEventId=geheim").expect(404);
    mod.invite("gast", "geheim");
    await as("gast").get("/state?mainEventId=geheim").expect(200);

    const state = (await as("gast").get("/state?mainEventId=lan").expect(200)).body;
    await as("gast").post(`/sessions/${state.session.id}/archive`).expect(200);
    const archived = (await as("gast").get("/sessions/archived").expect(200)).body.sessions;
    expect(archived[0]).toMatchObject({ mainEventId: "lan", mainEventName: "LAN Herbst" });
  });

  it("verweigert Runden für beendete Events", async () => {
    await as("pizzachef").get("/state?mainEventId=gibt-es-nicht").expect(404);
    mod.addEvent({ id: "alt", name: "Vorbei", status: "ended" });
    const refused = await as("pizzachef").post("/transitions?mainEventId=alt", { transition: "open" });
    expect(refused.status).toBe(409);
  });
});
