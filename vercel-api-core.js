'use strict';
/* =====================================================================
   SIPINTAR — INTI API SINKRONISASI UNTUK HOSTING SERVERLESS (VERCEL)
   Fase 37. NOL dependensi npm (hanya fetch & crypto bawaan Node 18+).

   Mengapa berkas ini ada:
   Vercel menjalankan fungsi serverless yang TIDAK punya disk tetap, jadi
   server/server.js (yang menyimpan state ke sipintar-server-data.json)
   tidak bisa dipakai apa adanya. Inti ini menerapkan KONTRAK API YANG SAMA
   persis (sehingga klien di index.html tidak perlu diubah) tetapi menyimpan
   seluruh state ke KV eksternal lewat protokol Redis REST:
     • Upstash Redis            → UPSTASH_REDIS_REST_URL / _TOKEN
     • Vercel KV (= Upstash)    → KV_REST_API_URL / KV_REST_API_TOKEN
     • memori (uji/dev lokal)   → SIPINTAR_KV=memory   [VOLATIL!]
   Bila tidak ada satupun → endpoint mengembalikan STORAGE_BELUM_DISETEL
   (klien tetap di mode simulasi, tidak pernah diam-diam kehilangan data).

   Keamanan: setel SIPINTAR_API_TOKEN → semua endpoint tulis/baca data
   mewajibkan header X-SIPINTAR-Token (atau ?api_token=). /api/state,
   /api/app-version, /api/offline-pin/status, dan /api/offline-package
   dikecualikan (state/app-version tidak memuat data sekolah; offline-package
   punya gerbang token unduhannya sendiri).

   Berkas ini adalah TEMPLATE: tools/buat-paket-vercel.js menyalinnya ke
   deploy-vercel/vercel-api-core.js sambil mengisi placeholder versi, ukuran,
   dan SHA-256 berkas aplikasi, karena fungsi serverless tidak dapat membaca
   berkas dari disk.
   ===================================================================== */

const crypto = require('crypto');

/* ---------- konstanta aplikasi (diisi saat build; serverless tanpa disk) ---------- */
const BAKED = {
  version: '0.9.42-cahaya-prima',
  size: Number('1339665') || 0,
  sha256: 'b0073b296e9ef969ad3c36ef19b1dc2a664390f75bd6282ad04c3df85be422ab',
  built_at: '2026-10-31T13:50:20.453Z',
  offline_file: '/offline.html'
};

const MAX_PULL_DEFAULT = 500;
const RUNTIME = 'vercel-serverless';

/* =====================================================================
   1. ADAPTER KV — satu antarmuka: pipeline(cmds) → Promise<hasil[]>
      Seluruh operasi inti ditulis sebagai perintah Redis, jadi dua
      backend (Upstash REST & memori) memakai jalur kode yang sama.
   ===================================================================== */
function kvConfig(env) {
  env = env || process.env;
  const url = String(env.SIPINTAR_KV_URL || env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || env.KV_URL || '').trim().replace(/\/+$/, '');
  const token = String(env.SIPINTAR_KV_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || env.KV_REST_API_KEY || '').trim();
  const mode = String(env.SIPINTAR_KV || '').toLowerCase();
  if (url) return {kind: 'upstash', url: url, token: token, label: 'upstash-redis'};
  if (mode === 'memory') return {kind: 'memory', label: 'memory'};
  return {kind: null, label: null, mode: mode};
}

/* --- Upstash / Vercel KV lewat REST (pipeline = 1 round-trip) --- */
function upstashKv(cfg, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  function pipeline(cmds) {
    if (!cmds || !cmds.length) return Promise.resolve([]);
    if (typeof f !== 'function') return Promise.reject(new Error('fetch tidak tersedia di runtime ini'));
    const headers = {'Content-Type': 'application/json'};
    if (cfg.token) headers['Authorization'] = 'Bearer ' + cfg.token;
    return f(cfg.url, {method: 'POST', headers: headers, body: JSON.stringify(cmds)}).then(function (r) {
      return r.text().then(function (txt) {
        let j = null; try { j = JSON.parse(txt); } catch (e) {}
        if (!r.ok || !j) throw new Error('KV HTTP ' + r.status + (txt ? ': ' + txt.slice(0, 180) : ''));
        if (j.error) throw new Error('KV: ' + j.error);
        return (j.result || []).map(function (x) {
          if (x && x.error) throw new Error('KV: ' + x.error);
          return x ? x.result : null;
        });
      });
    });
  }
  return {kind: 'upstash', label: 'upstash-redis', volatile: false, pipeline: pipeline};
}

