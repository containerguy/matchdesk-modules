import { createHmac } from "node:crypto";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createTestModule, type TestModule } from "@matchdesk/module-sdk/testing";
import { register, verifySignature } from "../src/server";

const moduleDir = path.resolve(import.meta.dirname, "..");
let module: TestModule | undefined;

afterEach(async () => {
  await module?.stop();
  module = undefined;
});

const settings = {
  callbackBaseUrl: "http://matchdesk:3000",
  billiardApiUrl: "http://billiard:3000/game-servers/billiard"
};
const secrets = { BILLIARD_API_KEY: "key", BILLIARD_WEBHOOK_SECRET: "hook" };

/** Spielserver-Attrappe: merkt sich Aufrufe und antwortet wie matchdesk-billiard. */
function fakeGameServer(mod: TestModule) {
  const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
  mod.ctx.http.fetch = (async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init.method ?? "GET", body, auth: new Headers(init.headers).get("authorization") });
    if (init.method === "POST") {
      const players = (body as { players: Array<{ id: string }> }).players;
      return Response.json(
        { id: "tbl-1", code: "ABCDE", seats: players.map((p, seat) => ({ playerId: p.id, seat, token: `tok-${p.id}` })) },
        { status: 201 }
      );
    }
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;
  return calls;
}

function signed(body: unknown, secret = "hook", timestamp = String(Math.floor(Date.now() / 1000))) {
  const raw = JSON.stringify(body);
  const signature = "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return { raw, headers: { "x-bandenduell-timestamp": timestamp, "x-bandenduell-signature": signature, "content-type": "application/json" } };
}

async function challenge(mod: TestModule) {
  const res = await request(mod.app)
    .post("/api/m/arena/matches")
    .set("x-test-user", "anna")
    .send({ game: "billiard", opponentId: "u-max" })
    .expect(201);
  return res.body.match as { id: string; embedUrl: string; status: string };
}

