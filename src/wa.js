const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const QueueManager = require('./queue');
const db = require('./db');
const { updateLidMapping, normalizeJid, getUserId, isLid, loadLidMappingsFromDB } = require('./jid-utils');

class WAManager extends EventEmitter {
    constructor(sessionId, sessionName) {
        super();
        this.sessionId = sessionId;
        this.sessionName = sessionName || sessionId;
        this.sock = null;
        this.qrCode = null;
        this.setStatus('DISCONNECTED'); // DISCONNECTED, CONNECTING, WAITING_QR, CONNECTED
        
        // Inisialisasi Queue Limiter dengan Jeda Protektif 3 Detik (3000 ms)
        this.messageQueue = new QueueManager(async (task) => {
            if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
            return await this.sock.sendMessage(task.number, task.payload);
        }, 3000);
    }

    setStatus(newStatus) {
        this.status = newStatus;
        this.emit('statusUpdate', {
            sessionId: this.sessionId,
            sessionName: this.sessionName,
            status: this.status,
            qrCode: this.qrCode
        });
    }

    async connect() {
        this.setStatus('CONNECTING');
        
        // Memuat seluruh mapping LID dari SQLite sebelum socket terhubung
        await loadLidMappingsFromDB();

        const authPath = path.join(__dirname, `../auth_info_baileys_${this.sessionId}`);
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        
        console.log(`[${this.sessionId}] Using WA v${version.join('.')}, isLatest: ${isLatest}`);

        this.sock = makeWASocket({ 
            version,
            auth: state, 
            printQRInTerminal: false,
            browser: ['Mac OS', 'Chrome', '10.15.7']
        });


        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                this.qrCode = qr;
                this.setStatus('WAITING_QR');
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
                // If it is destroyed (socket nullified), stop reconnection attempts immediately
                if (!this.sock) {
                    console.log(`[${this.sessionId}] Connection closed because device was deleted.`);
                    return;
                }
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`[${this.sessionId}] Connection closed due to`, lastDisconnect.error, ', reconnecting', shouldReconnect);
                
