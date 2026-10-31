SIPINTAR v0.9.42-cahaya-prima — PAKET DEPLOY VERCEL (Fase 37)
============================================================

ISI FOLDER INI (unggah apa adanya sebagai root proyek Vercel)
  index.html, app.js, sw.js   aplikasi (shell + logika + service worker)
  offline.html                salinan satu-berkas utk unduhan ber-PIN
  vercel.json                 header cache & Content-Disposition unduhan
  vercel-api-core.js          inti API sync (KV eksternal, nol dependensi)
  api/                        11 fungsi serverless = kontrak server/server.js
  package.json                pin Node 20 (TANPA dependensi npm)

LANGKAH DEPLOY (±10 menit, panduan lengkap: paket/PANDUAN-HOSTING-VERCEL.md)
  1. Buat KV: vercel.com → Storage → Create Database → Redis (KV),
     region Singapore (sin1/ap-southeast-1) agar latency rendah dari Jakarta.
     Atau buat gratis di upstash.com (Redis → region Singapore).
  2. Deploy folder ini: `vercel deploy --prod` (atau impor repo GitHub).
  3. Project → Settings → Environment Variables, isi:
       UPSTASH_REDIS_REST_URL   = https://xxx.upstash.io
       UPSTASH_REDIS_REST_TOKEN = AY...token...
       SIPINTAR_ROLE            = CLOUD
       SIPINTAR_API_TOKEN       = <token rahasia buatan Anda, WAJIB utk URL publik>
     (Bila memakai Vercel KV, tombol "Connect Project" mengisi
      KV_REST_API_URL & KV_REST_API_TOKEN secara otomatis.)
  4. Redeploy agar environment variable terbaca.
  5. Buka https://<proyek>.vercel.app/api/state → harus muncul
     "ok":true, "runtime":"vercel-serverless", "storage":"upstash-redis".
  6. Buka aplikasi di dua perangkat berbeda OS → menu Sinkronisasi →
     kartu "Hosting & Sinkronisasi Lintas Perangkat" harus hijau,
     isi Token API (langkah 3) di tiap perangkat, lalu uji konvergensi.

CATATAN PENTING
  • Serverless TIDAK punya disk: tanpa KV, /api/* menjawab
    STORAGE_BELUM_DISETEL dan aplikasi tetap di mode simulasi (jujur,
    tidak pernah berpura-pura sinkron).
  • Jangan menyetel SIPINTAR_KV=memory di produksi — data hilang tiap
    cold start (hanya untuk uji lokal `vercel dev`).
  • Irama sync bawaan di serverless = 3 menit/perangkat (hemat kuota).
    Perubahan data & tombol "Sinkron Sekarang" tetap diproses seketika.
  • Perbarui aplikasi: jalankan `node tools/buat-paket-vercel.js` lalu
    deploy ulang — versi/SHA-256 dipanggang ulang otomatis ke API.
