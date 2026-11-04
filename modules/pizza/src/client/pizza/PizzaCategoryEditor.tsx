import { useState, type FormEvent } from "react";
import { useI18n } from "../i18n/I18nContext";
import {
  deletePizzaCategory,
  reorderPizzaCategories,
  savePizzaCategory,
  setPizzaCategoryActive
} from "./api";
import type { PizzaCategory } from "./types";

type Mutate = (action: () => Promise<string | void>) => Promise<boolean>;

/**
 * Kategorien pflegen (ab manager): anlegen, umbenennen, sortieren, (de)aktivieren und leere
 * Kategorien löschen. Eingaben leben im State der Zeilen (Key = Kategorie-ID), damit ein
 * Live-Abgleich angefangene Umbenennungen nicht verwirft.
 */
export function PizzaCategoryEditor({ categories, mutate }: { categories: PizzaCategory[]; mutate: Mutate }) {
  const { t } = useI18n();
  const [newName, setNewName] = useState("");
  const ordered = [...categories].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  function move(index: number, delta: number) {
    const ids = ordered.map((category) => category.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void mutate(async () => {
      await reorderPizzaCategories(ids);
      return t("pizza.menuEditor.saved");
    });
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const ok = await mutate(async () => {
      await savePizzaCategory({ name });
      return t("pizza.menuEditor.saved");
    });
    if (ok) setNewName("");
  }

  return (
    <div className="pizza-category-editor" data-testid="pizza-category-editor">
      <p className="muted">{t("pizza.categories.help")}</p>
      <ul className="pizza-admin__list">
        {ordered.map((category, index) => (
          <CategoryRow
            key={category.id}
            category={category}
            first={index === 0}
            last={index === ordered.length - 1}
            onMove={(delta) => move(index, delta)}
            mutate={mutate}
          />
        ))}
      </ul>
      <form className="pizza-admin__new-variant" onSubmit={create}>
        <label>
          {t("pizza.categories.newName")}
          <input
            value={newName}
            maxLength={60}
            aria-label={t("pizza.categories.newName")}
            onChange={(event) => setNewName(event.target.value)}
          />
        </label>
        <button type="submit" className="secondary">
          {t("pizza.categories.create")}
        </button>
      </form>
    </div>
  );
}

function CategoryRow({
  category,
  first,
  last,
  onMove,
  mutate
}: {
  category: PizzaCategory;
  first: boolean;
  last: boolean;
  onMove: (delta: number) => void;
  mutate: Mutate;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(category.name);
  const active = category.active !== false;
  const itemCount = category.itemCount ?? 0;

  return (
    <li
      className={`pizza-admin__row${active ? "" : " pizza-admin__row--inactive"}`}
      data-testid={`pizza-category-${category.id}`}
    >
      <label>
        {t("pizza.categories.name")}
        <input
          value={name}
          maxLength={60}
          aria-label={`${t("pizza.categories.name")}: ${category.name}`}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <span className="muted">{t("pizza.categories.itemCount", { count: itemCount })}</span>
      {!active ? <span className="pizza-panel__pill">{t("pizza.menuEditor.inactive")}</span> : null}
      <div className="pizza-admin__row-actions">
        <button
          type="button"
          className="primary"
          aria-label={`${t("pizza.menuEditor.save")}: ${category.name}`}
          disabled={!name.trim() || name.trim() === category.name}
          onClick={() =>
            void mutate(async () => {
              await savePizzaCategory({ id: category.id, name: name.trim() });
              return t("pizza.menuEditor.saved");
            })
          }
        >
          {t("pizza.menuEditor.save")}
        </button>
        <button
          type="button"
          className="secondary"
          aria-label={`${t("pizza.categories.up")}: ${category.name}`}
          disabled={first}
          onClick={() => onMove(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="secondary"
          aria-label={`${t("pizza.categories.down")}: ${category.name}`}
          disabled={last}
          onClick={() => onMove(1)}
        >
          ↓
        </button>
        <button
          type="button"
          className="secondary"
          aria-label={`${active ? t("pizza.menuEditor.deactivate") : t("pizza.menuEditor.activate")}: ${category.name}`}
          onClick={() =>
            void mutate(async () => {
              await setPizzaCategoryActive(category.id, !active);
              return t("pizza.menuEditor.saved");
            })
          }
        >
          {active ? t("pizza.menuEditor.deactivate") : t("pizza.menuEditor.activate")}
        </button>
        <button
          type="button"
          className="secondary"
          aria-label={`${t("pizza.categories.delete")}: ${category.name}`}
          disabled={itemCount > 0}
          title={itemCount > 0 ? t("pizza.categories.notEmpty") : undefined}
          onClick={() => {
            if (!window.confirm(t("pizza.categories.deleteConfirm", { name: category.name }))) return;
            void mutate(async () => {
              await deletePizzaCategory(category.id);
              return t("pizza.menuEditor.deleted");
            });
          }}
        >
          {t("pizza.categories.delete")}
        </button>
      </div>
    </li>
  );
}
