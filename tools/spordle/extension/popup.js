const button = document.querySelector('#capture');
const status = document.querySelector('#status');
button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Reading the current team page…';
  try {
    const result = await chrome.runtime.sendMessage({type: 'capture-team'});
    if (!result?.ok) throw new Error(result?.error || 'Capture failed.');
    status.textContent = `Saved privately on Helios.\n${result.tableCount} tables captured.\nOpen another team tab and capture again if needed.`;
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
