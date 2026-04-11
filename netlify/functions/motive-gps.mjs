export default async (req, context) => {
  const KEY = Netlify.env.get("MOTIVE_API_KEY");
  if (!KEY) return new Response(JSON.stringify({error: true, message: "MOTIVE_API_KEY not set"}), {status: 500, headers: {"Content-Type": "application/json"}});
  try {
    const u = new URL(req.url);
    const action = u.searchParams.get("action") || "vehicles";
    let ep = "https://api.gomotive.com/v1/";
    if (action === "vehicles") ep += "vehicle_locations";
    else if (action === "drivers" || action === "users") ep += "users";
    else if (action === "logs" || action === "driver_logs") ep += "driver_logs";
    else if (action === "hos") ep += "hours_of_service";
    else ep += action;
    const p = new URLSearchParams();
    for (const [k, v] of u.searchParams) { if (k !== "action") p.set(k, v); }
    const full = ep + (p.toString() ? "?" + p.toString() : "");
    const r = await fetch(full, {headers: {"X-Api-Key": KEY, "Accept": "application/json"}});
    const d = await r.text();
    return new Response(d, {status: r.status, headers: {"Content-Type": "application/json"}});
  } catch (e) {
    return new Response(JSON.stringify({error: true, message: e.message || "Unknown"}), {status: 502, headers: {"Content-Type": "application/json"}});
  }
};
export const config = {path: "/.netlify/functions/motive-gps"};