/* --- KV memori (uji otomatis / `vercel dev` tanpa KV) — VOLATIL --- */
function memoryKv() {
  const store = new Map();
  function live(k) {
    const r = store.get(k);
    if (!r) return null;
    if (r.exp && r.exp < Date.now()) { store.delete(k); return null; }
    return r;
  }
  function str(k, v, exp) { store.set(k, {type: 'str', v: String(v), exp: exp || 0}); }
  function hash(k) { let h = live(k); if (!h || h.type !== 'hash') { h = {type: 'hash', v: {}, exp: 0}; store.set(k, h); } return h; }
  function incrBy(k, n) {
    const r = live(k);
    const v = (r && r.type === 'str' ? Number(r.v) || 0 : 0) + n;
    str(k, v, r ? r.exp : 0);
    return v;
  }
  function exec(c) {
    const op = String(c[0]).toUpperCase(), k = c[1];
    let i, r, h, n;
    switch (op) {
      case 'GET': r = live(k); return r && r.type === 'str' ? r.v : null;
      case 'SET': {
        let nx = false, xx = false, ex = 0;
        for (i = 3; i < c.length; i++) {
          const a = String(c[i]).toUpperCase();
          if (a === 'NX') nx = true;
          else if (a === 'XX') xx = true;
          else if (a === 'EX') { ex = Number(c[++i]) || 0; }
          else if (a === 'PX') { ex = (Number(c[++i]) || 0) / 1000; }
        }
        const cur = live(k);
        if (nx && cur) return null;
        if (xx && !cur) return null;
        str(k, c[2] === undefined || c[2] === null ? '' : c[2], ex ? Date.now() + ex * 1000 : 0);
        return 'OK';
      }
      case 'DEL': n = 0; for (i = 1; i < c.length; i++) { if (store.delete(c[i])) n++; } return n;
      case 'EXISTS': n = 0; for (i = 1; i < c.length; i++) { if (live(c[i])) n++; } return n;
      case 'INCR': return incrBy(k, 1);
      case 'INCRBY': return incrBy(k, Number(c[2]) || 0);
      case 'DECRBY': return incrBy(k, -(Number(c[2]) || 0));
      case 'MGET': return c.slice(1).map(function (x) { const q = live(x); return q && q.type === 'str' ? q.v : null; });
      case 'HSET': {
        h = hash(k); n = 0;
        for (i = 2; i + 1 < c.length; i += 2) {
          const f = String(c[i]);
          if (!(f in h.v)) n++;
          h.v[f] = String(c[i + 1]);
        }
        return n;
      }
      case 'HGET': h = live(k); return h && h.type === 'hash' && (String(c[2]) in h.v) ? h.v[String(c[2])] : null;
      case 'HGETALL': h = live(k); return h && h.type === 'hash' ? Object.assign({}, h.v) : {};
      case 'HLEN': h = live(k); return h && h.type === 'hash' ? Object.keys(h.v).length : 0;
      case 'HDEL': {
        h = live(k); if (!h || h.type !== 'hash') return 0; n = 0;
        for (i = 2; i < c.length; i++) { if (String(c[i]) in h.v) { delete h.v[String(c[i])]; n++; } }
        return n;
      }
      case 'HINCRBY': {
        h = hash(k);
        const v = (Number(h.v[String(c[2])]) || 0) + (Number(c[3]) || 0);
        h.v[String(c[2])] = String(v);
        return v;
      }
      default: throw new Error('perintah KV tidak didukung: ' + op);
    }
  }
  return {
    kind: 'memory', label: 'memory', volatile: true,
    pipeline: function (cmds) { return Promise.resolve((cmds || []).map(exec)); },
    _store: store
  };
}

function makeKv(env, fetchImpl) {
  const cfg = kvConfig(env);
  if (cfg.kind === 'upstash') return upstashKv(cfg, fetchImpl);
  if (cfg.kind === 'memory') return memoryKv();
  return null;
}

/* =====================================================================
   2. INTI API — createApi({env, kv, fetch}) → {info(), handle(req,res,path)}
   ===================================================================== */
