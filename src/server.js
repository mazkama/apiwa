const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const cookieParser = require('cookie-parser');
const sessionManager = require('./sessionManager');
const db = require('./db');
const apiRouter = require('./api');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Broadcast WA Status to all connected Dashboard users via WebSocket
sessionManager.on('statusUpdate', (data) => {
    io.emit('statusUpdate', data);
});

io.on('connection', (socket) => {
    // Kirim status awal untuk semua sesi yang sedang aktif
    socket.emit('initialSessions', sessionManager.getAllSessions());
});

app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// Konfigurasi Login Default
const DEFAULT_USER = process.env.DASHBOARD_USER || 'admin';
const DEFAULT_PASS = process.env.DASHBOARD_PASS || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'wabot-secret-key-123';

// Middleware Autentikasi untuk Web Dashboard
function authMiddleware(req, res, next) {
    if (req.path.startsWith('/api/v1')) {
        return next();
    }

    if (req.path.startsWith('/assets') || req.path === '/login' || req.path === '/api/login') {
        return next();
    }
    
    if (req.cookies.wabot_auth === SESSION_SECRET) {
        return next();
    }
    
    if (req.path.startsWith('/api')) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    res.redirect('/login');
}

app.use(authMiddleware);

app.use(express.static(path.join(__dirname, '../public')));

app.use('/api/v1', apiRouter);

// Routing Halaman Login
app.get('/login', (req, res) => {
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
        res.cookie('wabot_auth', SESSION_SECRET, { maxAge: 24 * 60 * 60 * 1000, httpOnly: true });
        res.json({ success: true, message: 'Login successful' });
    } else {
        res.status(401).json({ success: false, error: 'Username atau password salah!' });
    }
});

// Endpoint: List all sessions
app.get('/api/sessions', (req, res) => {
    res.json({ success: true, sessions: sessionManager.getAllSessions() });
});

// Endpoint: Create a new session
app.post('/api/sessions', async (req, res) => {
    try {
        const { sessionId, sessionName } = req.body;
        if (!sessionId) {
            return res.status(400).json({ success: false, error: 'Missing sessionId parameter' });
        }
        const manager = await sessionManager.createSession(sessionId, sessionName || sessionId);
        res.json({
            success: true,
            session: {
                id: manager.sessionId,
                name: manager.sessionName,
                status: manager.status,
                qrCode: manager.qrCode,
                webhookUrl: manager.webhookUrl,
                apiKey: manager.apiKey
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint: Update session-specific settings
app.post('/api/sessions/:sessionId/settings', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { webhookUrl, apiKey } = req.body;
        const manager = sessionManager.getSession(sessionId);
        if (!manager) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        manager.webhookUrl = webhookUrl || null;
        manager.apiKey = apiKey || null;

        await db.updateSessionSettings(sessionId, webhookUrl, apiKey);
        res.json({ success: true, message: 'Device node settings successfully updated.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint: Delete a session
app.delete('/api/sessions/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        await sessionManager.deleteSession(sessionId);
        res.json({ success: true, message: `Session ${sessionId} deleted.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint: Get QR Code Image for a session
app.get('/api/qr/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const manager = sessionManager.getSession(sessionId);
    
    if (!manager) {
        return res.status(404).json({ success: false, error: 'Session not found' });
    }

    if (manager.status === 'WAITING_QR' && manager.qrCode) {
        try {
            const qrDataURL = await QRCode.toDataURL(manager.qrCode);
            const img = Buffer.from(qrDataURL.split(',')[1], 'base64');
            res.writeHead(200, {
                'Content-Type': 'image/png',
                'Content-Length': img.length
            });
            res.end(img);
        } catch (err) {
            res.status(500).json({ success: false, error: 'Failed to generate QR Code image' });
        }
    } else {
        res.status(400).json({ success: false, error: 'QR Code is not available or bot is already connected' });
    }
});

// Endpoint: Reset/Logout Session WA
app.post('/api/logout/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const manager = sessionManager.getSession(sessionId);
    if (!manager) {
        return res.status(404).json({ success: false, error: 'Session not found' });
    }
    manager.logout();
    res.json({ success: true, message: 'Session reset initiated.' });
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
    server.listen(port, async () => {
        console.log(`Server API & Web Dashboard is running on http://localhost:${port}`);
        // Initialize sessions from Database
        await sessionManager.init();
    });
}

module.exports = { startServer, app };