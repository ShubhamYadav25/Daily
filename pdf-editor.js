(function () {
    'use strict';

    const dependencies = {};
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
        { family: 'Verdana', label: 'Verdana' }
    ];

    function sourceFontStyle(name, family) {
        const label = (name || family || 'Helvetica').replace(/^[A-Z]{6}\+/, '');
        const normalized = label.toLowerCase();
        return { label, family: /times|serif/.test(normalized) && !/sans/.test(normalized) ? 'Times New Roman'
            : /courier|mono/.test(normalized) ? 'Courier New' : /cambria/.test(normalized) ? 'Cambria'
                : /calibri/.test(normalized) ? 'Calibri' : /georgia/.test(normalized) ? 'Georgia' : 'Helvetica',
            weight: /bold|black|heavy|demi/.test(normalized) ? 'bold' : 'normal',
            style: /italic|oblique/.test(normalized) ? 'italic' : 'normal' };
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
        for (const definition of doc.fields) {
            if (definition.readOnly || definition.type === 'unsupported') continue;
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
            const baseline = lineTop + lineHeight / object.lineHeight * (1 - object._fontSizeFraction);
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
                const baseline = top + height / object.lineHeight * (1 - object._fontSizeFraction);
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

    window.DailyPdfTools = { pagePlacement, parsePages, pdfFields, filledDocument, sourceFontStyle, embeddedFontBytes, drawAnnotationText, groupTextTargets };

    window.DailyPdfEditor = function PdfEditor({ Panel, Icon, onClose }) {
        const { createElement: h, useState, useRef, useEffect } = React;
        const [ready, setReady] = useState(false);
        const [busy, setBusy] = useState('Loading PDF libraries...');
        const [error, setError] = useState('');
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
        const [stamp, setStamp] = useState('Reviewed');
        const [watermark, setWatermark] = useState('DRAFT');
        const [numberStart, setNumberStart] = useState(1);
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
        const docs = useRef([]);
        const currentPage = useRef();
        const histories = useRef(new Map());
        const restoring = useRef(false);
        const alive = useRef(true);
        const activeTasks = useRef(0);
        const page = pages[active];

        async function task(label, action) {
            activeTasks.current++;
            setBusy(label); setError('');
            try { await action(); }
            catch (failure) { if (alive.current) setError(failure.message || String(failure)); }
            finally { if (--activeTasks.current === 0 && alive.current) setBusy(''); }
        }

        useEffect(() => {
            alive.current = true;
            task('Loading PDF libraries...', async () => { await loadCore(); if (alive.current) setReady(true); });
            return () => {
                alive.current = false;
                docs.current.forEach(doc => { doc.render.destroy(); doc.fonts.forEach(font => { if (font.face) document.fonts.delete(font.face); }); });
            };
        }, []);

        useEffect(() => {
            const resize = () => setMobile(window.innerWidth <= 640);
            window.addEventListener('resize', resize);
            return () => window.removeEventListener('resize', resize);
        }, []);

        function capture() {
            if (!canvas.current || !currentPage.current || restoring.current) return;
            const object = canvas.current.getActiveObject();
            if (object?.sourceFontKey) {
                const original = currentPage.current.doc.fonts.get(object.sourceFontKey);
                if (original?.parsed) {
                    const supported = Array.from(object.text).every(character => /\s/.test(character) || original.parsed.hasGlyphForCodePoint(character.codePointAt(0)));
                    object.set('fontFamily', supported && original.face ? original.family : original.fallback);
                    object.sourceFontExact = supported && !!original.face;
                }
            }
            const value = canvas.current.toJSON(['replacementMask', 'name', 'sourceFontKey', 'sourceFontLabel', 'sourceFontExact', 'annotationKind']);
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
            if (!['i-text', 'textbox'].includes(object.type)) return;
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

        useEffect(() => {
            if (!ready || !page) return;
            let cancelled = false;
            let renderTask;
            restoring.current = true;
            const previewScale = Math.min(4, Math.max(1.5, zoom * (window.devicePixelRatio || 1)));
            const editCanvas = new fabric.Canvas(overlay.current, { preserveObjectStacking: true });
            editCanvas.getRetinaScaling = () => previewScale;
            editCanvas._isRetinaScaling = () => editCanvas.enableRetinaScaling && previewScale > 1;
            editCanvas._initRetinaScaling = () => {
                editCanvas.__initRetinaScaling(previewScale, editCanvas.lowerCanvasEl, editCanvas.contextContainer);
                if (editCanvas.upperCanvasEl) editCanvas.__initRetinaScaling(previewScale, editCanvas.upperCanvasEl, editCanvas.contextTop);
            };
            canvas.current = editCanvas;
            currentPage.current = page;
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
                        y: transform[5] - Math.cos(angle) * height, width: Math.max(10, item.width), height,
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
                        original = { parsed: null, fallback: detected.family, family: detected.family, face: null };
                        if (sourceFont?.data) {
                            try {
                                await loadScript('fontkit', 'https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js');
                                const bytes = embeddedFontBytes(page.doc.pdf, page.number, sourceFont.name) || sourceFont.data;
                                original.parsed = fontkit.create(bytes); original.bytes = bytes;
                                const variant = sourceFontStyle(sourceFont.name + ' ' + original.parsed.subfamilyName, detected.family);
                                original.fontWeight = variant.weight; original.fontStyle = variant.style;
                                const family = 'DailyPdfOriginal-' + crypto.randomUUID();
                                original.face = new FontFace(family, bytes, { weight: variant.weight, style: variant.style });
                                await original.face.load(); document.fonts.add(original.face); original.family = family;
                            } catch { original.parsed = null; original.face = null; }
                        }
                        page.doc.fonts.set(key, original);
                    }
                    const exact = !!original.face && Array.from(target.text).every(character => /\s/.test(character) || original.parsed.hasGlyphForCodePoint(character.codePointAt(0)));
                    const family = exact ? original.family : detected.family;
                    Object.assign(target, { fontFamily: family, fontWeight: original.fontWeight || detected.weight, fontStyle: original.fontStyle || detected.style,
                        sourceFontKey: key, sourceFontLabel: original.parsed?.familyName || detected.label, sourceFontExact: exact });
                }
                if (cancelled) return;
                setTextTargets(targets);
                editCanvas.setDimensions({ width: viewport.width, height: viewport.height });
                await new Promise(resolve => editCanvas.loadFromJSON(page.overlay || { objects: [] }, resolve));
                if (cancelled) return;
                editCanvas.getObjects().forEach(prepareObject);
                if (!histories.current.has(page.id)) histories.current.set(page.id, {
                    values: [editCanvas.toJSON(['replacementMask', 'name', 'sourceFontKey', 'sourceFontLabel', 'sourceFontExact', 'annotationKind'])], index: 0
                });
                restoring.current = false;
                editCanvas.renderAll();
                editCanvas.on('object:added', event => { prepareObject(event.target); capture(); });
                ['object:modified', 'object:removed', 'path:created', 'text:changed'].forEach(event => editCanvas.on(event, capture));
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
                const point = layer.getPointer(event.e);
                const target = selectionTargets.slice().reverse().find(item => {
                    const radians = item.angle * Math.PI / 180;
                    const dx = point.x - item.x, dy = point.y - item.y;
                    const x = dx * Math.cos(radians) + dy * Math.sin(radians);
                    const y = -dx * Math.sin(radians) + dy * Math.cos(radians);
                    return x >= 0 && x <= item.width && y >= 0 && y <= item.height * 1.3;
                });
                if (target) replaceText(target);
            }
            layer.on('mouse:dblclick', editPageText);
            return () => layer.off('mouse:dblclick', editPageText);
        }, [busy, mode, textTargets, textScope]);

        async function importFiles(files) {
            await task('Importing PDF pages...', async () => {
                const added = [];
                for (const file of files) {
                    const bytes = new Uint8Array(await file.arrayBuffer());
                    const pdf = await PDFLib.PDFDocument.load(bytes);
                    const render = await pdfjsLib.getDocument({ data: bytes.slice(), fontExtraProperties: true }).promise;
                    const fields = pdfFields(pdf);
                    const doc = { pdf, render, name: file.name, fields, fonts: new Map(),
                        formValues: Object.fromEntries(fields.map(field => [field.name, field.value])) };
                    docs.current.push(doc);
                    pdf.getPages().forEach((source, index) => added.push({ id: crypto.randomUUID(), doc, number: index + 1,
                        rotation: source.getRotation().angle, overlay: { objects: [] } }));
                }
                if (!alive.current) return;
                if (!pages.length && files[0]) { setName(files[0].name.replace(/\.pdf$/i, '')); setTitle(files[0].name.replace(/\.pdf$/i, '')); }
                setPages(previous => previous.concat(added)); setDirty(true);
            });
        }

        function addObject(object) {
            canvas.current.add(object); canvas.current.setActiveObject(object); canvas.current.renderAll(); setMode('select'); setInspectorTab('format');
        }

        function createReplacement(target) {
            const id = 'pdf-mask-' + crypto.randomUUID();
            const object = new fabric.IText(target.text, { left: target.x, top: target.y, angle: target.angle,
                fontSize: target.height, fontFamily: target.fontFamily, fontWeight: target.fontWeight, fontStyle: target.fontStyle,
                fill: '#111111', replacementMask: id, sourceFontKey: target.sourceFontKey,
                sourceFontLabel: target.sourceFontLabel, sourceFontExact: target.sourceFontExact });
            const angle = target.angle * Math.PI / 180;
            const baseline = fabric.util.transformPoint(new fabric.Point(object._getLeftOffset(),
                object._getTopOffset() + object.getHeightOfLine(0) / object.lineHeight * (1 - object._fontSizeFraction)), object.calcTransformMatrix());
            object.set({ left: object.left + target.x - Math.sin(angle) * target.height - baseline.x,
                top: object.top + target.y + Math.cos(angle) * target.height - baseline.y });
            canvas.current.add(new fabric.Rect({ left: target.x, top: target.y, width: target.width + 2,
                height: target.height * 1.3, angle: target.angle, fill: paperColor, selectable: false, evented: false, name: id }));
            canvas.current.add(object);
            return object;
        }

        function replaceText(target) {
            const runs = target.runs || [target];
            const first = runs[0];
            const uniform = runs.every(run => run.fontFamily === first.fontFamily && run.fontWeight === first.fontWeight
                && run.fontStyle === first.fontStyle && Math.abs(run.height - first.height) < 0.1);
            restoring.current = true;
            const objects = uniform ? [createReplacement(target)] : runs.map(createReplacement);
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
            const objects = canvas.current.getActiveObjects();
            restoring.current = true;
            objects.forEach(object => {
                if (object.replacementMask) {
                    const mask = canvas.current.getObjects().find(item => item.name === object.replacementMask);
                    if (mask) canvas.current.remove(mask);
                }
                canvas.current.remove(object);
            });
            restoring.current = false;
            canvas.current.discardActiveObject(); capture(); canvas.current.renderAll();
        }

        function updateField(field, value) {
            page.doc.formValues[field.name] = value;
            setFieldRevision(version => version + 1); setDirty(true);
        }

        function formatSelection(properties) {
            if (!canvas.current) return;
            const object = canvas.current.getActiveObject();
            if (!object) return;
            const textProperties = ['fontFamily', 'fontWeight', 'fontStyle', 'fontSize', 'underline', 'linethrough', 'textAlign', 'lineHeight', 'charSpacing', 'fill'];
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

        function duplicateSelection() {
            const object = canvas.current.getActiveObject();
            object.clone(copy => {
                copy.set({ left: object.left + 16, top: object.top + 16, name: 'annotation-' + crypto.randomUUID() });
                copy.replacementMask = null;
                addObject(copy);
            }, ['sourceFontKey', 'sourceFontLabel', 'sourceFontExact', 'annotationKind']);
        }

        async function decoratePages(kind) {
            await task('Updating page decorations...', async () => {
                for (let index = 0; index < pages.length; index++) {
                    const item = pages[index];
                    const source = item.doc.pdf.getPage(item.number - 1);
                    const placement = pagePlacement(source.getWidth(), source.getHeight(), item.rotation);
                    const layer = new fabric.StaticCanvas(document.createElement('canvas'), { width: placement.width, height: placement.height });
                    try {
                        await new Promise(resolve => layer.loadFromJSON(item.overlay, resolve));
                        layer.getObjects().filter(object => object.annotationKind === kind).forEach(object => layer.remove(object));
                        layer.add(new fabric.IText(kind === 'page-number' ? String(numberStart + index) : watermark, {
                            left: placement.width / 2, top: kind === 'page-number' ? placement.height - 28 : placement.height / 2,
                            originX: 'center', originY: 'center', fontFamily, fontSize: kind === 'page-number' ? 12 : 48,
                            fill: '#313b40', opacity: kind === 'page-number' ? 1 : 0.16,
                            angle: kind === 'page-number' ? 0 : -30, annotationKind: kind
                        }));
                        item.overlay = layer.toJSON(['replacementMask', 'name', 'sourceFontKey', 'sourceFontLabel', 'sourceFontExact', 'annotationKind']);
                        const history = histories.current.get(item.id) || { values: [{ objects: [] }], index: 0 };
                        history.values = history.values.slice(0, history.index + 1).concat(item.overlay).slice(-40);
                        history.index = history.values.length - 1; histories.current.set(item.id, history);
                    } finally { layer.dispose(); }
                }
                setDirty(true); setRenderRevision(version => version + 1);
            });
        }

        async function exportSelection() {
            if (exportFormat === 'pdf') return exportPdf();
            if (exportFormat === 'text') { download(text, name + '-text.txt', 'text/plain;charset=utf-8'); return; }
            if (exportFormat === 'fields') { download(JSON.stringify(page.doc.formValues, null, 2), name + '-fields.json', 'application/json'); return; }
            await task('Exporting page image...', async () => {
                const document = await filledDocument(page.doc, customFont);
                const render = await pdfjsLib.getDocument({ data: await document.save() }).promise;
                let layer;
                try {
                    const source = await render.getPage(page.number);
                    const viewport = source.getViewport({ scale: 2, rotation: page.rotation });
                    const output = window.document.createElement('canvas'); output.width = viewport.width; output.height = viewport.height;
                    await source.render({ canvasContext: output.getContext('2d'), viewport, intent: 'print' }).promise;
                    layer = new fabric.StaticCanvas(window.document.createElement('canvas'), { width: viewport.width / 2, height: viewport.height / 2 });
                    await new Promise(resolve => layer.loadFromJSON(page.overlay, resolve));
                    const image = new Image();
                    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = layer.toDataURL({ format: 'png', multiplier: 2 }); });
                    output.getContext('2d').drawImage(image, 0, 0);
                    const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
                    download(blob, name + '-page-' + (active + 1) + '.png', 'image/png');
                } finally { layer?.dispose(); await render.destroy(); }
            });
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
                    page.overlay = canvas.current.toJSON(['replacementMask', 'name', 'sourceFontKey', 'sourceFontLabel', 'sourceFontExact', 'annotationKind']); canvas.current.renderAll(); setDirty(true);
                    setSelectionVersion(version => version + 1);
                } finally { restoring.current = false; }
            });
        }

        useEffect(() => {
            function pointer(event) { pointerInside.current = !!editorRef.current?.contains(event.target); }
            function shortcuts(event) {
                if (event.defaultPrevented || event.isComposing || !page) return;
                const object = canvas.current?.getActiveObject();
                const fabricInput = event.target.hasAttribute?.('data-fabric-hiddentextarea') && object?.isEditing;
                if (!fabricInput && !editorRef.current?.contains(event.target) && !pointerInside.current) return;
                const input = event.target.closest?.('input,textarea,select,[contenteditable="true"]');
                if (input && !fabricInput && input.getAttribute('aria-label') !== 'Selected PDF text') return;
                const key = event.key.toLowerCase(), command = event.ctrlKey || event.metaKey;
                const textObjects = canvas.current?.getActiveObjects().filter(item => ['i-text', 'textbox', 'text'].includes(item.type)) || [];
                if (command && !event.altKey && (key === 'z' || key === 'y')) {
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
            if (dirty && !window.confirm('Close PDF Editor and discard this workspace? Export a PDF first to keep your changes.')) return;
            onClose();
        }

        useEffect(() => {
            function unload(event) { if (dirty) { event.preventDefault(); event.returnValue = ''; } }
            function escape(event) { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); } }
            window.addEventListener('beforeunload', unload);
            window.addEventListener('keydown', escape, true);
            return () => { window.removeEventListener('beforeunload', unload); window.removeEventListener('keydown', escape, true); };
        }, [dirty]);

        async function exportPdf(indices) {
            await task('Exporting PDF...', async () => {
                setExportNote('');
                indices = indices || parsePages(range, pages.length);
                const result = await PDFLib.PDFDocument.create();
                result.setTitle(title); result.setAuthor(author); result.setCreator('Daily PDF Editor');
                const documents = new Map();
                const fonts = new Map();
                const rasterFonts = new Set();
                for (const index of indices) {
                    const item = pages[index];
                    if (!documents.has(item.doc)) documents.set(item.doc, await filledDocument(item.doc, customFont));
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
                download(await result.save(), (name || 'document') + '-edited.pdf');
                if (rasterFonts.size) setExportNote('Some text uses image export because its font data or styling cannot be embedded: '
                    + [...rasterFonts].join(', ') + '. Load the matching TTF/OTF for plain text to enable sharp vector export.');
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
                onChange: event => action(Math.max(min, Math.min(max, Number(event.target.value) || min))) }));

        return h(Panel, { title: 'PDF Editor', icon: 'FilePenLine', onClose: close, initW: 1200, initH: 780, storageKey: 'pdf-editor', className: 'pdf-window pdf-background-' + workspaceBackground, panelRef: editorRef },
            h('div', { className: 'pdf-toolbar pdf-document-bar' },
                button('FolderOpen', 'Open or merge PDFs', () => fileInput.current.click(), !ready),
                button('FilePlus2', 'Add blank A4 page', newPage, !ready),
                h('span', { className: 'pdf-document-name', title: name }, name),
                h('span', { className: 'pdf-status', role: 'status' }, busy || (dirty ? 'Unsaved changes' : pages.length ? 'Exported' : 'No PDF open')),
                button('Undo2', 'Undo annotation', () => undo(-1), !page, { title: 'Undo (Ctrl/Cmd+Z)' }), button('Redo2', 'Redo annotation', () => undo(1), !page, { title: 'Redo (Ctrl/Cmd+Shift+Z or Ctrl+Y)' }),
                h('details', { className: 'pdf-export' },
                    h('summary', { 'aria-label': 'Export options' }, h(Icon, { name: 'Download', size: 18 }), h('span', null, 'Export')),
                    h('div', { className: 'pdf-export-menu' },
                        h('label', null, 'Filename', h('input', { className: 'finput', 'aria-label': 'Export filename', value: name, onChange: event => setName(event.target.value) })),
                        h('label', null, 'Format', h('select', { className: 'fselect', 'aria-label': 'Export format', value: exportFormat, onChange: event => setExportFormat(event.target.value) },
                            [['pdf', 'PDF document'], ['png', 'Current page PNG'], ['text', 'Extracted text TXT'], ['fields', 'Form values JSON']].map(([value, label]) => h('option', { value, key: value }, label)))),
                        exportFormat === 'pdf' && h('label', null, 'Pages', h('input', { className: 'finput', 'aria-label': 'Export page range', placeholder: 'All pages or 1,3-5', value: range, onChange: event => setRange(event.target.value) })),
                        h('button', { className: 'btn primary', disabled: !!busy || !page || (exportFormat === 'text' && !text) || (exportFormat === 'fields' && !page.doc.fields.length),
                            onClick: exportSelection }, h(Icon, { name: 'Download', size: 18 }), 'Download')))),
            error && h('div', { className: 'pdf-error', role: 'alert' }, error, !ready && button('RefreshCw', 'Retry loading libraries', () => task('Loading PDF libraries...', async () => { await loadCore(); setReady(true); }))),
            exportNote && h('div', { className: 'pdf-export-note', role: 'status' }, exportNote),
            h('div', { className: 'pdf-ribbon-tabs', role: 'tablist', 'aria-label': 'PDF tools' },
                [['edit', 'Edit', 'TextCursorInput'], ['annotate', 'Annotate', 'MessageSquareText'], ['pages', 'Pages', 'Layers2'], ['review', 'Review', 'ClipboardCheck']].map(([id, label, icon]) =>
                    h('button', { key: id, role: 'tab', 'aria-selected': toolsTab === id, onClick: () => { setToolsTab(id); if (id !== 'edit') setMode('select'); } }, h(Icon, { name: icon, size: 16 }), label))),
            h('div', { className: 'pdf-toolbar pdf-ribbon', role: 'toolbar', 'aria-label': toolsTab + ' tools' },
                toolsTab === 'edit' && h(React.Fragment, null,
                button('MousePointer2', 'Select and resize', () => setMode('select'), !page, { 'aria-pressed': mode === 'select' }),
                button('Type', 'Add editable text', () => addObject(new fabric.IText('Text', { left: 40, top: 40, fontSize, fill: color, fontFamily, fontWeight, fontStyle })), !page),
                button('TextCursorInput', 'Click to fill text', () => setMode('fill-text'), !page, { 'aria-pressed': mode === 'fill-text' }),
                button('SquareCheck', 'Click to place a check mark', () => setMode('fill-check'), !page, { 'aria-pressed': mode === 'fill-check' }),
                button('CalendarDays', 'Click to place today\'s date', () => setMode('fill-date'), !page, { 'aria-pressed': mode === 'fill-date' }),
                button('FilePenLine', 'Replace visible PDF text', () => setMode('replace'), !page || !textTargets.length, { 'aria-pressed': mode === 'replace' })),
                toolsTab === 'annotate' && h(React.Fragment, null,
                button('Pencil', 'Freehand drawing', () => setMode('draw'), !page, { 'aria-pressed': mode === 'draw' }),
                button('Highlighter', 'Add resizable highlight', () => addObject(new fabric.Rect({ left: 40, top: 80, width: 180, height: 24, fill: '#ffe34a', opacity: 0.35 })), !page),
                button('Square', 'Add rectangle', () => addObject(new fabric.Rect({ left: 40, top: 100, width: 160, height: 100, fill: 'transparent', stroke: color, strokeWidth: 2 })), !page),
                button('Circle', 'Add ellipse', () => addObject(new fabric.Ellipse({ left: 40, top: 100, rx: 60, ry: 40, fill: 'transparent', stroke: color, strokeWidth: 2 })), !page),
                button('ImagePlus', 'Add image', () => imageInput.current.click(), !page),
                button('Signature', 'Draw signature', () => setSignature(true), !page),
                button('MessageSquareText', 'Add comment note', () => addObject(new fabric.Textbox('Comment', { left: 40, top: 100, width: 200, fontSize: 16,
                    fontFamily, fill: '#34372f', backgroundColor: '#fff3a1', padding: 8, annotationKind: 'comment' })), !page),
                h('select', { className: 'fselect pdf-stamp-choice', 'aria-label': 'Review stamp', value: stamp, onChange: event => setStamp(event.target.value) },
                    ['Reviewed', 'Approved', 'Draft', 'Confidential'].map(value => h('option', { value, key: value }, value))),
                button('Stamp', 'Add review stamp', () => addObject(new fabric.IText(stamp.toUpperCase(), { left: 80, top: 140,
                    fontFamily, fontWeight: 'bold', fontSize: 28, fill: color, angle: -12, annotationKind: 'stamp' })), !page)),
                toolsTab === 'pages' && h(React.Fragment, null,
                    button('ArrowUp', 'Move page earlier', () => { const next = [...pages]; [next[active - 1], next[active]] = [next[active], next[active - 1]]; changePages(next, active - 1); }, !page || active === 0),
                    button('ArrowDown', 'Move page later', () => { const next = [...pages]; [next[active + 1], next[active]] = [next[active], next[active + 1]]; changePages(next, active + 1); }, !page || active === pages.length - 1),
                    button('Copy', 'Duplicate page', () => { const next = [...pages]; next.splice(active + 1, 0, { ...page, id: crypto.randomUUID(), overlay: JSON.parse(JSON.stringify(page.overlay)) }); changePages(next, active + 1); }, !page),
                    button('RotateCw', 'Rotate page clockwise', () => {
                        const transform = [0, 1, -1, 0, canvas.current.height, 0];
                        canvas.current.getObjects().forEach(object => fabric.util.applyTransformToObject(object, fabric.util.multiplyTransformMatrices(transform, object.calcTransformMatrix())));
                        capture(); histories.current.set(page.id, { values: [page.overlay], index: 0 });
                        setPages(previous => previous.map(item => item.id === page.id ? { ...item, rotation: (item.rotation + 90) % 360 } : item));
                    }, !page),
                    button('Trash2', 'Delete current page', () => { if (window.confirm('Delete this page and its annotations?')) changePages(pages.filter(item => item.id !== page.id), active); }, !page)),
                toolsTab === 'review' && h(React.Fragment, null,
                    h('input', { className: 'finput pdf-watermark', 'aria-label': 'Watermark text', value: watermark, onChange: event => setWatermark(event.target.value) }),
                    button('Waves', 'Apply watermark to all pages', () => decoratePages('watermark'), !page || !watermark.trim()),
                    numeric('Start number', numberStart, 1, 99999, setNumberStart),
                    button('ListOrdered', 'Number all pages', () => decoratePages('page-number'), !page)),
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
                                            transform: 'rotate(' + target.angle + 'deg)' } })))))),
                h('aside', { className: 'pdf-inspector' },
                    h('div', { className: 'pdf-inspector-tabs', role: 'tablist', 'aria-label': 'PDF properties' },
                        [['format', 'Format'], ['forms', 'Forms'], ['text', 'Text'], ['document', 'Document']].map(([id, label]) =>
                            h('button', { key: id, role: 'tab', 'aria-selected': inspectorTab === id, onClick: () => setInspectorTab(id) }, label))),
                    inspectorTab === 'format' && h('div', { className: 'pdf-format-panel' },
                        (!selected || isText) && h(React.Fragment, null,
                            h('label', null, 'Font', h('div', { className: 'pdf-font-picker' },
                                h('select', { className: 'fselect', value: family, 'aria-label': 'Text font', disabled: !!busy,
                                    onChange: event => { setFontFamily(event.target.value); formatSelection({ fontFamily: event.target.value }); } },
                                    fonts.map(font => h('option', { value: font.family, key: font.family, disabled: font.family === '__mixed__', style: { fontFamily: font.family } }, font.label))),
                                button('FileType', 'Load custom TTF or OTF font', () => fontInput.current.click(), !page))),
                            isText && !multipleText && textProfile.sourceFontLabel && h('p', { className: 'pdf-font-source' },
                                (textProfile.sourceFontExact ? 'Embedded font: ' : textProfile.sourceFontKey ? 'Font fallback: ' : 'Original font: ') + textProfile.sourceFontLabel),
                            multipleText && h('p', { className: 'pdf-font-source' }, selectedTexts.length + ' selected text runs'),
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
                                h('div', { className: 'pdf-property-grid' },
                                    numeric('Line height', textProfile.lineHeight, 1, 3, value => formatSelection({ lineHeight: value }), 0.05),
                                    numeric('Tracking (%)', (textProfile.charSpacing || 0) / 10, 0, 100, value => formatSelection({ charSpacing: value * 10 }))),
                                h('label', null, multipleText ? 'Mixed-font statement' : 'Text', h('textarea', { className: 'finput pdf-selected-text', 'aria-label': 'Selected PDF text',
                                    value: multipleText ? selectedTexts.map(object => object.text).join(' ') : textProfile.text, readOnly: multipleText, disabled: !!busy,
                                    onChange: event => formatSelection({ text: event.target.value }) })))),
                        (!selected || selected.type !== 'image') && h('label', { className: 'pdf-color-control' }, 'Color', h('input', { type: 'color',
                            value: typeof selectedFill === 'string' && selectedFill.startsWith('#') ? selectedFill : color,
                            disabled: !!busy, 'aria-label': 'Annotation color', onChange: event => { setColor(event.target.value); formatSelection({ fill: event.target.value }); } })),
                        selected && h(React.Fragment, null,
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
                            !isText && selected.type !== 'image' && h(React.Fragment, null,
                                h('label', { className: 'pdf-color-control' }, 'Outline', h('input', { type: 'color', 'aria-label': 'Outline color',
                                    value: selected.stroke?.startsWith('#') ? selected.stroke : color, onChange: event => formatSelection({ stroke: event.target.value }) })),
                                numeric('Outline width', selected.strokeWidth || 0, 0, 20, value => formatSelection({ strokeWidth: value })),
                                h('label', { className: 'pdf-check-control' }, h('input', { type: 'checkbox', checked: selected.fill === 'transparent',
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
                            else control = h('span', { className: 'pdf-caution' }, 'Unsupported field; digital signing is not available.');
                            return h('label', { key: field.name }, field.name + (field.required ? ' *' : '') + (field.readOnly ? ' (read-only)' : ''), control);
                        }),
                        !!page.doc.fields.length && h('div', { className: 'pdf-page-actions' },
                            button('ClipboardCheck', 'Apply form values to preview', previewFields),
                            button('RotateCcw', 'Reset PDF form values', () => {
                                page.doc.formValues = Object.fromEntries(page.doc.fields.map(field => [field.name, field.value]));
                                setFieldRevision(version => version + 1); setDirty(true);
                            }))),
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
            signature && h('div', { className: 'pdf-signature', role: 'dialog', 'aria-label': 'Draw signature' },
                h('div', { ref: stageHost, className: 'pdf-signature-stage' }),
                button('Eraser', 'Clear signature', () => signatureStage.current?.getLayers()[0].destroyChildren()),
                button('Check', 'Insert signature image', () => {
                    if (!signatureStage.current) return;
                    fabric.Image.fromURL(signatureStage.current.toDataURL({ pixelRatio: 2 }), image => { image.scaleToWidth(220); image.set({ left: 40, top: 40 }); addObject(image); });
                    setSignature(false);
                }), button('X', 'Cancel signature', () => setSignature(false))),
            h('input', { ref: fileInput, type: 'file', accept: '.pdf,application/pdf', multiple: true, hidden: true, onChange: event => { importFiles(Array.from(event.target.files)); event.target.value = ''; } }),
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