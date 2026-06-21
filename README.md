# APIWA Gateway 🚀

A self-hosted, scalable, and professional WhatsApp API Gateway built on top of **Node.js** and the **[Baileys](https://github.com/WhiskeySockets/Baileys)** library. APIWA is designed with Clean Architecture to seamlessly and securely bridge your internal systems (PHP, Laravel, Python, etc.) with the Meta WhatsApp network.

## ✨ Features & Capabilities

### 1. 🛡️ Production-Ready Security & Architecture
- **Environment Variables (`.env`)**: Core configurations are strongly encapsulated safely outside the source code, making the app highly secure and ready for Cloud VPS hosting.
- **Clean & Modular Architecture**: Complex logic is neatly organized into specific, maintainable modules (`server.js`, `wa.js`, `sessionManager.js`, `queue.js`, `db.js`).
- **Persistent SQLite Storage**: API Keys, Webhook URLs, multi-session data, and WhatsApp LID-to-Phone mappings are safely stored in a local SQLite database, ensuring your vital configurations and contact mappings persist seamlessly across server restarts.

### 2. 📱 Multi-Session Node Management
- **Add Unlimited Devices**: Pair multiple WhatsApp accounts from a single gateway. Easily separate the workload for your "Sales", "Support", or "IT" numbers.
- **Auto-Boot Mappings**: Once a session is created and paired, the server will autonomously restore and reconnect every single device immediately upon booting.
- **Device-Specific Configurations (Multi-Tenant)**: 
  - Each WhatsApp node/session can optionally run with its own **Unique API Key** and point to its own **Unique Webhook URL**. 
  - If a device-specific configuration is not provided, the session will smoothly fall back to the **Global Integrations** configuration.

### 3. 💻 Modern Multi-Tenant Web Dashboard
- **Responsive "Card Grid" UI**: An elegant, responsive, and mobile-friendly Single Page Application (SPA) designed to monitor multiple device connection states at a glance.
- **Interactive API Tester (Playground)**: Features an integrated testing UI. Select any active session from the dropdown and simulate live HTTP requests (Text, Image, PDF) directly from your browser.
- **API Credentials Manager**: Generate "Global API Keys" or "Device-Specific API Keys" instantly to securely rotate your access tokens.
- **Inbound Webhook Config**: Seamlessly configure external Webhook URL endpoints for incoming messages via the graphical UI.

### 4. 🚀 Outbound REST API (Message Broadcasting)
*All `/api/v1/...` endpoints are protected by standard `x-api-key` or `Authorization: Bearer` HTTP Headers.*
- **URL Structure**: Requests now explicitly target a `sessionId` in the URL path (e.g., `POST /api/v1/:sessionId/send-message`).
- **Dual-Identifier Formatting Engine**: Automatically handles both standard Phone Numbers and WhatsApp LIDs (Linked IDs).
- **Send Text, Image, & Document**: Fully supports raw media uploads via Base64 or direct URL streaming.

### 5. 🪝 Advanced Inbound Webhook API (Real-Time Callback)
- **Instant HTTP POST Transfer**: Whenever a message is received on any connected node, the Node.js engine instantly fires it to your specified Webhook URL.
- **Session Tracking**: Webhook payloads are now enriched with `"sessionId"` and `"sessionName"` properties, making it effortless to identify which specific WhatsApp node received the incoming message.
- **Deep Meta Inspection**: Features Native Message Type detection, LID identification, standard phone number extraction (`phone`), and a complete delivery of `rawContext`.

### 6. ⏳ Smart Delay Queue (Anti-Banned Rate Limiter)
- **Isolated Rate Limiting**: Each Session Node operates its own independent `QueueManager`.
- **Fire-And-Forget Architecture**: Blast thousands of messages concurrently, and APIWA instantly responds with `{"status": "queued"}`. The system buffers queued messages and trickles them out at a highly disciplined rate (1 Message every 3 Seconds) per active session.

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
Open the newly created `.env` file using any text editor and change the default values:
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

### 6. Login & Pair Devices
1. Open your browser and go to `http://localhost:3000` (or your VPS IP).
2. Log in using the credentials you defined in `.env`.
3. In the "My Devices" tab, click **Add New Device**. 
4. Click **View QR Code** and scan it via the WhatsApp app on your phone.

---

## 📖 Integration Note: Using Only One Session
If you intend to use this system strictly as a single-number gateway (just one WhatsApp session), the integration methodology remains straightforward:

1. **API Key & Webhook**: You can completely ignore the "Device Configurations" (⚙️ icon) and strictly rely on the **Global API Key** and **Global Webhook** settings inside the "Keys & Webhooks" menu.
2. **Session ID Reference**: When making API POST requests, simply use the auto-generated `sessionId` (e.g., `wa-2272a36e`) in your HTTP client path: `POST /api/v1/wa-2272a36e/send-message`.
3. **Webhook Identification**: All inbound webhooks will be posted to your Global Webhook URL. You can ignore the `sessionId` attribute in the JSON payload since you know all traffic is originating from your single node.

---

## 📚 API Playground & Postman

APIWA's detailed developer documentation is available directly through the Dashboard UI! Once deployed, just click the **API Playground** tab to view endpoints, body schemas, and perform Live Simulation requests without moving to a different window.
👉 `http://localhost:3000`

We also provide a ready-to-use **Postman Collection** with Native Bearer Authentication enabled. Simply click "Postman Pack" from the playground page and import it into your Postman client. Don't forget to configure your API Key inside the Collection Variables tab!

---
*Built for maximum stability, high execution speed, and unparalleled architectural cleanliness.* 🛡️
