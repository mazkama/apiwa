const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const QueueManager = require('./queue');
const db = require('./db');
const { updateLidMapping, normalizeJid, getUserId, isLid } = require('./jid-utils');

class WAManager extends EventEmitter {
    constructor() {
        super();
        this.sock = null;
        this.qrCode = null;
        this.setStatus('DISCONNECTED'); // DISCONNECTED, CONNECTING, WAITING_QR, CONNECTED
        this.qrCode = null;
        
        // Inisialisasi Queue Limiter dengan Jeda Protektif 3 Detik (3000 ms)
        this.messageQueue = new QueueManager(async (task) => {
            if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
            return await this.sock.sendMessage(task.number, task.payload);
        }, 3000);
    }

    setStatus(newStatus) {
        this.status = newStatus;
        this.emit('statusUpdate', this.status);
    }

    async connect() {
        this.setStatus('CONNECTING');
        const authPath = path.join(__dirname, '../auth_info_baileys');
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        
        console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

        this.sock = makeWASocket({ 
            version,
            auth: state, 
            printQRInTerminal: true,
            browser: ['Mac OS', 'Chrome', '10.15.7']
        });

        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                this.qrCode = qr;
                this.setStatus('WAITING_QR');
            } else {
                // Jangan hapus qrCode di sini, agar tetap tampil jika belum discan
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log('Connection closed due to', lastDisconnect.error, ', reconnecting', shouldReconnect);
                
                if (statusCode === 401 || statusCode === 403 || statusCode === 405) {
                    console.log('Session invalid, removing auth info and restarting...');
                    this.logout(); // Call logout without authPath, it handles it internally
                } else if (shouldReconnect) {
                    setTimeout(() => {
                        console.log('Mencoba menyambungkan kembali...');
                        this.connect();
                    }, 5000);
                } else {
                    // Jika dilogout (misal lewat HP atau perintah API)
                    this.qrCode = null;
                    this.setStatus('DISCONNECTED');
                    const authPath = path.join(__dirname, '../auth_info_baileys');
                    
                    setTimeout(() => {
                        try {
                            if (fs.existsSync(authPath)) {
                                fs.rmSync(authPath, { recursive: true, force: true });
                            }
                        } catch (e) {
                            console.error('Gagal menghapus cache kredensial (Mungkin File masih di-Lock Windows):', e.message);
                        }
                        this.connect(); // Memaksa agar membuat sesi QR baru jika Logout penuh dengan aman
                    }, 2500); // 2.5 Detik jeda agar Baileys melepas seluruh lock LevelDB
                }
            } else if (connection === 'open') {
                console.log('Opened connection');
                this.qrCode = null;
                this.setStatus('CONNECTED');
            }
        });

        this.sock.ev.on('creds.update', saveCreds);

        // LID mapping: contacts.update carries {id (phone JID), lid} pairs during contact sync.
        // This populates the in-memory LID→JID store used by normalizeJid().
        this.sock.ev.on('contacts.update', (updates) => {
            const mappings = [];
            for (const c of updates) {
                if (c.id && c.lid) mappings.push({ jid: c.id, lid: c.lid });
            }
            if (mappings.length > 0) updateLidMapping(mappings);
        });

        // lid-mapping.update is a dedicated Baileys event for LID resolution
        // (available in newer Baileys versions; safe no-op if not emitted)
        this.sock.ev.on('lid-mapping.update', (mappings) => {
            updateLidMapping(mappings);
        });

        // Listener untuk Pesan Masuk (Webhook Inbound)
        this.sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            // Abaikan pesan internal / dari diri sendiri
            if (!msg.message || msg.key.fromMe) return;

            try {
                // Full Enterprise Webhook Extraction
                let messageType = Object.keys(msg.message)[0];
                if (messageType === 'senderKeyDistributionMessage') {
                    messageType = Object.keys(msg.message)[1] || messageType; // Bypass signal distribution keys
                }
                
                // Cerdas mengekstrak teks asli atau caption dari media
                let messageText = '';
                if (msg.message.conversation) messageText = msg.message.conversation;
                else if (msg.message.extendedTextMessage?.text) messageText = msg.message.extendedTextMessage.text;
                else if (msg.message.imageMessage?.caption) messageText = msg.message.imageMessage.caption;
                else if (msg.message.videoMessage?.caption) messageText = msg.message.videoMessage.caption;
                
                let messageTitle = msg.message.documentMessage?.title || msg.message.documentMessage?.fileName || '';

                const isGroup = msg.key.remoteJid.endsWith('@g.us');

                // Normalize the conversation JID for the 'from' field:
                //   DM messages  → resolves to sender's phone number (or LID fallback)
                //   Group messages → returns the group JID unchanged (groups are not LID-affected)
                const normalizedRemoteJid = normalizeJid(msg.key.remoteJid);
                const sender = normalizedRemoteJid.split('@')[0];

                // Get the actual message sender (handles LID resolution and remoteJidAlt fallback):
                //   DM messages    → same as sender above
                //   Group messages → resolves msg.key.participant (may be a LID)
                const senderInfo = getUserId(msg);
                const participant = senderInfo.id;
                const isLidBased = senderInfo.isLidBased;
                const pushName = msg.pushName || 'Unknown Contact';

                db.getWebhookUrl().then(webhookUrl => {
                    if (webhookUrl) {
                        const payload = {
                            event: 'message.received',
                            data: {
                                id: msg.key.id,
                                from: sender,
                                participant: participant,
                                pushName: pushName,
                                isGroup: isGroup,
                                isLidBased: isLidBased,
                                type: messageType.replace('Message', ''),
                                text: messageText || messageTitle,
                                timestamp: msg.messageTimestamp,
                                device: msg.key.id.length > 21 ? 'Android' : 'iOS/Web',
                                // Sertakan metadata murni bagi Developer tingkat lanjut (mengunduh PDF/Gambar)
                                rawContext: msg.message
                            }
                        };

                        fetch(webhookUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        }).catch(e => console.error('Webhook payload bounced:', e.message));
                    }
                }).catch(e => console.error('Failed retrieving webhook URL:', e));
            } catch (err) {
                console.error("Error pada Event Listener Webhook API:", err);
            }
        });
    }

    logout() {
        this.setStatus('DISCONNECTED');
        const authPath = path.join(__dirname, '../auth_info_baileys');
        if (fs.existsSync(authPath)) {
            try {
                fs.rmSync(authPath, { recursive: true, force: true });
            } catch (e) {
                console.error('Logout: Gagal menghapus folder sesi:', e.message);
            }
        }
        this.qrCode = null;
        setTimeout(() => {
            this.connect();
        }, 2500);
    }
    
    // --- GATEWAY API METHODS ---

    /**
     * Format number to WhatsApp JID format
     */
    formatPhone(phone) {
        let number = phone.toString().replace(/[^0-9]/g, '');
        if (number.startsWith('0')) {
            number = '62' + number.slice(1);
        }
        if (!number.endsWith('@s.whatsapp.net')) {
            number = number + '@s.whatsapp.net';
        }
        return number;
    }

    // Helper untuk mengubah string input menjadi Base64 Buffer atau URL biasa
    getMediaContent(input) {
        if (typeof input === 'string' && input.startsWith('data:')) {
            const base64Data = input.split('base64,')[1];
            return Buffer.from(base64Data, 'base64');
        }
        return { url: input };
    }

    async sendText(to, text) {
        if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
        const number = this.formatPhone(to);
        
        // API tidak ditahan (Fire-And-Forget), biar diproses background
        this.messageQueue.add({ number, payload: { text: text } })
            .catch(err => console.error('Failed to send queued text:', err.message));
            
        return { status: 'queued', number: number, detail: 'Message added to rate-limiter queue' };
    }

    async sendImage(to, imageUrl, caption = '') {
        if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
        const number = this.formatPhone(to);
        const mediaConfig = this.getMediaContent(imageUrl);
        
        this.messageQueue.add({ number, payload: { image: mediaConfig, caption: caption } })
            .catch(err => console.error('Failed to send queued image:', err.message));
            
        return { status: 'queued', number: number, detail: 'Image added to rate-limiter queue' };
    }

    async sendDocument(to, documentUrl, fileName, mimetype = 'application/pdf') {
        if (!this.sock || this.status !== 'CONNECTED') throw new Error('WhatsApp is not connected');
        const number = this.formatPhone(to);
        const mediaConfig = this.getMediaContent(documentUrl);
        
        this.messageQueue.add({ number, payload: { document: mediaConfig, mimetype: mimetype, fileName: fileName } })
            .catch(err => console.error('Failed to send queued document:', err.message));
            
        return { status: 'queued', number: number, detail: 'Document added to rate-limiter queue' };
    }
}

const waManager = new WAManager();
module.exports = waManager;
