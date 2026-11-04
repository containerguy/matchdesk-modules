import React, { useEffect, useState } from "react";
import { requestJson } from "../api/request";
import { useI18n } from "../i18n/I18nContext";
import { GAME_ACCOUNT_LABELS, type MyGameAccounts } from "./game-accounts-model";

const LATER_KEY = "matchdesk.gameAccountsPrompt.later";

function readLater() {
  try {
    return window.sessionStorage.getItem(LATER_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Nach dem Login: Fragt, ob man seine Spielkonten pflegen möchte, solange noch ein Feld leer ist.
 * „Später“ gilt für diese Sitzung, „Nicht mehr fragen“ dauerhaft (serverseitig).
 */
export function GameAccountsPrompt({ currentUserId }: { currentUserId: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<MyGameAccounts | null>(null);
  const [hidden, setHidden] = useState(() => readLater());

  useEffect(() => {
    if (hidden) {
      return;
    }
    requestJson<MyGameAccounts>("/api/m/presence/accounts/me")
      .then(setData)
      .catch(() => setData(null));
  }, [currentUserId, hidden]);

  const pendingSteam = data?.accounts.steam?.pending;
  if (hidden || !data || (data.promptDismissed && !pendingSteam) || (data.missing.length === 0 && !pendingSteam)) {
    return null;
  }

  function later() {
    try {
      window.sessionStorage.setItem(LATER_KEY, "1");
    } catch {
      /* ohne Storage fragt die Karte beim nächsten Laden erneut */
    }
    setHidden(true);
  }

  function never() {
    setHidden(true);
    void requestJson("/api/m/presence/accounts/me/prompt-dismiss", { method: "POST" }).catch(() => undefined);
  }

  return (
    <section className="main-event-prompt" role="region" aria-label={t("gameAccounts.prompt.aria")}>
      <p className="eyebrow">{t("gameAccounts.eyebrow")}</p>
      <h2>{pendingSteam ? t("gameAccounts.prompt.steamTitle") : t("gameAccounts.prompt.title")}</h2>
      <p className="muted">
        {pendingSteam
          ? t("gameAccounts.steamPending", { name: pendingSteam.displayName || pendingSteam.accountId })
          : t("gameAccounts.prompt.body", {
              missing: data.missing.map((platform) => GAME_ACCOUNT_LABELS[platform]).join(", ")
            })}
      </p>
      <div className="action-row">
        <a className="button-link" href="#login/m-presence" onClick={later}>
          {t("gameAccounts.prompt.open")}
        </a>
        <button type="button" className="secondary" onClick={later}>
          {t("gameAccounts.prompt.later")}
        </button>
        {pendingSteam ? null : (
          <button type="button" className="secondary" onClick={never}>
            {t("gameAccounts.prompt.never")}
          </button>
        )}
      </div>
    </section>
  );
}
