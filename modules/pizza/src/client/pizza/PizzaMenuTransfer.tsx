import { useRef, useState, type ChangeEvent } from "react";
import { ApiError, getErrorMessage } from "../errors/errors";
import { useI18n, type TFunction } from "../i18n/I18nContext";
import type { MessageKey } from "../i18n/catalog/index";
import { useEventsChanged } from "../realtime/use-events-changed";
import {
  applyPizzaMenuTransfer,
  previewPizzaMenuTransfer,
  type PizzaMenuTransferFormat,
  type PizzaMenuTransferIssue,
  type PizzaMenuTransferResult
} from "./api";

const FORMATS: PizzaMenuTransferFormat[] = ["yaml", "csv", "extras_csv"];
const COUNT_ROWS = ["categories", "items", "variants", "extras"] as const;

/**
 * Dateiinhalt als Text: zuerst UTF-8 (mit oder ohne BOM); scheitert das, Windows-1252, denn so
 * speichert Excel „CSV (Trennzeichen-getrennt)“ ohne UTF-8.
 */
export function decodeImportFile(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1252").decode(buffer);
  }
}

/** Format anhand von Dateiname und Kopfzeile erraten. */
export function guessFormat(fileName: string, content: string): PizzaMenuTransferFormat {
  if (/\.ya?ml$/i.test(fileName)) return "yaml";
  const firstLine = content.replace(/^﻿/, "").split(/\r?\n/, 1)[0]?.trim().toLowerCase() ?? "";
  if (firstLine.startsWith("extra;")) return "extras_csv";
  if (/\.csv$/i.test(fileName) || firstLine.startsWith("kategorie;")) return "csv";
  return "yaml";
}

/** Fehlercodes des Servers mit eigenem Text (`pizza.transfer.error.<code>`). */
const KNOWN_ISSUE_CODES = new Set([
  "too_large",
  "empty",
  "yaml_syntax",
  "csv_quote",
  "csv_header",
  "csv_delimiter",
  "csv_columns",
  "invalid_field",
  "required",
  "invalid_price",
  "invalid_active",
  "duplicate_category",
  "duplicate_item",
  "duplicate_number",
  "duplicate_variant",
  "duplicate_extra",
  "item_conflict",
  "unknown_category",
  "too_many_variants",
  "too_many_rows",
  "unknown_field"
]);

export function issueText(t: TFunction, issue: PizzaMenuTransferIssue) {
  const message = KNOWN_ISSUE_CODES.has(issue.code)
    ? t(`pizza.transfer.error.${issue.code}` as MessageKey, issue.params)
    : t("pizza.transfer.error.unknown", { code: issue.code });
  return issue.line ? t("pizza.transfer.atLine", { line: issue.line, message }) : message;
}

/**
 * Menü als YAML/CSV exportieren und importieren (ab manager). Import immer in zwei Schritten:
 * Vorschau, dann „Übernehmen“. Live-Abgleiche verwerfen weder den Text noch die Vorschau; sie
 * markieren die Vorschau nur als möglicherweise veraltet.
 */
