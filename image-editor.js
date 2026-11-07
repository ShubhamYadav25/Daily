(function () {
    'use strict';

    const MAX_PIXELS = 12000000, MAX_TOTAL_PIXELS = 60000000, MAX_IMAGES = 24;
    const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
    const OPEN_FONTS = [{ family: 'Roboto Condensed', label: 'Roboto Condensed (open source)', package: 'roboto-condensed', version: '5.2.8' }];
    const fontLoads = new Map();
    async function loadOpenFonts() {
        await Promise.all(OPEN_FONTS.map(async font => {
            if (!fontLoads.has(font.family)) fontLoads.set(font.family, (async () => {
                const faces = await Promise.all([400, 700].flatMap(weight => ['normal', 'italic'].map(async style => {
                    const url = `https://cdn.jsdelivr.net/npm/@fontsource/${font.package}@${font.version}/files/${font.package}-latin-${weight}-${style}.woff2`;
                    const face = new FontFace(font.family, `url("${url}")`, { weight: String(weight), style });
                    await face.load(); return face;
                })));
                faces.forEach(face => document.fonts.add(face));
            })().catch(error => { fontLoads.delete(font.family); throw new Error('Could not load ' + font.family + '. Retry or import a local font. ' + error.message); }));
            await fontLoads.get(font.family);
        }));
    }
    const dependencies = {};
    function loadScript(name, url) {
        if (window[name]) return Promise.resolve(window[name]);
        if (!dependencies[name]) dependencies[name] = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = url;
            script.onload = () => window[name] ? resolve(window[name]) : reject(new Error(name + ' did not initialize.'));
            script.onerror = () => reject(new Error('Could not load ' + name + '. Check your connection and retry.'));
            document.head.appendChild(script);
        }).catch(error => { delete dependencies[name]; throw error; });
        return dependencies[name];
    }
    function dimensions(width, height) {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
            width > 16384 || height > 16384 || width * height > MAX_PIXELS) {
            throw new Error('Use whole-number dimensions from 1 to 16,384, with at most 12 megapixels.');
        }
        return { width, height };
    }
    function canvasOf(width, height) {
        dimensions(width, height);
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        return canvas;
    }
    function encode(canvas, type, quality) {
        return new Promise((resolve, reject) => canvas.toBlob(blob => {
            if (!blob) reject(new Error('The browser could not encode this image.'));
            else if (blob.type !== type) reject(new Error('This browser does not support ' + type + ' export. Choose another format.'));
            else resolve(blob);
        }, type, quality));
    }
    async function decode(blob) {
        const url = URL.createObjectURL(blob);
        try {
            const image = new Image();
            image.src = url;
            await image.decode();
            const canvas = canvasOf(image.naturalWidth, image.naturalHeight);
            canvas.getContext('2d').drawImage(image, 0, 0);
            return canvas;
        } finally { URL.revokeObjectURL(url); }
    }
    let resizer;
    async function resize(source, width, height) {
        const target = canvasOf(width, height);
        await loadScript('pica', 'https://cdn.jsdelivr.net/npm/pica@9.0.1/dist/pica.min.js');
        resizer ||= window.pica();
        await resizer.resize(source, target, { filter: 'mks2013', unsharpAmount: 80, unsharpRadius: 0.6, unsharpThreshold: 2 });
        return target;
    }
    function placement(sw, sh, tw, th, mode) {
        if (mode === 'stretch') return { x: 0, y: 0, width: tw, height: th };
        const scale = mode === 'cover' ? Math.max(tw / sw, th / sh) : Math.min(tw / sw, th / sh);
        return { x: (tw - sw * scale) / 2, y: (th - sh * scale) / 2, width: sw * scale, height: sh * scale };
    }
    function cropBounds(rect, width, height) {
        const x = Math.max(0, Math.min(width - 1, Math.round(rect.x)));
        const y = Math.max(0, Math.min(height - 1, Math.round(rect.y)));
        return { x, y, width: Math.max(1, Math.min(width - x, Math.round(rect.width))),
            height: Math.max(1, Math.min(height - y, Math.round(rect.height))) };
    }
    function aspectCrop(width, height, ratio) {
        const w = ratio ? Math.min(width, height * ratio) : width * .8;
        const h = ratio ? w / ratio : height * .8;
        return cropBounds({ x: (width - w) / 2, y: (height - h) / 2, width: w, height: h }, width, height);
    }
    function rotationSize(width, height, degrees) {
        if (!Number.isFinite(degrees)) throw new Error('Enter a finite rotation angle.');
        const radians = (degrees % 360) * Math.PI / 180;
        return { width: Math.max(1, Math.ceil(Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians)) - 1e-8)),
            height: Math.max(1, Math.ceil(Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians)) - 1e-8)), radians };
    }
    function crc32(bytes) {
        let crc = 0xffffffff;
        for (const byte of bytes) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
        return (crc ^ 0xffffffff) >>> 0;
    }
    function concat(...parts) {
        const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
        let offset = 0;
        for (const part of parts) { result.set(part, offset); offset += part.length; }
        return result;
    }
    function densityBytes(bytes, type, dpi) {
        if (!Number.isInteger(dpi) || dpi < 1 || dpi > 2400) throw new Error('DPI must be a whole number between 1 and 2,400.');
        if (type === 'image/png') {
            const chunk = new Uint8Array(21), view = new DataView(chunk.buffer);
            view.setUint32(0, 9);
            chunk.set([112, 72, 89, 115], 4);
            view.setUint32(8, Math.round(dpi / .0254)); view.setUint32(12, Math.round(dpi / .0254));
            chunk[16] = 1; view.setUint32(17, crc32(chunk.subarray(4, 17)));
            const parts = [bytes.subarray(0, 8), chunk];
            for (let offset = 8; offset < bytes.length;) {
                const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0) + 12;
                if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) !== 'pHYs') parts.push(bytes.subarray(offset, offset + length));
                offset += length;
            }
            // pHYs follows IHDR, as required by PNG decoders.
            const header = parts.splice(2, 1)[0];
            parts.splice(1, 0, header);
            return concat(...parts);
        }
        if (type === 'image/jpeg') {
            const jfif = new Uint8Array([255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 2, 1, dpi >> 8, dpi & 255, dpi >> 8, dpi & 255, 0, 0]);
            const parts = [bytes.subarray(0, 2), jfif];
            let offset = 2;
            while (offset + 4 < bytes.length && bytes[offset] === 255 && bytes[offset + 1] !== 218) {
                const marker = bytes[offset + 1], length = (bytes[offset + 2] << 8 | bytes[offset + 3]) + 2;
                if (marker !== 224 && marker !== 225 && marker !== 254) parts.push(bytes.subarray(offset, offset + length));
                offset += length;
            }
            parts.push(bytes.subarray(offset));
            return concat(...parts);
        }
        if (type === 'image/webp') {
            // Minimal TIFF: only resolution fields, no source EXIF or personal metadata.
            const tiff = new Uint8Array(66), t = new DataView(tiff.buffer);
            tiff.set([73, 73, 42, 0, 8, 0, 0, 0]); t.setUint16(8, 3, true);
            [[282, 5, 50], [283, 5, 58], [296, 3, 2]].forEach(([tag, kind, value], index) => {
                const at = 10 + index * 12;
                t.setUint16(at, tag, true); t.setUint16(at + 2, kind, true);
                t.setUint32(at + 4, 1, true); t.setUint32(at + 8, value, true);
            });
            t.setUint32(50, dpi, true); t.setUint32(54, 1, true); t.setUint32(58, dpi, true); t.setUint32(62, 1, true);
            const parts = [], reader = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            let width, height, alpha = false, hasExtended = false;
            for (let at = 12; at < bytes.length;) {
                const tag = String.fromCharCode(...bytes.subarray(at, at + 4)), size = reader.getUint32(at + 4, true);
                const part = bytes.slice(at, at + 8 + size + (size & 1));
                if (tag === 'VP8X') { part[8] |= 8; parts.unshift(part); hasExtended = true; }
                else if (tag !== 'EXIF' && tag !== 'XMP ') {
                    if (tag === 'VP8 ') { width = reader.getUint16(at + 14, true) & 16383; height = reader.getUint16(at + 16, true) & 16383; }
                    if (tag === 'VP8L') {
                        const bits = reader.getUint32(at + 9, true);
                        width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1; alpha = !!(bits & 0x10000000);
                    }
                    if (tag === 'ALPH') alpha = true;
                    parts.push(part);
                }
                at += 8 + size + (size & 1);
            }
            if (!hasExtended) {
                if (!width || !height) throw new Error('Unsupported WebP bitstream.');
                const vp8x = new Uint8Array(18);
                vp8x.set([86, 80, 56, 88, 10, 0, 0, 0, 8 | (alpha ? 16 : 0)]);
                for (let index = 0; index < 3; index++) { vp8x[12 + index] = ((width - 1) >>> (index * 8)) & 255; vp8x[15 + index] = ((height - 1) >>> (index * 8)) & 255; }
                parts.unshift(vp8x);
            }
            const exif = concat(new Uint8Array([69, 88, 73, 70, 66, 0, 0, 0]), tiff);
            const result = concat(bytes.subarray(0, 12), ...parts, exif);
            new DataView(result.buffer).setUint32(4, result.length - 8, true);
            return result;
        }
        throw new Error('Unsupported export format.');
    }
    async function imageBlob(canvas, type, quality, dpi) {
        let blob = await encode(canvas, type, quality);
        if (type === 'image/png') {
            await loadScript('pako', 'https://cdn.jsdelivr.net/npm/pako@1.0.11/dist/pako.min.js');
            await loadScript('UPNG', 'https://cdn.jsdelivr.net/npm/upng-js@2.1.0/UPNG.js');
            const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            const bytes = window.UPNG.encode([pixels.buffer], canvas.width, canvas.height, 0);
            const decoded = new Uint8Array(window.UPNG.toRGBA8(window.UPNG.decode(bytes))[0]);
            if (decoded.length !== pixels.length || !decoded.every((channel, index) => channel === pixels[index])) throw new Error('Lossless PNG pixel verification failed.');
            const optimized = new Blob([bytes], { type });
            if (optimized.size < blob.size) blob = optimized;
        }
        return new Blob([densityBytes(new Uint8Array(await blob.arrayBuffer()), type, dpi)], { type });
    }
    async function fittingEncoding(canvas, type, target, dpi, minQuality, encodeImage) {
        const highest = await encodeImage(canvas, type, 1, dpi);
        if (highest.size <= target) return { blob: highest, quality: 1 };
        const lowest = type === MIME.png || minQuality === 1 ? highest : await encodeImage(canvas, type, minQuality, dpi);
        if (lowest.size > target) return { minimumSize: lowest.size };
        let best = lowest, bestQuality = minQuality, low = minQuality, high = 1;
        for (let step = 0; step < 13; step++) {
            const quality = (low + high) / 2, blob = await encodeImage(canvas, type, quality, dpi);
            if (blob.size <= target) { best = blob; bestQuality = quality; low = quality; } else high = quality;
        }
        return { blob: best, quality: bestQuality };
    }
    function sizeLimit(target) {
        if (!Number.isSafeInteger(target) || target < 128 || target > 100000000) throw new Error('Choose a size limit between 128 bytes and 100 MB.');
    }
    async function compress(canvas, type, target, dpi, minQuality, allowResize, progress, encodeImage = imageBlob, resizeImage = resize) {
        sizeLimit(target);
        if (!Number.isFinite(minQuality) || minQuality < .1 || minQuality > 1) throw new Error('Minimum quality must be between 10% and 100%.');
        let current = canvas;
        for (let attempt = 0; attempt < 20; attempt++) {
            if (progress) progress('Finding highest quality at ' + current.width + ' x ' + current.height + '...');
            const result = await fittingEncoding(current, type, target, dpi, minQuality, encodeImage);
            if (result.blob) return { ...result, width: current.width, height: current.height };
            if (!allowResize || current.width === 1 && current.height === 1) break;
            const scale = Math.min(.9, Math.max(.25, Math.sqrt(target / result.minimumSize) * .92));
            const width = Math.max(1, Math.floor(current.width * scale)), height = Math.max(1, Math.floor(current.height * scale));
            current = await resizeImage(canvas, width, height);
        }
        throw new Error('Cannot meet this limit at the chosen quality/dimensions. Increase the limit, lower minimum quality, allow smaller dimensions, or choose JPEG/WebP. PNG is lossless.');
    }
    async function encodingError(source, blob) {
        const original = source.getContext('2d').getImageData(0, 0, source.width, source.height).data;
        const decoded = await decode(blob), pixels = decoded.getContext('2d').getImageData(0, 0, decoded.width, decoded.height).data;
        if (decoded.width !== source.width || decoded.height !== source.height) throw new Error('Encoded image dimensions changed unexpectedly.');
        let error = 0;
        for (let index = 0; index < pixels.length; index += 4) {
            for (let channel = 0; channel < 3; channel++) {
                const delta = original[index + channel] * original[index + 3] / 255 - pixels[index + channel] * pixels[index + 3] / 255;
                error += delta * delta;
            }
            error += (original[index + 3] - pixels[index + 3]) ** 2;
        }
        return error / pixels.length;
    }
    async function autoCompress(source, target, dpi, progress, encodeImage = imageBlob, resizeImage = resize,
        compare = encodingError, opaque = source.getContext('2d').getImageData(0, 0, source.width, source.height).data.every((value, index) => index % 4 !== 3 || value === 255),
        selectedType = null) {
        sizeLimit(target);
        if (selectedType && !Object.values(MIME).includes(selectedType)) throw new Error('Unsupported export format.');
        async function trial(current) {
            progress?.('Optimizing clarity at ' + current.width + ' x ' + current.height + '...');
            let minimumSize = Infinity, best;
            if (!selectedType || selectedType === MIME.png) {
                const png = await fittingEncoding(current, MIME.png, target, dpi, 1, encodeImage);
                if (png.blob) return { ...png, type: MIME.png, width: current.width, height: current.height };
                minimumSize = png.minimumSize;
            }
            for (const type of selectedType ? selectedType === MIME.png ? [] : [selectedType] : opaque ? [MIME.webp, MIME.jpg] : [MIME.webp]) {
                const candidate = await fittingEncoding(current, type, target, dpi, .75, encodeImage);
                if (!candidate.blob) { minimumSize = Math.min(minimumSize, candidate.minimumSize); continue; }
                const error = await compare(current, candidate.blob);
                if (!best || error < best.error) best = { ...candidate, type, error };
            }
            if (best) return { ...best, width: current.width, height: current.height };
            return { minimumSize };
        }
        let current = source, failedScale = 1;
        for (let attempt = 0; attempt < 40; attempt++) {
            let result = await trial(current);
            if (result.blob) {
                if (current === source) return result;
                let low = source.width >= source.height ? current.width / source.width : current.height / source.height, high = failedScale;
                // Refine the resize bracket instead of accepting the first, overly small image.
                for (let step = 0; step < 5; step++) {
                    const scale = (low + high) / 2, width = Math.max(1, Math.floor(source.width * scale)), height = Math.max(1, Math.floor(source.height * scale));
                    if (width === result.width && height === result.height) break;
                    const candidate = await trial(await resizeImage(source, width, height));
                    if (candidate.blob) { result = candidate; low = scale; } else high = scale;
                }
                return result;
            }
            if (current.width === 1 && current.height === 1) break;
            failedScale = source.width >= source.height ? current.width / source.width : current.height / source.height;
            const scale = Math.min(.9, Math.max(.5, Math.sqrt(target / result.minimumSize) * .97));
            current = await resizeImage(source, Math.max(1, Math.floor(current.width * scale)), Math.max(1, Math.floor(current.height * scale)));
        }
        throw new Error('This limit is too small for a valid image with DPI metadata. Choose a larger size.');
    }
    function enhancePixels(data, amount) {
        const original = new Uint8ClampedArray(data.data), { width, height } = data;
        const strength = amount / 100;
        for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
            const at = (y * width + x) * 4;
            for (let channel = 0; channel < 3; channel++) {
                const blur = (original[at - 4 + channel] + original[at + 4 + channel] +
                    original[at - width * 4 + channel] + original[at + width * 4 + channel]) / 4;
                data.data[at + channel] = original[at + channel] + (original[at + channel] - blur) * strength;
            }
        }
        return data;
    }
    const ADJUSTMENTS = { brightness: 100, contrast: 100, saturation: 100, blur: 0, sharpen: 0, pixel: 1 };
    function stepValue(value, delta, min = -Infinity, max = Infinity) {
        return Math.max(min, Math.min(max, Number(((Number(value) || 0) + delta).toFixed(8))));
    }
    function layerSnapshot(object) {
        const serialized = object.toObject(['replacementMask', 'replacementTarget', 'name', 'selectable', 'evented']);
        // Fabric temporarily disables selection during text entry; history must retain normal layer behavior.
        if (object.isEditing) serialized.selectable = object._savedProps?.selectable ?? true;
        return serialized;
    }
    function blurPixels(image, radius, region) {
        const { width, height, data } = image;
        const bounds = region ? cropBounds(region, width, height) : { x: 0, y: 0, width, height };
        const ideal = Math.sqrt(4 * radius * radius + 1), lower = Math.floor(ideal) | 1;
        const low = lower > ideal ? lower - 2 : lower, high = low + 2;
        const count = Math.round((12 * radius * radius - 3 * low * low - 12 * low - 9) / (-4 * low - 4));
        const radii = Array.from({ length: 3 }, (_, i) => ((i < count ? low : high) - 1) / 2);
        const padding = radii.reduce((sum, value) => sum + value, 0);
        const x0 = Math.max(0, bounds.x - padding), y0 = Math.max(0, bounds.y - padding);
        const w = Math.min(width, bounds.x + bounds.width + padding) - x0;
        const h = Math.min(height, bounds.y + bounds.height + padding) - y0;
        let input = new Uint8ClampedArray(w * h * 4), output = new Uint8ClampedArray(input.length);
        for (let y = 0; y < h; y++) input.set(data.subarray(((y + y0) * width + x0) * 4, ((y + y0) * width + x0 + w) * 4), y * w * 4);
        function pass(r, horizontal) {
            const length = horizontal ? w : h, lines = horizontal ? h : w, kernel = r * 2 + 1;
            for (let line = 0; line < lines; line++) {
                const at = position => (horizontal ? line * w + Math.max(0, Math.min(length - 1, position)) :
                    Math.max(0, Math.min(length - 1, position)) * w + line) * 4;
                const sums = [0, 0, 0, 0];
                function add(position, sign) {
                    const index = at(position), alpha = input[index + 3];
                    for (let c = 0; c < 3; c++) sums[c] += sign * input[index + c] * alpha;
                    sums[3] += sign * alpha;
                }
                for (let position = -r; position <= r; position++) add(position, 1);
                for (let position = 0; position < length; position++) {
                    const index = at(position);
                    for (let c = 0; c < 3; c++) output[index + c] = sums[3] ? sums[c] / sums[3] : input[index + c];
                    output[index + 3] = sums[3] / kernel;
                    add(position - r, -1); add(position + r + 1, 1);
                }
            }
            [input, output] = [output, input];
        }
        for (const r of radii) { pass(r, true); pass(r, false); }
        for (let y = bounds.y; y < bounds.y + bounds.height; y++) for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
            const dest = (y * width + x) * 4, src = ((y - y0) * w + x - x0) * 4;
            // Blur color only: never introduce transparency or change the chosen background.
            for (let c = 0; c < 3; c++) data[dest + c] = input[src + c];
        }
        return image;
    }
    function adjustedCanvas(source, values, region = null) {
        const target = canvasOf(source.width, source.height), ctx = target.getContext('2d');
        if (!('filter' in ctx)) throw new Error('Live adjustments require a browser with canvas filter support.');
        ctx.filter = `brightness(${values.brightness}%) contrast(${values.contrast}%) saturate(${values.saturation}%)`;
        ctx.drawImage(source, 0, 0); ctx.filter = 'none';
        if (values.blur > 0) {
            ctx.putImageData(blurPixels(ctx.getImageData(0, 0, source.width, source.height), values.blur, region), 0, 0);
        }
        if (values.pixel > 1) {
            const small = canvasOf(Math.max(1, Math.ceil(source.width / values.pixel)), Math.max(1, Math.ceil(source.height / values.pixel)));
            small.getContext('2d').drawImage(target, 0, 0, small.width, small.height);
            ctx.clearRect(0, 0, target.width, target.height);
            ctx.imageSmoothingEnabled = false; ctx.drawImage(small, 0, 0, target.width, target.height);
        }
        if (values.sharpen > 0) ctx.putImageData(enhancePixels(ctx.getImageData(0, 0, source.width, source.height), values.sharpen), 0, 0);
        return target;
    }
    function ocrTargets(lines, width, height) {
        return (lines || []).filter(line => line.text?.trim() && line.bbox).map((line, index) => {
            const { x0, y0, x1, y1 } = line.bbox;
            return { id: 'text-' + index, text: line.text.trim(),
                ...cropBounds({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, width, height) };
        });
    }
    function inkBounds(canvas) {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
            const index = (y * canvas.width + x) * 4;
            if (pixels[index + 3] > 24 && pixels[index] < 230) {
                left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
            }
        }
        if (right < left) throw new Error('No visible text pixels in the selected area.');
        return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
    }
    function normalizedInk(canvas) {
        const bounds = inkBounds(canvas), target = canvasOf(160, 64), ctx = target.getContext('2d');
        ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 160, 64);
        ctx.drawImage(canvas, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, 160, 64);
        return ctx.getImageData(0, 0, 160, 64).data;
    }
    function fontMatchConfidence(original, rendered) {
        let intersection = 0, union = 0;
        for (let i = 0; i < original.length; i += 4) {
            const a = 1 - original[i] / 255, b = 1 - rendered[i] / 255;
            intersection += Math.min(a, b); union += Math.max(a, b);
        }
        return union ? intersection / union : 0;
    }
    function reliableFontMatch(match, text) {
        return !!match && text.replace(/\s/g, '').length >= 4 && match.confidence >= .85;
    }
    async function matchRasterFont(source, target, colors, fonts) {
        const bounds = cropBounds(target, source.width, source.height);
        const patch = canvasOf(bounds.width, bounds.height), ctx = patch.getContext('2d');
        ctx.drawImage(source, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
        const image = ctx.getImageData(0, 0, bounds.width, bounds.height);
        const rgb = hex => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16));
        const paper = rgb(colors.paper), ink = rgb(colors.fill), vector = ink.map((value, i) => value - paper[i]);
        const magnitude = vector.reduce((sum, value) => sum + value * value, 0);
        if (!magnitude) throw new Error('Text and background colors must differ.');
        for (let index = 0; index < image.data.length; index += 4) {
            const amount = Math.max(0, Math.min(1, vector.reduce((sum, value, c) => sum + (image.data[index + c] - paper[c]) * value, 0) / magnitude));
            image.data[index] = image.data[index + 1] = image.data[index + 2] = 255 * (1 - amount); image.data[index + 3] = 255;
        }
        ctx.putImageData(image, 0, 0);
        const original = normalizedInk(patch);
        let best;
        for (const { family } of fonts) {
            await document.fonts.load('64px "' + family + '"', target.text);
            const probe = canvasOf(1, 1).getContext('2d'), sampleText = 'mmmmmmmmwwwwiiii0123456789';
            const available = ['monospace', 'serif', 'sans-serif'].some(fallback => {
                probe.font = '64px ' + fallback;
                const baseline = probe.measureText(sampleText).width;
                probe.font = '64px "' + family + '", ' + fallback;
                return Math.abs(probe.measureText(sampleText).width - baseline) > .01;
            });
            if (!available) continue;
            for (const fontWeight of ['normal', 'bold']) for (const fontStyle of ['normal', 'italic']) {
                const sample = canvasOf(Math.min(16384, Math.max(256, target.text.length * 128)), 160), c = sample.getContext('2d');
                c.font = `${fontStyle} ${fontWeight} 64px "${family}"`;
                c.fillStyle = 'white'; c.fillRect(0, 0, sample.width, sample.height);
                c.fillStyle = 'black'; c.fillText(target.text, 32, 96);
                const rendered = normalizedInk(sample);
                let error = 0;
                for (let i = 0; i < original.length; i += 4) error += (original[i] - rendered[i]) ** 2;
                if (!best || error < best.error) {
                    const glyph = inkBounds(sample);
                    best = { fontFamily: family, fontWeight, fontStyle, fontSize: bounds.height * 64 / glyph.height,
                        confidence: fontMatchConfidence(original, rendered), error };
                }
            }
        }
        return best;
    }
    function imageShortcut(event, inside, pointerInside, editing) {
        if (event.defaultPrevented || event.isComposing || event.altKey) return null;
        const fabricInput = event.target.hasAttribute?.('data-fabric-hiddentextarea') && editing;
        if (!fabricInput && !inside && !pointerInside) return null;
        const input = event.target.closest?.('input,textarea,select,[contenteditable="true"]');
        if (input && !fabricInput) return null;
        const key = event.key.toLowerCase(), command = event.ctrlKey || event.metaKey;
        if (command && (key === 'z' || key === 'y')) return key === 'y' || event.shiftKey ? 'redo' : 'undo';
        if (command && ['a', 'b', 'i', 'u'].includes(key)) return ({ a: 'selectText', b: 'bold', i: 'italic', u: 'underline' })[key];
        if (!command && !input && !editing && ['delete', 'backspace'].includes(key)) return 'delete';
        return null;
    }
    window.DailyImageTools = { imageBlob, dimensions, placement, cropBounds, aspectCrop, rotationSize, crc32, densityBytes, compress, autoCompress, blurPixels, matchRasterFont, fontMatchConfidence, reliableFontMatch, enhancePixels, stepValue, layerSnapshot, ocrTargets, imageShortcut };

    window.DailyImageEditor = function ImageEditor({ Panel, Icon, onClose }) {
        const { createElement: h, useState, useRef, useEffect } = React;
        const [ready, setReady] = useState(false), [busy, setBusy] = useState('Loading editor...');
        const [error, setError] = useState(''), [note, setNote] = useState('');
        const [items, setItems] = useState([]), [active, setActive] = useState(null), [tab, setTab] = useState('geometry');
        const [size, setSize] = useState({ width: 1, height: 1 }), [zoom, setZoom] = useState(1), [revision, setRevision] = useState(0);
        const [crop, setCrop] = useState(null), [ratio, setRatio] = useState('free');
        const [textTargets, setTextTargets] = useState([]), [editSource, setEditSource] = useState(false), [manualText, setManualText] = useState(null);
        const [theme, setTheme] = useState(() => localStorage.getItem('image-editor-theme') === 'black' ? 'black' : 'white');
        const [regionMode, setRegionMode] = useState(null), [customFonts, setCustomFonts] = useState([]);
        const [pendingFont, setPendingFont] = useState(null);
        const [settings, setSettings] = useState({ width: 1200, height: 800, fit: 'contain', dpi: 300, angle: 90,
            ...ADJUSTMENTS,
            background: '#ffffff', transparent: true, text: '', fontSize: 48, fontFamily: 'Arial', color: '#202930',
            fontWeight: 'normal', fontStyle: 'normal', underline: false, linethrough: false, textAlign: 'left', lineHeight: 1.16, charSpacing: 0,
            opacity: 100, stroke: 4, border: 20, radius: 40, format: 'png', quality: 92,
            limit: '', unit: 'KB', minQuality: 75, allowResize: false, lossless: true, autoSize: true, columns: 2, gap: 16, cellWidth: 600, cellHeight: 600 });
        const input = useRef(null), overlayInput = useRef(null), canvasNode = useRef(null), stage = useRef(null);
        const editor = useRef(null), docs = useRef(new Map()), current = useRef(null), lock = useRef(false);
        const restoring = useRef(false), mounted = useRef(true), dirty = useRef(false), panelRef = useRef(null);
        const cropDrag = useRef(null), zoomRef = useRef(1), previewFrame = useRef(null), previewPending = useRef(false);
        const pointerInside = useRef(false), fontInput = useRef(null);
        const config = (key, value) => {
            setSettings(previous => ({ ...previous, [key]: value }));
            if (Object.hasOwn(ADJUSTMENTS, key) && doc() && !restoring.current) {
                const number = Number(value), min = key === 'pixel' ? 1 : 0, max = key === 'blur' ? 40 : key === 'sharpen' ? 100 : 200;
                if (!Number.isFinite(number) || String(value).trim() === '' || number < min || number > max) {
                    setError('Enter a ' + key + ' value from ' + min + ' to ' + max + '.'); return;
                }
                setError('');
                doc().adjustments = { ...doc().adjustments, [key]: number };
                previewPending.current = true; commit();
            }
        };
        const doc = () => docs.current.get(current.current);
        const run = async (label, action) => {
            if (lock.current) return;
            lock.current = true; setBusy(label); setError('');
            try { flushPreview(); await action(); }
            catch (failure) { if (mounted.current) setError(failure.message || String(failure)); }
            finally { lock.current = false; if (mounted.current) setBusy(''); }
        };
        function snapshot() {
            const value = doc();
            if (!value || !editor.current) return;
            return { base: value.base, overlay: { objects: editor.current.getObjects().map(layerSnapshot) },
                dpi: value.dpi, adjustments: { ...value.adjustments }, targets: value.targets, blurRegion: value.blurRegion };
        }
        function trimHistory() {
            const values = [...docs.current.values()];
            function retainedPixels() {
                const bases = new Set(values.flatMap(value => [value.base, ...value.history.map(state => state.base)]));
                return [...bases].reduce((sum, base) => sum + base.width * base.height, 0);
            }
            while (retainedPixels() > MAX_TOTAL_PIXELS) {
                const candidate = values.find(value => value.index > 0) || values.find(value => value.history.length > 1);
                if (!candidate) break;
                if (candidate.index > 0) { candidate.history.shift(); candidate.index--; }
                else candidate.history.pop();
            }
        }
        function capture() {
            if (restoring.current || lock.current) return;
            commit();
        }
        function commit() {
            const value = doc(), state = snapshot();
            if (!state) return;
            const previous = value.history[value.index];
            if (previous && previous.base === state.base && previous.dpi === state.dpi &&
                JSON.stringify(previous.overlay) === JSON.stringify(state.overlay) &&
                JSON.stringify(previous.adjustments) === JSON.stringify(state.adjustments) &&
                JSON.stringify(previous.blurRegion) === JSON.stringify(state.blurRegion) &&
                JSON.stringify(previous.targets) === JSON.stringify(state.targets)) return;
            value.history = value.history.slice(0, value.index + 1);
            value.history.push(state);
            if (value.history.length > 8) value.history.shift();
            value.index = value.history.length - 1;
            trimHistory();
            dirty.current = true; setRevision(previous => previous + 1);
        }
        function fitZoom(width, height) {
            const viewport = stage.current;
            return Math.min(1, Math.max(.05, Math.min((viewport.clientWidth - 56) / width, (viewport.clientHeight - 56) / height)));
        }
        function displayZoom(value) {
            zoomRef.current = value; setZoom(value);
            const c = editor.current, valueDoc = doc();
            if (!c || !valueDoc) return;
            c.setDimensions({ width: Math.max(1, Math.round(valueDoc.base.width * value)), height: Math.max(1, Math.round(valueDoc.base.height * value)) });
            c.setViewportTransform([value, 0, 0, value, 0, 0]); c.renderAll();
        }
        function flushPreview() {
            if (previewFrame.current) { cancelAnimationFrame(previewFrame.current); previewFrame.current = null; }
            const value = doc();
            if (!previewPending.current || !value || !editor.current) return;
            const changed = Object.keys(ADJUSTMENTS).some(key => value.adjustments[key] !== ADJUSTMENTS[key]);
            const base = changed ? adjustedCanvas(value.base, value.adjustments, value.blurRegion) : value.base;
            previewPending.current = false;
            editor.current.setBackgroundImage(new fabric.Image(base, { selectable: false, evented: false }), editor.current.renderAll.bind(editor.current));
        }
        useEffect(() => {
            if (!previewPending.current) return;
            previewFrame.current = requestAnimationFrame(() => {
                previewFrame.current = null;
                try { flushPreview(); }
                catch (failure) { setError(failure.message); }
            });
            return () => { if (previewFrame.current) cancelAnimationFrame(previewFrame.current); };
        }, [settings.brightness, settings.contrast, settings.saturation, settings.blur, settings.sharpen, settings.pixel]);
        async function renderState(state, fit = false) {
            const c = editor.current, value = doc();
            if (!c || !value) return;
            restoring.current = true;
            try {
                value.base = state.base; value.dpi = state.dpi;
                value.adjustments = { ...ADJUSTMENTS, ...state.adjustments }; value.targets = state.targets || [];
                value.blurRegion = state.blurRegion || null;
                await new Promise(resolve => c.loadFromJSON(state.overlay, resolve));
                const changed = Object.keys(ADJUSTMENTS).some(key => value.adjustments[key] !== ADJUSTMENTS[key]);
                const background = new fabric.Image(changed ? adjustedCanvas(state.base, value.adjustments, value.blurRegion) : state.base, { selectable: false, evented: false });
                c.setBackgroundImage(background, c.renderAll.bind(c));
                previewPending.current = false;
                setSettings(previous => ({ ...previous, ...value.adjustments }));
                setTextTargets(value.targets || []); setManualText(null);
                setPendingFont(null);
                setSize({ width: state.base.width, height: state.base.height });
                config('width', state.base.width); config('height', state.base.height); config('dpi', state.dpi);
                displayZoom(fit ? fitZoom(state.base.width, state.base.height) : zoomRef.current);
                setCrop(null); setRegionMode(null); setRevision(previous => previous + 1);
            } finally { restoring.current = false; }
        }
        function scene(value = doc()) {
            const source = value.base, target = canvasOf(source.width, source.height);
            if (value === doc()) {
                const c = editor.current;
                const viewport = c.viewportTransform.slice(), previousWidth = c.width, previousHeight = c.height;
                try {
                    c.setDimensions({ width: source.width, height: source.height });
                    c.setViewportTransform([1, 0, 0, 1, 0, 0]);
                    target.getContext('2d').drawImage(c.toCanvasElement(), 0, 0);
                } finally {
                    c.setDimensions({ width: previousWidth, height: previousHeight }); c.setViewportTransform(viewport); c.renderAll();
                }
            }
            return target;
        }
        async function renderedDoc(value) {
            if (value === doc()) return scene();
            const c = new fabric.StaticCanvas(document.createElement('canvas'), { width: value.base.width, height: value.base.height, enableRetinaScaling: false });
            try {
                await new Promise(resolve => c.loadFromJSON(value.history[value.index].overlay, resolve));
                const changed = Object.keys(ADJUSTMENTS).some(key => value.adjustments[key] !== ADJUSTMENTS[key]);
                c.setBackgroundImage(new fabric.Image(changed ? adjustedCanvas(value.base, value.adjustments, value.blurRegion) : value.base), c.renderAll.bind(c)); c.renderAll();
                return c.toCanvasElement();
            } finally { c.dispose(); }
        }
        async function bake(base, message) {
            const total = [...docs.current.values()].reduce((sum, value) => sum + (value === doc() ? 0 : value.base.width * value.base.height), base.width * base.height);
            if (total > MAX_TOTAL_PIXELS) throw new Error('Workspace limit is 60 megapixels. Remove an image or use smaller dimensions.');
            doc().targets = [];
            await renderState({ base, overlay: { objects: [] }, dpi: doc().dpi, adjustments: ADJUSTMENTS }, true);
            commit(); setNote(message || 'Applied');
        }
        function addCanvas(base, name) {
            if (docs.current.size >= MAX_IMAGES) throw new Error('The workspace supports up to 24 images. Remove images before importing more.');
            const total = [...docs.current.values()].reduce((sum, value) => sum + value.base.width * value.base.height, base.width * base.height);
            if (total > MAX_TOTAL_PIXELS) throw new Error('Workspace limit is 60 megapixels. Remove images before importing more.');
            const id = crypto.randomUUID(), thumbnail = canvasOf(90, Math.max(1, Math.round(90 * base.height / base.width)));
            thumbnail.getContext('2d').drawImage(base, 0, 0, thumbnail.width, thumbnail.height);
            const value = { id, name, base, dpi: 300, adjustments: { ...ADJUSTMENTS }, targets: [], thumbnail: thumbnail.toDataURL(),
                history: [{ base, overlay: { objects: [] }, dpi: 300, adjustments: { ...ADJUSTMENTS } }], index: 0 };
            docs.current.set(id, value); trimHistory(); return value;
        }
        async function choose(id) {
            if (doc()) doc().history[doc().index] = snapshot();
            current.current = id; setActive(id);
            await renderState(doc().history[doc().index], true);
        }
        function refreshItems() { setItems([...docs.current.values()].map(value => ({ id: value.id, name: value.name, thumbnail: value.thumbnail }))); }
        async function importFiles(files, asOverlay = false) {
            if (!files.length) return;
            await run('Importing local files...', async () => {
                const imported = [];
                let failure;
                try {
                    for (const file of files) {
                        if (file.size > 80000000) throw new Error(file.name + ': maximum file size is 80 MB.');
                        if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
                            if (asOverlay) throw new Error('Use a PNG, JPEG, WebP or HEIC image for an overlay.');
                            await loadScript('pdfjsLib', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
                            window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                            const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
                            try {
                                if (pdf.numPages + docs.current.size > MAX_IMAGES) throw new Error('This PDF exceeds the remaining 24-image workspace capacity.');
                                for (let number = 1; number <= pdf.numPages; number++) {
                                    const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 2 });
                                    const base = canvasOf(Math.ceil(viewport.width), Math.ceil(viewport.height));
                                    await page.render({ canvasContext: base.getContext('2d'), viewport }).promise;
                                    const value = addCanvas(base, file.name.replace(/\.pdf$/i, '') + '-page-' + number);
                                    value.dpi = 144; value.history[0].dpi = 144; imported.push(value); page.cleanup();
                                }
                            } finally { await pdf.destroy(); }
                        } else {
                            let blob = file;
                            if (/\.(heic|heif)$/i.test(file.name) || /image\/hei[cf]/.test(file.type)) {
                                await loadScript('heic2any', 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js');
                                blob = await window.heic2any({ blob: file, toType: 'image/png' });
                                if (Array.isArray(blob)) throw new Error('Multi-frame HEIC is not supported. Export a single photo first.');
                            } else if (!/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name) && !/^image\/(png|jpeg|webp|gif|bmp|avif)$/.test(file.type)) {
                                throw new Error(file.name + ': unsupported file. Import PNG, JPEG, WebP, HEIC, GIF, BMP, AVIF or PDF.');
                            }
                            const base = await decode(blob);
                            if (asOverlay) {
                                const object = new fabric.Image(base, { left: 20, top: 20 });
                                object.scaleToWidth(Math.min(base.width, doc().base.width * .5));
                                editor.current.add(object); editor.current.setActiveObject(object); commit();
                            } else imported.push(addCanvas(base, file.name.replace(/\.[^.]+$/, '')));
                        }
                    }
                } catch (error) { failure = error; }
                if (imported.length) { refreshItems(); await choose(imported[0].id); dirty.current = true; }
                if (failure) throw new Error(failure.message + (imported.length ? ' Earlier successful imports are available in the image strip.' : ''));
                setNote(imported.length + ' image' + (imported.length === 1 ? '' : 's') + ' opened');
            });
        }
        useEffect(() => {
            mounted.current = true;
            run('Loading editor...', async () => {
                await loadScript('fabric', 'https://cdnjs.cloudflare.com/ajax/libs/fabric.js/5.3.1/fabric.min.js');
                if (!mounted.current) return;
                editor.current = new fabric.Canvas(canvasNode.current, { width: 1, height: 1, enableRetinaScaling: false, preserveObjectStacking: true });
                for (const event of ['object:modified', 'path:created', 'text:changed', 'text:editing:exited']) editor.current.on(event, capture);
                for (const event of ['selection:created', 'selection:updated', 'selection:cleared']) editor.current.on(event, () => {
                    const object = editor.current.getActiveObject();
                    if (object?.type === 'i-text') setSettings(previous => ({ ...previous, text: object.text, fontFamily: object.fontFamily,
                        fontSize: object.fontSize, color: object.fill, opacity: Math.round(object.opacity * 100),
                        fontWeight: object.fontWeight, fontStyle: object.fontStyle, underline: object.underline, linethrough: object.linethrough,
                        textAlign: object.textAlign, lineHeight: object.lineHeight, charSpacing: object.charSpacing }));
                    setRevision(previous => previous + 1);
                });
                setReady(true);
            });
            return () => { mounted.current = false; if (previewFrame.current) cancelAnimationFrame(previewFrame.current);
                editor.current?.dispose(); editor.current = null; docs.current.clear(); };
        }, []);
        function close() {
            if (lock.current) { setError('Wait for the current operation to finish before closing.'); return; }
            if (dirty.current && !window.confirm('Discard this image workspace? Download your images first to keep edits.')) return;
            onClose();
        }
        useEffect(() => {
            function pointer(event) { pointerInside.current = !!panelRef.current?.contains(event.target); }
            function unload(event) { if (dirty.current || lock.current) { event.preventDefault(); event.returnValue = ''; } }
            function key(event) {
                if (event.key === 'Escape') {
                    event.preventDefault(); event.stopImmediatePropagation();
                    const object = editor.current?.getActiveObject();
                    if (object?.isEditing) { object.exitEditing(); editor.current.renderAll(); }
                    else if (crop) setCrop(null);
                    else if (editSource) { setEditSource(false); setManualText(null); }
                    else close();
                    return;
                }
                const object = editor.current?.getActiveObject();
                const action = imageShortcut(event, panelRef.current?.contains(event.target), pointerInside.current, object?.isEditing);
                if (!action || lock.current) return;
                if (['bold', 'italic', 'underline', 'selectText'].includes(action) && object?.type !== 'i-text') return;
                event.preventDefault(); event.stopImmediatePropagation();
                if (action === 'undo' || action === 'redo') undo(action === 'redo' ? 1 : -1);
                else if (action === 'delete') removeSelection();
                else if (action === 'selectText') editSelectedText();
                else toggleTextStyle(action);
            }
            document.addEventListener('pointerdown', pointer, true);
            window.addEventListener('beforeunload', unload); window.addEventListener('keydown', key, true);
            return () => { document.removeEventListener('pointerdown', pointer, true);
                window.removeEventListener('beforeunload', unload); window.removeEventListener('keydown', key, true); };
        });
        async function undo(direction) {
            await run('Restoring edit...', async () => {
                const value = doc(); if (!value) return;
                const next = value.index + direction;
                if (next < 0 || next >= value.history.length) return;
                const object = editor.current.getActiveObject(), objectIndex = editor.current.getObjects().indexOf(object), editing = object?.isEditing;
                restoring.current = true;
                if (editing) object.exitEditing();
                value.index = next; await renderState(value.history[next], true); dirty.current = true;
                const restored = editor.current.getObjects()[objectIndex];
                if (restored?.selectable !== false && restored) {
                    editor.current.setActiveObject(restored);
                    if (editing && restored.type === 'i-text') { restored.enterEditing(); restored.selectAll(); restored.hiddenTextarea?.focus(); }
                    editor.current.renderAll();
                }
            });
        }
        function removeSelection() {
            const c = editor.current;
            if (!c || lock.current) return;
            c.getActiveObjects().forEach(object => {
                if (object.replacementMask) c.getObjects().filter(mask => mask.name === object.replacementMask).forEach(mask => c.remove(mask));
                c.remove(object);
            }); c.discardActiveObject(); c.renderAll(); commit();
        }
        function addObject(object) {
            editor.current.isDrawingMode = false;
            editor.current.add(object); editor.current.setActiveObject(object); editor.current.renderAll(); commit();
        }
        function numericSetting(key, label, min, max) {
            const number = Number(settings[key]);
            if (String(settings[key]).trim() === '' || !Number.isFinite(number) || number < min || number > max) {
                throw new Error(label + ' must be between ' + min + ' and ' + max + '.');
            }
            return number;
        }
        function insertText(watermark) {
            return run('Adding editable text...', async () => {
                if (!settings.text.trim()) throw new Error('Enter text before adding a text layer or watermark.');
                const fontSize = numericSetting('fontSize', 'Font size', 1, 2000), opacity = numericSetting('opacity', 'Opacity', 1, 100) / 100;
                addObject(new fabric.IText(settings.text, { left: size.width * (watermark ? .5 : .1), top: size.height * (watermark ? .5 : .1),
                    originX: watermark ? 'center' : 'left', originY: watermark ? 'center' : 'top', angle: watermark ? -25 : 0,
                    ...textStyle(), fontSize, fill: settings.color, opacity }));
            });
        }
        function insertShape(ellipse) {
            return run('Adding editable shape...', async () => {
                const properties = { left: 30, top: 30, fill: 'transparent', stroke: settings.color,
                    strokeWidth: numericSetting('stroke', 'Stroke width', 1, 200) };
                addObject(ellipse ? new fabric.Ellipse({ ...properties, rx: size.width * .15, ry: size.height * .1 })
                    : new fabric.Rect({ ...properties, width: size.width * .3, height: size.height * .2 }));
            });
        }
        async function detectText() {
            await run('Finding text...', async () => {
                await loadScript('Tesseract', 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
                const worker = await window.Tesseract.createWorker('eng');
                try {
                    const { data } = await worker.recognize(doc().base);
                    const targets = ocrTargets(data.words?.length ? data.words : data.lines, size.width, size.height);
                    if (!targets.length) throw new Error('No text found. Try a clearer image or use Add text.');
                    doc().targets = targets; setTextTargets(targets); setEditSource(true); setManualText(null); setCrop(null);
                    editor.current.isDrawingMode = false; commit(); setNote('Select text on the image');
                } finally { await worker.terminate(); }
            });
        }
        async function replaceSourceText(target, manual = false, confirmed = null) {
            if (lock.current) return;
            const existing = editor.current.getObjects().find(object => object.replacementTarget === target.id);
            if (existing) {
                editor.current.setActiveObject(existing); setEditSource(false); editSelectedText(); return;
            }
            let colors;
            try {
                if (confirmed) colors = confirmed.colors;
                else if (manual) colors = { paper: settings.background, fill: settings.color };
                else colors = window.DailyPdfTools.textPatchColors({ x: target.x - 2, y: target.y - 2, width: target.width + 2,
                    height: (target.height + 4) / 1.3, angle: 0 }, doc().base, size.width, size.height);
            } catch (failure) {
                setManualText(target);
                setError(failure.message.includes('complex background') ? 'This area has a complex background. Choose cover and text colors to replace it.'
                    : 'Text colors could not be matched. Choose cover and text colors to replace it.'); return;
            }
            editor.current.discardActiveObject(); editor.current.renderAll();
            return run('Matching text style...', async () => {
                let matched;
                if (confirmed || manual) matched = { ...textStyle(), fontSize: confirmed?.suggestion?.fontSize || target.height };
                else {
                    matched = await matchRasterFont(doc().base, target, colors, [...window.DailyPdfTools.FONT_CHOICES, ...customFonts]);
                    if (!reliableFontMatch(matched, target.text)) {
                        try { await loadOpenFonts(); }
                        catch (failure) {
                            setError(failure.message); setPendingFont({ target, colors, suggestion: matched });
                            setSettings(previous => ({ ...previous, text: target.text, ...matched }));
                            setEditSource(false); setNote('Choose or import a local font, then confirm.'); return;
                        }
                        matched = await matchRasterFont(doc().base, target, colors, [...window.DailyPdfTools.FONT_CHOICES, ...OPEN_FONTS, ...customFonts]);
                    }
                    if (!reliableFontMatch(matched, target.text)) {
                        setPendingFont({ target, colors, suggestion: matched });
                        setSettings(previous => ({ ...previous, text: target.text, ...matched }));
                        setEditSource(false);
                        setNote('Font match uncertain. Choose the original font and style, then confirm.');
                        return;
                    }
                }
                const id = 'image-mask-' + crypto.randomUUID();
                const bounds = cropBounds({ x: target.x - 2, y: target.y - 2, width: target.width + 4, height: target.height + 4 }, size.width, size.height);
                const mask = new fabric.Rect({ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height,
                    fill: colors.paper, strokeWidth: 0, selectable: false, evented: false, name: id });
                const text = new fabric.IText(target.text, { ...matched,
                    underline: manual ? settings.underline : false, linethrough: manual ? settings.linethrough : false,
                    left: 0, top: 0, fontSize: matched.fontSize || target.height, fill: colors.fill, replacementMask: id, replacementTarget: target.id });
                const glyphCanvas = text.toCanvasElement();
                const glyphCtx = glyphCanvas.getContext('2d'), glyphImage = glyphCtx.getImageData(0, 0, glyphCanvas.width, glyphCanvas.height);
                for (let i = 0; i < glyphImage.data.length; i += 4) glyphImage.data[i] = 0;
                glyphCtx.putImageData(glyphImage, 0, 0);
                const glyph = inkBounds(glyphCanvas), scaleX = target.width / glyph.width, scaleY = target.height / glyph.height;
                text.set({ left: target.x - glyph.x * scaleX, top: target.y - glyph.y * scaleY, scaleX, scaleY });
                editor.current.add(mask); addObject(text);
                setManualText(null); setPendingFont(null); setError(''); setEditSource(false);
                text.enterEditing(); text.selectAll(); text.hiddenTextarea?.focus(); editor.current.renderAll(); commit();
                setNote(manual ? '' : 'Closest font: ' + matched.fontFamily + (matched.fontWeight === 'bold' ? ' Bold' : '') + (matched.fontStyle === 'italic' ? ' Italic' : ''));
            });
        }
        function editSelectedText() {
            const object = editor.current.getActiveObject();
            if (object?.type !== 'i-text') { setError('Select a text layer, or use Edit image text to find existing text.'); return; }
            object.enterEditing(); object.selectAll(); editor.current.renderAll();
        }
        function textStyle() {
            return Object.fromEntries(['fontFamily', 'fontWeight', 'fontStyle', 'underline', 'linethrough', 'textAlign', 'lineHeight', 'charSpacing']
                .map(key => [key, settings[key]]));
        }
        function toggleTextStyle(kind) {
            const key = kind === 'bold' ? 'fontWeight' : kind === 'italic' ? 'fontStyle' : kind;
            const object = editor.current?.getActiveObject(), old = object?.type === 'i-text' ? object[key] : settings[key];
            const next = kind === 'bold' ? old === 'bold' ? 'normal' : 'bold' : kind === 'italic' ? old === 'italic' ? 'normal' : 'italic' : !old;
            config(key, next);
            if (object?.type === 'i-text') { object.set(key, next); object.setCoords(); editor.current.renderAll(); commit(); }
        }
        async function importFont(file) {
            await run('Loading font...', async () => {
                const family = 'DailyImage-' + crypto.randomUUID(), face = new FontFace(family, await file.arrayBuffer());
                await face.load(); document.fonts.add(face);
                setCustomFonts(previous => [...previous, { family, label: file.name.replace(/\.[^.]+$/, '') }]);
                config('fontFamily', family);
                const object = editor.current.getActiveObject();
                if (object?.type === 'i-text') { object.set('fontFamily', family); object.setCoords(); editor.current.renderAll(); commit(); }
            });
        }
        async function recognizeTextRegion(rect) {
            await run('Reading selected text...', async () => {
                await loadScript('Tesseract', 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
                const patch = canvasOf(rect.width, rect.height);
                patch.getContext('2d').drawImage(doc().base, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
                const worker = await window.Tesseract.createWorker('eng');
                try {
                    const { data } = await worker.recognize(patch);
                    const targets = ocrTargets(data.words?.length ? data.words : data.lines, rect.width, rect.height)
                        .map(target => ({ ...target, id: 'text-' + crypto.randomUUID(), x: target.x + rect.x, y: target.y + rect.y }));
                    if (!targets.length) throw new Error('No text recognized in this area. Try a tighter selection or add text manually.');
                    doc().targets = [...doc().targets, ...targets]; setTextTargets(doc().targets);
                    setCrop(null); setRegionMode(null); setEditSource(true); commit(); setNote('Select the recognized word to edit.');
                } finally { await worker.terminate(); }
            });
        }
        function chooseRegion(mode) {
            setRegionMode(mode); setRatio('free'); setEditSource(false);
            editor.current.isDrawingMode = false; editor.current.discardActiveObject(); editor.current.renderAll();
            setCrop(doc().blurRegion && mode === 'blur' ? doc().blurRegion : aspectCrop(size.width, size.height, 0));
        }
        function applyRegion() {
            if (regionMode === 'text') {
                const rect = cropBounds(crop, size.width, size.height);
                recognizeTextRegion(rect);
            } else {
                doc().blurRegion = cropBounds(crop, size.width, size.height);
                if (!doc().adjustments.blur) { doc().adjustments.blur = 8; config('blur', 8); }
                previewPending.current = true; flushPreview(); commit(); setCrop(null); setRegionMode(null);
            }
        }
        function startCrop(value = ratio, customRatio = settings.width / settings.height) {
            editor.current.isDrawingMode = false; editor.current.discardActiveObject(); editor.current.renderAll();
            const aspect = value === 'free' ? 0 : value === 'custom' ? customRatio : Number(value);
            if (!Number.isFinite(aspect) || aspect < 0 || value !== 'free' && aspect === 0) { setError('Enter positive width and height for a custom crop ratio.'); return; }
            setCrop(aspectCrop(size.width, size.height, aspect));
        }
        function pointerDown(event, handle) {
            event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
            cropDrag.current = { x: event.clientX, y: event.clientY, rect: { ...crop }, handle };
        }
        function pointerMove(event) {
            const drag = cropDrag.current;
            if (!drag || !crop) return;
            const dx = (event.clientX - drag.x) / zoom, dy = (event.clientY - drag.y) / zoom, r = drag.rect;
            if (!drag.handle) { setCrop({ ...r, x: Math.max(0, Math.min(size.width - r.width, r.x + dx)), y: Math.max(0, Math.min(size.height - r.height, r.y + dy)) }); return; }
            const left = drag.handle.includes('w'), top = drag.handle.includes('n');
            const anchorX = left ? r.x + r.width : r.x, anchorY = top ? r.y + r.height : r.y;
            let width = Math.max(1, r.width + (left ? -dx : dx)), height = Math.max(1, r.height + (top ? -dy : dy));
            const aspect = regionMode || ratio === 'free' ? 0 : ratio === 'custom' ? settings.width / settings.height : Number(ratio);
            if (aspect > 0 && Number.isFinite(aspect)) { height = width / aspect; }
            const scale = Math.min(1, (left ? anchorX : size.width - anchorX) / width, (top ? anchorY : size.height - anchorY) / height);
            width *= scale; height *= scale;
            setCrop(cropBounds({ x: left ? anchorX - width : anchorX, y: top ? anchorY - height : anchorY, width, height }, size.width, size.height));
        }
        async function applyCrop() {
            await run('Cropping...', async () => {
                const resizeWidth = settings.width, resizeHeight = settings.height;
                const r = cropBounds(crop, size.width, size.height), target = canvasOf(r.width, r.height);
                target.getContext('2d').drawImage(scene(), r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
                await bake(target);
                if (ratio === 'custom') { config('width', resizeWidth); config('height', resizeHeight); }
            });
        }
        async function applyResize() {
            await run('High-quality resizing...', async () => {
                const { width, height } = dimensions(Number(settings.width), Number(settings.height)), source = scene();
                if (settings.fit === 'stretch') { await bake(await resize(source, width, height)); return; }
                const place = placement(source.width, source.height, width, height, settings.fit);
                const target = canvasOf(width, height), ctx = target.getContext('2d');
                if (!settings.transparent) { ctx.fillStyle = settings.background; ctx.fillRect(0, 0, width, height); }
                let area = source;
                if (settings.fit === 'cover') {
                    const bounds = aspectCrop(source.width, source.height, width / height);
                    area = canvasOf(bounds.width, bounds.height);
                    area.getContext('2d').drawImage(source, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
                    ctx.drawImage(await resize(area, width, height), 0, 0);
                } else ctx.drawImage(await resize(area, Math.max(1, Math.round(place.width)), Math.max(1, Math.round(place.height))), Math.round(place.x), Math.round(place.y));
                await bake(target);
            });
        }
        async function transform(kind) {
            await run('Transforming image...', async () => {
                const source = scene();
                const { width, height, radians } = rotationSize(source.width, source.height, kind === 'rotate' ? Number(settings.angle) : 0);
                const target = canvasOf(width, height), ctx = target.getContext('2d');
                ctx.translate(width / 2, height / 2); ctx.rotate(radians);
                ctx.scale(kind === 'flipX' ? -1 : 1, kind === 'flipY' ? -1 : 1);
                ctx.drawImage(source, -source.width / 2, -source.height / 2);
                await bake(target);
            });
        }
        async function background(remove) {
            await run(remove ? 'Loading local background-removal model...' : 'Changing background...', async () => {
                let source = scene();
                if (remove) {
                    if (!window.isSecureContext) throw new Error('Background removal requires HTTPS or localhost.');
                    const library = await import('https://esm.sh/@imgly/background-removal@1.7.0?bundle');
                    const blob = await library.removeBackground(await encode(source, 'image/png'), {
                        device: 'cpu', model: 'isnet_quint8',
                        progress: (key, done, total) => { if (mounted.current) setBusy('Downloading model: ' + (total ? Math.round(done / total * 100) + '%' : key)); }
                    });
                    source = await decode(blob);
                }
                const target = canvasOf(source.width, source.height), ctx = target.getContext('2d');
                if (!settings.transparent) { ctx.fillStyle = settings.background; ctx.fillRect(0, 0, target.width, target.height); }
                ctx.drawImage(source, 0, 0); await bake(target);
            });
        }
        async function frame(kind) {
            await run('Applying frame...', async () => {
                const source = scene();
                if (kind === 'border') {
                    const border = Number(settings.border);
                    if (!Number.isInteger(border) || border < 0 || border > 2000) throw new Error('Border must be between 0 and 2,000 pixels.');
                    const target = canvasOf(source.width + border * 2, source.height + border * 2), ctx = target.getContext('2d');
                    ctx.fillStyle = settings.color; ctx.fillRect(0, 0, target.width, target.height); ctx.drawImage(source, border, border);
                    await bake(target);
                } else {
                    const radius = Number(settings.radius);
                    if (!Number.isFinite(radius) || radius < 0) throw new Error('Corner radius cannot be negative.');
                    const target = canvasOf(source.width, source.height), ctx = target.getContext('2d');
                    ctx.beginPath(); ctx.roundRect(0, 0, source.width, source.height, Math.min(radius, source.width / 2, source.height / 2)); ctx.clip(); ctx.drawImage(source, 0, 0);
                    await bake(target);
                }
            });
        }
        async function collage() {
            await run('Building collage...', async () => {
                const columns = Number(settings.columns), gap = Number(settings.gap), cw = Number(settings.cellWidth), ch = Number(settings.cellHeight);
                if (!Number.isInteger(columns) || columns < 1 || columns > 8 || !Number.isInteger(gap) || gap < 0 || gap > 500) throw new Error('Use 1-8 columns and a gap from 0 to 500 pixels.');
                dimensions(cw, ch);
                const values = [...docs.current.values()], rows = Math.ceil(values.length / columns);
                const target = canvasOf(columns * cw + (columns + 1) * gap, rows * ch + (rows + 1) * gap), ctx = target.getContext('2d');
                if (!settings.transparent) { ctx.fillStyle = settings.background; ctx.fillRect(0, 0, target.width, target.height); }
                for (let index = 0; index < values.length; index++) {
                    const source = await renderedDoc(values[index]), bounds = aspectCrop(source.width, source.height, cw / ch), area = canvasOf(bounds.width, bounds.height);
                    area.getContext('2d').drawImage(source, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
                    ctx.drawImage(await resize(area, cw, ch), gap + index % columns * (cw + gap), gap + Math.floor(index / columns) * (ch + gap));
                }
                const value = addCanvas(target, 'collage'); refreshItems(); await choose(value.id); dirty.current = true;
                setNote('Collage created');
            });
        }
        function download(blob, name) {
            const url = URL.createObjectURL(blob), anchor = document.createElement('a');
            anchor.href = url; anchor.download = name; document.body.appendChild(anchor); anchor.click(); anchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        }
        async function exportImage(all = false) {
            await run('Encoding export...', async () => {
                const values = all ? [...docs.current.values()] : [doc()];
                const automatic = settings.autoSize && String(settings.limit).trim() !== '';
                const type = MIME[settings.format];
                for (const value of values) {
                    let source = await renderedDoc(value);
                    if (type === 'image/jpeg') {
                        const opaque = canvasOf(source.width, source.height), ctx = opaque.getContext('2d');
                        ctx.fillStyle = settings.background; ctx.fillRect(0, 0, source.width, source.height); ctx.drawImage(source, 0, 0); source = opaque;
                    }
                    const dpi = Number(settings.dpi);
                    let result;
                    if (String(settings.limit).trim()) {
                        const multiplier = settings.unit === 'bytes' ? 1 : settings.unit === 'KB' ? 1000 : 1000000;
                        if (automatic) {
                            result = await autoCompress(source, Number(settings.limit) * multiplier, dpi,
                                message => { if (mounted.current) setBusy(message); }, imageBlob, resize, encodingError, type !== MIME.jpg, type);
                        } else if (settings.lossless && type === MIME.png) {
                            const target = Number(settings.limit) * multiplier;
                            sizeLimit(target);
                            const blob = await imageBlob(source, type, 1, dpi);
                            if (blob.size > target) throw new Error('Lossless output is ' + blob.size.toLocaleString() + ' bytes, above your limit. Increase the limit or switch off Lossless to allow quality changes.');
                            result = { blob, width: source.width, height: source.height, quality: 1 };
                        } else result = await compress(source, type, Number(settings.limit) * multiplier, dpi, Number(settings.minQuality) / 100,
                            (type !== MIME.png || !settings.lossless) && settings.allowResize, message => { if (mounted.current) setBusy(message); });
                    } else result = { blob: await imageBlob(source, type, Number(settings.quality) / 100, dpi), width: source.width, height: source.height, quality: Number(settings.quality) / 100 };
                    const extension = settings.format;
                    download(result.blob, value.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') + '.' + extension);
                    const resized = result.width !== source.width || result.height !== source.height;
                    setNote(`${value.name}: ${result.blob.size.toLocaleString()} bytes | ${extension.toUpperCase()} | ${result.width} x ${result.height} | ${dpi} DPI` +
                        (automatic ? (result.type === MIME.png && !resized ? ' | Lossless' : ' | Optimized' + (resized ? ', dimensions reduced' : ', original dimensions')) : ''));
                }
            });
        }
        async function exportPdf() {
            await run('Creating PDF...', async () => {
                await loadScript('PDFLib', 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');
                const pdf = await window.PDFLib.PDFDocument.create();
                for (const value of docs.current.values()) {
                    const source = await renderedDoc(value), blob = await encode(source, 'image/png'), image = await pdf.embedPng(await blob.arrayBuffer());
                    const width = source.width * 72 / value.dpi, height = source.height * 72 / value.dpi;
                    const page = pdf.addPage([width, height]); page.drawImage(image, { x: 0, y: 0, width, height });
                }
                download(new Blob([await pdf.save()], { type: 'application/pdf' }), 'images.pdf');
                setNote('PDF downloaded');
            });
        }
        const disabled = !ready || !!busy || !active;
        const automaticExport = settings.autoSize && String(settings.limit).trim() !== '';
        const value = doc(), c = editor.current, selection = c?.getActiveObject();
        const BUTTON_ICONS = { 'Open images / PDF': 'FolderOpen', Undo: 'Undo2', Redo: 'Redo2', 'Zoom out': 'Minus', 'Zoom in': 'Plus',
            Fit: 'Maximize', 'Show crop box': 'Crop', 'Apply crop': 'Check', Cancel: 'X', Rotate: 'RotateCw',
            'Flip H': 'FlipHorizontal', 'Flip V': 'FlipVertical', 'Add text': 'Type', Watermark: 'Stamp', Rectangle: 'Square',
            Ellipse: 'Circle', Draw: 'Pencil', Select: 'MousePointer2', Delete: 'Trash2', Duplicate: 'Copy', Up: 'ArrowUp', Down: 'ArrowDown',
            'Insert image overlay': 'ImagePlus', 'Edit selected text': 'TextCursorInput', 'Move image earlier': 'ArrowUp',
            'Move image later': 'ArrowDown', 'Remove current image': 'Trash2' };
        const button = (label, action, off = disabled, icon) => {
            const glyph = icon || BUTTON_ICONS[label];
            return h('button', { type: 'button', className: 'btn' + (glyph ? ' image-icon-button' : '') + (label === 'Download image' ? ' primary' : ''), disabled: off, onClick: action,
                title: label, 'aria-label': label }, glyph ? h(Icon, { name: glyph, size: 17 }) : label);
        };
        const numeric = (label, value, onChange, options = {}) => h('div', { className: 'image-number' },
            h('button', { type: 'button', title: 'Decrease ' + label, 'aria-label': 'Decrease ' + label, disabled: disabled || options.disabled || Number(value) <= options.min,
                onClick: () => onChange(stepValue(value, -(options.step || 1), options.min, options.max)) }, h(Icon, { name: 'Minus', size: 12 })),
            h('input', { type: 'number', 'aria-label': label, value, step: 1, disabled, ...options, onChange: event => onChange(event.target.value) }),
            h('button', { type: 'button', title: 'Increase ' + label, 'aria-label': 'Increase ' + label, disabled: disabled || options.disabled || Number(value) >= options.max,
                onClick: () => onChange(stepValue(value, options.step || 1, options.min, options.max)) }, h(Icon, { name: 'Plus', size: 12 })));
        const field = (label, key, type = 'number', options = {}) => {
            if (type === 'number' || type === 'range') return h('div', { className: 'image-field' },
                h('span', null, label), numeric(label, settings[key], next => config(key, next), options),
                type === 'range' && h('input', { type: 'range', 'aria-label': label + ' slider', value: settings[key], step: 1, disabled, ...options,
                    style: { '--range-progress': ((Number(settings[key]) - options.min) / (options.max - options.min) * 100) + '%' },
                    onChange: event => config(key, event.target.value) }));
            return h('label', { className: 'image-field' + (type === 'checkbox' ? ' image-check' : type === 'color' ? ' image-color' : '') }, label,
                h('input', { type, value: type === 'checkbox' ? undefined : settings[key], checked: type === 'checkbox' ? settings[key] : undefined,
                    disabled, onChange: event => config(key, type === 'checkbox' ? event.target.checked : event.target.value), ...options }));
        };
        const select = (label, key, choices) => h('label', { className: 'image-field' }, label,
            h('select', { disabled, value: settings[key], onChange: event => {
                const value = event.target.value;
                if (key === 'fontFamily' && OPEN_FONTS.some(font => font.family === value)) run('Loading font...', async () => {
                    await loadOpenFonts(); config(key, value);
                });
                else config(key, value);
            } },
                choices.map(([value, text]) => h('option', { key: value, value }, text))));
        const row = (...children) => h('div', { className: 'image-row' }, ...children);
        const actions = (...children) => h('div', { className: 'image-actions' }, ...children);
        const preset = (width, height) => {
            config('width', width); config('height', height); config('fit', 'cover'); config('dpi', 300); setRatio('custom');
            if (active) { doc().dpi = 300; commit(); startCrop('custom', width / height); }
        };
        const cropField = (label, key) => h('div', { className: 'image-field' }, h('span', null, label),
            numeric(label, Math.round(crop[key]), next => {
                const number = Number(next);
                if (Number.isFinite(number)) { setRatio('free'); setCrop(cropBounds({ ...crop, [key]: number }, size.width, size.height)); }
            }, { min: key === 'x' || key === 'y' ? 0 : 1,
                max: key === 'x' ? size.width - 1 : key === 'y' ? size.height - 1 : key === 'width' ? size.width - crop.x : size.height - crop.y }));
        const tabs = [['geometry', 'Geometry', 'Crop'], ['adjust', 'Adjust', 'SlidersHorizontal'], ['background', 'Background', 'Eraser'],
            ['annotate', 'Annotate', 'Type'], ['collage', 'Collage', 'LayoutGrid'], ['export', 'Export', 'Download']];
        return h(Panel, { title: 'Image Editor', icon: 'Image', onClose: close, initW: 1200, initH: 780, storageKey: 'image-editor', className: 'image-window image-background-' + theme, panelRef },
            h('input', { ref: fontInput, type: 'file', hidden: true, accept: '.ttf,.otf,.woff,.woff2',
                onChange: event => { const file = event.target.files[0]; event.target.value = ''; if (file) importFont(file); } }),
            h('input', { ref: input, type: 'file', hidden: true, multiple: true, accept: '.png,.jpg,.jpeg,.webp,.heic,.heif,.gif,.bmp,.avif,.pdf',
                onChange: event => { const files = [...event.target.files]; event.target.value = ''; importFiles(files); } }),
            h('input', { ref: overlayInput, type: 'file', hidden: true, accept: '.png,.jpg,.jpeg,.webp,.heic,.heif',
                onChange: event => { const files = [...event.target.files]; event.target.value = ''; importFiles(files, true); } }),
            h('div', { className: 'image-commandbar' },
                h('div', { className: 'image-toolbar', role: 'toolbar', 'aria-label': 'Image actions' },
                button('Open images', () => input.current.click(), !ready || !!busy, 'FolderOpen'),
                button('Undo', () => undo(-1), disabled || !value?.index, 'Undo2'),
                button('Redo', () => undo(1), disabled || value?.index >= value?.history.length - 1, 'Redo2')),
            h('div', { className: 'image-tabs', role: 'tablist', 'aria-label': 'Image tools' },
                tabs.map(([id, label, icon]) => h('button', { key: id, role: 'tab', id: 'image-tab-' + id, 'aria-controls': 'image-inspector', 'aria-selected': tab === id,
                    disabled: !!busy,
                    onClick: () => { setTab(id); setEditSource(false); setRegionMode(null); if (id !== 'geometry') setCrop(null); if (editor.current) editor.current.isDrawingMode = false; } },
                    h(Icon, { name: icon, size: 16 }), label))),
                h('div', { className: 'image-view-controls', role: 'toolbar', 'aria-label': 'Image view' },
                    button('Zoom out', () => displayZoom(Math.max(.05, zoom / 1.25))),
                    h('span', { className: 'image-zoom' }, Math.round(zoom * 100) + '%'),
                    button('Zoom in', () => displayZoom(Math.min(4, zoom * 1.25))),
                    button('Fit', () => displayZoom(fitZoom(size.width, size.height))),
                    ['white', 'black'].map(color => h('button', { key: color, type: 'button', className: 'btn image-icon-button',
                        'aria-label': color === 'white' ? 'White editor background' : 'Black editor background', title: color + ' theme',
                        'aria-pressed': theme === color, onClick: () => { setTheme(color); localStorage.setItem('image-editor-theme', color); } },
                        h(Icon, { name: color === 'white' ? 'Sun' : 'Moon', size: 16 }))))),
            error && h('div', { className: 'image-error', role: 'alert' }, error),
            h('div', { className: 'image-layout', 'aria-busy': !!busy },
                h('aside', { className: 'image-assets', 'aria-label': 'Images in export order' }, items.map((item, index) =>
                    h('button', { key: item.id, className: 'image-asset' + (active === item.id ? ' active' : ''), disabled: !!busy, 'aria-pressed': active === item.id,
                        onClick: () => run('Opening image...', () => choose(item.id)) },
                    h('img', { src: item.thumbnail, alt: '' }), h('span', null, (index + 1) + '. ' + item.name)))),
                h('div', { className: 'image-stage', ref: stage, onDragOver: event => { event.preventDefault(); },
                    onDrop: event => { event.preventDefault(); if (ready && !busy) importFiles([...event.dataTransfer.files]); } },
                    !active && h('div', { className: 'image-empty' },
                        button('Open images', () => input.current.click(), !ready || !!busy, 'ImagePlus'),
                        h('span', null, 'Drop images')),
                    h('div', { className: 'image-sheet', style: { width: Math.max(1, Math.round(size.width * zoom)), height: Math.max(1, Math.round(size.height * zoom)), display: active ? 'block' : 'none', pointerEvents: busy ? 'none' : undefined } },
                        h('canvas', { ref: canvasNode }),
                        crop && regionMode && h('div', { className: 'image-region-actions' },
                            button(regionMode === 'text' ? 'Recognize selected text' : 'Use blur region', applyRegion),
                            button('Cancel', () => { setCrop(null); setRegionMode(null); })),
                        editSource && h('div', { className: 'image-text-targets' }, textTargets.map(target =>
                            h('button', { key: target.id, type: 'button', title: 'Edit: ' + target.text, 'aria-label': 'Edit: ' + target.text,
                                style: { left: target.x * zoom, top: target.y * zoom, width: target.width * zoom, height: target.height * zoom },
                                onClick: () => replaceSourceText(target) }))),
                        crop && h('div', { className: 'image-crop-clip' }, h('div', { className: 'image-crop',
                            style: { left: crop.x * zoom, top: crop.y * zoom, width: crop.width * zoom, height: crop.height * zoom },
                            onPointerDown: event => pointerDown(event, null), onPointerMove: pointerMove,
                            onPointerUp: () => { cropDrag.current = null; }, onPointerCancel: () => { cropDrag.current = null; } },
                            ['nw', 'ne', 'sw', 'se'].map(handle => h('span', { key: handle, className: 'image-crop-handle ' + handle,
                                onPointerDown: event => pointerDown(event, handle) })))))),
                h('aside', { className: 'image-inspector', id: 'image-inspector', role: 'tabpanel', 'aria-labelledby': 'image-tab-' + tab, key: tab },
                    tab === 'geometry' && h(React.Fragment, null,
                        h('h4', null, 'Crop & aspect ratio'),
                        h('label', { className: 'image-field' }, 'Crop ratio', h('select', { value: ratio, disabled, onChange: event => { setRatio(event.target.value); startCrop(event.target.value); } },
                            [['free', 'Freeform'], ['1', 'Square 1:1'], [String(4 / 3), '4:3'], [String(3 / 4), '3:4'], [String(16 / 9), '16:9'], [String(9 / 16), '9:16'], ['custom', 'Custom width / height']].map(([value, label]) => h('option', { value, key: value }, label)))),
                        !crop && button('Show crop box', () => startCrop()),
                        crop && h(React.Fragment, null, row(cropField('X (px)', 'x'), cropField('Y (px)', 'y')), row(cropField('Width (px)', 'width'), cropField('Height (px)', 'height')),
                            actions(button('Apply crop', applyCrop), button('Cancel', () => setCrop(null)))),
                        h('h4', null, 'Resize'),
                        row(field('Width (px)', 'width', 'number', { min: 1 }), field('Height (px)', 'height', 'number', { min: 1 })),
                        select('Fit', 'fit', [['contain', 'Contain'], ['cover', 'Cover'], ['stretch', 'Stretch']]),
                        button('Resize', applyResize),
                        h('h4', null, 'Passport / ID presets'),
                        actions(button('35 x 45 mm', () => preset(413, 531)), button('2 x 2 inches', () => preset(600, 600))),
                        h('h4', null, 'Rotate & flip'), field('Rotation (degrees)', 'angle'),
                        actions(button('Rotate', () => transform('rotate')), button('Flip H', () => transform('flipX')), button('Flip V', () => transform('flipY'))),
                        field('Print density (DPI)', 'dpi', 'number', { min: 1, max: 2400 }),
                        button('Apply DPI', () => run('Setting density...', async () => {
                            const dpi = Number(settings.dpi); if (!Number.isInteger(dpi) || dpi < 1 || dpi > 2400) throw new Error('DPI must be between 1 and 2,400.');
                            doc().dpi = dpi; commit(); setNote((size.width / dpi).toFixed(2) + ' x ' + (size.height / dpi).toFixed(2) + ' in');
                        }))),
                    tab === 'adjust' && h(React.Fragment, null,
                        field('Brightness (%)', 'brightness', 'range', { min: 0, max: 200 }), field('Contrast (%)', 'contrast', 'range', { min: 0, max: 200 }),
                        field('Saturation (%)', 'saturation', 'range', { min: 0, max: 200 }), field('Blur (px)', 'blur', 'range', { min: 0, max: 40 }),
                        actions(button('Select blur region', () => chooseRegion('blur')), button('Blur whole image', () => {
                            doc().blurRegion = null; previewPending.current = true; flushPreview(); commit(); setCrop(null); setRegionMode(null);
                        })),
                        field('Sharpen (%)', 'sharpen', 'range', { min: 0, max: 100 }),
                        field('Pixelate (px)', 'pixel', 'range', { min: 1, max: 200 }),
                        button('Reset adjustments', () => {
                            doc().adjustments = { ...ADJUSTMENTS }; doc().blurRegion = null; previewPending.current = true;
                            setCrop(null); setRegionMode(null);
                            setSettings(previous => ({ ...previous, ...ADJUSTMENTS })); flushPreview(); commit();
                        })),
                    tab === 'background' && h(React.Fragment, null,
                        field('Transparent background', 'transparent', 'checkbox'), field('Background color', 'background', 'color'),
                        button('Remove background', () => background(true)),
                        button('Fill transparent areas', () => background(false), disabled || settings.transparent),
                        h('h4', null, 'Border & corners'), field('Frame color', 'color', 'color'), field('Border width (px)', 'border', 'number', { min: 0, max: 2000 }),
                        button('Add border / frame', () => frame('border')), field('Corner radius (px)', 'radius', 'number', { min: 0 }),
                        button('Round corners', () => frame('round'))),
                    tab === 'annotate' && h(React.Fragment, null,
                        h('h4', null, 'Image text'),
                        actions(button('Edit image text', () => {
                            if (textTargets.length) { setEditSource(previous => !previous); setCrop(null); c.isDrawingMode = false; }
                            else detectText();
                        }), button('Rescan text', detectText, disabled, 'ScanText')),
                        button('Select text area', () => chooseRegion('text')),
                        h('span', { className: 'image-hint' }, 'Replaces image text with an editable layer.'),
                        manualText && h('div', { className: 'image-manual-text' },
                            field('Cover color', 'background', 'color'), field('Text color', 'color', 'color'),
                            button('Replace text', () => replaceSourceText(manualText, true))),
                        h('h4', null, 'Text & watermark'),
                        field('Text / watermark', 'text', 'text'), select('Font', 'fontFamily',
                            [...window.DailyPdfTools.FONT_CHOICES, ...OPEN_FONTS, ...customFonts].map(font => [font.family, font.label])),
                        button('Import font', () => fontInput.current.click(), disabled, 'Upload'),
                        actions(...[['bold', 'Bold'], ['italic', 'Italic'], ['underline', 'Underline'], ['linethrough', 'Strikethrough']].map(([kind, icon]) =>
                            h('button', { key: kind, type: 'button', className: 'btn image-icon-button', title: icon, 'aria-label': icon, disabled,
                                'aria-pressed': kind === 'bold' ? settings.fontWeight === 'bold' : kind === 'italic' ? settings.fontStyle === 'italic' : !!settings[kind],
                                onClick: () => toggleTextStyle(kind) }, h(Icon, { name: icon, size: 16 })))),
                        pendingFont && h('div', { className: 'image-manual-text', role: 'status' },
                            h('span', { className: 'image-hint' }, 'Original font not confidently identified. Select a font and bold/italic above, or import the original font.'),
                            h('span', { style: { fontFamily: settings.fontFamily, fontWeight: settings.fontWeight, fontStyle: settings.fontStyle } }, pendingFont.target.text),
                            actions(button('Confirm font & edit', () => replaceSourceText(pendingFont.target, false, pendingFont)),
                                button('Cancel font selection', () => { setPendingFont(null); setNote(''); })) ),
                        select('Alignment', 'textAlign', [['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['justify', 'Justify']]),
                        row(field('Line height', 'lineHeight', 'number', { min: .5, max: 5, step: .01 }),
                            field('Letter spacing', 'charSpacing', 'number', { min: -100, max: 1000 })),
                        row(field('Size (px)', 'fontSize', 'number', { min: 1, max: 2000 }), field('Color', 'color', 'color')),
                        field('Opacity (%)', 'opacity', 'range', { min: 1, max: 100 }),
                        actions(button('Add text', () => insertText(false)), button('Watermark', () => insertText(true))),
                        actions(button('Edit selected text', editSelectedText, disabled || selection?.type !== 'i-text'),
                            button('Update text', () => run('Updating text...', async () => {
                                selection.set('text', settings.text); selection.setCoords(); c.renderAll(); commit();
                            }), disabled || selection?.type !== 'i-text')),
                        button('Apply style to selection', () => run('Updating layer style...', async () => {
                            const opacity = numericSetting('opacity', 'Opacity', 1, 100) / 100;
                            const fontSize = numericSetting('fontSize', 'Font size', 1, 2000);
                            const strokeWidth = numericSetting('stroke', 'Stroke width', 1, 200);
                            c.getActiveObjects().forEach(object => {
                                object.set({ opacity });
                                if (object.type === 'i-text') object.set({ ...textStyle(), fill: settings.color, fontSize });
                                else object.set({ stroke: settings.color, strokeWidth });
                                object.setCoords();
                            }); c.renderAll(); commit();
                        }), disabled || !selection),
                        field('Stroke width (px)', 'stroke', 'number', { min: 1, max: 200 }),
                        h('div', { className: 'image-actions image-annotation-tools', role: 'toolbar', 'aria-label': 'Annotation tools' },
                        button('Rectangle', () => insertShape(false)), button('Ellipse', () => insertShape(true)),
                        button('Draw', () => run('Setting drawing tool...', async () => {
                            const width = numericSetting('stroke', 'Stroke width', 1, 200);
                            setCrop(null); c.isDrawingMode = !c.isDrawingMode; c.freeDrawingBrush.color = settings.color;
                            c.freeDrawingBrush.width = width; setRevision(previous => previous + 1);
                        })), button('Select', () => { c.isDrawingMode = false; setRevision(previous => previous + 1); }),
                        button('Insert image overlay', () => overlayInput.current.click()),
                        button('Delete', removeSelection, disabled || !selection), button('Duplicate', () => run('Duplicating layer...', async () => {
                            const object = c.getActiveObject(); if (!object) return;
                            await new Promise(resolve => object.clone(clone => {
                                clone.set({ left: object.left + 20, top: object.top + 20, replacementMask: undefined, replacementTarget: undefined });
                                addObject(clone); resolve();
                            }));
                        }), disabled || !selection)),
                        h('h4', null, 'Layers'), [...(c?.getObjects() || [])].filter(object => object.selectable !== false || object.isEditing).reverse().map((object, index) => h('div', { className: 'image-layer', key: index },
                            button(object.text || object.type, () => { c.isDrawingMode = false; c.setActiveObject(object); c.renderAll(); setRevision(previous => previous + 1); }),
                            button('Up', () => { c.bringForward(object); c.renderAll(); commit(); }), button('Down', () => { c.sendBackwards(object); c.renderAll(); commit(); })))),
                    tab === 'collage' && h(React.Fragment, null,
                        row(field('Columns', 'columns', 'number', { min: 1, max: 8 }), field('Gap (px)', 'gap', 'number', { min: 0, max: 500 })),
                        row(field('Cell width (px)', 'cellWidth', 'number', { min: 1 }), field('Cell height (px)', 'cellHeight', 'number', { min: 1 })),
                        field('Transparent gaps', 'transparent', 'checkbox'), field('Gap background', 'background', 'color'),
                        button('Create collage', collage, disabled || items.length < 2),
                        actions(button('Move image earlier', () => run('Reordering...', async () => {
                            const values = [...docs.current.entries()], index = values.findIndex(([id]) => id === active);
                            if (index > 0) { [values[index - 1], values[index]] = [values[index], values[index - 1]]; docs.current = new Map(values); refreshItems(); }
                        }), disabled || items[0]?.id === active), button('Move image later', () => run('Reordering...', async () => {
                            const values = [...docs.current.entries()], index = values.findIndex(([id]) => id === active);
                            if (index < values.length - 1) { [values[index + 1], values[index]] = [values[index], values[index + 1]]; docs.current = new Map(values); refreshItems(); }
                        }), disabled || items[items.length - 1]?.id === active)),
                        button('Remove current image', () => run('Removing image...', async () => {
                            if (!window.confirm('Remove this image and its edits?')) return;
                            docs.current.delete(active); current.current = null; setActive(null); refreshItems();
                            if (docs.current.size) await choose(docs.current.keys().next().value);
                            else { c.clear(); setSize({ width: 1, height: 1 }); }
                            dirty.current = true;
                        }))),
                    tab === 'export' && h(React.Fragment, null,
                        select('Format', 'format', [['png', 'PNG'], ['jpg', 'JPG'], ['jpeg', 'JPEG'], ['webp', 'WebP']]),
                        field('Auto optimize to size', 'autoSize', 'checkbox'),
                        !automaticExport && settings.format === 'png' && field('Lossless - preserve every pixel', 'lossless', 'checkbox'),
                        settings.autoSize && h('span', { className: 'image-hint' }, 'Keeps your selected format. Smaller dimensions only when needed to meet your limit.'),
                        !automaticExport && settings.format !== 'png' && field('Encoder quality (%)', 'quality', 'range', { min: 10, max: 100 }),
                        field('Export density (DPI)', 'dpi', 'number', { min: 1, max: 2400 }),
                        ['jpg', 'jpeg'].includes(settings.format) && field('JPEG transparency fill', 'background', 'color'),
                        h('h4', null, 'Compress below a size limit'),
                        row(field('Limit (optional)', 'limit', 'number', { min: 0, placeholder: 'No limit' }), select('Unit', 'unit', [['bytes', 'Bytes'], ['KB', 'KB (1,000 bytes)'], ['MB', 'MB (1,000,000 bytes)']])),
                        !automaticExport && settings.format !== 'png' && field('Minimum encoder quality (%)', 'minQuality', 'range', { min: 10, max: 100 }),
                        !automaticExport && (settings.format !== 'png' || !settings.lossless) && field('Allow smaller pixel dimensions', 'allowResize', 'checkbox'),
                        actions(button('Download image', () => exportImage()), button('Download all', () => exportImage(true))),
                        h('label', { className: 'image-field image-check' }, 'Remove EXIF',
                            h('input', { type: 'checkbox', checked: true, disabled: true })),
                        h('h4', null, 'Images to PDF'), button('Download PDF', exportPdf)))),
            h('div', { className: 'image-status' },
                h('span', { className: 'image-title', title: value?.name }, value ? value.name + ' | ' + size.width + ' x ' + size.height + ' px' : ''),
                h('span', { role: 'status', 'aria-live': 'polite' }, busy || note)));
    };
})();
