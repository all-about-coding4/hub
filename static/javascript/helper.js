export default class lynkhub_ {
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

    async startServer() {
        this.server = this.app_.server();

        // --- Main pages ---
        this.server.get("/lynkhub/<filename>", null, async (req, res) => {

            const filen = req.params.filename;
            const data = await this.db_.select_from("html", filen);

            return new Response(data, {
                status: 200,
                headers: { "Content-Type": "text/html; charset=UTF-8" }
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
            if (rest === '') return base + '/';
            if (rest.startsWith(appName) && (rest.length === appName.length || rest[appName.length] === '/')) return rawPath;
            return base + rest;
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
