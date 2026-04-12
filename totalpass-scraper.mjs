export default async (req, context) => {
  const B600 = Netlify.env.get("B600_URL") || "https://b600.atlantafreightquotes.com";
  const USER = Netlify.env.get("B600_USERNAME") || "admin";
  const PASS = Netlify.env.get("B600_PASSWORD") || "";
  const cors = {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"};

  try {
    const u = new URL(req.url);
    const action = u.searchParams.get("action") || "punch";
    const date = u.searchParams.get("date") || new Date().toISOString().split("T")[0];

    // Debug mode — return raw response for troubleshooting
    if (action === "debug") {
      const r = await fetch(B600 + "/", {redirect: "manual"});
      const headers = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      const body = await r.text();
      return new Response(JSON.stringify({
        status: r.status, headers, bodyLength: body.length,
        body: body.substring(0, 5000),
        b600Url: B600, user: USER, passSet: PASS.length > 0
      }), {headers: cors});
    }

    if (!PASS) {
      return new Response(JSON.stringify({
        success: false, error: "B600_PASSWORD not set in Netlify env vars",
        hint: "Go to Netlify > Site Settings > Environment Variables and add B600_PASSWORD"
      }), {headers: cors});
    }

    // Step 1: Login
    const loginPage = await fetch(B600 + "/", {redirect: "follow"});
    const loginHtml = await loginPage.text();
    const cookies = [];
    const setCookie = loginPage.headers.get("set-cookie");
    if (setCookie) cookies.push(setCookie.split(";")[0]);

    // Try multiple login form formats (TotalPass varies by firmware)
    const loginUrls = ["/login.html", "/cgi-bin/login", "/"];
    const loginBodies = [
      `username=${encodeURIComponent(USER)}&password=${encodeURIComponent(PASS)}&buttonClicked=4`,
      `username=${encodeURIComponent(USER)}&password=${encodeURIComponent(PASS)}&submit=Login`,
      `user=${encodeURIComponent(USER)}&pass=${encodeURIComponent(PASS)}`,
    ];

    let authCookies = cookies.join("; ");
    let authenticated = false;
    let authHtml = "";

    for (let i = 0; i < loginUrls.length && !authenticated; i++) {
      try {
        const loginResp = await fetch(B600 + loginUrls[i], {
          method: "POST", redirect: "manual",
          headers: {"Content-Type": "application/x-www-form-urlencoded", "Cookie": authCookies},
          body: loginBodies[i]
        });
        const newCookie = loginResp.headers.get("set-cookie");
        if (newCookie) authCookies = [authCookies, newCookie.split(";")[0]].filter(Boolean).join("; ");

        const loc = loginResp.headers.get("location");
        if (loc) {
          const followUrl = loc.startsWith("http") ? loc : B600 + loc;
          const followResp = await fetch(followUrl, {headers: {"Cookie": authCookies}, redirect: "follow"});
          authHtml = await followResp.text();
        } else if (loginResp.status === 200) {
          authHtml = await loginResp.text();
        }

        authenticated = authHtml.length > 0 && (
          authHtml.includes("Punch") || authHtml.includes("punch") ||
          authHtml.includes("Report") || authHtml.includes("report") ||
          authHtml.includes("Employee") || authHtml.includes("employee") ||
          authHtml.includes("Attendance") || authHtml.includes("Dashboard") ||
          (!authHtml.toLowerCase().includes("login") && !authHtml.toLowerCase().includes("password"))
        );
      } catch (e) { /* try next format */ }
    }

    if (!authenticated) {
      return new Response(JSON.stringify({
        success: false,
        error: "Login failed",
        hint: "Check B600_USERNAME and B600_PASSWORD. Use ?action=debug to inspect raw response.",
        htmlPreview: authHtml.substring(0, 1000)
      }), {headers: cors});
    }

    // Step 2: Find punch/attendance report
    const reportUrls = [
      `/cgi-bin/att_report?date=${date}`,
      `/cgi-bin/report?type=attendance&date=${date}`,
      `/report.html?date=${date}`,
      `/attendance?date=${date}`,
      `/cgi-bin/export?format=csv&date=${date}`,
    ];

    let reportHtml = authHtml;
    let foundReport = reportHtml.includes("<table") && (reportHtml.includes("In") || reportHtml.includes("Out"));

    if (!foundReport) {
      for (const url of reportUrls) {
        try {
          const resp = await fetch(B600 + url, {headers: {"Cookie": authCookies}, redirect: "follow"});
          if (resp.ok) {
            const html = await resp.text();
            if (html.includes("<table") || html.includes("<tr") || (html.includes(",") && html.includes("\n") && !html.includes("<html"))) {
              reportHtml = html;
              foundReport = true;
              break;
            }
          }
        } catch (e) { /* try next */ }
      }
    }

    // Step 3: Parse records
    const records = [];
    const logs = [`Auth: OK`, `Report: ${foundReport}`, `HTML: ${reportHtml.length} chars`];

    // Try CSV
    if (reportHtml.includes(",") && !reportHtml.includes("<html") && !reportHtml.includes("<table")) {
      const lines = reportHtml.split("\n").filter(l => l.trim());
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",").map(c => c.trim().replace(/"/g, ""));
        if (cols.length >= 3 && cols[0]) {
          records.push({ name: cols[0], emp_id: cols[1] || "", clock_in: extractTime(cols[2] || ""), clock_out: extractTime(cols[3] || ""), date });
        }
      }
    }

    // Try HTML tables
    if (records.length === 0 && reportHtml.includes("<t")) {
      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowMatch;
      const rows = [];
      while ((rowMatch = rowRegex.exec(reportHtml)) !== null) {
        const cells = [];
        const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
        let cellMatch;
        while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
          cells.push(cellMatch[1].replace(/<[^>]+>/g, "").trim());
        }
        if (cells.length >= 2) rows.push(cells);
      }
      logs.push(`Table rows: ${rows.length}`);
      if (rows.length > 1) {
        const header = rows[0].map(h => h.toLowerCase());
        let nameCol = header.findIndex(h => h.includes("name") || h.includes("employee"));
        let inCol = header.findIndex(h => h.includes("in") || h.includes("start"));
        let outCol = header.findIndex(h => h.includes("out") || h.includes("end"));
        if (nameCol === -1) nameCol = 0;
        if (inCol === -1) inCol = 1;
        if (outCol === -1) outCol = 2;
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i];
          if (r.length < 2 || !r[nameCol] || r[nameCol].toLowerCase().includes("total")) continue;
          records.push({ name: r[nameCol], emp_id: "", clock_in: extractTime(r[inCol] || ""), clock_out: extractTime(r[outCol] || ""), date });
        }
      }
    }

    const validRecords = records.filter(r => r.name && r.name.length > 1);
    logs.push(`Parsed: ${validRecords.length} records`);

    return new Response(JSON.stringify({
      success: validRecords.length > 0, records: validRecords, total: validRecords.length,
      date, authenticated: true, logs,
      hint: validRecords.length === 0 ? "Login OK but no records parsed. Use ?action=debug to inspect HTML." : null
    }), {headers: cors});

  } catch (e) {
    return new Response(JSON.stringify({
      success: false, error: e.message || "Unknown",
      hint: "Connection failed. Is the Cloudflare tunnel running? Is the B600 on?"
    }), {status: 502, headers: cors});
  }
};

function extractTime(str) {
  if (!str) return "";
  const m = str.match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?/);
  if (!m) return "";
  let h = parseInt(m[1]);
  if (m[3] && m[3].toUpperCase() === "PM" && h < 12) h += 12;
  if (m[3] && m[3].toUpperCase() === "AM" && h === 12) h = 0;
  return String(h).padStart(2, "0") + ":" + m[2];
}

export const config = {path: "/.netlify/functions/totalpass-scraper"};
