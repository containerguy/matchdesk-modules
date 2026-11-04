import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createTestModule, type TestModule } from "@matchdesk/module-sdk/testing";
import { register } from "../src/server";

const moduleDir = path.resolve(import.meta.dirname, "..");
let module: TestModule | undefined;

afterEach(async () => {
  await module?.stop();
  module = undefined;
});

/** Testmodul mit Event „lan“; `core` baut vorher Kerntabellen wie private Events und Teilnehmer nach. */
async function start(core?: (mod: TestModule) => void) {
  const mod = await createTestModule({ moduleDir, register: () => undefined });
  mod.db.prepare("INSERT INTO main_events (id, name, status) VALUES ('lan', 'LAN Herbst', 'planned')").run();
  core?.(mod);
  register(mod.ctx);
  module = mod;
  return mod;
}

const as = (mod: TestModule, user: string) => {
  const base = (method: "get" | "post" | "patch" | "put" | "delete", url: string) =>
    request(mod.app)[method](`/api/m/extras${url}`).set("x-test-user", user);
  return {
    get: (url: string) => base("get", url),
    post: (url: string, body: object = {}) => base("post", url).send(body),
    patch: (url: string, body: object) => base("patch", url).send(body),
    put: (url: string, body: object) => base("put", url).send(body),
    delete: (url: string) => base("delete", url)
  };
};

