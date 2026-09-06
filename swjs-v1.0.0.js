let routes = new Map();
let route_params = [];
let wildcard_routes = [];
const pendingRequests = new Map();
const CACHE_NAME = "lynkio2";
const DB_NAME = "LynkioSW";
const STORE_NAME = "routes";

// ---------- IndexedDB helpers ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveRoute(route) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(route);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadRoutes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---------- Install & Activate ----------
self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", async event => {
  event.waitUntil((async () => {
    await self.clients.claim();
    const stored = await loadRoutes();
    for (const route of stored) {
      if (route.type === "route") {
        routes.set(route.key, route);
      } else if (route.type === "param") {
        route_params.push(route);
      } else if (route.type === "wildcard") {
        wildcard_routes.push(route);
      }
    }
    console.log(`Loaded ${stored.length} persisted routes.`);
  })());
});

// ---------- Message handler ----------
self.addEventListener("message", async event => {
  const structure = event.data;
  console.log("SW received message:", structure);

  if (structure.type === "route") {
    routes.set(structure.key, structure);
    await saveRoute(structure);
  } else if (structure.type === "param") {
    route_params.push(structure);
    await saveRoute(structure);
  } else if (structure.type === "wildcard") {
    wildcard_routes.push(structure);
    await saveRoute(structure);
  } else if (structure.type === "route-response") {
    const pending = pendingRequests.get(structure.requestId);
    if (!pending) return;
    pending.resolve(structure);
    pendingRequests.delete(structure.requestId);
  } else if (structure.type === "cache") {
    event.waitUntil(cacheResources(structure.files));
  }
});

// ---------- Cache helper ----------
async function cacheResources(files) {
  const cache = await caches.open(CACHE_NAME);
  for (const file of files) {
    try {
      const response = await fetch(file);
      if (response.ok) {
        await cache.put(file, response.clone());
        console.log("Cached:", file);
      }
    } catch (error) {
      console.error("Failed to cache:", file, error);
    }
  }
}

// ---------- Fetch handler ----------
self.addEventListener("fetch", async event => {
  const url = new URL(event.request.url);
  if (url.pathname === "/lynkio/service-ws.js") return;
  await event.respondWith(handleRequest(event.request));
});

// ---------- Route matching ----------
function normalizePath(path) {
  if (path !== "/" && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

function matchRoute(routePath, requestPath) {
  const normRoute = normalizePath(routePath);
  const normReq = normalizePath(requestPath);
  const routeParts = normRoute.split("/").filter(Boolean);
  const reqParts = normReq.split("/").filter(Boolean);
  if (!routePath.includes("<")) {
    return normRoute === normReq ? {} : null;
  }
  if (routeParts.length !== reqParts.length) return null;
  const params = {};
  for (let i = 0; i < routeParts.length; i++) {
    const rPart = routeParts[i];
    const reqPart = reqParts[i];
    if (rPart.startsWith("<") && rPart.endsWith(">")) {
      const name = rPart.slice(1, -1);
      params[name] = decodeURIComponent(reqPart);
    } else if (rPart !== reqPart) {
      return null;
    }
  }
  return params;
}

function matchWildcard(route, requestPath) {
  const base = route.basePath;
  if (base === "") return { wildcard: requestPath };
  const normBase = normalizePath(base);
  const normReq = normalizePath(requestPath);
  if (normReq.startsWith(normBase)) {
    const remainder = normReq.slice(normBase.length);
    const wildcard = remainder.startsWith("/") ? remainder.slice(1) : remainder;
    return { wildcard: wildcard || "" };
  }
  return null;
}

// ---------- Request handler ----------
async function handleRequest(request) {
  const url = new URL(request.url);
  const method = request.method;
  const rawPathname = url.pathname;
  const pathname = normalizePath(rawPathname);
  const port = url.port;
  const hostname = url.hostname;

  let matchedRoute = null;
  let routeType = null;
  let paramData = null;
  let wildcardData = null;

  // 1. Exact routes
  const exactKey = `${method}:${pathname}:${port}`;
  if (routes.has(exactKey)) {
    matchedRoute = routes.get(exactKey);
    routeType = "route";
  } else {
    // 2. Param routes
    for (const route of route_params) {
      const params = matchRoute(route.path, rawPathname);
      if (params !== null && route.hostname === hostname && route.method === method && route.port === port) {
        matchedRoute = route;
        routeType = "param";
        paramData = params;
        break;
      }
    }
    if (!matchedRoute) {
      // 3. Wildcard routes
      for (const route of wildcard_routes) {
        const match = matchWildcard(route, rawPathname);
        if (match !== null && route.hostname === hostname && route.method === method && route.port === port) {
          matchedRoute = route;
          routeType = "wildcard";
          wildcardData = match.wildcard;
          break;
        }
      }
    }
  }

  if (!matchedRoute) {
    try { return await fetch(request); } catch { return new Response("Not Found", { status: 404 }); }
  }

  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (!clients.length) {
    return new Response("Lynkio client unavailable", { status: 500 });
  }

  const client = clients[0];
  const requestId = crypto.randomUUID();
  const responsePromise = new Promise(resolve => pendingRequests.set(requestId, { resolve }));

  const requestObj = {
    requestId,
    url: request.url,
    method: request.method,
    pathname: rawPathname,
    hostname,
    port,
    headers: Object.fromEntries(request.headers.entries()),
    query: Object.fromEntries(url.searchParams.entries()),
    cookies: (() => {
      const cookie = request.headers.get("cookie");
      if (cookie) {
        return Object.fromEntries(cookie.split("; ").map(c => {
          const [key, ...val] = c.split("=");
          return [key, val.join("=")];
        }));
      }
      return {};
    })(),
    timestamp: Date.now()
  };

  if (method !== "GET" && method !== "HEAD") {
    try {
      const cloned = request.clone();
      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        requestObj.body = await cloned.json();
        requestObj.bodyType = "json";
      } else if (contentType.includes("text/")) {
        requestObj.body = await cloned.text();
        requestObj.bodyType = "text";
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        const text = await cloned.text();
        requestObj.body = Object.fromEntries(new URLSearchParams(text));
        requestObj.bodyType = "form";
      } else {
        requestObj.body = null;
        requestObj.bodyType = "unknown";
      }
    } catch (e) {
      requestObj.body = null;
      requestObj.bodyType = "error";
    }
  }

  const msg = {
    type: "execute-request",
    requestId,
    method,
    path: rawPathname,
    port,
    request: requestObj
  };
  if (routeType === "param") {
    msg.route_type = "param";
    msg.params = matchedRoute;
    msg.param_data = paramData;
  } else if (routeType === "wildcard") {
    msg.route_type = "wildcard";
    msg.wildcard = matchedRoute;
    msg.wildcard_data = wildcardData;
  } else {
    msg.route_type = "route";
    msg.route = matchedRoute;
    msg.route_data = {};
  }
  client.postMessage(msg);

  const isNavigation = request.mode === "navigate";
  const timeoutMs = isNavigation ? 2000 : 10000;
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Page response timeout")), timeoutMs)
  );

  let result;
  try {
    result = await Promise.race([responsePromise, timeoutPromise]);
  } catch (error) {
    console.error("Route execution timed out:", error);
    if (isNavigation) {
      try { return await fetch(request); } catch { return new Response("Navigation fallback failed", { status: 500 }); }
    }
    return new Response("Route execution timed out", { status: 504 });
  }

  const responseHeaders = new Headers(result.headers || {});
  return new Response(result.body ?? "", {
    status: result.status ?? 200,
    headers: responseHeaders
  });
}
