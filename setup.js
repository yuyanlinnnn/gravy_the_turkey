document.getElementById('go').addEventListener('click', async () => {
  const msg = document.getElementById('msg');
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    s.getTracks().forEach(t => t.stop()); try { chrome.storage.local.remove('localSR'); } catch {}
    msg.textContent = '✓ Allowed. You can close this tab and click the 🦃 icon to switch the pet on.';
  } catch (e) {
    msg.textContent = 'Not allowed (' + e.name + '). Click the camera icon in the address bar and allow it, then try again.';
  }
});
