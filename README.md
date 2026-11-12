# Tabungan Berdua 💰

Website tabungan harian untuk 2 orang. Buka di HP masing-masing, tap tanggal kalau hari itu sudah menabung. Kalender mengikuti tanggal asli, data tersinkron otomatis, dan nominal per hari bisa kamu atur sendiri (bukan cuma 50).

**Cara kerja tampilan**

- Tanggal yang di-tap jadi menyala (hijau/biru sesuai siapa yang menabung).
- Angka kecil di bawah tanggal = total tabungan sampai tanggal itu. Contoh nominal 50: tanggal 1 nyala → 50, tanggal 2 tidak nyala → tetap 50, tanggal 3 nyala → 100.
- Tanggal yang belum tiba terkunci. Tanggal yang sudah lewat masih boleh dicentang kalau lupa.
- Di atas ada ringkasan **Bulan ini** dan **Total semua**.

**Isi paket ini**

| File | Fungsi |
|---|---|
| `worker.js` | Seluruh website (tampilan, login, API) |
| `wrangler.toml` | Pengaturan deploy Cloudflare (nama, zona waktu, database) |
| `package.json` | Daftar alat deploy |
| `.gitignore` | Daftar file yang tidak ikut ke GitHub |

Tidak ada build, tidak ada framework. Biaya: gratis di paket gratis Cloudflare.

---

## Langkah 1: Siapkan nama kalian

Buka `wrangler.toml`, ganti baris `USERS` dengan dua nama kalian:

```toml
USERS = "Budi,Sari"
```

Kalau mau nominal awal bukan 50, ganti `DEFAULT_AMOUNT` (misalnya `"1000"`). Nominal ini tetap bisa diubah kapan saja dari website.

## Langkah 2: Upload ke GitHub

1. Ekstrak file ZIP. Kamu akan dapat folder `tabungan-berdua`.
2. Buka github.com → tombol **+** → **New repository**. Beri nama `tabungan-berdua`, pilih **Private**, klik **Create repository**.
3. Di halaman repo kosong, klik **uploading an existing file**.
4. **Seret semua isi folder** `tabungan-berdua` (`worker.js`, `wrangler.toml`, `package.json`, `.gitignore`, `README.md`). Jangan upload file ZIP-nya, GitHub tidak mengekstraknya.
5. Klik **Commit changes**.

## Langkah 3: Buat database di Cloudflare

1. Daftar/login di dash.cloudflare.com (gratis).
2. Menu **Storage & Databases** → **D1 SQL Database** → **Create database**.
3. Nama: `tabungan` → **Create**.
4. Di halaman database itu, salin **Database ID** (deretan huruf-angka panjang).
5. Kembali ke GitHub, buka `wrangler.toml` → ikon pensil (edit). Ganti `GANTI_DENGAN_DATABASE_ID` dengan ID tadi → **Commit changes**.

Tabel di dalam database dibuat otomatis, kamu tidak perlu mengisi apa pun.

## Langkah 4: Hubungkan GitHub ke Cloudflare

1. Cloudflare → **Workers & Pages** → **Create** → pilih **Import a repository** (menyambungkan ke Git).
2. Izinkan akses ke GitHub, pilih repo `tabungan-berdua`.
3. Biarkan pengaturan bawaan (deploy command `npx wrangler deploy`) → **Save and Deploy**.
4. Tunggu sampai berhasil. Kamu akan mendapat alamat seperti `tabungan-berdua.namakamu.workers.dev`.

Setiap kali file di GitHub diubah, Cloudflare otomatis deploy ulang.

## Langkah 5: Isi kata sandi (wajib)

Website belum bisa dipakai sebelum dua rahasia ini diisi:

1. Cloudflare → **Workers & Pages** → klik `tabungan-berdua` → **Settings** → **Variables and Secrets**.
2. **Add** → Type: **Secret**:
   - Name `PASSCODE`, value: kata sandi login kalian berdua (pakai yang panjang).
   - Name `SESSION_SECRET`, value: ketik acak panjang, misalnya 40 karakter campur huruf dan angka. Ini tidak perlu diingat.
