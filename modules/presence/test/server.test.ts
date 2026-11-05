import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createTestModule, type TestModule } from "@matchdesk/module-sdk/testing";
import { register, type PresenceOptions } from "../src/server";

const moduleDir = path.resolve(import.meta.dirname, "..");
let mod: TestModule | undefined;

async function start(options: PresenceOptions = {}) {
  mod = await createTestModule({
    moduleDir,
    register: (ctx) => register(ctx, { agentPath: "", ...options }),
    users: [
      { username: "rene", role: "admin" },
      { username: "gast", role: "user" }
    ]
  });
  return mod;
}

afterEach(async () => {
  await mod?.stop();
  mod = undefined;
});

const base = "/api/m/presence";
const as = (username: string) => ({
  get: (url: string) => request(mod!.app).get(`${base}${url}`).set("x-test-user", username),
  post: (url: string, body: unknown = {}) =>
    request(mod!.app).post(`${base}${url}`).set("x-test-user", username).send(body as object),
  put: (url: string, body: unknown = {}) =>
    request(mod!.app).put(`${base}${url}`).set("x-test-user", username).send(body as object),
  del: (url: string) => request(mod!.app).delete(`${base}${url}`).set("x-test-user", username)
});
const agent = (key: string) => ({
  post: (body: unknown) => request(mod!.app).post(`${base}/game`).set("Authorization", `Bearer ${key}`).send(body as object),
  del: () => request(mod!.app).delete(`${base}/game`).set("Authorization", `Bearer ${key}`)
});

/** Wie der Agent: Einmalcode auf der Seite holen, dann ohne Anmeldung gegen den Schlüssel tauschen. */
async function pairAgent(username: string) {
  const { body } = await as(username).post("/agent/pair-code").expect(201);
  const paired = await request(mod!.app).post(`${base}/agent/pair`).send({ code: body.code }).expect(201);
  return paired.body.key as string;
}

