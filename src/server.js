const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const cookieParser = require('cookie-parser');
const waManager = require('./wa');
const db = require('./db');
const apiRouter = require('./api');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// Konfigurasi Login Default
const DEFAULT_USER = process.env.DASHBOARD_USER || 'admin';
const DEFAULT_PASS = process.env.DASHBOARD_PASS || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'wabot-secret-key-123';

// Middleware Autentikasi untuk Web Dashboard
function authMiddleware(req, res, next) {
    // PENTING: Biarkan jalur khusus `x-api-key` dari Postman/layanan luar menembus pertahanan Cookie Dashboard
    if (req.path.startsWith('/api/v1')) {
        return next();
    }

    // Biarkan akses file css/js publik dan halaman login tanpa di-block
    if (req.path.startsWith('/assets') || req.path === '/login' || req.path === '/api/login') {
        return next();
    }
    
    // Cek Cookie
    if (req.cookies.wabot_auth === SESSION_SECRET) {
        return next();
    }
    
    // Jika akses API, kembalikan 401
    if (req.path.startsWith('/api')) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    // Jika akses halaman, redirect ke login
    res.redirect('/login');
}

// Terapkan middleware global
app.use(authMiddleware);

// Static Routing untuk file public 
// (dilakukan setelah middleware agar index terlindungi)
app.use(express.static(path.join(__dirname, '../public')));

// Sub-Router untuk API WhatsApp Gateway yang diproteksi `x-api-key`
app.use('/api/v1', apiRouter);

// Routing Halaman Login
app.get('/login', (req, res) => {
    // Jika sudah login, lempar kembali ke dashboard
    if (req.cookies.wabot_auth === SESSION_SECRET) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, '../public/login.html'));
});

// Routing Dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// API Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    if (username === DEFAULT_USER && password === DEFAULT_PASS) {
        // Set cookie berumur 1 hari
        res.cookie('wabot_auth', SESSION_SECRET, { maxAge: 24 * 60 * 60 * 1000, httpOnly: true });
        res.json({ success: true, message: 'Login successful' });
    } else {
        res.status(401).json({ success: false, error: 'Username atau password salah!' });
    }
});

// Endpoint: Dapatkan Status Koneksi Bot
app.get('/api/status', (req, res) => {
    res.json({
        status: waManager.status,
    });
});

// Endpoint: Dapatkan Gambar QR Code Base64
app.get('/api/qr', async (req, res) => {
    if (waManager.status === 'WAITING_QR' && waManager.qrCode) {
        try {
            const qrDataURL = await QRCode.toDataURL(waManager.qrCode);
            res.json({ success: true, qrcode: qrDataURL });
        } catch (err) {
            res.status(500).json({ success: false, error: 'Failed to generate QR Code image' });
        }
    } else {
        res.status(400).json({ success: false, error: 'QR Code is not available or bot is already connected' });
    }
});

// Endpoint: Reset/Logout Session WA
app.post('/api/logout', (req, res) => {
    waManager.logout();
    res.json({ success: true, message: 'Session deleted. The bot is restarting to generate a new QR Code.' });
});

// Endpoint: Logout Dashboard
app.post('/api/logout-dashboard', (req, res) => {
    res.clearCookie('wabot_auth');
    res.json({ success: true });
});

// Endpoint: Dapatkan API Key
app.get('/api/get-key', async (req, res) => {
    try {
        const key = await db.getApiKey();
        res.json({ success: true, key: key || 'NO_KEY_GENERATED_YET' });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Failed to fetch API Key' });
    }
});

// Endpoint: Generate API Key Baru
app.post('/api/generate-key', async (req, res) => {
    try {
        const newKey = await db.generateApiKey();
        res.json({ success: true, key: newKey });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Failed to generate API Key' });
    }
});

// Endpoint: Dapatkan Webhook URL
app.get('/api/get-webhook', async (req, res) => {
    try {
        const url = await db.getWebhookUrl();
        res.json({ success: true, url: url || '' });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Failed to fetch Webhook URL' });
    }
});

// Endpoint: Simpan Webhook URL
app.post('/api/set-webhook', async (req, res) => {
    try {
        const { url } = req.body;
        await db.setWebhookUrl(url);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Failed to set Webhook URL' });
    }
});

function startServer(port = process.env.PORT || 3000) {
    app.listen(port, () => {
        console.log(`Server API & Web Dashboard is running on http://localhost:${port}`);
    });
}

module.exports = { startServer, app };
