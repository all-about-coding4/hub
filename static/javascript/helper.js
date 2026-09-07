(()=>{
var lynkhub_  = class{
    constructor() {
        this.app_ = new LynkClient(`ws://${window.location.hostname}:${window.location.port}`);
        this.db_ = this.app_.createDataset("lynkHub");
        this.server = null;
        // In-memory static file cache
        this.staticFiles = new Map();
    }

    async getDB_() {
        return this.db_;
    }
    

    // Register a static file (CSS, JS, image, etc.)
    async registerStaticFile(path, content, contentType = "text/javascript") {
        this.staticFiles.set(path, { content, contentType });
        // Optionally store in IndexedDB for persistence
        // await this.db_.insert("static", { content, contentType }, path);
    }

    
    async detectContentType(data) {
        let bytes;
        let text = null;

        // ---- Normalise ----
        if (typeof data === 'string') {
            text = data;
            bytes = new TextEncoder().encode(data);
        } else if (data instanceof Blob) {
            bytes = new Uint8Array(await data.arrayBuffer());
        } else if (data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data);
        } else if (ArrayBuffer.isView(data)) {
            bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        } else {
            throw new TypeError(
                'Unsupported data type. Use string, Blob, File, ArrayBuffer, Uint8Array, or another ArrayBuffer view.'
            );
        }

        if (!bytes.length) return 'application/octet-stream';

        // ---- Binary magic detection ----
        const binaryMime = this.detectBinaryMime(bytes);
        if (binaryMime) return binaryMime;

        // ---- Decode text if needed ----
        if (text === null) {
            text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        }
        text = text.replace(/^\uFEFF/, ''); // remove BOM

        // ---- Heuristic binary check ----
        if (this.looksBinary(bytes)) return 'application/octet-stream';

        // ---- Text MIME detection ----
        return this.detectTextMime(text);
    }

    // ================================================================
    // BINARY DETECTION (magic bytes)
    // ================================================================

    detectBinaryMime(bytes) {
        const has = (...values) => {
            if (bytes.length < values.length) return false;
            for (let i = 0; i < values.length; i++) {
                if (bytes[i] !== values[i]) return false;
            }
            return true;
        };
        const ascii = (offset, length) => {
            if (offset < 0 || offset + length > bytes.length) return '';
            let result = '';
            for (let i = offset; i < offset + length; i++) {
                result += String.fromCharCode(bytes[i]);
            }
            return result;
        };

        // --- Images ---
        if (bytes.length >= 3 && has(0xFF, 0xD8, 0xFF)) return 'image/jpeg';
        if (has(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)) return 'image/png';
        if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
        if (ascii(0, 2) === 'BM') return 'image/bmp';
        if (has(0x49, 0x49, 0x2A, 0x00) || has(0x4D, 0x4D, 0x00, 0x2A)) return 'image/tiff';
        if (has(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
        if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
        if (ascii(4, 4) === 'ftyp' && (ascii(8, 4) === 'avif' || ascii(8, 4) === 'avis')) return 'image/avif';

        // --- Audio ---
        if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
        if (ascii(0, 4) === 'fLaC') return 'audio/flac';
        if (ascii(0, 4) === 'OggS') return 'audio/ogg';
        if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
        if (bytes.length >= 2 && bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) return 'audio/mpeg';

        // --- Video ---
        if (has(0x1A, 0x45, 0xDF, 0xA3)) return 'video/webm';
        if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'AVI ') return 'video/x-msvideo';
        if (bytes.length >= 12 && ascii(4, 4) === 'ftyp') {
            const brand = ascii(8, 4);
            if (brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') return 'audio/mp4';
            if (brand === 'avif' || brand === 'avis') return 'image/avif';
            return 'video/mp4';
        }

        // --- Fonts ---
        if (has(0x00, 0x01, 0x00, 0x00)) return 'font/ttf';
        if (ascii(0, 4) === 'OTTO') return 'font/otf';
        if (ascii(0, 4) === 'wOFF') return 'font/woff';
        if (ascii(0, 4) === 'wOF2') return 'font/woff2';

        // --- Archives ---
        if (has(0x50, 0x4B, 0x03, 0x04) || has(0x50, 0x4B, 0x05, 0x06) || has(0x50, 0x4B, 0x07, 0x08))
            return 'application/zip';
        if (ascii(0, 7) === 'Rar!\x1A\x07\x00' || ascii(0, 8) === 'Rar!\x1A\x07\x01\x00')
            return 'application/vnd.rar';
        if (has(0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C)) return 'application/x-7z-compressed';
        if (has(0x1F, 0x8B)) return 'application/gzip';
        if (ascii(0, 3) === 'BZh') return 'application/x-bzip2';
        if (has(0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00)) return 'application/x-xz';

        // --- Documents ---
        if (ascii(0, 5) === '%PDF-') return 'application/pdf';
        if (has(0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1))
            return 'application/vnd.ms-office';

        return null;
    }

    // ================================================================
    // BINARY HEURISTIC
    // ================================================================

    looksBinary(bytes) {
        const sample = bytes.slice(0, Math.min(bytes.length, 16384));
        if (!sample.length) return false;
        let suspicious = 0;
        for (const byte of sample) {
            if (byte === 0x00) return true;
            if (byte < 0x07 || (byte >= 0x0E && byte < 0x20 && byte !== 0x1B)) suspicious++;
        }
        return suspicious / sample.length > 0.01;
    }

    // ================================================================
    // TEXT MIME DETECTOR (scoring system)
    // ================================================================

    detectTextMime(text) {
        if (typeof text !== 'string') return 'text/plain';
        text = text.replace(/^\uFEFF/, '');
        if (!text.trim()) return 'text/plain';

        const lines = text.split(/\r?\n/);
        const sampleLines = lines.slice(0, 1000);
        const sample = sampleLines.join('\n');
        const trimmed = sample.trim();
        if (!trimmed) return 'text/plain';

        // Normalise: remove comments and strings from the "code" portion
        const { code, comments, strings } = this.normalizeSource(sample);

        // Scoring
        const scores = { html: 0, css: 0, javascript: 0, json: 0, xml: 0 };

        this.scoreHTML(sample, code, scores);
        this.scoreXML(sample, code, scores);
        this.scoreJSON(sample, trimmed, code, scores);
        this.scoreCSS(sample, code, comments, strings, scores);
        this.scoreJavaScript(sample, code, comments, strings, scores);

        // Sort and apply confidence thresholds
        const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        const best = ranked[0];
        const second = ranked[1] || ['', 0];

        if (best[1] < 10) return 'text/plain';
        if (second[1] > 0 && best[1] < second[1] * 1.4) return 'text/plain';

        const map = {
            html: 'text/html',
            css: 'text/css',
            javascript: 'application/javascript',
            json: 'application/json',
            xml: 'application/xml',
        };
        return map[best[0]] || 'text/plain';
    }

    // ================================================================
    // NORMALIZE SOURCE – strips comments and strings
    // ================================================================

    normalizeSource(source) {
        let code = '';
        let comments = '';
        let strings = '';
        let i = 0;
        let state = 'normal';

        while (i < source.length) {
            const c = source[i];
            const n = source[i + 1];

            if (state === 'normal') {
                if (c === '/' && n === '/') {
                    state = 'line-comment';
                    comments += '//';
                    code += '  ';
                    i += 2;
                    continue;
                }
                if (c === '/' && n === '*') {
                    state = 'block-comment';
                    comments += '/*';
                    code += '  ';
                    i += 2;
                    continue;
                }
                if (c === "'" || c === '"' || c === '`') {
                    state = c === '`' ? 'template-string' : c === "'" ? 'single-string' : 'double-string';
                    strings += c;
                    code += ' ';
                    i++;
                    continue;
                }
                code += c;
                i++;
                continue;
            }

            if (state === 'line-comment') {
                comments += c;
                if (c === '\n') { code += '\n'; state = 'normal'; } else code += ' ';
                i++;
                continue;
            }

            if (state === 'block-comment') {
                comments += c;
                if (c === '*' && n === '/') {
                    comments += '/';
                    code += '  ';
                    state = 'normal';
                    i += 2;
                } else {
                    code += c === '\n' ? '\n' : ' ';
                    i++;
                }
                continue;
            }

            if (state === 'single-string' || state === 'double-string') {
                strings += c;
                if (c === '\\') {
                    strings += source[i + 1] || '';
                    i += 2;
                    continue;
                }
                if ((state === 'single-string' && c === "'") || (state === 'double-string' && c === '"')) {
                    state = 'normal';
                }
                code += ' ';
                i++;
                continue;
            }

            if (state === 'template-string') {
                strings += c;
                if (c === '\\') {
                    strings += source[i + 1] || '';
                    i += 2;
                    continue;
                }
                if (c === '`') state = 'normal';
                code += ' ';
                i++;
                continue;
            }
        }

        return { code, comments, strings };
    }

    // ================================================================
    // SCORING FUNCTIONS
    // ================================================================

    scoreHTML(source, code, scores) {
        const lower = source.toLowerCase();
        if (/<!doctype\s+html\b/i.test(source)) scores.html += 50;
        if (/<html\b[^>]*>/i.test(source)) scores.html += 40;
        if (/<head\b[^>]*>/i.test(source)) scores.html += 15;
        if (/<body\b[^>]*>/i.test(source)) scores.html += 15;

        const tags = ['div', 'span', 'p', 'a', 'img', 'script', 'style', 'link', 'meta', 'title',
            'form', 'input', 'button', 'textarea', 'select', 'option', 'table', 'tr', 'td',
            'ul', 'ol', 'li', 'main', 'section', 'article', 'header', 'footer', 'nav',
            'video', 'audio', 'canvas'];
        let count = 0;
        for (const tag of tags) {
            const matches = lower.match(new RegExp(`<${tag}\\b`, 'gi'));
            if (matches) count += matches.length;
        }
        if (count >= 2) scores.html += Math.min(30, count * 3);

        const closing = (source.match(/<\/[a-zA-Z][\w:-]*\s*>/g) || []).length;
        if (closing >= 2) scores.html += Math.min(20, closing * 2);

        const attrs = (source.match(/\s(?:class|id|href|src|style|onclick|data-[\w-]+|aria-[\w-]+)\s*=/gi) || []).length;
        if (attrs >= 2) scores.html += Math.min(15, attrs * 2);
    }

    scoreXML(source, code, scores) {
        if (/^\s*<\?xml\b/i.test(source)) scores.xml += 50;
        if (/\bxmlns(?::[\w.-]+)?\s*=/i.test(source)) scores.xml += 20;
        if (/^\s*<svg\b/i.test(source)) scores.xml += 10;
        if (/\bxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(source)) scores.xml += 30;
        const tags = (source.match(/<([a-zA-Z][\w:.-]*)(?:\s[^>]*)?>/g) || []).length;
        const closing = (source.match(/<\/[a-zA-Z][\w:.-]*>/g) || []).length;
        if (tags >= 3 && closing >= 2) scores.xml += 20;
    }

    scoreJSON(source, trimmed, code, scores) {
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
        try { JSON.parse(trimmed); scores.json += 100; return; } catch (_) {}
        try { JSON.parse(source.trim()); scores.json += 100; return; } catch (_) {}
        const props = (source.match(/["'][^"'\n]+["']\s*:\s*(?:"[^"]*"|\d+(?:\.\d+)?|true|false|null|\[|\{)/g) || []).length;
        if (props >= 2) scores.json += 25;
        if (/^\s*\{\s*["'][^"']+["']\s*:/.test(trimmed)) scores.json += 20;
        if (/^\s*\[\s*(?:"|{|[0-9]|true|false|null)/.test(trimmed)) scores.json += 15;
        if ((source.match(/;/g) || []).length > 3) scores.json -= 20;
        scores.json = Math.max(0, scores.json);
    }

    scoreCSS(source, code, comments, strings, scores) {
        // @rules
        const atRules = (code.match(/@(?:charset|import|media|supports|font-face|keyframes|layer|container|namespace|page|property|scope)\b/gi) || []).length;
        scores.css += atRules * 8;

        // Blocks
        const blocks = (code.match(/(?:^|[}\n])\s*(?:[#.:\w*[\]>~+="-]|[a-zA-Z])[^{}]{0,200}\{[\s\S]{0,1000}\}/g) || []);
        if (blocks.length >= 1) scores.css += 12;
        if (blocks.length >= 2) scores.css += 15;
        if (blocks.length >= 4) scores.css += 15;

        // Declarations
        const decls = (code.match(/(?:^|[;{\n])\s*--?[\w-]+\s*:\s*[^;{}]+[;}]?/g) || []).length;
        if (decls >= 2) scores.css += 20;
        if (decls >= 5) scores.css += 20;
        if (decls >= 10) scores.css += 15;

        // Common CSS properties
        const props = ['display', 'position', 'margin', 'padding', 'width', 'height', 'color',
            'background', 'background-color', 'font-size', 'font-family', 'border', 'border-radius',
            'flex', 'grid', 'gap', 'align-items', 'justify-content', 'transform', 'transition',
            'animation', 'opacity', 'overflow', 'z-index'];
        let propHits = 0;
        for (const prop of props) {
            propHits += (code.match(new RegExp(`(?:^|[;{\\n])\\s*${prop}\\s*:`, 'g')) || []).length;
        }
        if (propHits >= 2) scores.css += 15;
        if (propHits >= 5) scores.css += 20;
        if (propHits >= 10) scores.css += 20;

        // CSS values (px, em, etc.)
        const values = (code.match(/\b(?:px|em|rem|vh|vw|vmin|vmax|deg|s|ms|fr)\b/g) || []).length;
        if (values >= 3) scores.css += 8;
        if (values >= 10) scores.css += 10;

        // CSS variables
        const vars = (code.match(/--[\w-]+\s*:/g) || []).length;
        if (vars >= 2) scores.css += 12;

        // Penalize JS
        const jsStrong = (code.match(/\b(?:import|export|function|class|const|let|var|async|await)\b/g) || []).length;
        if (jsStrong >= 3) scores.css -= 20;
        scores.css = Math.max(0, scores.css);
    }

    scoreJavaScript(source, code, comments, strings, scores) {
        // ES modules
        const imports = (code.match(/\bimport\s+(?:[\s\S]{0,300}?\s+from\s+)?["'][^"']+["']/g) || []).length;
        const exports = (code.match(/\bexport\s+(?:default\s+)?(?:class|function|const|let|var|\{)/g) || []).length;
        if (imports >= 1) scores.javascript += 35;
        if (imports >= 2) scores.javascript += 20;
        if (exports >= 1) scores.javascript += 30;

        // Declarations
        const decls = (code.match(/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*/g) || []).length;
        if (decls >= 2) scores.javascript += 12;
        if (decls >= 5) scores.javascript += 15;
        if (decls >= 10) scores.javascript += 15;

        // Functions
        const funcs = (code.match(/\bfunction(?:\s*\*)?\s*[A-Za-z_$]?[\w$]*\s*\(/g) || []).length;
        if (funcs >= 1) scores.javascript += 15;
        if (funcs >= 3) scores.javascript += 15;

        // Arrow functions
        const arrows = (code.match(/(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g) || []).length;
        if (arrows >= 1) scores.javascript += 15;
        if (arrows >= 3) scores.javascript += 15;

        // Classes
        const classes = (code.match(/\bclass\s+[A-Za-z_$][\w$]*/g) || []).length;
        if (classes >= 1) scores.javascript += 20;

        // JSX / TSX: <Component />, <div ...>
        const jsx = (code.match(/<[A-Z]\w*(?:\s+[^>]*)?\/?>/g) || []).length;
        if (jsx >= 2) scores.javascript += 20;

        // TypeScript: interface, type, as, : type annotations
        const ts = (code.match(/\b(?:interface|type|as|implements|extends)\s+/g) || []).length;
        if (ts >= 2) scores.javascript += 15;

        // Keywords
        const keywords = (code.match(/\b(?:return|throw|new|typeof|instanceof|this|delete|in|of|yield|await|async|try|catch|finally|switch|case|break|continue)\b/g) || []).length;
        if (keywords >= 3) scores.javascript += 12;
        if (keywords >= 8) scores.javascript += 15;

        // Common APIs
        const apis = (code.match(/\b(?:document|window|console|navigator|location|localStorage|sessionStorage|fetch|URL|URLSearchParams|WebSocket|Worker|Blob|File|FileReader|indexedDB|crypto|setTimeout|setInterval|Promise|JSON|Math|Date)\b/g) || []).length;
        if (apis >= 2) scores.javascript += 15;
        if (apis >= 5) scores.javascript += 20;

        // Method calls
        const methods = (code.match(/\b[A-Za-z_$][\w$]*\s*\.\s*[A-Za-z_$][\w$]*\s*\(/g) || []).length;
        if (methods >= 3) scores.javascript += 10;
        if (methods >= 8) scores.javascript += 15;

        // Operators
        const ops = (code.match(/===|!==|=>|\?\?|&&|\|\||\?\.|\+=|-=|\*=|\/=|\*\*|<<|>>/g) || []).length;
        if (ops >= 2) scores.javascript += 10;
        if (ops >= 6) scores.javascript += 15;

        // Semicolons
        const semis = (code.match(/;/g) || []).length;
        if (semis >= 5) scores.javascript += 8;
        if (semis >= 15) scores.javascript += 12;
        if (semis >= 30) scores.javascript += 10;

        // Bracket balance
        const curlyOpen = (code.match(/\{/g) || []).length;
        const curlyClose = (code.match(/\}/g) || []).length;
        const parenOpen = (code.match(/\(/g) || []).length;
        const parenClose = (code.match(/\)/g) || []).length;
        if (curlyOpen >= 2 && curlyClose >= 2 && parenOpen >= 2 && parenClose >= 2) {
            scores.javascript += 8;
        }

        // Object properties
        const objProps = (code.match(/\b[A-Za-z_$][\w$]*\s*:\s*(?!\/\/)/g) || []).length;
        if (objProps >= 4) scores.javascript += 8;
        if (objProps >= 10) scores.javascript += 10;

        // Strong JS syntax
        const strong = (code.match(/\b(?:import|export|function|class)\b|=>|===|!==|\?\?|\?\./g) || []).length;
        if (strong >= 2) scores.javascript += 15;
        if (strong >= 5) scores.javascript += 20;

        // Penalise CSS-like declarations
        const cssDecls = (code.match(/(?:^|[;{\n])\s*(?:display|position|margin|padding|color|background|width|height|font-size|border|flex|grid)\s*:/g) || []).length;
        if (cssDecls >= 5) scores.javascript -= 20;
        scores.javascript = Math.max(0, scores.javascript);
    }

    async get_appstore(){
        const url = "./app.manifest.json";
    }



    async startServer() {
        this.server = this.app_.server();

        // --- Main pages ---
        this.server.get("/lynkhub/home.html", null, async (req, res) => {

            const data = await this.db_.select_from("html", "home.html");

            return new Response(data, {
                status: 200,
                headers: { "Content-Type": "text/html; charset=UTF-8" }
            });
        });

        this.server.get("/lynkhub/*", null, async(req, res)=>{
            const filePath = "/"+req.wildcard;
            console.log("Wildcat" + filePath);

            const data = await this.db_.select_from("static", filePath);
            const contentType = await this.detectContentType(data);

            console.log(contentType);

            return new Response(data, {
                status: 200,
                headers: {
                    "Content-Type": contentType
                }
            });

        });

        this.server.get("/editor", null, async (req, res) => {
            const html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <title>LynkHub Editor</title>
                    <link rel="stylesheet" href="/editor/style.css">
                    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
                </head>
                <body>
                    <i class="fas fa-arrow-left" onclick="history.back()"></i>
                    <h1>Editor page</h1>
                    <p>This content is served by the Lynkio route.</p>
                    <script src="/editor/app.js"></script>
                    <script type="module">
                        import joe from "/editor/app.js";
                        console.log('Editor page loaded (iframe)');
                    </script>
                </body>
                </html>
            `;
            return new Response(html, {
                status: 200,
                headers: { "Content-Type": "text/html; charset=UTF-8" }
            });
        });

        // --- WILDCARD: serve static assets under /editor/* ---
        this.server.get("/editor/*", null, async (req, res) => {
            const filePath = req.wildcard; // e.g., "style.css", "app.js"
            console.log(`Serving static: /editor/${filePath}`);

            // 1. Check in-memory cache
            if (this.staticFiles.has(filePath)) {
                const { content, contentType } = this.staticFiles.get(filePath);
                return new Response(content, {
                    status: 200,
                    headers: { "Content-Type": contentType }
                });
            }

            // 2. Check IndexedDB (optional)
            // const stored = await this.db_.select_from("static", filePath);
            // if (stored) { ... }

            // 3. Fallback to network (or return 404)
            try {
                const response = await fetch(`/static/${filePath}`);
                if (response.ok) return response;
            } catch (e) {}

            return new Response(`File /editor/${filePath} not found`, {
                status: 404,
                headers: { "Content-Type": "text/plain" }
            });
        });

        // --- Register example static files ---
        await this.registerStaticFile("style.css", `
            body { font-family: system-ui; background: #f0f2f5; padding: 20px; }
            h1 { color: #007aff; }
        `, "text/css");

        await this.registerStaticFile("app.js", `
            console.log('Editor app script loaded!');
            document.querySelector('h1').style.color = 'green';
        `, "application/javascript");

        await this.server.ready();
        await new Promise(resolve => setTimeout(resolve, 100));
        console.log("Server ready");
    }
    
    async rewriteAppPaths(code, appName) {
    const base = '/' + appName.replace(/^\/+|\/+$/g, '');
    function rewritePath(rawPath) {
        const rest = rawPath.replace(/^\.?\//, '');
        // Avoid double‑prefixing
        if (rest.startsWith(appName) &&
            (rest.length === appName.length || rest[appName.length] === '/')) {
            return rawPath;
        }
        return base + '/' + rest; // ensures a slash between base and rest
    }
    const quotedRegex = /(["'`])((?:\.?\/)[^"'\`]*?)(["'`])/g;
    let result = code.replace(quotedRegex, (match, open, path, close) => open + rewritePath(path) + close);
    const cssUrlRegex = /url\(\s*((?:\.?\/)[^)\s]*)\s*\)/g;
    result = result.replace(cssUrlRegex, (match, path) => 'url(' + rewritePath(path) + ')');
    const attrRegex = /(src|href|action|data-[a-zA-Z0-9_-]+)\s*=\s*((?:\.?\/)[^\s>'"]+)/g;
    result = result.replace(attrRegex, (match, attr, path) => attr + '=' + rewritePath(path));
    return result;
}
    
}

globalThis.lynkhub_ = lynkhub_;
})();
