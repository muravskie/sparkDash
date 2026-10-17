import { authHeaders, reportAuthRequired } from "../../../api/authToken";

/** Same-origin fetch with the dashboard access token. */
export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  for (const [key, value] of Object.entries(authHeaders())) headers.set(key, value);
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) reportAuthRequired();
  return response;
}

export async function apiJson(url: string, options: RequestInit = {}) {
  const response = await apiFetch(url, options);
  const body = await response.json();
  if (!response.ok) {
    const detail = body?.detail ?? body?.error;
    throw new Error(typeof detail === "string" ? detail : `Request failed (${response.status})`);
  }
  return body;
}
