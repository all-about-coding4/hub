(() => {
  // ---------- dataset.js ----------
  var user_dataset = class {
    constructor(db_name) {
      this.db_name = db_name;
      this.db_version = 1;
    }
    async openDB() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(this.db_name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    async getVersion() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(this.db_name);
        request.onsuccess = () => {
          const db = request.result;
          const version = db.version;
          db.close();
          resolve(version);
        };
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = (event) => {
          event.target.result.close();
          resolve(1);
        };
      });
    }
    async create_table(table_name) {
      const currentVersion = await this.getVersion();
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(this.db_name, currentVersion + 1);
        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(table_name)) {
            db.createObjectStore(table_name);
          }
        };
        request.onsuccess = () => {
          request.result.close();
          resolve(true);
        };
        request.onerror = () => reject(request.error);
      });
    }
    async insert(table_name, value, key) {
      try {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(table_name, "readwrite");
          const store = tx.objectStore(table_name);
          store.put(value, key);
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        });
      } catch (error) {
        console.error(error);
        return false;
      }
    }
    async select_from(table_name, key) {
      try {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(table_name, "readonly");
          const store = tx.objectStore(table_name);
          const request = store.get(key);
          request.onsuccess = () => {
            db.close();
            resolve(request.result);
          };
          request.onerror = () => reject(request.error);
        });
      } catch (error) {
        console.error(error);
        return false;
      }
    }
    async delete_from(table_name, key) {
      try {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(table_name, "readwrite");
          const store = tx.objectStore(table_name);
          store.delete(key);
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        });
      } catch (error) {
        console.error(error);
        return false;
      }
    }
    async delete_all(table_name) {
      try {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(table_name, "readwrite");
          const store = tx.objectStore(table_name);
          store.clear();
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        });
      } catch (error) {
        console.error(error);
        return false;
      }
    }
    async delete_dataset() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(this.db_name);
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error);
      });
    }
  };

  // ---------- server.js ----------
  var server = class {
    constructor(options = {}) {
      this.server_version = 1;
      this.routes_db = new Map();
      this.params_db = new Map();
      this.wildcard_db = new Map();

      this.middleware = [];
      this.responseInterceptors = [];

      this.sworker = null;
      this.woker = null;

      this.options = options;
      this.port = options.port;
      this.hostname = options.hostname;

      // Track pending route registrations
      this._pendingRegistrations = [];

      this.sready = this.sfgo();
    }

    async sfgo() {
      this.sworker = await navigator.serviceWorker.register(
        "./swjs-v1.0.0.js",
        { scope: "/" }
      );

      await navigator.serviceWorker.ready;

      this.woker = navigator.serviceWorker.controller || this.sworker.active;

      if (!this.woker) {
        throw new Error("Service Worker is not controlling this page");
      }

      navigator.serviceWorker.addEventListener("message", (event) => {
        const message = event.data;
        if (message.type === "execute-request") {
          this._executeRoute(message);
        }
      });

      console.log("Worker ready", this.sworker);
      return this.sworker;
    }

    _deepSanitize(obj) {
      if (obj === null || typeof obj !== "object") {
        return obj;
      }
      if (obj instanceof URL) {
        return obj.toString();
      }
      if (obj instanceof Date) {
        return obj.toISOString();
      }
      if (Array.isArray(obj)) {
        return obj.map((item) => this._deepSanitize(item));
      }
      const sanitized = {};
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === "function") {
          continue;
        }
        sanitized[key] = this._deepSanitize(value);
      }
      return sanitized;
    }

    async _postmsg(msg) {
      await this.sready;
      const sanitized = this._deepSanitize(msg);
      this.woker?.postMessage(sanitized);
    }

    // ---------- Middleware registration ----------
    use(fn) {
      if (typeof fn !== "function") {
        throw new Error("Middleware must be a function");
      }
      this.middleware.push(fn);
      return this;
    }

    intercept(fn) {
      if (typeof fn !== "function") {
        throw new Error("Interceptor must be a function");
      }
      this.responseInterceptors.push(fn);
      return this;
    }

    // ---------- Wait for all routes to be registered ----------
    async ready() {
      await Promise.all(this._pendingRegistrations);
    }

    // ---------- Enhanced _executeRoute ----------
    async _executeRoute(message) {
      const url = new URL(message.request.url);
      const query = Object.fromEntries(url.searchParams.entries());

      const req = {
        requestId: message.requestId,
        url: message.request.url,
        method: message.request.method,
        pathname: message.request.pathname,
        hostname: message.request.hostname,
        port: message.request.port,
        headers: { ...message.request.headers },
        query: { ...query },
        cookies: { ...message.request.cookies },
        timestamp: message.request.timestamp,
        body: message.request.body,
        bodyType: message.request.bodyType,
        params: null,
        wildcard: null,
        route: null
      };

      if (message.route_type === "param") {
        req.params = message.param_data;
      } else if (message.route_type === "wildcard") {
        req.wildcard = message.wildcard_data;
      } else if (message.route_type === "route") {
        req.route = message.route_data;
      }

      const res = {
        status: 200,
        headers: { "Content-Type": "text/plain" },
        body: "",
        finished: false,
        json: function(data) {
          this.headers["Content-Type"] = "application/json";
          this.body = JSON.stringify(data);
          return this;
        },
        text: function(data) {
          this.headers["Content-Type"] = "text/plain";
          this.body = String(data);
          return this;
        },
        status: function(code) {
          this.status = code;
          return this;
        },
        setHeader: function(key, value) {
          this.headers[key] = value;
          return this;
        }
      };

      let handler = null;
      if (message.route_type === "param") {
        handler = this.params_db.get(message.params.key)?.execute;
      } else if (message.route_type === "wildcard") {
        handler = this.wildcard_db.get(message.wildcard.key)?.execute;
      } else {
        handler = this.routes_db.get(message.route.key)?.execute;
      }

      if (!handler) {
        await this._sendError(message.requestId, new Error("Route handler not found"));
        return;
      }

      const middlewares = [...this.middleware];
      let index = 0;
      const next = async () => {
        if (index < middlewares.length) {
          const fn = middlewares[index++];
          try {
            await fn(req, res, next);
            if (res.finished) {
              for (const interceptor of this.responseInterceptors) {
                await interceptor(req, res, () => {});
              }
              await this._sendResponseBuilder(message.requestId, res);
              return;
            }
          } catch (err) {
            await this._sendError(message.requestId, err);
            return;
          }
        } else {
          try {
            let result = await handler(req, res);
            if (result !== undefined) {
              if (result instanceof Response) {
                await this._sendResponse(message.requestId, result);
                return;
              }
              if (typeof result === "object") {
                res.json(result);
              } else {
                res.text(result);
              }
            }
            if (res.finished) {
              for (const interceptor of this.responseInterceptors) {
                await interceptor(req, res, () => {});
              }
              await this._sendResponseBuilder(message.requestId, res);
              return;
            }
            for (const interceptor of this.responseInterceptors) {
              await interceptor(req, res, () => {});
            }
            await this._sendResponseBuilder(message.requestId, res);
          } catch (err) {
            await this._sendError(message.requestId, err);
          }
        }
      };

      await next();
    }

    async _sendResponseBuilder(requestId, res) {
      await this._postmsg({
        type: "route-response",
        requestId,
        status: res.status || 200,
        body: res.body ?? "",
        headers: res.headers || {}
      });
    }

    async _sendResponse(requestId, result) {
      if (result instanceof Response) {
        const body = await result.text();
        const headers = {};
        for (const [k, v] of result.headers.entries()) {
          headers[k] = v;
        }
        return await this._postmsg({
          type: "route-response",
          requestId,
          status: result.status,
          body,
          headers
        });
      }
      await this._sendResponseBuilder(requestId, {
        status: result?.status ?? 200,
        body: result?.body ?? result ?? "",
        headers: { "Content-Type": "text/plain" }
      });
    }

    async _sendError(requestId, err) {
      await this._postmsg({
        type: "route-response",
        requestId,
        status: 500,
        body: err?.message || "Internal Server Error",
        headers: { "Content-Type": "text/plain" }
      });
    }

    // ---------- Route registration ----------
    get(path, listener, execute) {
      this._register("GET", path, execute, listener, {});
    }
    post(path, listener, execute) {
      this._register("POST", path, execute, listener, {});
    }
    delete(path, listener, execute) {
      this._register("DELETE", path, execute, listener, {});
    }
    put(path, listener, execute) {
      this._register("PUT", path, execute, listener, {});
    }
    route(path, listener, options = { method: "" }, execute) {
      if (!options.method) {
        throw new Error("A route requires a method either (GET, POST etc)");
      }
      this._register(options.method, path, execute, listener, options);
    }

    async _register(method, path, execute, listener, options) {
      if (!path) {
        throw new Error("Route path is required");
      }
      if (typeof execute !== "function") {
        throw new Error(`Route handler for ${method}:${path} must be a function`);
      }

      const port = this.port;

      const isWildcard = path.includes("*");
      let basePath = path;
      if (isWildcard) {
        basePath = path.replace(/\*$/, "").replace(/\/\*/g, "");
        if (basePath !== "" && !basePath.endsWith("/")) {
          basePath += "/";
        }
      }

      const key = `${method}:${path}:${port}`;

      if (this.routes_db.has(key) || this.params_db.has(key) || this.wildcard_db.has(key)) {
        throw new Error(`Path with name ${key} already registered`);
      }

      let regPromise;
      if (isWildcard) {
        const wc = {
          type: "wildcard",
          key: key,
          path: path,
          basePath: basePath,
          method,
          port: port,
          hostname: this.hostname,
          listener: this.options.listeners,
          execute: execute
        };
        this.wildcard_db.set(key, wc);
        const clone = { ...wc };
        delete clone.execute;
        regPromise = this._postmsg(clone);
        this._pendingRegistrations.push(regPromise);
        await regPromise;
        return;
      }

      const paramNames = [...path.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
      if (paramNames.length > 0) {
        const pd = {
          type: "param",
          key: key,
          path,
          method,
          port: port,
          hostname: this.hostname,
          listener: this.options.listeners,
          execute: execute
        };
        this.params_db.set(key, pd);
        const clone = { ...pd };
        delete clone.execute;
        regPromise = this._postmsg(clone);
        this._pendingRegistrations.push(regPromise);
        await regPromise;
      } else {
        const rd = {
          type: "route",
          key: key,
          path,
          method,
          port: port,
          hostname: this.hostname,
          listener: this.options.listeners,
          execute: execute
        };
        this.routes_db.set(key, rd);
        const clone = { ...rd };
        delete clone.execute;
        regPromise = this._postmsg(clone);
        this._pendingRegistrations.push(regPromise);
        await regPromise;
      }
    }

    async cache(files = [], options = {}) {
      await this._postmsg({
        type: "cache",
        files,
        options
      });
    }
  };

  // ---------- LynkClient ----------
  var LynkClient = class {
    constructor(host, listeners = {}, options = {}) {
      this.url = new URL(host);
      this.ws = null;
      this.handlers = {};
      this.binaryHandlers = [];
      this.binaryEventHandlers = {};
      this.connectionPromise = null;
      this._connectResolve = null;
      this._connectReject = null;
      this.reconnectAttempts = 0;
      this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
      this.reconnectDelay = options.reconnectDelay || 1000;
      this.shouldReconnect = true;
      this._tasks = [];

      this.port = this.url.port;
      this.options = {};
      this.listeners = listeners;
      this.hostname = this.url.hostname;
      this.options.hostname = this.hostname;
      this.options.server_url = this.url;
      this.options.server_port = this.port;
      this.options.port = this.port;   // port fix
      this.options.listeners = this.listeners;

      this._serverInstance = null;
    }

    connect() {
      if (this.connectionPromise) return this.connectionPromise;
      this.connectionPromise = new Promise((resolve, reject) => {
        this._connectResolve = resolve;
        this._connectReject = reject;
      });
      this._doConnect();
      return this.connectionPromise;
    }

    _doConnect() {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = "arraybuffer";

      this.ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const data = new Uint8Array(event.data);
          let eventName = null;
          let payload = data;
          if (data.length >= 2) {
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const nameLen = view.getUint16(0, false);
            if (data.length >= 2 + nameLen) {
              const nameBytes = data.slice(2, 2 + nameLen);
              eventName = new TextDecoder().decode(nameBytes);
              payload = data.slice(2 + nameLen);
            }
          }
          if (eventName && this.binaryEventHandlers[eventName]) {
            this.binaryEventHandlers[eventName](payload);
          }
          this.binaryHandlers.forEach((handler) => handler(data));
        } else {
          try {
            const msg = JSON.parse(event.data);
            const { event: evt, data } = msg;
            if (this.handlers[evt]) {
              this.handlers[evt](data);
            }
          } catch (e) {
            console.error("Failed to parse message", e);
          }
        }
      };

      this.ws.onopen = () => {
        console.log("Lynk WebSocket connected");
        this.reconnectAttempts = 0;
        if (this._connectResolve) {
          this._connectResolve();
          this._connectResolve = null;
          this._connectReject = null;
        }
      };

      this.ws.onclose = (event) => {
        console.log(`Lynk WebSocket closed (code: ${event.code})`);
        if (this._connectReject) {
          this._connectReject(new Error("Connection closed before open"));
          this._connectResolve = null;
          this._connectReject = null;
        }
        this.connectionPromise = null;
        this.ws = null;
        if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
          this.reconnectAttempts++;
          console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
          setTimeout(() => this._doConnect(), delay);
        } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.log("Max reconnect attempts reached");
        }
      };

      this.ws.onerror = (err) => {
        console.error("Lynk WebSocket error", err);
        if (this._connectReject) {
          this._connectReject(err);
          this._connectResolve = null;
          this._connectReject = null;
        }
      };
    }

    on(event, callback) {
      this.handlers[event] = callback;
    }

    emit(event, data) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ event, data }));
      } else {
        console.warn("WebSocket not open, cannot emit", event);
      }
    }

    onBinary(callback) {
      this.binaryHandlers.push(callback);
    }

    onBinaryEvent(eventName, callback) {
      if (typeof eventName === "string") {
        this.binaryEventHandlers[eventName] = callback;
      } else {
        this.binaryHandlers.push(eventName);
      }
    }

    sendBinary(data) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(data);
      } else {
        console.warn("WebSocket not open, cannot send binary");
      }
    }

    sendBinaryEvent(eventName, data) {
      const nameBytes = new TextEncoder().encode(eventName);
      const header = new Uint8Array(2 + nameBytes.length);
      const view = new DataView(header.buffer);
      view.setUint16(0, nameBytes.length, false);
      header.set(nameBytes, 2);
      const payload = data instanceof Uint8Array ? data : new Uint8Array(data);
      const combined = new Uint8Array(header.length + payload.length);
      combined.set(header);
      combined.set(payload, header.length);
      this.sendBinary(combined.buffer);
    }

    createTask(fn, interval = 0) {
      let id;
      if (interval > 0) {
        id = setInterval(fn, interval);
      } else {
        id = setTimeout(fn, 0);
      }
      this._tasks.push(id);
      return id;
    }

    scheduleTask(interval, fn) {
      return this.createTask(fn, interval);
    }

    clearTask(id) {
      clearInterval(id);
      clearTimeout(id);
      const idx = this._tasks.indexOf(id);
      if (idx > -1) this._tasks.splice(idx, 1);
    }

    joinRoom(room) {
      this.emit("join", { room });
    }

    leaveRoom(room) {
      this.emit("leave", { room });
    }

    setSession(key, value) {
      this.emit("set_session", { key, value });
    }

    sendUdp(path, data) {
      this.emit("__udp", { path, data });
    }

    close() {
      this.shouldReconnect = false;
      this._tasks.forEach((id) => {
        clearInterval(id);
        clearTimeout(id);
      });
      this._tasks = [];
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      this.connectionPromise = null;
      this._connectResolve = null;
      this._connectReject = null;
    }

    createDataset(db_name) {
      return new user_dataset(db_name);
    }

    server() {
      if (!this._serverInstance) {
        console.log("Creating new server instance with port", this.options.server_port);
        this._serverInstance = new server(this.options);
      }
      console.log("server running..");
      return this._serverInstance;
    }
  };

  globalThis.LynkClient = LynkClient;
})();
