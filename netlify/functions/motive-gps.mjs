export default async (req, context) => {
  const KEY = Netlify.env.get("MOTIVE_API_KEY");
  if (!KEY) return new Response(JSON.stringify({error: true, message: "MOTIVE_API_KEY not set"}), {status: 500, headers: {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}});

  const cors = {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"};

  try {
    const u = new URL(req.url);
    const action = u.searchParams.get("action") || "vehicles";

    let ep, version = "v1";

    switch (action) {
      case "vehicles":
        ep = "vehicle_locations";
        break;
      case "vehicle_history": {
        version = "v2";
        const vid = u.searchParams.get("vehicle_id");
        if (!vid) return new Response(JSON.stringify({error: true, message: "vehicle_id required for vehicle_history"}), {status: 400, headers: cors});
        ep = `vehicle_locations/${vid}`;
        break;
      }
      case "ifta_trips":
        ep = "ifta/trips";
        break;
      case "driving_periods":
        ep = "driving_periods";
        break;
      case "hos":
      case "hours_of_service":
        ep = "hours_of_service";
        break;
      case "driver_logs":
      case "logs":
        ep = "driver_logs";
        break;
      case "users":
      case "drivers":
        ep = "users";
        break;
      case "performance":
        ep = "driver_performance_events";
        break;
      default:
        ep = action;
    }

    const p = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (k === "action") continue;
      p.append(k, v);
    }

    const full = `https://api.gomotive.com/${version}/${ep}` + (p.toString() ? "?" + p.toString() : "");
    const r = await fetch(full, { headers: { "X-Api-Key": KEY, "Accept": "application/json" } });
    const d = await r.text();
    return new Response(d, { status: r.status, headers: cors });

  } catch (e) {
    return new Response(JSON.stringify({error: true, message: e.message || "Unknown"}), {status: 502, headers: cors});
  }
};
export const config = { path: "/.netlify/functions/motive-gps" };
