import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ProviderCatalogModel } from "./BenchTargetFrame";

function money(n: number): string {
  const precise = n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  const decimals = precise.includes(".") ? precise.split(".")[1].length : 0;
  return decimals <= 2 ? `$${n.toFixed(2)}` : `$${precise}`;
}

function rate(value: number | undefined, known: boolean): string {
  if (!known) return "—";
  return typeof value === "number" && Number.isFinite(value) ? money(value) : "—";
}

/** Hosted-provider model list as a table. A native select can only show one flat line. */
export function ProviderModelMenu({
  models,
  value,
  onChange,
  label = "Models",
}: {
  models: readonly ProviderCatalogModel[];
  value: string;
  onChange: (id: string) => void;
  /** Dialog name, for example "OpenRouter models". */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const selected = models.find((model) => model.id === value) ?? null;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((model) => model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q));
  }, [models, query]);

  function close() {
    setOpen(false);
    setQuery("");
  }

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const row = root.current?.querySelector<HTMLElement>("tr.is-active");
    row?.scrollIntoView?.({ block: "nearest" });
  }, [open, value]);

  return (
    <div className="bp-field bp-field--grow bp-model-menu" ref={root}>
      <span className="eyebrow">Model</span>
      <button
        type="button"
        className="bp-model-trigger"
        aria-label="Model"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={!models.length}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
      >
        {selected?.name || "Choose a model"}
      </button>
      {open ? (
        <div className="bp-model-panel" id={panelId} role="dialog" aria-label={label}>
          <input
            className="bp-model-filter"
            type="text"
            value={query}
            placeholder="Filter models"
            aria-label="Filter models"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="bp-model-scroll">
          <table className="bp-model-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Features</th>
                <th scope="col" className="bp-num">Context</th>
                <th scope="col" className="bp-num" title="Input price per 1M tokens">In</th>
                <th scope="col" className="bp-num" title="Output price per 1M tokens">Out</th>
                <th scope="col" className="bp-num" title="Cached input price per 1M tokens">Cache</th>
                <th scope="col" className="bp-num" title="Cache write price per 1M tokens">Write</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={7}>No matching models</td>
                </tr>
              ) : null}
              {shown.map((model) => {
                const known = model.cost != null;
                const features = model.features?.length ? model.features.join(", ") : "—";
                return (
                  <tr
                    key={model.id}
                    className={model.id === value ? "is-active" : undefined}
                    aria-selected={model.id === value}
                    onClick={() => {
                      onChange(model.id);
                      close();
                    }}
                  >
                    <th scope="row">{model.name}</th>
                    <td>{features}</td>
                    <td className="bp-num">{model.context || "—"}</td>
                    <td className="bp-num">{rate(model.cost?.input, known)}</td>
                    <td className="bp-num">{rate(model.cost?.output, known)}</td>
                    <td className="bp-num">{known && model.cost?.cache_read != null ? money(model.cost.cache_read) : "—"}</td>
                    <td className="bp-num">{known && model.cost?.cache_write != null ? money(model.cost.cache_write) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
