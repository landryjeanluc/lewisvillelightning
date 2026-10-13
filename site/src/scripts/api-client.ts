/** Shared result-style client for editors: offline failures remain recoverable. */
export async function api(path: string, options: RequestInit = {}): Promise<{ok:boolean; status:number; body:any}> {
  try {
    const headers = new Headers(options.headers);
    if (options.body && !(options.body instanceof FormData)) headers.set('content-type', 'application/json');
    const response = await fetch('/api' + path, {
      ...options, headers, credentials:'same-origin', cache:'no-store',
      signal:options.signal ?? AbortSignal.timeout(15000),
    });
    return {ok:response.ok, status:response.status, body:await response.json().catch(() => null)};
  } catch {
    return {ok:false, status:0, body:{detail:'Could not connect. Your changes have not been confirmed; please try again.'}};
  }
}
