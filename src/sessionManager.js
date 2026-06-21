const EventEmitter = require('events');
const WAManager = require('./wa');
const db = require('./db');

class SessionManager extends EventEmitter {
    constructor() {
        super();
        this.sessions = new Map();
    }

    async init() {
        const savedSessions = await db.getSessions();
        console.log(`[SessionManager] Loading ${savedSessions.length} saved sessions...`);
        for (const session of savedSessions) {
            try {
                const manager = await this.createSession(session.id, session.name);
                manager.webhookUrl = session.webhook_url;
                manager.apiKey = session.api_key;
            } catch (err) {
                console.error(`[SessionManager] Failed to auto-restore session ${session.id}:`, err.message);
            }
        }
    }

    async createSession(id, name) {
        if (this.sessions.has(id)) {
            return this.sessions.get(id);
        }

        const cleanId = id.replace(/[^a-zA-Z0-9_-]/g, '');
        if (!cleanId) throw new Error('Invalid session ID');

        const manager = new WAManager(cleanId, name);
        manager.webhookUrl = null;
        manager.apiKey = null;
        this.sessions.set(cleanId, manager);

        // Forward status updates to global listeners
        manager.on('statusUpdate', (data) => {
            this.emit('statusUpdate', data);
        });

        // Save to Database if not already there
        await db.saveSession(cleanId, name);

        // Trigger Connection in background
        manager.connect().catch(err => {
            console.error(`[SessionManager] Error connecting session ${cleanId}:`, err.message);
        });

        return manager;
    }

    getSession(id) {
        return this.sessions.get(id);
    }

    getAllSessions() {
        return Array.from(this.sessions.values()).map(manager => ({
            id: manager.sessionId,
            name: manager.sessionName,
            status: manager.status,
            qrCode: manager.qrCode,
            webhookUrl: manager.webhookUrl,
            apiKey: manager.apiKey
        }));
    }

    async deleteSession(id) {
        const manager = this.sessions.get(id);
        if (manager) {
            manager.destroy();
            this.sessions.delete(id);
        }
        await db.deleteSession(id);
        return true;
    }
}

const sessionManager = new SessionManager();
module.exports = sessionManager;