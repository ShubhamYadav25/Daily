(function () {
    'use strict';

    function runFileSharingWorker() {
        const CHUNK_SIZE = 1024 * 1024;
        const encoder = new TextEncoder();
        let database, directory;
        const records = new Map();

        function hex(bytes) {
            return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
        }

        function unhex(value) {
            return Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));
        }

        async function hash(buffer) {
            return hex(await crypto.subtle.digest('SHA-256', buffer));
        }

        async function chain(previous, chunkHash) {
            const input = new Uint8Array(64);
            input.set(previous);
            input.set(unhex(chunkHash), 32);
            return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
        }

        function transaction(mode, callback, stores = ['downloads']) {
            return new Promise((resolve, reject) => {
                const tx = database.transaction(stores, mode);
                const request = callback(tx.objectStore(stores[0]), tx);
                tx.oncomplete = () => resolve(request.result);
                tx.onerror = () => reject(tx.error || new Error('Local transfer database failed'));
                tx.onabort = () => reject(tx.error || new Error('Local transfer database transaction aborted'));
            });
        }

        async function save(record) {
            const { hashes, ...metadata } = record;
            await transaction('readwrite', store => store.put(metadata));
            records.set(record.id, record);
        }

        async function load(id) {
            const record = await transaction('readonly', store => store.get(id));
            if (!record) return null;
            const chunks = await transaction('readonly', store => store.index('download').getAll(id), ['chunks']);
            record.hashes = Object.fromEntries(chunks.map(chunk => [chunk.index, chunk.hash]));
            return record;
        }

        async function get(id) {
            const record = records.get(id) || await load(id);
            if (!record) throw new Error('Local transfer not found');
            records.set(id, record);
            return record;
        }

        function chunkLength(meta, index) {
            return Math.min(CHUNK_SIZE, meta.size - index * CHUNK_SIZE);
        }

        function summary(record) {
            const { hashes, ...metadata } = record;
            return metadata;
        }

        async function initialize() {
            if (!navigator.storage?.getDirectory) throw new Error('This browser does not support resumable local file storage. Use an up-to-date browser over HTTPS.');
            directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('daily-file-sharing', { create: true });
            database = await new Promise((resolve, reject) => {
                const request = indexedDB.open('daily-file-sharing', 1);
                request.onupgradeneeded = () => {
                    request.result.createObjectStore('downloads', { keyPath: 'id' });
                    request.result.createObjectStore('chunks', { keyPath: 'id' }).createIndex('download', 'download');
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
                request.onblocked = () => reject(new Error('Close other file-sharing tabs to initialize local storage'));
            });
        }

        async function process(action, data, requestId) {
            if (action === 'init') {
                await initialize();
                return true;
            }
            if (action === 'hash-file') {
                const { file } = data;
                if (!file.name || file.name.length > 255) throw new Error('File names must contain between 1 and 255 characters.');
                if (Math.ceil(file.size / CHUNK_SIZE) > 262144) throw new Error('Files above 256 GiB are not supported in this version.');
                const hashes = [];
                let root = new Uint8Array(32);
                for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
                    const digest = await hash(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
                    hashes.push(digest);
                    root = await chain(root, digest);
                    if (hashes.length % 16 === 0) self.postMessage({ requestId, progress: Math.min(file.size, offset + CHUNK_SIZE) });
                }
                const meta = { name: file.name, size: file.size, chunkSize: CHUNK_SIZE, chunks: hashes.length, root: hex(root) };
                meta.fileId = await hash(encoder.encode(JSON.stringify([meta.name, meta.size, meta.chunkSize, meta.root])));
                return { meta, hashes };
            }
            if (action === 'list') {
                const all = await transaction('readonly', store => store.getAll());
                return all.filter(record => record.room === data.room).map(summary);
            }
            if (action === 'prepare') {
                const { meta, room } = data;
                const expected = await hash(encoder.encode(JSON.stringify([meta.name, meta.size, meta.chunkSize, meta.root])));
                if (expected !== meta.fileId) throw new Error('Invalid file manifest identity');
                const id = `${room}_${meta.fileId}`;
                let record = await load(id);
                if (!record) {
                    record = { id, room, meta, hashes: {}, received: 0, bytes: 0, complete: false, created: Date.now() };
                    await directory.getDirectoryHandle(id, { create: true });
                    await save(record);
                }
                const folder = await directory.getDirectoryHandle(id, { create: true });
                let repaired = 0;
                for (const index of Object.keys(record.hashes)) {
                    let file;
                    try { file = await (await folder.getFileHandle(`chunk-${index}`)).getFile(); }
                    catch (error) {
                        if (error.name !== 'NotFoundError') throw error;
                    }
                    if (!file || file.size !== chunkLength(meta, Number(index))
                        || await hash(await file.arrayBuffer()) !== record.hashes[index]) {
                        delete record.hashes[index];
                        await transaction('readwrite', store => store.delete(`${id}_${index}`), ['chunks']);
                        repaired++;
                    }
                }
                record.complete = false;
                record.received = Object.keys(record.hashes).length;
                record.bytes = Object.keys(record.hashes).reduce((sum, index) => sum + chunkLength(meta, Number(index)), 0);
                await save(record);
                return { id, saved: Object.keys(record.hashes).map(Number), repaired, ...summary(record) };
            }
            if (action === 'store') {
                const record = await get(data.id);
                const { index, buffer, digest } = data;
                if (!Number.isInteger(index) || index < 0 || index >= record.meta.chunks
                    || buffer.byteLength !== chunkLength(record.meta, index)) throw new Error('Invalid file chunk');
                if (await hash(buffer) !== digest) throw new Error(`Checksum failed for chunk ${index}. Rejoin to retry.`);
                const folder = await directory.getDirectoryHandle(record.id);
                const handle = await folder.getFileHandle(`chunk-${index}`, { create: true });
                const stream = await handle.createWritable();
                try {
                    await stream.write(buffer);
                    await stream.close();
                } catch (error) {
                    try { await stream.abort(); } catch (abortError) { console.error('Unable to abort local chunk write', abortError); }
                    throw error;
                }
                if (!record.hashes[index]) {
                    record.received++;
                    record.bytes += buffer.byteLength;
                }
                record.hashes[index] = digest;
                record.complete = false;
                const metadata = summary(record);
                await transaction('readwrite', (store, tx) => {
                    tx.objectStore('chunks').put({ id: `${record.id}_${index}`, download: record.id, index, hash: digest });
                    return store.put(metadata);
                }, ['downloads', 'chunks']);
                return summary(record);
            }
            if (action === 'finish') {
                const record = await get(data.id);
                if (Object.keys(record.hashes).length !== record.meta.chunks) throw new Error('File has missing chunks');
                let root = new Uint8Array(32);
                for (let index = 0; index < record.meta.chunks; index++) root = await chain(root, record.hashes[index]);
                if (hex(root) !== record.meta.root) throw new Error('Final file integrity check failed. Delete this local transfer and request the file again.');
                record.complete = true;
                await save(record);
                return summary(record);
            }
            if (action === 'export') {
                const record = await get(data.id);
                if (!record.complete) throw new Error('The file is not complete yet');
                const folder = await directory.getDirectoryHandle(record.id);
                const handle = await folder.getFileHandle('export', { create: true });
                const stream = await handle.createWritable();
                try {
                    for (let index = 0; index < record.meta.chunks; index++) {
                        const chunk = await (await folder.getFileHandle(`chunk-${index}`)).getFile();
                        const buffer = await chunk.arrayBuffer();
                        if (await hash(buffer) !== record.hashes[index]) throw new Error(`Saved chunk ${index} is damaged. Rejoin to repair it.`);
                        await stream.write(buffer);
                        if (index % 16 === 0) self.postMessage({ requestId, progress: Math.min(record.meta.size, (index + 1) * CHUNK_SIZE) });
                    }
                    await stream.close();
                } catch (error) {
                    try { await stream.abort(); } catch (abortError) { console.error('Unable to abort local export', abortError); }
                    throw error;
                }
                return await handle.getFile();
            }
            if (action === 'chunk') {
                const record = await get(data.id);
                if (!record.complete) throw new Error('The file is not complete yet');
                const file = await (await (await directory.getDirectoryHandle(record.id)).getFileHandle(`chunk-${data.index}`)).getFile();
                if (file.size !== chunkLength(record.meta, data.index)
                    || await hash(await file.arrayBuffer()) !== record.hashes[data.index]) throw new Error('A saved chunk is damaged. Rejoin to repair it before exporting.');
                return file;
            }
            if (action === 'delete') {
                try { await directory.removeEntry(data.id, { recursive: true }); }
                catch (error) {
                    if (error.name !== 'NotFoundError') throw error;
                    console.warn('Local chunk directory was already removed; clearing its transfer metadata.');
                }
                await transaction('readwrite', (store, tx) => {
                    const chunkStore = tx.objectStore('chunks');
                    const cursor = chunkStore.index('download').openCursor(IDBKeyRange.only(data.id));
                    cursor.onsuccess = () => {
                        if (cursor.result) { cursor.result.delete(); cursor.result.continue(); }
                    };
                    return store.delete(data.id);
                }, ['downloads', 'chunks']);
                records.delete(data.id);
                return true;
            }
            throw new Error('Unknown local storage operation');
        }

        let queue = Promise.resolve();
        self.onmessage = ({ data: { requestId, action, data } }) => {
            const execute = async () => {
                try {
                    const result = await process(action, data, requestId);
                    self.postMessage({ requestId, result });
                } catch (error) {
                    console.error('File-sharing storage operation failed', action, error);
                    self.postMessage({ requestId, error: `${error.name}: ${error.message}` });
                }
            };
            if (action === 'hash-file') execute();
            else queue = queue.then(execute);
        };
    }

    if (typeof document === 'undefined') runFileSharingWorker();
    else window.DailyFileSharingWorkerSource = `(${runFileSharingWorker.toString()})();`;
})();
