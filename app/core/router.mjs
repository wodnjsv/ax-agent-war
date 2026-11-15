// 최소 HTTP 라우터. 경로 패턴은 '/api/plans/:plan_id' 형식.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createRouter() {
  const routes = [];

  const compile = (pattern) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    return { re, keys };
  };

  return {
    add(method, pattern, handler, owner = 'core') {
      routes.push({ method: method.toUpperCase(), ...compile(pattern), pattern, handler, owner });
    },
    list: () => routes.map(({ method, pattern, owner }) => ({ method, pattern, owner })),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(pathname);
        if (m) return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      }
      return null;
    },
  };
}

export async function readJsonBody(req, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '요청 본문이 너무 큽니다');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 본문이 아닙니다');
  }
}

export function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
