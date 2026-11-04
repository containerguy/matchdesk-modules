/* @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { requestJson } from "../api/request";
import { I18nProvider } from "../test-support";
import { buildStartFile, PresencePanel } from "./PresencePanel";

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
    const games = view.querySelectorAll(".presence-game");
    expect(games).toHaveLength(1);
    expect(games[0].textContent).toContain("Counter-Strike 2");
    expect(games[0].textContent).toContain("2 im Spiel");
    expect(games[0].textContent).toContain("Anna");
    expect(games[0].textContent).toContain("rene");
  });

  it("shows the empty state", async () => {
    requestJsonMock.mockResolvedValue({ players: [] });
    const view = await render();
    expect(view.textContent).toContain("Gerade meldet niemand ein laufendes Spiel.");
  });
});

describe("PresencePanel setup", () => {
  it("offers the download and creates an agent key for the start file", async () => {
    requestJsonMock.mockImplementation(async (url: string) => {
      if (url === "/api/m/presence") return { players: [], agentAvailable: true, agentKey: null };
      if (url === "/api/m/presence/agent-key") return { key: "md_ga_test", createdAt: "2026-11-03T19:00:00Z" };
      throw new Error(url);
    });
    const view = await render();
    expect(view.querySelector('a[href="/api/m/presence/agent/download"]')).toBeTruthy();
    const create = Array.from(view.querySelectorAll("button")).find((b) => b.textContent === "Agent einrichten");
    await act(async () => {
      create!.click();
      await Promise.resolve();
    });
    expect(requestJsonMock).toHaveBeenCalledWith(
      "/api/m/presence/agent-key",
      expect.objectContaining({ method: "POST" })
    );
    expect(view.textContent).toContain("Startdatei herunterladen");
    expect(view.textContent).toContain("Agent abmelden");
  });

  it("shows the state of an existing agent key", async () => {
    requestJsonMock.mockResolvedValue({
      players: [],
      agentAvailable: true,
      agentKey: { createdAt: "2026-11-03T19:00:00Z", lastUsedAt: null }
    });
    const view = await render();
    expect(view.textContent).toContain("Agent neu einrichten");
    expect(view.textContent).toContain("zuletzt gemeldet: noch nie");
  });

  it("explains when no agent is bundled", async () => {
    requestJsonMock.mockResolvedValue({ players: [], agentAvailable: false });
    const view = await render();
    expect(view.querySelector('a[href="/api/m/presence/agent/download"]')).toBeNull();
    expect(view.textContent).toContain("keinen fertigen Agenten");
  });

  it("builds a Windows start file that passes the key via the environment", () => {
    expect(buildStartFile("https://lan.example", "md_ga_x", "Spielt gerade")).toBe(
      '@echo off\r\ntitle Spielt gerade\r\ncd /d "%~dp0"\r\nset MATCHDESK_AGENT_KEY=md_ga_x\r\nmatchdesk-game-agent.exe -server https://lan.example -interval 30s\r\npause\r\n'
    );
  });
});
