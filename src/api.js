const express = require('express');
const router = express.Router();
const sessionManager = require('./sessionManager');
const db = require('./db');

// Middleware to check API key (Session-specific or Master API Key)
async function requireApiKey(req, res, next) {
    let providedKey = req.headers['x-api-key'];
    
    // Support "Authorization: Bearer <token>"
    if (!providedKey && req.headers.authorization) {
        const parts = req.headers.authorization.split(' ');
        if (parts.length === 2 && parts[0] === 'Bearer') {
            providedKey = parts[1];
        }
    }

    if (!providedKey) {
        return res.status(401).json({ success: false, error: 'Missing Authentication Header (x-api-key or Bearer Token)' });
    }

    const { sessionId } = req.params;
    const session = sessionManager.getSession(sessionId);

    // 1. Validate against Session-specific API Key
    if (session && session.apiKey) {
        if (providedKey === session.apiKey) {
            req.session = session;
            return next();
        }
    }
    
    // 2. Validate against Master Admin API Key
    const masterKey = await db.getMasterApiKey();
    if (masterKey && providedKey === masterKey) {
        if (session) req.session = session;
        return next();
    }
    
    return res.status(401).json({ success: false, error: 'Invalid API Key for this WhatsApp session' });
}

// Middleware to validate session existence and active status
function requireSession(req, res, next) {
    if (req.session) {
        if (req.session.status !== 'CONNECTED') {
            return res.status(400).json({ 
                success: false, 
                error: `Session '${req.params.sessionId}' is not connected (Status: ${req.session.status})` 
            });
        }
        return next();
    }
    
    const { sessionId } = req.params;
    const session = sessionManager.getSession(sessionId);
    if (!session) {
        return res.status(404).json({ success: false, error: `Session with ID '${sessionId}' not found.` });
    }
    
    if (session.status !== 'CONNECTED') {
        return res.status(400).json({ 
            success: false, 
            error: `Session '${sessionId}' is not connected (Status: ${session.status})` 
        });
    }

    req.session = session;
    next();
}

