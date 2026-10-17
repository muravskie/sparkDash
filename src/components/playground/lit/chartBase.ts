// Short chart baseline for the playground strip: a linear scale, a monotone
// path that breaks on gaps, and a light element that tracks its own width.

import { property, state } from "lit/decorators.js";
import { LightElement } from "./base";

export interface Pt {
  x: number;
  y: number;
}

export interface Scale {
  (value: number): number;
  domain: [number, number];
  range: [number, number];
  invert(px: number): number;
}

/** Map domain onto range. A zero-width domain uses a span of 1 so invert stays defined. */
export function linear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const scale = ((value: number) => r0 + ((value - d0) / span) * (r1 - r0)) as Scale;
  scale.domain = domain;
  scale.range = range;
  scale.invert = (px: number) => d0 + ((px - r0) / (r1 - r0 || 1)) * span;
  return scale;
}

function coord(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Fritsch–Carlson cubic through one run. Two points stay a straight segment. */
function curve(points: readonly Pt[]): string {
  const count = points.length;
  if (count === 0) return "";
  if (count === 1) return `M${coord(points[0].x)},${coord(points[0].y)} h0.01`;
  if (count === 2) return `M${coord(points[0].x)},${coord(points[0].y)} L${coord(points[1].x)},${coord(points[1].y)}`;

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < count - 1; i++) {
    const span = points[i + 1].x - points[i].x;
    dx.push(span);
    slope.push(span === 0 ? 0 : (points[i + 1].y - points[i].y) / span);
  }

  const tangent = new Array<number>(count);
  tangent[0] = slope[0];
  tangent[count - 1] = slope[count - 2];
  for (let i = 1; i < count - 1; i++) {
    tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < count - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const ahead = tangent[i] / slope[i];
    const behind = tangent[i + 1] / slope[i];
    const hypot = ahead * ahead + behind * behind;
    if (hypot > 9) {
      const tau = 3 / Math.sqrt(hypot);
      tangent[i] = tau * ahead * slope[i];
      tangent[i + 1] = tau * behind * slope[i];
    }
  }

  let path = `M${coord(points[0].x)},${coord(points[0].y)}`;
  for (let i = 0; i < count - 1; i++) {
    const third = dx[i] / 3;
    const c1x = points[i].x + third;
    const c1y = points[i].y + tangent[i] * third;
    const c2x = points[i + 1].x - third;
    const c2y = points[i + 1].y - tangent[i + 1] * third;
    path += ` C${coord(c1x)},${coord(c1y)} ${coord(c2x)},${coord(c2y)} ${coord(points[i + 1].x)},${coord(points[i + 1].y)}`;
  }
  return path;
}

/** One SVG path. A null, or a non-finite y, starts a new subpath instead of bridging the hole. */
export function monotonePath(points: readonly (Pt | null)[]): string {
  const parts: string[] = [];
  let run: Pt[] = [];
  const flush = () => {
    if (run.length > 0) parts.push(curve(run));
    run = [];
  };
  for (const point of points) {
    if (point == null || !Number.isFinite(point.y)) flush();
    else run.push(point);
  }
  flush();
  return parts.join(" ");
}

/** Measures its own width and redraws when the box actually changes size. */
export class ChartElement extends LightElement {
  @property({ type: Number }) declare height: number;
  @state() protected declare width: number;
  private observer: ResizeObserver | null = null;

  constructor() {
    super();
    this.height = 220;
    this.width = 0;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    const measured = this.getBoundingClientRect().width;
    this.width = measured > 0 ? measured : 600;
    if (typeof ResizeObserver !== "function") return;
    this.observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      if (next && Math.abs(next - this.width) > 1) this.width = next;
    });
    this.observer.observe(this);
  }

  override disconnectedCallback(): void {
    this.observer?.disconnect();
    this.observer = null;
    super.disconnectedCallback();
  }
}
