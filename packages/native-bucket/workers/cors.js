export function getCorsHeaders(req, env) {
  const origin = req.headers.get("Origin");
  const allowedDomains = (env.ALLOWED_DOMAINS || "").split(",");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
  if (origin && allowedDomains.some(d => origin.includes(d.trim()))) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}