export function PizzaMenuTransfer({ onChanged }: { onChanged?: () => Promise<void> | void }) {
  const { t, locale } = useI18n();
  const [format, setFormat] = useState<PizzaMenuTransferFormat>("yaml");
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState<{ result: PizzaMenuTransferResult; format: string; content: string } | null>(null);
  const [stale, setStale] = useState(false);
  /** Bestätigung der Warnung „viele Einträge werden entfernt“ (gilt nur für die aktuelle Vorschau). */
  const [confirmRemovals, setConfirmRemovals] = useState(false);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ownAction = useRef(false);
  const hasPreview = useRef(false);
  hasPreview.current = preview !== null;

  useEventsChanged(
    () => {
      if (ownAction.current || !hasPreview.current) return;
      setStale(true);
    },
    (reason) => reason === null || reason === "pizza_menu_changed"
  );

  const previewMatches = preview !== null && preview.format === format && preview.content === content;
  const needsConfirm = (preview?.result.warnings ?? []).length > 0;
  // Veraltete Vorschau (Menü inzwischen geändert) erst neu berechnen; der Server lehnt sie ohnehin ab.
  const canApply =
    previewMatches && preview.result.errors.length === 0 && busy === null && !stale && (!needsConfirm || confirmRemovals);

  function showPreview(result: PizzaMenuTransferResult) {
    setPreview({ result, format, content });
    setStale(false);
    setConfirmRemovals(false);
  }

  async function runPreview() {
    setBusy("preview");
    setError(null);
    setStatus(null);
    try {
      showPreview(await previewPizzaMenuTransfer(format, content));
    } catch (err) {
      setError(getErrorMessage(err, locale));
    } finally {
      setBusy(null);
    }
  }

  async function runApply() {
    setBusy("apply");
    setError(null);
    ownAction.current = true;
    try {
      const result = await applyPizzaMenuTransfer(format, content, {
        expectedVersion: preview?.result.menuVersion,
        confirmRemovals
      });
      setPreview(null);
      setConfirmRemovals(false);
      setStale(false);
      setStatus(t("pizza.transfer.applied", { summary: summarize(t, result) }));
      await onChanged?.();
    } catch (err) {
      // Fehler in der Datei, inzwischen geändertes Menü (409) oder fehlende Bestätigung: neue
      // Vorschau zeigen, damit der Nutzer die aktuellen Zahlen sieht, bevor er erneut übernimmt.
      const body = err instanceof ApiError ? (err.body as { error?: string; result?: PizzaMenuTransferResult }) : undefined;
      if (body?.result) {
        showPreview(body.result);
        if (body.error === "pizza_menu_geaendert") setError(t("pizza.transfer.staleRejected"));
      } else {
        setError(getErrorMessage(err, locale));
      }
    } finally {
      setBusy(null);
      // Das eigene pizza_menu_changed kommt entprellt; erst danach wieder als fremd werten.
      window.setTimeout(() => {
        ownAction.current = false;
      }, 1000);
    }
  }

  function loadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void file.arrayBuffer().then((buffer) => {
      const text = decodeImportFile(buffer);
      setContent(text);
      setFormat(guessFormat(file.name, text));
      setStatus(null);
    });
  }

  return (
    <div className="pizza-transfer" data-testid="pizza-menu-transfer">
      <p className="muted">{t("pizza.transfer.help")}</p>
      <div className="pizza-transfer__actions">
        <a className="secondary pizza-panel__pdf-link" href="/api/m/pizza/admin/menu/export.yaml" download>
          {t("pizza.transfer.exportYaml")}
        </a>
        <a className="secondary pizza-panel__pdf-link" href="/api/m/pizza/admin/menu/export.csv" download>
          {t("pizza.transfer.exportCsv")}
        </a>
        <a className="secondary pizza-panel__pdf-link" href="/api/m/pizza/admin/menu/extras-export.csv" download>
          {t("pizza.transfer.exportExtrasCsv")}
        </a>
      </div>

      <div className="pizza-transfer__actions">
        <label>
          {t("pizza.transfer.format")}
          <select value={format} onChange={(event) => setFormat(event.target.value as PizzaMenuTransferFormat)}>
            {FORMATS.map((option) => (
              <option key={option} value={option}>
                {t(`pizza.transfer.format.${option}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="pizza-json-admin__upload">
          <span>{t("pizza.transfer.file")}</span>
          <input type="file" accept=".yaml,.yml,.csv,text/csv,application/yaml,text/yaml" onChange={loadFile} />
        </label>
      </div>
      <textarea
        className="pizza-json-admin__textarea"
        aria-label={t("pizza.transfer.content")}
        value={content}
        rows={10}
        spellCheck={false}
        onChange={(event) => setContent(event.target.value)}
      />

      {error ? (
        <p className="pizza-panel__error" role="alert">
          {error}
        </p>
      ) : null}
      {status ? (
        <p className="muted" role="status">
          {status}
        </p>
      ) : null}

      {preview ? (
        <div className="pizza-transfer__preview" data-testid="pizza-transfer-preview">
          <h5>{t("pizza.transfer.previewTitle")}</h5>
          {stale ? (
            <p className="muted pizza-panel__stale" role="status">
              {t("pizza.transfer.stale")}
            </p>
          ) : null}
          {!previewMatches ? <p className="muted">{t("pizza.transfer.edited")}</p> : null}
          {preview.result.errors.length === 0 && needsConfirm ? (
            <div className="pizza-transfer__warnings" role="alert">
              {preview.result.warnings.map((warning, index) => (
                <p key={index} className="pizza-panel__error">
                  {t("pizza.transfer.warning.many_removed", {
                    kind: t(`pizza.transfer.row.${String(warning.params?.kind ?? "items")}` as MessageKey),
                    count: warning.params?.count ?? 0,
                    total: warning.params?.total ?? 0
                  })}
                </p>
              ))}
              <label className="pizza-extras__option">
                <input
                  type="checkbox"
                  checked={confirmRemovals}
                  onChange={(event) => setConfirmRemovals(event.target.checked)}
                />
                {t("pizza.transfer.confirmRemovals")}
              </label>
            </div>
          ) : null}
          {preview.result.errors.length > 0 ? (
            <>
              <p className="pizza-panel__error">{t("pizza.transfer.errors", { count: preview.result.errors.length })}</p>
              <ul className="pizza-transfer__errors">
                {preview.result.errors.map((issue, index) => (
                  <li key={index}>{issueText(t, issue)}</li>
                ))}
              </ul>
            </>
          ) : (
            <table className="pizza-transfer__counts">
              <thead>
                <tr>
                  <th />
                  <th>{t("pizza.transfer.count.new")}</th>
                  <th>{t("pizza.transfer.count.changed")}</th>
                  <th>{t("pizza.transfer.count.unchanged")}</th>
                  <th>{t("pizza.transfer.count.removed")}</th>
                </tr>
              </thead>
              <tbody>
                {COUNT_ROWS.filter((row) => (row === "extras" ? preview.result.sections.extras : preview.result.sections.menu)).map(
                  (row) => (
                    <tr key={row} data-testid={`pizza-transfer-count-${row}`}>
                      <th>{t(`pizza.transfer.row.${row}` as MessageKey)}</th>
                      <td>{preview.result.counts[row].new}</td>
                      <td>{preview.result.counts[row].changed}</td>
                      <td>{preview.result.counts[row].unchanged}</td>
                      <td>{preview.result.counts[row].removed}</td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      <div className="pizza-transfer__actions">
        <button type="button" className="secondary" disabled={!content.trim() || busy !== null} onClick={() => void runPreview()}>
          {busy === "preview" ? t("pizza.transfer.previewing") : t("pizza.transfer.preview")}
        </button>
        <button type="button" className="primary" disabled={!canApply} onClick={() => void runApply()}>
          {busy === "apply" ? t("pizza.transfer.applying") : t("pizza.transfer.apply")}
        </button>
      </div>
    </div>
  );
}

function summarize(t: TFunction, result: PizzaMenuTransferResult) {
  return COUNT_ROWS.filter((row) => (row === "extras" ? result.sections.extras : result.sections.menu))
    .map((row) =>
      t("pizza.transfer.summaryRow", {
        label: t(`pizza.transfer.row.${row}` as MessageKey),
        new: result.counts[row].new,
        changed: result.counts[row].changed,
        removed: result.counts[row].removed
      })
    )
    .join(" · ");
}
