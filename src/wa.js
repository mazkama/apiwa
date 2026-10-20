const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
        this.status = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, WAITING_QR, CONNECTED, PAUSED
        this.isActive = 1; // 1: Active, 0: Paused
        this.phoneNumber = null;
        this.pushName = null;
        this.webhookUrl = null;
        this.webhookSecret = null;
        this.webhookEvents = ['message.received', 'message.status'];
        this.apiKey = null;

        // Inisialisasi Queue Limiter dengan Jeda Protektif 3 Detik (3000 ms)
        this.messageQueue = new QueueManager(async (task) => {
            if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
            try {
                const res = await this.sock.sendMessage(task.number, task.payload);
                if (task.logId) {
                    await db.updateMessageLogStatus(task.logId, { status: 'sent' }).catch(() => {});
                }
                return res;
            } catch (err) {
                if (task.logId) {
                    await db.updateMessageLogStatus(task.logId, { status: 'failed', errorMessage: err.message }).catch(() => {});
                }
                throw err;
            }
        }, 3000);
    }

    setStatus(newStatus) {
        this.status = newStatus;
        this.emit('statusUpdate', {
            sessionId: this.sessionId,
            sessionName: this.sessionName,
            status: this.status,
            isActive: this.isActive,
            phoneNumber: this.phoneNumber,
            pushName: this.pushName,
            qrCode: this.qrCode
        });
    }

    async connect() {
        if (!this.isActive) {
            console.log(`[${this.sessionId}] Session is paused (isActive=0). Skipping auto-connect.`);
            this.setStatus('PAUSED');
            return;
        }

        this.setStatus('CONNECTING');
        
        // Memuat seluruh mapping LID dari SQLite sebelum socket terhubung
        await loadLidMappingsFromDB();

        const authPath = path.join(__dirname, `../auth_info_baileys_${this.sessionId}`);
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        
        console.log(`[${this.sessionId}] Starting WA socket v${version.join('.')}, isLatest: ${isLatest}`);

        this.sock = makeWASocket({ 
            version,
            auth: state, 
            printQRInTerminal: false,
            browser: ['Mac OS', 'Chrome', '10.15.7']
        });

        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                this.qrCode = qr;
                this.setStatus('WAITING_QR');
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
                
                // If paused or destroyed manually
                if (!this.isActive) {
                    console.log(`[${this.sessionId}] Socket cleanly paused.`);
                    this.qrCode = null;
                    this.setStatus('PAUSED');
                    return;
                }

                if (!this.sock) {
                    console.log(`[${this.sessionId}] Connection closed because device was deleted.`);
                    return;
                }

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`[${this.sessionId}] Connection closed due to`, lastDisconnect?.error?.message || lastDisconnect?.error, ', reconnecting:', shouldReconnect);
                
                if (statusCode === 401 || statusCode === 403 || statusCode === 405) {
                    console.log(`[${this.sessionId}] Session invalid / logged out remotely, removing credentials...`);
                    this.logout();
                } else if (shouldReconnect) {
                    this.setStatus('DISCONNECTED');
                    setTimeout(() => {
                        if (this.isActive) {
                            console.log(`[${this.sessionId}] Attempting auto-reconnect...`);
                            this.connect();
                        }
                    }, 5000);
                } else {
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
                        if (this.isActive) this.connect();
                    }, 2500);
                }
            } else if (connection === 'open') {
                console.log(`[${this.sessionId}] Opened connection successfully!`);
                this.qrCode = null;
                
                // Extract connected profile metadata
                try {
                    const rawJid = this.sock.user?.id || '';
                    const cleanPhone = rawJid.split(':')[0] || rawJid.split('@')[0];
                    const pushName = this.sock.user?.name || this.sock.user?.notify || 'WhatsApp User';
                    
                    this.phoneNumber = cleanPhone;
                    this.pushName = pushName;
                    await db.updateSessionProfile(this.sessionId, cleanPhone, pushName);
                } catch (e) {
                    console.error(`[${this.sessionId}] Error extracting user profile:`, e.message);
                }

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
            for (const c of (contacts || [])) {
                if (c.id && c.lid) mappings.push({ jid: c.id, lid: c.lid });
            }
            if (mappings.length > 0) updateLidMapping(mappings);
        });

        this.sock.ev.on('messaging-history.set', ({ contacts }) => {
            if (contacts) {
                const mappings = [];
                for (const c of contacts) {
                    if (c.id && c.lid) mappings.push({ jid: c.id, lid: c.lid });
                }
                if (mappings.length > 0) updateLidMapping(mappings);
            }
        });

        this.sock.ev.on('lid-mapping.update', (mappings) => {
            updateLidMapping(mappings);
        });

        // Inbound Messages Listener with strict Per-Session Webhook & HMAC
        
        // Message Delivery & Read Status Updates (Industry Standard)
        this.sock.ev.on('messages.update', async (updates) => {
            const statusNames = {
                1: 'PENDING',
                2: 'SERVER_ACK',
                3: 'DELIVERY_ACK',
                4: 'READ',
                5: 'PLAYED'
            };

            for (const update of updates) {
                if (update.update && update.update.status) {
                    const eventName = 'message.status';
                    if (this.webhookUrl && (!this.webhookEvents || this.webhookEvents.includes(eventName))) {
                        const statusNum = update.update.status;
                        const statusLabel = statusNames[statusNum] || ('STATUS_' + statusNum);

                        const payload = {
                            event: eventName,
                            sessionId: this.sessionId,
                            sessionName: this.sessionName,
                            timestamp: Date.now(),
                            data: {
                                id: update.key.id,
                                remoteJid: update.key.remoteJid,
                                fromMe: update.key.fromMe,
                                status: statusNum,
                                statusName: statusLabel
                            }
                        };

                        this.dispatchWebhook(payload).catch(() => {});
                    }
                }
            }
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

                // Check webhook subscriptions
                const eventName = 'message.received';
                if (this.webhookUrl && (!this.webhookEvents || this.webhookEvents.includes(eventName))) {
                    const payload = {
                        event: eventName,
                        sessionId: this.sessionId,
                        sessionName: this.sessionName,
                        timestamp: Date.now(),
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

                    this.dispatchWebhook(payload).catch(e => console.error(`[${this.sessionId}] Webhook dispatch error:`, e.message));
                }
            } catch (err) {
                console.error(`[${this.sessionId}] Error processing message webhook:`, err);
            }
        });
    }

    async dispatchWebhook(payload) {
        if (!this.webhookUrl) return { ok: false, error: 'No webhook URL configured' };

        const bodyStr = JSON.stringify(payload);
        const headers = {
            'Content-Type': 'application/json',
            'X-Session-Id': this.sessionId,
            'User-Agent': 'APIWA-Gateway/2.0'
        };

        if (this.webhookSecret) {
            headers['X-Webhook-Secret'] = this.webhookSecret;
            const hmac = crypto.createHmac('sha256', this.webhookSecret).update(bodyStr).digest('hex');
            headers['X-Signature-SHA256'] = hmac;
        }

        const startTime = Date.now();
        let statusCode = null;
        let respBody = '';
        let errorMsg = null;

        try {
            const res = await fetch(this.webhookUrl, {
                method: 'POST',
                headers,
                body: bodyStr,
                signal: AbortSignal.timeout(8000)
            });
            statusCode = res.status;
            respBody = await res.text().catch(() => '');
            const durationMs = Date.now() - startTime;

            // Audit Log into SQLite webhook_logs
            await db.saveWebhookLog({
                sessionId: this.sessionId,
                event: payload.event || 'message.received',
                url: this.webhookUrl,
                payload: payload,
                statusCode: statusCode,
                responseBody: respBody,
                durationMs: durationMs,
                errorMessage: res.ok ? null : ('HTTP Error ' + statusCode + ': ' + respBody.slice(0, 150))
            }).catch(err => console.error('[' + this.sessionId + '] Error saving webhook log:', err.message));

            return { ok: res.ok, status: statusCode, durationMs, body: respBody };
        } catch (e) {
            const durationMs = Date.now() - startTime;
            errorMsg = e.message;
            console.error('[' + this.sessionId + '] Webhook HTTP POST failed to ' + this.webhookUrl + ':', errorMsg);

            // Audit Log failed attempt
            await db.saveWebhookLog({
                sessionId: this.sessionId,
                event: payload.event || 'message.received',
                url: this.webhookUrl,
                payload: payload,
                statusCode: statusCode,
                responseBody: respBody,
                durationMs: durationMs,
                errorMessage: errorMsg
            }).catch(err => console.error('[' + this.sessionId + '] Error logging webhook failure:', err.message));

            throw e;
        }
    }

    async pause() {
        this.isActive = 0;
        await db.updateSessionState(this.sessionId, 0);
        this.setStatus('PAUSED');
        this.qrCode = null;

        if (this.sock) {
            try {
                this.sock.ev.removeAllListeners();
                if (this.sock.ws) this.sock.ws.close();
                this.sock.end(undefined);
            } catch (e) {
                console.error(`[${this.sessionId}] Error stopping socket on pause:`, e.message);
            }
            this.sock = null;
        }
        console.log(`[${this.sessionId}] Session paused.`);
        return true;
    }

    async resume() {
        this.isActive = 1;
        await db.updateSessionState(this.sessionId, 1);
        console.log(`[${this.sessionId}] Session resumed, connecting...`);
        await this.connect();
        return true;
    }

    async reconnect() {
        console.log(`[${this.sessionId}] Manual reconnect triggered.`);
        this.isActive = 1;
        await db.updateSessionState(this.sessionId, 1);
        if (this.sock) {
            try {
                this.sock.ev.removeAllListeners();
                if (this.sock.ws) this.sock.ws.close();
                this.sock.end(undefined);
            } catch (e) {}
            this.sock = null;
        }
        await this.connect();
        return true;
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
        this.phoneNumber = null;
        this.pushName = null;
        db.updateSessionProfile(this.sessionId, null, null);

        if (this.isActive) {
            setTimeout(() => {
                this.connect();
            }, 2500);
        }
    }

    destroy() {
        this.isActive = 0;
        this.setStatus('DISCONNECTED');
        const socketRef = this.sock;
        this.sock = null;
        try {
            if (socketRef) {
                socketRef.ev.removeAllListeners();
                if (socketRef.ws) socketRef.ws.close();
                socketRef.end(undefined);
            }
        } catch (e) {
            console.error(`[${this.sessionId}] Error destroying socket:`, e.message);
        }
        
        const authPath = path.join(__dirname, `../auth_info_baileys_${this.sessionId}`);
        if (fs.existsSync(authPath)) {
            setTimeout(() => {
                try {
                    if (fs.existsSync(authPath)) {
                        fs.rmSync(authPath, { recursive: true, force: true });
                    }
                } catch (e) {
                    console.error(`[${this.sessionId}] Gagal menghapus folder auth saat destroy:`, e.message);
                }
            }, 1000);
        }
    }
    
    formatRecipient(id, type = null) {
        if (typeof id !== 'string') id = id.toString().trim();
        if (id.endsWith('@s.whatsapp.net') || id.endsWith('@lid') || id.endsWith('@g.us') || id.endsWith('@newsletter')) {
            return id;
        }

        // WhatsApp Group handling (@g.us)
        if (type === 'group' || id.includes('@g.us')) {
            let clean = id.replace(/[^0-9_\-@a-zA-Z]/g, '');
            if (!clean.endsWith('@g.us')) clean = clean.split('@')[0] + '@g.us';
            return clean;
        }

        // WhatsApp Channel / Newsletter handling (@newsletter)
        if (type === 'channel' || type === 'newsletter' || id.includes('@newsletter')) {
            let clean = id.replace(/[^0-9_\-@a-zA-Z]/g, '');
            if (!clean.endsWith('@newsletter')) clean = clean.split('@')[0] + '@newsletter';
            return clean;
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

    // --- Outbound Actions ---

        async resolveNewsletter(inviteCodeOrJid) {
        if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
        let code = inviteCodeOrJid.toString().trim();
        
        // Handle URL format: https://whatsapp.com/channel/0029VbDr5w0Eawdsk4LeM52J
        if (code.includes('whatsapp.com/channel/')) {
            code = code.split('whatsapp.com/channel/')[1].split('/')[0].split('?')[0];
        }
        
        // Strip @newsletter suffix if present on invite code
        if (code.endsWith('@newsletter')) {
            code = code.split('@')[0];
        }

        // If it's already a numeric JID e.g. 120363410836649482
        if (/^\d+$/.test(code)) {
            const jid = `${code}@newsletter`;
            try {
                const meta = await this.sock.newsletterMetadata('JID', jid);
                return {
                    id: meta.id,
                    name: meta.thread_metadata?.name?.text || 'WhatsApp Channel',
                    description: meta.thread_metadata?.description?.text || '',
                    subscribers: meta.thread_metadata?.subscribers_count || '0'
                };
            } catch (e) {
                return { id: jid, name: 'WhatsApp Channel', description: '', subscribers: '0' };
            }
        }

        // Resolve alphanumeric invite code e.g. 0029VbDr5w0Eawdsk4LeM52J
        const meta = await this.sock.newsletterMetadata('INVITE', code);
        if (!meta || !meta.id) {
            throw new Error(`Gagal menemukan Saluran WhatsApp dengan kode: ${code}`);
        }

        return {
            id: meta.id,
            inviteCode: code,
            name: meta.thread_metadata?.name?.text || 'WhatsApp Channel',
            description: meta.thread_metadata?.description?.text || '',
            subscribers: meta.thread_metadata?.subscribers_count || '0'
        };
    }

async checkNumber(rawNumber) {
        if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
        let number = rawNumber.toString().replace(/[^0-9]/g, '');
        if (number.startsWith('0')) number = '62' + number.slice(1);
        
        const jid = number + '@s.whatsapp.net';
        const results = await this.sock.onWhatsApp(jid);
        if (results && results.length > 0 && results[0].exists) {
            return {
                exists: true,
                jid: results[0].jid,
                number: number
            };
        }
        return { exists: false, number: number };
    }

    async sendText(to, text, type = null, logId = null) {
        if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
        const number = this.formatRecipient(to, type);
        this.messageQueue.add({ number, payload: { text: text }, logId })
            .catch(err => console.error(`[undefined] Failed to send queued text:`, err.message));
        return { status: 'queued', number: number, detail: 'Message added to rate-limiter queue', logId };
    }

    async sendImage(to, imageUrl, caption = '', type = null, logId = null) {
        if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
        const number = this.formatRecipient(to, type);
        const mediaConfig = this.getMediaContent(imageUrl);
        this.messageQueue.add({ number, payload: { image: mediaConfig, caption: caption }, logId })
            .catch(err => console.error(`[undefined] Failed to send queued image:`, err.message));
        return { status: 'queued', number: number, detail: 'Image added to rate-limiter queue', logId };
    }

    async sendDocument(to, documentUrl, fileName, mimetype = 'application/pdf', type = null, logId = null) {
        if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
        const number = this.formatRecipient(to, type);
        const mediaConfig = this.getMediaContent(documentUrl);
        this.messageQueue.add({ number, payload: { document: mediaConfig, mimetype: mimetype, fileName: fileName }, logId })
            .catch(err => console.error(`[undefined] Failed to send queued document:`, err.message));
        return { status: 'queued', number: number, detail: 'Document added to rate-limiter queue', logId };
    }

    async sendVoice(to, audioUrl, ptt = true, type = null, logId = null) {
        if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
        const number = this.formatRecipient(to, type);
        const mediaConfig = this.getMediaContent(audioUrl);
        this.messageQueue.add({ number, payload: { audio: mediaConfig, ptt: ptt, mimetype: 'audio/mp4' }, logId })
            .catch(err => console.error(`[undefined] Failed to send queued voice note:`, err.message));
        return { status: 'queued', number: number, detail: 'Voice note added to rate-limiter queue', logId };
    }

    async sendVideo(to, videoUrl, caption = '', type = null, logId = null) {
        if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
        const number = this.formatRecipient(to, type);
        const mediaConfig = this.getMediaContent(videoUrl);
        this.messageQueue.add({ number, payload: { video: mediaConfig, caption: caption }, logId })
            .catch(err => console.error(`[undefined] Failed to send queued video:`, err.message));
        return { status: 'queued', number: number, detail: 'Video added to rate-limiter queue', logId };
    }

    async readMessages(keys) {
        if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
        await this.sock.readMessages(keys);
        return { success: true, count: keys.length };
    }
}

module.exports = WAManager;
