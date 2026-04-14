import type { Context, Config } from "@netlify/functions";

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const endpoint = url.searchParams.get("endpoint");
  
  if (!endpoint) {
    return new Response(JSON.stringify({ error: "Missing endpoint parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const apiKey = Netlify.env.get("MOTIVE_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "MOTIVE_API_KEY not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    // Build the Motive API URL
    const motiveUrl = `https://api.gomotive.com/${endpoint}`;
    
    // Forward query params (except endpoint)
    const params = new URLSearchParams();
    url.searchParams.forEach((value, key) => {
      if (key !== "endpoint") params.set(key, value);
    });
    
    const finalUrl = params.toString() ? `${motiveUrl}?${params}` : motiveUrl;
    
    const response = await fetch(finalUrl, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    });

    const data = await response.json();
    
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Motive API request failed", details: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};

export const config: Config = {
  path: "/.netlify/functions/motive-gps"
};
