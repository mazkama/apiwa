const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');

const app = express();
app.use(express.json());

let sock; // Definisikan sock secara global

// Inisialisasi database SQLite
const db = new sqlite3.Database('./commands.db', (err) => {
    if (err) {
        console.error("Error opening database:", err.message);
    } else {
        db.run(`CREATE TABLE IF NOT EXISTS bot_commands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            command TEXT UNIQUE,
            response TEXT
        )`);
        console.log("Database initialized.");
    }
});

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
            let text = message.message.conversation || "";
            console.log("Message text:", text);  // Log isi pesan untuk debugging

            if (text.startsWith('/')) {
                const [command, ...args] = text.trim().split(' ');
                if (command === '/help') {
                    const commands = [
                        '/addcommand <command> <response> - Add a new command',
                        '/delcommand <command> - Delete an existing command',
                        '/command - List all available commands',
                    ];
                    await sock.sendMessage(sender, { text: commands.join('\n') });
                } else if (command === '/addcommand' && args.length >= 2) {
                    const newCommand = args[0];
                    const response = args.slice(1).join(' ');
                    await addCommand(newCommand, response);
                    await sock.sendMessage(sender, { text: `Command ${newCommand} added.` });
                } else if (command === '/delcommand' && args.length === 1) {
                    const commandToDelete = args[0];
                    await deleteCommand(commandToDelete);
                    await sock.sendMessage(sender, { text: `Command ${commandToDelete} deleted.` });
                } else if (command === '/command') {
                    // Menampilkan semua perintah yang ada di database
                    const commandsList = await getAllCommands();
                    if (commandsList.length > 0) {
                        await sock.sendMessage(sender, { text: 'Available commands:\n' + commandsList.join('\n') });
                    } else {
                        await sock.sendMessage(sender, { text: 'No commands available.' });
                    }
                } else {
                    const foundCommand = await getCommandResponse(text);
                    if (foundCommand) {
                        await sock.sendMessage(sender, { text: foundCommand });
                    } else {
                        await sock.sendMessage(sender, { text: 'Unknown command. Use /help for a list of commands.' });
                    }
                }
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Fungsi untuk menambah perintah ke database
function addCommand(command, response) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO bot_commands (command, response) VALUES (?, ?)`,
            [command, response],
            (err) => {
                if (err) {
                    console.error('Error adding command:', err.message);
                    reject(err);
                } else {
                    console.log(`Command ${command} added.`);
                    resolve();
                }
            }
        );
    });
}

// Fungsi untuk menghapus perintah dari database
function deleteCommand(command) {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM bot_commands WHERE command = ?`, [command], (err) => {
            if (err) {
                console.error('Error deleting command:', err.message);
                reject(err);
            } else {
                console.log(`Command ${command} deleted.`);
                resolve();
            }
        });
    });
}

// Fungsi untuk mendapatkan respons berdasarkan perintah
function getCommandResponse(command) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT response FROM bot_commands WHERE command = ?`, [command], (err, row) => {
            if (err) {
                console.error('Error fetching command:', err.message);
                reject(err);
            } else {
                resolve(row ? row.response : null);
            }
        });
    });
}

// Fungsi untuk mendapatkan semua perintah yang ada di database
function getAllCommands() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT command FROM bot_commands`, [], (err, rows) => {
            if (err) {
                console.error('Error fetching commands:', err.message);
                reject(err);
            } else {
                resolve(rows.map(row => row.command));
            }
        });
    });
}

connectToWhatsApp();
app.listen(3000, () => {
    console.log('Server running on port 3000');
});
