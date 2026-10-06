import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../utils/cx.js";

export interface MetricCardComparison {
  /** Label for the previous series (default "previous period"). */
  label?: string;
  /** Delta vs the previous period ("+12%") — consumer-computed. */
  delta?: ReactNode;
  /** Previous-period values, rendered as the secondary (dashed) series. */
  series?: number[];
}

export interface MetricCardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Card title ("Gross volume"). */
  title: ReactNode;
  /** The metric value — its own tabular node, never mixed with text. */
  value?: ReactNode;
  /**
   * Current-period values; two or more points draw the sparkline. Absent or
   * empty renders the chart SCAFFOLD (axes visible) with "No data" and the
   * how-to-fill link inside it (contract 02 §8).
   */
  series?: number[];
  /** Built-in previous-period comparison (contract 02 §8). */
  comparison?: MetricCardComparison;
  /** Freshness label from the data's timestamp ("Updated 12 seconds ago"). */
  freshness?: ReactNode;
  /** "How to fill this" link shown inside the empty scaffold. */
  emptyLink?: { href: string; label?: string };
  /** [More details] affordance. */
  moreDetails?: ReactNode;
}

const CHART_W = 120;
const CHART_H = 36;
const CHART_PAD = 3;

/** Deterministic value→point mapping (pure; identical series in, identical points out). */
function toPoints(values: number[]): string {
  if (values.length === 0) {
    return "";
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const denominator = Math.max(values.length - 1, 1);
  return values
    .map((value, index) => {
      const x = CHART_PAD + (index * (CHART_W - 2 * CHART_PAD)) / denominator;
      const y =
        CHART_H -
        CHART_PAD -
        ((value - min) / span) * (CHART_H - 2 * CHART_PAD);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

/**
 * MetricCard (contract 03 §2.7 / 02 §8): title · value · built-in
 * previous-period comparison (secondary series + delta) · mini chart whose
 * scaffold ALWAYS renders · freshness label · [More details]. The empty
 * state renders INSIDE the chart scaffold — axes/ranges visible, "No data",
 * and a how-to-fill link — never a blank box and never fabricated points.
 * The sparkline mapping is deterministic; no randomness anywhere.
 */
export function MetricCard({
  title,
  value,
  series,
  comparison,
  freshness,
  emptyLink,
  moreDetails,
  className,
  ...rest
}: MetricCardProps) {
  const hasCurrent = Boolean(series && series.length >= 2);
  const hasPrevious = Boolean(comparison?.series && comparison.series.length >= 2);
  const isEmpty = !hasCurrent;

  return (
    <div className={cx("ps-metric", className)} {...rest}>
      <div className="ps-metric__head">
        <p className="ps-metric__title">{title}</p>
        {freshness ? (
          <p className="ps-metric__freshness">{freshness}</p>
        ) : null}
      </div>
      {value !== undefined ? <p className="ps-metric__value ps-num">{value}</p> : null}
      {comparison?.delta !== undefined ? (
        <p className="ps-metric__delta ps-num">
          {comparison.delta}
          <span className="ps-metric__vs">
            vs {comparison.label ?? "previous period"}
          </span>
        </p>
      ) : null}
      <div className="ps-metric__chart">
        <svg
          className="ps-metric__sparkline"
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          role="img"
          aria-label={
            isEmpty
              ? "Chart scaffold — no data"
              : "Trend chart, current period over previous period"
          }
          preserveAspectRatio="none"
          focusable="false"
        >
          {/* scaffold axes — always rendered (contract 02 §8) */}
          <line
            className="ps-metric__axis"
            x1={CHART_PAD}
            y1={CHART_H - CHART_PAD}
            x2={CHART_W - CHART_PAD}
            y2={CHART_H - CHART_PAD}
          />
          <line
            className="ps-metric__axis"
            x1={CHART_PAD}
            y1={CHART_PAD}
            x2={CHART_PAD}
            y2={CHART_H - CHART_PAD}
          />
          {hasPrevious ? (
            <polyline
              className="ps-metric__previous"
              points={toPoints(comparison!.series!)}
            />
          ) : null}
          {hasCurrent ? (
            <polyline className="ps-metric__line" points={toPoints(series!)} />
          ) : null}
        </svg>
        {isEmpty ? (
          <div className="ps-metric__empty">
            <p className="ps-metric__empty-text">No data</p>
            {emptyLink ? (
              <a
                className="ps-metric__empty-link"
                href={emptyLink.href}
              >
                {emptyLink.label ?? "How to fill this"}
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
      {moreDetails ? <div className="ps-metric__more">{moreDetails}</div> : null}
    </div>
  );
}
