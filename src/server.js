const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
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
    // Send initial active sessions
    socket.emit('initialSessions', sessionManager.getAllSessions());
});

app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configuration
const DEFAULT_USER = process.env.DASHBOARD_USER || 'admin';
const DEFAULT_PASS = process.env.DASHBOARD_PASS || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'wabot-secret-key-123';

// Authentication Middleware for Dashboard & Internal APIs
function authMiddleware(req, res, next) {
    if (req.path.startsWith('/api/v1')) {
        return next();
    }

    if (req.path.startsWith('/assets') || req.path === '/login' || req.path === '/api/login' || req.path === '/api/export-postman') {
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

// Logout Dashboard
app.post('/api/logout-dashboard', (req, res) => {
    res.clearCookie('wabot_auth');
    res.json({ success: true });
});

// --- Session Lifecycle Management ---

// List all sessions
app.get('/api/sessions', (req, res) => {
    res.json({ success: true, sessions: sessionManager.getAllSessions() });
});

// Create a new session
app.post('/api/sessions', async (req, res) => {
    try {
        const { sessionId, sessionName } = req.body;
        if (!sessionId) {
            return res.status(400).json({ success: false, error: 'Missing sessionId parameter' });
        }
        const manager = await sessionManager.createSession(sessionId, sessionName || sessionId, true);
        res.json({
            success: true,
            session: {
                id: manager.sessionId,
                name: manager.sessionName,
                status: manager.status,
                isActive: manager.isActive,
                phoneNumber: manager.phoneNumber,
                pushName: manager.pushName,
                qrCode: manager.qrCode,
                webhookUrl: manager.webhookUrl,
                webhookSecret: manager.webhookSecret,
                webhookEvents: manager.webhookEvents,
                apiKey: manager.apiKey
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Pause Session (Disconnect without deleting auth)
app.post('/api/sessions/:sessionId/pause', async (req, res) => {
    try {
        const { sessionId } = req.params;
        await sessionManager.pauseSession(sessionId);
        res.json({ success: true, message: `Session ${sessionId} paused.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Resume Session
app.post('/api/sessions/:sessionId/resume', async (req, res) => {
    try {
        const { sessionId } = req.params;
        await sessionManager.resumeSession(sessionId);
        res.json({ success: true, message: `Session ${sessionId} resumed.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Force Manual Reconnect
app.post('/api/sessions/:sessionId/reconnect', async (req, res) => {
    try {
        const { sessionId } = req.params;
        await sessionManager.reconnectSession(sessionId);
        res.json({ success: true, message: `Session ${sessionId} reconnect triggered.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Update Session Settings (Webhook, Secret, Events, API Key)
app.post('/api/sessions/:sessionId/settings', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { webhookUrl, webhookSecret, webhookEvents, apiKey } = req.body;
        const manager = sessionManager.getSession(sessionId);
        if (!manager) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        manager.webhookUrl = webhookUrl || null;
        manager.webhookSecret = webhookSecret || null;
        if (webhookEvents) manager.webhookEvents = Array.isArray(webhookEvents) ? webhookEvents : [webhookEvents];
        manager.apiKey = apiKey || manager.apiKey;

        await db.updateSessionSettings(sessionId, {
            webhookUrl: manager.webhookUrl,
            webhookSecret: manager.webhookSecret,
            webhookEvents: manager.webhookEvents,
            apiKey: manager.apiKey
        });

        res.json({ success: true, message: 'Session settings updated successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// Regenerate Session API Key
app.post("/api/sessions/:sessionId/regenerate-key", async (req, res) => {
    try {
        const { sessionId } = req.params;
        const manager = sessionManager.getSession(sessionId);
        if (!manager) {
            return res.status(404).json({ success: false, error: "Session not found" });
        }

        const newApiKey = db.generateRandomToken("wa_");
        manager.apiKey = newApiKey;

        await db.updateSessionSettings(sessionId, {
            webhookUrl: manager.webhookUrl,
            webhookSecret: manager.webhookSecret,
            webhookEvents: manager.webhookEvents,
            apiKey: newApiKey
        });

        res.json({ success: true, apiKey: newApiKey, message: "New API Key generated successfully." });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Regenerate Webhook Secret
app.post("/api/sessions/:sessionId/regenerate-secret", async (req, res) => {
    try {
        const { sessionId } = req.params;
        const manager = sessionManager.getSession(sessionId);
        if (!manager) {
            return res.status(404).json({ success: false, error: "Session not found" });
        }

        const newSecret = db.generateRandomToken("sec_");
        manager.webhookSecret = newSecret;

        await db.updateSessionSettings(sessionId, {
            webhookUrl: manager.webhookUrl,
            webhookSecret: newSecret,
            webhookEvents: manager.webhookEvents,
            apiKey: manager.apiKey
        });

        res.json({ success: true, webhookSecret: newSecret, message: "New Webhook Secret generated successfully." });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Test Webhook Dispatch (Ping simulator)
app.post('/api/sessions/:sessionId/webhook/test', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const manager = sessionManager.getSession(sessionId);
        if (!manager) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        if (!manager.webhookUrl) {
            return res.status(400).json({ success: false, error: 'No webhook URL configured for this session.' });
        }

        const testPayload = {
            event: 'webhook.test',
            sessionId: manager.sessionId,
            sessionName: manager.sessionName,
            timestamp: Date.now(),
            data: {
                message: 'Hello! This is a simulated ping test from APIWA Gateway.',
                ping: 'pong'
            }
        };

        const startTime = Date.now();
        const result = await manager.dispatchWebhook(testPayload);
        const duration = Date.now() - startTime;

        res.json({
            success: true,
            status: result.status,
            durationMs: duration,
            message: `Webhook received HTTP ${result.status} in ${duration}ms`
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Delete a session
app.delete('/api/sessions/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        await sessionManager.deleteSession(sessionId);
        res.json({ success: true, message: `Session ${sessionId} deleted.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get QR Code Image for a session
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

// Reset/Logout Session WA
app.post('/api/logout/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const manager = sessionManager.getSession(sessionId);
    if (!manager) {
        return res.status(404).json({ success: false, error: 'Session not found' });
    }
    manager.logout();
    res.json({ success: true, message: 'Session reset initiated.' });
});

// --- Master API Key & Logs ---

app.get('/api/master-key', async (req, res) => {
    try {
        let key = await db.getMasterApiKey();
        if (!key) {
            key = await db.generateMasterApiKey();
        }
        res.json({ success: true, masterApiKey: key });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/generate-master-key', async (req, res) => {
    try {
        const key = await db.generateMasterApiKey();
        res.json({ success: true, masterApiKey: key });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Outbox / Message Logs
app.get('/api/logs', async (req, res) => {
    try {
        const { sessionId, limit, offset } = req.query;
        const logs = await db.getMessageLogs(sessionId || null, parseInt(limit) || 50, parseInt(offset) || 0);
        res.json({ success: true, logs });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/logs', async (req, res) => {
    try {
        const { sessionId } = req.query;
        await db.clearMessageLogs(sessionId || null);
        res.json({ success: true, message: 'Message logs cleared.' });

// Webhook Delivery Logs
app.get('/api/webhook-logs', async (req, res) => {
    try {
        const { sessionId, limit, offset } = req.query;
        const logs = await db.getWebhookLogs(sessionId || null, parseInt(limit) || 50, parseInt(offset) || 0);
        res.json({ success: true, logs });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/webhook-logs', async (req, res) => {
    try {
        const { sessionId } = req.query;
        await db.clearWebhookLogs(sessionId || null);
        res.json({ success: true, message: 'Webhook logs cleared.' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- Dynamic Postman Collection Exporter ---

app.get('/api/export-postman', async (req, res) => {
    try {
        const { sessionId } = req.query;
        const host = `${req.protocol}://${req.get('host')}`;
        
        let targetSessionId = '{{session_id}}';
        let targetApiKey = '{{api_key}}';

        if (sessionId) {
            const manager = sessionManager.getSession(sessionId);
            if (manager) {
                targetSessionId = manager.sessionId;
                targetApiKey = manager.apiKey || '{{api_key}}';
            }
        }

        const postmanCollection = {
            info: {
                name: `APIWA Gateway${sessionId ? ` [${sessionId}]` : ''}`,
                description: 'Professional Multi-Session WhatsApp Gateway API Collection with Bearer Auth.',
                schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
            },
            auth: {
                type: 'bearer',
                bearer: [
                    {
                        key: 'token',
                        value: targetApiKey,
                        type: 'string'
                    }
                ]
            },
            item: [
                {
                    name: '0. Check Number on WhatsApp',
                    request: {
                        method: 'POST',
                        header: [{ key: 'Content-Type', value: 'application/json' }],
                        body: {
                            mode: 'raw',
                            raw: JSON.stringify({ number: '08123456789' }, null, 2)
                        },
                        url: {
                            raw: `${host}/api/v1/${targetSessionId}/check-number`,
                            protocol: host.split('://')[0],
                            host: host.split('://')[1].split('/')[0].split(':'),
                            path: ['api', 'v1', targetSessionId, 'check-number']
                        }
                    }
                },
                {
                    name: '1. Send Text Message',
                    request: {
                        method: 'POST',
                        header: [{ key: 'Content-Type', value: 'application/json' }],
                        body: {
                            mode: 'raw',
                            raw: JSON.stringify({ number: '08123456789', message: 'Halo! Ini notifikasi teks resmi dari APIWA Gateway.' }, null, 2)
                        },
                        url: {
                            raw: `${host}/api/v1/${targetSessionId}/send-message`,
                            protocol: host.split('://')[0],
                            host: host.split('://')[1].split('/')[0].split(':'),
                            path: ['api', 'v1', targetSessionId, 'send-message']
                        }
                    }
                },
                {
                    name: '2. Send Image (URL)',
                    request: {
                        method: 'POST',
                        header: [{ key: 'Content-Type', value: 'application/json' }],
                        body: {
                            mode: 'raw',
                            raw: JSON.stringify({
                                number: '08123456789',
                                image_url: 'https://images.unsplash.com/photo-1541963463532-d68292c34b19',
                                caption: 'Caption foto menarik dari APIWA Gateway'
                            }, null, 2)
                        },
                        url: {
                            raw: `${host}/api/v1/${targetSessionId}/send-image`,
                            protocol: host.split('://')[0],
                            host: host.split('://')[1].split('/')[0].split(':'),
                            path: ['api', 'v1', targetSessionId, 'send-image']
                        }
                    }
                },
                {
                    name: '3. Send Document (PDF/Docx)',
                    request: {
                        method: 'POST',
                        header: [{ key: 'Content-Type', value: 'application/json' }],
                        body: {
                            mode: 'raw',
                            raw: JSON.stringify({
                                number: '08123456789',
                                document_url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
                                filename: 'Invoice-APIWA.pdf',
                                mimetype: 'application/pdf'
                            }, null, 2)
                        },
                        url: {
                            raw: `${host}/api/v1/${targetSessionId}/send-document`,
                            protocol: host.split('://')[0],
                            host: host.split('://')[1].split('/')[0].split(':'),
                            path: ['api', 'v1', targetSessionId, 'send-document']
                        }
                    }
                },
                {
                    name: '4. Send Voice Note (PTT)',
                    request: {
                        method: 'POST',
                        header: [{ key: 'Content-Type', value: 'application/json' }],
                        body: {
                            mode: 'raw',
                            raw: JSON.stringify({
                                number: '08123456789',
                                audio_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
                                ptt: true
                            }, null, 2)
                        },
                        url: {
                            raw: `${host}/api/v1/${targetSessionId}/send-voice`,
                            protocol: host.split('://')[0],
                            host: host.split('://')[1].split('/')[0].split(':'),
                            path: ['api', 'v1', targetSessionId, 'send-voice']
                        }
                    }
                },
                {
                    name: '5. Send Video (MP4)',
                    request: {
                        method: 'POST',
                        header: [{ key: 'Content-Type', value: 'application/json' }],
                        body: {
                            mode: 'raw',
                            raw: JSON.stringify({
                                number: '08123456789',
                                video_url: 'https://www.w3schools.com/html/mov_bbb.mp4',
                                caption: 'Video promosi APIWA'
                            }, null, 2)
                        },
                        url: {
                            raw: `${host}/api/v1/${targetSessionId}/send-video`,
                            protocol: host.split('://')[0],
                            host: host.split('://')[1].split('/')[0].split(':'),
                            path: ['api', 'v1', targetSessionId, 'send-video']
                        }
                    }
                }
            ],
            variable: [
                { key: 'base_url', value: host, type: 'string' },
                { key: 'session_id', value: targetSessionId, type: 'string' },
                { key: 'api_key', value: targetApiKey, type: 'string' }
            ]
        };

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="APIWA_Postman_${sessionId || 'Collection'}.json"`);
        res.send(JSON.stringify(postmanCollection, null, 2));
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

function startServer(port = process.env.PORT || 3000) {
    server.listen(port, async () => {
        console.log(`Server API & Web Dashboard is running on http://localhost:${port}`);
        await sessionManager.init();
    });
}

module.exports = { startServer, app };
