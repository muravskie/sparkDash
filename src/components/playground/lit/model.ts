import type { ModelPrice } from "../providerCost";

/** The fields of an llm-dashboard model this page actually reads. */
export interface Model {
  id: string;
  name: string;
  healthy: boolean | null;
  engine: string | null;
  /** Provider model id sent upstream. Local engines leave this unset. */
  upstreamId?: string;
  /** Per-1M token rates for a paid provider model. */
  price?: ModelPrice | null;
}
