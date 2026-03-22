# APIWA Gateway 🚀

A self-hosted, scalable, and professional WhatsApp API Gateway built on top of **Node.js** and the **[Baileys](https://github.com/WhiskeySockets/Baileys)** library. APIWA is designed with Clean Architecture to seamlessly and securely bridge your internal systems (PHP, Laravel, Python, etc.) with the Meta WhatsApp network.


## ✨ Features & Capabilities

### 1. 🛡️ Production-Ready Security & Architecture
- **Environment Variables (`.env`)**: Core configurations are strongly encapsulated safely outside the source code, making the app highly secure and ready for Cloud VPS hosting.
- **Clean & Modular Architecture**: Complex logic is neatly organized into specific, maintainable modules (`server.js`, `wa.js`, `queue.js`, `db.js`).
- **Persistent SQLite Storage**: API Keys and Webhook URLs are safely stored in a local SQLite database, ensuring your vital configurations persist seamlessly across server restarts.

### 2. 💻 Minimal Tailwind CSS Web Dashboard
- **Interactive API Tester (Playground)**: Features an integrated testing UI with auto-filled mock payloads! You can simulate live HTTP requests (Text, Image, PDF) directly from your browser sidebar to your core WA engine and catch real-time JSON responses.
- **Secure Control Panel**: An elegant, responsive, and password-protected Single Page Application (SPA) built using pure Tailwind CSS and secured by encrypted Session Cookies.
- **Real-Time Status Monitor**: Visual indicators (Connecting, Waiting for QR, Connected) that update live.
- **Built-in QR Scanner**: Pair your WhatsApp account (Linked Devices) by scanning the QR code directly from the web UI.
- **API Credentials Manager**: Features a "1-Click Generate New Key" button to instantly rotate and revoke your secret API Token.
- **Inbound Webhook Config**: Seamlessly configure or disable your external Webhook URL endpoint for incoming messages via the graphical UI.

### 3. 🚀 Outbound REST API (Message Broadcasting)
*All `/api/v1/...` endpoints are strictly protected by standard `x-api-key` or `Authorization: Bearer` HTTP Headers.*
- **Dual-Identifier Formatting Engine**: The core engine automatically handles both standard **Phone Numbers** and WhatsApp **LIDs (Linked IDs)**.
  - **Phone Numbers**: Automatically scrubs and converts local formats (e.g., `0812...` or `62812...`) to Meta's strict JID standard (`62812...@s.whatsapp.net`).
  - **LIDs (Linked IDs)**: Supports new Android-based LIDs (e.g., `708...`) by passing an optional `type: "lid"` parameter in the request body.
- **Send Text**: Seamlessly broadcast standard string notifications.
- **Send Image (URL & Base64)**: Send images via public URLs or auto-decode long *Base64 String payloads* to reconstruct media files on-the-fly.
- **Send Document**: Send digital documents (PDFs, Word files, ZIPs) with full filename customization.

### 4. 🪝 Advanced Inbound Webhook API (Real-Time Callback)
- **Instant HTTP POST Transfer**: Whenever a message is received, the Node.js engine instantly packages the data and fires it to your external Company Backend via an Enterprise JSON Webhook POST payload.
- **Deep Meta Inspection**: Features Native Message Type detection (`type`: text, image, document), Android/iOS grouping (`device`), LID identification (`isLidBased`), and a complete delivery of `rawContext` Baileys buffer for advanced parsing.
- Perfect for building **Auto-Reply Customer Service**, Billing Validations, or **ChatGPT-powered AI Bots**.

### 5. ⏳ Smart Delay Queue (Anti-Banned Rate Limiter)
- **Fire-And-Forget Architecture**: Blast 1,000 promotional messages concurrently via Postman/PHP, and APIWA instantly responds with `{"status": "queued"}` without freezing your application's loading screen.
- **Background Interval Limiter**: APIWA buffers queued messages and trickles them out to Meta's servers at a highly disciplined rate of **1 Message every 3 Seconds**. This acts as an umbrella to protect your Company Number from being flagged as Spam.

---

## 🛠️ Installation & Server Setup

### 1. System Requirements
- **Node.js**: v18 or v20 (LTS Recommended)
- NPM or Yarn installed

### 2. Clone Repository
```bash
git clone https://github.com/yourusername/apiwa.git
cd apiwa
```

### 3. Install Dependencies
```bash
npm install
```

### 4. Environment Configuration
Copy the `.env.example` file to create your own configuration:
```bash
cp .env.example .env
```
Open the newly created `.env` file using any text editor and change the default values. This is where you configure your dynamic variables (Username, Password, and Port):
```env
# Server Configuration
PORT=3000

# Dashboard Login Credentials
DASHBOARD_USER=myusername
DASHBOARD_PASS=mypassword123

# Cookie Session Secret (Change this string!)
SESSION_SECRET=super-secret-key-apiwa-2026
```

### 5. Start the Server
```bash
npm start
# Expected Output: Server API & Web Dashboard is running on http://localhost:3000
```
*(For production VPS, it is recommended to use PM2: `pm2 start index.js --name apiwa`)*

### 6. Login & Pair WhatsApp
1. Open your browser and go to `http://localhost:3000` (or your VPS IP).
2. Log in using the credentials you defined in `.env`.
3. Go to WhatsApp on your phone (Linked Devices) and scan the **QR Code** displayed on the Dashboard until the status turns to **Connected**.

---

## 📚 API Playground & Postman

APIWA's detailed developer documentation is available directly through the Dashboard UI! Once deployed, just click the **API Playground** tab to view endpoints, body schemas, and perform Live Simulation requests without moving to a different window.
👉 `http://localhost:3000`

We also provide a ready-to-use **Postman Collection** with Native Bearer Authentication enabled. Simply click "Postman Pack" from the playground page and import it into your Postman client. Don't forget to configure your API Key inside the Collection Variables tab!

---
*Built for maximum stability, high execution speed, and unparalleled architectural cleanliness.* 🛡️
