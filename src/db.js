const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

// Inisialisasi database SQLite untuk konfigurasi Gateway
const db = new sqlite3.Database('./gateway.db', (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Database connected.');
    }
});

db.serialize(() => {
    // Gateway global settings (for admin master key, etc.)
    db.run(`CREATE TABLE IF NOT EXISTS gateway_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    // LID to phone mapping
    db.run(`CREATE TABLE IF NOT EXISTS lid_phone_map (
        lid TEXT PRIMARY KEY,
        jid TEXT,
        updated_at INTEGER
    )`);

    // Enhanced Multi-tenant Sessions Table
    db.run(`CREATE TABLE IF NOT EXISTS wa_sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        phone_number TEXT,
        push_name TEXT,
        is_active INTEGER DEFAULT 1,
        webhook_url TEXT,
        webhook_secret TEXT,
        webhook_events TEXT,
        api_key TEXT,
        created_at INTEGER,
        updated_at INTEGER
    )`);

    // Outbox & Message Delivery Logs Table
    db.run(`CREATE TABLE IF NOT EXISTS message_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        recipient TEXT NOT NULL,
        payload_preview TEXT,
        status TEXT NOT NULL,
        error_message TEXT,
        created_at INTEGER
    )`);

    // Webhook Delivery Logs Table (Industry Standard Audit & Tracking)
    db.run(`CREATE TABLE IF NOT EXISTS webhook_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        event TEXT NOT NULL,
        url TEXT NOT NULL,
        payload TEXT,
        status_code INTEGER,
        response_body TEXT,
        duration_ms INTEGER,
        error_message TEXT,
        created_at INTEGER
    )`);

    // Ensure columns exist on legacy tables
    const alterColumns = [
        'ALTER TABLE wa_sessions ADD COLUMN phone_number TEXT',
        'ALTER TABLE wa_sessions ADD COLUMN push_name TEXT',
        'ALTER TABLE wa_sessions ADD COLUMN is_active INTEGER DEFAULT 1',
        'ALTER TABLE wa_sessions ADD COLUMN webhook_url TEXT',
        'ALTER TABLE wa_sessions ADD COLUMN webhook_secret TEXT',
        'ALTER TABLE wa_sessions ADD COLUMN webhook_events TEXT',
        'ALTER TABLE wa_sessions ADD COLUMN api_key TEXT',
        'ALTER TABLE wa_sessions ADD COLUMN updated_at INTEGER'
    ];

    for (const sql of alterColumns) {
        db.run(sql, () => {});
    }
});

// Master / Admin API Key
function getMasterApiKey() {
    return new Promise((resolve, reject) => {
        db.get(`SELECT value FROM gateway_settings WHERE key = 'master_api_key'`, (err, row) => {
            if (err) {
                console.error('Error fetching Master API key:', err.message);
                reject(err);
            } else {
                resolve(row ? row.value : null);
            }
        });
    });
}

function generateMasterApiKey() {
    return new Promise((resolve, reject) => {
        const newKey = 'master_' + crypto.randomBytes(16).toString('hex');
        db.run(
            `INSERT INTO gateway_settings (key, value) VALUES ('master_api_key', ?) 
             ON CONFLICT(key) DO UPDATE SET value = ?`,
            [newKey, newKey],
            (err) => {
                if (err) {
                    console.error('Error saving Master API Key:', err.message);
                    reject(err);
                } else {
                    resolve(newKey);
                }
            }
        );
    });
}

function generateRandomToken(prefix = 'wa_') {
    return prefix + crypto.randomBytes(16).toString('hex');
}

// LID Mappings
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

// Sessions Operations
function getSessions() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM wa_sessions ORDER BY created_at DESC`, (err, rows) => {
            if (err) {
                console.error('Error loading sessions:', err.message);
                reject(err);
            } else {
                resolve(rows || []);
            }
        });
    });
}

