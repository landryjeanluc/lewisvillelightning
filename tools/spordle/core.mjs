import { createHash } from 'node:crypto';

export const teamId = '223790';
export const teamUrl = `https://page.spordle.com/lewisville/teams/${teamId}`;

export function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => {
    const normalized = key.toLowerCase().replace(/[_-]/g, '');
    return !/(token|password|secret|cookie|authorization|apikey)/.test(normalized)
      && !['apiprovider', 'apiproviders', 'spordleclient', 'session', 'currentuser',
        'user', 'account', 'auth', 'authuser'].includes(normalized);
  }).map(([key, item]) => [key, sanitize(item)]));
}

export function extractPageData(next) {
  if (String(next?.query?.teamId) !== teamId) {
    throw new Error('The loaded page is not team 223790. No snapshot was written.');
  }
  const props = next?.props?.pageProps;
  if (!props || typeof props !== 'object' || props.error || props.statusCode >= 400) {
    throw new Error('Team page data is missing or reports an error.');
  }
  // Avoid saving the page-wide account, billing, and integration configuration.
  const sections = Object.fromEntries(Object.entries(props).filter(([key]) =>
    /^(team|games?|schedules?|roster|players?|participants?|staff|standings|statistics|stats|season|category|office|organization)$/i.test(key)));
  if (!Object.keys(sections).length) {
    throw new Error('Unrecognized page data schema; update the adapter after inspecting the page.');
  }
  return sanitize(sections);
}

export function belongsToTeamPage(url) {
  try {
    const u = new URL(url);
    return u.origin === 'https://page.spordle.com'
      && new RegExp(`^/(?:en/|fr/)?lewisville/teams/${teamId}(?:/|$)`).test(u.pathname);
  } catch { return false; }
}

export function isTeamResponse(url, method = 'GET') {
  if (method !== 'GET') return false;
  try {
    const u = new URL(url);
    if (!['pub-api.play.spordle.com', 'pub-proxy.hcr.spordle.com'].includes(u.hostname)) return false;
    if (u.protocol !== 'https:') return false;
    if (!/\/(?:sp|public)\//.test(u.pathname)) return false;
    const decoded = u.pathname + '?' + decodeURIComponent(u.search);
    // Intentionally narrow: no organization-wide, account, or unrelated team exports.
    return new RegExp(`(?:^|[^0-9])${teamId}(?:[^0-9]|$)`).test(decoded)
      && !/(?:login|auth|members|contacts|registration|payment)/i.test(u.pathname);
  } catch { return false; }
}

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

export function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function describeChanges(previous, current) {
  const sections = new Set([...Object.keys(previous || {}), ...Object.keys(current)]);
  return [...sections].filter(key => digest(previous?.[key] ?? null) !== digest(current[key] ?? null));
}

export function pageProblem(title, url) {
  if (/security checkpoint|just a moment|access denied|verify you are human/i.test(title)) return 'browser_check_required';
  if (/login|sign.?in/i.test(title) || /\/login(?:[/?]|$)/.test(url)) return 'login_required';
  if (!belongsToTeamPage(url)) return 'wrong_page';
  return null;
}
