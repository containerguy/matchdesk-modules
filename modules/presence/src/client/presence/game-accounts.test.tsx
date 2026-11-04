/* @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { requestJson } from "../api/request";
import { I18nProvider } from "../test-support";
import { GameAccountsPrompt } from "./GameAccountsPrompt";
import { GameAccountsSection } from "./GameAccountsSection";
import { steamAddFriendUrl, steamProfileUrl } from "./game-accounts-model";

vi.mock("../api/request", () => ({ requestJson: vi.fn() }));
const requestJsonMock = vi.mocked(requestJson);

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<I18nProvider locale="de">{node}</I18nProvider>);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

function button(view: HTMLElement, text: string) {
  const found = Array.from(view.querySelectorAll("button, a")).find((el) => el.textContent === text);
  if (!found) {
    throw new Error(`no button ${text}`);
  }
  return found as HTMLElement;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  requestJsonMock.mockReset();
  window.sessionStorage.clear();
});

describe("GameAccountsPrompt", () => {
  it("asks while a field is empty and can be dismissed for good", async () => {
    requestJsonMock.mockResolvedValue({
      accounts: { steam: { accountId: "76561198000000001", displayName: "René", source: "agent" } },
      missing: ["ea", "battlenet"],
      promptDismissed: false
    });
    const view = await render(<GameAccountsPrompt currentUserId="u1" />);
    expect(view.textContent).toContain("Noch leer: EA, Battle.net");
    expect(button(view, "Jetzt pflegen").getAttribute("href")).toBe("#login/m-presence");

    await act(async () => button(view, "Nicht mehr fragen").click());
    expect(requestJsonMock).toHaveBeenLastCalledWith("/api/m/presence/accounts/me/prompt-dismiss", { method: "POST" });
    expect(view.textContent).toBe("");
  });

  it("stays quiet when everything is filled in or it was dismissed", async () => {
    requestJsonMock.mockResolvedValue({ accounts: {}, missing: ["ea"], promptDismissed: true });
    const view = await render(<GameAccountsPrompt currentUserId="u1" />);
    expect(view.textContent).toBe("");
  });

  it("still offers a new Steam account after 'don't ask again'", async () => {
    requestJsonMock.mockResolvedValue({
      accounts: {
        steam: {
          accountId: "76561198000000001",
          displayName: "René",
          source: "agent",
          pending: { accountId: "76561198000000002", displayName: "Zweitkonto" }
        }
      },
      missing: [],
      promptDismissed: true
    });
    const view = await render(<GameAccountsPrompt currentUserId="u1" />);
    expect(view.textContent).toContain("Zweitkonto");
  });
});

describe("GameAccountsSection", () => {
  it("accepts the Steam suggestion and only sends changed fields", async () => {
    const initial = {
      accounts: {
        steam: {
          accountId: "76561198000000001",
          displayName: "René",
          source: "agent",
          pending: { accountId: "76561198000000002", displayName: "Zweitkonto" }
        }
      },
      missing: ["ea", "battlenet", "epic", "ubisoft"],
      promptDismissed: false
    };
    requestJsonMock.mockResolvedValue(initial);
    const view = await render(<GameAccountsSection />);
    expect(view.textContent).toContain("anderes Steam-Konto gefunden: Zweitkonto");

    await act(async () => button(view, "Übernehmen").click());
    expect(requestJsonMock).toHaveBeenLastCalledWith("/api/m/presence/accounts/me/steam/accept", { method: "POST" });

    const input = view.querySelector<HTMLInputElement>('input[placeholder="BattleTag, z. B. Name#1234"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Rene#2345");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(view, "Speichern").click());
    expect(requestJsonMock).toHaveBeenLastCalledWith("/api/m/presence/accounts/me", {
      method: "PUT",
      body: JSON.stringify({ battlenet: "Rene#2345" })
    });
  });
});

describe("Steam links", () => {
  it("builds profile and add-friend links", () => {
    expect(steamProfileUrl("76561198000000001")).toBe("https://steamcommunity.com/profiles/76561198000000001");
    expect(steamAddFriendUrl("76561198000000001")).toBe("steam://friends/add/76561198000000001");
  });
});
