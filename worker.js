// Tabungan Berdua — satu Worker Cloudflare (halaman + API) dengan database D1.
// Setting yang dibutuhkan:
//   Binding D1      : DB
//   Secret          : PASSCODE        (kata sandi bersama untuk login)
//   Secret          : SESSION_SECRET  (string acak panjang untuk menandatangani sesi)
//   Variable (opsi) : USERS="Aku,Dia" (dua nama pengguna, pisahkan koma)
//   Variable (opsi) : TIMEZONE="Asia/Jakarta"
//   Variable (opsi) : DEFAULT_AMOUNT="50" (nominal awal; selanjutnya diubah dari dalam website)

const FALLBACK_AMOUNT = 50;
const MAX_AMOUNT = 100000000;
const SESSION_DAYS = 30;
const enc = new TextEncoder();
const dec = new TextDecoder();

let dbReady = false;

// ---------- util ----------
function toB64u(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64u(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return toB64u(new Uint8Array(sig));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}
function getUsers(env) {
  const list = String(env.USERS || "Aku,Dia")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2);
  return list.length ? list : ["Aku", "Dia"];
}
function validAmount(n) {
  return Number.isInteger(n) && n >= 1 && n <= MAX_AMOUNT;
}
function todayStr(env) {
  const tz = env.TIMEZONE || "Asia/Jakarta";
  // en-CA menghasilkan format YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
function validDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d &&
    y >= 2020
  );
}
function validMonth(s) {
  return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

// ---------- sesi ----------
async function makeToken(env, user) {
  const payload = toB64u(
    enc.encode(JSON.stringify({ u: user, exp: Date.now() + SESSION_DAYS * 86400000 }))
  );
  const sig = await hmac(env.SESSION_SECRET, payload);
  return payload + "." + sig;
}
async function readUser(request, env) {
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)tb=([^;]+)/);
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length !== 2) return null;
  const expected = await hmac(env.SESSION_SECRET, parts[0]);
  if (!safeEqual(expected, parts[1])) return null;
  try {
    const data = JSON.parse(dec.decode(fromB64u(parts[0])));
    if (!data || typeof data.u !== "string" || data.exp < Date.now()) return null;
    return getUsers(env).includes(data.u) ? data.u : null;
  } catch (e) {
    return null;
  }
}
function cookieHeader(value, maxAge) {
  return "tb=" + value + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=" + maxAge;
}

// ---------- database ----------
async function initDb(env) {
  if (dbReady) return;
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS saves (date TEXT PRIMARY KEY, by TEXT NOT NULL, at INTEGER NOT NULL, amount INTEGER NOT NULL DEFAULT 50)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    ),
  ]);
  // migrasi untuk database versi lama yang belum punya kolom amount
  const info = await env.DB.prepare("PRAGMA table_info(saves)").all();
  const cols = (info.results || []).map((c) => c.name);
  if (!cols.includes("amount")) {
    await env.DB.prepare(
      "ALTER TABLE saves ADD COLUMN amount INTEGER NOT NULL DEFAULT 50"
    ).run();
  }
  dbReady = true;
}
async function getAmount(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'amount'").first();
  const saved = row ? Number(row.value) : NaN;
  if (validAmount(saved)) return saved;
  const def = Number(env.DEFAULT_AMOUNT);
  return validAmount(def) ? def : FALLBACK_AMOUNT;
}

