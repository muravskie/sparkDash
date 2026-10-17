import { authHeaders, reportAuthRequired } from "../../api/authToken";

export interface ModelHealth {
  status: "healthy" | "unhealthy" | "unknown";
  label: string;
  reason: string | null;
}

export interface ControllerModel {
  id: string;
  name: string;
  endpoint: string | null;
  roles: string[];
  engine: string | null;
  ownership: string | null;
  runtime: string;
  health: ModelHealth;
  registered: boolean;
  enabled: boolean | null;
}

export interface ModelOperation {
  id: string;
  model_id: string;
  action: string;
  state: "working" | "succeeded" | "failed" | "unknown";
  error: string | null;
  result: { transaction_id?: string; status?: string } | null;
  acknowledged?: boolean;
}

export interface ControllerEvent {
  model_id?: string;
  operation?: string;
  phase?: string;
  transaction_id?: string;
}

export interface ScriptGuardState {
  hideAll: boolean;
  blockedIds: string[];
  reason: string | null;
}

export interface ModelsBoard {
  configured: boolean;
  available: boolean;
  error: string | null;
  models: ControllerModel[];
  active: string | null;
  operations: ModelOperation[];
  events: ControllerEvent[];
  scriptGuard: ScriptGuardState;
}

async function fail(res: Response): Promise<never> {
  if (res.status === 401) reportAuthRequired();
  const body = await res.json().catch(() => ({ error: res.statusText }));
  throw new Error(body.error || `HTTP ${res.status}`);
}

export async function fetchModels(sparkId: string): Promise<ModelsBoard> {
  const res = await fetch(`/api/sparks/${encodeURIComponent(sparkId)}/models`, { headers: { ...authHeaders() } });
  if (!res.ok) await fail(res);
  return res.json();
}

export async function postModelAction(sparkId: string, modelId: string, action: "activate" | "deactivate"): Promise<ModelOperation> {
  const res = await fetch(`/api/sparks/${encodeURIComponent(sparkId)}/models/${encodeURIComponent(modelId)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: "{}",
  });
  if (!res.ok) await fail(res);
  return res.json();
}

export async function acknowledgeOperation(sparkId: string, operationId: string): Promise<ModelOperation> {
  const res = await fetch(`/api/sparks/${encodeURIComponent(sparkId)}/models/operations/${encodeURIComponent(operationId)}/acknowledge`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  if (!res.ok) await fail(res);
  return res.json();
}
