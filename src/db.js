const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

// Inisialisasi database SQLite untuk konfigurasi Gateway
const db = new sqlite3.Database('./gateway.db', (err) => {
    if (err) {
        console.error("Error opening database:", err.message);
    } else {
        console.log("Database connected.");
    }
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS gateway_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS lid_phone_map (
        lid TEXT PRIMARY KEY,
        jid TEXT,
        updated_at INTEGER
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS wa_sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        webhook_url TEXT,
        api_key TEXT,
        created_at INTEGER
    )`);
    
    // Add columns if they don't exist (for existing dev dbs)
    db.run(`ALTER TABLE wa_sessions ADD COLUMN webhook_url TEXT`, (err) => {});
    db.run(`ALTER TABLE wa_sessions ADD COLUMN api_key TEXT`, (err) => {});
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

function getSessions() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT id, name, webhook_url, api_key, created_at FROM wa_sessions`, (err, rows) => {
            if (err) {
                console.error('Error loading sessions:', err.message);
                reject(err);
            } else {
                resolve(rows || []);
            }
        });
    });
}

function saveSession(id, name) {
    return new Promise((resolve, reject) => {
        const now = Date.now();
        db.run(
            `INSERT INTO wa_sessions (id, name, created_at) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name = ?`,
            [id, name, now, name],
            (err) => {
                if (err) {
                    console.error('Error saving session:', err.message);
                    reject(err);
                } else {
                    resolve({ id, name });
                }
            }
        );
    });
}

function updateSessionSettings(id, webhookUrl, apiKey) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE wa_sessions SET webhook_url = ?, api_key = ? WHERE id = ?`,
            [webhookUrl || null, apiKey || null, id],
            (err) => {
                if (err) {
                    console.error('Error updating session settings:', err.message);
                    reject(err);
                } else {
                    resolve(true);
                }
            }
        );
    });
}

function deleteSession(id) {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM wa_sessions WHERE id = ?`, [id], (err) => {
            if (err) {
                console.error('Error deleting session:', err.message);
                reject(err);
            } else {
                resolve(true);
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
    loadAllLidMappings,
    getSessions,
    saveSession,
    deleteSession,
    updateSessionSettings
};