describe("Modul „Spielt gerade“", () => {
  it("braucht eine Anmeldung und zeigt gemeldete Spiele ohne Rechnernamen", async () => {
    await start();
    await request(mod!.app).get(base).expect(401);
    await request(mod!.app).post(`${base}/game`).send({ playing: [] }).expect(401);

    await as("gast")
      .post("/game", {
        host: "DESKTOP-M4PJL0I",
        playing: [{ title: "Counter-Strike 2", launcher: "steam", appId: "730", exe: "", source: "steam-registry" }]
      })
      .expect(204);
    const list = await as("rene").get("/").expect(200);
    expect(list.body.players).toHaveLength(1);
    expect(list.body.players[0]).toMatchObject({
      username: "gast",
      games: [{ title: "Counter-Strike 2", launcher: "steam", appId: "730" }]
    });
    expect(JSON.stringify(list.body)).not.toContain("DESKTOP");
    expect(list.body.agentAvailable).toBe(false);

    await as("gast").post("/game", { playing: "kaputt" }).expect(400);
    await as("gast").del("/game").expect(204);
    expect((await as("rene").get("/").expect(200)).body.players).toEqual([]);
  });

  it("verbindet den Agenten über einen Einmalcode, der Schlüssel taugt nur für den Agenten", async () => {
    await start();
    const { body: pairCode } = await as("rene").post("/agent/pair-code").expect(201);
    expect(pairCode.code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    await request(mod!.app).post(`${base}/agent/pair-code`).expect(401);

    const formatted = `${pairCode.code.slice(0, 4).toLowerCase()}-${pairCode.code.slice(4)}`;
    const paired = await request(mod!.app).post(`${base}/agent/pair`).send({ code: formatted }).expect(201);
    expect(paired.body).toMatchObject({ username: "rene" });
    const key = paired.body.key as string;
    expect(key.startsWith("md_ga_")).toBe(true);
    await request(mod!.app).post(`${base}/agent/pair`).send({ code: pairCode.code }).expect(400, { error: "code_ungueltig" });

    await agent(key).post({ playing: [{ title: "Valheim", launcher: "steam", appId: "892970" }] }).expect(204);
    const list = await as("rene").get("/").expect(200);
    expect(list.body.players[0].games[0].title).toBe("Valheim");
    expect(list.body.agentKey.lastUsedAt).toBeTruthy();
    expect(JSON.stringify(list.body)).not.toContain(key);

    await request(mod!.app).get(base).set("Authorization", `Bearer ${key}`).expect(401);
    await request(mod!.app).get(`${base}/accounts`).set("Authorization", `Bearer ${key}`).expect(401);
    await request(mod!.app).post(`${base}/agent/pair-code`).set("Authorization", `Bearer ${key}`).expect(401);
    const version = await request(mod!.app).get(`${base}/agent/version`).set("Authorization", `Bearer ${key}`).expect(200);
    expect(version.body).toEqual({ version: expect.any(String), available: false });

    // Neu verbinden macht den alten Schlüssel ungültig.
    const second = await pairAgent("rene");
    await agent(key).post({ playing: [] }).expect(401);

    await as("rene").del("/agent-key").expect(204);
    await agent(second).del().expect(401);
    const after = await as("rene").get("/").expect(200);
    expect(after.body.players).toEqual([]);
    expect(after.body.agentKey).toBeNull();
  });

  it("übernimmt das Steam-Konto vom Agenten und lässt den Rest im Profil pflegen", async () => {
    await start();
    const key = await pairAgent("rene");
    const report = (steamAccount: unknown) => agent(key).post({ playing: [], steamAccount }).expect(204);

    const empty = await as("rene").get("/accounts/me").expect(200);
    expect(empty.body.missing).toEqual(["steam", "ea", "battlenet", "epic", "ubisoft"]);
    expect(empty.body.promptDismissed).toBe(false);

    await report({ steamId: "nope" });
    await report({ steamId: "76561198000000001", personaName: "René" });
    let me = await as("rene").get("/accounts/me").expect(200);
    expect(me.body.accounts.steam).toEqual({ accountId: "76561198000000001", displayName: "René", source: "agent" });

    await report({ steamId: "76561198000000002", personaName: "Zweitkonto" });
    me = await as("rene").get("/accounts/me").expect(200);
    expect(me.body.accounts.steam.pending).toEqual({ accountId: "76561198000000002", displayName: "Zweitkonto" });
    me = await as("rene").post("/accounts/me/steam/accept").expect(200);
    expect(me.body.accounts.steam).toEqual({ accountId: "76561198000000002", displayName: "Zweitkonto", source: "agent" });
    await as("rene").post("/accounts/me/steam/accept").expect(404);

    await as("rene").put("/accounts/me", { steam: "kein-link" }).expect(400, { error: "steam_id_ungueltig" });
    me = await as("rene")
      .put("/accounts/me", { steam: "https://steamcommunity.com/profiles/76561198000000003/", battlenet: "Rene#2345", ea: "  " })
      .expect(200);
    expect(me.body.accounts.steam).toEqual({ accountId: "76561198000000003", displayName: null, source: "manual" });
    expect(me.body.missing).toEqual(["ea", "epic", "ubisoft"]);

    await as("rene").post("/accounts/me/prompt-dismiss").expect(204);
    expect((await as("rene").get("/accounts/me").expect(200)).body.promptDismissed).toBe(true);

    const all = await as("gast").get("/accounts").expect(200);
    expect(all.body.users).toHaveLength(1);
    expect(all.body.users[0].accounts.battlenet).toEqual({ accountId: "Rene#2345", displayName: null });
    await request(mod!.app).get(`${base}/accounts/me`).set("Authorization", `Bearer ${key}`).expect(401);
  });

  it("lässt Einmalcodes ablaufen und bremst das Durchprobieren", async () => {
    let clock = Date.parse("2026-11-04T20:00:00Z");
    await start({ now: () => clock });
    const { body } = await as("gast").post("/agent/pair-code").expect(201);
    const { body: newer } = await as("gast").post("/agent/pair-code").expect(201);
    // Nur der neueste Code eines Benutzers gilt.
    await request(mod!.app).post(`${base}/agent/pair`).send({ code: body.code }).expect(400);
    clock += 5 * 60_000;
    await request(mod!.app).post(`${base}/agent/pair`).send({ code: newer.code }).expect(400);

    for (let i = 0; i < 19; i += 1) {
      await request(mod!.app).post(`${base}/agent/pair`).send({ code: "AAAAAAAA" }).expect(400);
    }
    const { body: fresh } = await as("gast").post("/agent/pair-code").expect(201);
    await request(mod!.app).post(`${base}/agent/pair`).send({ code: fresh.code }).expect(429);
    clock += 60_000;
    await request(mod!.app).post(`${base}/agent/pair`).send({ code: fresh.code }).expect(201);
  });

  it("liefert den Installer nur an Angemeldete und verbundene Agenten aus", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "presence-agent-"));
    const agentPath = path.join(dir, "matchdesk-agent-setup.exe");
    fs.writeFileSync(agentPath, "MZ-test");
    await start({ agentPath });
    expect((await as("gast").get("/").expect(200)).body.agentAvailable).toBe(true);
    const ok = await as("gast").get("/agent/download").expect(200);
    expect(ok.headers["content-disposition"]).toContain("Mitspielzentrale-Agent-Setup.exe");
    await request(mod!.app).get(`${base}/agent/download`).expect(401);
    await request(mod!.app).get(`${base}/agent/download`).set("Authorization", "Bearer md_ga_falsch").expect(401);
    const key = await pairAgent("gast");
    await request(mod!.app).get(`${base}/agent/download`).set("Authorization", `Bearer ${key}`).expect(200);
    expect((await as("gast").get("/agent/version").expect(200)).body.available).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
