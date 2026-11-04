import { useEffect, useState } from "react";
import { requestJson } from "../api/request";

interface ExportShape {
  items: unknown[];
}

interface ImportResponse {
  ok: boolean;
  itemCount: number;
  deactivated: number;
  variantsRemoved: number;
  variantsDeactivated?: number;
}

export function PizzaMenuJsonAdmin() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  async function loadCurrent() {
    setLoading(true);
    try {
      const data = await requestJson<ExportShape>("/api/m/pizza/admin/menu/export");
      setText(JSON.stringify(data, null, 2));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch_failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCurrent();
  }, []);

  async function importNow() {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const parsed = JSON.parse(text) as unknown;
      const result = await requestJson<ImportResponse>("/api/m/pizza/admin/menu/import", {
        method: "PUT",
        body: JSON.stringify(parsed)
      });
      setStatus(
        `Import OK — ${result.itemCount} Einträge, ${result.deactivated} deaktiviert, ${result.variantsRemoved} Varianten entfernt, ${result.variantsDeactivated ?? 0} Varianten deaktiviert (in Bestellungen verwendet).`
      );
      await loadCurrent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "import_failed");
    } finally {
      setBusy(false);
    }
  }

  function downloadJson() {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pizza-menu-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function uploadJson(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        setText(result);
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  }

  return (
    <section className="admin-ops pizza-json-admin" aria-label="Pizza-Menü als JSON">
      <p className="eyebrow">Pizzabestellung</p>
      <h2>Menü als JSON</h2>
      <p className="muted">
        Schema: {"{"} items: [{"{"} id?, number?, name, ingredients?, allergens?, categoryId | category (Name), active?,
        sortOrder?, variants: [{"{"} id?, sizeLabel, priceCents, sortOrder?, active? {"}"}] {"}"}] {"}"}.
        Beim Import werden Einträge per id geupdatet (oder neu angelegt). Fehlende Einträge werden
        deaktiviert; fehlende Varianten werden entfernt bzw. deaktiviert, wenn eine bestehende
        Bestellung sie referenziert. Einzelne Artikel und Preise lassen sich bequemer direkt in der
        Pizzabestellung unter „Menü verwalten“ pflegen (ab manager); dort gibt es auch Import und
        Export als YAML und CSV (Excel) mit Vorschau.
      </p>

      {error ? (
        <p className="pizza-panel__error" role="alert">
          {error}
        </p>
      ) : null}
      {status ? <p className="muted">{status}</p> : null}

      <textarea
        className="pizza-json-admin__textarea"
        value={loading ? "Lade…" : text}
        onChange={(event) => setText(event.target.value)}
        rows={18}
        spellCheck={false}
        disabled={loading || busy}
      />

      <div className="pizza-json-admin__actions">
        <button type="button" onClick={loadCurrent} disabled={busy || loading}>
          Neu laden
        </button>
        <button type="button" onClick={downloadJson} disabled={loading}>
          Als Datei herunterladen
        </button>
        <label className="pizza-json-admin__upload">
          <span>Aus Datei laden</span>
          <input type="file" accept="application/json,.json" onChange={uploadJson} />
        </label>
        <button type="button" className="primary" onClick={importNow} disabled={busy || loading}>
          {busy ? "Import läuft…" : "Importieren"}
        </button>
      </div>
    </section>
  );
}
