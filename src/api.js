const express = require('express');
const router = express.Router();
const sessionManager = require('./sessionManager');
const db = require('./db');

// Middleware to check API key
async function requireApiKey(req, res, next) {
    let providedKey = req.headers['x-api-key'];
    
    // Dukung standar "Authorization: Bearer [TOKEN]"
    if (!providedKey && req.headers.authorization) {
        const parts = req.headers.authorization.split(' ');
        if (parts.length === 2 && parts[0] === 'Bearer') {
            providedKey = parts[1];
        }
    }

    if (!providedKey) {
        return res.status(401).json({ success: false, error: 'Missing Authentication Header (x-api-key or Bearer Token)' });
    }

    // First validate session existence to check device-specific key
    const { sessionId } = req.params;
    const session = sessionManager.getSession(sessionId);

    // If device-specific key exists, check that first
    if (session && session.apiKey) {
        if (providedKey === session.apiKey) {
            req.session = session; // attach session object early
            return next();
        }
    }
    
    // Fallback to global API key validation
    const validKey = await db.getApiKey();
    if (providedKey !== validKey) {
        return res.status(401).json({ success: false, error: 'Invalid API Key' });
    }
    
    // Validasi token API berhasil
    next();
}

// Middleware to validate session existence (runs after requireApiKey)
function requireSession(req, res, next) {
    // If early attached by requireApiKey, bypass
    if (req.session) {
        return next();
    }
    const { sessionId } = req.params;
    const session = sessionManager.getSession(sessionId);
    if (!session) {
        return res.status(404).json({ success: false, error: `Session with ID '${sessionId}' not found or not active.` });
    }
    req.session = session;
    next();
}

// 1. Endpoint: Mengirim Pesan Teks
router.post('/:sessionId/send-message', requireApiKey, requireSession, async (req, res) => {
    try {
        const { number, message, type } = req.body;
        if (!number || !message) {
            return res.status(400).json({ success: false, error: 'Missing number or message parameter' });
        }
        
        const result = await req.session.sendText(number, message, type);
        res.json({ success: true, message: 'Message sent successfully', result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. Endpoint: Mengirim Pesan Gambar (Image)
router.post('/:sessionId/send-image', requireApiKey, requireSession, async (req, res) => {
    try {
        const { number, image_url, caption, type } = req.body;
        if (!number || !image_url) {
            return res.status(400).json({ success: false, error: 'Missing number or image_url parameter' });
        }
        
        const result = await req.session.sendImage(number, image_url, caption || '', type);
        res.json({ success: true, message: 'Image sent successfully', result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Endpoint: Mengirim Dokumen/Berkas (PDF, DOCX, ZIP)
router.post('/:sessionId/send-document', requireApiKey, requireSession, async (req, res) => {
    try {
        const { number, document_url, filename, mimetype, type } = req.body;
        if (!number || !document_url) {
            return res.status(400).json({ success: false, error: 'Missing number or document_url parameter' });
        }
        
        const mime = mimetype || 'application/pdf';
        const name = filename || 'Document';
        
        const result = await req.session.sendDocument(number, document_url, name, mime, type);
        res.json({ success: true, message: 'Document sent successfully', result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;