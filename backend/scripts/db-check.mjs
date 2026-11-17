// Supabase connection diagnostic. Prints NO passwords/keys.
// Put this file in backend/scripts/ and run from the backend folder:
//   node --env-file=.env scripts/db-check.mjs
import dns from "node:dns/promises";
import pg from "pg";

const raw = process.env.SUPABASE_DB_URL;
if (!raw) { console.log("SUPABASE_DB_URL is not set. Run:  node --env-file=.env scripts/db-check.mjs"); process.exit(2); }

let u; try { u = new URL(raw); } catch { console.log("SUPABASE_DB_URL is not a valid URL (check special characters in the password: @ : / # ? must be percent-encoded)."); process.exit(2); }
const host = u.hostname, port = Number(u.port || 5432);
const line = (k, v) => console.log(`${k.padEnd(22)} ${v}`);
const warn = (m) => console.log(`  >> ${m}`);

console.log("\nSupabase connection check\n");
line("Host", host); line("Port", port);
if (port === 6543) warn("Port 6543 is the TRANSACTION pooler. It is fine for most queries but the backend uses BEGIN/COMMIT on one connection; prefer the SESSION pooler (port 5432 on the pooler host).");
if (/^db\..+\.supabase\.co$/.test(host)) warn("This is the DIRECT host. It is IPv6-only on many projects; many home/ISP networks have no IPv6 and then fail or time out. If the checks below fail, use the 'Session pooler' string from Supabase > Connect.");

let addrs = [];
try { addrs = await dns.lookup(host, { all: true }); } catch {}
const a4 = addrs.filter((a) => a.family === 4), a6 = addrs.filter((a) => a.family === 6);
line("IPv4 addresses", a4.length || "none"); line("IPv6 addresses", a6.length || "none");
if (!addrs.length) warn("Host does not resolve: wrong host, no internet/DNS, or the project was deleted.");
if (!a4.length && a6.length) warn("IPv6-only host. If you see timeouts/ENETUNREACH below, switch to the pooler connection string.");

const client = new pg.Client({ connectionString: raw, connectionTimeoutMillis: 10_000, application_name: "smartcare-db-check" });
client.on("error", (e) => console.log("  (connection error event)", e.code || e.message));
let t = Date.now();
try {
  await client.connect();
  line("Connect", `OK in ${Date.now() - t} ms`);
} catch (e) {
  line("Connect", `FAILED after ${Date.now() - t} ms`);
  line("Error code", e.code || e.name); line("Error message", e.message);
  if (e.code === "ENOTFOUND") warn("DNS failed. Check the host in SUPABASE_DB_URL.");
  if (e.code === "ETIMEDOUT" || e.code === "ENETUNREACH" || /timeout/i.test(e.message)) warn("Network can't reach Supabase. Likely IPv6-only direct host, firewall/VPN, or the project is PAUSED (free projects pause after ~1 week idle: open the Supabase dashboard and click Restore).");
  if (e.code === "28P01" || /password authentication/i.test(e.message)) warn("Wrong database password. Reset it in Supabase > Project Settings > Database, then update .env.");
  if (/Tenant or user not found/i.test(e.message)) warn("Pooler username must be postgres.<project-ref>, copied exactly from the Supabase Connect dialog.");
  console.log("\nIMPORTANT: when this happens the backend can silently fall back to a local SQLite file, so you may be looking at different data than Supabase holds.");
  process.exit(1);
}

const times = [];
for (let i = 0; i < 8; i++) { t = Date.now(); await client.query("select 1"); times.push(Date.now() - t); }
times.sort((x, y) => x - y);
const median = times[Math.floor(times.length / 2)];
line("Query latency (median)", `${median} ms   (all: ${times.join(", ")})`);
if (median > 150) warn("Each query pauses the WHOLE backend for this long (the Postgres adapter is synchronous). A page needing ~10 queries would freeze it ~" + (median * 10 / 1000).toFixed(1) + "s. Pick a Supabase region close to you (e.g. Singapore for the Philippines).");
else if (median > 60) warn("Acceptable, but noticeable. Closer region would help.");

for (const table of ["users", "appointments", "services", "dentists", "appointment_payments"]) {
  try { const r = await client.query(`select count(*)::int as n from ${table}`); line(`Table ${table}`, `${r.rows[0].n} rows`); }
  catch (e) { line(`Table ${table}`, `ERROR ${e.code}: ${e.message}`); if (e.code === "42P01") warn("Table missing: the schema in backend/supabase/schema.sql has not been applied to this database."); }
}
const ssl = await client.query("select ssl from pg_stat_ssl where pid = pg_backend_pid()").catch(() => null);
if (ssl?.rows?.[0]) line("SSL", ssl.rows[0].ssl ? "on" : "off");
await client.end();
console.log("\nDone. If everything above is OK, the database is healthy and the 500 is coming from the backend process or proxy (send me the backend terminal output).");