// ---------- handler ----------
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (request.method === "GET" && path === "/") {
        return new Response(HTML, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }

      if (!path.startsWith("/api/")) return new Response("Not found", { status: 404 });

      if (request.method === "GET" && path === "/api/users") {
        return json({ users: getUsers(env) });
      }

      if (!env.DB) return json({ error: "Database D1 (binding DB) belum dipasang." }, 500);
      if (!env.PASSCODE || !env.SESSION_SECRET)
        return json({ error: "Secret PASSCODE / SESSION_SECRET belum diatur." }, 500);

      await initDb(env);

      // POST wajib JSON (proteksi CSRF tambahan)
      let body = {};
      if (request.method === "POST") {
        const ct = request.headers.get("content-type") || "";
        if (!ct.includes("application/json")) return json({ error: "Bad request" }, 400);
        try {
          body = await request.json();
        } catch (e) {
          return json({ error: "JSON tidak valid" }, 400);
        }
        if (!body || typeof body !== "object") body = {};
      }

      // --- login / logout ---
      if (request.method === "POST" && path === "/api/login") {
        const users = getUsers(env);
        const user = String(body.user || "");
        const pass = String(body.pass || "");
        const a = await hmac(env.SESSION_SECRET, "pw:" + pass);
        const b = await hmac(env.SESSION_SECRET, "pw:" + env.PASSCODE);
        if (!users.includes(user) || !safeEqual(a, b)) {
          return json({ error: "Nama atau kata sandi salah" }, 401);
        }
        const token = await makeToken(env, user);
        return json({ ok: true }, 200, {
          "set-cookie": cookieHeader(token, SESSION_DAYS * 86400),
        });
      }
      if (request.method === "POST" && path === "/api/logout") {
        return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });
      }

      // --- butuh login ---
      const me = await readUser(request, env);
      if (!me) return json({ error: "Belum login" }, 401);

      if (request.method === "GET" && path === "/api/state") {
        const today = todayStr(env);
        let month = url.searchParams.get("month");
        if (!validMonth(month)) month = today.slice(0, 7);
        const rows = await env.DB.prepare(
          "SELECT date, by, amount FROM saves WHERE date LIKE ?"
        )
          .bind(month + "-%")
          .all();
        const days = {};
        for (const r of rows.results || []) days[r.date] = { by: r.by, amount: r.amount };
        const t = await env.DB.prepare(
          "SELECT COALESCE(SUM(amount), 0) AS s FROM saves"
        ).first();
        return json({
          me,
          users: getUsers(env),
          today,
          month,
          amount: await getAmount(env),
          days,
          total: t ? t.s : 0,
        });
      }

      if (request.method === "POST" && path === "/api/amount") {
        const n = body.amount;
        if (!validAmount(n))
          return json({ error: "Nominal harus bilangan bulat 1 – 100.000.000" }, 400);
        await env.DB.prepare(
          "INSERT INTO settings (key, value) VALUES ('amount', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
          .bind(String(n))
          .run();
        return json({ ok: true, amount: n });
      }

      if (request.method === "POST" && path === "/api/toggle") {
        const date = body.date;
        const on = body.on === true;
        if (!validDate(date)) return json({ error: "Tanggal tidak valid" }, 400);
        if (date > todayStr(env))
          return json({ error: "Tanggal belum tiba, belum bisa dicentang" }, 400);
        if (on) {
          const amount = await getAmount(env);
          await env.DB.prepare(
            "INSERT OR IGNORE INTO saves (date, by, at, amount) VALUES (?, ?, ?, ?)"
          )
            .bind(date, me, Date.now(), amount)
            .run();
        } else {
          await env.DB.prepare("DELETE FROM saves WHERE date = ?").bind(date).run();
        }
        const row = await env.DB.prepare("SELECT by, amount FROM saves WHERE date = ?")
          .bind(date)
          .first();
        return json({
          ok: true,
          date,
          by: row ? row.by : null,
          amount: row ? row.amount : 0,
        });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: "Terjadi kesalahan server" }, 500);
    }
  },
};

