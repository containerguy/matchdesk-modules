import { useState, type FormEvent } from "react";
import { useI18n } from "../i18n/I18nContext";
import { removePizzaExtra, savePizzaExtra, setPizzaExtraActive, type PizzaRemovalResult } from "./api";
import { centsToInput, parseEuroToCents } from "./price";
import type { PizzaCategory, PizzaExtra } from "./types";

type Mutate = (action: () => Promise<string | void>) => Promise<boolean>;

interface ExtrasEditorProps {
  extras: PizzaExtra[];
  categories: PizzaCategory[];
  mutate: Mutate;
  onInvalid: (message: string) => void;
}

/**
 * Extras mit Aufpreis pflegen (ab manager): Name, Preis, Kategorien, aktiv. Ein schon bestelltes
 * Extra wird beim Entfernen nur deaktiviert. Eingaben leben im State der Zeilen (Key = ID).
 */
export function PizzaExtrasEditor({ extras, categories, mutate, onInvalid }: ExtrasEditorProps) {
  const { t } = useI18n();
  const sortedCategories = [...categories].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  function removalText(result: PizzaRemovalResult) {
    return result === "deleted" ? t("pizza.menuEditor.deleted") : t("pizza.extras.deactivated");
  }

  return (
    <div className="pizza-extras-editor" data-testid="pizza-extras-editor">
      <p className="muted">{t("pizza.extras.help")}</p>
      {extras.length === 0 ? <p className="muted">{t("pizza.extras.empty")}</p> : null}
      <ul className="pizza-admin__list">
        {extras.map((extra) => (
          <ExtraRow
            key={extra.id}
            extra={extra}
            categories={sortedCategories}
            onInvalid={() => onInvalid(t("pizza.menuEditor.invalidPrice"))}
            onSave={(input) =>
              mutate(async () => {
                await savePizzaExtra({ id: extra.id, ...input });
                return t("pizza.menuEditor.saved");
              })
            }
            onToggleActive={() =>
              mutate(async () => {
                await setPizzaExtraActive(extra.id, !extra.active);
                return t("pizza.menuEditor.saved");
              })
            }
            onRemove={() => mutate(async () => removalText(await removePizzaExtra(extra.id)))}
          />
        ))}
      </ul>
      <NewExtraForm
        categories={sortedCategories}
        onInvalid={() => onInvalid(t("pizza.menuEditor.invalidPrice"))}
        onCreate={(input) =>
          mutate(async () => {
            await savePizzaExtra(input);
            return t("pizza.menuEditor.saved");
          })
        }
      />
    </div>
  );
}

interface ExtraFormValue {
  name: string;
  priceCents: number;
  categoryIds: string[];
}

function CategoryChecks({
  categories,
  value,
  onChange,
  labelPrefix
}: {
  categories: PizzaCategory[];
  value: string[];
  onChange: (next: string[]) => void;
  labelPrefix: string;
}) {
  return (
    <span className="pizza-extras__categories">
      {categories.map((category) => (
        <label key={category.id} className="pizza-extras__option">
          <input
            type="checkbox"
            checked={value.includes(category.id)}
            aria-label={`${labelPrefix}: ${category.name}`}
            onChange={(event) =>
              onChange(
                event.target.checked ? [...value, category.id] : value.filter((id) => id !== category.id)
              )
            }
          />
          {category.name}
        </label>
      ))}
    </span>
  );
}

function ExtraRow({
  extra,
  categories,
  onSave,
  onToggleActive,
  onRemove,
  onInvalid
}: {
  extra: PizzaExtra;
  categories: PizzaCategory[];
  onSave: (input: ExtraFormValue) => Promise<boolean>;
  onToggleActive: () => Promise<boolean>;
  onRemove: () => Promise<boolean>;
  onInvalid: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(extra.name);
  const [price, setPrice] = useState(centsToInput(extra.priceCents));
  const [categoryIds, setCategoryIds] = useState(extra.categoryIds);

  return (
    <li
      className={`pizza-admin__row${extra.active ? "" : " pizza-admin__row--inactive"}`}
      data-testid={`pizza-extra-${extra.id}`}
    >
      <label>
        {t("pizza.extras.name")}
        <input
          value={name}
          maxLength={80}
          aria-label={`${t("pizza.extras.name")}: ${extra.name}`}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        {t("pizza.menuEditor.price")}
        <input
          value={price}
          inputMode="decimal"
          aria-label={`${t("pizza.menuEditor.price")}: ${extra.name}`}
          onChange={(event) => setPrice(event.target.value)}
        />
      </label>
      <CategoryChecks
        categories={categories}
        value={categoryIds}
        onChange={setCategoryIds}
        labelPrefix={`${t("pizza.extras.categories")} ${extra.name}`}
      />
      {!extra.active ? <span className="pizza-panel__pill">{t("pizza.menuEditor.inactive")}</span> : null}
      <div className="pizza-admin__row-actions">
        <button
          type="button"
          className="primary"
          aria-label={`${t("pizza.menuEditor.save")}: ${extra.name}`}
          onClick={() => {
            const cents = parseEuroToCents(price);
            if (cents === null || !name.trim()) {
              onInvalid();
              return;
            }
            void onSave({ name: name.trim(), priceCents: cents, categoryIds });
          }}
        >
          {t("pizza.menuEditor.save")}
        </button>
        <button
          type="button"
          className="secondary"
          aria-label={`${extra.active ? t("pizza.menuEditor.deactivate") : t("pizza.menuEditor.activate")}: ${extra.name}`}
          onClick={() => void onToggleActive()}
        >
          {extra.active ? t("pizza.menuEditor.deactivate") : t("pizza.menuEditor.activate")}
        </button>
        <button
          type="button"
          className="secondary"
          aria-label={`${t("pizza.menuEditor.remove")}: ${extra.name}`}
          onClick={() => {
            if (!window.confirm(t("pizza.extras.removeConfirm", { name: extra.name }))) return;
            void onRemove();
          }}
        >
          {t("pizza.menuEditor.remove")}
        </button>
      </div>
    </li>
  );
}

function NewExtraForm({
  categories,
  onCreate,
  onInvalid
}: {
  categories: PizzaCategory[];
  onCreate: (input: ExtraFormValue) => Promise<boolean>;
  onInvalid: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [categoryIds, setCategoryIds] = useState<string[]>([]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cents = parseEuroToCents(price);
    if (cents === null || !name.trim()) {
      onInvalid();
      return;
    }
    if (await onCreate({ name: name.trim(), priceCents: cents, categoryIds })) {
      setName("");
      setPrice("");
      setCategoryIds([]);
    }
  }

  return (
    <form className="pizza-admin__new-variant pizza-extras-editor__new" onSubmit={handleSubmit}>
      <label>
        {t("pizza.extras.name")}
        <input
          value={name}
          maxLength={80}
          placeholder={t("pizza.extras.namePlaceholder")}
          aria-label={t("pizza.extras.newName")}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        {t("pizza.menuEditor.price")}
        <input
          value={price}
          inputMode="decimal"
          aria-label={t("pizza.extras.newPrice")}
          onChange={(event) => setPrice(event.target.value)}
        />
      </label>
      <CategoryChecks
        categories={categories}
        value={categoryIds}
        onChange={setCategoryIds}
        labelPrefix={t("pizza.extras.newCategories")}
      />
      <button type="submit" className="secondary">
        {t("pizza.extras.create")}
      </button>
    </form>
  );
}
