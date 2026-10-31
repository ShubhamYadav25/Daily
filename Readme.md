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
- Free self-hosted collaborative boards: host/invite, multi-person live card editing, presence, and follow-host card view
- JSON syntax repair and partial recovery, with unresolved text and original input preserved in recovery reports
- JSON diagnostics with source locations, fix hints, and warnings for duplicate keys, integer precision loss, and suspicious path escapes
- Minimal & distraction-free design
- First-use feature tour on desktop, tablet and mobile, with replay from Tools;
  each description highlights its exact icon or column with a connecting arrow,
  automatically revealing the matching Tools menu item when its icon is hidden
- Keyboard shortcuts and a clickable feature launcher in Tools → Shortcuts

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

## Feature Tour & Keyboard Shortcuts

New browsers automatically show a guided walkthrough of the board and every
tool. Next/Back (or arrow keys) navigate; Escape skips. Completion or skipping
is remembered locally. Replay anytime with **H** or **Tools → Replay Tour**.
The tour does not modify your board or request permissions.

Open **Tools → Shortcuts** (or **?**) for the full guide. Each feature row is
clickable, including on touch devices. Keys are case-insensitive and work from
the board, not while typing, composing text, or editing a tool/dialog.
Ctrl/Cmd/Alt combinations are left to the browser and editor.

| Key | Feature |
| --- | --- |
| N / W | New card / New column |
| / | Search cards |
| E / D / A | Scratch Pad / Drawing Board / AI Assistants |
| O / F / B | Image → Text / Diff Checker / Base64 Converter |
| G / J / Z | Diagrams / JSON Prettifier / ZPL |
| C / M | Calendar events / Time Machine history |
| S / V | Collaborate and device sync / Review sync conflicts |
| R / L / P | Refresh ages / Toggle theme / Enable notifications |
| I / X / U | Import board JSON / Export board JSON / Install app |
| K / H / ? | Tools menu / Replay tour / Shortcut guide |
| Escape | Close tools/dialogs and clear search |

Card-specific controls (priority, comments, timers, move/delete) are available
inside an open card; destructive operations are not assigned global shortcuts.
Use Ctrl+M / Ctrl+Shift+M in the Markdown editor for inline/block math, and
F7 / Shift+F7 in Diff Checker to navigate changes. Importing board JSON replaces
the current board: export a backup first. Board exports contain columns and
cards, not Scratch Pad, events or timers; history has separate backup controls
inside Time Machine.

Run the dependency-free frontend shortcut tests from the repository root:

```powershell
node --test frontend.test.js
```

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

Open `http://localhost:8080` to load the app directly from the relay (it automatically
uses that relay for sync). Alternatively, open [index.html](index.html) and append
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

## Live Collaborative Boards

Choose **Collaborate** (desktop or mobile), enter your name and relay URL, then
click **Host shared board**. The host's current columns, cards, comments and Scratch
Pad become a separate shared board. **Copy invite link** and send it to collaborators;
they can open the link or paste it into **Join board**. No accounts, paid APIs,
subscriptions, or per-person fees are required.

- Guests load the host's board rather than merging in their personal cards.
- Everyone can create, move, rename, edit and delete cards/columns. Card titles,
  notes, priority and color update while editing, without pressing Save.
- Changes are batched every 80 ms while connected, plus network latency. Ordinary
  replacements and deletions apply immediately in collaboration mode. Truly
  competing edits retain alternatives for shared conflict review instead of losing text.
- The shared-board banner shows connection state and online participants. The
  board displays colored live mouse pointers labeled with each person's name.
  Pointers are anchored to cards/columns so they follow local scrolling and
  different screen sizes. They disappear when someone leaves the board area,
  hides their tab or disconnects. Cursor presence is temporary, not saved as board data.
  Touch-only devices can see others' cursors but do not broadcast a mouse pointer.
  Movement is batched every 40 ms plus network latency, without any paid service.
  The invitation panel shows who has a card open. **Follow host card** opens/closes the
  card the host is viewing; this is not video screen sharing or a full Miro canvas.
- **Leave board & restore personal board** returns to your untouched personal data.
  Shared edits and pending conflicts are cached separately per room; a reload or
  reconnect replays that room's history. Legacy **device sync** remains available
  separately and retains its stricter deletion/replacement review behavior.

### Completely Free Local / LAN Use

Run the backend using the setup commands above and open `http://localhost:8080`.
Other devices on the same network should open `http://YOUR-LAN-IP:8080` instead.
Open the host app through that LAN address before copying its invite link; a
`localhost` link points to the recipient's own device. Allow the chosen port through
your firewall only on trusted networks. The backend serves the app and WebSockets;
no additional frontend server or paid infrastructure is needed. The first app
load still needs internet access for its existing CDN assets.

For remote internet collaboration, host the relay on your own reachable machine
or a provider's free tier and enter its `wss://` URL. The code has no paid service
dependency, but third-party free tiers can sleep, impose limits or change pricing;
unlimited always-on public hosting cannot be guaranteed. HTTPS pages require WSS.
Deploy the updated frontend, shared engine and backend together; the previously
hosted relay must be updated before it can accept collaborative rooms.

Shared rooms stay in relay memory even when everyone leaves, until the backend
restarts. There is no server database or durable backup. After a restart, the host
can reopen its cached session to restore the shared room; guests cannot join a
missing room until the host restores it. Export important boards regularly.
Anyone with a room ID can edit; the Host label indicates who started the board,
not an administrator permission. There is no authentication or end-to-end encryption.

---

## 📸 Preview

![alt text](image.png)

---

## ❤️ Feedback

Would love feedback, ideas, and feature suggestions.

If you like the project, consider giving it a ⭐