3. Klik **Deploy** / **Save**.

Buka alamat `workers.dev` tadi. Kalau muncul halaman login, berarti berhasil.

---

## Cara pakai sehari-hari

1. Buka alamat websitenya, pilih **namamu**, masukkan kata sandi. Login bertahan 30 hari per perangkat.
2. **Menabung hari ini:** tap tanggal hari ini (ada garis kuning). Tanggal menyala dan nominal di bawahnya bertambah.
3. **Salah tap / mau batal:** tap tanggal yang menyala, lalu konfirmasi.
4. **Lupa kemarin:** tanggal yang sudah lewat masih bisa di-tap.
5. **Lihat bulan lain:** tombol ‹ dan › di atas kalender (bulan depan tidak bisa dibuka).
6. **Tabungan pasangan:** otomatis muncul di HP-mu dalam hitungan detik (atau saat aplikasi dibuka kembali).
7. **Tips:** di HP, buka menu browser lalu **Tambahkan ke layar utama** supaya seperti aplikasi.

### Mengubah nominal per hari

1. Di bagian atas ada kotak **Nominal menabung per hari (Rp)**.
2. Ketik angka (atau tap salah satu pilihan cepat), lalu **Simpan**.
3. Nominal baru dipakai untuk tanggal yang dicentang **setelah itu**. Tanggal yang sudah dicentang tetap memakai nominal lamanya, jadi total lama tidak berubah.
4. Berlaku untuk kalian berdua. Batas: bilangan bulat 1 sampai 100.000.000.

Untuk tanggal yang sudah dicentang tapi nominalnya mau diganti: batalkan tanggalnya (tap), ubah nominal, lalu centang lagi.

Catatan tampilan: angka di kotak tanggal diringkas kalau besar (misalnya `12,5rb`, `1,2jt`). Angka tepatnya ada di kotak **Bulan ini** dan **Total semua**, atau tekan lama / arahkan kursor ke tanggal.

---

## Mengubah pengaturan nanti

| Mau ubah | Caranya |
|---|---|
| Nama pengguna | Edit `USERS` di `wrangler.toml` di GitHub (data lama tetap aman, tapi tanggal yang sudah tercatat atas nama lama tetap tertulis nama lama) |
| Zona waktu | Edit `TIMEZONE`, contoh `Asia/Makassar` atau `Asia/Jayapura` |
| Kata sandi | Cloudflare → Settings → Variables and Secrets → edit `PASSCODE` |
| Paksa semua perangkat login ulang | Ganti nilai `SESSION_SECRET` |

Setelah edit di GitHub, tunggu sekitar satu menit sampai Cloudflare selesai deploy.

## Kalau ada masalah

- **Muncul tulisan "Secret PASSCODE / SESSION_SECRET belum diatur":** ulangi Langkah 5.
- **Muncul "Database D1 ... belum dipasang":** `database_id` di `wrangler.toml` belum benar (Langkah 3 nomor 5), lalu tunggu deploy ulang.
- **Deploy gagal di Cloudflare:** hampir selalu karena `database_id` masih `GANTI_DENGAN_DATABASE_ID`.
- **Tanggal bergeser sehari:** cek `TIMEZONE` di `wrangler.toml`.
- **Data pasangan telat muncul:** tarik layar ke bawah / buka ulang halaman, atau tunggu 15 detik.
- **Lupa kata sandi:** ganti `PASSCODE` di Cloudflare.

## Opsional: coba di komputer sendiri

Butuh Node.js.

```bash
npm install
# buat file .dev.vars berisi:
#   PASSCODE=rahasia
#   SESSION_SECRET=acak-panjang-apa-saja
npx wrangler dev
```

Buka alamat yang tampil di terminal. Untuk deploy lewat terminal tanpa GitHub: `npx wrangler login`, lalu `npx wrangler deploy`.