                if (statusCode === 401 || statusCode === 403 || statusCode === 405) {
                    console.log(`[${this.sessionId}] Session invalid, removing auth info and restarting...`);
                    this.logout();
                } else if (shouldReconnect) {
                    setTimeout(() => {
                        console.log(`[${this.sessionId}] Mencoba menyambungkan kembali...`);
                        this.connect();
                    }, 5000);
                } else {
                    // Jika dilogout (misal lewat HP atau perintah API)
                    this.qrCode = null;
                    this.setStatus('DISCONNECTED');
                    const authPath = path.join(__dirname, `../auth_info_baileys_${this.sessionId}`);
                    
                    setTimeout(() => {
                        try {
                            if (fs.existsSync(authPath)) {
                                fs.rmSync(authPath, { recursive: true, force: true });
                            }
                        } catch (e) {
                            console.error(`[${this.sessionId}] Gagal menghapus cache kredensial:`, e.message);
                        }
                        this.connect();
                    }, 2500);
                }
            } else if (connection === 'open') {
                console.log(`[${this.sessionId}] Opened connection`);
                this.qrCode = null;
                this.setStatus('CONNECTED');
            }
        });

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('contacts.update', (updates) => {
            const mappings = [];
            for (const c of updates) {
                if (c.id && c.lid) mappings.push({ jid: c.id, lid: c.lid });
            }
            if (mappings.length > 0) updateLidMapping(mappings);
        });

        this.sock.ev.on('contacts.upsert', (contacts) => {
            const mappings = [];
            for (const c of contacts) {
                if (c.id && c.lid) mappings.push({ jid: c.id, lid: c.lid });
            }
            if (mappings.length > 0) updateLidMapping(mappings);
        });

        this.sock.ev.on('contacts.set', ({ contacts }) => {
            const mappings = [];
            for (const c of contacts) {
                if (c.id && c.lid) mappings.push({ jid: c.id, lid: c.lid });
            }
            if (mappings.length > 0) {
                updateLidMapping(mappings);
            }
        });

        this.sock.ev.on('messaging-history.set', ({ contacts }) => {
            if (contacts) {
                const mappings = [];
                for (const c of contacts) {
                    if (c.id && c.lid) mappings.push({ jid: c.id, lid: c.lid });
                }
                if (mappings.length > 0) {
                    updateLidMapping(mappings);
                }
            }
        });

        this.sock.ev.on('lid-mapping.update', (mappings) => {
            updateLidMapping(mappings);
        });

        this.sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            try {
                let messageType = Object.keys(msg.message)[0];
                if (messageType === 'senderKeyDistributionMessage') {
                    messageType = Object.keys(msg.message)[1] || messageType;
                }
                
                let messageText = '';
                if (msg.message.conversation) messageText = msg.message.conversation;
                else if (msg.message.extendedTextMessage?.text) messageText = msg.message.extendedTextMessage.text;
                else if (msg.message.imageMessage?.caption) messageText = msg.message.imageMessage.caption;
                else if (msg.message.videoMessage?.caption) messageText = msg.message.videoMessage.caption;
                
                let messageTitle = msg.message.documentMessage?.title || msg.message.documentMessage?.fileName || '';

                const isGroup = msg.key.remoteJid.endsWith('@g.us');
                const normalizedRemoteJid = normalizeJid(msg.key.remoteJid);
                const sender = normalizedRemoteJid.split('@')[0];

                const senderInfo = getUserId(msg);
                const participant = senderInfo.id;
                const isLidBased = senderInfo.isLidBased;
                const phone = isLidBased ? null : senderInfo.id;
                const pushName = msg.pushName || 'Unknown Contact';

                // Decide webhook URL to use: device-specific or global fallback
                const targetWebhook = this.webhookUrl || await db.getWebhookUrl();

                if (targetWebhook) {
                    const payload = {
                        event: 'message.received',
                        sessionId: this.sessionId,
                        sessionName: this.sessionName,
                        data: {
                            id: msg.key.id,
                            from: sender,
                            participant: participant,
                            phone: phone,
                            pushName: pushName,
                            isGroup: isGroup,
                            isLidBased: isLidBased,
                            type: messageType.replace('Message', ''),
                            text: messageText || messageTitle,
                            timestamp: msg.messageTimestamp,
                            device: msg.key.id.length > 21 ? 'Android' : 'iOS/Web',
                            rawContext: msg.message
                        }
                    };

                    fetch(targetWebhook, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    }).catch(e => console.error(`[${this.sessionId}] Webhook payload bounced:`, e.message));
                }
            } catch (err) {
                console.error(`[${this.sessionId}] Error pada Event Listener Webhook API:`, err);
            }
        });
    }

    logout() {
        this.setStatus('DISCONNECTED');
        const authPath = path.join(__dirname, `../auth_info_baileys_${this.sessionId}`);
        if (fs.existsSync(authPath)) {
            try {
                fs.rmSync(authPath, { recursive: true, force: true });
            } catch (e) {
                console.error(`[${this.sessionId}] Logout: Gagal menghapus folder sesi:`, e.message);
            }
        }
        this.qrCode = null;
        setTimeout(() => {
            this.connect();
        }, 2500);
    }

    destroy() {
        this.setStatus('DISCONNECTED');
        const socketRef = this.sock;
        this.sock = null; // nullify early to prevent reconnection loops
        try {
            if (socketRef) {
                socketRef.ev.removeAllListeners();
                if (socketRef.ws) {
                    socketRef.ws.close();
                }
                socketRef.end(undefined);
            }
        } catch (e) {
            console.error(`[${this.sessionId}] Error destroying socket:`, e.message);
        }
        
        const authPath = path.join(__dirname, `../auth_info_baileys_${this.sessionId}`);
        if (fs.existsSync(authPath)) {
            try {
                // Give Baileys a small delay to finish any pending IO before we forcefully delete the folder
                setTimeout(() => {
                    if (fs.existsSync(authPath)) {
                        fs.rmSync(authPath, { recursive: true, force: true });
                    }
                }, 1000);
            } catch (e) {
                console.error(`[${this.sessionId}] Gagal menghapus folder auth saat destroy:`, e.message);
            }
        }
    }
    
    formatRecipient(id, type = null) {
        if (typeof id !== 'string') id = id.toString();
        if (id.endsWith('@s.whatsapp.net') || id.endsWith('@lid') || id.endsWith('@g.us')) {
            return id;
        }

        let identifier = id.replace(/[^0-9a-zA-Z]/g, '');
        const isLikelyLid = (identifier.length >= 14 && identifier.startsWith('7'));
        
        if (type === 'lid' || isLid(id) || (type !== 'number' && isLikelyLid)) {
            if (!identifier.endsWith('@lid')) identifier = identifier + '@lid';
            return identifier;
        }

        let number = id.replace(/[^0-9]/g, '');
        if (number.startsWith('0')) {
            number = '62' + number.slice(1);
        }
        if (!number.endsWith('@s.whatsapp.net')) {
            number = number + '@s.whatsapp.net';
        }
        return number;
    }

    getMediaContent(input) {
        if (typeof input === 'string' && input.startsWith('data:')) {
            const base64Data = input.split('base64,')[1];
            return Buffer.from(base64Data, 'base64');
        }
        return { url: input };
    }

    async sendText(to, text, type = null) {
        if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
        const number = this.formatRecipient(to, type);
        this.messageQueue.add({ number, payload: { text: text } })
            .catch(err => console.error(`[${this.sessionId}] Failed to send queued text:`, err.message));
        return { status: 'queued', number: number, detail: 'Message added to rate-limiter queue' };
    }

    async sendImage(to, imageUrl, caption = '', type = null) {
        if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
        const number = this.formatRecipient(to, type);
        const mediaConfig = this.getMediaContent(imageUrl);
        this.messageQueue.add({ number, payload: { image: mediaConfig, caption: caption } })
            .catch(err => console.error(`[${this.sessionId}] Failed to send queued image:`, err.message));
        return { status: 'queued', number: number, detail: 'Image added to rate-limiter queue' };
    }

    async sendDocument(to, documentUrl, fileName, mimetype = 'application/pdf', type = null) {
        if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
        const number = this.formatRecipient(to, type);
        const mediaConfig = this.getMediaContent(documentUrl);
        this.messageQueue.add({ number, payload: { document: mediaConfig, mimetype: mimetype, fileName: fileName } })
            .catch(err => console.error(`[${this.sessionId}] Failed to send queued document:`, err.message));
        return { status: 'queued', number: number, detail: 'Document added to rate-limiter queue' };
    }
}

module.exports = WAManager;