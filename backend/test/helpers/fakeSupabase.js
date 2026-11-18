// In-memory stand-in for the Supabase query builder (subset used by CareLoop).
// DB-level constraints/triggers are verified separately against real Postgres.
let counter = 0;
const uid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const tick = () => new Date(Date.UTC(2026, 0, 1) + 1000 * 3600 * 24 * 365 + ++counter).toISOString();

function createFakeSupabase() {
  const store = { tables: {} };
  class Query {
    constructor(table) { this.table = table; this.op = null; this.payload = null; this.filters = []; this.cols = "*"; this.single_ = false; this.maybe = false; this.orders = []; this.lim = null; }
    select(cols = "*") { this.op = this.op || "select"; this.cols = cols; return this; }
    insert(p) { this.op = "insert"; this.payload = p; return this; }
    update(p) { this.op = "update"; this.payload = p; return this; }
    delete() { this.op = "delete"; return this; }
    eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
    neq(c, v) { this.filters.push((r) => r[c] !== v); return this; }
    is(c, v) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
    in(c, vs) { this.filters.push((r) => vs.includes(r[c])); return this; }
    order(c, o = {}) { this.orders.push([c, o.ascending === false ? -1 : 1]); return this; }
    limit(n) { this.lim = n; return this; }
    single() { this.single_ = true; return this; }
    maybeSingle() { this.maybe = true; return this; }
    then(res, rej) { return Promise.resolve(this.exec()).then(res, rej); }
    project(r) {
      if (this.cols === "*") return { ...r };
      if (this.cols.includes("(")) throw new Error("fake supabase: joins are not supported");
      const out = {}; this.cols.split(",").map((s) => s.trim()).forEach((c) => { out[c] = r[c]; }); return out;
    }
    exec() {
      const rows = (store.tables[this.table] = store.tables[this.table] || []);
      let result;
      if (this.op === "insert") {
        const items = Array.isArray(this.payload) ? this.payload : [this.payload];
        result = items.map((it) => { const row = { id: uid(), created_at: tick(), ...it }; rows.push(row); return row; });
      } else if (this.op === "delete") {
        result = rows.filter((r) => this.filters.every((f) => f(r)));
        store.tables[this.table] = rows.filter((r) => !result.includes(r));
      } else {
        result = rows.filter((r) => this.filters.every((f) => f(r)));
        if (this.op === "update") result.forEach((r) => Object.assign(r, this.payload));
      }
      for (const [c, d] of [...this.orders].reverse()) result = [...result].sort((a, b) => (a[c] > b[c] ? d : a[c] < b[c] ? -d : 0));
      if (this.lim) result = result.slice(0, this.lim);
      if (this.single_ || this.maybe) {
        if (result.length === 0) return this.maybe ? { data: null, error: null } : { data: null, error: { message: "Row not found", code: "PGRST116" } };
        if (result.length > 1) return { data: null, error: { message: "Multiple rows", code: "PGRST116" } };
        return { data: this.project(result[0]), error: null };
      }
      return { data: result.map((r) => this.project(r)), error: null };
    }
  }
  return {
    from: (t) => new Query(t),
    reset(seed = {}) { store.tables = {}; for (const [k, v] of Object.entries(seed)) store.tables[k] = v.map((r) => ({ ...r })); },
    table: (t) => store.tables[t] || [],
  };
}
module.exports = { createFakeSupabase };
