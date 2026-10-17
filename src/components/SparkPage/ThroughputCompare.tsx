import { Fragment } from "react";
import { formatTokDelta, tokDelta, type ThroughputCompareRow } from "./throughputCompare";

function cell(n: number | null): string {
  return n == null ? "—" : n.toFixed(1);
}

/**
 * Side-by-side tok/s. A mismatched pair passes a reason and no rows, so the
 * table does not invent a score.
 */
export function ThroughputCompare({
  reason,
  rows,
  primaryLabel,
  secondaryLabel,
  thisLabel,
  otherLabel,
  onClear,
}: {
  reason: string | null;
  rows: ThroughputCompareRow[];
  primaryLabel: string;
  /** Null hides the stream columns (prefill has one rate per size). */
  secondaryLabel: string | null;
  thisLabel: string;
  otherLabel: string;
  onClear: () => void;
}) {
  const groups = rows.some((r) => r.group);
  return (
    <div className="bench-compare" aria-label="Run comparison">
      <div className="bench-compare__head">
        <span className="eyebrow">Compare</span>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onClear}>
          Clear
        </button>
      </div>
      <p className="bench-sheet__hint">
        This run ({thisLabel}) against {otherLabel}. Delta is this run minus the other.
      </p>
      {reason ? (
        <p className="bench-sheet__hint" role="status">
          {reason}
        </p>
      ) : null}
      {!reason && rows.length === 0 ? <p className="bench-sheet__hint">No shared levels to score.</p> : null}
      {!reason && rows.length > 0 ? (
        <div className="bp-table-wrap">
          <table className="bp-table">
            <thead>
              <tr>
                <th>Level</th>
                <th className="bp-num">{primaryLabel}</th>
                <th className="bp-num">Other</th>
                <th className="bp-num">Δ</th>
                {secondaryLabel ? (
                  <>
                    <th className="bp-num">{secondaryLabel}</th>
                    <th className="bp-num">Other</th>
                    <th className="bp-num">Δ</th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const showGroup = groups && r.group && (i === 0 || rows[i - 1].group !== r.group);
                const span = secondaryLabel ? 7 : 4;
                return (
                  <Fragment key={r.key}>
                    {showGroup ? (
                      <tr>
                        <td colSpan={span}>
                          <strong>{r.group}</strong>
                        </td>
                      </tr>
                    ) : null}
                    <tr>
                      <td>{r.level}</td>
                      <td className="bp-num">{cell(r.primaryA)}</td>
                      <td className="bp-num">{cell(r.primaryB)}</td>
                      <td className="bp-num">{formatTokDelta(tokDelta(r.primaryA, r.primaryB))}</td>
                      {secondaryLabel ? (
                        <>
                          <td className="bp-num">{cell(r.secondaryA)}</td>
                          <td className="bp-num">{cell(r.secondaryB)}</td>
                          <td className="bp-num">{formatTokDelta(tokDelta(r.secondaryA, r.secondaryB))}</td>
                        </>
                      ) : null}
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
