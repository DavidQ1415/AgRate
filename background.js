chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === "RMP_FETCH") {
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
  }

  if (message.type === "ANEX_FETCH") {
    (async () => {
      try {
        const { dept, number } = message.payload || {};
        const body = `dept=${encodeURIComponent(
          dept || ""
        )}&number=${encodeURIComponent(number || "")}`;
        const res = await fetch(message.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
          },
          body
        });

        if (!res.ok) {
          sendResponse({ ok: false, error: `ANEX HTTP ${res.status}` });
          return;
        }

        const json = await res.json();
        sendResponse({ ok: true, data: json });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();

    return true;
  }
});