// 1. Endpoint: Check Number Registered on WhatsApp (is-on-whatsapp)
router.post('/:sessionId/check-number', requireApiKey, requireSession, async (req, res) => {
    try {
        const { number } = req.body;
        if (!number) {
            return res.status(400).json({ success: false, error: 'Missing number parameter' });
        }
        
        const result = await req.session.checkNumber(number);
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. Endpoint: Send Text Message
router.post('/:sessionId/send-message', requireApiKey, requireSession, async (req, res) => {
    try {
        const { number, message, type } = req.body;
        if (!number || !message) {
            return res.status(400).json({ success: false, error: 'Missing number or message parameter' });
        }
        
        const logId = require('crypto').randomUUID();
        await db.saveMessageLog({
            id: logId,
            sessionId: req.session.sessionId,
            type: 'text',
            recipient: req.body.number,
            payloadPreview: message.substring(0, 150),
            status: 'queued'
        });
        const result = await req.session.sendText(number, message, type, logId);

        res.json({ success: true, message: 'Message queued for delivery', result });
    } catch (err) {
        await db.saveMessageLog({
            sessionId: req.params.sessionId,
            type: 'text',
            recipient: req.body.number || 'unknown',
            payloadPreview: (req.body.message || '').substring(0, 150),
            status: 'failed',
            errorMessage: err.message
        }).catch(() => {});

        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Endpoint: Send Image Message
router.post('/:sessionId/send-image', requireApiKey, requireSession, async (req, res) => {
    try {
        const { number, image_url, caption, type } = req.body;
        if (!number || !image_url) {
            return res.status(400).json({ success: false, error: 'Missing number or image_url parameter' });
        }
        
        const logId = require('crypto').randomUUID();
        await db.saveMessageLog({
            id: logId,
            sessionId: req.session.sessionId,
            type: 'image',
            recipient: req.body.number,
            payloadPreview: caption || '[Image Attachment]',
            status: 'queued'
        });
        const result = await req.session.sendImage(number, image_url, caption || '', type, logId);

        res.json({ success: true, message: 'Image queued for delivery', result });
    } catch (err) {
        await db.saveMessageLog({
            sessionId: req.params.sessionId,
            type: 'image',
            recipient: req.body.number || 'unknown',
            payloadPreview: req.body.caption || '[Image Attachment]',
            status: 'failed',
            errorMessage: err.message
        }).catch(() => {});

        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Endpoint: Send Document Message (PDF, DOCX, ZIP)
router.post('/:sessionId/send-document', requireApiKey, requireSession, async (req, res) => {
    try {
        const { number, document_url, filename, mimetype, type } = req.body;
        if (!number || !document_url) {
            return res.status(400).json({ success: false, error: 'Missing number or document_url parameter' });
        }
        
        const mime = mimetype || 'application/pdf';
        const name = filename || 'Document';
        
        const logId = require('crypto').randomUUID();
        await db.saveMessageLog({
            id: logId,
            sessionId: req.session.sessionId,
            type: 'document',
            recipient: req.body.number,
            payloadPreview: name,
            status: 'queued'
        });
        const result = await req.session.sendDocument(number, document_url, name, mime, type, logId);

        res.json({ success: true, message: 'Document queued for delivery', result });
    } catch (err) {
        await db.saveMessageLog({
            sessionId: req.params.sessionId,
            type: 'document',
            recipient: req.body.number || 'unknown',
            payloadPreview: req.body.filename || 'Document',
            status: 'failed',
            errorMessage: err.message
        }).catch(() => {});

        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. Endpoint: Send Voice Note (PTT Audio)
router.post('/:sessionId/send-voice', requireApiKey, requireSession, async (req, res) => {
    try {
        const { number, audio_url, ptt, type } = req.body;
        if (!number || !audio_url) {
            return res.status(400).json({ success: false, error: 'Missing number or audio_url parameter' });
        }
        
        const isPtt = ptt !== undefined ? !!ptt : true;
        const logId = require('crypto').randomUUID();
        await db.saveMessageLog({
            id: logId,
            sessionId: req.session.sessionId,
            type: 'voice',
            recipient: req.body.number,
            payloadPreview: '[PTT Voice Note]',
            status: 'queued'
        });
        const result = await req.session.sendVoice(number, audio_url, isPtt, type, logId);

        res.json({ success: true, message: 'Voice note queued for delivery', result });
    } catch (err) {
        await db.saveMessageLog({
            sessionId: req.params.sessionId,
            type: 'voice',
            recipient: req.body.number || 'unknown',
            payloadPreview: '[PTT Voice Note]',
            status: 'failed',
            errorMessage: err.message
        }).catch(() => {});

        res.status(500).json({ success: false, error: err.message });
    }
});

// 6. Endpoint: Send Video Message
router.post('/:sessionId/send-video', requireApiKey, requireSession, async (req, res) => {
    try {
        const { number, video_url, caption, type } = req.body;
        if (!number || !video_url) {
            return res.status(400).json({ success: false, error: 'Missing number or video_url parameter' });
        }
        
        const logId = require('crypto').randomUUID();
        await db.saveMessageLog({
            id: logId,
            sessionId: req.session.sessionId,
            type: 'video',
            recipient: req.body.number,
            payloadPreview: caption || '[Video Attachment]',
            status: 'queued'
        });
        const result = await req.session.sendVideo(number, video_url, caption || '', type, logId);

        res.json({ success: true, message: 'Video queued for delivery', result });
    } catch (err) {
        await db.saveMessageLog({
            sessionId: req.params.sessionId,
            type: 'video',
            recipient: req.body.number || 'unknown',
            payloadPreview: req.body.caption || '[Video Attachment]',
            status: 'failed',
            errorMessage: err.message
        }).catch(() => {});

        res.status(500).json({ success: false, error: err.message });
    }
});

// 8. Endpoint: Resolve Newsletter / Channel Invite Code or JID
router.post('/:sessionId/resolve-newsletter', requireApiKey, requireSession, async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) {
            return res.status(400).json({ success: false, error: 'Missing code or invite URL parameter' });
        }
        
        const result = await req.session.resolveNewsletter(code);
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 7. Endpoint: Read / Mark Messages as Read
router.post('/:sessionId/read-messages', requireApiKey, requireSession, async (req, res) => {
    try {
        const { keys } = req.body;
        if (!keys || !Array.isArray(keys)) {
            return res.status(400).json({ success: false, error: 'Missing keys array parameter' });
        }
        
        const result = await req.session.readMessages(keys);
        res.json({ success: true, message: 'Messages marked as read', result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
