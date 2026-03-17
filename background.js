chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "RMP_FETCH") return;

  (async () => {
    try {
      const res = await fetch(message.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message.payload)
      });

      if (!res.ok) {
        sendResponse({ ok: false, error: `RMP HTTP ${res.status}` });
        return;
      }

      const json = await res.json();
      sendResponse({ ok: true, data: json });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();

  return true;
});
