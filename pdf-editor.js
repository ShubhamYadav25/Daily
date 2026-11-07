(function () {
    'use strict';

    const dependencies = {};
    const editorScriptUrl = typeof document === 'undefined' ? '' : document.currentScript?.src;
    function unlockPdf(bytes, password) {
        return new Promise((resolve, reject) => {
            const workerUrl = new URL('pdf-unlock-worker.js', editorScriptUrl || window.location.href);
            if (!['http:', 'https:'].includes(workerUrl.protocol)) {
                reject(new Error('Open Daily through an HTTP(S) web server to unlock PDFs.'));
                return;
            }
            const worker = new Worker(workerUrl, { type: 'module' });
            const timeout = setTimeout(() => finish(new Error('PDF unlocking timed out. Retry with a smaller document.')), 120000);
            function finish(error, result) {
                clearTimeout(timeout); worker.terminate();
                if (error) reject(error); else resolve(result);
            }
            worker.onerror = () => finish(new Error('Could not start the PDF unlock worker. Open Daily through a web server and retry.'));
            worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data);
            worker.postMessage({ bytes: bytes.slice(), password });
        });
    }
    function loadScript(name, url) {
        if (window[name]) return Promise.resolve(window[name]);
        if (!dependencies[name]) dependencies[name] = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = url;
            script.onload = () => window[name] ? resolve(window[name]) : reject(new Error(name + ' could not initialize.'));
            script.onerror = () => reject(new Error('Could not load ' + name + '. Check your connection and retry.'));
            document.head.appendChild(script);
        }).catch(error => { delete dependencies[name]; throw error; });
        return dependencies[name];
    }

    async function loadCore() {
        await Promise.all([
            loadScript('pdfjsLib', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'),
            loadScript('PDFLib', 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js'),
            loadScript('fabric', 'https://cdnjs.cloudflare.com/ajax/libs/fabric.js/5.3.1/fabric.min.js')
        ]);
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        patchFabricText();
    }

    const OBJECT_PROPS = ['replacementMask', 'name', 'sourceFontKey', 'sourceFontLabel', 'sourceFontExact', 'sourceFontMethod', 'annotationKind',
        'paragraphSpacing', 'selectable', 'evented', 'tableRows', 'tableCols', 'cellWidth', 'cellHeight', 'lockMovementX', 'lockMovementY', 'markdownImage', 'markdownHeading'];

    const STAR_PATH = 'M' + Array.from({ length: 10 }, (_, index) => {
        const radius = index % 2 ? 21 : 50, angle = (index * 36 - 90) * Math.PI / 180;
        return (50 + radius * Math.cos(angle)).toFixed(1) + ' ' + (53 + radius * Math.sin(angle)).toFixed(1);
    }).join('L') + 'Z';
    const SHAPES = [
        ['Rectangle', 'M0 0H100V100H0Z'], ['Rounded rectangle', 'M14 0H86Q100 0 100 14V86Q100 100 86 100H14Q0 100 0 86V14Q0 0 14 0Z'],
        ['Ellipse', 'M0 50A50 50 0 1 0 100 50A50 50 0 1 0 0 50Z'], ['Triangle', 'M50 0L100 100H0Z'], ['Right triangle', 'M0 0V100H100Z'],
        ['Diamond', 'M50 0L100 50L50 100L0 50Z'], ['Pentagon', 'M50 0L100 38L81 100H19L0 38Z'], ['Hexagon', 'M25 0H75L100 50L75 100H25L0 50Z'],
        ['Star', STAR_PATH], ['Speech bubble', 'M0 0H100V70H45L22 96L28 70H0Z'], ['Block arrow', 'M0 30H58V4L100 50L58 96V70H0Z'],
        ['Chevron', 'M0 0H62L100 50L62 100H0L38 50Z'], ['Plus', 'M35 0H65V35H100V65H65V100H35V65H0V35H35Z'], ['Line', 'M0 50H100', true],
        ['Arrow', 'M0 50H96M78 33L97 50L78 67', true], ['Double arrow', 'M4 50H96M21 33L3 50L21 67M79 33L97 50L79 67', true],
        ['Check mark', 'M4 54L36 86L96 14', true], ['Cross', 'M10 10L90 90M90 10L10 90', true]
    ];
    const HIGHLIGHT_COLORS = [['#ffe34a', 'Yellow'], ['#9cc4ff', 'Sky blue'], ['#ffb3d1', 'Pink'], ['#d1d5db', 'Gray']];
    const NOTE_COLORS = [['#dbe8ff', 'Sky blue'], ['#ffffff', 'White'], ['#fff3a1', 'Yellow'], ['#e5e7eb', 'Gray']];

    function paragraphGap(object, index) {
        return object.paragraphSpacing && index > 0 && object.isEndOfWrapping(index - 1) ? object.paragraphSpacing : 0;
    }

    function textBaseline(object, index, lineTop) {
        const gap = paragraphGap(object, index);
        return lineTop + gap + (object.getHeightOfLine(index) - gap) / object.lineHeight * (1 - object._fontSizeFraction);
    }

    let fabricPatched = false;
    function patchFabricText() {
        if (fabricPatched) return;
        fabricPatched = true;
        const text = fabric.Text.prototype;
        new Set([text._dimensionAffectingProps, fabric.IText.prototype._dimensionAffectingProps, fabric.Textbox.prototype._dimensionAffectingProps])
            .forEach(list => list.push('paragraphSpacing'));
        new Set([text, fabric.IText.prototype, fabric.Textbox.prototype]).forEach(prototype => {
            prototype.cacheProperties = prototype.cacheProperties.concat('paragraphSpacing');
        });
        const baseHeight = text.getHeightOfLine;
        text.getHeightOfLine = function (index) { return baseHeight.call(this, index) + paragraphGap(this, index); };
        text._renderTextCommon = function (ctx, method) {
            ctx.save();
            let lineTop = this._getTopOffset();
            const left = this._getLeftOffset();
            for (let index = 0; index < this._textLines.length; index++) {
                const height = this.getHeightOfLine(index), gap = paragraphGap(this, index);
                // _renderChars subtracts the full line height fraction, so the gap share is added back here.
                const baseline = lineTop + (height - gap) / this.lineHeight + gap + gap * this._fontSizeFraction / this.lineHeight;
                this._renderTextLine(method, ctx, this._textLines[index], left + this._getLineLeftOffset(index), baseline, index);
                lineTop += height;
            }
            ctx.restore();
        };
        const baseDecoration = text._renderTextDecoration;
        text._renderTextDecoration = function (ctx, type) {
            if (!this.paragraphSpacing || !this[type]) return baseDecoration.call(this, ctx, type);
            let lineTop = this._getTopOffset();
            ctx.fillStyle = this.fill;
            for (let index = 0; index < this._textLines.length; index++) {
                const y = textBaseline(this, index, lineTop) + this.offsets[type] * this.fontSize;
                ctx.fillRect(this._getLeftOffset() + this._getLineLeftOffset(index), y, this.getLineWidth(index), this.fontSize / 15);
                lineTop += this.getHeightOfLine(index);
            }
        };
    }

    const LIST_KINDS = {
        bullet: ['Bullet •', index => '•'], dash: ['Dash -', () => '-'], endash: ['En dash –', () => '–'],
        equals: ['Equals =', () => '='], arrow: ['Arrow →', () => '→'], asterisk: ['Asterisk *', () => '*'],
        check: ['Checkbox ☐', () => '☐'], number: ['Numbers 1.', index => index + '.'], paren: ['Numbers 1)', index => index + ')'],
        alpha: ['Letters a.', index => alphaMarker(index) + '.'], roman: ['Roman i.', index => romanMarker(index) + '.']
    };
    const MARKER_PATTERN = /^(\s*)(?:[•\-–=→*☐☑]|\d+[.)]|[a-z]{1,3}[.)]|[ivxlcdm]+[.)])\s+/i;
    const KIND_PATTERNS = {
        number: /^\s*\d+\.\s/, paren: /^\s*\d+\)\s/, alpha: /^\s*[a-z]{1,3}\.\s/, roman: /^\s*[ivxlcdm]+\.\s/i
    };

    function alphaMarker(index) {
        let value = '';
        for (let number = index; number > 0; number = Math.floor((number - 1) / 26)) value = String.fromCharCode(97 + (number - 1) % 26) + value;
        return value;
    }

    function romanMarker(index) {
        const table = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
        let value = '';
        for (const [amount, numeral] of table) while (index >= amount) { value += numeral; index -= amount; }
        return value;
    }

    function applyListMarkers(lines, kind) {
        const stripped = lines.map(line => line.replace(MARKER_PATTERN, '$1'));
        if (kind === 'none') return stripped;
        const pattern = KIND_PATTERNS[kind] || new RegExp('^\\s*' + LIST_KINDS[kind][1](1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s');
        if (lines.every(line => !line.trim() || pattern.test(line))) return stripped;
        const counters = [];
        return stripped.map(line => {
            if (!line.trim()) return line;
            const indent = line.match(/^\s*/)[0];
            counters.length = indent.length + 1;
            counters[indent.length] = (counters[indent.length] || 0) + 1;
            return indent + LIST_KINDS[kind][1](counters[indent.length]) + ' ' + line.slice(indent.length);
        });
    }

    function indentLines(lines, direction) {
        return lines.map(line => direction > 0 ? '    ' + line : line.replace(/^(\t| {1,4})/, ''));
    }

    function signatureFields(pdf) {
        const form = pdf.getForm();
        const pages = pdf.getPages();
        return form.getFields().filter(field => field instanceof PDFLib.PDFSignature).map(field => ({
            name: field.getName(), field, signed: !!field.acroField.dict.lookup(PDFLib.PDFName.of('V')),
            widgets: field.acroField.getWidgets().map(widget => {
                let pageIndex = -1;
                try { pageIndex = pages.indexOf(form.findWidgetPage(widget)); } catch { }
                return { pageIndex, rect: widget.getRectangle() };
            })
        }));
    }

    let pkiModule = null;
    function loadPki() {
        pkiModule = pkiModule || import('https://esm.sh/pkijs@3.2.4?bundle').catch(() => {
            pkiModule = null;
            throw new Error('Could not load the signature verifier. Check your connection and retry.');
        });
        return pkiModule;
    }

    function derBytes(bytes) {
        if (bytes[0] !== 0x30) throw new Error('Signature contents are not a CMS signature.');
        if (bytes[1] < 0x80) return bytes.subarray(0, 2 + bytes[1]);
        const size = bytes[1] & 0x7f;
        if (!size) return bytes;
        let length = 0;
        for (let index = 0; index < size; index++) length = length * 256 + bytes[2 + index];
        return bytes.subarray(0, 2 + size + length);
    }

    function pdfDate(value) {
        const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/.exec(value || '');
        if (!match) return null;
        const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00', zone, zoneHour = '00', zoneMinute = '00'] = match;
        const suffix = !zone || zone === 'Z' ? 'Z' : zone + zoneHour + ':' + zoneMinute;
        const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${suffix}`);
        return isNaN(date) ? null : date;
    }

    function distinguishedName(names) {
        const value = type => names.typesAndValues.find(item => item.type === type)?.value.valueBlock.value;
        return value('2.5.4.3') || value('2.5.4.10') || names.typesAndValues.map(item => item.value.valueBlock.value).join(', ');
    }

    function signatureOutcome(result) {
        if (!result.integrity) return { status: 'invalid', message: 'The signature does not match the signed content.' };
        if (!result.coversWholeFile) return { status: 'modified', message: 'The signed revision is intact, but changes were added after signing.' };
        if (result.certificateValidAtSigning === false) return { status: 'invalid', message: 'The claimed signing date is outside the signer certificate validity period.' };
        if (result.revoked) return { status: 'invalid', message: 'A certificate in the signing chain has been revoked.' };
        if (!result.chainTrusted) return { status: 'unknown', message: 'Signed bytes are intact. Signer identity is not trusted: ' + result.chainMessage };
        if (!result.revocationChecked) return { status: 'unknown', message: 'Signed bytes and certificate trust passed, but revocation could not be confirmed: ' + result.revocationMessage };
        return { status: 'valid', message: 'Signature, whole-file coverage, certificate trust and revocation checks passed.' };
    }

    async function readTrustFile(file, kind) {
        const pki = await loadPki();
        const raw = new Uint8Array(await file.arrayBuffer());
        const text = new TextDecoder().decode(raw);
        const label = kind === 'crl' ? 'X509 CRL' : 'CERTIFICATE';
        const blocks = [...text.matchAll(new RegExp('-----BEGIN ' + label + '-----([\\s\\S]*?)-----END ' + label + '-----', 'g'))];
        const buffers = blocks.length ? blocks.map(match => Uint8Array.from(atob(match[1].replace(/\s/g, '')), char => char.charCodeAt(0))) : [raw];
        return Promise.all(buffers.map(async bytes => {
            const value = kind === 'crl' ? pki.CertificateRevocationList.fromBER(bytes.slice().buffer) : pki.Certificate.fromBER(bytes.slice().buffer);
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
            return { value, fingerprint: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join(':'),
                name: distinguishedName(kind === 'crl' ? value.issuer : value.subject) };
        }));
    }

    async function verifyCertificateTrust(pki, signed, certificate, trust) {
        if (!certificate) return { chainTrusted: false, chainMessage: 'Signer certificate is missing.', revocationChecked: false };
        if (!trust.certificates.length) return { chainTrusted: false, chainMessage: 'No independently trusted certificates have been imported.', revocationChecked: false };
        const certs = (signed.certificates || []).filter(item => item instanceof pki.Certificate && item !== certificate).concat(certificate);
        const now = new Date();
        const makeEngine = crls => new pki.CertificateChainValidationEngine({
            trustedCerts: trust.certificates.map(item => item.value), certs,
            crls, checkDate: now
        });
        const chain = await makeEngine([]).verify({ passedWhenNotRevValues: true });
        if (!chain.result) return { chainTrusted: false, chainMessage: chain.resultMessage, revocationChecked: false };
        // Directly trusting the signer does not prove that its certificate was not revoked.
        if (!trust.crls.length || !chain.certificatePath || chain.certificatePath.length < 2) {
            return { chainTrusted: true, chainMessage: 'Certificate chain reaches a manually trusted certificate.',
                revocationChecked: false, revocationMessage: 'Import current issuer CRLs and trust an issuer/root rather than the signer.' };
        }
        const currentCrls = trust.crls.map(item => item.value).filter(crl => crl.thisUpdate.value <= now
            && crl.nextUpdate?.value > now
            && !(crl.crlExtensions?.extensions || []).some(extension => ['2.5.29.27', '2.5.29.28'].includes(extension.extnID)));
        if (!currentCrls.length) return { chainTrusted: true, chainMessage: 'Certificate chain reaches a manually trusted certificate.',
            revocationChecked: false, revocationMessage: 'No current, complete issuer CRLs with a next-update date were imported.' };
        const revocation = await makeEngine(currentCrls).verify({ passedWhenNotRevValues: false });
        return { chainTrusted: true, chainMessage: 'Certificate chain reaches a manually trusted certificate.',
            revocationChecked: revocation.result, revoked: revocation.resultCode === 12, revocationMessage: revocation.resultMessage,
            certificateChain: chain.certificatePath.map(item => distinguishedName(item.subject)) };
    }

    async function verifySignature(bytes, entry, trust = { certificates: [], crls: [] }) {
        const dictionary = entry.field.acroField.dict.lookupMaybe(PDFLib.PDFName.of('V'), PDFLib.PDFDict);
        if (!dictionary) return { name: entry.name, status: 'unsigned', message: 'This signature field has not been signed.' };
        const read = key => {
            const value = dictionary.lookup(PDFLib.PDFName.of(key));
            return value?.decodeText ? value.decodeText() : undefined;
        };
        const subFilter = read('SubFilter') || '';
        const details = { name: entry.name, subFilter, reason: read('Reason'), location: read('Location'),
            claimedSigner: read('Name'), signedAt: pdfDate(read('M')) };
        const range = dictionary.lookupMaybe(PDFLib.PDFName.of('ByteRange'), PDFLib.PDFArray)?.asArray().map(item => item.asNumber?.());
        const contents = dictionary.lookup(PDFLib.PDFName.of('Contents'));
        if (!range || range.length !== 4 || !contents?.asBytes) return { ...details, status: 'invalid', message: 'The signature has no valid byte range or contents.' };
        const [first, firstLength, second, secondLength] = range;
        if (!range.every(Number.isSafeInteger) || secondLength < 0 || first !== 0 || firstLength < 1 || second <= firstLength || second + secondLength > bytes.length
            || bytes[firstLength] !== 0x3c || bytes[second - 1] !== 0x3e) {
            return { ...details, status: 'invalid', message: 'The signed byte range does not match the signature contents in this file.' };
        }
        const excluded = new TextDecoder().decode(bytes.subarray(firstLength + 1, second - 1)).replace(/\s/g, '');
        const stored = contents.asBytes();
        if (!/^[0-9a-f]*$/i.test(excluded) || excluded.length !== stored.length * 2
            || stored.some((value, index) => value !== parseInt(excluded.slice(index * 2, index * 2 + 2), 16))) {
            return { ...details, status: 'invalid', message: 'The excluded byte range is not exactly this signature contents value.' };
        }
        if (!/^(adbe\.pkcs7\.(detached|sha1)|ETSI\.CAdES\.detached)$/.test(subFilter)) {
            return { ...details, status: 'unsupported', message: 'Signature format ' + (subFilter || 'unknown') + ' cannot be verified here.' };
        }
        const signedBytes = new Uint8Array(firstLength + secondLength);
        signedBytes.set(bytes.subarray(0, firstLength));
        signedBytes.set(bytes.subarray(second, second + secondLength), firstLength);
        const pki = await loadPki();
        let signed, verification;
        try {
            const der = derBytes(contents.asBytes());
            signed = new pki.SignedData({ schema: pki.ContentInfo.fromBER(der.slice().buffer).content });
            if (subFilter === 'adbe.pkcs7.sha1') {
                const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', signedBytes));
                const embedded = new Uint8Array(signed.encapContentInfo.eContent.getValue());
                if (digest.length !== embedded.length || digest.some((value, index) => value !== embedded[index])) {
                    return { ...details, status: 'invalid', message: 'The document hash does not match the signed hash. The document was altered.' };
                }
                verification = await signed.verify({ signer: 0, checkChain: false, extendedMode: true });
            } else {
                verification = await signed.verify({ signer: 0, data: signedBytes.buffer, checkChain: false, extendedMode: true });
            }
        } catch (failure) {
            const message = String(failure?.message || failure);
            return { ...details, status: 'invalid', message: /digest/i.test(message)
                ? 'The document was changed after it was signed: its hash no longer matches the signature.'
                : 'Verification failed: ' + message };
        }
        const signerInfo = signed.signerInfos[0];
        const certificate = verification.signerCertificate;
        const signingTime = signerInfo.signedAttrs?.attributes.find(item => item.type === '1.2.840.113549.1.9.5')?.values[0]?.toDate();
        const at = signingTime || details.signedAt;
        const result = { ...details, signedAt: at,
            signer: certificate ? distinguishedName(certificate.subject) : details.claimedSigner,
            issuer: certificate ? distinguishedName(certificate.issuer) : undefined,
            selfSigned: !!certificate && certificate.subject.isEqual(certificate.issuer),
            validFrom: certificate?.notBefore.value, validTo: certificate?.notAfter.value,
            certificateValidAtSigning: certificate && at ? at >= certificate.notBefore.value && at <= certificate.notAfter.value : undefined,
            timestamp: !!signerInfo.unsignedAttrs?.attributes.some(item => item.type === '1.2.840.113549.1.9.16.2.14'),
            integrity: !!verification.signatureVerified,
            coversWholeFile: second + secondLength === bytes.length };
        if (!verification.signatureVerified) return { ...result, status: 'invalid', message: verification.message || 'The signature does not match the signed content. The document was altered or the signature is corrupt.' };
        const trustResult = await verifyCertificateTrust(pki, signed, certificate, trust);
        return { ...result, ...trustResult, ...signatureOutcome({ ...result, ...trustResult }) };
    }

    function pagePlacement(width, height, rotation) {
        const angle = ((rotation % 360) + 360) % 360;
        return {
            width: angle % 180 ? height : width,
            height: angle % 180 ? width : height,
            x: angle === 180 ? width : angle === 270 ? height : 0,
            y: angle === 90 ? width : angle === 180 ? height : 0,
            angle: -angle
        };
    }

    function parsePages(value, count) {
        if (!value.trim()) return Array.from({ length: count }, (_, index) => index);
        const pages = [];
        for (const part of value.split(',')) {
            const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
            if (!match) throw new Error('Use page numbers or ranges, for example 1,3-5.');
            const first = Number(match[1]), last = Number(match[2] || match[1]);
            if (first < 1 || last > count || last < first) throw new Error('Page range is outside the document.');
            for (let number = first; number <= last; number++) if (!pages.includes(number - 1)) pages.push(number - 1);
        }
        return pages;
    }

    const FONT_CHOICES = [
        { family: 'Helvetica', label: 'Helvetica / Arial' },
        { family: 'Times New Roman', label: 'Times New Roman' },
        { family: 'Georgia', label: 'Georgia' },
        { family: 'Cambria', label: 'Cambria' },
        { family: 'Calibri', label: 'Calibri' },
        { family: 'Courier New', label: 'Courier New' },
        { family: 'Verdana', label: 'Verdana' },
        ...['Arial', 'Arial Black', 'Aptos', 'Segoe UI', 'Tahoma', 'Trebuchet MS', 'Century Gothic',
            'Gill Sans', 'Franklin Gothic Medium', 'Candara', 'Corbel', 'Palatino Linotype',
            'Book Antiqua', 'Garamond', 'Baskerville', 'Constantia', 'Century Schoolbook',
            'Consolas', 'Lucida Console', 'Lucida Sans Unicode', 'Impact', 'Comic Sans MS',
            'Brush Script MT', 'DM Sans', 'DM Mono'].map(family => ({ family, label: family }))
    ];

    function markdownBlocks(source, lexer, assets = {}) {
        if (!source.trim()) throw new Error('Write some Markdown before adding pages.');
        if (source.length > 100000) throw new Error('Markdown is limited to 100,000 characters per document.');
        const blocks = [];
        let decoder;
        const decode = value => value.replace(/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);/gi, entity => {
            decoder ||= document.createElement('textarea');
            decoder.innerHTML = entity;
            return decoder.value;
        });
        function inline(tokens, style = {}) {
            return (tokens || []).flatMap(token => {
                if (token.type === 'strong') return inline(token.tokens, { ...style, fontWeight: 'bold' });
                if (token.type === 'em') return inline(token.tokens, { ...style, fontStyle: 'italic' });
                if (token.type === 'del') return inline(token.tokens, { ...style, linethrough: true });
                if (token.type === 'codespan') return [{ text: token.text, style: { ...style, fontFamily: 'Courier New' } }];
                if (token.type === 'br') return [{ text: '\n', style }];
                if (token.type === 'image') {
                    if (!assets[token.href]) throw new Error('Image is not available in this session. Use the Image button to add a local image.');
                    return [{ text: '', style: {}, image: assets[token.href], href: token.href }];
                }
                if (token.tokens) return inline(token.tokens, token.type === 'link' ? { ...style, underline: true } : style);
                const text = token.text || token.raw || '';
                return [{ text: token.type === 'text' ? decode(text) : text, style }];
            });
        }
        function walk(tokens, indent = 0, prefix = '') {
            for (const token of tokens) {
                if (token.type === 'space' || token.type === 'def') continue;
                if (token.type === 'list') {
                    token.items.forEach((item, index) => {
                        const marker = item.task ? (item.checked ? '[x] ' : '[ ] ')
                            : token.ordered ? (Number(token.start) + index) + '. ' : '- ';
                        walk(item.tokens, indent + 16, marker);
                    });
                    continue;
                }
                if (token.type === 'blockquote') { walk(token.tokens, indent + 18, '> '); continue; }
                if (token.type === 'table') {
                    const row = cells => cells.map(cell => inline(cell.tokens).map(run => {
                        if (run.image) throw new Error('Place image references outside tables to include them in the PDF.');
                        return run.text;
                    }).join('')).join(' | ');
                    blocks.push({ runs: [{ text: [row(token.header), ...token.rows.map(row)].join('\n'), style: {} }],
                        fontFamily: 'Courier New', fontSize: 11, indent });
                    continue;
                }
                const heading = token.type === 'heading';
                const runs = token.type === 'code' ? [{ text: token.text, style: {} }]
                    : token.type === 'hr' ? [{ text: '________________________________________', style: {} }]
                        : inline(token.tokens || [{ text: token.text || token.raw }]);
                if (prefix) { runs.unshift({ text: prefix, style: {} }); prefix = ''; }
                let part = [];
                const textBlock = () => {
                    if (!part.length) return;
                    blocks.push({ runs: part, indent, fontFamily: token.type === 'code' ? 'Courier New' : 'Helvetica',
                        fontSize: heading ? [28, 23, 19, 16, 14, 13][token.depth - 1] : token.type === 'code' ? 11 : 12,
                        fontWeight: heading ? 'bold' : 'normal', heading: heading ? token.depth : 0 });
                    part = [];
                };
                runs.forEach(run => {
                    if (run.image) { textBlock(); blocks.push({ image: run.image, href: run.href }); }
                    else part.push(run);
                });
                textBlock();
            }
        }
        walk(lexer(source, { gfm: true }));
        return blocks;
    }

    function layoutMarkdown(blocks) {
        const output = [{ objects: [] }];
        let top = 48;
        const fixed = blocks.filter(block => block.image?.fixed).map(block => block.image);
        for (const block of blocks) {
            if (block.image) {
                const image = block.image;
                let object;
                if (image.fixed) {
                    object = { ...image.object };
                    output[0].objects.push({ ...object, markdownImage: block.href });
                } else {
                    const scale = Math.min(1, 499.28 / image.object.width, 700 / image.object.height);
                    const height = image.object.height * scale;
                    if (output.length === 1) {
                        for (const retained of fixed.slice().sort((a, b) => a.bottom - b.bottom)) {
                            if (top < retained.bottom && top + height > retained.top) top = retained.bottom + 10;
                        }
                    }
                    if (top + height > 793.89) { output.push({ objects: [] }); top = 48; }
                    if (output.length > 200) throw new Error('Markdown exceeds the 200-page limit.');
                    object = { ...image.object, left: 48, top, scaleX: scale, scaleY: scale, angle: 0 };
                    output[output.length - 1].objects.push({ ...object, markdownImage: block.href });
                    top += height + 10;
                }
                continue;
            }
            const indent = Math.min(180, block.indent);
            const text = block.runs.map(run => run.text).join('');
            const styles = {};
            let line = 0, column = 0;
            block.runs.forEach(run => Array.from(run.text).forEach(character => {
                if (character === '\n') { line++; column = 0; }
                else {
                    if (Object.keys(run.style).length) (styles[line] ||= {})[column] = run.style;
                    column++;
                }
            }));
            const box = new fabric.Textbox(text, { width: 499.28 - indent, fontSize: block.fontSize,
                fontFamily: block.fontFamily, fontWeight: block.fontWeight || 'normal', lineHeight: 1.35,
                fill: '#17212b', styles });
            if (box._textLines.some((characters, index) => box.getLineWidth(index) > box.width)) {
                box.set('splitByGrapheme', true); box.initDimensions();
            }
            box._textLines.forEach((characters, index) => {
                const height = box.getHeightOfLine(index);
                if (output.length === 1) {
                    for (const image of fixed.slice().sort((a, b) => a.bottom - b.bottom)) {
                        if (top < image.bottom && top + height > image.top) top = image.bottom + 10;
                    }
                }
                if (top + height > 793.89) {
                    if (output.length >= 200) throw new Error('Markdown exceeds the 200-page limit.');
                    output.push({ objects: [] }); top = 48;
                }
                const map = box._styleMap[index];
                const lineStyles = {};
                characters.forEach((character, offset) => {
                    const style = styles[map.line]?.[map.offset + offset];
                    if (style) lineStyles[offset] = style;
                });
                const object = new fabric.Textbox(characters.join(''), {
                    left: 48 + indent, top, width: Math.max(box.width, box.getLineWidth(index) + 2),
                    fontFamily: block.fontFamily, fontSize: block.fontSize, fontWeight: block.fontWeight || 'normal',
                    lineHeight: 1.35, fill: '#17212b', styles: Object.keys(lineStyles).length ? { 0: lineStyles } : {},
                    markdownHeading: block.heading || 0,
                    name: 'markdown-' + output.length + '-' + output[output.length - 1].objects.length
                });
                output[output.length - 1].objects.push(object.toObject(OBJECT_PROPS));
                top += height;
            });
            top += 10;
        }
        return output;
    }

    function escapeMarkdown(text) {
        return text.replace(/\\/g, '\\\\').replace(/([`*_[\]<>#|])/g, '\\$1');
    }

    function pageMarkdown(objects, assets) {
        let previous;
        return objects.slice().sort((a, b) => a.top - b.top || a.left - b.left).flatMap(object => {
            const adjacent = previous && object.type !== 'image' && previous.type !== 'image'
                && Math.abs(object.left - previous.left) < 2
                && object.fontSize === previous.fontSize
                && object.top - previous.top <= (previous.fontSize || 12) * (previous.lineHeight || 1.35) * 1.14 + 1;
            const separator = previous ? adjacent ? '\n' : '\n\n' : '';
            if (object.type === 'image') {
                const href = 'pdf-image:' + crypto.randomUUID();
                const image = new fabric.Rect({ left: object.left, top: object.top, width: object.width, height: object.height,
                    scaleX: object.scaleX || 1, scaleY: object.scaleY || 1, angle: object.angle || 0,
                    skewX: object.skewX || 0, skewY: object.skewY || 0, originX: object.originX || 'left', originY: object.originY || 'top', strokeWidth: 0 });
                const bounds = image.getBoundingRect(true, true);
                assets[href] = { object, fixed: true, top: bounds.top, bottom: bounds.top + bounds.height };
                previous = object;
                return [separator + '![Page image](' + href + ')'];
            }
            if (!['textbox', 'i-text', 'text'].includes(object.type) || !object.text?.trim()) return [];
            let offset = 0;
            let value = object.text.split('\n').map((line, lineIndex) => {
                const runs = [];
                Array.from(line).forEach((character, characterIndex) => {
                    const style = Array.isArray(object.styles)
                        ? object.styles.find(run => offset >= run.start && offset < run.end)?.style || {}
                        : object.styles?.[lineIndex]?.[characterIndex] || {};
                    offset++;
                    const key = JSON.stringify(style);
                    if (runs[runs.length - 1]?.key === key) runs[runs.length - 1].text += character;
                    else runs.push({ key, text: character, style });
                });
                return runs.map(run => {
                    let text = escapeMarkdown(run.text);
                    if (run.style.fontWeight === 'bold') text = '**' + text + '**';
                    if (run.style.fontStyle === 'italic') text = '*' + text + '*';
                    if (run.style.linethrough) text = '~~' + text + '~~';
                    return text;
                }).join('');
            }).join('\n');
            if (object.markdownHeading) value = '#'.repeat(object.markdownHeading) + ' ' + value;
            else if (object.fontWeight === 'bold') value = '**' + value + '**';
            if (object.fontStyle === 'italic') value = '*' + value + '*';
            previous = object;
            return [separator + value];
        }).join('');
    }

    function layoutSource(blocks) {
        return blocks.map(block => `<!-- pdf-block:${block.id} -->\n${block.source}`).join('\n\n');
    }

    function parseLayoutSource(source, blocks) {
        const marker = /<!-- pdf-block:([a-z0-9-]+) -->\r?\n?/g;
        const matches = Array.from(source.matchAll(marker));
        if (matches.length !== blocks.length || source.slice(0, matches[0]?.index).trim()) {
            throw new Error('Keep each pdf-block marker. Edit the text inside its block; do not add or remove blocks in layout-preserving mode.');
        }
        return blocks.map((block, index) => {
            if (matches[index][1] !== block.id) throw new Error('Keep the pdf-block markers in their original order to preserve page positions.');
            return source.slice(matches[index].index + matches[index][0].length, matches[index + 1]?.index ?? source.length).trim();
        });
    }

    function replacementObjects(target, paper, fill) {
        const id = 'pdf-mask-' + crypto.randomUUID();
        const object = new fabric.IText(target.text, { left: target.x, top: target.y, angle: target.angle,
            fontSize: target.height, fontFamily: target.fontFamily, fontWeight: target.fontWeight, fontStyle: target.fontStyle,
            fill, objectCaching: false, replacementMask: id, sourceFontKey: target.sourceFontKey,
            sourceFontLabel: target.sourceFontLabel, sourceFontExact: target.sourceFontExact, sourceFontMethod: target.sourceFontMethod });
        if (target.width > 0 && object.width > 0) object.set('scaleX', target.width / object.width);
        const angle = target.angle * Math.PI / 180;
        const baseline = fabric.util.transformPoint(new fabric.Point(object._getLeftOffset(),
            object._getTopOffset() + object.getHeightOfLine(0) / object.lineHeight * (1 - object._fontSizeFraction)), object.calcTransformMatrix());
        object.set({ left: object.left + target.x - Math.sin(angle) * target.height - baseline.x,
            top: object.top + target.y + Math.cos(angle) * target.height - baseline.y });
        const mask = new fabric.Rect({ left: target.x, top: target.y, width: target.width + 2,
            height: target.height * 1.3, angle: target.angle, fill: paper, strokeWidth: 0,
            selectable: false, evented: false, name: id });
        return { object, mask };
    }

    function textPatchColors(target, background, width, height) {
        const patch = document.createElement('canvas');
        const scale = 3, angle = target.angle * Math.PI / 180;
        patch.width = Math.max(3, Math.ceil((target.width + 2) * scale));
        patch.height = Math.max(3, Math.ceil(target.height * 1.3 * scale));
        const context = patch.getContext('2d');
        context.scale(scale, scale); context.rotate(-angle); context.translate(-target.x, -target.y);
        context.drawImage(background, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, patch.width, patch.height).data;
        const edges = new Map(), colors = new Map();
        const keyAt = index => (pixels[index] << 16) | (pixels[index + 1] << 8) | pixels[index + 2];
        let edgeCount = 0;
        for (let y = 0; y < patch.height; y++) for (let x = 0; x < patch.width; x++) {
            const index = (y * patch.width + x) * 4;
            if (pixels[index + 3] < 250) throw new Error('This text block crosses the page edge. Edit it directly on the PDF instead.');
            const key = keyAt(index);
            colors.set(key, (colors.get(key) || 0) + 1);
            if (y < 2 || y >= patch.height - 2 || x < 2 || x >= patch.width - 2) {
                edges.set(key, (edges.get(key) || 0) + 1); edgeCount++;
            }
        }
        const backgroundColor = [...edges].sort((a, b) => b[1] - a[1])[0][0];
        const distance = (a, b) => Math.abs((a >> 16) - (b >> 16))
            + Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) + Math.abs((a & 255) - (b & 255));
        const matching = [...edges].reduce((sum, [key, count]) => sum + (distance(key, backgroundColor) < 30 ? count : 0), 0);
        if (matching / edgeCount < 0.9) {
            throw new Error('This text block has a complex background or touches other artwork. It cannot be covered safely; edit it directly on the PDF.');
        }
        const foregrounds = [...colors].filter(([key]) => distance(key, backgroundColor) > 90).sort((a, b) => b[1] - a[1]);
        if (!foregrounds.length) throw new Error('The original text color could not be detected safely for this block.');
        const foreground = foregrounds.filter(([, count]) => count >= foregrounds[0][1] * 0.1)
            .sort((a, b) => distance(b[0], backgroundColor) - distance(a[0], backgroundColor))[0][0];
        const channels = key => [(key >> 16) & 255, (key >> 8) & 255, key & 255];
        const paper = channels(backgroundColor), ink = channels(foreground);
        const vector = ink.map((value, index) => value - paper[index]);
        const magnitude = vector.reduce((sum, value) => sum + value * value, 0);
        const blendDistance = key => {
            const color = channels(key);
            const alpha = Math.max(0, Math.min(1, color.reduce((sum, value, index) =>
                sum + (value - paper[index]) * vector[index], 0) / magnitude));
            return color.reduce((sum, value, index) => sum + Math.abs(value - paper[index] - alpha * vector[index]), 0);
        };
        if (foregrounds.some(([key, count]) => count > foregrounds[0][1] * 0.2 && blendDistance(key) > 60)) {
            throw new Error('This text block contains multiple colors or artwork. Edit its individual text runs directly on the PDF.');
        }
        const hex = key => '#' + key.toString(16).padStart(6, '0');
        return { paper: hex(backgroundColor), fill: hex(foreground) };
    }

    async function layoutEdits(markdown, lexer) {
        const values = parseLayoutSource(markdown.source, markdown.blocks);
        const overlay = JSON.parse(JSON.stringify(markdown.originalOverlay));
        for (let index = 0; index < markdown.blocks.length; index++) {
            const block = markdown.blocks[index], value = values[index];
            if (value === block.source.trim()) continue;
            let runs = [];
            if (value) {
                if (/!\[[^\]]*\]\(/.test(value)) throw new Error('Images stay unchanged in layout-preserving mode. Use Annotate to add or remove image annotations.');
                const blocks = markdownBlocks(value, lexer);
                runs = blocks.flatMap((item, index) => {
                    if (item.image) throw new Error('Images stay unchanged in layout-preserving mode. Use Annotate to add or remove image annotations.');
                    return [...(index ? [{ text: '\n', style: {} }] : []), ...item.runs];
                });
            }
            const text = runs.map(run => run.text).join('');
            let object, mask, originalWidth, originalHeight, originalLines;
            if (block.target) {
                const pair = replacementObjects(block.target, '#ffffff', '#000000');
                object = pair.object; mask = pair.mask;
                originalWidth = Math.max(block.target.width, object.width);
                originalHeight = object.height; originalLines = object._textLines.length;
            } else {
                [object] = await new Promise(resolve => fabric.util.enlivenObjects([block.object], resolve));
                originalWidth = object.width; originalHeight = object.height; originalLines = object._textLines.length;
            }
            const styles = {};
            let line = 0, column = 0;
            runs.forEach(run => Array.from(run.text).forEach(character => {
                if (character === '\n') { line++; column = 0; }
                else {
                    if (Object.keys(run.style).length) (styles[line] ||= {})[column] = run.style;
                    column++;
                }
            }));
            const originalFont = markdown.fonts?.get(object.sourceFontKey);
            object.set({ text, styles, ...(originalFont ? sourceTextFont(originalFont, text) : {}) });
            object.initDimensions(); object.setCoords();
            if (object.width > originalWidth + 0.5 || object.height > originalHeight + 0.5 || object._textLines.length > originalLines) {
                throw new Error(`Block ${index + 1} overflows its original text area. Shorten the text or remove formatting. Apply is blocked; the PDF has not changed.`);
            }
            if (block.target) {
                const colors = textPatchColors(block.target, markdown.backgroundCanvas, markdown.width, markdown.height);
                object.set({ fill: colors.fill }); mask.set({ fill: colors.paper });
                overlay.objects.push(mask.toObject(OBJECT_PROPS));
                if (text) overlay.objects.push(object.toObject(OBJECT_PROPS));
            } else {
                const position = overlay.objects.findIndex(item => item.name === block.object.name);
                if (position < 0) throw new Error('This text annotation no longer exists. Reopen Markdown to edit the current page.');
                if (text) overlay.objects[position] = object.toObject(OBJECT_PROPS);
                else overlay.objects.splice(position, 1);
            }
        }
        return overlay;
    }

    async function pageImages(source, rotation) {
        const viewport = source.getViewport({ scale: 1, rotation });
        const operators = await source.getOperatorList();
        const images = [];
        const stack = [];
        let matrix = [1, 0, 0, 1, 0, 0];
        let clips = [];
        let path, point = [0, 0], start = [0, 0];
        const multiply = pdfjsLib.Util.transform;
        const ops = pdfjsLib.OPS;
        const transformPoint = (x, y) => pdfjsLib.Util.applyTransform([x, y], multiply(viewport.transform, matrix));
        function rectangle(target, x, y, width, height) {
            const corners = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]]
                .map(([px, py]) => transformPoint(px, py));
            target.moveTo(...corners[0]);
            corners.slice(1).forEach(corner => target.lineTo(...corner));
            target.closePath();
        }
        for (let index = 0; index < operators.fnArray.length; index++) {
            const op = operators.fnArray[index], args = operators.argsArray[index];
            if (op === ops.save) stack.push({ matrix: matrix.slice(), clips: clips.slice() });
            else if (op === ops.restore) ({ matrix, clips } = stack.pop() || { matrix: [1, 0, 0, 1, 0, 0], clips: [] });
            else if (op === ops.transform) matrix = multiply(matrix, args);
            else if (op === ops.constructPath) {
                path ||= new Path2D();
                let offset = 0;
                for (const command of args[0]) {
                    if (command === ops.rectangle) {
                        point = transformPoint(args[1][offset], args[1][offset + 1]); start = point;
                        rectangle(path, ...args[1].slice(offset, offset + 4)); offset += 4;
                    } else if (command === ops.moveTo || command === ops.lineTo) {
                        point = transformPoint(args[1][offset++], args[1][offset++]);
                        if (command === ops.moveTo) { path.moveTo(...point); start = point; }
                        else path.lineTo(...point);
                    } else if (command === ops.curveTo) {
                        const first = transformPoint(args[1][offset++], args[1][offset++]);
                        const second = transformPoint(args[1][offset++], args[1][offset++]);
                        point = transformPoint(args[1][offset++], args[1][offset++]);
                        path.bezierCurveTo(...first, ...second, ...point);
                    } else if (command === ops.curveTo2) {
                        const second = transformPoint(args[1][offset++], args[1][offset++]);
                        const end = transformPoint(args[1][offset++], args[1][offset++]);
                        path.bezierCurveTo(...point, ...second, ...end); point = end;
                    } else if (command === ops.curveTo3) {
                        const first = transformPoint(args[1][offset++], args[1][offset++]);
                        point = transformPoint(args[1][offset++], args[1][offset++]);
                        path.bezierCurveTo(...first, ...point, ...point);
                    } else if (command === ops.closePath) { path.closePath(); point = start; }
                    else throw new Error('This PDF uses an unsupported image clipping path. The original page has not been changed.');
                }
            } else if (op === ops.clip || op === ops.eoClip) {
                if (!path) throw new Error('The PDF image clipping path is missing. The original page has not been changed.');
                clips = clips.concat({ path: new Path2D(path), rule: op === ops.eoClip ? 'evenodd' : 'nonzero' });
            } else if ([ops.endPath, ops.stroke, ops.closeStroke, ops.fill, ops.eoFill, ops.fillStroke,
                ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke].includes(op)) path = null;
            else if (op === ops.paintFormXObjectBegin) {
                stack.push({ matrix: matrix.slice(), clips: clips.slice() });
                if (args[0]) matrix = multiply(matrix, args[0]);
                if (args[1]) {
                    const box = new Path2D(), [x1, y1, x2, y2] = args[1];
                    rectangle(box, x1, y1, x2 - x1, y2 - y1);
                    clips = clips.concat({ path: box, rule: 'nonzero' });
                }
            } else if (op === ops.paintFormXObjectEnd) ({ matrix, clips } = stack.pop() || { matrix: [1, 0, 0, 1, 0, 0], clips: [] });
            else if (op === ops.paintImageXObject || op === ops.paintInlineImageXObject) {
                const image = op === ops.paintInlineImageXObject ? args[0]
                    : await new Promise(resolve => (args[0].startsWith('g_') ? source.commonObjs : source.objs).get(args[0], resolve));
                const raw = document.createElement('canvas');
                raw.width = image.width; raw.height = image.height;
                const context = raw.getContext('2d');
                if (image.bitmap) context.drawImage(image.bitmap, 0, 0);
                else {
                    const pixels = context.createImageData(image.width, image.height);
                    for (let pixel = 0; pixel < image.width * image.height; pixel++) {
                        const offset = pixel * 4;
                        if (image.kind === pdfjsLib.ImageKind.RGBA_32BPP) pixels.data.set(image.data.subarray(offset, offset + 4), offset);
                        else if (image.kind === pdfjsLib.ImageKind.RGB_24BPP) {
                            pixels.data.set(image.data.subarray(pixel * 3, pixel * 3 + 3), offset); pixels.data[offset + 3] = 255;
                        } else if (image.kind === pdfjsLib.ImageKind.GRAYSCALE_1BPP) {
                            const row = Math.floor(pixel / image.width), column = pixel % image.width;
                            const value = image.data[row * Math.ceil(image.width / 8) + (column >> 3)] & (128 >> (column % 8)) ? 255 : 0;
                            pixels.data.set([value, value, value, 255], offset);
                        } else throw new Error('This page contains an unsupported image format. The original page has not been changed.');
                    }
                    context.putImageData(pixels, 0, 0);
                }
                const transform = multiply(viewport.transform, matrix);
                const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(point => pdfjsLib.Util.applyTransform(point, transform));
                const left = Math.max(0, Math.min(...corners.map(point => point[0]))), top = Math.max(0, Math.min(...corners.map(point => point[1])));
                const width = Math.min(viewport.width, Math.max(...corners.map(point => point[0]))) - left;
                const height = Math.min(viewport.height, Math.max(...corners.map(point => point[1]))) - top;
                if (width < 0.1 || height < 0.1) continue;
                const rendered = document.createElement('canvas');
                const scale = Math.min(2, 4096 / Math.max(width, height));
                rendered.width = Math.max(1, Math.ceil(width * scale)); rendered.height = Math.max(1, Math.ceil(height * scale));
                const ctx = rendered.getContext('2d');
                ctx.scale(scale, scale); ctx.translate(-left, -top);
                clips.forEach(clip => ctx.clip(clip.path, clip.rule));
                ctx.transform(...transform);
                ctx.scale(1 / image.width, -1 / image.height); ctx.drawImage(raw, 0, -image.height);
                let output = rendered, cropX = 0, cropY = 0;
                if (clips.length) {
                    const pixels = ctx.getImageData(0, 0, rendered.width, rendered.height).data;
                    let minX = rendered.width, minY = rendered.height, maxX = -1, maxY = -1;
                    for (let y = 0; y < rendered.height; y++) for (let x = 0; x < rendered.width; x++) {
                        if (!pixels[(y * rendered.width + x) * 4 + 3]) continue;
                        minX = Math.min(minX, x); minY = Math.min(minY, y);
                        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
                    }
                    if (maxX < 0) continue;
                    output = document.createElement('canvas');
                    output.width = maxX - minX + 1; output.height = maxY - minY + 1;
                    output.getContext('2d').drawImage(rendered, minX, minY, output.width, output.height, 0, 0, output.width, output.height);
                    cropX = minX / scale; cropY = minY / scale;
                }
                const sx = 595.28 / viewport.width, sy = 841.89 / viewport.height;
                const placement = { left: (left + cropX) * sx, top: (top + cropY) * sy, scaleX: sx / scale, scaleY: sy / scale };
                images.push({ ...new fabric.Image(output, placement).toObject(OBJECT_PROPS), ...placement });
            } else if ([ops.paintImageMaskXObject, ops.paintImageMaskXObjectGroup, ops.paintImageXObjectRepeat,
                ops.paintImageMaskXObjectRepeat, ops.paintInlineImageXObjectGroup, ops.paintSolidColorImageMask].includes(op)) {
                throw new Error('This page uses grouped or masked images that cannot be converted safely. The original page has not been changed.');
            }
        }
        return images;
    }

    function sourceFontStyle(name, family) {
        const label = (name || family || 'Helvetica').replace(/^[A-Z]{6}\+/, '');
        const normalized = label.toLowerCase(), compact = normalized.replace(/[^a-z0-9]/g, '');
        const named = FONT_CHOICES.slice().sort((a, b) => b.family.length - a.family.length)
            .find(font => compact.startsWith(font.family.toLowerCase().replace(/[^a-z0-9]/g, '')));
        return { label, family: named?.family || (/times|serif/.test(normalized) && !/sans/.test(normalized) ? 'Times New Roman'
            : /courier|mono/.test(normalized) ? 'Courier New' : 'Helvetica'),
            namedFamily: !!named || /^(times|courier|helvetica)(?:-|$)/i.test(label),
            weight: /bold|black|heavy|demi|semibold/.test(normalized) ? 'bold' : 'normal',
            style: /italic|oblique/.test(normalized) ? 'italic' : 'normal' };
    }

    function sourceTextFont(original, text) {
        const characters = Array.from(text).filter(character => !/\s/.test(character));
        const hasGlyph = character => original.parsed.hasGlyphForCodePoint(character.codePointAt(0));
        const supported = original.parsed && characters.every(hasGlyph);
        if (supported && original.face) return { fontFamily: original.family, sourceFontExact: true, sourceFontMethod: 'embedded' };
        if (original.localFace) return { fontFamily: original.localFamily, sourceFontExact: true, sourceFontMethod: 'device' };
        if (original.face && original.parsed && characters.some(hasGlyph)) {
            return { fontFamily: original.family + ', "' + original.fallback + '"', sourceFontExact: false, sourceFontMethod: 'partial' };
        }
        return { fontFamily: original.fallback, sourceFontExact: false, sourceFontMethod: 'fallback' };
    }

    async function recoverSourceFont(pdf, pageNumber, sourceFont, detected) {
        const original = { parsed: null, fallback: detected.family, family: detected.family, face: null,
            fontWeight: detected.weight, fontStyle: detected.style, recoveryErrors: [] };
        const candidates = [];
        try {
            const embedded = embeddedFontBytes(pdf, pageNumber, sourceFont?.name);
            if (embedded) candidates.push(embedded);
        } catch (failure) { original.recoveryErrors.push('Embedded font: ' + failure.message); }
        if (sourceFont?.data) candidates.push(sourceFont.data);
        if (candidates.length) {
            let parser;
            try { parser = await loadScript('fontkit', 'https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js'); }
            catch (failure) { original.recoveryErrors.push(failure.message); }
            for (const bytes of parser ? candidates : []) {
                try {
                    const parsed = parser.create(bytes);
                    const variant = sourceFontStyle((sourceFont?.name || detected.label) + ' ' + parsed.subfamilyName, detected.family);
                    const family = 'DailyPdfOriginal-' + crypto.randomUUID();
                    const face = new FontFace(family, bytes, { weight: variant.weight, style: variant.style });
                    await face.load(); document.fonts.add(face);
                    Object.assign(original, { parsed, bytes, family, face, fontWeight: variant.weight, fontStyle: variant.style });
                    break;
                } catch (failure) { original.recoveryErrors.push('Font program: ' + failure.message); }
            }
        }
        const styledName = detected.family + (original.fontWeight === 'bold' ? ' Bold' : '') + (original.fontStyle === 'italic' ? ' Italic' : '');
        const names = [...new Set([original.parsed?.fullName, detected.label, detected.namedFamily ? styledName : null])]
            .filter(name => name && !/^(serif|sans-serif|monospace)$/i.test(name));
        for (const name of names) {
            try {
                const family = 'DailyPdfLocal-' + crypto.randomUUID();
                const face = new FontFace(family, 'local(' + JSON.stringify(name) + ')',
                    { weight: original.fontWeight, style: original.fontStyle });
                await face.load(); document.fonts.add(face);
                original.localFamily = family; original.localFace = face;
                break;
            } catch (failure) { original.recoveryErrors.push('Device font ' + name + ': ' + failure.message); }
        }
        return original;
    }

    function groupTextTargets(targets) {
        const lines = [];
        for (const target of targets) {
            const radians = target.angle * Math.PI / 180;
            const baselineX = target.x - Math.sin(radians) * target.height;
            const baselineY = target.y + Math.cos(radians) * target.height;
            const line = lines.slice().reverse().find(item => {
                if (Math.abs(item.angle - target.angle) > 0.2 || item.runs[item.runs.length - 1].hasEOL) return false;
                const dx = baselineX - item.baselineX, dy = baselineY - item.baselineY;
                const offset = dx * Math.cos(radians) + dy * Math.sin(radians);
                const gap = offset - item.width;
                return Math.abs(-dx * Math.sin(radians) + dy * Math.cos(radians)) <= Math.min(item.height, target.height) * 0.2
                    && Math.abs(item.height - target.height) <= Math.max(item.height, target.height) * 0.25
                    && gap >= -1 && gap <= Math.max(item.height, target.height) * 1.5;
            });
            if (!line) {
                lines.push({ ...target, baselineX, baselineY, runs: [target] });
                continue;
            }
            const offset = (baselineX - line.baselineX) * Math.cos(radians) + (baselineY - line.baselineY) * Math.sin(radians);
            const space = offset - line.width > target.height * 0.1 && !/\s$/.test(line.text) && !/^\s/.test(target.text) ? ' ' : '';
            line.text += space + target.text; line.width = offset + target.width;
            line.height = Math.max(line.height, target.height);
            line.x = line.baselineX + Math.sin(radians) * line.height;
            line.y = line.baselineY - Math.cos(radians) * line.height;
            line.runs.push(target);
        }
        return lines;
    }

    function embeddedFontBytes(pdf, pageNumber, fontName) {
        const visited = new Set();
        function find(resources) {
            if (!resources || visited.has(resources)) return null;
            visited.add(resources);
            const fonts = resources.lookupMaybe(PDFLib.PDFName.of('Font'), PDFLib.PDFDict);
            for (const [key, reference] of fonts?.entries() || []) {
                const font = pdf.context.lookup(reference, PDFLib.PDFDict);
                const base = font.get(PDFLib.PDFName.of('BaseFont'));
                if (base?.decodeText() !== fontName && key.decodeText() !== fontName) continue;
                const descendants = font.lookupMaybe(PDFLib.PDFName.of('DescendantFonts'), PDFLib.PDFArray);
                const definition = descendants ? descendants.lookup(0, PDFLib.PDFDict) : font;
                const descriptor = definition.lookupMaybe(PDFLib.PDFName.of('FontDescriptor'), PDFLib.PDFDict);
                if (!descriptor) continue;
                for (const name of ['FontFile2', 'FontFile3', 'FontFile']) {
                    const stream = descriptor.lookupMaybe(PDFLib.PDFName.of(name), PDFLib.PDFRawStream);
                    if (stream) return PDFLib.decodePDFRawStream(stream).decode();
                }
            }
            const objects = resources.lookupMaybe(PDFLib.PDFName.of('XObject'), PDFLib.PDFDict);
            for (const [, reference] of objects?.entries() || []) {
                const object = pdf.context.lookup(reference);
                if (!(object instanceof PDFLib.PDFRawStream)) continue;
                const found = find(object.dict.lookupMaybe(PDFLib.PDFName.of('Resources'), PDFLib.PDFDict));
                if (found) return found;
            }
            return null;
        }
        return find(pdf.getPage(pageNumber - 1).node.Resources());
    }

    function download(data, name, type = 'application/pdf') {
        const url = URL.createObjectURL(new Blob([data], { type }));
        const anchor = document.createElement('a');
        anchor.href = url; anchor.download = name; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function pdfFields(pdf) {
        return pdf.getForm().getFields().map(field => {
            const base = { name: field.getName(), readOnly: field.isReadOnly(), required: field.isRequired() };
            if (field instanceof PDFLib.PDFTextField) return { ...base, type: 'text', value: field.getText() || '',
                multiline: field.isMultiline(), maxLength: field.getMaxLength() };
            if (field instanceof PDFLib.PDFSignature) return { ...base, type: 'signature', value: '' };
            if (field instanceof PDFLib.PDFCheckBox) return { ...base, type: 'check', value: field.isChecked() };
            if (field instanceof PDFLib.PDFRadioGroup) return { ...base, type: 'radio', value: field.getSelected() || '', options: field.getOptions() };
            if (field instanceof PDFLib.PDFDropdown || field instanceof PDFLib.PDFOptionList) return {
                ...base, type: 'options', value: field.getSelected(), options: field.getOptions(), multiple: field.isMultiselect()
            };
            return { ...base, type: 'unsupported', value: '' };
        });
    }

    async function filledDocument(doc, customFont) {
        const result = await PDFLib.PDFDocument.load(await doc.pdf.save({ updateFieldAppearances: false }));
        if (!doc.fields.length) return result;
        const form = result.getForm();
        for (const field of form.getFields()) {
            if (!(field instanceof PDFLib.PDFSignature) || field.acroField.getWidgets().every(widget => widget.getAppearances()?.normal)) continue;
            // pdf-lib's removeField needs an appearance stream, so detach the widgets directly.
            const refs = field.acroField.normalizedEntries().Kids.asArray();
            result.getPages().forEach(page => refs.forEach(ref => page.node.removeAnnot(ref)));
            form.acroForm.removeField(field.acroField);
        }
        for (const definition of doc.fields) {
            if (definition.readOnly || definition.type === 'unsupported' || definition.type === 'signature') continue;
            const field = form.getField(definition.name);
            const value = doc.formValues[definition.name];
            if (definition.type === 'text') field.setText(value);
            else if (definition.type === 'check') value ? field.check() : field.uncheck();
            else if (definition.type === 'radio') value ? field.select(value) : field.clear();
            else if (definition.type === 'options') value.length ? field.select(value) : field.clear();
        }
        let font;
        if (customFont) {
            result.registerFontkit(window.fontkit);
            font = await result.embedFont(customFont.bytes);
        } else font = await result.embedFont(PDFLib.StandardFonts.Helvetica);
        form.updateFieldAppearances(font);
        form.flatten({ updateFieldAppearances: false });
        return result;
    }

    async function annotationFont(pdf, doc, object, customFont, cache) {
        const original = doc.fonts.get(object.sourceFontKey);
        const bytes = original?.family === object.fontFamily ? original.bytes
            : customFont?.family === object.fontFamily ? customFont.bytes : null;
        const bold = object.fontWeight === 'bold' || Number(object.fontWeight) >= 600;
        const italic = /italic|oblique/.test(object.fontStyle || '');
        const variant = original?.family === object.fontFamily ? original : customFont;
        if (bytes && ((variant.fontWeight === 'bold') !== bold || (variant.fontStyle === 'italic') !== italic)) return null;
        let standard;
        if (/^(Helvetica|Arial)$/i.test(object.fontFamily)) standard = bold ? (italic ? 'HelveticaBoldOblique' : 'HelveticaBold') : (italic ? 'HelveticaOblique' : 'Helvetica');
        else if (/^(Times New Roman|Times)$/i.test(object.fontFamily)) standard = bold ? (italic ? 'TimesRomanBoldItalic' : 'TimesRomanBold') : (italic ? 'TimesRomanItalic' : 'TimesRoman');
        else if (/^(Courier New|Courier)$/i.test(object.fontFamily)) standard = bold ? (italic ? 'CourierBoldOblique' : 'CourierBold') : (italic ? 'CourierOblique' : 'Courier');
        if (!bytes && !standard) return null;
        const key = bytes ? object.fontFamily : standard;
        if (!cache.has(key)) {
            if (bytes) pdf.registerFontkit(window.fontkit);
            cache.set(key, await pdf.embedFont(bytes || PDFLib.StandardFonts[standard]));
        }
        return cache.get(key);
    }

    async function drawAnnotationText(pdf, page, doc, object, customFont, cache) {
        if (!['i-text', 'textbox', 'text'].includes(object.type) || object.path || object.direction === 'rtl'
            || typeof object.fill !== 'string' || object.backgroundColor || object.shadow
            || (object.stroke && object.strokeWidth) || Object.keys(object.styles || {}).length) return false;
        let font;
        try {
            font = await annotationFont(pdf, doc, object, customFont, cache);
            if (!font) return false;
            object._textLines.forEach(line => line.forEach(character => font.encodeText(character)));
        } catch { return false; }
        const source = new fabric.Color(object.fill).getSource();
        const matrix = object.calcTransformMatrix();
        const fontKey = page.node.newFontDictionary('EditedText', font.ref);
        const opacityKey = page.node.newExtGState('EditedOpacity', pdf.context.register(pdf.context.obj({
            Type: 'ExtGState', ca: object.opacity * source[3], CA: object.opacity * source[3]
        })));
        const operators = [PDFLib.pushGraphicsState(), PDFLib.setGraphicsState(opacityKey),
            PDFLib.setFillingRgbColor(source[0] / 255, source[1] / 255, source[2] / 255)];
        let lineTop = object._getTopOffset();
        for (let lineIndex = 0; lineIndex < object._textLines.length; lineIndex++) {
            const line = object._textLines[lineIndex];
            const lineHeight = object.getHeightOfLine(lineIndex);
            const baseline = textBaseline(object, lineIndex, lineTop);
            const left = object._getLeftOffset() + object._getLineLeftOffset(lineIndex);
            line.forEach((character, characterIndex) => {
                const bounds = object.__charBounds[lineIndex][characterIndex];
                const localX = left + bounds.left + bounds.kernedWidth - bounds.width;
                const point = fabric.util.transformPoint(new fabric.Point(localX, baseline), matrix);
                operators.push(PDFLib.beginText(), PDFLib.setFontAndSize(fontKey, object.fontSize),
                    PDFLib.setTextMatrix(matrix[0], -matrix[1], -matrix[2], matrix[3], point.x, page.getHeight() - point.y),
                    PDFLib.showText(font.encodeText(character)), PDFLib.endText());
            });
            lineTop += lineHeight;
        }
        operators.push(PDFLib.popGraphicsState());
        page.pushOperators(...operators);
        for (const decoration of ['underline', 'linethrough', 'overline']) {
            if (!object[decoration]) continue;
            let top = object._getTopOffset();
            for (let lineIndex = 0; lineIndex < object._textLines.length; lineIndex++) {
                const height = object.getHeightOfLine(lineIndex);
                const left = object._getLeftOffset() + object._getLineLeftOffset(lineIndex);
                const baseline = textBaseline(object, lineIndex, top);
                const y = baseline + object.offsets[decoration] * object.fontSize;
                const width = object.getLineWidth(lineIndex);
                const points = [[left, y], [left + width, y], [left + width, y + object.fontSize / 15], [left, y + object.fontSize / 15]]
                    .map(([x, localY]) => fabric.util.transformPoint(new fabric.Point(x, localY), matrix));
                page.drawSvgPath('M ' + points.map(point => point.x + ' ' + point.y).join(' L ') + ' Z', {
                    x: 0, y: page.getHeight(), color: PDFLib.rgb(source[0] / 255, source[1] / 255, source[2] / 255), opacity: object.opacity * source[3]
                });
                top += height;
            }
        }
        return true;
    }

    function exportSize(value, unit) {
        if (!String(value).trim()) return null;
        const bytes = Number(value) * ({ bytes: 1, KB: 1000, MB: 1000000 })[unit];
        if (!Number.isSafeInteger(bytes) || bytes < 128 || bytes > 100000000) throw new Error('Choose a size limit between 128 bytes and 100 MB.');
        return bytes;
    }
    async function withRasterPages(bytes, scale, action) {
        const render = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
        try {
            for (let number = 1; number <= render.numPages; number++) {
                const source = await render.getPage(number), physical = source.getViewport({ scale: 1 });
                const actualScale = Math.min(scale, Math.sqrt(12000000 / (physical.width * physical.height)), 16384 / Math.max(physical.width, physical.height));
                const viewport = source.getViewport({ scale: actualScale }), sheet = document.createElement('canvas');
                sheet.width = Math.max(1, Math.floor(viewport.width)); sheet.height = Math.max(1, Math.floor(viewport.height));
                try {
                    await source.render({ canvasContext: sheet.getContext('2d'), viewport, intent: 'print', background: '#ffffff' }).promise;
                    await action(sheet, { width: physical.width, height: physical.height, dpi: Math.max(1, Math.round(actualScale * 72)) }, number);
                } finally { source.cleanup(); sheet.width = sheet.height = 1; }
            }
        } finally { await render.destroy(); }
    }
    async function rasterPdf(bytes, scale, quality) {
        const output = await PDFLib.PDFDocument.create();
        await withRasterPages(bytes, scale, async (sheet, physical) => {
            const blob = await new Promise((resolve, reject) => sheet.toBlob(value => value ? resolve(value) : reject(new Error('Could not encode PDF page.')), 'image/jpeg', quality));
            const image = await output.embedJpg(await blob.arrayBuffer()), page = output.addPage([physical.width, physical.height]);
            page.drawImage(image, { x: 0, y: 0, width: physical.width, height: physical.height });
        });
        return output.save();
    }
    async function compressPdf(bytes, target, progress, raster = rasterPdf) {
        exportSize(target, 'bytes');
        if (bytes.length <= target) return { bytes, rasterized: false };
        let scale = 2;
        for (let attempt = 0; attempt < 45; attempt++) {
            progress?.('Compressing PDF at ' + Math.round(scale * 72) + ' DPI...');
            const high = await raster(bytes, scale, .95);
            if (high.length <= target) return { bytes: high, rasterized: true, dpi: Math.round(scale * 72), quality: .95 };
            const low = await raster(bytes, scale, .75);
            if (low.length <= target) {
                let best = low, lower = .75, upper = .95;
                for (let step = 0; step < 8; step++) {
                    const quality = (lower + upper) / 2, candidate = await raster(bytes, scale, quality);
                    if (candidate.length <= target) { best = candidate; lower = quality; } else upper = quality;
                }
                return { bytes: best, rasterized: true, dpi: Math.round(scale * 72), quality: lower };
            }
            scale *= Math.min(.9, Math.max(.5, Math.sqrt(target / low.length) * .95));
            if (scale < .001) break;
        }
        throw new Error('This limit is too small for a valid PDF with these pages. Increase the size limit.');
    }

    window.DailyPdfTools = { exportSize, compressPdf, pagePlacement, parsePages, pdfFields, filledDocument, sourceFontStyle, sourceTextFont, recoverSourceFont, embeddedFontBytes, drawAnnotationText,
        groupTextTargets, applyListMarkers, indentLines, signatureFields, verifySignature, signatureOutcome, verifyCertificateTrust, readTrustFile, unlockPdf, FONT_CHOICES, markdownBlocks, layoutMarkdown, pageMarkdown, pageImages,
        layoutSource, parseLayoutSource, layoutEdits, textPatchColors, replacementObjects };

    window.DailyPdfEditor = function PdfEditor({ Panel, Icon, MdEditor, onClose }) {
        const { createElement: h, useState, useRef, useEffect } = React;
        const [ready, setReady] = useState(false);
        const [busy, setBusy] = useState('Loading PDF libraries...');
        const [error, setError] = useState('');
        const [manualReplacement, setManualReplacement] = useState(null);
        const [exportNote, setExportNote] = useState('');
        const [pages, setPages] = useState([]);
        const [active, setActive] = useState(0);
        const [zoom, setZoom] = useState(1);
        const [mode, setMode] = useState('select');
        const [color, setColor] = useState('#d12e49');
        const [fontSize, setFontSize] = useState(20);
        const [text, setText] = useState('');
        const [range, setRange] = useState('');
        const [name, setName] = useState('document');
        const [title, setTitle] = useState('');
        const [author, setAuthor] = useState('');
        const [dirty, setDirty] = useState(false);
        const [signature, setSignature] = useState(false);
        const [customFont, setCustomFont] = useState(null);
        const [selectionVersion, setSelectionVersion] = useState(0);
        const [mobile, setMobile] = useState(window.innerWidth <= 640);
        const [textTargets, setTextTargets] = useState([]);
        const [textScope, setTextScope] = useState('statement');
        const textScopeRef = useRef('statement');
        textScopeRef.current = textScope;
        const selectionTargets = textScope === 'statement' ? groupTextTargets(textTargets) : textTargets;
        const [paperColor, setPaperColor] = useState('#ffffff');
        const [fieldRevision, setFieldRevision] = useState(0);
        const [renderRevision, setRenderRevision] = useState(0);
        const [fontFamily, setFontFamily] = useState('Helvetica');
        const [fontWeight, setFontWeight] = useState('normal');
        const [fontStyle, setFontStyle] = useState('normal');
        const [toolsTab, setToolsTab] = useState('edit');
        const [inspectorTab, setInspectorTab] = useState('format');
        const [exportFormat, setExportFormat] = useState('pdf');
        const [exportLimit, setExportLimit] = useState('');
        const [exportUnit, setExportUnit] = useState('KB');
        const [stamp, setStamp] = useState('Reviewed');
        const [watermark, setWatermark] = useState('DRAFT');
        const [numberStart, setNumberStart] = useState(1);
        const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0][0]);
        const [tableHover, setTableHover] = useState({ rows: 0, cols: 0 });
        const [redactPattern, setRedactPattern] = useState('text');
        const [redactQuery, setRedactQuery] = useState('');
        const [watermarkStyle, setWatermarkStyle] = useState({ size: 48, opacity: 16, angle: -30, color: '#64748b', layout: 'center' });
        const [signatureResults, setSignatureResults] = useState({});
        const [activeSignature, setActiveSignature] = useState('');
        const [pageViewport, setPageViewport] = useState(null);
        const [mergeFiles, setMergeFiles] = useState(null);
        const [lockedPdf, setLockedPdf] = useState(null);
        const [pdfPassword, setPdfPassword] = useState('');
        const unlockRequest = useRef(null);
        const unlockRunning = useRef(false);
        const [trust, setTrust] = useState({ certificates: [], crls: [] });
        const trustCertificateInput = useRef();
        const trustCrlInput = useRef();
        const [markdown, setMarkdown] = useState(null);
        const [markdownPreview, setMarkdownPreview] = useState([]);
        const [markdownError, setMarkdownError] = useState('');
        const [markdownPreviewPage, setMarkdownPreviewPage] = useState(0);
        const markdownCanvas = useRef();
        const mergeInput = useRef();
        const markdownAssets = useRef({});
        const [workspaceBackground, setWorkspaceBackground] = useState(() => {
            try { return localStorage.getItem('daily_pdf_background') === 'black' ? 'black' : 'white'; }
            catch { return 'white'; }
        });
        const background = useRef();
        const overlay = useRef();
        const canvas = useRef();
        const stageHost = useRef();
        const signatureStage = useRef();
        const fileInput = useRef();
        const imageInput = useRef();
        const fontInput = useRef();
        const viewportRef = useRef();
        const editorRef = useRef();
        const pointerInside = useRef(false);
        const undoSelection = useRef(null);
        const modeRef = useRef(mode);
        modeRef.current = mode;
        const pendingCell = useRef(null);
        const docs = useRef([]);
        const currentPage = useRef();
        const histories = useRef(new Map());
        const restoring = useRef(false);
        const alive = useRef(true);
        const activeTasks = useRef(0);
        const page = pages[active];

        useEffect(() => { setManualReplacement(null); }, [page?.id, page?.rotation, zoom, renderRevision]);

        async function task(label, action) {
            activeTasks.current++;
            setBusy(label); setError(''); setManualReplacement(null);
            try { await action(); }
            catch (failure) { if (alive.current) setError(failure.message || String(failure)); }
            finally { if (--activeTasks.current === 0 && alive.current) setBusy(''); }
        }

        useEffect(() => {
            alive.current = true;
            task('Loading PDF libraries...', async () => { await loadCore(); if (alive.current) setReady(true); });
            return () => {
                alive.current = false;
                unlockRequest.current?.(null); unlockRequest.current = null;
                docs.current.forEach(doc => { doc.render.destroy(); doc.fonts.forEach(font => {
                    if (font.face) document.fonts.delete(font.face);
                    if (font.localFace) document.fonts.delete(font.localFace);
                }); });
            };
        }, []);

        useEffect(() => {
            const resize = () => setMobile(window.innerWidth <= 640);
            window.addEventListener('resize', resize);
            return () => window.removeEventListener('resize', resize);
        }, []);

        function capture() {
            if (!canvas.current || !currentPage.current || restoring.current) return;
            canvas.current.getActiveObjects().forEach(object => {
                const original = currentPage.current.doc.fonts.get(object.sourceFontKey);
                if (original) object.set(sourceTextFont(original, object.text));
            });
            const value = canvas.current.toJSON(OBJECT_PROPS);
            currentPage.current.overlay = value;
            const history = histories.current.get(currentPage.current.id) || { values: [{ objects: [] }], index: 0 };
            if (JSON.stringify(history.values[history.index]) !== JSON.stringify(value)) {
                history.values = history.values.slice(0, history.index + 1).concat(value).slice(-40);
                history.index = history.values.length - 1;
                histories.current.set(currentPage.current.id, history);
                setDirty(true);
            }
            setSelectionVersion(version => version + 1);
        }

        function prepareObject(object) {
            if (object.selectable !== false && !object.name) object.name = 'annotation-' + crypto.randomUUID();
            if (linkedPrefix(object)) object.set({ lockMovementX: true, lockMovementY: true });
            if (!['i-text', 'textbox', 'text'].includes(object.type)) return;
            object.set('objectCaching', false);
            if (object.type === 'text') return;
            object.off('mousedblclick', object.doubleClickHandler);
            if (object.pdfSelectionHandler) object.off('mousedblclick', object.pdfSelectionHandler);
            object.pdfSelectionHandler = () => {
                const layer = canvas.current;
                if (textScopeRef.current === 'statement' && object.name?.startsWith('statement-')) {
                    object.exitEditing(); layer.discardActiveObject();
                    const prefix = object.name.split(':')[0] + ':';
                    const statement = layer.getObjects().filter(item => item.name?.startsWith(prefix));
                    layer.setActiveObject(new fabric.ActiveSelection(statement, { canvas: layer }));
                    layer.renderAll(); setInspectorTab('format');
                } else {
                    object.enterEditing(); object.selectAll(); object.hiddenTextarea?.focus();
                }
            };
            object.on('mousedblclick', object.pdfSelectionHandler);
        }

        function clearSelection() {
            if (!canvas.current) return;
            canvas.current.getActiveObjects().forEach(object => object.exitEditing?.());
            canvas.current.discardActiveObject(); canvas.current.renderAll();
            undoSelection.current = null;
            setSelectionVersion(version => version + 1); setMode('select');
        }

        function linkedPrefix(object) { return /^(table|sticky)-[^:]+:/.exec(object?.name || '')?.[0]; }

        function linkedMembers(prefix) { return canvas.current.getObjects().filter(item => item.name?.startsWith(prefix)); }

        function selectObjects(objects) {
            const layer = canvas.current;
            layer.discardActiveObject();
            layer.setActiveObject(objects.length === 1 ? objects[0] : new fabric.ActiveSelection(objects, { canvas: layer }));
            layer.requestRenderAll(); setSelectionVersion(version => version + 1);
        }

        function editText(object, selectAll) {
            const layer = canvas.current;
            layer.discardActiveObject(); layer.setActiveObject(object);
            object.enterEditing();
            if (selectAll) object.selectAll();
            else object.selectionStart = object.selectionEnd = object.text.length;
            object.hiddenTextarea?.focus(); layer.requestRenderAll(); setSelectionVersion(version => version + 1);
        }

        function tableCellAt(prefix, pointer) {
            const grid = canvas.current.getObjects().find(item => item.name === prefix + 'grid');
            if (!grid) return null;
            const local = fabric.util.transformPoint(pointer, fabric.util.invertTransform(grid.calcTransformMatrix()));
            const column = Math.floor((local.x + grid.tableCols * grid.cellWidth / 2) / grid.cellWidth);
            const row = Math.floor((local.y + grid.tableRows * grid.cellHeight / 2) / grid.cellHeight);
            if (row < 0 || column < 0 || row >= grid.tableRows || column >= grid.tableCols) return null;
            return canvas.current.getObjects().find(item => item.name === prefix + row + ':' + column) || null;
        }

        function expandOnPointer(event) {
            const layer = canvas.current, target = event.target;
            const prefix = linkedPrefix(target);
            if (modeRef.current !== 'select' || !prefix) return;
            const active = layer.getActiveObject();
            if (active?.isEditing && linkedPrefix(active) === prefix) {
                if (prefix.startsWith('table-')) pendingCell.current = tableCellAt(prefix, layer.getPointer(event.e));
                return;
            }
            if (active?.type === 'activeSelection' && active.contains(target)) return;
            selectObjects(linkedMembers(prefix));
            // Make fabric drag the whole table or note instead of the clicked member.
            layer._target = layer.getActiveObject();
        }

        function finishCellSwitch() {
            const cell = pendingCell.current;
            pendingCell.current = null;
            if (cell) editText(cell, false);
        }

        function editLinkedText(event) {
            const layer = canvas.current, active = layer.getActiveObject();
            if (modeRef.current !== 'select' || active?.type !== 'activeSelection') return;
            const prefix = linkedPrefix(active.getObjects()[0]);
            if (!prefix) return;
            const text = prefix.startsWith('table-') ? tableCellAt(prefix, layer.getPointer(event.e))
                : linkedMembers(prefix).find(item => item.name.endsWith(':body'));
            if (text) editText(text, prefix.startsWith('sticky-'));
        }

        function growSticky(object) {
            if (!/^sticky-[^:]+:body$/.test(object?.name || '')) return;
            const card = canvas.current.getObjects().find(item => item.name === object.name.replace(/body$/, 'card'));
            if (!card) return;
            const needed = Math.max(140 * card.scaleY, object.top + object.getScaledHeight() + 14 - card.top);
            if (Math.abs(needed - card.getScaledHeight()) > 0.5) { card.set('height', needed / card.scaleY); card.setCoords(); }
        }

        function removeObjects(objects, record = true) {
            const layer = canvas.current, all = new Set();
            objects.forEach(object => {
                all.add(object);
                const prefix = linkedPrefix(object);
                if (prefix) linkedMembers(prefix).forEach(member => all.add(member));
                const mask = object.replacementMask && layer.getObjects().find(item => item.name === object.replacementMask);
                if (mask) all.add(mask);
            });
            restoring.current = true;
            layer.discardActiveObject();
            all.forEach(object => layer.remove(object));
            restoring.current = false;
            if (record) capture();
            layer.requestRenderAll(); setSelectionVersion(version => version + 1);
        }

        function textTargetAt(point, list) {
            return list.slice().reverse().find(item => {
                const radians = item.angle * Math.PI / 180;
                const dx = point.x - item.x, dy = point.y - item.y;
                const x = dx * Math.cos(radians) + dy * Math.sin(radians);
                const y = -dx * Math.sin(radians) + dy * Math.cos(radians);
                return x >= 0 && x <= item.width && y >= 0 && y <= item.height * 1.3;
            });
        }

        function intersectsBox(item, box) {
            const radians = item.angle * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
            const corners = [[0, 0], [item.width, 0], [0, item.height], [item.width, item.height]]
                .map(([x, y]) => [item.x + x * cos - y * sin, item.y + x * sin + y * cos]);
            const xs = corners.map(point => point[0]), ys = corners.map(point => point[1]);
            return Math.max(...xs) >= box.left && Math.min(...xs) <= box.left + box.width
                && Math.max(...ys) >= box.top && Math.min(...ys) <= box.top + box.height;
        }

        function textMark(item, kind) {
            const radians = item.angle * Math.PI / 180, lift = item.height * 0.08;
            return { left: item.x - 1 + Math.sin(radians) * lift, top: item.y - Math.cos(radians) * lift, width: item.width + 2,
                height: item.height * 1.32, angle: item.angle, kind };
        }

        function markRegion(start, end, kind) {
            const box = { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
            const click = box.width < 4 && box.height < 4;
            let marks = [];
            if (click) {
                const target = textTargetAt(start, selectionTargets);
                if (target) marks = [textMark(target, kind)];
            } else if (kind === 'highlight') {
                marks = groupTextTargets(textTargets.filter(item => intersectsBox(item, box))).map(item => textMark(item, kind));
            }
            if (!marks.length && !click) marks = [{ ...box, angle: 0, kind }];
            if (!marks.length) return;
            const layer = canvas.current;
            restoring.current = true;
            marks.forEach(mark => {
                const object = new fabric.Rect({ left: mark.left, top: mark.top, width: mark.width, height: mark.height, angle: mark.angle,
                    fill: kind === 'redaction' ? '#000000' : highlightColor, opacity: kind === 'redaction' ? 1 : 0.4, strokeWidth: 0, annotationKind: kind });
                prepareObject(object); layer.add(object);
            });
            restoring.current = false;
            capture(); layer.requestRenderAll();
        }

        useEffect(() => {
            if (!ready || !page) return;
            let cancelled = false;
            let renderTask;
            restoring.current = true;
            const previewScale = Math.min(4, Math.max(2, zoom * (window.devicePixelRatio || 1)));
            const editCanvas = new fabric.Canvas(overlay.current, { preserveObjectStacking: true });
            editCanvas.getRetinaScaling = () => previewScale;
            editCanvas._isRetinaScaling = () => editCanvas.enableRetinaScaling && previewScale > 1;
            editCanvas._initRetinaScaling = () => {
                editCanvas.__initRetinaScaling(previewScale, editCanvas.lowerCanvasEl, editCanvas.contextContainer);
                if (editCanvas.upperCanvasEl) editCanvas.__initRetinaScaling(previewScale, editCanvas.upperCanvasEl, editCanvas.contextTop);
            };
            canvas.current = editCanvas;
            currentPage.current = page;
            setPageViewport(null);
            task('Rendering page...', async () => {
                const source = await page.doc.render.getPage(page.number);
                if (cancelled) return;
                const viewport = source.getViewport({ scale: 1, rotation: page.rotation });
                const content = await source.getTextContent();
                if (cancelled) return;
                const targets = content.items.filter(item => item.str?.trim() && item.dir !== 'ttb').map((item, index) => {
                    const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
                    const angle = Math.atan2(transform[1], transform[0]);
                    const height = Math.hypot(transform[2], transform[3]);
                    return { id: index, text: item.str, x: transform[4] + Math.sin(angle) * height,
                        y: transform[5] - Math.cos(angle) * height, width: Math.max(0.1, item.width), height,
                        angle: angle * 180 / Math.PI, fontKey: item.fontName, hasEOL: item.hasEOL };
                    });
                page.width = viewport.width; page.height = viewport.height;
                background.current.width = Math.ceil(viewport.width * previewScale);
                background.current.height = Math.ceil(viewport.height * previewScale);
                background.current.style.width = viewport.width + 'px';
                background.current.style.height = viewport.height + 'px';
                renderTask = source.render({ canvasContext: background.current.getContext('2d'), viewport: source.getViewport({ scale: previewScale, rotation: page.rotation }) });
                await renderTask.promise;
                if (cancelled) return;
                for (const target of targets) {
                    const sourceFont = source.commonObjs.has(target.fontKey) ? source.commonObjs.get(target.fontKey) : null;
                    const detected = sourceFontStyle(sourceFont?.name, content.styles[target.fontKey]?.fontFamily);
                    const key = page.number + ':' + target.fontKey;
                    let original = page.doc.fonts.get(key);
                    if (!original) {
                        original = await recoverSourceFont(page.doc.pdf, page.number, sourceFont, detected);
                        if (cancelled) {
                            if (original.face) document.fonts.delete(original.face);
                            if (original.localFace) document.fonts.delete(original.localFace);
                            return;
                        }
                        page.doc.fonts.set(key, original);
                    }
                    Object.assign(target, sourceTextFont(original, target.text), {
                        fontWeight: original.fontWeight, fontStyle: original.fontStyle,
                        sourceFontKey: key, sourceFontLabel: original.parsed?.familyName || detected.label });
                }
                if (cancelled) return;
                setTextTargets(targets);
                setPageViewport(viewport);
                editCanvas.setDimensions({ width: viewport.width, height: viewport.height });
                await new Promise(resolve => editCanvas.loadFromJSON(page.overlay || { objects: [] }, resolve));
                if (cancelled) return;
                editCanvas.getObjects().forEach(prepareObject);
                if (page.markdown?.perPage && !page.markdown.initialized) {
                    page.markdown.overlay = JSON.stringify(editCanvas.toJSON(OBJECT_PROPS));
                    page.markdown.initialized = true;
                }
                if (!histories.current.has(page.id)) histories.current.set(page.id, {
                    values: [editCanvas.toJSON(OBJECT_PROPS)], index: 0
                });
                restoring.current = false;
                editCanvas.renderAll();
                editCanvas.on('object:added', event => { prepareObject(event.target); capture(); });
                editCanvas.on('text:changed', event => growSticky(event.target));
                ['object:modified', 'object:removed', 'path:created', 'text:changed'].forEach(event => editCanvas.on(event, capture));
                editCanvas.on('mouse:down:before', expandOnPointer);
                editCanvas.on('mouse:up', finishCellSwitch);
                editCanvas.on('mouse:dblclick', editLinkedText);
                ['selection:created', 'selection:updated', 'selection:cleared'].forEach(event => editCanvas.on(event, () => setSelectionVersion(version => version + 1)));
            });
            return () => { cancelled = true; renderTask?.cancel(); editCanvas.dispose(); if (canvas.current === editCanvas) canvas.current = null; };
        }, [ready, page?.id, page?.rotation, mobile, renderRevision, zoom]);

        useEffect(() => {
            if (!canvas.current) return;
            const layer = canvas.current;
            layer.isDrawingMode = mode === 'draw';
            layer.freeDrawingBrush.color = color;
            layer.freeDrawingBrush.width = 3;
            layer.defaultCursor = mode.startsWith('fill') ? 'crosshair' : 'default';
            function fillAtPointer(event) {
                if (busy || !mode.startsWith('fill') || event.target) return;
                const point = layer.getPointer(event.e);
                if (mode === 'fill-check') {
                    addObject(new fabric.Text('X', { left: point.x, top: point.y, fontSize, fill: color, fontFamily: 'Helvetica' }));
                } else {
                    const value = mode === 'fill-date' ? new Date().toLocaleDateString() : 'Enter text';
                    const object = new fabric.IText(value, { left: point.x, top: point.y, fontSize, fill: color, fontFamily, fontWeight, fontStyle });
                    addObject(object); object.enterEditing(); object.selectAll();
                }
            }
            layer.on('mouse:down', fillAtPointer);
            return () => layer.off('mouse:down', fillAtPointer);
        }, [mode, color, fontSize, fontFamily, fontWeight, fontStyle, busy]);

        useEffect(() => {
            const layer = canvas.current;
            if (!layer) return;
            function editPageText(event) {
                if (busy || mode !== 'select' || event.target) return;
                const target = textTargetAt(layer.getPointer(event.e), selectionTargets);
                if (target) replaceText(target);
            }
            layer.on('mouse:dblclick', editPageText);
            return () => layer.off('mouse:dblclick', editPageText);
        }, [busy, mode, textTargets, textScope]);

        useEffect(() => {
            const layer = canvas.current;
            if (!layer) return;
            const kind = mode === 'highlight' ? 'highlight' : mode === 'blackout' ? 'redaction' : null;
            const erasing = mode === 'erase';
            layer.selection = !kind && !erasing;
            layer.skipTargetFind = !!kind || erasing;
            if (kind || erasing) {
                layer.defaultCursor = 'crosshair';
                layer.discardActiveObject(); layer.requestRenderAll();
            }
            let start = null, preview = null, erased = false;
            function eraseAt(event) {
                const pointer = layer.getPointer(event.e);
                const target = layer.getObjects().slice().reverse().find(object => object.visible && object.evented !== false
                    && object.selectable !== false && object.containsPoint(pointer)
                    && (object.type !== 'path' || !layer.isTargetTransparent(object, pointer.x, pointer.y)));
                if (target) { removeObjects([target], false); erased = true; }
            }
            function down(event) {
                if (busy) return;
                start = layer.getPointer(event.e);
                if (erasing) { eraseAt(event); return; }
                if (!kind) { start = null; return; }
                restoring.current = true;
                preview = new fabric.Rect({ left: start.x, top: start.y, width: 0, height: 0, fill: kind === 'redaction' ? '#000000' : highlightColor,
                    opacity: kind === 'redaction' ? 0.55 : 0.4, selectable: false, evented: false, excludeFromExport: true });
                layer.add(preview);
                restoring.current = false;
            }
            function move(event) {
                if (!start) return;
                if (erasing) { eraseAt(event); return; }
                const point = layer.getPointer(event.e);
                preview.set({ left: Math.min(start.x, point.x), top: Math.min(start.y, point.y),
                    width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y) });
                layer.requestRenderAll();
            }
            function up(event) {
                if (!start) return;
                const origin = start;
                start = null;
                if (erasing) { if (erased) capture(); erased = false; return; }
                restoring.current = true; layer.remove(preview); restoring.current = false; preview = null;
                markRegion(origin, layer.getPointer(event.e), kind);
            }
            layer.on('mouse:down', down); layer.on('mouse:move', move); layer.on('mouse:up', up);
            return () => {
                layer.off('mouse:down', down); layer.off('mouse:move', move); layer.off('mouse:up', up);
                if (preview) { restoring.current = true; layer.remove(preview); restoring.current = false; }
                layer.selection = true; layer.skipTargetFind = false;
            };
        }, [mode, highlightColor, busy, textTargets, textScope, renderRevision]);

        async function prepareDocument(file) {
            const originalBytes = new Uint8Array(await file.arrayBuffer());
            let bytes = originalBytes;
            // pdf-lib's browser bundle does not preserve EncryptedPDFError's prototype.
            let pdf = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
            if (pdf.isEncrypted) {
                const unlocked = await new Promise(resolve => {
                    unlockRequest.current = resolve; setPdfPassword(''); setLockedPdf({ file, bytes });
                });
                if (!unlocked) throw new Error('PDF unlock cancelled. No pages were imported.');
                if (unlocked.action === 'save') return null;
                bytes = unlocked.bytes;
                pdf = await PDFLib.PDFDocument.load(bytes);
            }
            const render = await pdfjsLib.getDocument({ data: bytes.slice(), fontExtraProperties: true }).promise;
            try {
                const fields = pdfFields(pdf);
                return { id: crypto.randomUUID(), bytes, originalBytes, pdf, render, name: file.name, fields, fonts: new Map(),
                    signatures: signatureFields(pdf),
                    formValues: Object.fromEntries(fields.map(field => [field.name, field.value])) };
            } catch (failure) { await render.destroy(); throw failure; }
        }

        async function importFiles(files, merging = false) {
            if (!files.length) return;
            await task('Importing PDF pages...', async () => {
                const added = [];
                const prepared = [];
                try {
                    for (const file of files) {
                        let doc;
                        try { doc = await prepareDocument(file); }
                        catch (failure) { throw new Error(file.name + ': ' + (failure.message || String(failure))); }
                        if (!doc) continue;
                        prepared.push(doc);
                        doc.pdf.getPages().forEach((source, index) => added.push({ id: crypto.randomUUID(), doc, number: index + 1,
                            rotation: source.getRotation().angle, overlay: { objects: [] } }));
                    }
                } catch (failure) {
                    prepared.forEach(doc => doc.render.destroy());
                    throw failure;
                }
                if (!alive.current) { prepared.forEach(doc => doc.render.destroy()); return; }
                docs.current.push(...prepared);
                if (!added.length) { if (merging) setMergeFiles(null); return; }
                if (!pages.length && prepared[0]) { setName(prepared[0].name.replace(/\.pdf$/i, '')); setTitle(prepared[0].name.replace(/\.pdf$/i, '')); }
                setPages(previous => previous.concat(added)); setDirty(true);
                if (prepared.some(doc => doc.signatures.some(item => item.signed))) setInspectorTab('verify');
                if (merging) setMergeFiles(null);
            });
        }

        async function completeUnlock(action) {
            if (unlockRunning.current) return;
            unlockRunning.current = true;
            activeTasks.current++; setBusy('Unlocking PDF...'); setError('');
            try {
                const result = await unlockPdf(lockedPdf.bytes, pdfPassword);
                if (!alive.current) return;
                await PDFLib.PDFDocument.load(result.bytes);
                if (action === 'save') download(result.bytes, lockedPdf.file.name.replace(/\.pdf$/i, '') + '-unlocked.pdf');
                setExportNote('Unlocked locally. Rewriting a PDF invalidates its original digital signatures. Verify uses the original file, not the unlocked copy.'
                    + (result.warnings.length ? ' Decryption warnings: ' + result.warnings.join(' ') : ''));
                const resolve = unlockRequest.current; unlockRequest.current = null;
                setPdfPassword(''); setLockedPdf(null); resolve?.({ bytes: result.bytes, action });
            } catch (failure) { if (alive.current) setError(failure.message || String(failure)); }
            finally {
                unlockRunning.current = false;
                activeTasks.current--;
                if (alive.current && unlockRequest.current) setBusy('Waiting for PDF password...');
                else if (alive.current && activeTasks.current === 0) setBusy('');
            }
        }

        async function importTrustFiles(files, kind) {
            await task('Reading verification certificates...', async () => {
                const entries = [];
                for (const file of files) entries.push(...await readTrustFile(file, kind));
                if (kind === 'certificate' && !window.confirm('Trust these certificates for this editor session?\n'
                    + entries.map(item => item.name + '\nSHA-256: ' + item.fingerprint).join('\n\n')
                    + '\n\nCompare fingerprints with an independent official source (for Indian documents, CCA). Never trust a certificate only because it is embedded in a PDF.')) return;
                const key = kind === 'crl' ? 'crls' : 'certificates';
                setTrust(previous => ({ ...previous, [key]: [...previous[key], ...entries].filter((item, index, all) => all.findIndex(other => other.fingerprint === item.fingerprint) === index) }));
                setSignatureResults({});
            });
        }

        useEffect(() => {
            if (!markdown) return;
            let cancelled = false;
            setMarkdownPreview([]); setMarkdownError('');
            const timer = setTimeout(async () => {
                try {
                    await loadScript('marked', 'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js');
                    if (cancelled) return;
                    for (const asset of Object.values(markdownAssets.current)) {
                        if (!asset.pending) continue;
                        const image = await new Promise((resolve, reject) => fabric.Image.fromURL(asset.pending, (image, failed) => {
                            if (failed) reject(new Error('The added image could not be decoded.'));
                            else resolve(image);
                        }));
                        asset.object = image.toObject(OBJECT_PROPS); asset.fixed = false; delete asset.pending;
                    }
                    if (cancelled) return;
                    const preview = markdown.preserveLayout ? [await layoutEdits(markdown, window.marked.lexer)]
                        : layoutMarkdown(markdownBlocks(markdown.source, window.marked.lexer, markdownAssets.current));
                    if (cancelled) return;
                    setMarkdownPreview(preview); setMarkdownPreviewPage(0);
                } catch (failure) {
                    if (!cancelled) setMarkdownError(failure.message || String(failure));
                }
            }, 250);
            return () => { cancelled = true; clearTimeout(timer); };
        }, [markdown?.source, markdown?.id]);

        useEffect(() => {
            if (!markdown || !markdownPreview.length || !markdownCanvas.current) return;
            let cancelled = false;
            const preview = new fabric.StaticCanvas(markdownCanvas.current, { backgroundColor: '#ffffff',
                width: markdown.width || 595.28, height: markdown.height || 841.89 });
            const data = { ...markdownPreview[markdownPreviewPage] };
            if (markdown.preserveLayout) data.backgroundImage = markdown.backgroundImage;
            preview.loadFromJSON(data, () => { if (!cancelled) preview.renderAll(); });
            return () => { cancelled = true; preview.dispose(); };
        }, [markdownPreview, markdownPreviewPage, !!markdown]);

        useEffect(() => {
            if (mergeFiles === null && !markdown && !lockedPdf) return;
            const previous = document.activeElement;
            const dialog = editorRef.current?.querySelector(lockedPdf ? '.pdf-unlock-dialog' : '.pdf-dialog');
            const controls = () => Array.from(dialog?.querySelectorAll('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled)') || []);
            (dialog?.querySelector('textarea') || controls()[0])?.focus();
            function trap(event) {
                if (event.key !== 'Tab') return;
                const items = controls(), index = items.indexOf(document.activeElement);
                if (event.shiftKey && index <= 0) { event.preventDefault(); items[items.length - 1]?.focus(); }
                else if (!event.shiftKey && (index === items.length - 1 || index < 0)) { event.preventDefault(); items[0]?.focus(); }
            }
            dialog?.addEventListener('keydown', trap);
            return () => { dialog?.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus(); };
        }, [mergeFiles !== null, !!markdown, !!lockedPdf]);

        function openMarkdown() {
            setMarkdownPreview([]); setMarkdownError(''); setError('');
            setMarkdown({ id: crypto.randomUUID(), source: '# My document\n\nWrite **Markdown** and see it render here.\n\n- First item\n- Second item\n\n```js\nconsole.log("Hello PDF");\n```',
                replacing: false });
        }

        function changeMarkdown(value) {
            const source = value.replace(/!\[([^\]]*)\]\((data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+)\)/g, (match, label, data) => {
                const href = 'pdf-image:' + crypto.randomUUID();
                markdownAssets.current[href] = { pending: data };
                return '![' + label + '](' + href + ')';
            });
            setMarkdownPreview([]);
            setMarkdown(previous => ({ ...previous, source }));
        }

        async function editPageMarkdown() {
            if (!page) return;
            await task('Opening layout-preserving Markdown...', async () => {
                clearSelection();
                capture();
                if (page.overlay.objects.some(object => object.annotationKind === 'redaction')) {
                    throw new Error('This page contains blacked-out content. Export and reopen its redacted PDF before converting it to Markdown.');
                }
                const masks = page.overlay.objects.filter(object => object.selectable === false && object.name?.startsWith('pdf-mask-'));
                const blocks = textTargets.filter(target => !masks.some(mask => {
                    const angle = (mask.angle || 0) * Math.PI / 180;
                    const dx = target.x - mask.left, dy = target.y - mask.top;
                    const x = dx * Math.cos(angle) + dy * Math.sin(angle), y = -dx * Math.sin(angle) + dy * Math.cos(angle);
                    return x >= -2 && x <= mask.width + 2 && y >= -2 && y <= mask.height + 2;
                })).map(target => ({ target, left: target.x, top: target.y, source: escapeMarkdown(target.text) }));
                page.overlay.objects.filter(object => ['textbox', 'i-text', 'text'].includes(object.type) && object.text?.trim()).forEach(object => {
                    blocks.push({ object, left: object.left, top: object.top, source: pageMarkdown([object], {}) });
                });
                blocks.sort((a, b) => a.top - b.top || a.left - b.left);
                blocks.forEach((block, index) => { block.id = 'text-' + (index + 1); });
                if (!blocks.length) throw new Error('This page has no editable text blocks. Use OCR first or create a new Markdown page.');
                const snapshot = document.createElement('canvas');
                snapshot.width = background.current.width; snapshot.height = background.current.height;
                snapshot.getContext('2d').drawImage(background.current, 0, 0);
                const backgroundImage = new fabric.Image(snapshot, { left: 0, top: 0, scaleX: page.width / snapshot.width,
                    scaleY: page.height / snapshot.height }).toObject();
                setMarkdownPreview([]); setMarkdownError('');
                setMarkdown({ id: crypto.randomUUID(), source: layoutSource(blocks), blocks, preserveLayout: true,
                    originalOverlay: JSON.parse(JSON.stringify(page.overlay)), backgroundCanvas: snapshot, backgroundImage, fonts: page.doc.fonts,
                    width: page.width, height: page.height, replacing: true, targetId: page.id });
            });
        }

        async function applyMarkdown() {
            if (!markdownPreview.length || markdownError) return;
            if (markdown.preserveLayout) {
                await task('Applying text edits without changing page layout...', async () => {
                    if (page?.id !== markdown.targetId) throw new Error('The active page changed. Reopen Markdown for the selected page.');
                    const overlay = await layoutEdits(markdown, window.marked.lexer);
                    restoring.current = true;
                    try {
                        await new Promise(resolve => canvas.current.loadFromJSON(overlay, resolve));
                        canvas.current.getObjects().forEach(prepareObject);
                    } finally { restoring.current = false; }
                    capture(); canvas.current.renderAll(); setMarkdown(null);
                });
                return;
            }
            await task('Creating Markdown pages...', async () => {
                const generated = await PDFLib.PDFDocument.create();
                markdownPreview.forEach(() => {
                    const sheet = generated.addPage([595.28, 841.89]);
                    sheet.drawRectangle({ x: 0, y: 0, width: 595.28, height: 841.89, color: PDFLib.rgb(1, 1, 1) });
                });
                const doc = await prepareDocument(new File([await generated.save()], 'Markdown.pdf', { type: 'application/pdf' }));
                if (!alive.current) { await doc.render.destroy(); return; }
                const added = markdownPreview.map((overlay, index) => {
                    const assets = markdownAssets.current;
                    const source = markdownPreview.length === 1 ? markdown.source : pageMarkdown(overlay.objects, assets);
                    return { id: crypto.randomUUID(), doc, number: index + 1,
                        rotation: 0, overlay: JSON.parse(JSON.stringify(overlay)),
                        markdown: { id: crypto.randomUUID(), source, perPage: true, overlay: JSON.stringify(overlay) } };
                });
                docs.current.push(doc);
                const first = pages.findIndex(item => item.id === markdown.targetId);
                const next = pages.filter(item => item.id !== markdown.targetId);
                const index = first < 0 ? next.length : first;
                next.splice(index, 0, ...added);
                changePages(next, index); setMarkdown(null);
            });
        }

        function addObject(object) {
            canvas.current.add(object); canvas.current.setActiveObject(object); canvas.current.renderAll(); setMode('select'); setInspectorTab('format');
        }

        function createReplacement(target, colors) {
            const { object, mask } = replacementObjects(target, colors.paper, colors.fill);
            canvas.current.add(mask);
            canvas.current.add(object);
            return object;
        }

        function replaceText(target, manual = false) {
            const runs = target.runs || [target];
            const first = runs[0];
            let colors;
            if (manual) {
                if (manualReplacement?.pageId !== page?.id || manualReplacement.target !== target) {
                    setError('The page changed. Select its text again before replacing it.'); setManualReplacement(null); return;
                }
                colors = runs.map(() => ({ paper: paperColor, fill: color }));
            } else {
                try { colors = runs.map(run => textPatchColors(run, background.current, page.width, page.height)); }
                catch (failure) {
                    setError(failure.message);
                    setManualReplacement({ target, pageId: page.id });
                    return;
                }
            }
            setManualReplacement(null);
            setError('');
            const uniform = runs.every(run => run.fontFamily === first.fontFamily && run.fontWeight === first.fontWeight
                && run.sourceFontKey === first.sourceFontKey && run.fontStyle === first.fontStyle && Math.abs(run.height - first.height) < 0.1)
                && colors.every(item => item.paper === colors[0].paper && item.fill === colors[0].fill);
            restoring.current = true;
            const objects = uniform ? [createReplacement(target, colors[0])] : runs.map((run, index) => createReplacement(run, colors[index]));
            if (objects.length > 1) {
                const id = 'statement-' + crypto.randomUUID();
                objects.forEach((object, index) => { object.name = id + ':' + index; });
            }
            restoring.current = false;
            canvas.current.setActiveObject(objects.length === 1 ? objects[0] : new fabric.ActiveSelection(objects, { canvas: canvas.current }));
            capture(); canvas.current.renderAll(); setMode('select');
            setInspectorTab('format');
            if (objects.length === 1) { objects[0].enterEditing(); objects[0].selectAll(); }
        }

        function deleteSelection() {
            removeObjects(canvas.current.getActiveObjects());
        }

        function updateField(field, value) {
            page.doc.formValues[field.name] = value;
            setFieldRevision(version => version + 1); setDirty(true);
        }

        function convertToTextbox(object) {
            const layer = canvas.current;
            const mask = object.replacementMask && layer.getObjects().find(item => item.name === object.replacementMask);
            const width = Math.max(object.width, mask ? mask.getScaledWidth() / object.scaleX : 0);
            const data = object.toObject(OBJECT_PROPS);
            delete data.type;
            const box = new fabric.Textbox(object.text, { ...data, width });
            restoring.current = true;
            const index = layer.getObjects().indexOf(object);
            layer.remove(object); layer.insertAt(box, index); prepareObject(box);
            restoring.current = false;
            return box;
        }

        function formatSelection(properties) {
            if (!canvas.current) return;
            let object = canvas.current.getActiveObject();
            if (!object) return;
            if (properties.textAlign && canvas.current.getActiveObjects().some(item => item.type === 'i-text')) {
                const members = canvas.current.getActiveObjects();
                canvas.current.discardActiveObject();
                selectObjects(members.map(item => item.type === 'i-text' ? convertToTextbox(item) : item));
                object = canvas.current.getActiveObject();
            }
            const textProperties = ['fontFamily', 'fontWeight', 'fontStyle', 'fontSize', 'underline', 'linethrough', 'textAlign', 'lineHeight', 'charSpacing', 'fill', 'paragraphSpacing'];
            const objects = object.type === 'activeSelection' && Object.keys(properties).some(key => textProperties.includes(key))
                ? canvas.current.getActiveObjects().filter(item => ['i-text', 'textbox', 'text'].includes(item.type)) : [object];
            objects.forEach(item => {
                if (properties.fontFamily) { item.sourceFontKey = null; item.sourceFontExact = false; }
                item.set(properties); item.setCoords();
            });
            if (object.type === 'activeSelection' && objects.length > 1) object.addWithUpdate();
            canvas.current.renderAll(); capture();
        }

        function chooseBackground(value) {
            setWorkspaceBackground(value);
            try { localStorage.setItem('daily_pdf_background', value); } catch { }
        }

        function setTextValue(object, value, selectionStart, selectionEnd) {
            object.set('text', value);
            if (object.isEditing) {
                object.selectionStart = selectionStart; object.selectionEnd = selectionEnd;
                object.hiddenTextarea.value = value;
                object._updateTextarea();
            }
            growSticky(object);
            object.setCoords(); canvas.current.requestRenderAll(); capture();
        }

        function transformLines(change) {
            const object = canvas.current?.getActiveObject();
            if (!object || !['i-text', 'textbox'].includes(object.type)) return;
            const text = object.text;
            let start = 0, end = text.length;
            if (object.isEditing) {
                start = text.lastIndexOf('\n', object.selectionStart - 1) + 1;
                const last = object.selectionEnd > object.selectionStart && text[object.selectionEnd - 1] === '\n' ? object.selectionEnd - 1 : object.selectionEnd;
                end = text.indexOf('\n', last);
                if (end < 0) end = text.length;
            }
            const next = change(text.slice(start, end).split('\n')).join('\n');
            setTextValue(object, text.slice(0, start) + next + text.slice(end), start, start + next.length);
        }

        function continueList(object) {
            const text = object.text, caret = object.selectionStart;
            const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
            const line = text.slice(lineStart, caret);
            const marker = line.match(MARKER_PATTERN)?.[0];
            if (!marker) return false;
            if (!line.slice(marker.length).trim()) {
                setTextValue(object, text.slice(0, lineStart) + text.slice(caret), lineStart, lineStart);
                return true;
            }
            const next = marker.replace(/\d+/, number => Number(number) + 1)
                .replace(/^(\s*)([ivx]+|[a-hj-uwyz])([.)])/i, (match, indent, value, end) => {
                    if (/^[ivx]+$/i.test(value)) {
                        const numerals = { i: 1, v: 5, x: 10 };
                        let number = 0;
                        for (let index = 0; index < value.length; index++) {
                            const current = numerals[value[index].toLowerCase()], following = numerals[value[index + 1]?.toLowerCase()] || 0;
                            number += current < following ? -current : current;
                        }
                        return indent + romanMarker(number + 1) + end;
                    }
                    return indent + String.fromCharCode(value.charCodeAt(0) + 1) + end;
                });
            const insert = '\n' + next;
            setTextValue(object, text.slice(0, caret) + insert + text.slice(object.selectionEnd), caret + insert.length, caret + insert.length);
            return true;
        }

        function setBounds(key, value) {
            const object = canvas.current?.getActiveObject();
            if (!object) return;
            const rect = object.getBoundingRect(true, true);
            if (key === 'x') object.set('left', object.left + value - rect.left);
            else if (key === 'y') object.set('top', object.top + value - rect.top);
            else if (key === 'w' && object.type === 'textbox') object.set('width', Math.max(10, object.width * value / rect.width));
            else if (key === 'w') object.set('scaleX', object.scaleX * value / rect.width);
            else object.set('scaleY', object.scaleY * value / rect.height);
            object.setCoords(); canvas.current.requestRenderAll(); capture();
        }

        function alignToPage(where) {
            const object = canvas.current?.getActiveObject();
            if (!object) return;
            const rect = object.getBoundingRect(true, true);
            const dx = { left: -rect.left, center: (page.width - rect.width) / 2 - rect.left, right: page.width - rect.width - rect.left }[where] || 0;
            const dy = { top: -rect.top, middle: (page.height - rect.height) / 2 - rect.top, bottom: page.height - rect.height - rect.top }[where] || 0;
            object.set({ left: object.left + dx, top: object.top + dy });
            object.setCoords(); canvas.current.requestRenderAll(); capture();
        }

        function closeMenu(event) { event.currentTarget.closest('details')?.removeAttribute('open'); }

        function insertShape([label, path, open]) {
            addObject(new fabric.Path(path, { left: page.width / 2 - 60, top: 120, fill: open ? null : 'transparent', stroke: color,
                strokeWidth: 2, strokeUniform: true, strokeLineCap: 'round', strokeLineJoin: 'round', scaleX: 1.2, scaleY: 1.2,
                annotationKind: open ? 'line' : 'shape', name: 'annotation-' + crypto.randomUUID() + ':' + label }));
        }

        function insertTable(rows, cols) {
            const id = 'table-' + crypto.randomUUID() + ':';
            const cellWidth = Math.min(110, (page.width - 80) / cols), cellHeight = 28, left = 40, top = 100;
            const lines = [];
            for (let row = 0; row <= rows; row++) lines.push(`M0 ${row * cellHeight}H${cols * cellWidth}`);
            for (let col = 0; col <= cols; col++) lines.push(`M${col * cellWidth} 0V${rows * cellHeight}`);
            const grid = new fabric.Group([
                new fabric.Rect({ left: 0, top: 0, width: cols * cellWidth, height: cellHeight, fill: '#e5eeff', strokeWidth: 0 }),
                new fabric.Path(lines.join(''), { left: 0, top: 0, fill: null, stroke: '#1f2937', strokeWidth: 1 })
            ], { left, top, name: id + 'grid', annotationKind: 'table', tableRows: rows, tableCols: cols, cellWidth, cellHeight });
            const layer = canvas.current;
            restoring.current = true;
            layer.add(grid);
            for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
                layer.add(new fabric.Textbox('', { left: left + col * cellWidth + 5, top: top + row * cellHeight + 7, width: cellWidth - 10,
                    fontSize: 12, fontFamily, fontWeight: row === 0 ? 'bold' : 'normal', fill: '#111111', name: id + row + ':' + col, annotationKind: 'table' }));
            }
            layer.getObjects().forEach(prepareObject);
            restoring.current = false;
            capture(); setMode('select'); setInspectorTab('format');
            editText(linkedMembers(id).find(item => item.name === id + '0:0'), false);
        }

        function addSticky() {
            const id = 'sticky-' + crypto.randomUUID() + ':', left = 60, top = 140, width = 210;
            const layer = canvas.current;
            restoring.current = true;
            layer.add(new fabric.Rect({ left, top, width, height: 140, rx: 8, ry: 8, fill: NOTE_COLORS[0][0], stroke: '#9db9e8', strokeWidth: 1,
                shadow: new fabric.Shadow({ color: 'rgba(15,23,42,.18)', blur: 10, offsetY: 3 }), name: id + 'card', annotationKind: 'sticky' }));
            layer.add(new fabric.Text('NOTE · ' + new Date().toLocaleDateString(), { left: left + 12, top: top + 10, fontSize: 9,
                fontWeight: 'bold', fontFamily: 'Helvetica', fill: '#334155', charSpacing: 60, name: id + 'header', annotationKind: 'sticky' }));
            layer.add(new fabric.Textbox('Add a note', { left: left + 12, top: top + 30, width: width - 24, fontSize: 13, fontFamily: 'Helvetica',
                fill: '#111827', name: id + 'body', annotationKind: 'sticky' }));
            layer.getObjects().forEach(prepareObject);
            restoring.current = false;
            capture(); setMode('select'); setInspectorTab('format');
            editText(linkedMembers(id).find(item => item.name.endsWith(':body')), true);
        }

        async function updateOverlays(label, mutate) {
            let changed = 0;
            await task(label, async () => {
                for (let index = 0; index < pages.length; index++) {
                    const item = pages[index];
                    const source = item.doc.pdf.getPage(item.number - 1);
                    const placement = pagePlacement(source.getWidth(), source.getHeight(), item.rotation);
                    const layer = new fabric.StaticCanvas(document.createElement('canvas'), { width: placement.width, height: placement.height });
                    try {
                        await new Promise(resolve => layer.loadFromJSON(item.overlay, resolve));
                        const count = await mutate(layer, item, index, placement);
                        if (!count) continue;
                        changed += count;
                        item.overlay = layer.toJSON(OBJECT_PROPS);
                        const history = histories.current.get(item.id) || { values: [{ objects: [] }], index: 0 };
                        history.values = history.values.slice(0, history.index + 1).concat(item.overlay).slice(-40);
                        history.index = history.values.length - 1; histories.current.set(item.id, history);
                    } finally { layer.dispose(); }
                }
                if (changed) { setDirty(true); setRenderRevision(version => version + 1); }
            });
            return changed;
        }

        function decoratePages(kind, remove = false) {
            return updateOverlays(remove ? 'Removing ' + kind + '...' : 'Updating page decorations...', (layer, item, index, placement) => {
                const existing = layer.getObjects().filter(object => object.annotationKind === kind);
                existing.forEach(object => layer.remove(object));
                if (remove) return existing.length;
                const text = kind === 'page-number' ? String(numberStart + index) : watermark;
                const base = { originX: 'center', originY: 'center', fontFamily, annotationKind: kind, name: 'annotation-' + crypto.randomUUID() };
                if (kind === 'page-number') {
                    layer.add(new fabric.IText(text, { ...base, left: placement.width / 2, top: placement.height - 28, fontSize: 12, fill: '#313b40' }));
                    return 1;
                }
                const { size, opacity, angle, color: tint, layout } = watermarkStyle;
                const style = { ...base, fontSize: size, fill: tint, opacity: opacity / 100, angle, fontWeight: 'bold' };
                if (layout !== 'tile') {
                    layer.add(new fabric.IText(text, { ...style, left: placement.width / 2, top: placement.height / 2 }));
                    return 1;
                }
                const stepX = Math.max(size * text.length * 0.62 + size, 140), stepY = size * 3.2;
                let count = 0;
                for (let y = stepY / 2; y < placement.height + stepY / 2; y += stepY) {
                    for (let x = (Math.round(y / stepY) % 2 ? stepX / 2 : 0); x < placement.width + stepX / 2; x += stepX) {
                        layer.add(new fabric.IText(text, { ...style, left: x, top: y, name: 'annotation-' + crypto.randomUUID() }));
                        count++;
                    }
                }
                return count;
            });
        }

        async function redactMatches() {
            const patterns = {
                text: () => new RegExp(redactQuery.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
                email: () => /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
                phone: () => /\+?\d[\d\s().-]{7,}\d/g,
                number: () => /\b\d[\d\s-]{3,}\d\b/g
            };
            if (redactPattern === 'text' && !redactQuery.trim()) return;
            const count = await updateOverlays('Finding sensitive content...', async (layer, item) => {
                const source = await item.doc.render.getPage(item.number);
                const viewport = source.getViewport({ scale: 1, rotation: item.rotation });
                const content = await source.getTextContent();
                let added = 0;
                for (const text of content.items) {
                    if (!text.str) continue;
                    const transform = pdfjsLib.Util.transform(viewport.transform, text.transform);
                    const radians = Math.atan2(transform[1], transform[0]), height = Math.hypot(transform[2], transform[3]);
                    const originX = transform[4] + Math.sin(radians) * height, originY = transform[5] - Math.cos(radians) * height;
                    for (const match of text.str.matchAll(patterns[redactPattern]())) {
                        const offset = text.width * match.index / text.str.length, width = text.width * match[0].length / text.str.length;
                        const lift = height * 0.08;
                        layer.add(new fabric.Rect({ left: originX + Math.cos(radians) * offset + Math.sin(radians) * lift - 1,
                            top: originY + Math.sin(radians) * offset - Math.cos(radians) * lift, width: width + 2, height: height * 1.32,
                            angle: radians * 180 / Math.PI, fill: '#000000', strokeWidth: 0, annotationKind: 'redaction', name: 'annotation-' + crypto.randomUUID() }));
                        added++;
                    }
                }
                return added;
            });
            setExportNote(count ? `Blacked out ${count} match${count === 1 ? '' : 'es'}. Review every page: matches split across separate PDF text runs or inside images are not found.`
                : 'No matching text found. Scanned pages and text inside images are not searched; use Black out area instead.');
        }

        async function verifyDocumentSignature(signature) {
            const key = page.doc.id + ':' + signature.name;
            setActiveSignature(key); setInspectorTab('verify');
            setSignatureResults(previous => {
                const next = { ...previous }; delete next[key]; return next;
            });
            await task('Verifying signature...', async () => {
                const result = await verifySignature(page.doc.originalBytes || page.doc.bytes, signature, trust);
                setSignatureResults(previous => ({ ...previous, [key]: { ...result, checkedAt: new Date() } }));
            });
        }

        function duplicateSelection() {
            const object = canvas.current.getActiveObject();
            object.clone(copy => {
                copy.set({ left: object.left + 16, top: object.top + 16, name: 'annotation-' + crypto.randomUUID() });
                copy.replacementMask = null;
                addObject(copy);
            }, OBJECT_PROPS);
        }

        async function exportSelection() {
            if (exportFormat === 'pdf') return exportPdf();
            if (exportFormat === 'text') { download(text, name + '-text.txt', 'text/plain;charset=utf-8'); return; }
            if (exportFormat === 'fields') { download(JSON.stringify(page.doc.formValues, null, 2), name + '-fields.json', 'application/json'); return; }
            return exportPdf(undefined, true);
        }
        async function exportPageImages(bytes, indices, target) {
            if (!window.DailyImageTools) throw new Error('Image export tools are unavailable. Reload the app and retry.');
            if (indices.length > 1) await loadScript('JSZip', 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
            const zip = indices.length > 1 ? new window.JSZip() : null;
            const type = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' })[exportFormat];
            if (!type) throw new Error('Unsupported image export format.');
            const images = [];
            await withRasterPages(bytes, 2, async (sheet, physical, number) => {
                const result = target
                    ? await window.DailyImageTools.autoCompress(sheet, target, physical.dpi, setBusy, undefined, undefined, undefined, true, type)
                    : { blob: await window.DailyImageTools.imageBlob(sheet, type, .95, physical.dpi), width: sheet.width, height: sheet.height };
                const filename = (name || 'document').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') + '-page-' + (indices[number - 1] + 1) + '.' + exportFormat;
                if (zip) zip.file(filename, await result.blob.arrayBuffer());
                images.push({ ...result, filename });
            });
            if (zip) {
                download(await zip.generateAsync({ type: 'blob', compression: 'STORE' }), (name || 'document') + '-pages.zip', 'application/zip');
            } else download(images[0].blob, images[0].filename, type);
            setExportNote(images.length + ' page image' + (images.length === 1 ? '' : 's in ZIP') + ' exported.' +
                (target ? ' Each image is at or below ' + target.toLocaleString() + ' bytes.' + (zip ? ' ZIP overhead is additional.' : '') : '') +
                images.map((image, index) => ` Page ${indices[index] + 1}: ${image.blob.size.toLocaleString()} bytes, ${image.width} x ${image.height}.`).join(''));
        }

        async function previewFields() {
            await task('Applying form values...', async () => {
                const document = await filledDocument(page.doc, customFont);
                const next = await pdfjsLib.getDocument({ data: await document.save(), fontExtraProperties: true }).promise;
                const previous = page.doc.render;
                page.doc.render = next;
                setRenderRevision(version => version + 1);
                await previous.destroy();
            });
        }

        async function undo(direction) {
            if (busy || !page) return;
            const history = histories.current.get(page.id);
            if (!history || history.index + direction < 0 || history.index + direction >= history.values.length) return;
            const selected = canvas.current.getActiveObjects();
            if (selected.length) undoSelection.current = selected.map(object => object.name);
            selected.forEach(object => object.exitEditing?.());
            canvas.current.discardActiveObject();
            await task('Restoring annotation...', async () => {
                restoring.current = true;
                try {
                    history.index += direction;
                    await new Promise(resolve => canvas.current.loadFromJSON(history.values[history.index], resolve));
                    canvas.current.getObjects().forEach(prepareObject);
                    const restored = canvas.current.getObjects().filter(object => undoSelection.current?.includes(object.name));
                    if (restored.length) canvas.current.setActiveObject(restored.length === 1 ? restored[0] : new fabric.ActiveSelection(restored, { canvas: canvas.current }));
                    page.overlay = canvas.current.toJSON(OBJECT_PROPS); canvas.current.renderAll(); setDirty(true);
                    setSelectionVersion(version => version + 1);
                } finally { restoring.current = false; }
            });
        }

        useEffect(() => {
            function pointer(event) { pointerInside.current = !!editorRef.current?.contains(event.target); }
            function shortcuts(event) {
                if (event.defaultPrevented || event.isComposing || !page || event.target.closest?.('.pdf-dialog')) return;
                const object = canvas.current?.getActiveObject();
                const fabricInput = event.target.hasAttribute?.('data-fabric-hiddentextarea') && object?.isEditing;
                if (!fabricInput && !editorRef.current?.contains(event.target) && !pointerInside.current) return;
                const input = event.target.closest?.('input,textarea,select,[contenteditable="true"]');
                if (input && !fabricInput && input.getAttribute('aria-label') !== 'Selected PDF text') return;
                const key = event.key.toLowerCase(), command = event.ctrlKey || event.metaKey;
                const textObjects = canvas.current?.getActiveObjects().filter(item => ['i-text', 'textbox', 'text'].includes(item.type)) || [];
                if (fabricInput && key === 'enter' && !command && !event.shiftKey && !event.altKey
                    && object.selectionStart === object.selectionEnd && continueList(object)) {
                    event.preventDefault(); event.stopImmediatePropagation();
                } else if (command && !event.altKey && (key === '[' || key === ']') && textObjects.length === 1) {
                    event.preventDefault(); event.stopImmediatePropagation();
                    if (!busy) transformLines(lines => indentLines(lines, key === ']' ? 1 : -1));
                } else if (command && !event.altKey && (key === 'z' || key === 'y')) {
                    event.preventDefault(); event.stopImmediatePropagation();
                    if (!busy) undo(key === 'y' || event.shiftKey ? 1 : -1);
                } else if (command && !event.altKey && textObjects.length && ['a', 'b', 'i', 'u'].includes(key)) {
                    event.preventDefault(); event.stopImmediatePropagation();
                    if (busy) return;
                    if (key === 'a') {
                        if (textObjects.length === 1 && textObjects[0].enterEditing) {
                            textObjects[0].enterEditing(); textObjects[0].selectAll(); textObjects[0].hiddenTextarea?.focus();
                        }
                    } else if (key === 'b') formatSelection({ fontWeight: textObjects.every(item => item.fontWeight === 'bold') ? 'normal' : 'bold' });
                    else if (key === 'i') formatSelection({ fontStyle: textObjects.every(item => item.fontStyle === 'italic') ? 'normal' : 'italic' });
                    else formatSelection({ underline: !textObjects.every(item => item.underline) });
                } else if (!command && !input && !object?.isEditing && (key === 'delete' || key === 'backspace') && object) {
                    event.preventDefault(); event.stopImmediatePropagation();
                    if (!busy) deleteSelection();
                }
            }
            document.addEventListener('pointerdown', pointer, true);
            window.addEventListener('keydown', shortcuts, true);
            return () => { document.removeEventListener('pointerdown', pointer, true); window.removeEventListener('keydown', shortcuts, true); };
        }, [page, busy]);

        function close() {
            if ((dirty || markdown) && !window.confirm('Close PDF Editor and discard this workspace and any Markdown draft? Export a PDF first to keep your changes.')) return;
            onClose();
        }

        useEffect(() => {
            function unload(event) { if (dirty || markdown) { event.preventDefault(); event.returnValue = ''; } }
            function escape(event) {
                if (event.key !== 'Escape') return;
                event.preventDefault(); event.stopImmediatePropagation();
                if (busy && (markdown || mergeFiles !== null)) return;
                if (markdown) { if (window.confirm('Discard this Markdown draft?')) setMarkdown(null); }
                else if (mergeFiles !== null) setMergeFiles(null);
                else close();
            }
            window.addEventListener('beforeunload', unload);
            window.addEventListener('keydown', escape, true);
            return () => { window.removeEventListener('beforeunload', unload); window.removeEventListener('keydown', escape, true); };
        }, [dirty, !!markdown, mergeFiles !== null, busy]);

        async function exportPdf(indices, images = false) {
            await task('Exporting PDF...', async () => {
                setExportNote('');
                indices = indices || parsePages(range, pages.length);
                const target = exportSize(exportLimit, exportUnit);
                const result = await PDFLib.PDFDocument.create();
                result.setTitle(title); result.setAuthor(author); result.setCreator('Daily PDF Editor');
                const documents = new Map();
                const renders = new Map();
                const fonts = new Map();
                const rasterFonts = new Set();
                let redactedPages = 0;
                try {
                for (const index of indices) {
                    const item = pages[index];
                    if (!documents.has(item.doc)) documents.set(item.doc, await filledDocument(item.doc, customFont));
                    if (item.overlay?.objects?.some(object => object.annotationKind === 'redaction')) {
                        if (!renders.has(item.doc)) renders.set(item.doc, await pdfjsLib.getDocument({ data: await documents.get(item.doc).save() }).promise);
                        const sourcePage = await renders.get(item.doc).getPage(item.number);
                        const viewport = sourcePage.getViewport({ scale: 3, rotation: item.rotation });
                        const sheet = document.createElement('canvas');
                        sheet.width = viewport.width; sheet.height = viewport.height;
                        const context = sheet.getContext('2d');
                        context.fillStyle = '#ffffff'; context.fillRect(0, 0, sheet.width, sheet.height);
                        await sourcePage.render({ canvasContext: context, viewport, intent: 'print' }).promise;
                        const layer = new fabric.StaticCanvas(document.createElement('canvas'), { width: viewport.width / 3, height: viewport.height / 3 });
                        try {
                            await new Promise(resolve => layer.loadFromJSON(item.overlay, resolve));
                            const image = new Image();
                            await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = layer.toDataURL({ format: 'png', multiplier: 3 }); });
                            context.drawImage(image, 0, 0);
                        } finally { layer.dispose(); }
                        const flattened = result.addPage([viewport.width / 3, viewport.height / 3]);
                        flattened.drawImage(await result.embedPng(sheet.toDataURL('image/png')), { x: 0, y: 0, width: viewport.width / 3, height: viewport.height / 3 });
                        redactedPages++;
                        continue;
                    }
                    const source = documents.get(item.doc).getPage(item.number - 1);
                    const embedded = await result.embedPage(source);
                    const placement = pagePlacement(embedded.width, embedded.height, item.rotation);
                    const output = result.addPage([placement.width, placement.height]);
                    output.drawPage(embedded, { x: placement.x, y: placement.y, width: embedded.width,
                        height: embedded.height, rotate: PDFLib.degrees(placement.angle) });
                    if (item.overlay?.objects?.length) {
                        const scratch = document.createElement('canvas');
                        const layer = new fabric.StaticCanvas(scratch, { width: placement.width, height: placement.height });
                        try {
                            await new Promise(resolve => layer.loadFromJSON(item.overlay, resolve));
                            const objects = layer.getObjects().slice();
                            layer.clear();
                            async function flushRaster() {
                                if (!layer.getObjects().length) return;
                                const image = await result.embedPng(layer.toDataURL({ format: 'png', multiplier: 3 }));
                                output.drawImage(image, { x: 0, y: 0, width: placement.width, height: placement.height });
                                layer.clear();
                            }
                            for (const object of objects) {
                                if (['i-text', 'textbox', 'text'].includes(object.type)) {
                                    await flushRaster();
                                    if (await drawAnnotationText(result, output, item.doc, object, customFont, fonts)) continue;
                                    rasterFonts.add(object.sourceFontLabel || object.fontFamily);
                                }
                                layer.add(object);
                            }
                            await flushRaster();
                        } finally { layer.dispose(); }
                    }
                }
                } finally { await Promise.all([...renders.values()].map(render => render.destroy())); }
                const bytes = await result.save();
                if (images) { await exportPageImages(bytes, indices, target); return; }
                const compressed = target ? await compressPdf(bytes, target, setBusy) : { bytes, rasterized: false };
                download(compressed.bytes, (name || 'document') + '-edited.pdf');
                const notes = [];
                notes.push('PDF: ' + compressed.bytes.length.toLocaleString() + ' bytes' + (target ? ' (limit ' + target.toLocaleString() + ')' : '') + '.');
                if (compressed.rasterized) notes.push('Compressed to page images at ' + compressed.dpi + ' DPI; searchable text and vector content were removed.');
                if (redactedPages) notes.push(`${redactedPages} page${redactedPages === 1 ? ' was' : 's were'} flattened to images so blacked-out content is permanently removed; ${redactedPages === 1 ? 'it is' : 'they are'} no longer text-searchable.`);
                if (rasterFonts.size) notes.push('Some text uses image export because its font data or styling cannot be embedded: '
                    + [...rasterFonts].join(', ') + '. Load the matching TTF/OTF for plain text to enable sharp vector export.');
                setExportNote(notes.join(' '));
                if (indices.length === pages.length) setDirty(false);
            });
        }

        async function extract(ocr) {
            await task(ocr ? 'Recognizing scanned text...' : 'Extracting PDF text...', async () => {
                const source = await page.doc.render.getPage(page.number);
                if (!ocr) {
                    const content = await source.getTextContent();
                    setText(content.items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join(''));
                } else {
                    await loadScript('Tesseract', 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
                    const worker = await Tesseract.createWorker(ocrLanguage.current);
                    try {
                        const { data } = await worker.recognize(background.current);
                        if (alive.current) setText(data.text);
                    } finally { await worker.terminate(); }
                }
            });
        }
        const ocrLanguage = useRef('eng');

        async function newPage() {
            await task('Generating blank page...', async () => {
                await loadScript('PDFDocument', 'https://cdn.jsdelivr.net/npm/pdfkit@0.15.0/js/pdfkit.standalone.js');
                const generated = new PDFDocument({ size: 'A4', margin: 0 });
                const chunks = [];
                const bytes = await new Promise((resolve, reject) => {
                    generated.on('data', chunk => chunks.push(chunk));
                    generated.on('error', reject);
                    generated.on('end', () => resolve(new Blob(chunks)));
                    generated.end();
                });
                await importFiles([new File([bytes], 'blank.pdf', { type: 'application/pdf' })]);
            });
        }

        async function loadFont(file) {
            await task('Loading font...', async () => {
                await loadScript('fontkit', 'https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js');
                const bytes = new Uint8Array(await file.arrayBuffer());
                const parsed = fontkit.create(bytes);
                const variant = sourceFontStyle(parsed.familyName + ' ' + parsed.subfamilyName);
                const family = 'DailyPdf-' + crypto.randomUUID();
                const face = new FontFace(family, bytes, { weight: variant.weight, style: variant.style });
                await face.load(); document.fonts.add(face);
                setCustomFont({ family, label: parsed.familyName || file.name, bytes, fontWeight: variant.weight, fontStyle: variant.style });
                setFontFamily(family); setFontWeight(variant.weight); setFontStyle(variant.style);
                if (['i-text', 'textbox', 'text'].includes(canvas.current?.getActiveObject()?.type)) formatSelection({ fontFamily: family, fontWeight: variant.weight, fontStyle: variant.style });
            });
        }

        useEffect(() => {
            if (!signature) return;
            let cancelled = false;
            task('Opening signature pad...', async () => {
                await loadScript('Konva', 'https://cdn.jsdelivr.net/npm/konva@9.3.18/konva.min.js');
                if (cancelled) return;
                const stage = new Konva.Stage({ container: stageHost.current, width: Math.min(500, stageHost.current.clientWidth), height: 180 });
                const layer = new Konva.Layer(); stage.add(layer); signatureStage.current = stage;
                let line;
                stage.on('mousedown touchstart', event => {
                    event.evt.preventDefault(); const point = stage.getPointerPosition();
                    line = new Konva.Line({ points: [point.x, point.y], stroke: color, strokeWidth: 3, lineCap: 'round', lineJoin: 'round' }); layer.add(line);
                });
                stage.on('mousemove touchmove', event => {
                    if (!line) return; event.evt.preventDefault(); const point = stage.getPointerPosition();
                    line.points(line.points().concat([point.x, point.y]));
                });
                stage.on('mouseup touchend mouseleave', () => { line = null; });
            });
            return () => { cancelled = true; signatureStage.current?.destroy(); signatureStage.current = null; };
        }, [signature]);

        function changePages(next, selected) { setPages(next); setActive(Math.max(0, Math.min(selected, next.length - 1))); setDirty(true); }
        const selected = canvas.current?.getActiveObject();
        const selectedObjects = canvas.current?.getActiveObjects() || [];
        const selectedTexts = selectedObjects.filter(object => ['i-text', 'textbox', 'text'].includes(object.type));
        const isText = selectedTexts.length > 0 && selectedTexts.length === selectedObjects.length;
        const textProfile = selectedTexts[0];
        const selectedFill = isText ? textProfile.fill : selected?.fill;
        const multipleText = isText && selectedTexts.length > 1;
        const family = isText ? selectedTexts.every(object => object.fontFamily === textProfile.fontFamily) ? textProfile.fontFamily : '__mixed__' : fontFamily;
        const bold = isText ? selectedTexts.every(object => object.fontWeight === 'bold') : fontWeight === 'bold';
        const italic = isText ? selectedTexts.every(object => object.fontStyle === 'italic') : fontStyle === 'italic';
        const fonts = [...FONT_CHOICES];
        const bounds = selected?.getBoundingRect(true, true);
        const stickyPrefix = selectedObjects.map(linkedPrefix).find(prefix => prefix?.startsWith('sticky-'));
        const stickyCard = stickyPrefix && canvas.current.getObjects().find(item => item.name === stickyPrefix + 'card');
        if (customFont) fonts.push({ family: customFont.family, label: customFont.label });
        if (!fonts.some(font => font.family === family)) fonts.unshift({ family, label: family === '__mixed__' ? 'Mixed fonts' : textProfile?.sourceFontLabel || 'Document font' });
        void selectionVersion;
        void fieldRevision;
        const button = (icon, label, action, disabled = false, extra = {}) => h('button', {
            className: 'btn', type: 'button', title: label, 'aria-label': label,
            disabled: !!busy || disabled, onClick: action, ...extra
        }, h(Icon, { name: icon, size: 18 }));
        const numeric = (label, value, min, max, action, step = 1) => h('label', { className: 'pdf-numeric' }, label,
            h('input', { className: 'finput', type: 'number', 'aria-label': label, value, min, max, step, disabled: !!busy,
                onChange: event => {
                    const number = Number(event.target.value);
                    if (event.target.value !== '' && Number.isFinite(number)) action(Math.max(min, Math.min(max, number)));
                } }));

        return h(Panel, { title: 'PDF Editor', icon: 'FilePenLine', onClose: close, initW: 1200, initH: 780, storageKey: 'pdf-editor', className: 'pdf-window pdf-background-' + workspaceBackground, panelRef: editorRef },
            h('div', { className: 'pdf-toolbar pdf-document-bar' },
                button('FolderOpen', 'Open or merge PDFs', () => fileInput.current.click(), !ready),
                h('button', { className: 'btn pdf-toolbar-label', disabled: !ready || !!busy, onClick: () => { setError(''); setMergeFiles([]); } },
                    h(Icon, { name: 'Files', size: 18 }), 'Merge PDFs'),
                h('button', { className: 'btn pdf-toolbar-label', disabled: !ready || !!busy, onClick: () => openMarkdown() },
                    h(Icon, { name: 'FileCode', size: 18 }), 'Markdown'),
                h('button', { className: 'btn pdf-toolbar-label', disabled: !ready || !!busy || !page, onClick: editPageMarkdown },
                    h(Icon, { name: 'FilePenLine', size: 18 }), 'Edit page in Markdown'),
                button('FilePlus2', 'Add blank A4 page', newPage, !ready),
                h('span', { className: 'pdf-document-name', title: name }, name),
                h('span', { className: 'pdf-status', role: 'status' }, busy || (dirty ? 'Unsaved changes' : pages.length ? 'Exported' : 'No PDF open')),
                button('Undo2', 'Undo annotation', () => undo(-1), !page, { title: 'Undo (Ctrl/Cmd+Z)' }), button('Redo2', 'Redo annotation', () => undo(1), !page, { title: 'Redo (Ctrl/Cmd+Shift+Z or Ctrl+Y)' }),
                h('details', { className: 'pdf-export' },
                    h('summary', { 'aria-label': 'Export options' }, h(Icon, { name: 'Download', size: 18 }), h('span', null, 'Export')),
                    h('div', { className: 'pdf-export-menu' },
                        h('label', null, 'Filename', h('input', { className: 'finput', 'aria-label': 'Export filename', value: name, onChange: event => setName(event.target.value) })),
                        h('label', null, 'Format', h('select', { className: 'fselect', 'aria-label': 'Export format', value: exportFormat, onChange: event => setExportFormat(event.target.value) },
                            [['pdf', 'PDF document'], ['png', 'PNG images'], ['jpg', 'JPG images'], ['jpeg', 'JPEG images'], ['webp', 'WebP images'], ['text', 'Extracted text TXT'], ['fields', 'Form values JSON']].map(([value, label]) => h('option', { value, key: value }, label)))),
                        !['text', 'fields'].includes(exportFormat) && h(React.Fragment, null,
                            h('label', null, 'Pages', h('input', { className: 'finput', 'aria-label': 'Export page range', placeholder: 'All pages or 1,3-5', value: range, onChange: event => setRange(event.target.value) })),
                            h('label', null, exportFormat === 'pdf' ? 'Size limit' : 'Size limit per image',
                                h('input', { type: 'number', min: 0, className: 'finput', 'aria-label': 'Export size limit', placeholder: 'No limit', value: exportLimit, onChange: event => setExportLimit(event.target.value) })),
                            h('label', null, 'Unit', h('select', { className: 'fselect', 'aria-label': 'Export size unit', value: exportUnit, onChange: event => setExportUnit(event.target.value) },
                                [['bytes', 'Bytes'], ['KB', 'KB'], ['MB', 'MB']].map(([value, label]) => h('option', { key: value, value }, label)))),
                            h('span', { className: 'pdf-hint' }, exportFormat === 'pdf'
                                ? 'Small limits may rasterize pages and remove searchable text.'
                                : 'Multiple pages download as ZIP. Small limits may reduce image dimensions.')),
                        h('button', { className: 'btn primary', disabled: !!busy || !page || (exportFormat === 'text' && !text) || (exportFormat === 'fields' && !page.doc.fields.length),
                            onClick: exportSelection }, h(Icon, { name: 'Download', size: 18 }), 'Download')))),
            error && h('div', { className: 'pdf-error', role: 'alert' }, error, !ready && button('RefreshCw', 'Retry loading libraries', () => task('Loading PDF libraries...', async () => { await loadCore(); setReady(true); }))),
            page && manualReplacement && manualReplacement.pageId === page.id && h('div', { className: 'pdf-manual-replacement', role: 'region', 'aria-label': 'Manual text replacement' },
                h('p', null, 'Automatic style detection could not safely replace this text. Manual replacement uses the chosen colors and may cover nearby text, borders or watermarks. Undo restores the original.'),
                h('div', { className: 'pdf-format-actions' },
                    h('label', { className: 'pdf-color-control' }, 'Background', h('input', { type: 'color', value: paperColor, 'aria-label': 'Manual replacement background',
                        onChange: event => setPaperColor(event.target.value) })),
                    h('label', { className: 'pdf-color-control' }, 'Text', h('input', { type: 'color', value: color, 'aria-label': 'Manual replacement text color',
                        onChange: event => setColor(event.target.value) })),
                    h('button', { className: 'btn primary', disabled: !!busy, onClick: () => replaceText(manualReplacement.target, true) }, 'Replace anyway with chosen colors'),
                    h('button', { className: 'btn', disabled: !!busy, onClick: () => { setManualReplacement(null); setError(''); } }, 'Cancel replacement'))),
            exportNote && h('div', { className: 'pdf-export-note', role: 'status' }, exportNote),
            h('div', { className: 'pdf-ribbon-tabs', role: 'tablist', 'aria-label': 'PDF tools' },
                [['edit', 'Edit', 'TextCursorInput'], ['annotate', 'Annotate', 'MessageSquareText'], ['pages', 'Pages', 'Layers2'], ['review', 'Review', 'ClipboardCheck']].map(([id, label, icon]) =>
                    h('button', { key: id, role: 'tab', 'aria-selected': toolsTab === id, onClick: () => { setToolsTab(id); if (id !== 'edit') setMode('select'); } }, h(Icon, { name: icon, size: 16 }), label))),
            h('div', { className: 'pdf-toolbar pdf-ribbon', role: 'toolbar', 'aria-label': toolsTab + ' tools' },
                toolsTab === 'edit' && h(React.Fragment, null,
                button('MousePointer2', 'Select and resize', () => setMode('select'), !page, { 'aria-pressed': mode === 'select' }),
                button('Type', 'Add editable text box', () => addObject(new fabric.Textbox('Text', { left: 40, top: 40, width: 240, fontSize, fill: color, fontFamily, fontWeight, fontStyle })), !page),
                button('TextCursorInput', 'Click to fill text', () => setMode('fill-text'), !page, { 'aria-pressed': mode === 'fill-text' }),
                button('SquareCheck', 'Click to place a check mark', () => setMode('fill-check'), !page, { 'aria-pressed': mode === 'fill-check' }),
                button('CalendarDays', 'Click to place today\'s date', () => setMode('fill-date'), !page, { 'aria-pressed': mode === 'fill-date' }),
                button('FilePenLine', 'Replace visible PDF text', () => setMode('replace'), !page || !textTargets.length, { 'aria-pressed': mode === 'replace' })),
                toolsTab === 'annotate' && h(React.Fragment, null,
                button('Pencil', 'Freehand drawing', () => setMode('draw'), !page, { 'aria-pressed': mode === 'draw' }),
                button('Eraser', 'Eraser: click or drag over annotations to remove them', () => setMode('erase'), !page, { 'aria-pressed': mode === 'erase' }),
                button('Highlighter', 'Highlight text: click a line or drag across text', () => setMode('highlight'), !page, { 'aria-pressed': mode === 'highlight' }),
                h('div', { className: 'pdf-swatches', role: 'group', 'aria-label': 'Highlight color' },
                    HIGHLIGHT_COLORS.map(([value, label]) => h('button', { key: value, type: 'button', title: label + ' highlight', 'aria-label': label + ' highlight',
                        'aria-pressed': highlightColor === value, style: { background: value }, onClick: () => { setHighlightColor(value); setMode('highlight'); } }))),
                h('span', { className: 'pdf-ribbon-divider' }),
                !page ? button('Shapes', 'Shapes', null, true) : h('details', { className: 'pdf-popover' },
                    h('summary', { title: 'Shapes', 'aria-label': 'Shapes' }, h(Icon, { name: 'Shapes', size: 18 }), h(Icon, { name: 'ChevronDown', size: 12 })),
                    h('div', { className: 'pdf-popover-menu' }, h('h4', null, 'Shapes'),
                        h('div', { className: 'pdf-shape-grid' }, SHAPES.map(shape => h('button', { key: shape[0], type: 'button', title: shape[0], 'aria-label': 'Insert ' + shape[0],
                            onClick: event => { insertShape(shape); closeMenu(event); } },
                            h('svg', { viewBox: '-8 -8 116 116', width: 22, height: 22, 'aria-hidden': true },
                                h('path', { d: shape[1], fill: shape[2] ? 'none' : 'currentColor', fillOpacity: 0.14, stroke: 'currentColor',
                                    strokeWidth: 7, strokeLinecap: 'round', strokeLinejoin: 'round' }))))))),
                !page ? button('Table', 'Insert table', null, true) : h('details', { className: 'pdf-popover', onToggle: event => { if (!event.currentTarget.open) setTableHover({ rows: 0, cols: 0 }); } },
                    h('summary', { title: 'Insert table', 'aria-label': 'Insert table' }, h(Icon, { name: 'Table', size: 18 }), h(Icon, { name: 'ChevronDown', size: 12 })),
                    h('div', { className: 'pdf-popover-menu' }, h('h4', null, 'Insert table'),
                        h('div', { className: 'pdf-table-grid', onMouseLeave: () => setTableHover({ rows: 0, cols: 0 }) },
                            Array.from({ length: 80 }, (_, cell) => {
                                const rows = Math.floor(cell / 10) + 1, cols = cell % 10 + 1;
                                return h('button', { key: cell, type: 'button', 'aria-label': `Insert ${rows} by ${cols} table`,
                                    'data-active': rows <= tableHover.rows && cols <= tableHover.cols,
                                    onMouseEnter: () => setTableHover({ rows, cols }), onFocus: () => setTableHover({ rows, cols }),
                                    onClick: event => { insertTable(rows, cols); closeMenu(event); } });
                            })),
                        h('div', { className: 'pdf-table-size', 'aria-live': 'polite' }, tableHover.rows ? `${tableHover.rows} × ${tableHover.cols} table` : 'Hover to choose rows and columns'))),
                button('StickyNote', 'Add sticky note', addSticky, !page),
                button('ImagePlus', 'Add image', () => imageInput.current.click(), !page),
                button('Signature', 'Draw signature', () => setSignature(true), !page),
                h('span', { className: 'pdf-ribbon-divider' }),
                h('select', { className: 'fselect pdf-stamp-choice', 'aria-label': 'Review stamp', value: stamp, onChange: event => setStamp(event.target.value) },
                    ['Reviewed', 'Approved', 'Draft', 'Confidential'].map(value => h('option', { value, key: value }, value))),
                button('Stamp', 'Add review stamp', () => addObject(new fabric.IText(stamp.toUpperCase(), { left: 80, top: 140,
                    fontFamily, fontWeight: 'bold', fontSize: 28, fill: color, angle: -12, annotationKind: 'stamp' })), !page)),
                toolsTab === 'pages' && h(React.Fragment, null,
                    button('ArrowUp', 'Move page earlier', () => { const next = [...pages]; [next[active - 1], next[active]] = [next[active], next[active - 1]]; changePages(next, active - 1); }, !page || active === 0),
                    button('ArrowDown', 'Move page later', () => { const next = [...pages]; [next[active + 1], next[active]] = [next[active], next[active + 1]]; changePages(next, active + 1); }, !page || active === pages.length - 1),
                    button('Copy', 'Duplicate page', () => { const next = [...pages]; next.splice(active + 1, 0, { ...page, id: crypto.randomUUID(), markdown: null, overlay: JSON.parse(JSON.stringify(page.overlay)) }); changePages(next, active + 1); }, !page),
                    button('FileCode', 'Edit Markdown source', editPageMarkdown, !page),
                    button('RotateCw', 'Rotate page clockwise', () => {
                        const transform = [0, 1, -1, 0, canvas.current.height, 0];
                        canvas.current.getObjects().forEach(object => fabric.util.applyTransformToObject(object, fabric.util.multiplyTransformMatrices(transform, object.calcTransformMatrix())));
                        capture(); histories.current.set(page.id, { values: [page.overlay], index: 0 });
                        setPages(previous => previous.map(item => item.id === page.id ? { ...item, rotation: (item.rotation + 90) % 360 } : item));
                    }, !page),
                    button('Trash2', 'Delete current page', () => { if (window.confirm('Delete this page and its annotations?')) changePages(pages.filter(item => item.id !== page.id), active); }, !page)),
                toolsTab === 'review' && h(React.Fragment, null,
                    h('input', { className: 'finput pdf-watermark', 'aria-label': 'Watermark text', value: watermark, onChange: event => setWatermark(event.target.value) }),
                    h('details', { className: 'pdf-popover' },
                        h('summary', { title: 'Watermark settings', 'aria-label': 'Watermark settings' }, h(Icon, { name: 'SlidersHorizontal', size: 18 })),
                        h('div', { className: 'pdf-popover-menu pdf-watermark-menu' },
                            numeric('Size', watermarkStyle.size, 8, 200, size => setWatermarkStyle(style => ({ ...style, size }))),
                            numeric('Opacity (%)', watermarkStyle.opacity, 2, 100, opacity => setWatermarkStyle(style => ({ ...style, opacity }))),
                            numeric('Angle', watermarkStyle.angle, -90, 90, angle => setWatermarkStyle(style => ({ ...style, angle }))),
                            h('label', null, 'Color', h('input', { type: 'color', 'aria-label': 'Watermark color', value: watermarkStyle.color,
                                onChange: event => setWatermarkStyle(style => ({ ...style, color: event.target.value })) })),
                            h('label', { className: 'wide' }, 'Layout', h('select', { className: 'fselect', 'aria-label': 'Watermark layout', value: watermarkStyle.layout,
                                onChange: event => setWatermarkStyle(style => ({ ...style, layout: event.target.value })) },
                                h('option', { value: 'center' }, 'Centered'), h('option', { value: 'tile' }, 'Tiled across page'))))),
                    button('Waves', 'Apply watermark to all pages', () => decoratePages('watermark'), !page || !watermark.trim()),
                    button('Trash2', 'Remove watermark from all pages', () => decoratePages('watermark', true), !page),
                    h('span', { className: 'pdf-ribbon-divider' }),
                    numeric('Start number', numberStart, 1, 99999, setNumberStart),
                    button('ListOrdered', 'Number all pages', () => decoratePages('page-number'), !page),
                    h('span', { className: 'pdf-ribbon-divider' }),
                    button('EyeOff', 'Black out: click a line or drag over sensitive content', () => setMode('blackout'), !page, { 'aria-pressed': mode === 'blackout' }),
                    h('select', { className: 'fselect', 'aria-label': 'Sensitive content type', value: redactPattern, onChange: event => setRedactPattern(event.target.value) },
                        h('option', { value: 'text' }, 'Text'), h('option', { value: 'email' }, 'Emails'), h('option', { value: 'phone' }, 'Phones'), h('option', { value: 'number' }, 'Numbers/IDs')),
                    redactPattern === 'text' && h('input', { className: 'finput pdf-redact-query', 'aria-label': 'Text to black out', placeholder: 'Text to black out',
                        value: redactQuery, onChange: event => setRedactQuery(event.target.value), onKeyDown: event => { if (event.key === 'Enter') redactMatches(); } }),
                    button('Search', 'Find and black out on all pages', redactMatches, !page || (redactPattern === 'text' && !redactQuery.trim()))),
                h('div', { className: 'pdf-view-controls' },
                toolsTab === 'edit' && h('select', { className: 'fselect pdf-selection-scope', 'aria-label': 'PDF text selection scope', value: textScope,
                    title: 'Statement selects adjacent text on one line; Text run selects an individual PDF fragment',
                    onChange: event => { setTextScope(event.target.value); clearSelection(); } },
                    h('option', { value: 'statement' }, 'Statement'), h('option', { value: 'run' }, 'Text run')),
                button('Sun', 'White editor background', () => chooseBackground('white'), false, { 'aria-pressed': workspaceBackground === 'white' }),
                button('Moon', 'Black editor background', () => chooseBackground('black'), false, { 'aria-pressed': workspaceBackground === 'black' }),
                button('Scan', 'Fit page to workspace', () => {
                    setZoom(Math.max(0.2, Math.min(2, (viewportRef.current.clientWidth - 32) / page.width, (viewportRef.current.clientHeight - 32) / page.height)));
                }, !page),
                h('select', { className: 'fselect', value: zoom, 'aria-label': 'PDF zoom', onChange: event => setZoom(Number(event.target.value)) },
                    [...new Set([0.5, 0.75, 1, 1.25, 1.5, 2, zoom])].sort((left, right) => left - right).map(value => h('option', { key: value, value }, Math.round(value * 100) + '%'))))),
            h('div', { className: 'pdf-layout' },
                h('aside', { className: 'pdf-pages', 'aria-label': 'PDF pages' },
                    pages.map((item, index) => h('button', { key: item.id, className: 'pdf-page' + (active === index ? ' active' : ''), disabled: !!busy,
                        'aria-current': active === index ? 'page' : undefined, onClick: () => { setActive(index); setText(''); } },
                        h(Icon, { name: 'FileText', size: 22 }), h('strong', null, 'Page ' + (index + 1)), h('small', null, item.doc.name), h('small', null, item.rotation + ' deg')))),
                h('main', { ref: viewportRef, className: 'pdf-viewport', 'aria-label': 'PDF page workspace', style: { pointerEvents: busy ? 'none' : undefined },
                    onPointerDown: event => {
                        if (!event.target.closest('canvas,.canvas-container,.pdf-text-targets button')) clearSelection();
                    } },
                    !page ? h('div', { className: 'pdf-empty' }, h(Icon, { name: 'FilePenLine', size: 48 }),
                        h('h2', null, 'PDF Editor'), h('button', { className: 'btn primary', disabled: !ready || !!busy, onClick: () => fileInput.current.click() }, h(Icon, { name: 'FolderOpen' }), 'Open PDFs')) :
                        h('div', { style: { width: (page.width || 595) * zoom, height: (page.height || 842) * zoom, margin: 'auto' } },
                            h('div', { className: 'pdf-sheet', style: { width: page.width || 595, height: page.height || 842, transform: 'scale(' + zoom + ')', transformOrigin: 'top left' } },
                                h('canvas', { ref: background, className: 'pdf-background' }), h('canvas', { ref: overlay }),
                                mode === 'replace' && h('div', { className: 'pdf-text-targets' }, selectionTargets.map(target =>
                                    h('button', { key: target.id, type: 'button', 'aria-label': 'Replace text: ' + target.text,
                                        title: target.text, onClick: () => replaceText(target),
                                        style: { left: target.x, top: target.y, width: target.width, height: target.height * 1.3,
                                            transform: 'rotate(' + target.angle + 'deg)' } }))),
                                pageViewport && page.doc.signatures.length > 0 && !['highlight', 'blackout', 'erase', 'draw'].includes(mode)
                                && h('div', { className: 'pdf-signature-targets' }, page.doc.signatures.flatMap(signature => signature.widgets
                                    .filter(widget => widget.pageIndex === page.number - 1 && widget.rect.width > 0 && widget.rect.height > 0)
                                    .map((widget, index) => {
                                        const bounds = pdfjsLib.Util.normalizeRect(pageViewport.convertToViewportRectangle([widget.rect.x, widget.rect.y,
                                            widget.rect.x + widget.rect.width, widget.rect.y + widget.rect.height]));
                                        const status = signatureResults[page.doc.id + ':' + signature.name]?.status;
                                        return h('button', { key: signature.name + index, type: 'button', 'data-status': status,
                                            title: (signature.signed ? 'Click to verify signature: ' : 'Unsigned signature field: ') + signature.name,
                                            'aria-label': 'Verify signature ' + signature.name, onClick: () => verifyDocumentSignature(signature),
                                            style: { left: bounds[0], top: bounds[1], width: bounds[2] - bounds[0], height: bounds[3] - bounds[1] } },
                                            h(Icon, { name: status === 'valid' ? 'ShieldCheck' : 'ShieldAlert', size: 14 }));
                                    })))))),
                h('aside', { className: 'pdf-inspector' },
                    h('div', { className: 'pdf-inspector-tabs', role: 'tablist', 'aria-label': 'PDF properties' },
                        [['format', 'Format'], ['forms', 'Forms'], ['text', 'Text'], ['verify', 'Verify'], ['document', 'Doc']].map(([id, label]) =>
                            h('button', { key: id, role: 'tab', 'aria-selected': inspectorTab === id, onClick: () => setInspectorTab(id) }, label))),
                    inspectorTab === 'format' && h('div', { className: 'pdf-format-panel' },
                        (!selected || isText) && h(React.Fragment, null,
                            h('label', null, 'Font', h('div', { className: 'pdf-font-picker' },
                                h('select', { className: 'fselect', value: family, 'aria-label': 'Text font', disabled: !!busy,
                                    style: { fontFamily: family },
                                    onChange: event => { setFontFamily(event.target.value); formatSelection({ fontFamily: event.target.value }); } },
                                    fonts.map(font => h('option', { value: font.family, key: font.family, disabled: font.family === '__mixed__', style: { fontFamily: font.family } }, font.label))),
                                button('FileType', 'Load custom TTF or OTF font', () => fontInput.current.click(), !page))),
                            isText && !multipleText && textProfile.sourceFontLabel && h('p', { className: 'pdf-font-source' },
                                (textProfile.sourceFontMethod === 'device' ? 'Matched device font: '
                                    : textProfile.sourceFontExact ? 'Embedded font: ' : textProfile.sourceFontKey ? 'Font fallback: ' : 'Original font: ') + textProfile.sourceFontLabel),
                            isText && !multipleText && textProfile.sourceFontKey && !textProfile.sourceFontExact
                                && h('p', { className: 'pdf-font-source', role: 'status',
                                    title: page.doc.fonts.get(textProfile.sourceFontKey)?.recoveryErrors?.join('\n') },
                                    (textProfile.sourceFontMethod === 'partial'
                                        ? 'The embedded font lacks some characters. Keeping its available glyphs; missing characters use '
                                        : 'The original font is unavailable or lacks these characters. Using ') +
                                    (page.doc.fonts.get(textProfile.sourceFontKey)?.fallback || textProfile.fontFamily) +
                                    '. Load the matching full TTF/OTF font for an exact match.'),
                            multipleText && h(React.Fragment, null,
                                h('p', { className: 'pdf-font-source' }, selectedTexts.length + ' selected text runs. Mixed-style statements are selected together; edit their wording one run at a time.'),
                                h('button', { className: 'btn', disabled: !!busy, onClick: () => {
                                    const object = selectedTexts[0];
                                    setTextScope('run'); textScopeRef.current = 'run';
                                    selectObjects([object]); object.enterEditing(); object.selectAll(); object.hiddenTextarea?.focus();
                                } }, 'Edit individual text runs')),
                            numeric('Text size', isText ? textProfile.fontSize : fontSize, 6, 144, value => { setFontSize(value); formatSelection({ fontSize: value }); }),
                            h('div', { className: 'pdf-format-actions' },
                                button('Bold', 'Bold', () => { const value = bold ? 'normal' : 'bold'; setFontWeight(value); formatSelection({ fontWeight: value }); }, !page, { 'aria-pressed': bold, title: 'Bold selected statement (Ctrl/Cmd+B)' }),
                                button('Italic', 'Italic', () => { const value = italic ? 'normal' : 'italic'; setFontStyle(value); formatSelection({ fontStyle: value }); }, !page, { 'aria-pressed': italic, title: 'Italic selected statement (Ctrl/Cmd+I)' }),
                                button('Underline', 'Underline', () => formatSelection({ underline: !selectedTexts.every(object => object.underline) }), !isText, { 'aria-pressed': isText && selectedTexts.every(object => object.underline), title: 'Underline selected statement (Ctrl/Cmd+U)' }),
                                button('Strikethrough', 'Strikethrough', () => formatSelection({ linethrough: !selectedTexts.every(object => object.linethrough) }), !isText, { 'aria-pressed': isText && selectedTexts.every(object => object.linethrough) })),
                            isText && h(React.Fragment, null,
                                h('div', { className: 'pdf-format-actions', 'aria-label': 'Text alignment' },
                                    [['left', 'AlignLeft'], ['center', 'AlignCenter'], ['right', 'AlignRight'], ['justify', 'AlignJustify']].map(([value, icon]) =>
                                        button(icon, 'Align ' + value, () => formatSelection({ textAlign: value }), false, { key: value, 'aria-pressed': selectedTexts.every(object => object.textAlign === value) }))),
                                !multipleText && textProfile.type === 'textbox' && textProfile._textLines.length === 1
                                    && textProfile.width - textProfile.calcTextWidth() < 2 && h('p', { className: 'pdf-hint' }, 'Drag the text box side handles wider (or set W below) to see alignment within the box.'),
                                h('div', { className: 'pdf-format-actions' },
                                    h('select', { className: 'fselect', 'aria-label': 'List style', value: '', disabled: !!busy || multipleText,
                                        title: 'Apply list markers to the selected lines (or all lines)',
                                        onChange: event => { const kind = event.target.value; if (kind) transformLines(lines => applyListMarkers(lines, kind)); } },
                                        h('option', { value: '' }, 'List style…'),
                                        Object.entries(LIST_KINDS).map(([kind, [label]]) => h('option', { key: kind, value: kind }, label)),
                                        h('option', { value: 'none' }, 'Remove list')),
                                    button('IndentDecrease', 'Decrease indent (Ctrl/Cmd+[)', () => transformLines(lines => indentLines(lines, -1)), multipleText),
                                    button('IndentIncrease', 'Increase indent (Ctrl/Cmd+])', () => transformLines(lines => indentLines(lines, 1)), multipleText)),
                                h('h3', null, 'Spacing'),
                                h('div', { className: 'pdf-property-grid' },
                                    numeric('Line spacing', textProfile.lineHeight, 0.8, 3, value => formatSelection({ lineHeight: value }), 0.05),
                                    numeric('Paragraph spacing', textProfile.paragraphSpacing || 0, 0, 72, value => formatSelection({ paragraphSpacing: value })),
                                    numeric('Letter spacing (%)', (textProfile.charSpacing || 0) / 10, -20, 100, value => formatSelection({ charSpacing: value * 10 })),
                                    numeric('Horizontal scale (%)', Math.round(textProfile.scaleX / textProfile.scaleY * 100), 50, 200,
                                        value => formatSelection({ scaleX: textProfile.scaleY * value / 100 }))),
                                h('label', null, multipleText ? 'Mixed-font statement' : 'Text', h('textarea', { className: 'finput pdf-selected-text', 'aria-label': 'Selected PDF text',
                                    value: multipleText ? selectedTexts.map(object => object.text).join(' ') : textProfile.text, readOnly: multipleText, disabled: !!busy,
                                    onChange: event => formatSelection({ text: event.target.value }) })))),
                        (!selected || selected.type !== 'image') && h('label', { className: 'pdf-color-control' }, 'Color', h('input', { type: 'color',
                            value: typeof selectedFill === 'string' && selectedFill.startsWith('#') ? selectedFill : color,
                            disabled: !!busy, 'aria-label': 'Annotation color', onChange: event => { setColor(event.target.value); formatSelection({ fill: event.target.value }); } })),
                        selected && h(React.Fragment, null,
                            h('h3', null, 'Position'),
                            h('div', { className: 'pdf-position-grid' },
                                numeric('X', Math.round(bounds.left), -5000, 5000, value => setBounds('x', value)),
                                numeric('Y', Math.round(bounds.top), -5000, 5000, value => setBounds('y', value)),
                                numeric('W', Math.round(bounds.width), 1, 5000, value => setBounds('w', value)),
                                isText ? h('label', { className: 'pdf-numeric' }, 'H', h('input', { className: 'finput', 'aria-label': 'H', value: Math.round(bounds.height), disabled: true }))
                                    : numeric('H', Math.round(bounds.height), 1, 5000, value => setBounds('h', value))),
                            h('div', { className: 'pdf-format-actions', 'aria-label': 'Align to page' },
                                button('AlignStartVertical', 'Align to page left', () => alignToPage('left')),
                                button('AlignCenterVertical', 'Center horizontally on page', () => alignToPage('center')),
                                button('AlignEndVertical', 'Align to page right', () => alignToPage('right')),
                                button('AlignStartHorizontal', 'Align to page top', () => alignToPage('top')),
                                button('AlignCenterHorizontal', 'Center vertically on page', () => alignToPage('middle')),
                                button('AlignEndHorizontal', 'Align to page bottom', () => alignToPage('bottom'))),
                            stickyCard && h('label', null, 'Note color', h('div', { className: 'pdf-swatches' }, NOTE_COLORS.map(([value, label]) =>
                                h('button', { key: value, type: 'button', 'aria-label': label + ' note', title: label, 'aria-pressed': stickyCard.fill === value,
                                    style: { background: value }, onClick: () => { stickyCard.set('fill', value); canvas.current.requestRenderAll(); capture(); } })))),
                            h('div', { className: 'pdf-property-grid' },
                                numeric('Rotation', ((selected.angle || 0) + 540) % 360 - 180, -180, 180, value => formatSelection({ angle: value })),
                                numeric('Opacity (%)', Math.round(selected.opacity * 100), 0, 100, value => formatSelection({ opacity: value / 100 }))),
                            h('div', { className: 'pdf-format-actions' },
                                button('CopyPlus', 'Duplicate selected object', duplicateSelection, selected.type === 'activeSelection'),
                                button('BringToFront', 'Bring selection forward', () => { selected.bringToFront(); capture(); }),
                                button('SendToBack', 'Send selection backward', () => { selected.sendToBack(); capture(); }),
                                button('Trash2', 'Delete selected annotation', deleteSelection)),
                            selected.type === 'image' && h(React.Fragment, null,
                                h('h3', null, 'Image Crop'),
                                h('div', { className: 'pdf-property-grid' },
                                    numeric('Crop left', selected.cropX || 0, 0, selected.getElement().width - 1, value => formatSelection({ cropX: value, width: Math.min(selected.width, selected.getElement().width - value) })),
                                    numeric('Crop top', selected.cropY || 0, 0, selected.getElement().height - 1, value => formatSelection({ cropY: value, height: Math.min(selected.height, selected.getElement().height - value) })),
                                    numeric('Crop width', selected.width, 1, selected.getElement().width - (selected.cropX || 0), value => formatSelection({ width: value })),
                                    numeric('Crop height', selected.height, 1, selected.getElement().height - (selected.cropY || 0), value => formatSelection({ height: value }))),
                                h('div', { className: 'pdf-format-actions' },
                                    button('FlipHorizontal2', 'Flip image horizontally', () => formatSelection({ flipX: !selected.flipX })),
                                    button('FlipVertical2', 'Flip image vertically', () => formatSelection({ flipY: !selected.flipY })),
                                    button('RotateCcw', 'Reset image crop', () => formatSelection({ cropX: 0, cropY: 0, width: selected.getElement().width, height: selected.getElement().height })))),
                            !isText && selected.type !== 'image' && selected.type !== 'activeSelection' && h(React.Fragment, null,
                                h('label', { className: 'pdf-color-control' }, 'Outline', h('input', { type: 'color', 'aria-label': 'Outline color',
                                    value: selected.stroke?.startsWith('#') ? selected.stroke : color, onChange: event => formatSelection({ stroke: event.target.value }) })),
                                numeric('Outline width', selected.strokeWidth || 0, 0, 20, value => formatSelection({ strokeWidth: value })),
                                selected.annotationKind !== 'line' && selected.fill !== null && h('label', { className: 'pdf-check-control' }, h('input', { type: 'checkbox', checked: selected.fill === 'transparent',
                                    onChange: event => formatSelection({ fill: event.target.checked ? 'transparent' : color }) }), 'Transparent fill'))),
                        (mode === 'replace' || selected?.replacementMask) && h(React.Fragment, null,
                            h('label', { className: 'pdf-color-control' }, 'Replacement background', h('input', { type: 'color', value: paperColor, 'aria-label': 'Replacement background',
                                onChange: event => {
                                    setPaperColor(event.target.value);
                                    const mask = canvas.current?.getObjects().find(object => object.name === selected?.replacementMask);
                                    if (mask) { mask.set('fill', event.target.value); canvas.current.renderAll(); capture(); }
                                } })),
                            h('p', { className: 'pdf-caution', role: 'note' }, 'Visual replacement only; original text remains underneath. Not secure redaction.'))),
                    inspectorTab === 'forms' && page && h('details', { className: 'pdf-form-fields', open: true },
                        h('summary', null, 'PDF Form Fields (' + page.doc.fields.length + ')'),
                        !page.doc.fields.length && h('p', { className: 'pdf-caution' }, 'No interactive fields detected. Use click-to-fill text for this PDF.'),
                        page.doc.fields.map(field => {
                            const value = page.doc.formValues[field.name];
                            const properties = { 'aria-label': 'PDF field: ' + field.name, disabled: !!busy || field.readOnly,
                                required: field.required, className: 'finput' };
                            let control;
                            if (field.type === 'text') control = h(field.multiline ? 'textarea' : 'input', {
                                ...properties, value, maxLength: field.maxLength, onChange: event => updateField(field, event.target.value)
                            });
                            else if (field.type === 'check') control = h('input', { ...properties, type: 'checkbox', checked: value,
                                onChange: event => updateField(field, event.target.checked) });
                            else if (field.type === 'radio' || field.type === 'options') control = h('select', {
                                ...properties, multiple: !!field.multiple, value: field.type === 'radio' ? value : field.multiple ? value : value[0] || '',
                                onChange: event => updateField(field, field.type === 'radio' ? event.target.value :
                                    Array.from(event.target.selectedOptions).map(option => option.value).filter(Boolean))
                            }, !field.multiple && h('option', { value: '' }, 'Not selected'), field.options.map(option => h('option', { key: option, value: option }, option)));
                            else if (field.type === 'signature') control = h('button', { className: 'btn', type: 'button', disabled: !!busy,
                                onClick: () => { const signature = page.doc.signatures.find(item => item.name === field.name); if (signature) verifyDocumentSignature(signature); } },
                                h(Icon, { name: 'ShieldCheck', size: 16 }), 'Verify digital signature');
                            else control = h('span', { className: 'pdf-caution' }, 'Unsupported field type.');
                            return h('label', { key: field.name }, field.name + (field.required ? ' *' : '') + (field.readOnly ? ' (read-only)' : ''), control);
                        }),
                        !!page.doc.fields.length && h('div', { className: 'pdf-page-actions' },
                            button('ClipboardCheck', 'Apply form values to preview', previewFields),
                            button('RotateCcw', 'Reset PDF form values', () => {
                                page.doc.formValues = Object.fromEntries(page.doc.fields.map(field => [field.name, field.value]));
                                setFieldRevision(version => version + 1); setDirty(true);
                            }))),
                    inspectorTab === 'verify' && h('div', { className: 'pdf-format-panel' },
                        h('strong', null, 'Certificate trust (this session only)'),
                        h('p', { className: 'pdf-hint' }, 'Import certificates from an independent official source, not from an unverified document. CCA roots are not automatically trusted. Validation uses current time; signing dates and embedded timestamps are not trusted time evidence.'),
                        h('button', { className: 'btn', disabled: !!busy, onClick: () => trustCertificateInput.current.click() }, 'Import trusted certificates'),
                        h('button', { className: 'btn', disabled: !!busy, onClick: () => trustCrlInput.current.click() }, 'Import issuer CRLs'),
                        h('span', { className: 'pdf-hint' }, `${trust.certificates.length} trusted certificate(s); ${trust.crls.length} revocation list(s)`),
                        trust.certificates.map(item => h('details', { key: item.fingerprint },
                            h('summary', null, item.name), h('p', { className: 'pdf-fingerprint' }, 'SHA-256: ' + item.fingerprint))),
                        h('button', { className: 'btn', disabled: !!busy || (!trust.certificates.length && !trust.crls.length), onClick: () => {
                            setTrust({ certificates: [], crls: [] }); setSignatureResults({});
                        } }, 'Clear trust settings'),
                        page && h('button', { className: 'btn', disabled: !!busy, onClick: () => download(page.doc.originalBytes || page.doc.bytes, page.doc.name) }, 'Save original signed source'),
                        !page ? h('p', { className: 'pdf-hint' }, 'Open a PDF to verify its digital signatures.')
                            : !page.doc.signatures.length ? h('p', { className: 'pdf-hint' }, 'No digital signature fields were found. Drawn or image signatures cannot be cryptographically verified.')
                                : h(React.Fragment, null,
                                    h('button', { className: 'btn primary', type: 'button', disabled: !!busy || !page.doc.signatures.some(item => item.signed),
                                        onClick: async () => { for (const signature of page.doc.signatures.filter(item => item.signed)) await verifyDocumentSignature(signature); } },
                                        h(Icon, { name: 'ShieldCheck', size: 16 }), 'Verify all signatures'),
                                    page.doc.signatures.map(signature => {
                                        const key = page.doc.id + ':' + signature.name, result = signatureResults[key];
                                        const status = result?.status || (signature.signed ? 'pending' : 'unsigned');
                                        const labels = { valid: 'Valid', unknown: 'Validity unknown', invalid: 'Invalid', modified: 'Changed after signing', unsupported: 'Unsupported', unsigned: 'Unsigned', pending: 'Not verified' };
                                        const pagesLabel = [...new Set(signature.widgets.map(widget => widget.pageIndex + 1).filter(number => number > 0))].join(', ');
                                        const rows = result ? [
                                            ['Signed by', result.signer || result.claimedSigner], ['Issued by', result.issuer && result.issuer + (result.selfSigned ? ' (self-signed)' : '')],
                                            ['Claimed signed on', result.signedAt?.toLocaleString()],
                                            ['Checked on', result.checkedAt?.toLocaleString()],
                                            ['Certificate valid from', result.validFrom?.toLocaleString()], ['Certificate valid until', result.validTo?.toLocaleString()],
                                            ['Certificate', result.certificateValidAtSigning === undefined ? undefined : result.certificateValidAtSigning ? 'Valid at claimed signing time' : 'Not valid at claimed signing time'],
                                            ['Integrity', result.integrity === undefined ? undefined : result.integrity ? 'Signed bytes match' : 'Failed'],
                                            ['Whole document', result.coversWholeFile === undefined ? undefined : result.coversWholeFile ? 'Covered by signature' : 'Later changes present'],
                                            ['Trust chain', result.chainMessage],
                                            ['Revocation', result.integrity ? result.revocationChecked ? 'Passed using imported issuer CRLs' : result.revocationMessage || 'Not checked' : undefined],
                                            ['Chain', result.certificateChain?.join(' -> ')],
                                            ['Timestamp', result.signer ? (result.timestamp ? 'Embedded timestamp present (not validated)' : 'No trusted timestamp') : undefined],
                                            ['Reason', result.reason], ['Location', result.location]
                                        ].filter(row => row[1]) : [];
                                        return h('div', { key, className: 'pdf-signature-card', 'data-active': activeSignature === key },
                                            h('header', null, h('strong', null, signature.name), h('span', { className: 'pdf-status-chip', 'data-status': status }, labels[status])),
                                            pagesLabel && h('span', { className: 'pdf-hint' }, 'Source page ' + pagesLabel),
                                            result && h('p', null, result.message),
                                            rows.length > 0 && h('dl', null, rows.flatMap(([term, value]) => [h('dt', { key: term }, term), h('dd', { key: term + '-value' }, value)])),
                                            h('button', { className: 'btn', type: 'button', disabled: !!busy || !signature.signed, onClick: () => verifyDocumentSignature(signature) },
                                                h(Icon, { name: 'ShieldCheck', size: 16 }), result ? 'Verify again' : 'Verify'));
                                    }),
                                    h('p', { className: 'pdf-hint' }, 'Results apply only to the original source file, not editor changes or unlocked/exported copies. Missing trust, expired certificates or unavailable/currently unusable CRLs leave validity unknown. No network revocation requests or document uploads are made. This is not automatic CCA/AATL validation.'))),
                    inspectorTab === 'document' && h('div', { className: 'pdf-format-panel' },
                        h('label', null, 'PDF title', h('input', { className: 'finput', 'aria-label': 'PDF title', value: title, onChange: event => { setTitle(event.target.value); setDirty(true); } })),
                        h('label', null, 'Author', h('input', { className: 'finput', value: author, onChange: event => { setAuthor(event.target.value); setDirty(true); } }))),
                    inspectorTab === 'text' && h('div', { className: 'pdf-format-panel' },
                    h('div', { className: 'pdf-page-actions' }, button('ScanText', 'Extract current page text', () => extract(false), !page),
                        button('Scan', 'OCR current page', () => extract(true), !page),
                        button('FileInput', 'Insert extracted text as note', () => addObject(new fabric.Textbox(text, { left: 40, top: 100, width: 300, fontFamily, fontSize: 16, fill: color })), !text)),
                    h('select', { className: 'fselect', 'aria-label': 'OCR language', defaultValue: 'eng', onChange: event => { ocrLanguage.current = event.target.value; } },
                        [['eng', 'English'], ['hin', 'Hindi'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['ara', 'Arabic']].map(([value, label]) => h('option', { value, key: value }, label))),
                    h('textarea', { className: 'finput pdf-text', 'aria-label': 'Extracted page text', value: text, onChange: event => setText(event.target.value) })))),
            mergeFiles !== null && h('div', { className: 'pdf-dialog-backdrop' },
                h('section', { className: 'pdf-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': 'Merge PDFs' },
                    h('h2', null, 'Merge PDFs'),
                    h('p', { className: 'pdf-hint' }, 'Choose PDFs, arrange their order, then append them to this document. Download the combined PDF using Export. Existing pages stay first.'),
                    error && h('p', { className: 'pdf-error', role: 'alert' }, error),
                    h('button', { className: 'btn', disabled: !!busy, onClick: () => mergeInput.current.click() }, 'Choose PDFs'),
                    h('ol', { className: 'pdf-merge-list' }, mergeFiles.map((file, index) => h('li', { key: index },
                        h('span', null, file.name),
                        button('ArrowUp', 'Move file earlier: ' + file.name, () => setMergeFiles(files => {
                            const next = [...files]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next;
                        }), index === 0),
                        button('ArrowDown', 'Move file later: ' + file.name, () => setMergeFiles(files => {
                            const next = [...files]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; return next;
                        }), index === mergeFiles.length - 1),
                        button('X', 'Remove file: ' + file.name, () => setMergeFiles(files => files.filter((item, position) => position !== index)))))),
                    h('div', { className: 'pdf-dialog-actions' },
                        h('button', { className: 'btn', disabled: !!busy, onClick: () => setMergeFiles(null) }, 'Cancel'),
                        h('button', { className: 'btn primary', disabled: !!busy || !mergeFiles.length || (!pages.length && mergeFiles.length < 2),
                            onClick: () => importFiles(mergeFiles, true) }, 'Merge PDFs')))),
            markdown && h('div', { className: 'pdf-dialog-backdrop' },
                h('section', { className: 'pdf-dialog pdf-markdown-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': 'Markdown pages' },
                    h('h2', null, markdown.replacing ? 'Edit page in Markdown' : 'Create Markdown pages'),
                    h('p', { className: 'pdf-hint' }, markdown.preserveLayout
                        ? 'Original layout, colors and images stay in place. Edit text inside each pdf-block marker; keep the markers and their order. Apply is blocked if a block overflows. Images and artwork remain unchanged.'
                        : 'New Markdown pages reflow. Keep image references to retain images; delete a reference to remove its image. Source and images are kept for this session.'),
                    markdownError && h('p', { className: 'pdf-error', role: 'alert' }, markdownError),
                    error && h('p', { className: 'pdf-error', role: 'alert' }, error),
                    h('div', { className: 'pdf-markdown-layout' },
                        h('div', { className: 'pdf-markdown-source', inert: busy ? '' : undefined },
                            h(MdEditor, { key: markdown.id, fill: true, lineNumbers: true, ariaLabel: 'Markdown source',
                                allowImages: !markdown.preserveLayout,
                                value: markdown.source, onChange: changeMarkdown,
                                previewValue: markdown.source.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, label, href) => {
                                    const asset = markdownAssets.current[href];
                                    return asset?.object?.src ? '![' + label + '](' + asset.object.src + ')' : '[Image unavailable]';
                                }) })),
                        h('div', { className: 'pdf-markdown-preview', 'aria-label': 'Markdown live preview' },
                            h('canvas', { ref: markdownCanvas, hidden: !markdownPreview.length }))),
                    h('div', { className: 'pdf-dialog-actions' },
                        button('ChevronLeft', 'Previous preview page', () => setMarkdownPreviewPage(value => value - 1), !markdownPreview.length || markdownPreviewPage === 0),
                        h('span', { role: 'status' }, markdownPreview.length ? `Page ${markdownPreviewPage + 1} of ${markdownPreview.length}` : markdownError ? 'Preview unavailable' : 'Rendering preview...'),
                        button('ChevronRight', 'Next preview page', () => setMarkdownPreviewPage(value => value + 1), !markdownPreview.length || markdownPreviewPage >= markdownPreview.length - 1),
                        h('button', { className: 'btn', disabled: !!busy, onClick: () => {
                            if (window.confirm('Discard this Markdown draft?')) setMarkdown(null);
                        } }, 'Cancel'),
                        h('button', { className: 'btn primary', disabled: !!busy || !markdownPreview.length || !!markdownError,
                            onClick: applyMarkdown }, markdown.replacing ? 'Apply to page' : 'Add pages')))),
            lockedPdf && h('div', { className: 'pdf-dialog-backdrop pdf-unlock-backdrop' },
                h('section', { className: 'pdf-dialog pdf-unlock-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': 'Unlock PDF' },
                    h('h2', null, 'Unlock PDF'),
                    h('p', null, lockedPdf.file.name),
                    h('p', { className: 'pdf-hint' }, 'Enter the correct PDF password. Files and passwords stay on this device. Unlocking rewrites the file and invalidates original digital signatures; verification will use the original source. Only unlock documents you are authorised to access.'),
                    error && h('p', { className: 'pdf-error', role: 'alert' }, error),
                    h('label', null, 'PDF password', h('input', { type: 'password', className: 'finput', autoFocus: true, autoComplete: 'off',
                        'aria-label': 'PDF password', value: pdfPassword, disabled: busy === 'Unlocking PDF...',
                        onChange: event => setPdfPassword(event.target.value), onKeyDown: event => {
                            if (event.key === 'Enter' && busy !== 'Unlocking PDF...') { event.preventDefault(); completeUnlock('open'); }
                        } })),
                    h('p', { className: 'pdf-hint' }, 'For permission-only locks, try an empty password. Unlock and save downloads this file only, without importing pages or applying editor changes.'),
                    h('div', { className: 'pdf-dialog-actions' },
                        h('button', { className: 'btn', disabled: busy === 'Unlocking PDF...', onClick: () => {
                            const resolve = unlockRequest.current; unlockRequest.current = null;
                            setPdfPassword(''); setLockedPdf(null); resolve?.(null);
                        } }, 'Cancel'),
                        h('button', { className: 'btn', disabled: busy === 'Unlocking PDF...', onClick: () => completeUnlock('save') }, 'Unlock and save'),
                        h('button', { className: 'btn primary', disabled: busy === 'Unlocking PDF...', onClick: () => completeUnlock('open') }, 'Unlock and open')))),
            signature && h('div', { className: 'pdf-signature', role: 'dialog', 'aria-label': 'Draw signature' },
                h('div', { ref: stageHost, className: 'pdf-signature-stage' }),
                button('Eraser', 'Clear signature', () => signatureStage.current?.getLayers()[0].destroyChildren()),
                button('Check', 'Insert signature image', () => {
                    if (!signatureStage.current) return;
                    fabric.Image.fromURL(signatureStage.current.toDataURL({ pixelRatio: 2 }), image => { image.scaleToWidth(220); image.set({ left: 40, top: 40 }); addObject(image); });
                    setSignature(false);
                }), button('X', 'Cancel signature', () => setSignature(false))),
            h('input', { ref: fileInput, type: 'file', accept: '.pdf,application/pdf', multiple: true, hidden: true, onChange: event => { importFiles(Array.from(event.target.files)); event.target.value = ''; } }),
            h('input', { ref: trustCertificateInput, type: 'file', accept: '.cer,.crt,.der,.pem', multiple: true, hidden: true, onChange: event => {
                const files = Array.from(event.target.files); event.target.value = ''; importTrustFiles(files, 'certificate');
            } }),
            h('input', { ref: trustCrlInput, type: 'file', accept: '.crl,.pem,.der', multiple: true, hidden: true, onChange: event => {
                const files = Array.from(event.target.files); event.target.value = ''; importTrustFiles(files, 'crl');
            } }),
            h('input', { ref: mergeInput, type: 'file', accept: '.pdf,application/pdf', multiple: true, hidden: true, onChange: event => {
                const files = Array.from(event.target.files); event.target.value = '';
                setMergeFiles(previous => [...(previous || []), ...files]);
            } }),
            h('input', { ref: imageInput, type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, onChange: event => {
                const file = event.target.files[0]; event.target.value = ''; if (!file) return;
                task('Adding image...', async () => {
                    const url = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result);
                        reader.onerror = () => reject(new Error('Image could not be read.'));
                        reader.readAsDataURL(file);
                    });
                    await new Promise((resolve, reject) => fabric.Image.fromURL(url, (image, failed) => {
                        if (failed) { reject(new Error('Image could not be decoded.')); return; }
                        image.scaleToWidth(Math.min(240, page.width / 2)); image.set({ left: 40, top: 40 }); addObject(image); resolve();
                    }));
                });
            } }),
            h('input', { ref: fontInput, type: 'file', accept: '.ttf,.otf', hidden: true, onChange: event => { const file = event.target.files[0]; event.target.value = ''; if (file) loadFont(file); } })
        );
    };
})();