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

describe("Modul Hallo", () => {
  it("zeigt die Pinnwand allen mit hallo.view, schreiben dürfen Organisatoren und höher", async () => {
    module = await createTestModule({ moduleDir, register });
    await request(module.app).get("/api/m/hallo/notes").expect(401);
    const anna = await request(module.app).get("/api/m/hallo/notes").set("x-test-user", "anna").expect(200);
    expect(anna.body).toEqual(expect.objectContaining({ greeting: "Hallo und willkommen!", canPost: false, notes: [] }));
    await request(module.app).post("/api/m/hallo/notes").set("x-test-user", "anna").send({ text: "Hi" }).expect(403);

    await request(module.app).post("/api/m/hallo/notes").set("x-test-user", "max").send({ text: "Pizza um 20 Uhr" }).expect(201);
    const notes = (await request(module.app).get("/api/m/hallo/notes").set("x-test-user", "anna").expect(200)).body.notes;
    expect(notes).toEqual([expect.objectContaining({ text: "Pizza um 20 Uhr", author: "max" })]);
    expect(module.broadcasts).toEqual([{ event: "notes_changed", data: undefined }]);
    expect(module.audits[0]).toEqual(expect.objectContaining({ action: "hallo.note_created" }));

    // fremde Notiz löschen nur mit hallo.manage
    await request(module.app).delete(`/api/m/hallo/notes/${notes[0].id}`).set("x-test-user", "anna").expect(403);
    await request(module.app).delete(`/api/m/hallo/notes/${notes[0].id}`).set("x-test-user", "admin").expect(204);
  });

  it("erlaubt hallo.post auch nur für ein Event", async () => {
    module = await createTestModule({ moduleDir, register });
    module.db.prepare("INSERT INTO main_events (id, name) VALUES ('lan-1', 'LAN 1')").run();
    module.grant("anna", "hallo.post", "lan-1");
    await request(module.app).post("/api/m/hallo/notes").set("x-test-user", "anna").send({ text: "global" }).expect(403);
    await request(module.app)
      .post("/api/m/hallo/notes")
      .set("x-test-user", "anna")
      .send({ text: "fürs Event", mainEventId: "lan-1" })
      .expect(201);
  });

  it("benachrichtigt auf Wunsch alle Leser und begrenzt die Liste laut Einstellung", async () => {
    module = await createTestModule({ moduleDir, register, settings: { notifyOnPost: true, maxNotes: 1 } });
    await request(module.app).post("/api/m/hallo/notes").set("x-test-user", "max").send({ text: "eins" }).expect(201);
    await request(module.app).post("/api/m/hallo/notes").set("x-test-user", "max").send({ text: "zwei" }).expect(201);
    expect(module.pushes[0].userIds.sort()).toEqual([module.userId("admin"), module.userId("anna")].sort());
    expect((await request(module.app).get("/api/m/hallo/notes").set("x-test-user", "anna")).body.notes).toHaveLength(1);
  });

  it("räumt beim Deinstallieren alle eigenen Tabellen weg", async () => {
    module = await createTestModule({ moduleDir, register });
    module.db.exec(fs.readFileSync(path.join(moduleDir, "uninstall.sql"), "utf8"));
    const left = module.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'hallo\\_%' ESCAPE '\\'").all();
    expect(left).toEqual([]);
  });
});
