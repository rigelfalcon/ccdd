/**
 * Claude Code Session Discovery
 * Reads existing sessions from Claude Code's project directories
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Cache TTL in milliseconds
const CACHE_TTL_MS = 30000;

class ClaudeSessionDiscovery {
    constructor() {
        this.claudeDir = path.join(os.homedir(), '.claude');
        this.projectsDir = path.join(this.claudeDir, 'projects');
        this._cache = null;
        this._cacheTime = 0;
    }

    /**
     * Decode project directory name to actual path
     */
    decodeProjectPath(encodedName) {
        let decoded = encodedName
            .replace(/---/g, ' - ')
            .replace(/--/g, '/')
            .replace(/-/g, '/');
        if (/^[A-Z]\//.test(decoded)) {
            decoded = decoded.replace(/^([A-Z])\//, '$1:/');
        }
        return decoded;
    }

    /**
     * Invalidate cache
     */
    invalidateCache() {
        this._cache = null;
        this._cacheTime = 0;
    }

    /**
     * List all projects with their sessions (cached)
     */
    listProjects() {
        const now = Date.now();
        if (this._cache && (now - this._cacheTime) < CACHE_TTL_MS) {
            return this._cache;
        }

        const projects = [];
        if (!fs.existsSync(this.projectsDir)) {
            return projects;
        }

        const dirs = fs.readdirSync(this.projectsDir, { withFileTypes: true });

        for (const dir of dirs) {
            if (!dir.isDirectory()) continue;
            const projectPath = this.decodeProjectPath(dir.name);
            const projectDir = path.join(this.projectsDir, dir.name);
            const sessions = this.getSessionsForProject(projectDir);

            if (sessions.length > 0) {
                projects.push({
                    encodedName: dir.name,
                    path: projectPath,
                    sessions: sessions,
                    latestSession: sessions[0]
                });
            }
        }

        projects.sort((a, b) => {
            const aTime = a.latestSession?.timestamp || '';
            const bTime = b.latestSession?.timestamp || '';
            return bTime.localeCompare(aTime);
        });

        this._cache = projects;
        this._cacheTime = now;
        return projects;
    }

    /**
     * Get sessions for a specific project directory
     */
    getSessionsForProject(projectDir) {
        const sessions = [];
        try {
            const files = fs.readdirSync(projectDir)
                .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'));

            for (const file of files) {
                const filePath = path.join(projectDir, file);
                const session = this.parseSessionFile(filePath);
                if (session) {
                    sessions.push(session);
                }
            }
            sessions.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
        } catch (e) {}
        return sessions;
    }

    /**
     * Parse a session JSONL file to extract session info
     */
    parseSessionFile(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.trim().split('\n').filter(l => l.trim());
            if (lines.length === 0) return null;

            const firstLine = JSON.parse(lines[0]);
            const lastLine = JSON.parse(lines[lines.length - 1]);
            const userMessages = lines.filter(l => {
                try { return JSON.parse(l).type === 'user'; } catch { return false; }
            }).length;

            return {
                sessionId: firstLine.sessionId,
                agentId: firstLine.agentId,
                cwd: firstLine.cwd,
                version: firstLine.version,
                gitBranch: firstLine.gitBranch,
                timestamp: lastLine.timestamp,
                messageCount: lines.length,
                userMessageCount: userMessages,
                filePath: filePath
            };
        } catch (e) {
            return null;
        }
    }

    /**
     * Find session by ID
     */
    findSessionById(sessionId) {
        const projects = this.listProjects();
        for (const project of projects) {
            const session = project.sessions.find(s =>
                s.sessionId === sessionId || s.sessionId.startsWith(sessionId)
            );
            if (session) {
                return { project, session };
            }
        }
        return null;
    }

    /**
     * Get recent sessions across all projects
     */
    getRecentSessions(limit = 10) {
        const projects = this.listProjects();
        const allSessions = [];
        for (const project of projects) {
            for (const session of project.sessions) {
                allSessions.push({ ...session, projectPath: project.path });
            }
        }
        allSessions.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
        return allSessions.slice(0, limit);
    }

    /**
     * Format session info for display
     */
    formatSessionInfo(session, includeDetails = false) {
        const lines = [];
        const shortId = session.sessionId?.substring(0, 8) || 'unknown';
        const date = session.timestamp ? new Date(session.timestamp).toLocaleString() : 'Unknown';
        lines.push(`Session: ${shortId}...`);
        lines.push(`Project: ${session.projectPath || session.cwd}`);
        lines.push(`Last activity: ${date}`);
        if (includeDetails) {
            lines.push(`Messages: ${session.messageCount || 0}`);
            lines.push(`Branch: ${session.gitBranch || 'N/A'}`);
        }
        return lines.join('\n');
    }

    /**
     * Format projects list for display
     */
    formatProjectsList(limit = 5) {
        const projects = this.listProjects().slice(0, limit);
        if (projects.length === 0) {
            return 'No Claude Code projects found.';
        }
        const lines = ['Recent Projects:\n'];
        projects.forEach((project, index) => {
            const shortPath = project.path.length > 40
                ? '...' + project.path.slice(-37)
                : project.path;
            const sessionCount = project.sessions.length;
            const latestDate = project.latestSession?.timestamp
                ? new Date(project.latestSession.timestamp).toLocaleDateString()
                : 'Unknown';
            lines.push(`${index + 1}. ${shortPath}`);
            lines.push(`   Sessions: ${sessionCount}, Last: ${latestDate}`);
        });
        return lines.join('\n');
    }
}

module.exports = {
    ClaudeSessionDiscovery
};
