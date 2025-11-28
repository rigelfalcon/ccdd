/**
 * Session Manager
 * Manages user-to-session mappings for Claude Code interactions
 */

const fs = require('fs');
const path = require('path');

class SessionManager {
    constructor(dataFile = null) {
        this.dataFile = dataFile || path.join(__dirname, 'sessions.json');
        this.sessions = this.load();
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
     * Save sessions to file
     */
    save() {
        try {
            fs.writeFileSync(this.dataFile, JSON.stringify(this.sessions, null, 2));
        } catch (e) {
            console.log('[SessionManager] Failed to save sessions:', e.message);
        }
    }

    /**
     * Generate a unique key for a user
     * @param {string} platform - 'telegram' or 'feishu'
     * @param {string} chatId - Chat/User ID
     * @returns {string} Unique key
     */
    getKey(platform, chatId) {
        return `${platform}:${chatId}`;
    }

    /**
     * Get session info for a user
     * @param {string} platform - Platform name
     * @param {string} chatId - Chat ID
     * @returns {Object|null} Session info
     */
    getSession(platform, chatId) {
        const key = this.getKey(platform, chatId);
        return this.sessions[key] || null;
    }

    /**
     * Set session info for a user
     * @param {string} platform - Platform name
     * @param {string} chatId - Chat ID
     * @param {Object} sessionInfo - Session information
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
     * @param {string} platform - Platform name
     * @param {string} chatId - Chat ID
     * @param {string} sessionId - New session ID
     * @param {string} projectDir - Project directory
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
     * @param {string} platform - Platform name
     * @param {string} chatId - Chat ID
     * @param {string} projectDir - Project directory
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
     * @param {string} platform - Platform name
     * @param {string} chatId - Chat ID
     */
    clearSession(platform, chatId) {
        const key = this.getKey(platform, chatId);
        const existing = this.sessions[key] || {};

        // Keep projectDir but clear sessionId
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
     * @param {string} platform - Platform name
     * @param {string} chatId - Chat ID
     * @returns {string} Status message
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
