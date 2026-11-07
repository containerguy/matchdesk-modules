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
    <details>
      <summary>{t("gameAccounts.overview.title")}</summary>
      <p className="muted">
        {t("gameAccounts.overview.help")} <a href="#login/m-presence">{t("gameAccounts.overview.own")}</a>
      </p>
      {users && users.length === 0 ? (
        <p className="muted empty-state">{t("gameAccounts.overview.empty")}</p>
      ) : null}
      {users && users.length > 0 ? (
        <ul className="device-list">
          {users.map((user) => (
            <li key={user.userId} className="device-row">
              <div>
                <p className="item-title">
                  <strong>{user.displayName || user.username}</strong>
                </p>
                {GAME_ACCOUNT_PLATFORMS.filter((platform) => user.accounts[platform]).map((platform) => {
                  const account = user.accounts[platform]!;
                  return (
                    <p key={platform} className="item-sub">
                      {GAME_ACCOUNT_LABELS[platform]}:{" "}
                      {platform === "steam" ? (
                        <>
                          <a href={steamProfileUrl(account.accountId)} target="_blank" rel="noreferrer">
                            {accountLabel(account)}
                          </a>{" "}
                          · <a href={steamAddFriendUrl(account.accountId)}>{t("gameAccounts.overview.addFriend")}</a>
                        </>
                      ) : (
                        account.accountId
                      )}
                    </p>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
