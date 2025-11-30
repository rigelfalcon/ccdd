/**
 * Session Manager
 * Manages user-to-session mappings for Claude Code interactions
 */

const fs = require('fs');
const path = require('path');

// Debounce delay for saving (ms)
const SAVE_DEBOUNCE_MS = 2000;

class SessionManager {
    constructor(dataFile = null) {
        this.dataFile = dataFile || path.join(__dirname, 'sessions.json');
        this.lockFile = this.dataFile + '.lock';
        this.sessions = this.load();
        this.saveTimer = null;
        this.pendingSave = false;
    }

    /**
     * Load sessions from file
     */
    load() {
        try {
            if (fs.existsSync(this.dataFile)) {
                const data = fs.readFileSync(this.dataFile, 'utf8');
                return JSON.parse(data);
            }
        } catch (e) {
            console.log('[SessionManager] Failed to load sessions:', e.message);
        }
        return {};
    }

    /**
     * Acquire file lock (simple implementation for personal use)
     */
    acquireLock() {
        const maxWait = 5000;
        const start = Date.now();
        while (fs.existsSync(this.lockFile)) {
            try {
                const stat = fs.statSync(this.lockFile);
                if (Date.now() - stat.mtimeMs > 10000) {
                    fs.unlinkSync(this.lockFile);
                    break;
                }
            } catch (e) { break; }
            if (Date.now() - start > maxWait) {
                try { fs.unlinkSync(this.lockFile); } catch (e) {}
                break;
            }
            const waitUntil = Date.now() + 50;
            while (Date.now() < waitUntil) {}
        }
        fs.writeFileSync(this.lockFile, process.pid.toString());
    }

    /**
     * Release file lock
     */
    releaseLock() {
        try { fs.unlinkSync(this.lockFile); } catch (e) {}
    }

    /**
     * Save sessions to file (debounced)
     */
    save() {
        this.pendingSave = true;
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            if (!this.pendingSave) return;
            this.pendingSave = false;
            this._doSave();
        }, SAVE_DEBOUNCE_MS);
    }

    /**
     * Internal save with locking
     */
    _doSave() {
        try {
            this.acquireLock();
            fs.writeFileSync(this.dataFile, JSON.stringify(this.sessions, null, 2));
        } catch (e) {
            console.log('[SessionManager] Failed to save sessions:', e.message);
        } finally {
            this.releaseLock();
        }
    }

    /**
     * Generate a unique key for a user
     */
    getKey(platform, chatId) {
        return `${platform}:${chatId}`;
    }

    /**
     * Get session info for a user
     */
    getSession(platform, chatId) {
        const key = this.getKey(platform, chatId);
        return this.sessions[key] || null;
    }

    /**
     * Set session info for a user
     */
    setSession(platform, chatId, sessionInfo) {
        const key = this.getKey(platform, chatId);
        this.sessions[key] = {
            ...sessionInfo,
            updatedAt: new Date().toISOString()
        };
        this.save();
    }

    /**
     * Update session ID for a user
     */
    updateSessionId(platform, chatId, sessionId, projectDir = null) {
        const key = this.getKey(platform, chatId);
        const existing = this.sessions[key] || {};
        this.sessions[key] = {
            ...existing,
            sessionId: sessionId,
            projectDir: projectDir || existing.projectDir,
            updatedAt: new Date().toISOString()
        };
        this.save();
    }

    /**
     * Set project directory for a user
     */
    setProjectDir(platform, chatId, projectDir) {
        const key = this.getKey(platform, chatId);
        const existing = this.sessions[key] || {};
        this.sessions[key] = {
            ...existing,
            projectDir: projectDir,
            updatedAt: new Date().toISOString()
        };
        this.save();
    }

    /**
     * Clear session for a user (for /new command)
     */
    clearSession(platform, chatId) {
        const key = this.getKey(platform, chatId);
        const existing = this.sessions[key] || {};
        this.sessions[key] = {
            projectDir: existing.projectDir,
            sessionId: null,
            updatedAt: new Date().toISOString()
        };
        this.save();
    }

    /**
     * Get all sessions (for debugging)
     */
    getAllSessions() {
        return this.sessions;
    }

    /**
     * Get status string for a user
     */
    getStatusString(platform, chatId) {
        const session = this.getSession(platform, chatId);
        if (!session) {
            return 'No active session.\nUse /project <path> to set a project directory.';
        }
        const lines = [];
        lines.push(`Project: ${session.projectDir || 'Not set'}`);
        lines.push(`Session: ${session.sessionId ? session.sessionId.substring(0, 8) + '...' : 'None'}`);
        lines.push(`Updated: ${session.updatedAt || 'Unknown'}`);
        return lines.join('\n');
    }
}

module.exports = {
    SessionManager
};
