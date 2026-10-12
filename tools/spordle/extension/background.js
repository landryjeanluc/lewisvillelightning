// Runs only after the user clicks Capture. No cookies API, network replay, or polling.
function captureVisibleTeam() {
  const url = new URL(location.href);
  if (url.origin !== 'https://page.spordle.com' || !/^\/(?:en\/|fr\/)?lewisville\/teams\/223790\/?$/.test(url.pathname)) {
    throw new Error('Open the Lewisville team 223790 page before capturing.');
  }
  if (/security checkpoint|just a moment|access denied|verify you are human/i.test(document.title)) {
    throw new Error('Spordle has not loaded the team page. No data was captured.');
  }
  const visible = element => element.getClientRects().length > 0;
  const clean = value => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => {
      const k = key.toLowerCase().replace(/[_-]/g, '');
      return !/(token|password|secret|cookie|authorization|apikey)/.test(k)
        && !['apiprovider','apiproviders','spordleclient','session','currentuser','user','account','auth'].includes(k);
    }).map(([key, item]) => [key, clean(item)]));
  };
  let next = {};
  try { next = JSON.parse(document.querySelector('#__NEXT_DATA__')?.textContent || '{}'); } catch { /* DOM capture remains available. */ }
  const props = next.props?.pageProps || {};
  const sections = Object.fromEntries(Object.entries(props).filter(([key]) =>
    /^(spTeam|team|games?|schedules?|roster|players?|participants?|staff|standings|statistics|stats|season|category|office|organization)$/i.test(key)));
  const main = document.querySelector('main, [role="main"]') || document.body;
  const tables = [...main.querySelectorAll('table,[role="table"],[role="grid"]')].filter(visible).map(table => ({
    caption: table.querySelector('caption')?.innerText || '',
    rows: [...table.querySelectorAll('tr,[role="row"]')].filter(visible).map(row =>
      [...row.querySelectorAll('th,td,[role="cell"],[role="columnheader"],[role="gridcell"]')]
        .map(cell => cell.innerText.trim())),
  }));
  const headings = [...main.querySelectorAll('h1,h2,h3,[role="tab"]')].filter(visible).map(node => node.innerText.trim());
  const images = [...main.querySelectorAll('img')].filter(visible).map(img => {
    try {
      const src = new URL(img.currentSrc || img.src);
      // Preserve a source path, never signed URLs or other URL credentials.
      return {alt: img.alt, source: src.origin + src.pathname, width: img.naturalWidth, height: img.naturalHeight};
    } catch { return null; }
  }).filter(Boolean);
  const text = main.innerText;
  if (text.length > 180000) throw new Error('Page is too large for a team-only capture.');
  if (!tables.length && !Object.keys(sections).length && !/lightning|lewisville/i.test(text)) {
    throw new Error('No team content found. Open the loaded team page and try again.');
  }
  return {
    version: 1, teamId: '223790', sourceUrl: url.origin + url.pathname,
    capturedAt: new Date().toISOString(),
    data: {sections: clean(sections), headings, tables, images, visibleText: text,
      schema: Object.fromEntries(Object.entries(props).map(([key, value]) => [key, {
        type: Array.isArray(value) ? 'array' : typeof value,
        keys: value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : undefined,
      }]))},
  };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type !== 'capture-team' || sender.id !== chrome.runtime.id) return false;
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      if (!tab?.id) throw new Error('No active team tab.');
      const [execution] = await chrome.scripting.executeScript({target: {tabId: tab.id}, func: captureVisibleTeam});
      if (!execution?.result) throw new Error('Could not read the team page.');
      const saved = await chrome.runtime.sendNativeMessage('ca.lewisville.private_capture', execution.result);
      respond(saved);
    } catch (error) { respond({ok: false, error: error.message}); }
  })();
  return true;
});
