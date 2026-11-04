import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { getErrorMessage } from "../errors/errors";
import { useI18n } from "../i18n/I18nContext";
import { useEventsChanged } from "../realtime/use-events-changed";
import {
  fetchPizzaAdminMenu,
  removePizzaItem,
  removePizzaVariant,
  savePizzaItem,
  savePizzaVariant,
  setPizzaItemActive,
  setPizzaVariantActive,
  type PizzaAdminMenu,
  type PizzaRemovalResult
} from "./api";
import { PizzaCategoryEditor } from "./PizzaCategoryEditor";
import { PizzaExtrasEditor } from "./PizzaExtrasEditor";
import { PizzaMenuTransfer } from "./PizzaMenuTransfer";
import { centsToInput, formatEuro, parseEuroToCents } from "./price";
import type { PizzaCategory, PizzaExtra, PizzaItem, PizzaVariant } from "./types";

interface PizzaMenuEditorProps {
  /** Wird nach jeder Änderung aufgerufen, damit das Bestell-Panel das Menü neu lädt. */
  onChanged?: () => Promise<void> | void;
}

type Feedback = { kind: "status" | "error"; text: string } | null;

/** Menüpflege ab manager: Artikel und Varianten/Preise anlegen, ändern, deaktivieren, entfernen. */
export function PizzaMenuEditor({ onChanged }: PizzaMenuEditorProps) {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<PizzaItem[] | null>(null);
  const [categories, setCategories] = useState<PizzaCategory[]>([]);
  const [extras, setExtras] = useState<PizzaExtra[]>([]);
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const mutating = useRef(0);

  function apply(menu: PizzaAdminMenu) {
    setItems(menu.items);
    setCategories(menu.categories);
    setExtras(menu.extras);
  }

  async function load() {
    try {
      apply(await fetchPizzaAdminMenu());
    } catch (err) {
      setFeedback({ kind: "error", text: getErrorMessage(err, locale) });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Live: Menüänderungen anderer Manager still übernehmen. Offene Formulare behalten ihre
  // Eingaben (State wird nur beim Mounten aus den Daten initialisiert, Keys sind Artikel-IDs).
  // Während einer eigenen Änderung lädt `mutate` ohnehin danach neu.
  useEventsChanged(
    () => {
      if (mutating.current > 0) return;
      fetchPizzaAdminMenu()
        .then(apply)
        .catch(() => {
          /* Hintergrund-Fehler: bisherigen Stand behalten */
        });
    },
    (reason) => reason === null || reason === "pizza_menu_changed"
  );

  /** Führt eine Änderung aus, lädt das Menü neu und meldet Erfolg oder Fehler. */
  async function mutate(action: () => Promise<string | void>) {
    mutating.current += 1;
    try {
      const status = await action();
      setFeedback(status ? { kind: "status", text: status } : null);
      await load();
      await onChanged?.();
      return true;
    } catch (err) {
      setFeedback({ kind: "error", text: getErrorMessage(err, locale) });
      return false;
    } finally {
      mutating.current -= 1;
    }
  }

  function removalText(result: PizzaRemovalResult) {
    return result === "deleted" ? t("pizza.menuEditor.deleted") : t("pizza.menuEditor.deactivated");
  }

  const filtered = useMemo(() => {
    if (!items) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(needle) || (item.number ?? "").toLowerCase().includes(needle)
    );
  }, [items, query]);

  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));

  return (
    <section className="pizza-menu-editor" aria-label={t("pizza.menuEditor.aria")}>
      <h4>{t("pizza.menuEditor.title")}</h4>
      <p className="muted">{t("pizza.menuEditor.help")}</p>

      {feedback ? (
        <p
          className={feedback.kind === "error" ? "pizza-panel__error" : "muted"}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.text}
        </p>
      ) : null}

      <details className="pizza-menu-editor__section">
        <summary>{t("pizza.categories.title", { count: categories.length })}</summary>
        <PizzaCategoryEditor categories={categories} mutate={mutate} />
      </details>

      <details className="pizza-menu-editor__section">
        <summary>{t("pizza.extras.title", { count: extras.length })}</summary>
        <PizzaExtrasEditor
          extras={extras}
          categories={categories}
          mutate={mutate}
          onInvalid={(text) => setFeedback({ kind: "error", text })}
        />
      </details>

      <details className="pizza-menu-editor__section">
        <summary>{t("pizza.transfer.title")}</summary>
        <PizzaMenuTransfer
          onChanged={async () => {
            await load();
            await onChanged?.();
          }}
        />
      </details>

      <div className="pizza-menu-editor__toolbar">
        <label className="pizza-menu-editor__search">
          {t("pizza.menuEditor.search")}
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        {!creating ? (
          <button type="button" className="secondary" onClick={() => setCreating(true)}>
            {t("pizza.menuEditor.newItem")}
          </button>
        ) : null}
      </div>

      {creating ? (
        <ItemForm
          categories={categories}
          submitLabel={t("pizza.menuEditor.createItem")}
          onCancel={() => setCreating(false)}
          onSubmit={async (input) => {
            const ok = await mutate(async () => {
              const { id } = await savePizzaItem(input);
              setExpandedId(id);
              return t("pizza.menuEditor.saved");
            });
            if (ok) setCreating(false);
          }}
        />
      ) : null}

      {items === null ? <p className="muted">{t("pizza.menuEditor.loading")}</p> : null}
      {items ? (
        <p className="muted pizza-menu-editor__count">
          {t("pizza.menuEditor.count", { shown: filtered.length, total: items.length })}
        </p>
      ) : null}

      <ul className="pizza-admin__list">
        {filtered.map((item) => {
          const expanded = expandedId === item.id;
          return (
            <li
              key={item.id}
              className={`pizza-admin__row${item.active ? "" : " pizza-admin__row--inactive"}`}
              data-testid={`pizza-menu-item-${item.id}`}
            >
              <div className="pizza-menu-editor__head">
                <span className="pizza-menu-item__number">{item.number ?? "—"}</span>
                <strong>{item.name}</strong>
                <span className="pizza-panel__pill pizza-menu-editor__category">
                  {categoryNames.get(item.categoryId) ?? "—"}
                </span>
                {!item.active ? (
                  <span className="pizza-panel__pill">{t("pizza.menuEditor.inactive")}</span>
                ) : null}
                <span className="muted pizza-menu-editor__prices">
                  {item.variants.length === 0
                    ? t("pizza.menuEditor.noVariants")
                    : item.variants
                        .filter((variant) => variant.active)
                        .map(
                          (variant) =>
                            `${variant.sizeLabel ?? t("pizza.menu.standardSize")} ${formatEuro(variant.priceCents)}`
                        )
                        .join(" · ")}
                </span>
              </div>
              <div className="pizza-admin__row-actions">
                <button
                  type="button"
                  className="secondary"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? t("pizza.menuEditor.close") : t("pizza.menuEditor.edit")}: ${item.name}`}
                  onClick={() => setExpandedId(expanded ? null : item.id)}
                >
                  {expanded ? t("pizza.menuEditor.close") : t("pizza.menuEditor.edit")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  aria-label={`${item.active ? t("pizza.menuEditor.deactivate") : t("pizza.menuEditor.activate")}: ${item.name}`}
                  onClick={() =>
                    void mutate(async () => {
                      await setPizzaItemActive(item.id, !item.active);
                      return t("pizza.menuEditor.saved");
                    })
                  }
                >
                  {item.active ? t("pizza.menuEditor.deactivate") : t("pizza.menuEditor.activate")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  aria-label={`${t("pizza.menuEditor.remove")}: ${item.name}`}
                  onClick={() => {
                    if (!window.confirm(t("pizza.menuEditor.removeConfirm", { name: item.name }))) return;
                    void mutate(async () => removalText(await removePizzaItem(item.id)));
                  }}
                >
                  {t("pizza.menuEditor.remove")}
                </button>
              </div>
              {expanded ? (
                <div className="pizza-menu-editor__details">
                  <ItemForm
                    item={item}
                    categories={categories}
                    submitLabel={t("pizza.menuEditor.save")}
                    onSubmit={async (input) => {
                      await mutate(async () => {
                        await savePizzaItem({ ...input, id: item.id });
                        return t("pizza.menuEditor.saved");
                      });
                    }}
                  />
                  <div className="pizza-admin__variants">
                    <h5>{t("pizza.menuEditor.variants")}</h5>
                    <ul>
                      {item.variants.map((variant) => (
                        <VariantRow
                          key={variant.id}
                          variant={variant}
                          itemName={item.name}
                          onSave={(sizeLabel, priceCents) =>
                            mutate(async () => {
                              await savePizzaVariant({
                                id: variant.id,
                                itemId: item.id,
                                sizeLabel,
                                priceCents
                              });
                              return t("pizza.menuEditor.saved");
                            })
                          }
                          onToggleActive={() =>
                            mutate(async () => {
                              await setPizzaVariantActive(variant.id, !variant.active);
                              return t("pizza.menuEditor.saved");
                            })
                          }
                          onRemove={() =>
                            mutate(async () => removalText(await removePizzaVariant(variant.id)))
                          }
                          onInvalid={() =>
                            setFeedback({ kind: "error", text: t("pizza.menuEditor.invalidPrice") })
                          }
                        />
                      ))}
                    </ul>
                    <NewVariantForm
                      itemName={item.name}
                      onInvalid={() =>
                        setFeedback({ kind: "error", text: t("pizza.menuEditor.invalidPrice") })
                      }
                      onCreate={(sizeLabel, priceCents) =>
                        mutate(async () => {
                          await savePizzaVariant({
                            itemId: item.id,
                            sizeLabel,
                            priceCents,
                            sortOrder: item.variants.length + 1
                          });
                          return t("pizza.menuEditor.saved");
                        })
                      }
                    />
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface ItemFormInput {
  number: string | null;
  name: string;
  ingredients: string | null;
  allergens: string | null;
  categoryId: string;
  sortOrder: number;
}

function emptyToNull(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function ItemForm({
  item,
  categories,
  submitLabel,
  onSubmit,
  onCancel
}: {
  item?: PizzaItem;
  categories: PizzaCategory[];
  submitLabel: string;
  onSubmit: (input: ItemFormInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const [number, setNumber] = useState(item?.number ?? "");
  const [name, setName] = useState(item?.name ?? "");
  const [ingredients, setIngredients] = useState(item?.ingredients ?? "");
  const [allergens, setAllergens] = useState(item?.allergens ?? "");
  // Ohne Auswahl gilt beim Speichern die erste Kategorie (auch wenn die Liste erst später lädt).
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? "");
  const sortedCategories = [...categories].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const effectiveCategoryId = categoryId || sortedCategories[0]?.id || "";
  const [sortOrder, setSortOrder] = useState(String(item?.sortOrder ?? 0));
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setError(t("pizza.menuEditor.nameRequired"));
      return;
    }
    if (!effectiveCategoryId) {
      setError(t("pizza.menuEditor.categoryRequired"));
      return;
    }
    setError(null);
    await onSubmit({
      number: emptyToNull(number),
      name: name.trim(),
      ingredients: emptyToNull(ingredients),
      allergens: emptyToNull(allergens),
      categoryId: effectiveCategoryId,
      sortOrder: Number.parseInt(sortOrder, 10) || 0
    });
  }

  return (
    <form className="pizza-menu-editor__form" onSubmit={handleSubmit}>
      <label>
        {t("pizza.menuEditor.number")}
        <input value={number} maxLength={16} onChange={(event) => setNumber(event.target.value)} />
      </label>
      <label className="pizza-menu-editor__wide">
        {t("pizza.menuEditor.name")}
        <input
          value={name}
          maxLength={120}
          required
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="pizza-menu-editor__wide">
        {t("pizza.menuEditor.ingredients")}
        <input
          value={ingredients}
          maxLength={500}
          onChange={(event) => setIngredients(event.target.value)}
        />
      </label>
      <label>
        {t("pizza.menuEditor.allergens")}
        <input value={allergens} maxLength={120} onChange={(event) => setAllergens(event.target.value)} />
      </label>
      <label>
        {t("pizza.menuEditor.category")}
        <select value={effectiveCategoryId} onChange={(event) => setCategoryId(event.target.value)}>
          {sortedCategories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
              {category.active === false ? ` (${t("pizza.menuEditor.inactive")})` : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("pizza.menuEditor.sortOrder")}
        <input
          type="number"
          inputMode="numeric"
          value={sortOrder}
          onChange={(event) => setSortOrder(event.target.value)}
        />
      </label>
      {error ? (
        <p className="pizza-panel__error pizza-menu-editor__wide" role="alert">
          {error}
        </p>
      ) : null}
      <div className="pizza-admin__row-actions pizza-menu-editor__wide">
        <button type="submit" className="primary">
          {submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className="secondary" onClick={onCancel}>
            {t("pizza.menuEditor.cancel")}
          </button>
        ) : null}
      </div>
    </form>
  );
}

function VariantRow({
  variant,
  itemName,
  onSave,
  onToggleActive,
  onRemove,
  onInvalid
}: {
  variant: PizzaVariant;
  itemName: string;
  onSave: (sizeLabel: string | null, priceCents: number) => Promise<boolean>;
  onToggleActive: () => Promise<boolean>;
  onRemove: () => Promise<boolean>;
  onInvalid: () => void;
}) {
  const { t } = useI18n();
  const [sizeLabel, setSizeLabel] = useState(variant.sizeLabel ?? "");
  const [price, setPrice] = useState(centsToInput(variant.priceCents));
  const label = `${itemName} ${variant.sizeLabel ?? t("pizza.menu.standardSize")}`;

  return (
    <li className={variant.active ? "" : "pizza-admin__row--inactive"}>
      <label>
        {t("pizza.menuEditor.sizeLabel")}
        <input
          value={sizeLabel}
          maxLength={32}
          placeholder={t("pizza.menuEditor.sizePlaceholder")}
          aria-label={`${t("pizza.menuEditor.sizeLabel")}: ${label}`}
          onChange={(event) => setSizeLabel(event.target.value)}
        />
      </label>
      <label>
        {t("pizza.menuEditor.price")}
        <input
          value={price}
          inputMode="decimal"
          aria-label={`${t("pizza.menuEditor.price")}: ${label}`}
          onChange={(event) => setPrice(event.target.value)}
        />
      </label>
      {!variant.active ? <span className="pizza-panel__pill">{t("pizza.menuEditor.inactive")}</span> : null}
      <button
        type="button"
        className="primary"
        aria-label={`${t("pizza.menuEditor.save")}: ${label}`}
        onClick={() => {
          const cents = parseEuroToCents(price);
          if (cents === null) {
            onInvalid();
            return;
          }
          void onSave(emptyToNull(sizeLabel), cents);
        }}
      >
        {t("pizza.menuEditor.save")}
      </button>
      <button
        type="button"
        className="secondary"
        aria-label={`${variant.active ? t("pizza.menuEditor.deactivate") : t("pizza.menuEditor.activate")}: ${label}`}
        onClick={() => void onToggleActive()}
      >
        {variant.active ? t("pizza.menuEditor.deactivate") : t("pizza.menuEditor.activate")}
      </button>
      <button
        type="button"
        className="secondary"
        aria-label={`${t("pizza.menuEditor.remove")}: ${label}`}
        onClick={() => {
          if (!window.confirm(t("pizza.menuEditor.removeConfirm", { name: label }))) return;
          void onRemove();
        }}
      >
        {t("pizza.menuEditor.remove")}
      </button>
    </li>
  );
}

function NewVariantForm({
  itemName,
  onCreate,
  onInvalid
}: {
  itemName: string;
  onCreate: (sizeLabel: string | null, priceCents: number) => Promise<boolean>;
  onInvalid: () => void;
}) {
  const { t } = useI18n();
  const [sizeLabel, setSizeLabel] = useState("");
  const [price, setPrice] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cents = parseEuroToCents(price);
    if (cents === null) {
      onInvalid();
      return;
    }
    if (await onCreate(emptyToNull(sizeLabel), cents)) {
      setSizeLabel("");
      setPrice("");
    }
  }

  return (
    <form className="pizza-admin__new-variant" onSubmit={handleSubmit}>
      <label>
        {t("pizza.menuEditor.sizeLabel")}
        <input
          value={sizeLabel}
          maxLength={32}
          placeholder={t("pizza.menuEditor.sizePlaceholder")}
          aria-label={`${t("pizza.menuEditor.addVariant")} ${t("pizza.menuEditor.sizeLabel")}: ${itemName}`}
          onChange={(event) => setSizeLabel(event.target.value)}
        />
      </label>
      <label>
        {t("pizza.menuEditor.price")}
        <input
          value={price}
          inputMode="decimal"
          aria-label={`${t("pizza.menuEditor.addVariant")} ${t("pizza.menuEditor.price")}: ${itemName}`}
          onChange={(event) => setPrice(event.target.value)}
        />
      </label>
      <button type="submit" className="secondary">
        {t("pizza.menuEditor.addVariant")}
      </button>
    </form>
  );
}