describe("Modul Event-Extras", () => {
  it("führt Installations- und Mitbringliste", async () => {
    const mod = await start();
    await as(mod, "anna").post("/events/lan/items", { list: "install", title: "CS2" }).expect(403);
    await as(mod, "max").post("/events/lan/items", { list: "install", title: "CS2", url: "javascript:alert(1)" }).expect(400);
    let view = (await as(mod, "max").post("/events/lan/items", { list: "install", title: "CS2", url: "https://store.steampowered.com/app/730" }).expect(201))
      .body;
    const cs2 = view.install[0];
    view = (await as(mod, "anna").put(`/items/${cs2.id}/done`, { done: true }).expect(200)).body;
    expect(view.install[0]).toEqual(expect.objectContaining({ title: "CS2", doneCount: 1, doneByMe: true }));

    view = (await as(mod, "max").post("/events/lan/items", { list: "bring", title: "Mehrfachsteckdose", quantity: 4 }).expect(201)).body;
    const socket = view.bring[0];
    expect(socket).toEqual(expect.objectContaining({ quantity: 4, brought: 0 }));
    await as(mod, "anna").put(`/items/${socket.id}/bring`, { quantity: 2 }).expect(200);
    view = (await as(mod, "admin").put(`/items/${socket.id}/bring`, { quantity: 1 }).expect(200)).body;
    expect(view.bring[0]).toEqual(expect.objectContaining({ brought: 3, mine: 1 }));
    await as(mod, "anna").delete(`/items/${socket.id}`).expect(403);

    // Eigener Mitbring-Eintrag: gleich mit „ich bringe mit“
    view = (await as(mod, "anna").post("/events/lan/items", { list: "bring", title: "Switch 16 Port" }).expect(201)).body;
    expect(view.bring[1]).toEqual(expect.objectContaining({ title: "Switch 16 Port", brought: 1, mine: 1, canEdit: true }));
    expect(mod.broadcasts.every((entry) => entry.event === "extras_changed" && entry.data === undefined)).toBe(true);
  });

  it("verleiht Gegenstände und nimmt sie auch nach dem Event zurück", async () => {
    const mod = await start();
    const view = (await as(mod, "anna").post("/events/lan/items", { list: "lend", title: "Monitor 24\"" }).expect(201)).body;
    const monitor = view.lend[0];
    expect(monitor).toEqual(expect.objectContaining({ owner: expect.objectContaining({ username: "anna" }), out: false, canEdit: true }));
    await as(mod, "anna").post(`/items/${monitor.id}/borrow`).expect(400);
    await as(mod, "max").post(`/items/${monitor.id}/borrow`).expect(200);
    await as(mod, "admin").post(`/items/${monitor.id}/borrow`).expect(409);
    await as(mod, "anna").delete(`/items/${monitor.id}`).expect(409);

    mod.db.prepare("UPDATE main_events SET status = 'ended' WHERE id = 'lan'").run();
    await as(mod, "admin").post(`/items/${monitor.id}/return`).expect(200);
    const after = (await as(mod, "anna").get("/events/lan").expect(200)).body.lend[0];
    expect(after).toEqual(expect.objectContaining({ out: false, borrowedBy: expect.objectContaining({ username: "max" }) }));
    expect(after.returnedAt).toBeTruthy();
    expect(mod.audits.map((entry) => entry.action)).toEqual(["extras.lend_borrowed", "extras.lend_returned"]);
    await as(mod, "anna").post("/events/lan/items", { list: "lend", title: "Headset" }).expect(409);
  });

  it("verleiht als Besitzer an andere", async () => {
    const mod = await start();
    mod.db.prepare("INSERT INTO users (id, username, email, role) VALUES ('u-tom', 'tom', 'tom@example.test', 'user')").run();
    const monitor = (await as(mod, "anna").post("/events/lan/items", { list: "lend", title: "Controller" }).expect(201)).body.lend[0];
    await as(mod, "admin").post(`/items/${monitor.id}/borrow`, { userId: mod.userId("max") }).expect(200);
    await as(mod, "admin").post(`/items/${monitor.id}/return`).expect(200);
    // Fremde dürfen nicht für andere ausleihen
    await as(mod, "tom").post(`/items/${monitor.id}/borrow`, { userId: mod.userId("admin") }).expect(403);
    await as(mod, "anna").post(`/items/${monitor.id}/borrow`, { userId: mod.userId("max") }).expect(200);
    await as(mod, "max").post(`/items/${monitor.id}/return`).expect(200);
  });

  it("verwaltet den Unkostenbeitrag mit Meldung und Bestätigung", async () => {
    const mod = await start((m) => {
      m.db.exec(`CREATE TABLE main_event_participants (id TEXT PRIMARY KEY, main_event_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL)`);
      m.db.prepare("INSERT INTO main_event_participants (id, main_event_id, user_id, status) VALUES ('p1', 'lan', ?, 'joined'), ('p2', 'lan', ?, 'interested')")
        .run(m.userId("anna"), m.userId("max"));
    });
    await as(mod, "anna").put("/events/lan/payment", { method: "paypal" }).expect(409);
    await as(mod, "anna").put("/events/lan/cost", { amountCents: 1500 }).expect(403);
    await as(mod, "max").put("/events/lan/cost", { amountCents: 1500, paypalUrl: "https://paypal.me/lanparty", note: "Strom und Snacks" }).expect(200);

    let view = (await as(mod, "anna").put("/events/lan/payment", { method: "paypal" }).expect(200)).body;
    expect(view.cost).toEqual(
      expect.objectContaining({ amountCents: 1500, currency: "EUR", paypalUrl: "https://paypal.me/lanparty", mine: expect.objectContaining({ status: "reported" }) })
    );
    expect(view.cost.payments).toBeUndefined();

    view = (await as(mod, "max").get("/events/lan").expect(200)).body;
    expect(view.cost.payments).toEqual([
      { user: expect.objectContaining({ username: "anna" }), payment: expect.objectContaining({ method: "paypal", status: "reported" }) }
    ]);
    await as(mod, "max").put(`/events/lan/payments/${mod.userId("anna")}`, { status: "confirmed" }).expect(200);
    await as(mod, "anna").put("/events/lan/payment", { method: null }).expect(409);
    // Bar vor Ort, ohne vorherige Meldung
    view = (await as(mod, "max").put(`/events/lan/payments/${mod.userId("admin")}`, { status: "confirmed", method: "cash" }).expect(200)).body;
    expect(view.cost.payments.map((entry: { user: { username: string }; payment: { status: string } }) => [entry.user.username, entry.payment.status])).toEqual([
      ["anna", "confirmed"],
      ["admin", "confirmed"]
    ]);
    expect(mod.audits.map((entry) => entry.action)).toEqual(["extras.cost_set", "extras.payment_confirmed", "extras.payment_confirmed"]);
  });

  it("organisiert Fahrgemeinschaften mit begrenzten Plätzen", async () => {
    const mod = await start();
    mod.db.prepare("INSERT INTO users (id, username, email, role) VALUES ('u-tom', 'tom', 'tom@example.test', 'user')").run();
    let view = (await as(mod, "anna").post("/events/lan/rides", { direction: "there", startPlace: "Köln Hbf", seats: 1, departsAt: "2026-12-04T16:00:00+01:00" }).expect(201))
      .body;
    const ride = view.rides[0];
    expect(ride).toEqual(expect.objectContaining({ startPlace: "Köln Hbf", seats: 1, free: 1, departsAt: "2026-12-04T15:00:00.000Z", canEdit: true }));
    await as(mod, "anna").put(`/rides/${ride.id}/seat`, {}).expect(400);
    await as(mod, "max").put(`/rides/${ride.id}/seat`, {}).expect(200);
    await as(mod, "tom").put(`/rides/${ride.id}/seat`, {}).expect(409);
    await as(mod, "anna").patch(`/rides/${ride.id}`, { seats: 0 }).expect(400);
    view = (await as(mod, "anna").patch(`/rides/${ride.id}`, { seats: 3 }).expect(200)).body;
    expect(view.rides[0]).toEqual(expect.objectContaining({ free: 2, passengers: [expect.objectContaining({ username: "max" })] }));
    await as(mod, "tom").put(`/rides/${ride.id}/seat`, {}).expect(200);
    await as(mod, "tom").delete(`/rides/${ride.id}/seat`).expect(200);
    await as(mod, "tom").delete(`/rides/${ride.id}`).expect(403);
    view = (await as(mod, "anna").delete(`/rides/${ride.id}`).expect(200)).body;
    expect(view.rides).toEqual([]);
  });

  it("stellt Zusatzfragen und exportiert die Antworten als CSV", async () => {
    const mod = await start();
    await as(mod, "anna").post("/events/lan/fields", { label: "Bringe eigenen PC mit", kind: "checkbox" }).expect(403);
    await as(mod, "max").post("/events/lan/fields", { label: "Bringe eigenen PC mit", kind: "checkbox" }).expect(201);
    await as(mod, "max").post("/events/lan/fields", { label: "Übernachtung", kind: "choice", choices: ["ja"] }).expect(400);
    await as(mod, "max").post("/events/lan/fields", { label: "Übernachtung", kind: "choice", choices: ["Zelt", "Isomatte im Saal", "nein"] }).expect(201);
    let view = (await as(mod, "max").post("/events/lan/fields", { label: "Ankunft", kind: "text" }).expect(201)).body;
    const [pc, sleep, arrival] = view.fields;

    await as(mod, "anna").put("/events/lan/answers", { answers: { [sleep.id]: "Hotel" } }).expect(400);
    view = (
      await as(mod, "anna")
        .put("/events/lan/answers", { answers: { [pc.id]: "yes", [sleep.id]: "Zelt", [arrival.id]: '=HYPERLINK("x");Fr 18 Uhr' } })
        .expect(200)
    ).body;
    expect(view.fields.map((field: { mine: string | null }) => field.mine)).toEqual(["yes", "Zelt", '=HYPERLINK("x");Fr 18 Uhr']);
    expect(view.fields[0].answers).toBeUndefined();

    const csv = await as(mod, "max").get("/events/lan/answers.csv").expect(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    const lines = csv.text.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Benutzer;Anzeigename;Bringe eigenen PC mit;Übernachtung;Ankunft");
    expect(lines[1]).toBe(`anna;;yes;Zelt;"'=HYPERLINK(""x"");Fr 18 Uhr"`);
    await as(mod, "anna").get("/events/lan/answers.csv").expect(403);
  });

  it("vergibt Verwalten pro Event und hält private Events privat", async () => {
    const mod = await start((m) => {
      m.db.exec(`
        ALTER TABLE main_events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
        CREATE TABLE main_event_invites (id TEXT PRIMARY KEY, main_event_id TEXT NOT NULL, user_id TEXT NOT NULL);
        INSERT INTO main_events (id, name, visibility) VALUES ('secret', 'Geheim', 'private');
      `);
    });
    mod.grant("anna", "extras.manage", "lan");
    await as(mod, "anna").put("/events/lan/cost", { amountCents: 500 }).expect(200);
    expect((await as(mod, "anna").get("/events").expect(200)).body.events).toEqual([
      expect.objectContaining({ id: "lan", canManage: true })
    ]);
    await as(mod, "anna").get("/events/secret").expect(404);
    await as(mod, "max").get("/events/secret").expect(404);
    const item = (await as(mod, "admin").post("/events/secret/items", { list: "lend", title: "Beamer" }).expect(201)).body.lend[0];
    await as(mod, "anna").post(`/items/${item.id}/borrow`).expect(404);

    mod.db.prepare("INSERT INTO main_event_invites (id, main_event_id, user_id) VALUES ('i1', 'secret', ?)").run(mod.userId("anna"));
    expect((await as(mod, "anna").get("/events/secret").expect(200)).body.canManage).toBe(false);
    await as(mod, "anna").put("/events/secret/cost", { amountCents: 500 }).expect(403);
  });

  it("räumt beim Deinstallieren alle eigenen Tabellen weg", async () => {
    const mod = await start();
    mod.db.exec(fs.readFileSync(path.join(moduleDir, "uninstall.sql"), "utf8"));
    const left = mod.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'extras\\_%' ESCAPE '\\'").all();
    expect(left).toEqual([]);
  });
});
