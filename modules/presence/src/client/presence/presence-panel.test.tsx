/* @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { requestJson } from "../api/request";
import { I18nProvider } from "../test-support";
import { buildPairLink, formatPairCode, PresencePanel } from "./PresencePanel";

vi.mock("../api/request", () => ({ requestJson: vi.fn() }));
const requestJsonMock = vi.mocked(requestJson);

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider locale="de">
        <PresencePanel />
      </I18nProvider>
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  requestJsonMock.mockReset();
});

describe("PresencePanel", () => {
  it("groups players by game", async () => {
    requestJsonMock.mockResolvedValue({
      players: [
        {
          userId: "1",
          username: "rene",
          displayName: null,
          games: [{ title: "Counter-Strike 2", launcher: "steam", appId: "730", since: "2026-11-03T18:00:00Z" }],
          updatedAt: "2026-11-03T18:00:30Z"
        },
        {
          userId: "2",
          username: "anna",
          displayName: "Anna",
          games: [{ title: "Counter-Strike 2", launcher: "steam", since: "2026-11-03T18:05:00Z" }],
          updatedAt: "2026-11-03T18:05:30Z"
        }
      ]
    });
    const view = await render();
    expect(requestJsonMock).toHaveBeenCalledWith("/api/m/presence");
    const games = view.querySelector("ul.device-list")!.querySelectorAll("li.device-row");
    expect(games).toHaveLength(1);
    expect(games[0].querySelector(".item-title strong")?.textContent).toBe("Counter-Strike 2");
    expect(games[0].querySelector(".item-meta")?.textContent).toBe("Steam");
    expect(games[0].querySelector(".badge")?.textContent).toBe("2 im Spiel");
    expect(games[0].textContent).toContain("Anna");
    expect(games[0].textContent).toContain("rene");
  });

  it("uses the shared building blocks instead of module classes", async () => {
    requestJsonMock.mockResolvedValue({
      players: [
        {
          userId: "1",
          username: "rene",
          displayName: null,
          games: [{ title: "Counter-Strike 2", launcher: "steam", since: "2026-11-03T18:00:00Z" }],
          updatedAt: "2026-11-03T18:00:30Z"
        }
      ],
      agentAvailable: true,
      agentKey: null
    });
    const view = await render();
    const own = Array.from(view.querySelectorAll<HTMLElement>("[class]"))
      .flatMap((element) => Array.from(element.classList))
      .filter((name) => name.startsWith("presence-") || name.startsWith("game-account"));
    expect(own).toEqual([]);
  });

  it("shows the empty state", async () => {
    requestJsonMock.mockResolvedValue({ players: [] });
    const view = await render();
    expect(view.textContent).toContain("Gerade meldet niemand ein laufendes Spiel.");
  });
});

describe("PresencePanel setup", () => {
  it("offers the installer and connects the agent with a one-time code", async () => {
    requestJsonMock.mockImplementation(async (url: string) => {
      if (url === "/api/m/presence") return { players: [], agentAvailable: true, agentKey: null };
      if (url === "/api/m/presence/agent/pair-code") return { code: "K7MX2QPD", expiresAt: "2026-11-04T20:05:00Z" };
      throw new Error(url);
    });
    const view = await render();
    expect(view.querySelector('a[href="/api/m/presence/agent/download"]')).toBeTruthy();
    expect(view.textContent).not.toContain(".cmd");
    const connect = Array.from(view.querySelectorAll("button")).find((b) => b.textContent === "Agent verbinden");
    await act(async () => {
      connect!.click();
      await Promise.resolve();
    });
    expect(requestJsonMock).toHaveBeenCalledWith(
      "/api/m/presence/agent/pair-code",
      expect.objectContaining({ method: "POST" })
    );
    expect(view.textContent).toContain("K7MX-2QPD");
  });

  it("shows the state of an existing agent key", async () => {
    requestJsonMock.mockResolvedValue({
      players: [],
      agentAvailable: true,
      agentKey: { createdAt: "2026-11-03T19:00:00Z", lastUsedAt: null }
    });
    const view = await render();
    expect(view.textContent).toContain("Agent neu verbinden");
    expect(view.textContent).toContain("Agent trennen");
    expect(view.textContent).toContain("zuletzt gemeldet: noch nie");
  });

  it("explains when no agent is bundled", async () => {
    requestJsonMock.mockResolvedValue({ players: [], agentAvailable: false });
    const view = await render();
    expect(view.querySelector('a[href="/api/m/presence/agent/download"]')).toBeNull();
    expect(view.textContent).toContain("keinen fertigen Agenten");
  });

  it("builds the pairing link for the installed agent", () => {
    expect(buildPairLink("https://lan.example:8443", "K7MX2QPD")).toBe(
      "matchdesk-agent://pair?server=https%3A%2F%2Flan.example%3A8443&code=K7MX2QPD"
    );
    expect(formatPairCode("K7MX2QPD")).toBe("K7MX-2QPD");
  });
});
