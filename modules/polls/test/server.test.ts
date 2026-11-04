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

const as = (mod: TestModule, user: string) => ({
  get: (url: string) => request(mod.app).get(`/api/m/polls${url}`).set("x-test-user", user),
  post: (url: string, body: unknown = {}) => request(mod.app).post(`/api/m/polls${url}`).set("x-test-user", user).send(body as object),
  patch: (url: string, body: unknown) => request(mod.app).patch(`/api/m/polls${url}`).set("x-test-user", user).send(body as object),
  put: (url: string, body: unknown) => request(mod.app).put(`/api/m/polls${url}`).set("x-test-user", user).send(body as object),
  delete: (url: string) => request(mod.app).delete(`/api/m/polls${url}`).set("x-test-user", user)
});

describe("Modul Abstimmungen", () => {
  it("legt eine Spiele-Abstimmung an und zählt Stimmen", async () => {
    const mod = await createTestModule({ moduleDir, register });
    module = mod;
    await as(mod, "anna").post("/polls", { kind: "game", title: "Was spielen wir?", options: [{ label: "CS2" }, { label: "AoE" }] }).expect(403);
    const created = (
      await as(mod, "max")
        .post("/polls", { kind: "game", title: "Was spielen wir?", options: [{ label: "CS2" }, { label: "AoE" }] })
        .expect(201)
    ).body;
    expect(created).toEqual(expect.objectContaining({ kind: "game", multiple: false, open: true, canManage: true }));
    expect(mod.pushes[0]).toEqual(expect.objectContaining({ payload: expect.objectContaining({ title: "Neue Abstimmung", body: "Was spielen wir?" }) }));
    expect(mod.pushes[0].userIds.sort()).toEqual([mod.userId("admin"), mod.userId("anna")].sort());

    const [cs2, aoe] = created.options;
    await as(mod, "anna").put(`/polls/${created.id}/vote`, { votes: [{ optionId: cs2.id }, { optionId: aoe.id }] }).expect(400);
    await as(mod, "anna").put(`/polls/${created.id}/vote`, { votes: [{ optionId: cs2.id }] }).expect(200);
    const voted = (await as(mod, "admin").put(`/polls/${created.id}/vote`, { votes: [{ optionId: cs2.id }] }).expect(200)).body;
    expect(voted.options[0]).toEqual(expect.objectContaining({ label: "CS2", yes: 2, mine: "yes" }));
    expect(voted.options[0].voters.map((voter: { username: string }) => voter.username).sort()).toEqual(["admin", "anna"]);
    expect(voted.voterCount).toBe(2);

    // Stimme ändern ersetzt die alte
    const changed = (await as(mod, "anna").put(`/polls/${created.id}/vote`, { votes: [{ optionId: aoe.id }] }).expect(200)).body;
    expect(changed.options.map((option: { yes: number }) => option.yes)).toEqual([1, 1]);
    expect(mod.broadcasts.every((entry) => entry.event === "polls_changed" && entry.data === undefined)).toBe(true);
  });

  it("findet Termine mit ja, vielleicht und nein", async () => {
    const mod = await createTestModule({ moduleDir, register });
    module = mod;
    await as(mod, "max").post("/polls", { kind: "date", title: "Wann?", options: [{ label: "Fr" }, { label: "Sa" }] }).expect(400);
    const poll = (
      await as(mod, "max")
        .post("/polls", {
          kind: "date",
          title: "Wann ist die nächste LAN?",
          options: [
            { label: "Fr", startsAt: "2026-12-04T18:00:00+01:00" },
            { label: "Sa", startsAt: "2026-12-05T14:00:00+01:00" }
          ]
        })
        .expect(201)
    ).body;
    expect(poll.multiple).toBe(true);
    const [friday, saturday] = poll.options;
    const result = (
      await as(mod, "anna")
        .put(`/polls/${poll.id}/vote`, { votes: [{ optionId: friday.id, value: "maybe" }, { optionId: saturday.id, value: "no" }] })
        .expect(200)
    ).body;
    expect(result.options.map((option: { yes: number; maybe: number; no: number }) => [option.yes, option.maybe, option.no])).toEqual([
      [0, 1, 0],
      [0, 0, 1]
    ]);
    expect(result.voterCount).toBe(1);
  });

  it("nimmt Vorschläge an, wenn erlaubt, und lässt eigene zurückziehen", async () => {
    const mod = await createTestModule({ moduleDir, register });
    module = mod;
    const poll = (await as(mod, "max").post("/polls", { kind: "food", title: "Essen am Samstag", allowSuggestions: true, multiple: true }).expect(201)).body;
    const withPizza = (await as(mod, "anna").post(`/polls/${poll.id}/options`, { label: "Pizza" }).expect(201)).body;
    await as(mod, "admin").post(`/polls/${poll.id}/options`, { label: "pizza" }).expect(409);
    await as(mod, "admin").post(`/polls/${poll.id}/options`, { label: "Burger" }).expect(201);
    const pizza = withPizza.options[0];
    expect(pizza).toEqual(expect.objectContaining({ label: "Pizza", suggested: true }));

    await as(mod, "admin").put(`/polls/${poll.id}/vote`, { votes: [{ optionId: pizza.id }] }).expect(200);
    // Mit fremder Stimme nicht mehr zurückziehbar, Verwalter dürfen immer.
    await as(mod, "anna").delete(`/polls/${poll.id}/options/${pizza.id}`).expect(403);
    await as(mod, "max").delete(`/polls/${poll.id}/options/${pizza.id}`).expect(200);

    await as(mod, "max").patch(`/polls/${poll.id}`, { allowSuggestions: false }).expect(200);
    await as(mod, "anna").post(`/polls/${poll.id}/options`, { label: "Döner" }).expect(403);
  });

  it("schließt per Hand, per Frist und mit dem Eventende", async () => {
    const mod = await createTestModule({ moduleDir, register, settings: { notifyOnCreate: false } });
    module = mod;
    mod.db.prepare("INSERT INTO main_events (id, name, status) VALUES ('lan-1', 'LAN 1', 'running')").run();
    const options = [{ label: "A" }, { label: "B" }];
    const manual = (await as(mod, "max").post("/polls", { kind: "other", title: "Hand", options }).expect(201)).body;
    await as(mod, "max").patch(`/polls/${manual.id}`, { closed: true }).expect(200);
    await as(mod, "anna").put(`/polls/${manual.id}/vote`, { votes: [{ optionId: manual.options[0].id }] }).expect(409);

    const past = (await as(mod, "max").post("/polls", { kind: "other", title: "Frist", options, closesAt: "2020-01-01T00:00:00Z" }).expect(201)).body;
    expect(past.open).toBe(false);
    // Mit Zeitzone angegeben, in UTC gespeichert und richtig verglichen.
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    const local = `${new Date(soon.getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 19)}+02:00`;
    const future = (await as(mod, "max").post("/polls", { kind: "other", title: "Später", options, closesAt: local }).expect(201)).body;
    expect(future).toEqual(expect.objectContaining({ open: true, closesAt: soon.toISOString().slice(0, 19) + ".000Z" }));

    const eventPoll = (await as(mod, "max").post("/polls", { kind: "game", title: "Event", mainEventId: "lan-1", options }).expect(201)).body;
    expect(eventPoll).toEqual(expect.objectContaining({ mainEventName: "LAN 1", open: true }));
    mod.db.prepare("UPDATE main_events SET status = 'ended' WHERE id = 'lan-1'").run();
    expect((await as(mod, "anna").get(`/polls/${eventPoll.id}`).expect(200)).body.open).toBe(false);
    await as(mod, "max").patch(`/polls/${eventPoll.id}`, { closed: false }).expect(409);
    await as(mod, "max").post("/polls", { kind: "game", title: "Zu spät", mainEventId: "lan-1", options }).expect(409);
    expect(mod.pushes).toEqual([]);
  });

  it("vergibt das Verwalten pro Event und hält private Events privat", async () => {
    const mod = await createTestModule({ moduleDir, register: () => undefined });
    // Kern mit privaten Events nachbauen, dann das Modul starten.
    mod.db.exec(`
      INSERT INTO main_events (id, name, visibility) VALUES ('open', 'Offen', 'public'), ('secret', 'Geheim', 'private');
    `);
    register(mod.ctx);
    module = mod;
    const options = [{ label: "A" }, { label: "B" }];

    mod.grant("anna", "polls.manage", "open");
    await as(mod, "anna").post("/polls", { kind: "game", title: "Global", options }).expect(403);
    const own = (await as(mod, "anna").post("/polls", { kind: "game", title: "Offen", mainEventId: "open", options }).expect(201)).body;
    expect(own.canManage).toBe(true);
    const events = (await as(mod, "anna").get("/events").expect(200)).body;
    expect(events).toEqual({ canManageGlobal: false, events: [expect.objectContaining({ id: "open", manageable: true })] });

    // Verwalten allein reicht nicht für private Events: wie im Kern braucht es eine Einladung oder Event-Verwaltung.
    await as(mod, "max").post("/polls", { kind: "game", title: "Geheim", mainEventId: "secret", options }).expect(400);
    const pushesBefore = mod.pushes.length;
    const secret = (await as(mod, "admin").post("/polls", { kind: "game", title: "Geheim", mainEventId: "secret", options }).expect(201)).body;
    expect(mod.pushes).toHaveLength(pushesBefore);
    await as(mod, "max").get(`/polls/${secret.id}`).expect(404);
    await as(mod, "anna").get(`/polls/${secret.id}`).expect(404);
    await as(mod, "anna").put(`/polls/${secret.id}/vote`, { votes: [] }).expect(404);
    expect((await as(mod, "anna").get("/polls").expect(200)).body.polls.map((poll: { title: string }) => poll.title)).toEqual(["Offen"]);

    mod.db.prepare("INSERT INTO main_event_invites (id, main_event_id, user_id) VALUES ('i1', 'secret', ?)").run(mod.userId("anna"));
    expect((await as(mod, "anna").get("/polls").expect(200)).body.polls).toHaveLength(2);
    expect((await as(mod, "anna").get(`/polls/${secret.id}`).expect(200)).body.canManage).toBe(false);
  });

  it("zeigt bei geheimen Abstimmungen keine Namen, Verwaltern schon", async () => {
    const mod = await createTestModule({ moduleDir, register });
    module = mod;
    const poll = (await as(mod, "max").post("/polls", { kind: "other", title: "Geheim", anonymous: true, options: [{ label: "A" }, { label: "B" }] }).expect(201)).body;
    await as(mod, "anna").put(`/polls/${poll.id}/vote`, { votes: [{ optionId: poll.options[0].id }] }).expect(200);
    const seenByAdmin = (await as(mod, "admin").get(`/polls/${poll.id}`).expect(200)).body;
    expect(seenByAdmin.options[0].voters).toHaveLength(1);
    const seenByMax = (await as(mod, "max").get(`/polls/${poll.id}`).expect(200)).body;
    expect(seenByMax.options[0].voters).toHaveLength(1);
    mod.db.prepare("INSERT INTO users (id, username, email, role) VALUES ('u-tom', 'tom', 'tom@example.test', 'user')").run();
    const seenByTom = (await as(mod, "tom").get(`/polls/${poll.id}`).expect(200)).body;
    expect(seenByTom.options[0]).toEqual(expect.objectContaining({ yes: 1, voters: [] }));
    await as(mod, "tom").delete(`/polls/${poll.id}`).expect(403);
    await as(mod, "max").delete(`/polls/${poll.id}`).expect(204);
    expect(mod.db.prepare("SELECT COUNT(*) AS count FROM polls_votes").get()).toEqual({ count: 0 });
  });

  it("räumt beim Deinstallieren alle eigenen Tabellen weg", async () => {
    const mod = await createTestModule({ moduleDir, register });
    module = mod;
    mod.db.exec(fs.readFileSync(path.join(moduleDir, "uninstall.sql"), "utf8"));
    const left = mod.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'polls\\_%' ESCAPE '\\'").all();
    expect(left).toEqual([]);
  });
});
