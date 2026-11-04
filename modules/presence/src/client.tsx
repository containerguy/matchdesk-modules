import type { ModuleClientFactory, ModuleNoticeProps } from "@matchdesk/module-sdk";
import { setHost } from "./client/host";
import { GameAccountsPrompt } from "./client/presence/GameAccountsPrompt";
import { GameAccountsSection } from "./client/presence/GameAccountsSection";
import { PresencePanel } from "./client/presence/PresencePanel";

function Page() {
  return <PresencePanel />;
}

/** Profil › Spielkonten (bis 0.16 im Kern unter #login/spielkonten). */
function Profile() {
  return <GameAccountsSection />;
}

/** Startseite: fragt nach fehlenden Spielkonten, bis sie gepflegt oder „nicht mehr fragen“ ist. */
function Notice({ user }: ModuleNoticeProps) {
  return <GameAccountsPrompt currentUserId={user.id} />;
}

const createModule: ModuleClientFactory = (host) => {
  setHost(host);
  return { Page, Profile, Notice };
};

export default createModule;
