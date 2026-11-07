const express = require("express"), http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { Server } = require("socket.io");
const app = express(), srv = http.createServer(app), io = new Server(srv);
app.use(express.json({ limit: "6mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/admin", (q, r) => r.sendFile(path.join(__dirname, "public", "admin.html")));

const DB = path.join(__dirname, "data.json"), IMG = path.join(__dirname, "public/images");
const hash = s => crypto.createHash("sha256").update("ym:" + s).digest("hex"); // legacy hash, still accepted once
const hashPw = (p, salt = crypto.randomBytes(16).toString("hex")) => salt + ":" + crypto.scryptSync(p, salt, 32).toString("hex");
const checkPw = (p, st) => {
  if (!st.includes(":")) return hash(p) === st;
  const [salt, h] = st.split(":"), a = Buffer.from(h, "hex"), b = crypto.scryptSync(p, salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const initPw = () => { // no default password: use ADMIN_PASSWORD, or make a random one and print it once
  let p = process.env.ADMIN_PASSWORD;
  if (!p) { p = crypto.randomBytes(6).toString("hex"); console.log("\n*** First run. Admin password: " + p + "  (change it in Settings) ***\n"); }
  return hashPw(p);
};
// strips characters that could break the pages (admin-typed text is shown to customers)
const clean = (s, n = 80) => String(s == null ? "" : s).replace(/[<>"'`\\]/g, "").trim().slice(0, n);
const seed = require("./menu.json");
const SEED_AREAS = [["Zindabazar", 48, 25], ["Amberkhana", 54, 28], ["Upatyaka", 78, 35], ["Tilagarh", 66, 32], ["Upashahar", 72, 33], ["Shibganj", 84, 38], ["Kumarpara", 60, 30], ["Bagbari", 90, 40], ["Shahjalal Upashahar", 96, 42], ["Sylhet Sadar", 42, 25]];
const db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : { menu: JSON.parse(JSON.stringify(seed)), orders: [], pw: initPw() };
if (!db.areas) db.areas = SEED_AREAS.map((a, i) => ({ id: i + 1, name: a[0], fee: a[1], eta: a[2] }));
db.settings = Object.assign({ delivery: true, pickup: { on: true, open: "09:00", close: "22:00", address: "YM Cafe, Sylhet City", phone: "" } }, db.settings || {});
if (process.env.TRUST_PROXY) app.set("trust proxy", 1); // set TRUST_PROXY=1 when hosted behind a proxy (Render, Railway...)
for (const m of db.menu) { // upgrade data saved by older versions
  const d = seed.find(x => x.id === m.id);
  if (d) for (const k of Object.keys(d)) if (m[k] === undefined) m[k] = d[k];
  if (/^\/images\/[a-z-]+\.svg$/.test(m.img || "")) m.img = "";
  delete m.rating;
}
fs.mkdirSync(path.join(IMG, "uploads"), { recursive: true });
const save = () => fs.writeFileSync(DB, JSON.stringify(db, null, 2));
const tokens = new Map(); // token -> expiry time
const valid = t => { const e = tokens.get(t); if (e && e > Date.now()) return true; tokens.delete(t); return false; };
const auth = (q, r, n) => valid(q.headers["x-token"]) ? n() : r.status(401).json({ error: "auth" });
const dropImg = m => { if (m && (m.img || "").startsWith("/images/uploads/")) fs.unlink(path.join(IMG, m.img.slice(8)), () => {}); };
const num = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;

app.get("/api/menu", (q, r) => r.json(db.menu));
app.get("/api/areas", (q, r) => r.json(db.areas));

// ---- order alerts: Telegram / WhatsApp (each turns on when its env vars are set) ----
const E = process.env;
const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const channels = () => [E.TELEGRAM_BOT_TOKEN && E.TELEGRAM_CHAT_ID && "Telegram", E.CALLMEBOT_PHONE && E.CALLMEBOT_APIKEY && "WhatsApp (CallMeBot)", E.WA_TOKEN && E.WA_PHONE_ID && E.WA_TO && "WhatsApp (Meta Cloud API)"].filter(Boolean);
async function notify(o) {
  const items = o.items.map(i => `${i.q}x ${i.n}`).join(", ");
  const where = o.type === "pickup" ? `PICKUP at ${o.time}` : `DELIVERY ${o.a}: ${o.address.road} ${o.address.building}${o.address.notes ? " (" + o.address.notes + ")" : ""}`;
  const line = `New order ${o.id} | ${o.name} ${o.phone} | ${items} | ${where} | ${o.pay} | Total BDT ${o.t}`.replace(/\s+/g, " ");
  const multi = line.replace(/ \| /g, "\n"), jobs = [];
  if (E.TELEGRAM_BOT_TOKEN && E.TELEGRAM_CHAT_ID) jobs.push(post(`https://api.telegram.org/bot${E.TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: E.TELEGRAM_CHAT_ID, text: multi }));
  if (E.CALLMEBOT_PHONE && E.CALLMEBOT_APIKEY) jobs.push(fetch(`https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(E.CALLMEBOT_PHONE)}&apikey=${encodeURIComponent(E.CALLMEBOT_APIKEY)}&text=${encodeURIComponent(multi)}`));
  if (E.WA_TOKEN && E.WA_PHONE_ID && E.WA_TO) jobs.push(post(`https://graph.facebook.com/v20.0/${E.WA_PHONE_ID}/messages`, { messaging_product: "whatsapp", to: E.WA_TO, type: "template", template: { name: E.WA_TEMPLATE || "new_order", language: { code: E.WA_LANG || "en" }, components: [{ type: "body", parameters: [{ type: "text", text: line }] }] } }, { Authorization: "Bearer " + E.WA_TOKEN }));
  (await Promise.allSettled(jobs)).forEach(x => { if (x.status === "rejected") console.error("Notify failed:", x.reason && x.reason.message); else if (x.value && x.value.ok === false) console.error("Notify error, HTTP", x.value.status); });
}

// ---- orders: Sylhet City delivery or café pickup, all rules enforced here ----
const OUTSIDE = /dhaka|chattogram|chittagong|khulna|rajshahi|barisal|barishal|rangpur|mymensingh|comilla|cumilla|gazipur|narayanganj|cox|bogura|bogra|jessore|jashore|sunamganj|moulvibazar|habiganj|outside/i;
const OUT_MSG = "Sorry! YM Cafe currently delivers only within Sylhet City.";
const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/, mins = t => +t.slice(0, 2) * 60 + +t.slice(3);
const dhakaMin = () => mins(new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Dhaka", hour12: false, hour: "2-digit", minute: "2-digit" }));
app.get("/api/settings", (q, r) => r.json(db.settings));

app.post("/api/orders", (q, r) => {
  const b = q.body || {}, bad = (m, c = 400) => r.status(c).json({ error: m });
  if (!["COD", "bKash", "Nagad", "Rocket", "Card"].includes(b.pay)) return bad("Invalid payment method");
  const name = clean(b.name, 60), phone = String(b.phone || "").replace(/[\s-]/g, "");
  if (name.length < 2 || !/^(\+?880|0)?1[3-9]\d{8}$/.test(phone)) return bad("Please enter your name and a valid Bangladeshi mobile number");
  const lines = [];
  for (const it of Array.isArray(b.items) ? b.items : []) {
    const m = db.menu.find(x => x.id === it.id), n = Math.floor(it.q);
    if (!m || !m.on || !(n > 0 && n < 50)) return bad("An item is unavailable");
    lines.push({ n: m.n, q: n, p: m.p });
  }
  if (!lines.length) return bad("Your cart is empty");
  const sub = lines.reduce((s, l) => s + l.p * l.q, 0);
  const o = { id: "YM" + (1000 + db.orders.length + 1), code: crypto.randomBytes(4).toString("hex"), name, phone, pay: b.pay, items: lines, sub, st: 0, r: "", at: Date.now() };
  if (b.type === "pickup") {
    const p = db.settings.pickup, t = String(b.time || "");
    if (!p.on) return bad("Pickup is currently unavailable");
    if (!hhmm.test(t) || mins(t) < mins(p.open) || mins(t) > mins(p.close) || mins(t) < dhakaMin() + 15) return bad(`Choose a pickup time between ${p.open} and ${p.close}, at least 15 minutes from now`);
    Object.assign(o, { type: "pickup", a: "Pickup", time: t, fee: 0, eta: 15, t: sub });
  } else {
    if (!db.settings.delivery) return bad("Home delivery is currently unavailable. Please choose pickup");
    const ar = db.areas.find(x => x.name === b.area);
    if (!ar) return bad(OUT_MSG, 422);
    const ad = { road: clean(b.road, 120), building: clean(b.building, 80), notes: clean(b.notes, 200), city: clean(b.city || "Sylhet City", 40) };
    if (!/^sylhet( city)?$/i.test(ad.city) || OUTSIDE.test(Object.values(ad).join(" "))) return bad(OUT_MSG, 422);
    if (!ad.road) return bad("Please enter your road / house number");
    if (sub < 300) return bad("Minimum delivery order is BDT 300");
    Object.assign(o, { type: "delivery", a: ar.name, address: ad, fee: ar.fee, eta: ar.eta, t: sub + ar.fee });
  }
  db.orders.unshift(o); save();
  io.to("admin").emit("order:new", o); notify(o);
  r.json(o);
});

const fails = new Map(); // ip -> [count, resetAt]
app.post("/api/admin/login", (q, r) => {
  const ip = q.ip, f = fails.get(ip) || [0, 0], live = f[1] > Date.now();
  if (live && f[0] >= 5) return r.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  const pw = String((q.body || {}).password || ""), ok = checkPw(pw, db.pw);
  setTimeout(() => {
    if (!ok) { fails.set(ip, [live ? f[0] + 1 : 1, live ? f[1] : Date.now() + 9e5]); return r.status(401).json({ error: "Incorrect password" }); }
    fails.delete(ip);
    if (!db.pw.includes(":")) { db.pw = hashPw(pw); save(); } // upgrade an old password hash
    const t = crypto.randomBytes(24).toString("hex"); tokens.set(t, Date.now() + 12 * 36e5); r.json({ token: t });
  }, ok ? 0 : 600);
});
app.get("/api/admin/orders", auth, (q, r) => r.json(db.orders));
app.patch("/api/admin/orders/:id", auth, (q, r) => {
  const o = db.orders.find(x => x.id === q.params.id);
  if (!o) return r.status(404).json({ error: "Not found" });
  if (Number.isInteger(q.body.st) && q.body.st >= 0 && q.body.st <= 5) o.st = q.body.st;
  if (typeof q.body.r === "string") o.r = clean(q.body.r, 40);
  save(); io.to("admin").to(o.code || o.id).emit("order:update", o); r.json(o);
});

// ---- food items: add, edit, remove, photo ----
app.post("/api/admin/menu", auth, (q, r) => {
  const b = q.body || {}, n = clean(b.n, 60), c = clean(b.c, 40), p = Math.round(num(b.p));
  if (!n || !c || !(p > 0)) return r.status(400).json({ error: "Name, category and a price above 0 are required" });
  const m = {
    id: Math.max(0, ...db.menu.map(x => x.id)) + 1, n, c, p, sp: [0, 1, 2, 3].includes(+b.sp) ? +b.sp : 0, pop: 0,
    chef: b.chef ? 1 : 0, veg: b.veg ? 1 : 0, on: true, d: clean(b.d, 240),
    ing: String(b.ing || "").split(",").map(x => clean(x, 30)).filter(Boolean).slice(0, 15),
    cal: Math.max(0, Math.round(num(b.cal))), time: Math.max(1, Math.round(num(b.time, 10))), img: ""
  };
  db.menu.push(m); save(); io.emit("menu", db.menu); r.json(m);
});
app.put("/api/admin/menu/:id", auth, (q, r) => {
  const m = db.menu.find(x => x.id === +q.params.id), b = q.body || {};
  if (!m) return r.status(404).json({ error: "Not found" });
  if (typeof b.on === "boolean") m.on = b.on;
  if (num(b.p) > 0) m.p = Math.round(num(b.p));
  if (typeof b.n === "string" && clean(b.n, 60)) m.n = clean(b.n, 60);
  if (typeof b.d === "string") m.d = clean(b.d, 240);
  save(); io.emit("menu", db.menu); r.json(m);
});
app.delete("/api/admin/menu/:id", auth, (q, r) => {
  const i = db.menu.findIndex(x => x.id === +q.params.id);
  if (i < 0) return r.status(404).json({ error: "Not found" });
  dropImg(db.menu[i]); db.menu.splice(i, 1); save(); io.emit("menu", db.menu); r.json({ ok: true });
});
app.post("/api/admin/menu/:id/image", auth, (q, r) => {
  const m = db.menu.find(x => x.id === +q.params.id), mt = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String((q.body || {}).data || ""));
  if (!m || !mt) return r.status(400).json({ error: "Upload a PNG, JPG or WebP image" });
  const f = `uploads/${m.id}-${Date.now()}.${mt[1] === "jpeg" ? "jpg" : mt[1]}`;
  fs.writeFileSync(path.join(IMG, f), Buffer.from(mt[2], "base64"));
  dropImg(m); m.img = "/images/" + f; save(); io.emit("menu", db.menu); r.json(m);
});

// ---- delivery areas and charges: add, edit, remove ----
app.post("/api/admin/areas", auth, (q, r) => {
  const b = q.body || {}, name = clean(b.name, 40);
  if (OUTSIDE.test(name)) return r.status(400).json({ error: "Areas must be inside Sylhet City" });
  if (!name || db.areas.some(a => a.name.toLowerCase() === name.toLowerCase())) return r.status(400).json({ error: "Enter a new area name" });
  if (num(b.fee, -1) < 0 || !(num(b.eta) > 0)) return r.status(400).json({ error: "Enter a fee (0 or more) and minutes" });
  db.areas.push({ id: Math.max(0, ...db.areas.map(a => a.id)) + 1, name, fee: Math.round(num(b.fee)), eta: Math.round(num(b.eta)) });
  save(); io.emit("areas", db.areas); r.json(db.areas);
});
app.put("/api/admin/areas/:id", auth, (q, r) => {
  const a = db.areas.find(x => x.id === +q.params.id), b = q.body || {};
  if (!a) return r.status(404).json({ error: "Not found" });
  if (num(b.fee, -1) >= 0 && b.fee !== undefined) a.fee = Math.round(num(b.fee));
  if (num(b.eta) > 0) a.eta = Math.round(num(b.eta));
  save(); io.emit("areas", db.areas); r.json(a);
});
app.delete("/api/admin/areas/:id", auth, (q, r) => {
  const i = db.areas.findIndex(x => x.id === +q.params.id);
  if (i < 0) return r.status(404).json({ error: "Not found" });
  db.areas.splice(i, 1); save(); io.emit("areas", db.areas); r.json({ ok: true });
});

app.put("/api/admin/settings", auth, (q, r) => {
  const b = q.body || {}, p = b.pickup || {};
  if (!hhmm.test(p.open) || !hhmm.test(p.close) || mins(p.open) >= mins(p.close)) return r.status(400).json({ error: "Enter valid pickup hours" });
  db.settings = { delivery: !!b.delivery, pickup: { on: !!p.on, open: p.open, close: p.close, address: clean(p.address, 160), phone: clean(p.phone, 30) } };
  save(); io.emit("settings", db.settings); r.json(db.settings);
});

app.post("/api/admin/password", auth, (q, r) => {
  const p = String((q.body || {}).password || "");
  if (p.length < 6) return r.status(400).json({ error: "Too short" });
  db.pw = hashPw(p); save(); r.json({ ok: true });
});

io.on("connection", s => {
  if (valid((s.handshake.auth || {}).token)) s.join("admin");
  s.on("track", id => typeof id === "string" && s.join(id));
});
srv.listen(process.env.PORT || 3000, () => {
  console.log("YM Cafe running on http://localhost:" + (process.env.PORT || 3000));
  console.log("Order alerts: " + (channels().join(", ") || "none set up"));
});
