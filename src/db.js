const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

// Inisialisasi database SQLite untuk konfigurasi Gateway
const db = new sqlite3.Database('./gateway.db', (err) => {
    if (err) {
        console.error("Error opening database:", err.message);
    } else {
        db.run(`CREATE TABLE IF NOT EXISTS gateway_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS lid_phone_map (
            lid TEXT PRIMARY KEY,
            jid TEXT,
            updated_at INTEGER
        )`);
        console.log("Database initialized.");
    }
});

function getApiKey() {
    return new Promise((resolve, reject) => {
        db.get(`SELECT value FROM gateway_settings WHERE key = 'api_key'`, (err, row) => {
            if (err) {
                console.error('Error fetching API key:', err.message);
                reject(err);
            } else {
                resolve(row ? row.value : null);
            }
        });
    });
}

function generateApiKey() {
    return new Promise((resolve, reject) => {
        const newKey = 'wa_' + require('crypto').randomBytes(16).toString('hex');
        db.run(
            `INSERT INTO gateway_settings (key, value) VALUES ('api_key', ?) 
             ON CONFLICT(key) DO UPDATE SET value = ?`,
            [newKey, newKey],
            (err) => {
                if (err) {
                    console.error('Error saving API Key:', err.message);
                    reject(err);
                } else {
                    resolve(newKey);
                }
            }
        );
    });
}

function getWebhookUrl() {
    return new Promise((resolve, reject) => {
        db.get(`SELECT value FROM gateway_settings WHERE key = 'webhook_url'`, (err, row) => {
            if (err) {
                console.error('Error fetching Webhook URL:', err.message);
                reject(err);
            } else {
                resolve(row ? row.value : null);
            }
        });
    });
}

function setWebhookUrl(url) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO gateway_settings (key, value) VALUES ('webhook_url', ?) 
             ON CONFLICT(key) DO UPDATE SET value = ?`,
            [url || '', url || ''],
            (err) => {
                if (err) {
                    console.error('Error saving Webhook URL:', err.message);
                    reject(err);
                } else {
                    resolve(url);
                }
            }
        );
    });
}

function saveLidMapping(lid, jid) {
    return new Promise((resolve, reject) => {
        const now = Date.now();
        db.run(
            `INSERT INTO lid_phone_map (lid, jid, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(lid) DO UPDATE SET jid = ?, updated_at = ?`,
            [lid, jid, now, jid, now],
            (err) => {
                if (err) {
                    console.error('Error saving LID mapping:', err.message);
                    reject(err);
                } else {
                    resolve({ lid, jid });
                }
            }
        );
    });
}

function loadAllLidMappings() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT lid, jid FROM lid_phone_map`, (err, rows) => {
            if (err) {
                console.error('Error loading LID mappings:', err.message);
                reject(err);
            } else {
                resolve(rows || []);
            }
        });
    });
}

module.exports = {
    getApiKey,
    generateApiKey,
    getWebhookUrl,
    setWebhookUrl,
    saveLidMapping,
    loadAllLidMappings
};

