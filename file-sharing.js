'use strict';

(() => {
    const scriptUrl = document.currentScript?.src || location.href;
    const template = `
        <div class="fs-intro"><h2>Send files to another device</h2><p>Your files stay on your devices. Choose who to share with and pick up where you left off.</p></div>
        <section aria-label="Connect devices">
            <h3>Connect devices</h3>
            <label>Your name <input data-share="name" class="finput" maxlength="40" placeholder="Guest" autocomplete="off"></label>
            <div class="actions">
                <button data-share="create" class="btn primary" disabled>Create room</button>
                <button data-share="join" class="btn" disabled>Join / rejoin</button>
                <button data-share="leave" class="btn" disabled>Disconnect</button>
            </div>
            <label>Invitation link <input data-share="invite" class="finput" placeholder="Paste the link from the other device" autocomplete="off"></label>
            <button data-share="copy" class="btn" disabled>Copy invitation</button>
            <div data-share="qr"></div>
            <details class="fs-settings"><summary>Connection settings</summary>
                <label>Connection address <input data-share="server" class="finput" type="url" autocomplete="off"></label>
                <p class="hint">Usually you can leave this unchanged.</p>
            </details>
            <p class="hint">Share your invitation privately. Up to 8 devices can join.</p>
            <p data-share="power" class="hint">Keep your devices awake while sharing.</p>
            <p data-share="connection" class="fs-status" role="status">Not connected</p>
            <div data-share="peers" class="peers"></div>
        </section>
        <section aria-label="Send files">
            <h3>Send files</h3>
            <label class="drop" data-share="drop">Choose or drop files
                <input data-share="files" type="file" multiple disabled>
            </label>
            <p class="hint">Each person chooses which files to accept. After reopening Daily, rejoin with the same invitation and choose the original files again to continue.</p>
            <div data-share="sources"></div>
        </section>
        <section aria-label="Received files">
            <h3>Received files</h3>
            <p data-share="storage" class="hint" role="status">Checking available space...</p>
            <p class="hint">Your progress stays on this device. Save completed files before clearing browser data. Some browsers need extra space when saving.</p>
            <div data-share="transfers"></div>
        </section>
        <p data-share="error" class="fs-error" role="alert" hidden></p>`;

    function mount(root, options = {}) {
        root.innerHTML = template;
        const qr = DailyInviteQr.widget(root.querySelector('[data-share="qr"]'), () => room ? root.querySelector('[data-share="invite"]').value : '');
        const CHUNK_SIZE = 1024 * 1024;
        const WINDOW = 4;
        const UUID = /^[a-f0-9-]{36}$/i;
        const HASH = /^[a-f0-9]{64}$/;
        const $ = id => root.querySelector(`[data-share="${id}"]`);
        const sources = new Map(), peers = new Map(), downloads = new Map(), requests = new Map();
        let worker, supported = false, room, socket, ice, reconnectTimer, intentional = true;
        let requestNumber = 0, reconnectAttempt = 0, wakeLock, wakeLockDenied = false, fingerprinting = false;
        let peerId, disposed = false, workerUrl, connectionError = false;

        function error(reason) {
            if (disposed) return;
            console.error('Daily file sharing:', reason);
            connectionError = /connect|network|signal|WebRTC|ICE|channel|Failed to fetch/i.test(reason?.message || String(reason));
            $('error').textContent = friendlyError(reason);
            $('error').hidden = false;
        }

        function friendlyError(reason) {
            const message = reason instanceof Error ? reason.message : String(reason);
            if (reason?.name === 'AbortError') return 'Cancelled. Your saved progress is still here.';
            if (/sharing settings|updated Daily backend/i.test(message)) return 'Sharing is not available on the connection service yet. Ask the site owner to update it, then try again.';
            if (/quota|disk|space/i.test(message)) return 'There is not enough free space to finish this step. Remove unneeded received files or use a device with more space.';
            if (/checksum|integrity|damaged|changed|ordering|chunk/i.test(message)) return 'We could not check this file. Your saved progress is kept. Rejoin and try again, or choose the original file again.';
            if (/worker/i.test(message)) return 'File Sharing could not start. Reload Daily and try again.';
            if (/storage|filesystem|Web Locks|IndexedDB|secure context|HTTPS|origin/i.test(message)) return location.protocol === 'file:'
                ? 'To receive large files and keep your progress, open Daily through a web address instead of opening the downloaded HTML file.'
                : 'This browser cannot save large files here. Try an updated browser and open Daily through a secure web address.';
            if (/room|invitation|already connected|device is busy|full \(8/i.test(message)) return /room is full/i.test(message)
                ? 'This room already has 8 devices. Wait for someone to leave.'
                : /already connected/i.test(message) ? 'This device is already in the room. Close the other sharing window first.'
                    : 'Check your invitation link and try joining again.';
            if (/WebRTC|ICE|NAT|firewall|TURN|signal|network|connect|channel|Failed to fetch/i.test(message)) return 'We could not connect the devices. Check your connection and try again. If it keeps failing, try another network.';
            if (/ws:|wss:|URL/i.test(message)) return 'The connection address is not valid. Check it under Connection settings.';
            if (/fingerprinting/i.test(message)) return 'Wait while your files are prepared before adding more.';
            if (/256 GiB/i.test(message)) return 'This file is too large to share here. Choose a smaller file.';
            if (/file names/i.test(message)) return 'Choose a file with a name no longer than 255 characters.';
            if (/pause|wait|100 files|not complete|file to finish|busy in another tab/i.test(message)) return message;
            return 'This step could not be completed. Your saved progress is kept. Try again.';
        }

        function run(action) {
            return Promise.resolve().then(action).catch(error);
        }

        async function keepAwake() {
            if (disposed || !navigator.wakeLock || wakeLock || wakeLockDenied || document.visibilityState !== 'visible') return;
            try {
                wakeLock = await navigator.wakeLock.request('screen');
                if (disposed) { await wakeLock.release(); wakeLock = null; return; }
                $('power').textContent = 'Your screen will stay awake while this page is visible.';
                wakeLock.addEventListener('release', () => {
                    wakeLock = null;
                    if (!disposed) $('power').textContent = 'Keep your device awake to continue sharing.';
                });
            } catch (failure) {
                if (!['NotAllowedError', 'NotSupportedError'].includes(failure.name)) throw failure;
                console.warn('Screen wake lock unavailable:', failure.message);
                wakeLockDenied = true;
                $('power').textContent = 'Keep your device awake manually. Sharing may pause when you switch apps.';
            }
        }

        function bytes(value) {
            if (!value) return '0 B';
            const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
            return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
        }

        function rpc(action, data = {}, progress, transfer = []) {
            return new Promise((resolve, reject) => {
                if (disposed) { reject(new Error('File Sharing was closed.')); return; }
                const requestId = ++requestNumber;
                requests.set(requestId, { resolve, reject, progress });
                try { worker.postMessage({ requestId, action, data }, transfer); }
                catch (failure) { requests.delete(requestId); reject(failure); }
            });
        }

        function lockDownload(id) {
            return new Promise((resolve, reject) => {
                navigator.locks.request(`daily-download-${id}`, { ifAvailable: true }, lock => {
                    if (disposed) { reject(new Error('File Sharing was closed.')); return; }
                    if (!lock) { reject(new Error('This file is busy in another tab. Pause or close that transfer before continuing.')); return; }
                    return new Promise(release => resolve(release));
                }).catch(reject);
            });
        }

        function button(text, action) {
            const element = document.createElement('button');
            element.className = 'btn';
            element.textContent = text;
            element.onclick = () => run(async () => {
                element.disabled = true;
                try { await action(); } finally { element.disabled = false; }
            });
            return element;
        }

        function row(container, title, detail) {
            const element = document.createElement('div');
            element.className = 'transfer';
            const heading = document.createElement('h3');
            heading.textContent = title;
            const description = document.createElement('p');
            description.textContent = detail;
            const progress = document.createElement('progress');
            progress.max = 1;
            progress.value = 0;
            const status = document.createElement('p');
            const actions = document.createElement('div');
            actions.className = 'actions';
            element.append(heading, description, progress, status, actions);
            container.append(element);
            return { element, progress, status, actions };
        }

        function downloadRow(record) {
            let item = downloads.get(record.id);
            if (!item) {
                item = { record, ui: row($('transfers'), record.meta.name, `${bytes(record.meta.size)} - on this device`), receivers: new Set() };
                downloads.set(record.id, item);
                item.ui.actions.append(
                    button('Save file', () => exportFile(item)),
                    button('Remove from this device', async () => {
                        if (item.receivers.size) throw new Error('Pause this transfer before removing its received copy.');
                        if (!confirm(`Remove the received copy of "${item.record.meta.name}" from this device? This cannot be undone.`)) return;
                        const release = await lockDownload(item.record.id);
                        try { await rpc('delete', { id: item.record.id }); } finally { release(); }
                        const prepared = item.ui.actions.querySelector('.prepared-download');
                        if (prepared) URL.revokeObjectURL(prepared.href);
                        item.ui.element.remove();
                        downloads.delete(item.record.id);
                        await storageStatus();
                    })
                );
            }
            item.record = record;
            item.ui.progress.value = record.meta.size ? record.bytes / record.meta.size : record.complete ? 1 : 0;
            item.ui.status.textContent = record.complete ? 'Ready to save. Your file has been checked.'
                : `${bytes(record.bytes)} / ${bytes(record.meta.size)} saved. Waiting for sender; rejoin and accept its offer to resume.`;
            return item;
        }

        async function storageStatus() {
            const estimate = await navigator.storage.estimate();
            $('storage').textContent = `Space available for received files: ${bytes(Math.max(0, (estimate.quota || 0) - (estimate.usage || 0)))}`;
        }

        async function checkSpace(required) {
            const { quota, usage } = await navigator.storage.estimate();
            if (!Number.isFinite(quota) || !Number.isFinite(usage)) throw new Error('Browser storage quota is unavailable; unable to safely accept this file.');
            if (quota - usage < required + 8 * CHUNK_SIZE) throw new Error(`Not enough browser disk quota. Need about ${bytes(required + 8 * CHUNK_SIZE)} free. Delete local downloads or use a browser/device with more space.`);
        }

        async function exportFile(item) {
            if (!item.record.complete) throw new Error('Wait for this file to finish before saving.');
            const release = await lockDownload(item.record.id);
            try { await saveFile(item); } finally { release(); }
        }

        async function saveFile(item) {
            const name = item.record.meta.name.replace(/[\\/\u0000-\u001f]/g, '_');
            if (window.showSaveFilePicker) {
                const handle = await window.showSaveFilePicker({ suggestedName: name });
                const output = await handle.createWritable();
                item.ui.status.textContent = 'Saving your file...';
                try {
                    for (let index = 0; index < item.record.meta.chunks; index++) {
                        await output.write(await rpc('chunk', { id: item.record.id, index }));
                        item.ui.progress.value = (index + 1) / Math.max(1, item.record.meta.chunks);
                    }
                    await output.close();
                } catch (failure) {
                    try { await output.abort(); } catch (abortError) { error(abortError); }
                    item.ui.status.textContent = 'Could not save. Your progress is kept; try again.';
                    throw failure;
                }
                item.ui.status.textContent = 'Saved. You can now remove the received copy from this page.';
            } else {
                await checkSpace(item.record.meta.size);
                item.ui.status.textContent = 'Preparing your download. This may need extra space...';
                const file = await rpc('export', { id: item.record.id }, progress => {
                    item.ui.progress.value = item.record.meta.size ? progress / item.record.meta.size : 1;
                });
                const url = URL.createObjectURL(file);
                const link = document.createElement('a');
                link.href = url;
                link.download = name;
                link.textContent = 'Download prepared file';
                link.className = 'prepared-download';
                const old = item.ui.actions.querySelector('.prepared-download');
                if (old) {
                    URL.revokeObjectURL(old.href);
                    old.remove();
                }
                item.ui.actions.append(link);
                item.ui.status.textContent = 'Ready. Tap "Download prepared file", then check your download before removing this copy.';
            }
            await storageStatus();
        }

        function invitation(server) {
            const url = new URL('file-sharing.html', scriptUrl);
            if (url.protocol === 'file:') {
                const address = new URL(server);
                address.protocol = address.protocol === 'wss:' ? 'https:' : 'http:';
                address.pathname = '/file-sharing.html';
                url.href = address.href;
            }
            url.search = '';
            url.hash = new URLSearchParams({ room: room.id, key: room.key, server }).toString();
            return url.href;
        }

        function readInvitation(value) {
            const url = new URL(value);
            const params = new URLSearchParams(url.hash.slice(1));
            const id = params.get('room'), key = params.get('key'), server = params.get('server');
            if (!UUID.test(id || '') || !HASH.test(key || '') || !server) throw new Error('Paste a complete Daily file-sharing invitation link.');
            return { id, key, server: validateServer(server) };
        }

        function validateServer(value) {
            const url = new URL(value);
            if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Use a ws:// or wss:// signaling server URL without embedded credentials.');
            if (location.protocol === 'https:' && url.protocol !== 'wss:') throw new Error('HTTPS pages require a secure wss:// signaling server.');
            url.search = '';
            return url.href;
        }

        async function loadConfiguration(server) {
            const url = new URL(server);
            url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
            url.pathname = '/file-sharing-config';
            let response;
            try {
                response = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10000) });
            } catch (failure) {
                console.error('Unable to fetch file-sharing configuration:', url.origin, failure);
                throw new Error('Could not load sharing settings. Check the connection service is online and running the updated Daily backend.', { cause: failure });
            }
            if (!response.ok) throw new Error(`Signaling configuration failed (${response.status}). Deploy the updated Daily backend.`);
            const config = await response.json();
            if (!Array.isArray(config.iceServers)) throw new Error('Invalid sharing settings. Deploy the updated Daily backend.');
            return config;
        }

        function sendSignal(to, signal) {
            if (socket?.readyState !== WebSocket.OPEN) throw new Error('Signaling disconnected. Waiting to reconnect.');
            socket.send(JSON.stringify({ type: 'signal', to, signal }));
        }

        function control(peer, message) {
            if (peer.channel?.readyState !== 'open') throw new Error('Peer disconnected. Rejoin to resume.');
            peer.channel.send(JSON.stringify(message));
        }

        function updatePeers() {
            $('peers').replaceChildren();
            peers.forEach(peer => {
                const element = document.createElement('span');
                element.className = 'peer';
                const states = { new: 'Connecting', connecting: 'Connecting', connected: 'Connected',
                    disconnected: 'Reconnecting', failed: 'Could not connect', closed: 'Disconnected' };
                element.textContent = `${peer.name} - ${peer.network || states[peer.pc.connectionState] || 'Connecting'}`;
                $('peers').append(element);
            });
        }

        function suspendReceiver(peer, message) {
            const receive = peer.receive;
            if (!receive) return;
            receive.stopped = true;
            receive.pending.clear();
            if (!receive.committing) receive.release();
            receive.item.receivers.delete(peer.id);
            receive.item.ui.status.textContent = message;
            peer.receive = null;
            if (receive.pauseButton) receive.pauseButton.remove();
        }

        function destroyPeer(peer, reason) {
            clearTimeout(peer.retryTimer);
            clearTimeout(peer.disconnectTimer);
            suspendReceiver(peer, reason || 'Disconnected. Your progress is kept; rejoin to continue.');
            peer.closed = true;
            peer.channel?.close();
            peer.pc.close();
            peer.offers.forEach(ui => {
                ui.status.textContent = 'Device disconnected. Rejoin to continue.';
                ui.actions.querySelectorAll('button').forEach(element => { element.disabled = true; });
            });
            peer.sending.forEach(state => { state.status.textContent = 'Disconnected. Rejoin to continue from the saved progress.'; });
        }

        function disconnect() {
            intentional = true;
            clearTimeout(reconnectTimer);
            socket?.close();
            socket = null;
            peers.forEach(peer => destroyPeer(peer));
            peers.clear();
            $('connection').textContent = 'Disconnected. Your progress is kept.';
            $('leave').disabled = true;
            $('create').disabled = false;
            $('join').disabled = false;
            $('files').disabled = true;
            updatePeers();
        }

        async function connect(server) {
            ice = await loadConfiguration(server);
            if (intentional || disposed) return;
            const url = new URL(server);
            url.search = new URLSearchParams({ mode: 'files', room: room.id, key: room.key, peer: peerId,
                name: $('name').value.trim() || 'Guest' }).toString();
            const ws = new WebSocket(url);
            socket = ws;
            $('connection').textContent = 'Connecting...';
            ws.onopen = () => {
                if (socket !== ws) return;
                reconnectAttempt = 0;
                $('connection').textContent = ice.relayAvailable
                    ? 'Room ready. Invite another device to start sharing.'
                    : 'Room ready. Some networks may prevent devices from connecting.';
                $('files').disabled = false;
            };
            ws.onerror = () => error(new Error('Signaling connection failed. Check the server address, TLS certificate, and network.'));
            ws.onmessage = event => run(async () => {
                if (socket !== ws) return;
                const message = JSON.parse(event.data);
                if (message.type === 'peers') {
                    const remote = message.peers.filter(person => person.id !== peerId);
                    peers.forEach((peer, id) => {
                        if (!remote.some(person => person.id === id)) {
                            destroyPeer(peer);
                            peers.delete(id);
                        }
                    });
                    for (const person of remote) {
                        if (!peers.has(person.id)) {
                            const peer = createPeer(person);
                            if (peerId < person.id) await makeOffer(peer);
                        }
                    }
                    updatePeers();
                } else if (message.type === 'signal') {
                    const peer = peers.get(message.from);
                    if (!peer) throw new Error('Received signaling from an unknown participant');
                    peer.signals = peer.signals.then(() => applySignal(peer, message.signal)).catch(failure => {
                        error(failure);
                        retryPeer(peer);
                    });
                } else if (message.type === 'peer-unavailable') {
                    const peer = peers.get(message.peer);
                    if (peer) destroyPeer(peer);
                } else throw new Error('Unknown file-sharing signaling response');
            });
            ws.onclose = event => {
                if (socket !== ws) return;
                peers.forEach(peer => destroyPeer(peer));
                peers.clear();
                updatePeers();
                $('files').disabled = true;
                if (intentional) return;
                if (event.code === 1008 || event.code === 1013) {
                    error(new Error(event.reason || 'The signaling server rejected this connection.'));
                    disconnect();
                    return;
                }
                $('connection').textContent = 'Connection lost. Trying again; your progress is kept...';
                scheduleReconnect(server);
            };
        }

        function scheduleReconnect(server) {
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => {
                if (!intentional) connect(server).catch(failure => { error(failure); scheduleReconnect(server); });
            }, Math.min(30000, 1000 * 2 ** Math.min(5, reconnectAttempt++)));
        }

        async function join(value) {
            disconnect();
            $('error').hidden = true;
            room = value;
            $('server').value = value.server;
            $('invite').value = invitation(value.server);
            qr.update();
            if (options.standalone && location.protocol !== 'file:') history.replaceState(null, '', $('invite').value);
            localStorage.setItem('daily_file_invite', $('invite').value);
            localStorage.setItem('daily_file_name', $('name').value);
            $('transfers').replaceChildren();
            downloads.clear();
            if (supported) (await rpc('list', { room: room.id })).forEach(downloadRow);
            intentional = false;
            $('create').disabled = true;
            $('join').disabled = true;
            $('leave').disabled = false;
            try { await connect(value.server); }
            catch (failure) { disconnect(); throw failure; }
        }

        function createPeer(person) {
            const pc = new RTCPeerConnection({ iceServers: ice.iceServers });
            const peer = { id: person.id, name: person.name, pc, channel: null, candidates: [], signals: Promise.resolve(),
                sending: new Map(), offers: new Map(), closed: false, receive: null };
            peers.set(peer.id, peer);
            pc.onicecandidate = event => {
                if (event.candidate && !peer.closed) run(() => sendSignal(peer.id, { kind: 'candidate', value: event.candidate.toJSON() }));
            };
            pc.ondatachannel = event => attachChannel(peer, event.channel);
            pc.onconnectionstatechange = () => {
                updatePeers();
                if (peer.closed) return;
                if (pc.connectionState === 'failed') {
                    error(new Error(`Connection to ${peer.name} failed. If direct WebRTC is blocked, a self-hosted TURN relay is required.`));
                    retryPeer(peer);
                } else if (pc.connectionState === 'disconnected') {
                    clearTimeout(peer.disconnectTimer);
                    peer.disconnectTimer = setTimeout(() => retryPeer(peer), 10000);
                } else if (pc.connectionState === 'connected') {
                    clearTimeout(peer.disconnectTimer);
                    if (connectionError) {
                        $('error').hidden = true;
                        connectionError = false;
                    }
                    run(async () => {
                        const stats = await pc.getStats();
                        stats.forEach(report => {
                            if (report.type === 'transport' && report.selectedCandidatePairId) {
                                const pair = stats.get(report.selectedCandidatePairId);
                                const local = pair && stats.get(pair.localCandidateId);
                                const remote = pair && stats.get(pair.remoteCandidateId);
                                peer.network = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'Connected with help' : 'Connected directly';
                            }
                        });
                        updatePeers();
                    });
                }
            };
            return peer;
        }

        function retryPeer(peer) {
            if (peer.closed || intentional || peers.get(peer.id) !== peer) return;
            destroyPeer(peer);
            if (peerId < peer.id) {
                peer.retryTimer = setTimeout(() => run(async () => {
                    if (intentional || socket?.readyState !== WebSocket.OPEN || peers.get(peer.id) !== peer) return;
                    ice = await loadConfiguration(room.server);
                    const replacement = createPeer(peer);
                    await makeOffer(replacement);
                }), 3000);
            }
        }

        async function makeOffer(peer) {
            attachChannel(peer, peer.pc.createDataChannel('daily-files-v1', { ordered: true }));
            await peer.pc.setLocalDescription(await peer.pc.createOffer());
            sendSignal(peer.id, { kind: 'description', value: peer.pc.localDescription.toJSON() });
        }

        async function applySignal(original, signal) {
            let peer = peers.get(original.id);
            if (!peer || intentional) return;
            if (signal.kind === 'description') {
                if (signal.value?.type === 'offer' && (peer.closed || peer.pc.signalingState === 'stable' && peer.channel)) {
                    destroyPeer(peer);
                    peer = createPeer(peer);
                }
                await peer.pc.setRemoteDescription(signal.value);
                for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
                if (signal.value.type === 'offer') {
                    await peer.pc.setLocalDescription(await peer.pc.createAnswer());
                    sendSignal(peer.id, { kind: 'description', value: peer.pc.localDescription.toJSON() });
                }
            } else if (signal.kind === 'candidate') {
                if (peer.closed) return;
                if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(signal.value);
                else peer.candidates.push(signal.value);
            } else throw new Error('Invalid WebRTC signal');
        }

        function attachChannel(peer, channel) {
            if (peer.channel) throw new Error('Unexpected duplicate file channel');
            peer.channel = channel;
            channel.binaryType = 'arraybuffer';
            channel.bufferedAmountLowThreshold = 128 * 1024;
            channel.onopen = () => {
                peer.network = peer.network || 'Connected';
                updatePeers();
                sources.forEach(source => offer(peer, source));
            };
            channel.onclose = () => {
                if (!peer.closed) retryPeer(peer);
            };
            channel.onerror = () => error(new Error(`File channel error with ${peer.name}. Saved progress is retained.`));
            channel.onmessage = event => run(async () => {
                try {
                    if (typeof event.data === 'string') {
                        if (event.data.length > 16000) throw new Error('Oversized transfer control message');
                        handleControl(peer, JSON.parse(event.data));
                    } else receiveFrame(peer, event.data);
                } catch (failure) {
                    error(failure);
                    if (channel.readyState === 'open') control(peer, { type: 'error', message: String(failure.message).slice(0, 300) });
                    destroyPeer(peer, 'Sharing stopped. Your progress is kept; rejoin to try again.');
                }
            });
        }

        function validMeta(meta) {
            return meta && typeof meta.name === 'string' && meta.name.length > 0 && meta.name.length <= 255
                && Number.isSafeInteger(meta.size) && meta.size >= 0 && meta.chunkSize === CHUNK_SIZE
                && meta.chunks === Math.ceil(meta.size / CHUNK_SIZE) && meta.chunks <= 262144
                && HASH.test(meta.root || '') && HASH.test(meta.fileId || '');
        }

        function offer(peer, source) {
            if (!peer.closed && peer.channel?.readyState === 'open') control(peer, { type: 'offer', meta: source.meta });
        }

        function nextRequests(receive) {
            const indexes = [];
            while (receive.pending.size < WINDOW && receive.cursor < receive.meta.chunks) {
                const index = receive.cursor++;
                if (!receive.saved.has(index)) {
                    receive.pending.set(index, null);
                    indexes.push(index);
                }
            }
            if (indexes.length) control(receive.peer, { type: 'want', fileId: receive.meta.fileId, session: receive.session, indexes });
        }

        async function accept(peer, meta, offerUi) {
            if (!supported) throw new Error('Receiving needs browser private filesystem support over HTTPS. Update your browser or use desktop Chrome/Edge.');
            if (peer.receive) throw new Error('Pause or complete the current file from this device first.');
            run(keepAwake);
            const id = `${room.id}_${meta.fileId}`;
            const existing = downloads.get(id);
            if (existing?.receivers.size) throw new Error('This file is already being received from another device.');
            const release = await lockDownload(id);
            let receive;
            try {
                offerUi.status.textContent = 'Checking your saved progress and available space...';
                const record = await rpc('prepare', { room: room.id, meta });
                const item = downloadRow(record);
                await checkSpace(Math.max(0, meta.size - record.bytes));
                if (navigator.storage.persist) {
                    const persistent = await navigator.storage.persist();
                    if (!persistent) $('storage').textContent += ' Save completed files soon; your browser may clear them when space runs low.';
                }
                if (peer.closed || peer.channel.readyState !== 'open') throw new Error('Peer disconnected during resume preparation. Rejoin and accept again.');
                if (peer.receive || item.receivers.size) throw new Error('Another transfer started during preparation. Pause it first.');
                receive = { peer, meta, item, id, saved: new Set(record.saved), pending: new Map(), cursor: 0,
                    stopped: false, bytes: record.bytes, started: performance.now(), initialBytes: record.bytes,
                    session: crypto.getRandomValues(new Uint32Array(1))[0], release, committing: 0 };
                peer.receive = receive;
                item.receivers.add(peer.id);
                receive.pauseButton = button('Pause', () => {
                    control(peer, { type: 'pause', fileId: meta.fileId, session: receive.session });
                    suspendReceiver(peer, 'Paused. Click Accept / resume on the sender offer to continue.');
                });
                item.ui.actions.append(receive.pauseButton);
                offerUi.status.textContent = record.repaired ? 'Some saved data needs to be sent again. Continuing...' : 'Accepted. Continuing from your saved progress.';
                control(peer, { type: 'accepted', fileId: meta.fileId, session: receive.session, bytes: record.bytes });
                if (receive.saved.size === meta.chunks) await finishReceive(receive);
                else nextRequests(receive);
            } catch (failure) {
                if (receive && !receive.stopped) {
                    if (peer.channel.readyState === 'open') control(peer, { type: 'pause', fileId: meta.fileId, session: receive.session });
                    suspendReceiver(peer, 'Could not continue. Your progress is kept; try again.');
                } else release();
                throw failure;
            }
        }

        function handleControl(peer, message) {
            if (!message || typeof message.type !== 'string') throw new Error('Invalid transfer control');
            if (message.type === 'offer') {
                if (!validMeta(message.meta)) throw new Error('Invalid file offer');
                if (peer.offers.has(message.meta.fileId)) return;
                if (peer.offers.size >= 100) throw new Error('Too many file offers from this device');
                const ui = row($('transfers'), message.meta.name, `${bytes(message.meta.size)} - offered by ${peer.name}`);
                ui.status.textContent = 'Waiting for your permission. Nothing is downloaded until you accept.';
                ui.actions.append(button('Accept / resume', () => accept(peer, message.meta, ui)));
                peer.offers.set(message.meta.fileId, ui);
            } else if (message.type === 'accepted') {
                const source = sources.get(message.fileId);
                if (!source || !Number.isSafeInteger(message.bytes) || message.bytes < 0 || message.bytes > source.meta.size
                    || !Number.isInteger(message.session) || message.session < 0 || message.session > 0xffffffff) throw new Error('Invalid transfer acceptance');
                if ([...peer.sending.entries()].some(([id, state]) => id !== message.fileId && !state.paused)) throw new Error('A receiver can accept only one file at a time from this device.');
                let state = peer.sending.get(message.fileId);
                if (!state) {
                    const status = document.createElement('p');
                    source.ui.element.append(status);
                    state = { source, status, queue: [], pending: new Set(), busy: false, bytes: 0, paused: false };
                    peer.sending.set(message.fileId, state);
                }
                state.queue = [];
                state.pending.clear();
                state.bytes = message.bytes;
                state.session = message.session;
                state.paused = false;
                state.status.textContent = `${peer.name}: ${bytes(message.bytes)} already saved. Continuing...`;
            } else if (message.type === 'want') {
                const state = peer.sending.get(message.fileId);
                if (state && message.session !== state.session) return;
                if (!state || state.paused || !Array.isArray(message.indexes) || !message.indexes.length || message.indexes.length > WINDOW
                    || state.pending.size + message.indexes.length > WINDOW) throw new Error('Invalid receiver chunk request');
                for (const index of message.indexes) {
                    if (!Number.isInteger(index) || index < 0 || index >= state.source.meta.chunks || state.pending.has(index)) throw new Error('Invalid requested chunk index');
                    state.pending.add(index);
                    state.queue.push(index);
                }
                run(() => pump(peer, state));
            } else if (message.type === 'chunk') {
                const receive = peer.receive;
                if (!receive || receive.stopped) return;
                if (message.session !== receive.session) return;
                const length = Math.min(CHUNK_SIZE, receive.meta.size - message.index * CHUNK_SIZE);
                if (message.fileId !== receive.meta.fileId || !receive.pending.has(message.index)
                    || receive.pending.get(message.index) !== null || message.length !== length || !HASH.test(message.hash || '')) throw new Error('Invalid chunk announcement');
                receive.pending.set(message.index, { buffer: new ArrayBuffer(length), offset: 0, hash: message.hash, committing: false });
            } else if (message.type === 'saved') {
                const state = peer.sending.get(message.fileId);
                if (!state || state.paused) return;
                if (message.session !== state.session) return;
                if (!state.pending.delete(message.index)) throw new Error('Unexpected chunk acknowledgement');
                state.bytes += Math.min(CHUNK_SIZE, state.source.meta.size - message.index * CHUNK_SIZE);
                state.status.textContent = `${peer.name}: ${bytes(state.bytes)} / ${bytes(state.source.meta.size)} saved.`;
            } else if (message.type === 'complete') {
                const state = peer.sending.get(message.fileId);
                if (!state) throw new Error('Unexpected completion message');
                if (message.session !== state.session) return;
                state.paused = true;
                state.status.textContent = `${peer.name}: received and checked.`;
            } else if (message.type === 'pause') {
                const state = peer.sending.get(message.fileId);
                if (state && message.session === state.session) {
                    state.paused = true;
                    state.queue = [];
                    state.status.textContent = `${peer.name}: paused. Progress is kept.`;
                }
            } else if (message.type === 'error') {
                if (typeof message.message !== 'string') throw new Error('Invalid peer error');
                throw new Error(`${peer.name}: ${message.message.slice(0, 300)}`);
            } else throw new Error('Unknown file-transfer control message');
        }

        function receiveFrame(peer, frame) {
            const receive = peer.receive;
            if (!receive || receive.stopped) return;
            if (!(frame instanceof ArrayBuffer) || frame.byteLength <= 12 || frame.byteLength > 65536) throw new Error('Invalid binary chunk frame');
            const header = new DataView(frame);
            if (header.getUint32(8) !== receive.session) return;
            const index = header.getUint32(0), offset = header.getUint32(4);
            const chunk = receive.pending.get(index);
            const length = frame.byteLength - 12;
            if (!chunk || chunk.committing || offset !== chunk.offset || offset + length > chunk.buffer.byteLength) throw new Error('Unexpected chunk data or ordering');
            new Uint8Array(chunk.buffer, offset, length).set(new Uint8Array(frame, 12));
            chunk.offset += length;
            if (chunk.offset === chunk.buffer.byteLength) {
                chunk.committing = true;
                receive.committing++;
                const buffer = chunk.buffer;
                run(async () => {
                    try {
                        const record = await rpc('store', { id: receive.id, index, buffer, digest: chunk.hash }, null, [buffer]);
                        receive.saved.add(index);
                        receive.pending.delete(index);
                        receive.bytes = record.bytes;
                        receive.item.record = record;
                        if (receive.stopped) return;
                        receive.item.ui.progress.value = record.bytes / Math.max(1, receive.meta.size);
                        const seconds = (performance.now() - receive.started) / 1000;
                        const speed = (record.bytes - receive.initialBytes) / Math.max(1, seconds);
                        const remaining = speed ? Math.ceil((receive.meta.size - record.bytes) / speed) : null;
                        receive.item.ui.status.textContent = `${bytes(record.bytes)} / ${bytes(receive.meta.size)} saved - ${bytes(speed)}/s${remaining === null ? '' : ` - about ${remaining}s remaining`}`;
                        control(peer, { type: 'saved', fileId: receive.meta.fileId, session: receive.session, index });
                        if (receive.saved.size === receive.meta.chunks) await finishReceive(receive);
                        else nextRequests(receive);
                    } catch (failure) {
                        if (!receive.stopped) {
                            if (peer.channel.readyState === 'open') control(peer, { type: 'pause', fileId: receive.meta.fileId, session: receive.session });
                            suspendReceiver(peer, 'Could not save the next part. Your progress is kept; check available space and try again.');
                        }
                        throw failure;
                    } finally {
                        receive.committing--;
                        if (receive.stopped && !receive.committing) receive.release();
                    }
                });
            }
        }

        async function finishReceive(receive) {
            receive.item.ui.status.textContent = 'Checking your completed file...';
            const record = await rpc('finish', { id: receive.id });
            if (receive.stopped) return;
            downloadRow(record);
            control(receive.peer, { type: 'complete', fileId: receive.meta.fileId, session: receive.session });
            receive.item.receivers.delete(receive.peer.id);
            receive.pauseButton.remove();
            receive.peer.receive = null;
            receive.stopped = true;
            if (!receive.committing) receive.release();
            await storageStatus();
        }

        function waitForBuffer(peer) {
            const channel = peer.channel;
            if (channel.readyState !== 'open') return Promise.reject(new Error('Peer disconnected while sending'));
            if (channel.bufferedAmount <= 256 * 1024) return Promise.resolve();
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => done(new Error('File channel stalled. Rejoin to resume.')), 30000);
                const low = () => done();
                const closed = () => done(new Error('Peer disconnected while sending'));
                function done(failure) {
                    clearTimeout(timer);
                    channel.removeEventListener('bufferedamountlow', low);
                    channel.removeEventListener('close', closed);
                    channel.removeEventListener('error', closed);
                    if (failure) reject(failure); else resolve();
                }
                channel.addEventListener('bufferedamountlow', low);
                channel.addEventListener('close', closed);
                channel.addEventListener('error', closed);
                if (channel.readyState !== 'open') closed();
                else if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) low();
            });
        }

        async function pump(peer, state) {
            if (state.busy) return;
            state.busy = true;
            const session = state.session;
            try {
                while (state.queue.length && !state.paused && !peer.closed && state.session === session) {
                    const index = state.queue.shift();
                    const source = state.source;
                    const buffer = await source.file.slice(index * CHUNK_SIZE, Math.min(source.file.size, (index + 1) * CHUNK_SIZE)).arrayBuffer();
                    const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(value => value.toString(16).padStart(2, '0')).join('');
                    if (actual !== source.hashes[index]) throw new Error('The source file changed after fingerprinting. Reselect it before sharing.');
                    if (state.paused || peer.closed || state.session !== session) break;
                    await waitForBuffer(peer);
                    if (state.paused || peer.closed || state.session !== session) break;
                    control(peer, { type: 'chunk', fileId: source.meta.fileId, session, index, hash: actual, length: buffer.byteLength });
                    const negotiated = peer.pc.sctp?.maxMessageSize;
                    const frameSize = Math.min(16384, negotiated && Number.isFinite(negotiated) ? negotiated : 16384);
                    if (frameSize <= 12) throw new Error('Negotiated WebRTC message limit is too small');
                    for (let offset = 0; offset < buffer.byteLength; offset += frameSize - 12) {
                        await waitForBuffer(peer);
                        if (peer.closed || state.paused || state.session !== session) break;
                        const length = Math.min(frameSize - 12, buffer.byteLength - offset);
                        const frame = new Uint8Array(length + 12);
                        const header = new DataView(frame.buffer);
                        header.setUint32(0, index);
                        header.setUint32(4, offset);
                        header.setUint32(8, session);
                        frame.set(new Uint8Array(buffer, offset, length), 12);
                        peer.channel.send(frame);
                    }
                }
            } catch (failure) {
                state.paused = true;
                state.status.textContent = 'Sharing stopped. Your progress is kept; rejoin to continue.';
                if (peer.channel?.readyState === 'open') control(peer, { type: 'error', message: failure.message.slice(0, 300) });
                throw failure;
            } finally {
                state.busy = false;
                if (state.queue.length && !state.paused && !peer.closed) run(() => pump(peer, state));
            }
        }

        async function selectFiles(files) {
            if (fingerprinting) throw new Error('Wait for the current files to finish fingerprinting before adding more.');
            if (intentional || socket?.readyState !== WebSocket.OPEN) throw new Error('Connect to a room before choosing files.');
            if (files.length > 100 || sources.size + files.length > 100) throw new Error('Share up to 100 files at a time.');
            fingerprinting = true;
            try {
                for (const file of files) {
                    const ui = row($('sources'), file.name, `${bytes(file.size)} - source stays on your device`);
                    ui.status.textContent = 'Preparing your file...';
                    try {
                        const result = await rpc('hash-file', { file }, progress => {
                            ui.progress.value = file.size ? progress / file.size : 1;
                            ui.status.textContent = `Preparing ${bytes(progress)} / ${bytes(file.size)}...`;
                        });
                        if (sources.has(result.meta.fileId)) {
                            ui.element.remove();
                            continue;
                        }
                        const source = { file, ...result, ui };
                        sources.set(result.meta.fileId, source);
                        ui.progress.value = 1;
                        ui.status.textContent = 'Ready. Connected devices can accept this file. Keep this page open.';
                        ui.actions.append(button('Offer again', () => peers.forEach(peer => offer(peer, source))));
                        peers.forEach(peer => offer(peer, source));
                    } catch (failure) {
                        ui.status.textContent = 'Could not prepare this file. Choose it again and retry.';
                        throw failure;
                    }
                }
                $('files').value = '';
            } finally { fingerprinting = false; }
        }

        async function initialize() {
            if (!window.isSecureContext || !window.RTCPeerConnection || !crypto.subtle || !crypto.randomUUID) throw new Error('File sharing requires HTTPS (or localhost) and an up-to-date browser with WebRTC support.');
            peerId = sessionStorage.getItem('daily_file_peer') || crypto.randomUUID();
            sessionStorage.setItem('daily_file_peer', peerId);
            if (location.protocol === 'file:') {
                if (!window.DailyFileSharingWorkerSource) throw new Error('Could not load the file-sharing worker. Reopen Daily and try again.');
                workerUrl = URL.createObjectURL(new Blob([window.DailyFileSharingWorkerSource], { type: 'text/javascript' }));
            }
            worker = new Worker(workerUrl || new URL('file-sharing-worker.js', scriptUrl));
            worker.onmessage = ({ data }) => {
                const request = requests.get(data.requestId);
                if (!request) return;
                if (data.progress !== undefined) { request.progress?.(data.progress); return; }
                requests.delete(data.requestId);
                if (data.error) request.reject(new Error(data.error)); else request.resolve(data.result);
            };
            worker.onerror = event => {
                const failure = new Error(`Local transfer worker failed: ${event.message}`);
                requests.forEach(request => request.reject(failure));
                requests.clear();
                disconnect();
                error(failure);
            };
            try {
                if (location.protocol === 'file:') throw new Error('Receiving files requires a web address, not a local file origin.');
                if (!navigator.locks) throw new Error('This browser lacks Web Locks needed for safe resumable local writes.');
                await rpc('init');
                supported = true;
                await storageStatus();
            } catch (failure) {
                if (disposed) return;
                console.warn('Receiving is unavailable:', failure);
                $('storage').textContent = location.protocol === 'file:'
                    ? 'You can send files here. To receive large files and keep your progress, open Daily through a web address.'
                    : 'You can send files here. To receive large files, try an updated browser through a secure web address.';
            }
            if (disposed) return;
            $('name').value = localStorage.getItem('daily_file_name') || 'Guest';
            $('server').value = options.serverUrl || new URLSearchParams(location.search).get('syncServer') || window.DAILY_RELAY
                || (/^https?:$/.test(location.protocol) && ['localhost', '127.0.0.1'].includes(location.hostname)
                    ? location.origin.replace(/^http/, 'ws') : 'wss://daily-2.onrender.com');
            $('invite').value = options.standalone && location.hash ? location.href : localStorage.getItem('daily_file_invite') || '';
            $('invite').oninput = () => qr.update();
            $('create').disabled = false;
            $('join').disabled = false;
            $('copy').disabled = false;
            $('create').onclick = () => run(() => {
                const key = [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join('');
                return join({ id: crypto.randomUUID(), key, server: validateServer($('server').value) });
            });
            $('join').onclick = () => run(() => join(readInvitation($('invite').value)));
            $('leave').onclick = disconnect;
            $('copy').onclick = () => run(async () => {
                readInvitation($('invite').value);
                await navigator.clipboard.writeText($('invite').value);
                $('connection').textContent = 'Invitation copied. Share it privately with the other devices.';
            });
            $('files').onchange = event => run(() => selectFiles([...event.target.files]));
            $('drop').ondragover = event => { event.preventDefault(); $('drop').classList.add('over'); };
            $('drop').ondragleave = () => $('drop').classList.remove('over');
            $('drop').ondrop = event => {
                event.preventDefault();
                $('drop').classList.remove('over');
                run(() => selectFiles([...event.dataTransfer.files]));
            };
            document.addEventListener('visibilitychange', onVisibility);
            $('files').addEventListener('click', () => {
                run(keepAwake);
            });
            window.addEventListener('beforeunload', onBeforeUnload);
        }

        function onVisibility() {
            if (!intentional && !disposed) run(keepAwake);
        }

        function onBeforeUnload(event) {
            if (!intentional && (sources.size || [...peers.values()].some(peer => peer.receive))) {
                event.preventDefault();
                event.returnValue = '';
            }
        }

        run(initialize);
        return {
            isActive: () => !intentional || fingerprinting,
            destroy() {
                disconnect();
                disposed = true;
                document.removeEventListener('visibilitychange', onVisibility);
                window.removeEventListener('beforeunload', onBeforeUnload);
                if (wakeLock) wakeLock.release().catch(failure => console.warn('Could not release screen wake lock:', failure));
                requests.forEach(request => request.reject(new Error('File Sharing was closed.')));
                requests.clear();
                worker?.terminate();
                qr.destroy();
                if (workerUrl) URL.revokeObjectURL(workerUrl);
                root.querySelectorAll('.prepared-download').forEach(link => URL.revokeObjectURL(link.href));
            }
        };
    }

    window.DailyFileSharing = function FileSharing({ Panel, onClose, serverUrl }) {
        const { createElement: h, useRef, useEffect } = React;
        const root = useRef(null), manager = useRef(null);
        useEffect(() => {
            manager.current = mount(root.current, { serverUrl });
            return () => manager.current?.destroy();
        }, []);
        useEffect(() => {
            function escape(event) {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopImmediatePropagation();
                close();
            }
            window.addEventListener('keydown', escape, true);
            return () => window.removeEventListener('keydown', escape, true);
        }, [onClose]);
        function close() {
            if (manager.current?.isActive() && !confirm('Close File Sharing? Transfers will pause. You can rejoin later to continue from saved progress.')) return;
            onClose();
        }
        return h(Panel, { title: 'File Sharing', icon: 'Send', onClose: close, initW: 920, initH: 740,
            storageKey: 'file-sharing', className: 'file-sharing-window' },
            h('div', { ref: root, className: 'file-sharing-content' }));
    };

    if (document.querySelector('[data-file-sharing-standalone]')) {
        mount(document.querySelector('[data-file-sharing-standalone]'), { standalone: true });
    }
})();
