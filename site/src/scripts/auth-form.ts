/** A failed connection must leave the form usable and explain the failure. */
export async function postAuth(path: string, body: unknown) {
  try {
    const response = await fetch(`/api/auth/${path}`, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      signal: AbortSignal.timeout(15000), headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    const detail = typeof data?.detail === "string" ? data.detail
      : Array.isArray(data?.detail) ? data.detail[0]?.msg : "Could not complete the request.";
    return { ok: response.ok, detail };
  } catch {
    return { ok: false, detail: "Could not connect. Please check your connection and try again." };
  }
}
