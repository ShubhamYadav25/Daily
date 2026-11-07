// PDF data and passwords stay inside this short-lived worker.
self.onmessage = async ({ data }) => {
    try {
        const qpdf = await import('https://cdn.jsdelivr.net/npm/@arshad-shah/qpdf-wasm@0.1.0/dist/index.js');
        const result = await qpdf.decrypt(data.bytes, data.password);
        const inspection = await qpdf.inspect(result.bytes);
        if (inspection.encrypted) throw new Error('The PDF is still encrypted.');
        self.postMessage({ bytes: result.bytes, warnings: result.warnings }, [result.bytes.buffer]);
    } catch (failure) {
        self.postMessage({ error: failure.code === 'WRONG_PASSWORD'
            ? 'Incorrect PDF password. Try again.'
            : 'Unable to unlock PDF. ' + (failure.code === 'WASM_ERROR'
                ? 'Could not load the decryption library. Check your connection and retry.'
                : 'The file may be damaged or use unsupported encryption.'), code: failure.code });
    }
};
