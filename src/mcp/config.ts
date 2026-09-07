export function loadConfigFromEnv(): { domain: string; token: string } {
  const domain = process.env.CANVAS_DOMAIN;
  const token = process.env.CANVAS_API_TOKEN;
  if (!domain || !token) {
    throw new Error("CANVAS_DOMAIN and CANVAS_API_TOKEN must be set (see .env.example).");
  }
  return { domain, token };
}
