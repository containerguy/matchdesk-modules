import type { ModuleClientFactory, ModulePageProps } from "@matchdesk/module-sdk";
import { setHost } from "./client/host";
import { PizzaPanel } from "./client/pizza/PizzaPanel";
import { PizzaMenuJsonAdmin } from "./client/pizza/PizzaMenuJsonAdmin";

function Page({ user }: ModulePageProps) {
  const current = user as ModulePageProps["user"] & { currentMainEventId?: string | null };
  return (
    <PizzaPanel
      currentUserId={current.id}
      currentUserRole={current.role}
      currentMainEventId={current.currentMainEventId ?? null}
    />
  );
}

function Admin() {
  return <PizzaMenuJsonAdmin />;
}

const createModule: ModuleClientFactory = (host) => {
  setHost(host);
  return { Page, Admin };
};

export default createModule;
