import React, { useCallback, useEffect, useState } from "react";
import { requestJson } from "../api/request";
import { useI18n } from "../i18n/I18nContext";
import { GameAccountsOverview } from "./GameAccountsOverview";
import { groupByGame, LAUNCHER_LABELS, type PresencePlayer } from "./presence-model";

/** Agent meldet alle 30 s; die Seite fragt etwas häufiger nach. */
export const PRESENCE_REFRESH_MS = 20_000;

/**
 * Startdatei für Windows: liegt neben der .exe und startet den Agenten. Der Schlüssel geht über
 * eine Umgebungsvariable, nicht über die Befehlszeile (die andere Prozesse mitlesen können).
 */
export function buildStartFile(origin: string, key: string, title: string) {
  return [
    "@echo off",
    `title ${title}`,
    'cd /d "%~dp0"',
    `set MATCHDESK_AGENT_KEY=${key}`,
    `matchdesk-game-agent.exe -server ${origin} -interval 30s`,
    "pause",
    ""
  ].join("\r\n");
}

type AgentKeyInfo = { createdAt: string; lastUsedAt: string | null } | null;

function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatTime(iso: string, locale: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

export function PresencePanel() {
  const { t, locale } = useI18n();
  const [players, setPlayers] = useState<PresencePlayer[] | null>(null);
  const [error, setError] = useState(false);
  const [agentAvailable, setAgentAvailable] = useState(false);
  const [agentKey, setAgentKey] = useState<AgentKeyInfo>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [setupState, setSetupState] = useState<"idle" | "busy" | "error">("idle");

  const load = useCallback(async () => {
    try {
      const body = await requestJson<{
        players: PresencePlayer[];
        agentAvailable?: boolean;
        agentKey?: AgentKeyInfo;
      }>("/api/m/presence");
      setPlayers(body.players);
      setAgentAvailable(Boolean(body.agentAvailable));
      setAgentKey(body.agentKey ?? null);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), PRESENCE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  async function createKey() {
    setSetupState("busy");
    try {
      const created = await requestJson<{ key: string; createdAt: string }>("/api/m/presence/agent-key", {
        method: "POST"
      });
      setNewKey(created.key);
      setAgentKey({ createdAt: created.createdAt, lastUsedAt: null });
      setSetupState("idle");
    } catch {
      setSetupState("error");
    }
  }

  async function revokeKey() {
    setSetupState("busy");
    try {
      await requestJson("/api/m/presence/agent-key", { method: "DELETE" });
      setNewKey(null);
      setAgentKey(null);
      setSetupState("idle");
      void load();
    } catch {
      setSetupState("error");
    }
  }

  const groups = players ? groupByGame(players) : [];
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <section className="presence-panel" aria-label={t("presence.aria")}>
      {error ? <p className="error">{t("presence.error")}</p> : null}
      {!players && !error ? <p className="muted">{t("presence.loading")}</p> : null}
      {players && groups.length === 0 ? <p className="muted">{t("presence.empty")}</p> : null}
      {groups.length > 0 ? (
        <ul className="presence-list">
          {groups.map((group) => (
            <li key={group.title} className="presence-game">
              <div className="presence-game-header">
                <strong>{group.title}</strong>
                <span className="muted">
                  {[LAUNCHER_LABELS[group.launcher], t("presence.count", { count: group.players.length })]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <ul className="presence-players">
                {group.players.map((entry) => (
                  <li key={entry.userId}>
                    {entry.name}{" "}
                    <span className="muted">{t("presence.since", { time: formatTime(entry.since, locale) })}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
      <GameAccountsOverview />
      <details className="presence-setup">
        <summary>{t("presence.setup.title")}</summary>
        <p className="muted">{t("presence.setup.privacy")}</p>
        {agentAvailable ? (
          <>
            <p className="muted">{t("presence.setup.steps")}</p>
            <div className="action-row">
              <a className="button-link" href="/api/m/presence/agent/download" download>
                {t("presence.setup.download")}
              </a>
              {newKey ? (
                <button
                  type="button"
                  onClick={() =>
                    downloadText(
                      t("presence.setup.startFileName"),
                      buildStartFile(origin, newKey, t("main.nav.presence"))
                    )
                  }
                >
                  {t("presence.setup.startFile")}
                </button>
              ) : (
                <button type="button" disabled={setupState === "busy"} onClick={() => void createKey()}>
                  {setupState === "busy"
                    ? t("presence.setup.creating")
                    : agentKey
                      ? t("presence.setup.recreate")
                      : t("presence.setup.create")}
                </button>
              )}
              {agentKey ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={setupState === "busy"}
                  onClick={() => void revokeKey()}
                >
                  {t("presence.setup.revoke")}
                </button>
              ) : null}
            </div>
            {setupState === "error" ? <p className="error">{t("presence.setup.createError")}</p> : null}
            {agentKey && !newKey ? (
              <p className="muted">
                {t("presence.setup.keyStatus", {
                  created: new Date(agentKey.createdAt).toLocaleDateString(locale),
                  used: agentKey.lastUsedAt
                    ? new Date(agentKey.lastUsedAt).toLocaleString(locale)
                    : t("presence.setup.keyNeverUsed")
                })}
              </p>
            ) : null}
            {newKey ? <p className="muted">{t("presence.setup.tokenNote")}</p> : null}
            <p className="muted">{t("presence.setup.smartscreen")}</p>
          </>
        ) : (
          <p className="muted">{t("presence.setup.noAgent")}</p>
        )}
      </details>
    </section>
  );
}