describe("Modul Spiele (arena)", () => {
  it("bietet nur eingerichtete Spiele an", async () => {
    module = await createTestModule({ moduleDir, register });
    const empty = await request(module.app).get("/api/m/arena/games").set("x-test-user", "anna").expect(200);
    expect(empty.body.games).toEqual([]);
    await module.stop();
    module = await createTestModule({ moduleDir, register, settings, secrets });
    const games = await request(module.app).get("/api/m/arena/games").set("x-test-user", "anna").expect(200);
    expect(games.body.games.map((g: { id: string }) => g.id)).toEqual(["billiard"]);
    expect(games.body.games[0]).toMatchObject({ embedPath: "/game-servers/billiard/", computerLevels: ["easy", "medium", "hard"] });
    await request(module.app).get("/api/m/arena/games").expect(401);
  });

  it("legt bei einer Herausforderung einen reservierten Tisch an und gibt nur eigene Platz-Links heraus", async () => {
    module = await createTestModule({ moduleDir, register, settings, secrets });
    const calls = fakeGameServer(module);
    const match = await challenge(module);
    expect(calls[0]).toMatchObject({
      url: "http://billiard:3000/game-servers/billiard/api/integrations/v1/tables",
      method: "POST",
      auth: "Bearer key",
      body: {
        ref: match.id,
        callbackUrl: "http://matchdesk:3000/api/m/arena/webhook/billiard",
        players: [
          { id: "u-anna", name: "anna" },
          { id: "u-max", name: "max" }
        ]
      }
    });
    expect(match.embedUrl).toBe("/game-servers/billiard/?embed=1&seat=tok-u-anna");
    expect(module.pushes[0]).toMatchObject({ userIds: ["u-max"], payload: { url: `/#games/arena/billiard/match/${match.id}` } });

    const forMax = await request(module.app).get(`/api/m/arena/matches/${match.id}`).set("x-test-user", "max").expect(200);
    expect(forMax.body.match.embedUrl).toBe("/game-servers/billiard/?embed=1&seat=tok-u-max");
    const forAdmin = await request(module.app).get(`/api/m/arena/matches/${match.id}`).set("x-test-user", "admin").expect(200);
    expect(forAdmin.body.match.embedUrl).toBeNull();
  });

  it("lehnt sich selbst, Unbekannte und unbekannte Spiele als Gegner ab", async () => {
    module = await createTestModule({ moduleDir, register, settings, secrets });
    fakeGameServer(module);
    const post = (body: object) => request(module!.app).post("/api/m/arena/matches").set("x-test-user", "anna").send(body);
    await post({ game: "billiard", opponentId: "u-anna" }).expect(400);
    await post({ game: "billiard", opponentId: "u-niemand" }).expect(400);
    await post({ game: "schach", opponentId: "u-max" }).expect(400);
  });

  it("übernimmt das Ergebnis aus dem signierten Ereignis und lehnt falsche Signaturen ab", async () => {
    module = await createTestModule({ moduleDir, register, settings, secrets });
    fakeGameServer(module);
    const match = await challenge(module);
    const event = {
      type: "game.finished",
      reason: "won",
      table: {
        id: "tbl-1",
        ref: match.id,
        status: "finished",
        winner: "u-max",
        gamesPlayed: 1,
        players: [
          { id: "u-anna", score: 0 },
          { id: "u-max", score: 1 }
        ]
      }
    };
    const forged = signed(event, "falsch");
    await request(module.app).post("/api/m/arena/webhook/billiard").set(forged.headers).send(forged.raw).expect(401);
    const old = signed(event, "hook", String(Math.floor(Date.now() / 1000) - 3600));
    await request(module.app).post("/api/m/arena/webhook/billiard").set(old.headers).send(old.raw).expect(401);

    const ok = signed(event);
    await request(module.app).post("/api/m/arena/webhook/billiard").set(ok.headers).send(ok.raw).expect(204);
    const after = await request(module.app).get(`/api/m/arena/matches/${match.id}`).set("x-test-user", "anna").expect(200);
    expect(after.body.match).toMatchObject({
      status: "finished",
      challenger: { score: 0 },
      opponent: { score: 1 },
      winner: { id: "u-max", name: "max" },
      gamesPlayed: 1
    });
    const list = await request(module.app).get("/api/m/arena/matches?game=billiard").set("x-test-user", "admin").expect(200);
    expect(list.body.recent).toHaveLength(1);
    expect(module.audits.map((a) => a.action)).toContain("arena.match_finished");

    // Tisch später geschlossen: Ergebnis bleibt, Platz-Links gehen weg
    const closed = signed({ ...event, type: "table.closed" });
    await request(module.app).post("/api/m/arena/webhook/billiard").set(closed.headers).send(closed.raw).expect(204);
    const final = await request(module.app).get(`/api/m/arena/matches/${match.id}`).set("x-test-user", "anna").expect(200);
    expect(final.body.match).toMatchObject({ status: "finished", embedUrl: null });
  });

  it("sagt eine offene Herausforderung ab und schließt den Tisch", async () => {
    module = await createTestModule({ moduleDir, register, settings, secrets });
    const calls = fakeGameServer(module);
    const match = await challenge(module);
    await request(module.app).post(`/api/m/arena/matches/${match.id}/cancel`).set("x-test-user", "max").expect(200);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: expect.stringContaining("/tables/tbl-1") });
    const after = await request(module.app).get(`/api/m/arena/matches/${match.id}`).set("x-test-user", "anna").expect(200);
    expect(after.body.match).toMatchObject({ status: "cancelled", embedUrl: null });
    await request(module.app).post(`/api/m/arena/matches/${match.id}/cancel`).set("x-test-user", "anna").expect(409);
  });

  it("meldet einen nicht erreichbaren Spielserver", async () => {
    module = await createTestModule({ moduleDir, register, settings, secrets });
    module.ctx.http.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await request(module.app).post("/api/m/arena/matches").set("x-test-user", "anna").send({ game: "billiard", opponentId: "u-max" }).expect(502);
  });
});

describe("verifySignature", () => {
  it("prüft HMAC über Zeitstempel und rohen Body", () => {
    const raw = Buffer.from('{"a":1}');
    const sig = "sha256=" + createHmac("sha256", "s").update(`100.${raw}`).digest("hex");
    expect(verifySignature("s", "100", raw, sig, 100)).toBe(true);
    expect(verifySignature("s", "100", raw, sig, 1000)).toBe(false);
    expect(verifySignature("t", "100", raw, sig, 100)).toBe(false);
  });
});
