const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const express = require('express');

const app = express();
app.use(express.json());

let sock; // Definisikan sock secara global

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info.json');

    sock = makeWASocket({ auth: state, printQRInTerminal: false });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to', lastDisconnect.error, ', reconnecting', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Opened connection');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const message = m.messages[0];
        if (!message.key.fromMe && message.message) {
            const sender = message.key.remoteJid;
            let text = '';

            // Periksa semua kemungkinan tipe pesan teks
            if (message.message.conversation) {
                text = message.message.conversation; // Teks biasa
            } else if (message.message.extendedTextMessage && message.message.extendedTextMessage.text) {
                text = message.message.extendedTextMessage.text; // Pesan teks extended
            } else if (message.message.imageMessage && message.message.imageMessage.caption) {
                text = message.message.imageMessage.caption; // Teks di gambar (caption)
            } else if (message.message.buttonsResponseMessage && message.message.buttonsResponseMessage.selectedButtonId) {
                text = message.message.buttonsResponseMessage.selectedButtonId; // Respon dari tombol
            } else {
                text = ''; // Pesan lain yang tidak dikenali
            }

            if (text) {
                console.log('Received message:', text);

                // Lakukan pengecekan perintah seperti sebelumnya
                if (text.startsWith('/')) {
                    const commands = await getBotCommands();
                    const foundCommand = commands.find(cmd => text.toLowerCase() === cmd.command.toLowerCase());

                    if (foundCommand) {
                        await sock.sendMessage(sender, { text: foundCommand.response });
                    } else {
                        await sock.sendMessage(sender, { text: 'Unknown command. Type /help for available commands.' });
                    }
                }
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

async function getBotCommands() {
    try {
        const response = await axios.get('http://localhost:7806/bot-commands');
        return response.data;
    } catch (error) {
        console.error('Error fetching bot commands:', error);
        return [];
    }
}

const { MessageType, Mimetype } = require('@whiskeysockets/baileys'); // Import tipe pesan

// Fungsi untuk menambahkan delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;

    // Pastikan 'phone' bisa berupa string atau array
    const phones = Array.isArray(phone) ? phone : [phone];

    // Validasi format nomor telepon
    for (const p of phones) {
        if (!/^(\+?62|0)[0-9]+$/.test(p)) {
            return res.status(400).send({ error: `Invalid phone number format: ${p}` });
        }
    }

    // Format nomor telepon
    const formattedPhones = phones.map(p => p.startsWith('0') ? p.replace(/^0/, '62') : p);

    if (!sock) {
        return res.status(500).send({ error: 'WhatsApp socket not connected' });
    }

    try {
        for (const formattedPhone of formattedPhones) {
            await delay(5000); // 2000 ms = 2 detik delay
            await sock.sendMessage(formattedPhone + '@s.whatsapp.net', { text: message });
            console.log(`Message sent to ${formattedPhone}`);
        }
        res.send({ status: 'Messages sent successfully' });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).send({ error: 'Error sending message' });
    }
});



connectToWhatsApp();
app.listen(3000, () => {
    console.log('Server running on port 3000');
});
