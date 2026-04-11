export default async (req, context) => {
  const B600 = Netlify.env.get("B600_URL") || "https://b600.atlantafreightquotes.com";
  const USER = Netlify.env.get("B600_USERNAME") || "admin";
  const PASS = Netlify.env.get("B600_PASSWORD") || "";
  try {
    const u = new URL(req.url);
    const action = u.searchParams.get("action") || "login";
    if (action === "debug") {
      const r = await fetch(B600 + "/", {redirect: "manual"});
      const headers = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      return new Response(JSON.stringify({status: r.status, headers, body: (await r.text()).substring(0, 2000)}), {headers: {"Content-Type": "application/json"}});
    }
    const loginPage = await fetch(B600 + "/", {redirect: "follow"});
    const loginHtml = await loginPage.text();
    const cookies = loginPage.headers.get("set-cookie") || "";
    const formBody = "username=" + encodeURIComponent(USER) + "&password=" + encodeURIComponent(PASS) + "&buttonClicked=4";
    const loginResp = await fetch(B600 + "/login.html", {
      method: "POST", redirect: "manual",
      headers: {"Content-Type": "application/x-www-form-urlencoded", "Cookie": cookies},
      body: formBody
    });
    const allCookies = [cookies, loginResp.headers.get("set-cookie") || ""].filter(Boolean).join("; ");
    const location = loginResp.headers.get("location") || "/";
    const authResp = await fetch(B600 + location, {headers: {"Cookie": allCookies}, redirect: "follow"});
    const authHtml = await authResp.text();
    return new Response(JSON.stringify({
      status: authResp.status, loginStatus: loginResp.status,
      html: authHtml.substring(0, 5000), cookies: allCookies,
      authenticated: !authHtml.includes("login") || authHtml.includes("Punch")
    }), {status: 200, headers: {"Content-Type": "application/json"}});
  } catch (e) {
    return new Response(JSON.stringify({error: true, message: e.message || "Unknown"}), {status: 502, headers: {"Content-Type": "application/json"}});
  }
};
export const config = {path: "/.netlify/functions/totalpass-scraper"};
