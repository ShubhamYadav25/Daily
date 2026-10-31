# Daily.

A clean and minimal space for your daily workflow.

Instead of writing plans, tasks, updates, and notes here & there — keep everything in one place.

---

## ✨ What is Daily.?

Daily. is a lightweight productivity & daily tracking app that can be used as:

- 📝 Personal daily diary
- ✅ Task / work tracker
- 📌 Planning board
- 🚧 Blocker tracker
- 📊 Progress manager

Whether you're working solo, studying, freelancing, or managing a team — Daily. helps you stay organized without clutter.

---

## 🚀 Features

- Drag & drop workflow
- Create custom statuses
- Daily work updates
- Markdown notes support
- Blocker highlighting
- Auto task aging
- Priority management
- Responsive board, adaptive tool panels, and mobile-friendly forms and navigation
- Consistent [Lucide icons](https://lucide.dev/) (MIT licensed), labeled tools, and accessible action names
- Local storage support
- Multi-device sync with automatic additive merges and shared conflict/deletion review
- JSON syntax repair and partial recovery, with unresolved text and original input preserved in recovery reports
- JSON diagnostics with source locations, fix hints, and warnings for duplicate keys, integer precision loss, and suspicious path escapes
- Minimal & distraction-free design

---

## 💡 Why Daily.?

Most productivity tools become too heavy.

Daily. focuses on simplicity:
write what you're doing, what’s pending, what’s blocked, and what’s next — all in one place.

---

## 🛠 Built With

- React
- Vanilla CSS
- LocalStorage
- Vercel Deployment

---

## 🌐 Live Demo

[Open Daily.](https://daily-one-coral.vercel.app/)

---

## Device Sync

Boards, cards, comments, and Scratch Pad content are shared. Calendar events,
timers, utility inputs, and panel positions remain local to each device.

- Independent new cards and columns are combined; neither device replaces the other's board.
- Recorded text insertions are merged without dropping existing text.
- Removed text, replacement text, competing field edits, and deletions remain pending until explicitly reviewed.
- The conflict dialog shows all alternatives and a line/word diff. Any device can choose an alternative or enter merged text.
- Review Later preserves the alternatives. Reopen them using the conflict icon beside the header tools.
- Different simultaneous decisions reopen a conflict instead of picking a timestamp winner.
- Different initial text without shared history requires review, including prefix differences such as `abc` versus `ab`.
- Offline changes, pending reviews, and deletion history are stored locally and sent again after reconnecting.

### Local Setup

From the repository root:

```powershell
npm ci --prefix Backend
npm test --prefix Backend
npm start --prefix Backend
```

Open [index.html](index.html) and append
`?syncServer=ws%3A%2F%2Flocalhost%3A8080` to its URL to use the local relay.
Create a room and join the same room ID on the other clients. When testing
from another physical device, use the relay computer's reachable address,
not that device's `localhost`. Include the same `syncServer` setting there.

### Deployment And Limits

Deploy the updated [Backend/server.js](Backend/server.js), [sync-engine.js](sync-engine.js),
and frontend together, then reload every client. The relay must be able to
load the shared engine from the repository root. The hosted frontend uses
`wss://daily-2.onrender.com` by default. Older clients/server versions cannot
provide protocol-2 review guarantees; older snapshot messages are not applied
by updated clients.

The relay has no content authority: it combines causal records and broadcasts
decisions. Room state is held in memory while clients are connected, not in a
durable database. Recovery depends on at least one client's retained local
history. Keep board exports, and do not clear browser storage before backing
up. Storage-full failures are surfaced in the app.

A room ID is access to that room; there is no account authentication or
end-to-end encryption. Use HTTPS/WSS for deployed sync and share room IDs
only with trusted collaborators.

---

## 📸 Preview

![alt text](image.png)

---

## ❤️ Feedback

Would love feedback, ideas, and feature suggestions.

If you like the project, consider giving it a ⭐