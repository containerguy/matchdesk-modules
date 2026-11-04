import React, { useEffect, useState } from "react";
import { requestJson } from "../api/request";
import { useI18n } from "../i18n/I18nContext";
import {
  accountLabel,
  GAME_ACCOUNT_LABELS,
  GAME_ACCOUNT_PLATFORMS,
  steamAddFriendUrl,
  steamProfileUrl,
  type UserGameAccounts
} from "./game-accounts-model";

/** Spielkonten aller Teilnehmer, damit man sich gegenseitig findet. */
export function GameAccountsOverview() {
  const { t } = useI18n();
  const [users, setUsers] = useState<UserGameAccounts[] | null>(null);

  useEffect(() => {
    requestJson<{ users: UserGameAccounts[] }>("/api/m/presence/accounts")
      .then((body) => setUsers(body.users ?? []))
      .catch(() => setUsers([]));
  }, []);

  return (
    <details className="presence-setup game-accounts-overview">
      <summary>{t("gameAccounts.overview.title")}</summary>
      <p className="muted">
        {t("gameAccounts.overview.help")} <a href="#login/m-presence">{t("gameAccounts.overview.own")}</a>
      </p>
      {users && users.length === 0 ? <p className="muted">{t("gameAccounts.overview.empty")}</p> : null}
      {users && users.length > 0 ? (
        <ul className="presence-list">
          {users.map((user) => (
            <li key={user.userId} className="presence-game">
              <strong>{user.displayName || user.username}</strong>
              <dl className="game-accounts-list">
                {GAME_ACCOUNT_PLATFORMS.filter((platform) => user.accounts[platform]).map((platform) => {
                  const account = user.accounts[platform]!;
                  return (
                    <div key={platform}>
                      <dt>{GAME_ACCOUNT_LABELS[platform]}</dt>
                      <dd>
                        {platform === "steam" ? (
                          <>
                            <a href={steamProfileUrl(account.accountId)} target="_blank" rel="noreferrer">
                              {accountLabel(account)}
                            </a>{" "}
                            <a className="muted" href={steamAddFriendUrl(account.accountId)}>
                              {t("gameAccounts.overview.addFriend")}
                            </a>
                          </>
                        ) : (
                          <span className="game-account-id">{account.accountId}</span>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
