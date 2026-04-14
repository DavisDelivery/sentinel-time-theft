// netlify/functions/motive-gps.mjs
// Motive API proxy for SENTINEL
// Routes all Motive API calls through Netlify to keep API key server-side
// Supports: vehicles, vehicle_history, driving_periods, ifta_trips, users, hos, safety_events

export default async (req, context) => {
  const KEY = Netlify.env.get("MOTIVE_API_KEY");
  if (!KEY) return new Response(JSON.stringify({error: true, message: "MOTIVE_API_KEY not set"}), {status: 500, headers: {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}});

  const cors = {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization"};

  if (req.method === "OPTIONS") return new Response("", {status: 200, headers: cors});

  try {
    const u = new URL(req.url);
    const action = u.searchParams.get("action") || "vehicles";

    let ep, version = "v1";

    // Map actions to correct Motive API endpoints
    switch (action) {
      case "vehicles":
        ep = "vehicle_locations";
        break;

      case "vehicle_history":
        // v2 endpoint: /v2/vehicle_locations/{vehicle_id}?start_date=&end_date=
        version = "v2";
        const vid = u.searchParams.get("vehicle_id");
        if (!vid) return new Response(JSON.stringify({error: true, message: "vehicle_id required"}), {status: 400, headers: cors});
        ep = `vehicle_locations/${vid}`;
        break;

      case "ifta_trips":
        // /v1/ifta/trips?vehicle_ids[]=ID&start_date=&end_date=
        ep = "ifta/trips";
        break;

      case "driving_periods":
        // /v1/driving_periods?vehicle_id=&start_date=&end_date=
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

      case "speeding":
        ep = "speeding_events";
        break;

      case "safety_events":
        ep = "safety_events";
        break;

      default:
        ep = action;
    }

    // Build URL with remaining params
    const p = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (k === "action") continue;
      p.append(k, v);
    }

    const full = `https://api.gomotive.com/${version}/${ep}` + (p.toString() ? "?" + p.toString() : "");

    console.log(`[SENTINEL] Motive → ${full}`);

    const resp = await fetch(full, {
      headers: {
        "X-Api-Key": KEY,
        "Content-Type": "application/json"
      }
    });

    const data = await resp.json();

    return new Response(JSON.stringify(data), {
      status: resp.status,
      headers: cors
    });

  } catch (err) {
    console.error("[SENTINEL] Motive error:", err);
    return new Response(JSON.stringify({error: true, message: err.message}), {
      status: 500,
      headers: cors
    });
  }
};
