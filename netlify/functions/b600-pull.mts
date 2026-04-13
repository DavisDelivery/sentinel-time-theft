/**
 * SENTINEL B600 Time Clock Auto-Pull
 * Netlify Scheduled Function — runs 2am daily
 * 
 * Hits B600 via Cloudflare Tunnel, parses timecards, pushes to Firebase.
 * 
 * Env vars needed in Netlify:
 *   B600_HOST     = b600.atlantafreightquotes.com  (Cloudflare Tunnel)
 *   B600_PASSWORD = admin12345
 *   FIREBASE_URL  = https://glorybounddispatch-default-rtdb.firebaseio.com
 * 
 * Also callable manually:  GET /.netlify/functions/b600-pull
 *                          GET /.netlify/functions/b600-pull?days=7
 *                          GET /.netlify/functions/b600-pull?from=04/01/26&to=04/07/26
 */

import type { Config } from "@netlify/functions";

const B600_HOST = process.env.B600_HOST || "b600.atlantafreightquotes.com";
const B600_USER = "admin";
const B600_PASS = process.env.B600_PASSWORD || "admin12345";
const FIREBASE_URL = process.env.FIREBASE_URL || "https://glorybounddispatch-default-rtdb.firebaseio.com";

// ── Helpers ─────────────────────────────────────────────────────────

function fmtDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
}

function dateKey(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseTime12(raw: string): string | null {
  const match = raw.match(/^(\d{1,2}):(\d{2})([ap])$/i);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const m = match[2];
  const ap = match[3].toLowerCase();
  if (ap === "p" && h !== 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${m}`;
}

// ── Step 1: Login ───────────────────────────────────────────────────

async function login(): Promise<string> {
  const url = `https://${B600_HOST}/login.html`;
  const body = `username=${encodeURIComponent(B600_USER)}&password=${encodeURIComponent(B600_PASS)}`;

  // Don't follow redirect — we need the cookie from the 301
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });

  console.log(`Login: ${res.status}`);

  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("No set-cookie from login");

  // Extract just the cookie key=value
  const cookie = setCookie.split(";")[0];
  console.log(`Cookie: ${cookie.substring(0, 30)}...`);
  return cookie;
}

// ── Step 2: Fetch report ────────────────────────────────────────────

async function fetchReport(cookie: string, from: Date, to: Date): Promise<string> {
  const fromStr = fmtDate(from);
  const toStr = fmtDate(to);
  const url = `https://${B600_HOST}/report.html?rt=2&type=7&customfld_fieldId=0&from=${encodeURIComponent(fromStr)}&to=${encodeURIComponent(toStr)}&eid=0&submitMenu=Submit`;

  console.log(`Report: ${fromStr} → ${toStr}`);

  const res = await fetch(url, {
    headers: { Cookie: cookie },
    redirect: "follow",
  });

  if (!res.ok) throw new Error(`Report fetch failed: ${res.status}`);
  return await res.text();
}

// ── Step 3: Parse ───────────────────────────────────────────────────

interface Punch {
  date: string;
  clock_in: string | null;
  clock_out: string | null;
}

interface Employee {
  name: string;
  punches: Punch[];
}

