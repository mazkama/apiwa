const express = require('express');
const router = express.Router();
const waManager = require('./wa');
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
    
    const validKey = await db.getApiKey();
    if (providedKey !== validKey) {
        return res.status(401).json({ success: false, error: 'Invalid API Key' });
    }
    
    // Validasi token API berhasil
    next();
}

// 1. Endpoint: Mengirim Pesan Teks
router.post('/send-message', requireApiKey, async (req, res) => {
    try {
        const { number, message, type } = req.body;
        if (!number || !message) {
            return res.status(400).json({ success: false, error: 'Missing number or message parameter' });
        }
        
        const result = await waManager.sendText(number, message, type || 'number');
        res.json({ success: true, message: 'Message sent successfully', result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. Endpoint: Mengirim Pesan Gambar (Image)
router.post('/send-image', requireApiKey, async (req, res) => {
    try {
        const { number, image_url, caption, type } = req.body;
        if (!number || !image_url) {
            return res.status(400).json({ success: false, error: 'Missing number or image_url parameter' });
        }
        
        const result = await waManager.sendImage(number, image_url, caption || '', type || 'number');
        res.json({ success: true, message: 'Image sent successfully', result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Endpoint: Mengirim Dokumen/Berkas (PDF, DOCX, ZIP)
router.post('/send-document', requireApiKey, async (req, res) => {
    try {
        const { number, document_url, filename, mimetype, type } = req.body;
        if (!number || !document_url) {
            return res.status(400).json({ success: false, error: 'Missing number or document_url parameter' });
        }
        
        const mime = mimetype || 'application/pdf';
        const name = filename || 'Document';
        
        const result = await waManager.sendDocument(number, document_url, name, mime, type || 'number');
        res.json({ success: true, message: 'Document sent successfully', result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
