// netlify/functions/sentinel-ai.js
// Sends driver data to Claude API for time theft analysis
// Returns natural language insights about suspicious patterns

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const FETCH_TIMEOUT_MS = 20000;

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });

  const API_KEY = Netlify.env.get('ANTHROPIC_API_KEY');
  if (!API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500, headers: CORS });
  }

  try {
    const body = await req.json();
    const { driverName, driverType, driverCo, kpis, clockToFirst, dailyRows, topCustomers, topCities, fleetBench, typeBench } = body;

    const systemPrompt = `You are SENTINEL, an AI time theft detection system for Davis Delivery Service, a fleet carrier based in Buford, GA. You analyze driver behavior data to identify potential time theft, unauthorized stops, route deviations, and productivity issues.

Your analysis should be direct, specific, and actionable. Flag concrete suspicious patterns with dates and times. Use the fleet and type-specific benchmarks to contextualize — a tractor driver's "normal" is different from a box truck driver's.

Key things to look for:
1. CLOCK-IN TO FIRST DELIVERY GAP: Drivers clocking in but not making deliveries for hours. The fleet median is about 2.5 hours (includes warehouse loading). Anything over 3 hours is suspicious, over 4 hours is critical.
2. INTER-DELIVERY GAPS: Long unexplained gaps between stops. Fleet P90 is ~42 min. Gaps over 60 min at non-delivery locations suggest personal stops.
3. PATTERN DETECTION: Same suspicious behavior on the same day of week, same time, same location = habitual time theft.
4. EARLY QUIT / LATE START: Consistently starting deliveries late or finishing early relative to clocked hours.
5. LOW PRODUCTIVITY: Few stops relative to hours worked compared to peers of the same vehicle type.
6. MILEAGE/ROUTE DEVIATION: If mileage data suggests they're going off-route.

Format your response in clear sections. Be blunt about what you see. Give a risk rating (LOW / MEDIUM / HIGH / CRITICAL) and estimate stolen hours/dollars where possible. Use $23/hr for box truck drivers, $27.50/hr for tractor drivers.`;

    const userPrompt = `Analyze this driver's data for time theft and suspicious patterns:

DRIVER: ${driverName}
TYPE: ${driverType} (${driverCo})
PERIOD: ${dailyRows?.length || 0} days of data

KPIs:
- Avg stops/day: ${kpis?.avgStopsDay || '?'}
- Avg shift: ${kpis?.avgShift || '?'}h
- Avg first delivery: ${kpis?.avgFirstDel || '?'}
- Avg gap between stops: ${kpis?.avgGap || '?'}m
- Median gap: ${kpis?.medGap || '?'}m
- P90 gap: ${kpis?.p90Gap || '?'}m
- Avg clock-in: ${kpis?.avgClockIn || '?'}
- Total stops: ${kpis?.totalStops || '?'}

FLEET BENCHMARKS:
- Gap: median ${fleetBench?.gap?.median}m, P75 ${fleetBench?.gap?.p75}m, P90 ${fleetBench?.gap?.p90}m
- First delivery: median ${fleetBench?.firstDel?.median}h
- Stops/day: median ${fleetBench?.stopsDay?.median}

TYPE BENCHMARKS (${driverType}):
- Gap: median ${typeBench?.gap?.median}m, P90 ${typeBench?.gap?.p90}m
- First delivery: median ${typeBench?.firstDel?.median}h
- Stops/day: median ${typeBench?.stopsDay?.median}

CLOCK-IN → FIRST DELIVERY (every instance, sorted worst first):
${(clockToFirst || []).slice(0, 30).map(r => `  ${r.date}: Clock-in ${r.clockIn} → First delivery ${r.firstDel} = ${r.gapMin}min gap (${r.stops} stops that day)`).join('\n') || 'No data'}

DAILY BREAKDOWN (recent ${Math.min(dailyRows?.length || 0, 30)} days):
${(dailyRows || []).slice(0, 30).map(r => `  ${r.date}: Clock ${r.clockIn}-${r.clockOut} (${r.totalHrs}h) | 1st del ${r.first} | last ${r.last} | ${r.stops} stops | avg gap ${r.avgGap?.toFixed(0)}m | max gap ${r.maxGap}m | cities: ${r.cities?.join(', ')}`).join('\n') || 'No data'}

TOP DELIVERY LOCATIONS:
${(topCustomers || []).slice(0, 8).map(([name, count]) => `  ${name}: ${count} deliveries`).join('\n') || 'No data'}

CITIES SERVED:
${(topCities || []).slice(0, 6).map(([city, count]) => `  ${city}: ${count} stops`).join('\n') || 'No data'}

Provide your SENTINEL analysis. Be specific with dates and patterns.`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }]
        }),
        signal: controller.signal
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        return new Response(JSON.stringify({ error: 'Claude API upstream timeout' }), { status: 504, headers: CORS });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const errText = await res.text();
      return new Response(JSON.stringify({ error: `Claude API ${res.status}`, detail: errText.substring(0, 300) }), { status: 502, headers: CORS });
    }

    const data = await res.json();
    const analysis = data.content?.[0]?.text || 'No analysis returned';

    return new Response(JSON.stringify({ success: true, analysis, model: data.model, usage: data.usage }), { status: 200, headers: CORS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
};

export const config = { path: '/api/sentinel-ai' };