function createApi(options) {
  options = options || {};
  const env = options.env || process.env;
  const kv = options.kv !== undefined ? options.kv : makeKv(env, options.fetch);
  const role = String(env.SIPINTAR_ROLE || 'CLOUD').toUpperCase();
  const apiToken = String(env.SIPINTAR_API_TOKEN || '').trim();
  const prefix = String(env.SIPINTAR_KV_PREFIX || 'sipintar').replace(/[^A-Za-z0-9_.-]/g, '');
  const MAX_PULL = Math.max(1, Number(env.SIPINTAR_MAX_PULL || MAX_PULL_DEFAULT));
  const idemTtl = Math.max(60, Number(env.SIPINTAR_IDEM_TTL_DAYS || 30) * 86400);
  const eventTtl = Number(env.SIPINTAR_EVENT_TTL_DAYS || 0) > 0 ? Number(env.SIPINTAR_EVENT_TTL_DAYS) * 86400 : 0;

  const K = {
    seq: prefix + ':seq',
    evt: n => prefix + ':evt:' + n,
    idem: k => prefix + ':idem:' + k,
    devices: prefix + ':devices',
    statsOp: prefix + ':stats:op',
    statsEnt: prefix + ':stats:ent',
    meta: prefix + ':meta',
    pin: prefix + ':pin'
  };
  function nowIso() { return new Date().toISOString(); }
  function safeJson(s, fb) { try { const v = JSON.parse(s); return v === null || v === undefined ? fb : v; } catch (e) { return fb; } }

  /* ---------- helper HTTP ---------- */
  function cors(res) {
    try {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-SIPINTAR-Token, Authorization');
      res.setHeader('Access-Control-Max-Age', '86400');
    } catch (e) {}
  }
  function json(res, code, obj) {
    cors(res);
    const body = JSON.stringify(obj);
    try {
      res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body)});
      res.end(body);
    } catch (e) { /* res sudah ditutup */ }
    return Promise.resolve(obj);
  }
  function readBody(req) {
    return new Promise(function (resolve) {
      const pre = req.body;
      if (pre !== undefined && pre !== null) {
        if (typeof pre === 'string') return resolve(safeJson(pre, null) || {});
        if (Buffer.isBuffer(pre)) return resolve(safeJson(pre.toString('utf8'), null) || {});
        if (typeof pre === 'object') return resolve(pre);
      }
      let raw = '', done = false;
      const finish = v => { if (!done) { done = true; clearTimeout(guard); resolve(v); } };
      const guard = setTimeout(() => finish(raw ? (safeJson(raw, null) || {}) : {}), 5000);
      try {
        req.on('data', c => { raw += c; if (raw.length > 25e6) { try { req.destroy(); } catch (e) {} } });
        req.on('end', () => finish(raw ? (safeJson(raw, null) || {}) : {}));
        req.on('error', () => finish({}));
      } catch (e) { finish({}); }
    });
  }
  function queryOf(req) {
    const o = {};
    if (req.query && typeof req.query === 'object') {
      Object.keys(req.query).forEach(k => { const v = req.query[k]; o[k] = Array.isArray(v) ? v[0] : v; });
    }
    const u = String(req.url || '');
    const i = u.indexOf('?');
    if (i !== -1) { new URLSearchParams(u.slice(i + 1)).forEach((v, k) => { o[k] = v; }); }
    return o;
  }
  function tokenOf(req, q) {
    const h = req.headers || {};
    const head = h['x-sipintar-token'] || h['X-SIPINTAR-Token'];
    if (head) return String(head).trim();
    const auth = String(h['authorization'] || h['Authorization'] || '');
    if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
    return String(q.api_token || '').trim();
  }

  /* ---------- info server (dipakai /api/state & uji otomatis) ---------- */
  function info() {
    return {
      runtime: RUNTIME, role: role,
      storage: kv ? kv.label : null,
      volatile: !!(kv && kv.volatile),
      tokenRequired: !!apiToken,
      maxPull: MAX_PULL, prefix: prefix
    };
  }

  /* ---------- operasi data di atas KV ---------- */
  function ensureMeta() {
    return kv.pipeline([['HGET', K.meta, 'started_at']]).then(function (r) {
      if (!r[0]) return kv.pipeline([['HSET', K.meta, 'started_at', nowIso(), 'total_events', '0']]);
      return r;
    });
  }
  function getSeq() { return kv.pipeline([['GET', K.seq]]).then(r => Number(r[0]) || 0); }
  function deviceGet(id) {
    return kv.pipeline([['HGET', K.devices, id]]).then(r => safeJson(r[0], null));
  }
  function devicePut(d) { return kv.pipeline([['HSET', K.devices, d.id, JSON.stringify(d)]]).then(() => d); }
  function deviceOf(id, name) {
    if (!id) return Promise.resolve(null);
    return deviceGet(id).then(function (d) {
      if (!d) {
        d = {id: id, name: name || id, registered_at: nowIso(), last_seen: nowIso(),
             status: 'AKTIF', event_count: 0, school_id: null};
      } else {
        d.last_seen = nowIso();
        if (name) d.name = name;
      }
      return devicePut(d);
    });
  }

  /* ---------- rute ---------- */
  function routeState(res, authorized) {
    if (!kv) {
      return json(res, 200, {ok: false, error: 'STORAGE_BELUM_DISETEL', runtime: RUNTIME, role: role, storage: null,
        features: {serverless: true, offline_pin: true, tls: true, volatile_storage: false, token_required: !!apiToken, anonymous_access: !apiToken},
        hint: 'Setel UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN (atau KV_REST_API_URL & KV_REST_API_TOKEN) di Environment Variables, lalu redeploy.'});
    }
    return ensureMeta().then(() => kv.pipeline([
      ['GET', K.seq], ['HLEN', K.devices], ['HGET', K.meta, 'total_events']
    ])).then(function (r) {
      const base = {
        ok: true, role: role, runtime: RUNTIME, storage: kv.label,
        server_seq: Number(r[0]) || 0, devices: Number(r[1]) || 0, events: Number(r[2]) || 0,
        app: true, features: {tls: true, offline_pin: true, serverless: true,
                              volatile_storage: !!kv.volatile, token_required: !!apiToken,
                              anonymous_access: !apiToken}
      };
      if (!authorized) {
        /* tanpa token: cukup bukti bahwa server SIPINTAR hidup di host ini */
        return json(res, 200, {ok: false, error: 'TOKEN_WAJIB', runtime: RUNTIME, role: role, storage: kv.label,
          features: base.features});
      }
      return json(res, 200, base);
    });
  }

  function routeConsolidated(res) {
    if (!kv) return json(res, 503, {ok: false, error: 'STORAGE_BELUM_DISETEL'});
    return kv.pipeline([
      ['GET', K.seq], ['HGETALL', K.devices], ['HGETALL', K.statsOp], ['HGETALL', K.statsEnt],
      ['HGET', K.meta, 'started_at'], ['HGET', K.meta, 'total_events']
    ]).then(function (r) {
      const devices = Object.keys(r[1] || {}).map(k => safeJson(r[1][k], null)).filter(Boolean);
      const byOp = {}, byEnt = {};
      Object.keys(r[2] || {}).forEach(k => { byOp[k] = Number(r[2][k]) || 0; });
      Object.keys(r[3] || {}).forEach(k => { byEnt[k] = Number(r[3][k]) || 0; });
      return json(res, 200, {
        ok: true, role: role, runtime: RUNTIME, storage: kv.label,
        server_seq: Number(r[0]) || 0, total_events: Number(r[5]) || 0,
        devices: devices, revoked: devices.filter(d => d.status === 'DICABUT').length,
        by_operation: byOp, by_entity: byEnt, started_at: r[4] || null
      });
    });
  }

  function routeDevices(res, b) {
    if (!kv) return json(res, 503, {ok: false, error: 'STORAGE_BELUM_DISETEL'});
    if (!b || !b.device_id) return json(res, 400, {ok: false, error: 'device_id wajib'});
    return deviceOf(b.device_id, b.device_name || b.name).then(function (d) {
      const cmds = [];
      if (b.school_id && d.school_id !== b.school_id) { d.school_id = b.school_id; cmds.push(['HSET', K.devices, d.id, JSON.stringify(d)]); }
      cmds.push(['GET', K.seq]);
      return kv.pipeline(cmds).then(r => json(res, 200, {ok: true, device: d, server_seq: Number(r[r.length - 1]) || 0, runtime: RUNTIME}));
    });
  }

  function routeRevoke(res, b) {
    if (!kv) return json(res, 503, {ok: false, error: 'STORAGE_BELUM_DISETEL'});
    if (!b || !b.device_id) return json(res, 400, {ok: false, error: 'device_id wajib'});
    return deviceOf(b.device_id, b.name || b.device_name).then(function (d) {
      d.status = b.revoke === false ? 'AKTIF' : 'DICABUT';
      d.revoked_at = d.status === 'DICABUT' ? nowIso() : null;
      return devicePut(d).then(() => json(res, 200, {ok: true, device: d}));
    });
  }

  function routePush(res, b) {
    if (!kv) return json(res, 503, {ok: false, error: 'STORAGE_BELUM_DISETEL'});
    if (!b) return json(res, 400, {ok: false, error: 'body JSON tidak valid'});
    if (!b.device_id) return json(res, 400, {ok: false, error: 'device_id wajib'});
    return deviceOf(b.device_id, b.device_name).then(function (d) {
      if (!d) return json(res, 400, {ok: false, error: 'device_id wajib'});
      if (d.status === 'DICABUT') return json(res, 403, {ok: false, error: 'PERANGKAT_DICABUT'});
      if (b.school_id) d.school_id = b.school_id;
      const events = (b.events || []).filter(e => e && e.idempotency_key);
      if (!events.length) {
        return devicePut(d).then(() => getSeq()).then(seq => json(res, 200, {ok: true, acks: [], server_seq: seq, accepted: 0, runtime: RUNTIME}));
      }
      /* (1) kunci deduplikasi: SET NX per idempotency_key — atomik antar fungsi */
      return kv.pipeline(events.map(e => ['SET', K.idem(e.idempotency_key), '0', 'NX', 'EX', idemTtl])).then(function (locked) {
        const fresh = events.filter((e, i) => locked[i] === 'OK');
        const dups = events.filter((e, i) => locked[i] !== 'OK');
        if (!fresh.length) {
          return devicePut(d).then(() => getSeq()).then(seq => json(res, 200, {
            ok: true, runtime: RUNTIME, server_seq: seq, accepted: 0,
            acks: dups.map(e => ({idempotency_key: e.idempotency_key, dup: true, seq: null}))
          }));
        }
        /* (2) pesan blok seq atomik (INCRBY n) → tidak ada dua fungsi berebut nomor */
        return kv.pipeline([['INCRBY', K.seq, fresh.length]]).then(function (r) {
          const seqEnd = Number(r[0]) || fresh.length;
          const seqStart = seqEnd - fresh.length + 1;
          const receivedAt = nowIso();
          const stored = [];
          const acks = [];
          const cmds = [];
          fresh.forEach(function (ev, i) {
            const seq = seqStart + i;
            const rec = {
              seq: seq, idempotency_key: ev.idempotency_key,
              entity_type: ev.entity_type || null, entity_id: ev.entity_id || null,
              operation: ev.operation || 'UNKNOWN', payload: ev.payload || null,
              payload_summary: ev.payload_summary || '', device_id: d.id, device_name: d.name,
              school_id: b.school_id || d.school_id || null,
              client_created_at: ev.client_created_at || null, received_at: receivedAt
            };
            stored.push(rec);
            const setCmd = ['SET', K.evt(seq), JSON.stringify(rec)];
            if (eventTtl) { setCmd.push('EX', eventTtl); }
            cmds.push(setCmd);
            cmds.push(['SET', K.idem(ev.idempotency_key), String(seq), 'EX', idemTtl]);
            cmds.push(['HINCRBY', K.statsOp, rec.operation, 1]);
            if (rec.entity_type) cmds.push(['HINCRBY', K.statsEnt, rec.entity_type, 1]);
            acks.push({idempotency_key: ev.idempotency_key, dup: false, seq: seq});
          });
          dups.forEach(e => acks.push({idempotency_key: e.idempotency_key, dup: true, seq: null}));
          d.event_count = (d.event_count || 0) + fresh.length;
          cmds.push(['HSET', K.devices, d.id, JSON.stringify(d)]);
          cmds.push(['HINCRBY', K.meta, 'total_events', fresh.length]);
          return kv.pipeline(cmds).then(() => json(res, 200, {
            ok: true, runtime: RUNTIME, storage: kv.label, acks: acks,
            server_seq: seqEnd, accepted: fresh.length, duplicates: dups.length
          }));
        });
      });
    });
  }

  function routePull(res, q) {
    if (!kv) return json(res, 503, {ok: false, error: 'STORAGE_BELUM_DISETEL'});
    const since = Number(q.since || 0) || 0;
    const deviceId = String(q.device_id || '');
    const school = String(q.school || '');
    return getSeq().then(function (seq) {
      const from = since + 1;
      const to = Math.min(seq, from + MAX_PULL - 1);
      if (to < from) {
        return json(res, 200, {ok: true, events: [], server_seq: seq, count: 0, truncated: false,
                               device_id: deviceId, role: role, runtime: RUNTIME, storage: kv.label});
      }
      const keys = [];
      for (let n = from; n <= to; n++) keys.push(K.evt(n));
      const chunks = [];
      for (let i = 0; i < keys.length; i += 100) chunks.push(keys.slice(i, i + 100));
      return chunks.reduce((p, c) => p.then(acc => kv.pipeline([['MGET'].concat(c)]).then(r => acc.concat(r[0] || []))), Promise.resolve([]))
        .then(function (raws) {
          let list = raws.filter(x => x !== null && x !== undefined).map(x => safeJson(x, null)).filter(Boolean);
          if (school) list = list.filter(e => !e.school_id || e.school_id === school);
          return json(res, 200, {
            ok: true, events: list, server_seq: seq, count: list.length,
            truncated: seq - since > MAX_PULL, device_id: deviceId, role: role,
            runtime: RUNTIME, storage: kv.label
          });
        });
    });
  }

  function routeAppVersion(res) {
    return json(res, 200, {ok: true, version: BAKED.version, size: BAKED.size, sha256: BAKED.sha256,
      mtime: BAKED.built_at, runtime: RUNTIME, source: 'build-time', offline_file: BAKED.offline_file,
      storage: kv ? kv.label : null});
  }

  function pinGet() {
    return kv.pipeline([['GET', K.pin]]).then(r => safeJson(r[0], null));
  }
  function pinSet(obj, ttlSec) {
    const cmd = ['SET', K.pin, JSON.stringify(obj)];
    if (ttlSec > 0) { cmd.push('EX', Math.ceil(ttlSec)); }
    return kv.pipeline([cmd]);
  }
  function pinActive(p) { return !!(p && new Date(p.expires_at).getTime() > Date.now()); }

  function routePinSet(res, b) {
    if (!kv) return json(res, 503, {ok: false, error: 'STORAGE_BELUM_DISETEL'});
    if (!b) return json(res, 400, {ok: false, error: 'body JSON tidak valid'});
    if (b.revoke) {
      return kv.pipeline([['DEL', K.pin]]).then(() => json(res, 200, {ok: true, active: false}));
    }
    const pin = String(b.pin || '');
    if (!/^\d{6}$/.test(pin)) return json(res, 400, {ok: false, error: 'PIN harus 6 digit angka'});
    const ttl = Math.max(5, Number(b.ttl_minutes || 480));
    const rec = {pin: pin, token: null, created_at: nowIso(), created_by: b.created_by || '-',
                 device_id: b.device_id || null, expires_at: new Date(Date.now() + ttl * 60000).toISOString()};
    return pinSet(rec, ttl * 60 + 60).then(() => json(res, 200, {ok: true, active: true, expires_at: rec.expires_at}));
  }
  function routePinStatus(res) {
    if (!kv) return json(res, 200, {ok: false, active: false, error: 'STORAGE_BELUM_DISETEL'});
    return pinGet().then(function (p) {
      const act = pinActive(p);
      return json(res, 200, {ok: true, active: act, expires_at: act ? p.expires_at : null,
                             created_by: act ? p.created_by : null, runtime: RUNTIME});
    });
  }
  function routePinVerify(res, b) {
    if (!kv) return json(res, 503, {ok: false, error: 'STORAGE_BELUM_DISETEL'});
    if (!b) return json(res, 400, {ok: false, error: 'body JSON tidak valid'});
    return pinGet().then(function (p) {
      if (!pinActive(p)) return json(res, 410, {ok: false, error: 'PIN_KADALUARSA'});
      if (String(b.pin || '') !== p.pin) return json(res, 403, {ok: false, error: 'PIN_SALAH'});
      p.token = crypto.randomBytes(16).toString('hex');
      const sisa = Math.max(60, (new Date(p.expires_at).getTime() - Date.now()) / 1000);
      return pinSet(p, sisa).then(() => json(res, 200, {ok: true, token: p.token, expires_at: p.expires_at}));
    });
  }
  /* Serverless tidak punya disk: berkas aplikasi disajikan sebagai aset statis
     /offline.html, endpoint ini memvalidasi token lalu MENGARAHKAN (302) ke sana.
     Header Content-Disposition & X-SIPINTAR-Version dipasang lewat vercel.json. */
  function routeOfflinePackage(res, q) {
    if (!kv) return json(res, 404, {ok: false, error: 'STORAGE_BELUM_DISETEL'});
    const tok = String(q.token || '');
    return pinGet().then(function (p) {
      if (!p || !p.token || p.token !== tok || !pinActive(p)) return json(res, 403, {ok: false, error: 'TOKEN_TIDAK_VALID'});
      cors(res);
      const loc = BAKED.offline_file + '?v=' + encodeURIComponent(BAKED.version) + '&dl=' + Date.now();
      res.writeHead(302, {
        'Location': loc, 'Cache-Control': 'no-store',
        'X-SIPINTAR-Version': BAKED.version,
        'X-SIPINTAR-Sha256': BAKED.sha256
      });
      res.end();
      return Promise.resolve({ok: true, redirect: loc});
    });
  }

  const EXEMPT = {'/api/state': 1, '/api/app-version': 1, '/api/offline-pin/status': 1, '/api/offline-package': 1};

  function handle(req, res, routePath) {
    const rawPath = routePath || String(req.url || '/').split('?')[0];
    const path = rawPath.replace(/\/+$/, '') || '/';
    const q = queryOf(req);
    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return Promise.resolve({ok: true}); }
    const authorized = !apiToken || tokenOf(req, q) === apiToken;
    try {
      if (path === '/api/state') return routeState(res, authorized);
      if (path === '/api/app-version') return routeAppVersion(res);
      if (path === '/api/offline-package' && req.method === 'GET') return routeOfflinePackage(res, q);
      if (path === '/api/offline-pin/status' && req.method === 'GET') return routePinStatus(res);
      if (!authorized) return json(res, 401, {ok: false, error: 'TOKEN_TIDAK_VALID', runtime: RUNTIME,
        hint: 'Kirim header X-SIPINTAR-Token (atau ?api_token=) yang sama dengan SIPINTAR_API_TOKEN di hosting.'});
      if (!kv && path !== '/api/state') {
        return json(res, 503, {ok: false, error: 'STORAGE_BELUM_DISETEL', runtime: RUNTIME,
          hint: 'Fungsi serverless tidak punya disk. Setel UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN (atau KV_REST_API_URL & KV_REST_API_TOKEN).'});
      }
      if (path === '/api/consolidated' && req.method === 'GET') return routeConsolidated(res);
      if (path === '/api/sync/pull' && req.method === 'GET') return routePull(res, q);
      if (req.method === 'POST') {
        return readBody(req).then(function (b) {
          if (path === '/api/devices') return routeDevices(res, b);
          if (path === '/api/devices/revoke') return routeRevoke(res, b);
          if (path === '/api/sync/push') return routePush(res, b);
          if (path === '/api/offline-pin') return routePinSet(res, b);
          if (path === '/api/offline-pin/verify') return routePinVerify(res, b);
          return json(res, 404, {ok: false, error: 'endpoint tidak dikenal: ' + path});
        });
      }
      return json(res, 404, {ok: false, error: 'endpoint tidak dikenal: ' + path});
    } catch (e) {
      return json(res, 500, {ok: false, error: 'KESALAHAN_SERVER', detail: String((e && e.message) || e)});
    }
  }

  return {handle: handle, info: info, kv: kv, BAKED: BAKED, keys: K, MAX_PULL: MAX_PULL};
}

/* Singleton untuk fungsi Vercel: inti dibuat sekali per instance container,
   lalu dipakai ulang oleh semua invocation di instance yang sama (hemat dingin). */
let _default = null;
function api() {
  if (!_default) _default = createApi({});
  return _default;
}

module.exports = {
  createApi: createApi, api: api, memoryKv: memoryKv, upstashKv: upstashKv,
  kvConfig: kvConfig, makeKv: makeKv, BAKED: BAKED, RUNTIME: RUNTIME
};