function parseTimecards(html: string): Employee[] {
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");

  const employees: Employee[] = [];
  const sections = text.split(/(?=From:\s*\d{2}\/\d{2}\/\d{2}\s+Thru:)/i);

  for (const section of sections) {
    const headerMatch = section.match(
      /From:\s*(\d{2}\/\d{2}\/\d{2})\s+Thru:\s*(\d{2}\/\d{2}\/\d{2})\s+([A-Z][A-Z\s,'.()-]+?)(?=\s+DATE\s+TIME\s+IN|$)/i
    );
    if (!headerMatch) continue;

    const employeeName = headerMatch[3].trim();
    const punchRegex = /(\d{2}\/\d{2}\/\d{2})\s+[A-Za-z]{3}(\d{1,2}:\d{2}[ap])\s+Dept\s+\d+\s+(?:([A-Za-z]{3})(\d{1,2}:\d{2}[ap]))?/gi;
    const punches: Punch[] = [];
    let m;

    while ((m = punchRegex.exec(section)) !== null) {
      punches.push({
        date: m[1],
        clock_in: parseTime12(m[2]),
        clock_out: m[4] ? parseTime12(m[4]) : null,
      });
    }

    if (punches.length > 0) {
      employees.push({ name: employeeName, punches });
    }
  }

  return employees;
}

// ── Step 4: Group by date & push to Firebase ────────────────────────

interface DayEmployees {
  [date: string]: { name: string; punches: { clock_in: string | null; clock_out: string | null }[] }[];
}

function groupByDate(employees: Employee[]): DayEmployees {
  const byDate: { [date: string]: { [name: string]: { clock_in: string | null; clock_out: string | null }[] } } = {};

  for (const emp of employees) {
    for (const p of emp.punches) {
      const [mm, dd, yy] = p.date.split("/");
      const key = `20${yy}-${mm}-${dd}`;
      if (!byDate[key]) byDate[key] = {};
      if (!byDate[key][emp.name]) byDate[key][emp.name] = [];
      byDate[key][emp.name].push({ clock_in: p.clock_in, clock_out: p.clock_out });
    }
  }

  const result: DayEmployees = {};
  for (const [day, empMap] of Object.entries(byDate)) {
    result[day] = Object.entries(empMap).map(([name, punches]) => ({ name, punches }));
  }
  return result;
}

async function pushToFirebase(dateKeyStr: string, employees: any[]): Promise<void> {
  const payload = JSON.stringify({
    pulled_at: new Date().toISOString(),
    employee_count: employees.length,
    employees,
  });

  const res = await fetch(`${FIREBASE_URL}/sentinel_b600/${dateKeyStr}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });

  if (!res.ok) throw new Error(`Firebase PUT failed: ${res.status}`);
  console.log(`Firebase: ${dateKeyStr} → ${employees.length} employees`);
}

// ── Handler ─────────────────────────────────────────────────────────

export default async (req: Request) => {
  const url = new URL(req.url);
  const params = url.searchParams;

  // Determine date range
  let from: Date, to: Date;

  if (params.has("from") && params.has("to")) {
    const parse = (s: string) => {
      const [mm, dd, yy] = s.split("/");
      return new Date(2000 + parseInt(yy), parseInt(mm) - 1, parseInt(dd));
    };
    from = parse(params.get("from")!);
    to = parse(params.get("to")!);
  } else if (params.has("days")) {
    const n = parseInt(params.get("days")!, 10) || 7;
    to = new Date(); to.setDate(to.getDate() - 1);
    from = new Date(to); from.setDate(from.getDate() - (n - 1));
  } else {
    // Default: yesterday (cron mode)
    to = new Date(); to.setDate(to.getDate() - 1);
    from = new Date(to);
  }

  console.log(`\n=== SENTINEL B600 Pull: ${dateKey(from)} → ${dateKey(to)} ===`);

  try {
    const cookie = await login();
    const html = await fetchReport(cookie, from, to);
    console.log(`Report: ${html.length} chars`);

    const employees = parseTimecards(html);
    console.log(`Parsed: ${employees.length} employees`);

    const byDate = groupByDate(employees);
    const days = Object.keys(byDate).sort();

    for (const day of days) {
      await pushToFirebase(day, byDate[day]);
    }

    if (days.length === 0) {
      await pushToFirebase(dateKey(from), []);
    }

    const summary = `Pulled ${days.length} day(s), ${employees.length} employees`;
    console.log(summary);

    return new Response(JSON.stringify({
      ok: true,
      range: `${dateKey(from)} → ${dateKey(to)}`,
      days: days.length,
      employees: employees.length,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("FATAL:", err.message);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

// ── Schedule: 2am ET daily ──────────────────────────────────────────
export const config: Config = {
  schedule: "0 6 * * *", // 6am UTC = 2am ET
};