function getSessionById(id) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM wa_sessions WHERE id = ?`, [id], (err, row) => {
            if (err) reject(err);
            else resolve(row || null);
        });
    });
}

function saveSession(id, name) {
    return new Promise((resolve, reject) => {
        const now = Date.now();
        const defaultApiKey = generateRandomToken('wa_');
        const defaultWebhookSecret = generateRandomToken('sec_');
        const defaultEvents = JSON.stringify(['message.received', 'message.status']);

        db.run(
            `INSERT INTO wa_sessions (id, name, is_active, webhook_events, webhook_secret, api_key, created_at, updated_at) 
             VALUES (?, ?, 1, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name = ?, updated_at = ?`,
            [id, name, defaultEvents, defaultWebhookSecret, defaultApiKey, now, now, name, now],
            (err) => {
                if (err) {
                    console.error('Error saving session:', err.message);
                    reject(err);
                } else {
                    resolve({ id, name, apiKey: defaultApiKey, webhookSecret: defaultWebhookSecret });
                }
            }
        );
    });
}

function updateSessionSettings(id, { webhookUrl, webhookSecret, webhookEvents, apiKey }) {
    return new Promise((resolve, reject) => {
        const now = Date.now();
        const eventsStr = Array.isArray(webhookEvents) ? JSON.stringify(webhookEvents) : (webhookEvents || '["message.received"]');
        
        db.run(
            `UPDATE wa_sessions SET 
                webhook_url = ?, 
                webhook_secret = ?, 
                webhook_events = ?, 
                api_key = ?, 
                updated_at = ? 
             WHERE id = ?`,
            [webhookUrl || null, webhookSecret || null, eventsStr, apiKey || null, now, id],
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

function updateSessionState(id, isActive) {
    return new Promise((resolve, reject) => {
        const now = Date.now();
        db.run(
            `UPDATE wa_sessions SET is_active = ?, updated_at = ? WHERE id = ?`,
            [isActive ? 1 : 0, now, id],
            (err) => {
                if (err) reject(err);
                else resolve(true);
            }
        );
    });
}

function updateSessionProfile(id, phoneNumber, pushName) {
    return new Promise((resolve, reject) => {
        const now = Date.now();
        db.run(
            `UPDATE wa_sessions SET phone_number = ?, push_name = ?, updated_at = ? WHERE id = ?`,
            [phoneNumber || null, pushName || null, now, id],
            (err) => {
                if (err) reject(err);
                else resolve(true);
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
                // Also clean message logs and webhook logs
                db.run(`DELETE FROM message_logs WHERE session_id = ?`, [id], () => {});
                db.run(`DELETE FROM webhook_logs WHERE session_id = ?`, [id], () => {});
                resolve(true);
            }
        });
    });
}

// Message Logs Operations
function saveMessageLog({ id, sessionId, type, recipient, payloadPreview, status, errorMessage }) {
    return new Promise((resolve, reject) => {
        const logId = id || crypto.randomUUID();
        const now = Date.now();
        db.run(
            `INSERT INTO message_logs (id, session_id, type, recipient, payload_preview, status, error_message, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [logId, sessionId, type, recipient, payloadPreview || '', status || 'sent', errorMessage || null, now],
            (err) => {
                if (err) {
                    console.error('Error saving message log:', err.message);
                    reject(err);
                } else {
                    resolve(logId);
                }
            }
        );
    });
}

function updateMessageLogStatus(id, { status, errorMessage }) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE message_logs SET status = ?, error_message = ? WHERE id = ?`,
            [status, errorMessage || null, id],
            (err) => {
                if (err) reject(err);
                else resolve(true);
            }
        );
    });
}

function getMessageLogs(sessionId = null, limit = 50, offset = 0) {
    return new Promise((resolve, reject) => {
        let sql = `SELECT * FROM message_logs`;
        const params = [];
        if (sessionId) {
            sql += ` WHERE session_id = ?`;
            params.push(sessionId);
        }
        sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        db.all(sql, params, (err, rows) => {
            if (err) {
                console.error('Error fetching message logs:', err.message);
                reject(err);
            } else {
                resolve(rows || []);
            }
        });
    });
}

function clearMessageLogs(sessionId = null) {
    return new Promise((resolve, reject) => {
        let sql = `DELETE FROM message_logs`;
        const params = [];
        if (sessionId) {
            sql += ` WHERE session_id = ?`;
            params.push(sessionId);
        }
        db.run(sql, params, (err) => {
            if (err) reject(err);
            else resolve(true);
        });
    });
}

// Webhook Delivery Logs Operations (Audit & Delivery Tracking)
function saveWebhookLog({ id, sessionId, event, url, payload, statusCode, responseBody, durationMs, errorMessage }) {
    return new Promise((resolve, reject) => {
        const logId = id || crypto.randomUUID();
        const now = Date.now();
        const payloadStr = typeof payload === 'object' ? JSON.stringify(payload) : (payload || '');
        const respStr = typeof responseBody === 'object' ? JSON.stringify(responseBody) : (responseBody || '');

        db.run(
            `INSERT INTO webhook_logs (id, session_id, event, url, payload, status_code, response_body, duration_ms, error_message, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [logId, sessionId, event, url, payloadStr, statusCode || null, respStr.slice(0, 2000), durationMs || 0, errorMessage || null, now],
            (err) => {
                if (err) {
                    console.error('Error saving webhook log:', err.message);
                    reject(err);
                } else {
                    resolve(logId);
                }
            }
        );
    });
}

function getWebhookLogs(sessionId = null, limit = 50, offset = 0) {
    return new Promise((resolve, reject) => {
        let sql = `SELECT * FROM webhook_logs`;
        const params = [];
        if (sessionId) {
            sql += ` WHERE session_id = ?`;
            params.push(sessionId);
        }
        sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        db.all(sql, params, (err, rows) => {
            if (err) {
                console.error('Error fetching webhook logs:', err.message);
                reject(err);
            } else {
                resolve(rows || []);
            }
        });
    });
}

function clearWebhookLogs(sessionId = null) {
    return new Promise((resolve, reject) => {
        let sql = `DELETE FROM webhook_logs`;
        const params = [];
        if (sessionId) {
            sql += ` WHERE session_id = ?`;
            params.push(sessionId);
        }
        db.run(sql, params, (err) => {
            if (err) reject(err);
            else resolve(true);
        });
    });
}

module.exports = {
    getMasterApiKey,
    generateMasterApiKey,
    generateRandomToken,
    saveLidMapping,
    loadAllLidMappings,
    getSessions,
    getSessionById,
    saveSession,
    deleteSession,
    updateSessionSettings,
    updateSessionState,
    updateSessionProfile,
    saveMessageLog,
    updateMessageLogStatus,
    getMessageLogs,
    clearMessageLogs,
    saveWebhookLog,
    getWebhookLogs,
    clearWebhookLogs
};
