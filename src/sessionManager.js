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
                const manager = await this.createSession(session.id, session.name, false);
                manager.phoneNumber = session.phone_number || null;
                manager.pushName = session.push_name || null;
                manager.isActive = session.is_active !== undefined ? session.is_active : 1;
                manager.webhookUrl = session.webhook_url || null;
                manager.webhookSecret = session.webhook_secret || null;
                manager.apiKey = session.api_key || null;
                
                try {
                    manager.webhookEvents = session.webhook_events ? JSON.parse(session.webhook_events) : ['message.received', 'message.status'];
                } catch (e) {
                    manager.webhookEvents = ['message.received', 'message.status'];
                }

                if (manager.isActive === 1) {
                    manager.connect().catch(err => {
                        console.error(`[SessionManager] Error auto-connecting session ${session.id}:`, err.message);
                    });
                } else {
                    manager.setStatus('PAUSED');
                    console.log(`[SessionManager] Session ${session.id} is paused. Skipping auto-connect.`);
                }
            } catch (err) {
                console.error(`[SessionManager] Failed to auto-restore session ${session.id}:`, err.message);
            }
        }
    }

    async createSession(id, name, autoConnect = true) {
        if (this.sessions.has(id)) {
            return this.sessions.get(id);
        }

        const cleanId = id.replace(/[^a-zA-Z0-9_-]/g, '');
        if (!cleanId) throw new Error('Invalid session ID format');

        const manager = new WAManager(cleanId, name);
        this.sessions.set(cleanId, manager);

        // Forward status updates to global listeners
        manager.on('statusUpdate', (data) => {
            this.emit('statusUpdate', data);
        });

        // Save to Database if creating a brand new session
        const dbResult = await db.saveSession(cleanId, name);
        if (dbResult && dbResult.apiKey) {
            manager.apiKey = dbResult.apiKey;
            manager.webhookSecret = dbResult.webhookSecret;
        }

        if (autoConnect) {
            manager.connect().catch(err => {
                console.error(`[SessionManager] Error connecting session ${cleanId}:`, err.message);
            });
        }

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
            isActive: manager.isActive,
            phoneNumber: manager.phoneNumber,
            pushName: manager.pushName,
            qrCode: manager.qrCode,
            webhookUrl: manager.webhookUrl,
            webhookSecret: manager.webhookSecret,
            webhookEvents: manager.webhookEvents,
            apiKey: manager.apiKey
        }));
    }

    async pauseSession(id) {
        const manager = this.sessions.get(id);
        if (!manager) throw new Error(`Session '${id}' not found`);
        return await manager.pause();
    }

    async resumeSession(id) {
        const manager = this.sessions.get(id);
        if (!manager) throw new Error(`Session '${id}' not found`);
        return await manager.resume();
    }

    async reconnectSession(id) {
        const manager = this.sessions.get(id);
        if (!manager) throw new Error(`Session '${id}' not found`);
        return await manager.reconnect();
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
