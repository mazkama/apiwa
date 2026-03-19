const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const EventEmitter = require('events');
const QueueManager = require('./queue');
const db = require('./db');

class WAManager extends EventEmitter {
    constructor() {
        super();
        this.sock = null;
        this.qrCode = null;
        this.status = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, WAITING_QR, CONNECTED
        
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
        const authPath = './auth_info.json';
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
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log('Connection closed due to', lastDisconnect.error, ', reconnecting', shouldReconnect);
                
                if (statusCode === 401 || statusCode === 403 || statusCode === 405) {
                    console.log('Session invalid, removing auth info and restarting...');
                    this.logout(authPath);
                } else if (shouldReconnect) {
                    setTimeout(() => {
                        console.log('Mencoba menyambungkan kembali...');
                        this.connect();
                    }, 5000);
                } else {
                    this.setStatus('DISCONNECTED');
                }
            } else if (connection === 'open') {
                console.log('Opened connection');
                this.qrCode = null;
                this.setStatus('CONNECTED');
            }
        });

        this.sock.ev.on('creds.update', saveCreds);

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

                const sender = msg.key.remoteJid.split('@')[0];
                const participant = msg.key.participant ? msg.key.participant.split('@')[0] : sender;
                const isGroup = msg.key.remoteJid.endsWith('@g.us');
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

    logout(authPathStr) {
        this.setStatus('DISCONNECTED');
        const authPath = authPathStr || './auth_info.json';
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }
        setTimeout(() => {
            this.connect();
        }, 2000);
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
