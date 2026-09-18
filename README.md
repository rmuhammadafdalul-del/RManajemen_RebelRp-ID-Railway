# RManajemen_RebelRp — Discord Multi-Ticket Bot

Versi ID-based untuk GitHub + Railway. Kategori, channel, dan staff menggunakan Discord ID agar tiket tidak salah masuk kategori.

## Fitur
- 🎫 Multi-ticket
- 📢 Report
- 📝 Formulir
- 💰 Donasi + bukti pembayaran
- 👮 Staff Confirm / Reject
- ⏰ Donasi auto-delete
- 📁 Tiket otomatis masuk ke kategori berdasarkan ID
- 🛠️ `/setup` untuk menyiapkan `create-ticket` dan memasang panel
- 👋 Welcome / Goodbye
- 🎭 Self-role
- 💾 SQLite

## Railway Variables
```env
DISCORD_TOKEN=TOKEN_BOT_KAMU
CLIENT_ID=CLIENT_ID_BOT
GUILD_ID=ID_SERVER_DISCORD
STAFF_ROLE_ID=ID_ROLE_STAFF
SUPPORT_CATEGORY_ID=ID_KATEGORI_SUPPORT
CREATE_TICKET_CHANNEL_ID=ID_CHANNEL_CREATE_TICKET
DONATION_CATEGORY_ID=ID_KATEGORI_DONASI
REPORT_CATEGORY_ID=ID_KATEGORI_REPORT
FORM_CATEGORY_ID=ID_KATEGORI_FORMULIR
LOG_CHANNEL_ID=ID_CHANNEL_LOG
DONATION_TIMEOUT_HOURS=24
WELCOME_CHANNEL_ID=ID_CHANNEL_WELCOME
GOODBYE_CHANNEL_ID=ID_CHANNEL_GOODBYE
WELCOME_IMAGE_URL=
GOODBYE_IMAGE_URL=
WELCOME_MESSAGE=Selamat datang {user} di server!
GOODBYE_MESSAGE=See you {user}, semoga sukses!
ROLE_PANEL_CHANNEL_ID=ID_CHANNEL_AMBIL_ROLE
ROLE_BUTTONS=Announcement|ID_ROLE_ANNOUNCEMENT|📢,Giveaway|ID_ROLE_GIVEAWAY|🎁,Partner|ID_ROLE_PARTNER|🤝
```

## Setup create-ticket
1. Isi `SUPPORT_CATEGORY_ID` dengan ID kategori SUPPORT.
2. Jika `CREATE_TICKET_CHANNEL_ID` diisi, bot akan memakai channel itu dan memastikan parent-nya adalah `SUPPORT_CATEGORY_ID`.
3. Jika `CREATE_TICKET_CHANNEL_ID` dikosongkan, isi `CREATE_TICKET_CHANNEL_NAME` (default `create-ticket`). Jalankan `/setup`; bot akan membuat channel tersebut di kategori SUPPORT dan memasang panel.
4. Untuk tiket, isi `DONATION_CATEGORY_ID`, `REPORT_CATEGORY_ID`, dan `FORM_CATEGORY_ID`.

## Penting
- Semua ID harus ID Discord asli, bukan nama.
- Bot membutuhkan **Manage Channels**, **Manage Roles**, dan izin pesan yang sesuai.
- Role bot harus berada di atas `STAFF_ROLE_ID` bila perlu mengelola permission role tersebut.
- Aktifkan **Server Members Intent** untuk Welcome/Goodbye.
- Jangan masukkan token ke GitHub.
