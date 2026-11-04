/** Spielkonten (Profil „Spielkonten“, Übersicht auf „Spielt gerade“). */
export const GAME_ACCOUNT_PLATFORMS = ["steam", "ea", "battlenet", "epic", "ubisoft"] as const;
export type GameAccountPlatform = (typeof GAME_ACCOUNT_PLATFORMS)[number];

export const GAME_ACCOUNT_LABELS: Record<GameAccountPlatform, string> = {
  steam: "Steam",
  ea: "EA",
  battlenet: "Battle.net",
  epic: "Epic Games",
  ubisoft: "Ubisoft Connect"
};

export type GameAccount = {
  accountId: string;
  displayName: string | null;
  source?: "agent" | "manual";
  pending?: { accountId: string; displayName: string | null };
};

export type MyGameAccounts = {
  accounts: Partial<Record<GameAccountPlatform, GameAccount>>;
  missing: GameAccountPlatform[];
  promptDismissed: boolean;
};

export type UserGameAccounts = {
  userId: string;
  username: string;
  displayName: string | null;
  accounts: Partial<Record<GameAccountPlatform, GameAccount>>;
};

export function steamProfileUrl(steamId: string) {
  return `https://steamcommunity.com/profiles/${encodeURIComponent(steamId)}`;
}

/** Öffnet den Steam-Client mit „Als Freund hinzufügen“. */
export function steamAddFriendUrl(steamId: string) {
  return `steam://friends/add/${encodeURIComponent(steamId)}`;
}

/** Text für die Anzeige: Anzeigename (falls bekannt) sonst die ID. */
export function accountLabel(account: GameAccount) {
  return account.displayName?.trim() || account.accountId;
}
