import React, { FormEvent, useEffect, useState } from "react";
import { requestJson } from "../api/request";
import { getErrorMessage } from "../errors/errors";
import { useI18n } from "../i18n/I18nContext";
import {
  accountLabel,
  GAME_ACCOUNT_LABELS,
  GAME_ACCOUNT_PLATFORMS,
  type GameAccountPlatform,
  type MyGameAccounts,
  steamProfileUrl
} from "./game-accounts-model";

type Drafts = Record<GameAccountPlatform, string>;

function toDrafts(data: MyGameAccounts): Drafts {
  const drafts = {} as Drafts;
  for (const platform of GAME_ACCOUNT_PLATFORMS) {
    drafts[platform] = data.accounts[platform]?.accountId ?? "";
  }
  return drafts;
}

/** Profil → Spielkonten. Steam füllt der Agent, der Rest wird hier gepflegt. */
export function GameAccountsSection() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<MyGameAccounts | null>(null);
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  function apply(next: MyGameAccounts) {
    setData(next);
    setDrafts(toDrafts(next));
  }

  useEffect(() => {
    requestJson<MyGameAccounts>("/api/m/presence/accounts/me")
      .then(apply)
      .catch((caught) => setError(getErrorMessage(caught, locale)));
  }, [locale]);

  async function run(action: () => Promise<MyGameAccounts | undefined>) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const next = await action();
      if (next) {
        apply(next);
        setSaved(true);
      }
    } catch (caught) {
      setError(getErrorMessage(caught, locale));
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!drafts) {
      return;
    }
    const body: Record<string, string | null> = {};
    for (const platform of GAME_ACCOUNT_PLATFORMS) {
      if (drafts[platform].trim() !== (data?.accounts[platform]?.accountId ?? "")) {
        body[platform] = drafts[platform].trim() || null;
      }
    }
    void run(() =>
      requestJson<MyGameAccounts>("/api/m/presence/accounts/me", { method: "PUT", body: JSON.stringify(body) })
    );
  }

  const steam = data?.accounts.steam;
  const pending = steam?.pending;

  return (
    <section className="device-panel game-accounts" aria-label={t("gameAccounts.title")}>
      <p className="eyebrow">{t("gameAccounts.eyebrow")}</p>
      <h3>{t("gameAccounts.title")}</h3>
      <p className="muted">{t("gameAccounts.help")}</p>
      {error ? <p className="error">{error}</p> : null}
      {pending ? (
        <div className="notice game-accounts-pending">
          <p>{t("gameAccounts.steamPending", { name: pending.displayName || pending.accountId })}</p>
          <div className="action-row">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() => requestJson<MyGameAccounts>("/api/m/presence/accounts/me/steam/accept", { method: "POST" }))
              }
            >
              {t("gameAccounts.steamAccept")}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(() => requestJson<MyGameAccounts>("/api/m/presence/accounts/me/steam/dismiss", { method: "POST" }))
              }
            >
              {t("gameAccounts.steamKeep")}
            </button>
          </div>
        </div>
      ) : null}
      {drafts ? (
        <form className="admin-form" onSubmit={save}>
          {GAME_ACCOUNT_PLATFORMS.map((platform) => (
            <label key={platform}>
              {GAME_ACCOUNT_LABELS[platform]}
              <input
                value={drafts[platform]}
                maxLength={platform === "steam" ? 200 : 64}
                placeholder={t(`gameAccounts.placeholder.${platform}`)}
                onChange={(event) => setDrafts({ ...drafts, [platform]: event.target.value })}
              />
            </label>
          ))}
          {steam ? (
            <p className="muted">
              {t(steam.source === "agent" ? "gameAccounts.steamFromAgent" : "gameAccounts.steamManual", {
                name: accountLabel(steam)
              })}{" "}
              <a href={steamProfileUrl(steam.accountId)} target="_blank" rel="noreferrer">
                {t("gameAccounts.steamProfile")}
              </a>
            </p>
          ) : (
            <p className="muted">{t("gameAccounts.steamHint")}</p>
          )}
          <div className="action-row">
            <button type="submit" disabled={busy}>
              {t("gameAccounts.save")}
            </button>
          </div>
          {saved ? <p className="notice">{t("gameAccounts.saved")}</p> : null}
        </form>
      ) : !error ? (
        <p className="muted">{t("presence.loading")}</p>
      ) : null}
    </section>
  );
}