// ---------- halaman ----------
const HTML = String.raw`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f172a">
<title>Tabungan Berdua</title>
<style>
:root{--bg:#0f172a;--card:#1e293b;--line:#334155;--muted:#94a3b8;--text:#f1f5f9;--u0:#22c55e;--u1:#38bdf8;--warn:#fbbf24}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;min-height:100vh}
.wrap{max-width:480px;margin:0 auto;padding:16px 14px calc(24px + env(safe-area-inset-bottom))}
h1{font-size:20px;margin:6px 0 2px}
.sub{color:var(--muted);font-size:13px;margin:0 0 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px}
.hidden{display:none!important}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 6px}
input[type=password],input[type=number]{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font-size:16px}
.chips{display:flex;gap:8px}
.chip{flex:1;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font-size:15px;cursor:pointer}
.chip.sel{border-color:var(--u0);background:rgba(34,197,94,.15)}
.btn{width:100%;margin-top:16px;padding:13px;border:0;border-radius:10px;background:var(--u0);color:#04210e;font-weight:700;font-size:16px;cursor:pointer}
.btn:disabled{opacity:.6}
.err{color:#f87171;font-size:13px;margin-top:10px;min-height:18px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px}
.who{font-size:13px;color:var(--muted)}
.link{background:none;border:0;color:var(--muted);text-decoration:underline;font-size:13px;cursor:pointer;padding:4px}
.nav{display:flex;align-items:center;justify-content:space-between;margin:12px 0}
.nav h2{margin:0;font-size:18px}
.nb{width:42px;height:42px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--text);font-size:20px;cursor:pointer}
.nb:disabled{opacity:.3;cursor:default}
.stats{display:flex;gap:10px;margin-bottom:12px}
.stat{flex:1;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px 12px;min-width:0}
.stat b{display:block;font-size:17px;margin-top:2px;overflow-wrap:anywhere}
.stat span{font-size:12px;color:var(--muted)}
.amt{margin-bottom:14px;padding:12px 14px}
.amt label{margin:0 0 6px}
.amt .row{display:flex;gap:8px}
.amt .row input{flex:1;min-width:0}
.amt .save{width:auto;margin:0;padding:0 18px;font-size:15px}
.presets{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.preset{padding:6px 10px;border-radius:999px;border:1px solid var(--line);background:var(--bg);color:var(--muted);font-size:12px;cursor:pointer}
.note{margin:8px 0 0;font-size:11px;color:var(--muted);line-height:1.4}
.dow,.grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
.dow div{text-align:center;font-size:11px;color:var(--muted);padding-bottom:6px}
.cell{position:relative;aspect-ratio:1/1.2;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--text);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:0;font-family:inherit;cursor:pointer;transition:transform .08s;min-width:0}
.cell:active{transform:scale(.94)}
.cell .n{font-size:15px;font-weight:700}
.cell .a{font-size:10px;color:var(--muted)}
.cell.on{color:#04210e;border-color:transparent}
.cell.on.u0{background:var(--u0)}
.cell.on.u1{background:var(--u1)}
.cell.on .a{color:rgba(4,33,14,.75);font-weight:600}
.cell .by{position:absolute;top:3px;right:5px;font-size:9px;font-weight:700;opacity:.7}
.cell.today{outline:2px solid var(--warn);outline-offset:1px}
.cell.future{opacity:.35;cursor:not-allowed}
.legend{display:flex;gap:14px;justify-content:center;margin-top:14px;font-size:12px;color:var(--muted);flex-wrap:wrap}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px}
.hint{text-align:center;color:var(--muted);font-size:12px;margin-top:10px}
#toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);background:#0b1220;border:1px solid var(--line);color:var(--text);padding:10px 16px;border-radius:12px;font-size:14px;opacity:0;pointer-events:none;transition:opacity .2s;max-width:90%}
#toast.show{opacity:1}
</style>
</head>
<body>
<div class="wrap">

  <section id="login" class="hidden">
    <h1>Tabungan Berdua 💰</h1>
    <p class="sub">Masuk dulu, ya.</p>
    <form class="card" id="loginForm" autocomplete="on">
      <label>Kamu siapa?</label>
      <div class="chips" id="chips"></div>
      <label for="pass">Kata sandi</label>
      <input type="password" id="pass" autocomplete="current-password" required>
      <div class="err" id="loginErr"></div>
      <button class="btn" id="loginBtn" type="submit">Masuk</button>
    </form>
  </section>

  <section id="app" class="hidden">
    <div class="top">
      <div class="who" id="who"></div>
      <button class="link" id="logout" type="button">Keluar</button>
    </div>
    <h1>Tabungan Berdua 💰</h1>
    <p class="sub">Nominal kecil di bawah tanggal adalah total tabungan sampai hari itu.</p>

    <form class="card amt" id="amtForm">
      <label for="amt">Nominal menabung per hari (Rp)</label>
      <div class="row">
        <input type="number" id="amt" inputmode="numeric" min="1" max="100000000" step="1" required>
        <button class="btn save" type="submit">Simpan</button>
      </div>
      <div class="presets" id="presets"></div>
      <p class="note">Nominal baru berlaku untuk tanggal yang dicentang setelah ini. Tanggal yang sudah dicentang tetap memakai nominal lamanya.</p>
    </form>

    <div class="nav">
      <button class="nb" id="prev" type="button" aria-label="Bulan sebelumnya">‹</button>
      <h2 id="title"></h2>
      <button class="nb" id="next" type="button" aria-label="Bulan berikutnya">›</button>
    </div>

    <div class="stats">
      <div class="stat"><span>Bulan ini</span><b id="monthTotal">Rp 0</b></div>
      <div class="stat"><span>Total semua</span><b id="allTotal">Rp 0</b></div>
    </div>

    <div class="dow"><div>Sen</div><div>Sel</div><div>Rab</div><div>Kam</div><div>Jum</div><div>Sab</div><div>Min</div></div>
    <div class="grid" id="grid"></div>

    <div class="legend" id="legend"></div>
    <p class="hint">Tap tanggal untuk menandai sudah menabung. Tap lagi untuk membatalkan.</p>
  </section>
</div>
<div id="toast"></div>

<script>
(function () {
  var MONTHS = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
  var PRESETS = [50, 100, 500, 1000, 5000, 10000];
  var MAX_AMOUNT = 100000000;
  var state = { me: null, users: [], month: null, today: null, amount: 50, days: {}, total: 0 };
  var pending = {};
  var pendingCount = 0;
  var selectedUser = null;
  var loading = false;
  var USERS_CACHE = ["Aku", "Dia"];

  function $(id) { return document.getElementById(id); }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function num(n) { return n.toLocaleString("id-ID"); }
  function rp(n) { return "Rp " + num(n); }
  // format ringkas untuk kotak tanggal yang sempit (angka tepat ada di ringkasan atas)
  function compact(n) {
    if (n < 10000) return num(n);
    if (n < 1000000) return num(Math.floor(n / 100) / 10) + "rb";
    if (n < 1000000000) return num(Math.floor(n / 100000) / 10) + "jt";
    return num(Math.floor(n / 100000000) / 10) + "M";
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", credentials: "same-origin", headers: {} };
    if (opts.body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401 && path !== "/api/login") {
          showLogin();
          var e = new Error("unauth");
          e.unauth = true;
          throw e;
        }
        if (!r.ok) throw new Error(data.error || "Gagal, coba lagi");
        return data;
      });
    });
  }

  // ---------- login ----------
  function showLogin() {
    state.me = null;
    $("app").classList.add("hidden");
    $("login").classList.remove("hidden");
  }
  function buildChips(users) {
    var box = $("chips");
    box.textContent = "";
    var saved = null;
    try { saved = localStorage.getItem("tb_user"); } catch (e) {}
    if (!selectedUser || users.indexOf(selectedUser) < 0) {
      selectedUser = users.indexOf(saved) >= 0 ? saved : users[0];
    }
    users.forEach(function (u) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (u === selectedUser ? " sel" : "");
      b.textContent = u;
      b.addEventListener("click", function () {
        selectedUser = u;
        buildChips(users);
      });
      box.appendChild(b);
    });
  }
  $("loginForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    $("loginErr").textContent = "";
    $("loginBtn").disabled = true;
    api("/api/login", { method: "POST", body: { user: selectedUser, pass: $("pass").value } })
      .then(function () {
        try { localStorage.setItem("tb_user", selectedUser); } catch (e) {}
        $("pass").value = "";
        loading = false;
        return load(null);
      })
      .catch(function (e) { if (!e.unauth) $("loginErr").textContent = e.message; })
      .then(function () { $("loginBtn").disabled = false; });
  });
  $("logout").addEventListener("click", function () {
    api("/api/logout", { method: "POST", body: {} }).catch(function () {}).then(function () {
      showLogin();
    });
  });

  // ---------- data ----------
  function load(month, quiet) {
    if (loading) return Promise.resolve();
    loading = true;
    var q = month ? "?month=" + encodeURIComponent(month) : "";
    return api("/api/state" + q)
      .then(function (d) {
        // jangan timpa perubahan yang sedang diproses
        if (pendingCount > 0 && quiet) return;
        state.me = d.me;
        state.users = d.users;
        USERS_CACHE = d.users;
        state.today = d.today;
        state.month = d.month;
        state.amount = d.amount;
        state.days = d.days;
        state.total = d.total;
        $("login").classList.add("hidden");
        $("app").classList.remove("hidden");
        render();
      })
      .catch(function (e) {
        if (!e.unauth && !quiet) toast(e.message);
        if (!state.me && !e.unauth) showLogin();
      })
      .then(function () { loading = false; });
  }

  function userIdx(name) {
    return state.users.indexOf(name) === 1 ? 1 : 0;
  }

  function render() {
    var p = state.month.split("-");
    var y = +p[0], m = +p[1];
    $("title").textContent = MONTHS[m - 1] + " " + y;
    $("who").textContent = "Masuk sebagai " + state.me;

    var amtInput = $("amt");
    if (document.activeElement !== amtInput) amtInput.value = state.amount;

    var first = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Senin = 0
    var dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    var grid = $("grid");
    grid.textContent = "";
    for (var i = 0; i < first; i++) grid.appendChild(document.createElement("div"));

    var cum = 0;
    for (var d = 1; d <= dim; d++) {
      (function (d) {
        var ds = state.month + "-" + pad(d);
        var rec = state.days[ds];
        if (rec) cum += rec.amount;
        var future = ds > state.today;
        var b = document.createElement("button");
        b.type = "button";
        b.className = "cell" + (rec ? " on u" + userIdx(rec.by) : "") + (ds === state.today ? " today" : "") + (future ? " future" : "");
        b.setAttribute("aria-label", d + " " + MONTHS[m - 1] + (rec ? ", sudah menabung " + rp(rec.amount) : "") + ", total " + rp(cum));
        b.title = "Total sampai tanggal ini: " + rp(cum);
        var n = document.createElement("span");
        n.className = "n";
        n.textContent = d;
        var a = document.createElement("span");
        a.className = "a";
        a.textContent = compact(cum);
        b.appendChild(n);
        b.appendChild(a);
        if (rec) {
          var by = document.createElement("span");
          by.className = "by";
          by.textContent = rec.by.charAt(0).toUpperCase();
          b.appendChild(by);
        }
        b.addEventListener("click", function () { toggle(ds); });
        grid.appendChild(b);
      })(d);
    }

    $("monthTotal").textContent = rp(cum);
    $("allTotal").textContent = rp(state.total);
    $("next").disabled = state.month >= state.today.slice(0, 7);

    var lg = $("legend");
    lg.textContent = "";
    state.users.forEach(function (u, i) {
      var s = document.createElement("span");
      var dot = document.createElement("i");
      dot.className = "dot";
      dot.style.background = i === 1 ? "var(--u1)" : "var(--u0)";
      s.appendChild(dot);
      s.appendChild(document.createTextNode(u));
      lg.appendChild(s);
    });
  }

  function toggle(ds) {
    if (ds > state.today) { toast("Tanggal ini belum tiba"); return; }
    if (pending[ds]) return;
    var was = state.days[ds];
    if (was && !confirm("Batalkan tanda menabung untuk tanggal ini?")) return;
    var turnOn = !was;
    var optimistic = { by: state.me, amount: state.amount };

    pending[ds] = true;
    pendingCount++;
    if (turnOn) { state.days[ds] = optimistic; state.total += optimistic.amount; }
    else { delete state.days[ds]; state.total -= was.amount; }
    render();

    api("/api/toggle", { method: "POST", body: { date: ds, on: turnOn } })
      .then(function (r) {
        if (r.by) state.days[ds] = { by: r.by, amount: r.amount }; else delete state.days[ds];
      })
      .catch(function (e) {
        // kembalikan seperti semula
        if (turnOn) { delete state.days[ds]; state.total -= optimistic.amount; }
        else { state.days[ds] = was; state.total += was.amount; }
        if (!e.unauth) toast(e.message);
      })
      .then(function () {
        delete pending[ds];
        pendingCount--;
        if (state.me) {
          if (pendingCount === 0) { loading = false; load(state.month, true); }
          else render();
        }
      });
  }

  // ---------- nominal ----------
  PRESETS.forEach(function (v) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "preset";
    b.textContent = num(v);
    b.addEventListener("click", function () { $("amt").value = v; });
    $("presets").appendChild(b);
  });
  $("amtForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var v = Number($("amt").value);
    if (!Number.isInteger(v) || v < 1 || v > MAX_AMOUNT) {
      toast("Isi bilangan bulat antara 1 dan 100.000.000");
      return;
    }
    api("/api/amount", { method: "POST", body: { amount: v } })
      .then(function (d) {
        state.amount = d.amount;
        $("amt").blur();
        render();
        toast("Nominal per hari sekarang " + rp(d.amount));
      })
      .catch(function (e) { if (!e.unauth) toast(e.message); });
  });

  function shift(delta) {
    var p = state.month.split("-");
    var y = +p[0], m = +p[1] + delta;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    var nm = y + "-" + pad(m);
    if (delta > 0 && nm > state.today.slice(0, 7)) return;
    load(nm);
  }
  $("prev").addEventListener("click", function () { shift(-1); });
  $("next").addEventListener("click", function () { shift(1); });

  // sinkron otomatis antar perangkat
  setInterval(function () {
    if (!document.hidden && state.me && pendingCount === 0) load(state.month, true);
  }, 15000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.me && pendingCount === 0) load(state.month, true);
  });

  // mulai
  buildChips(USERS_CACHE);
  fetch("/api/users").then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.users && d.users.length) { USERS_CACHE = d.users; buildChips(d.users); }
  }).catch(function () {});
  load(null);
})();
</script>
</body>
</html>`;
