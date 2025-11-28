/**
 * Claude Code Session Discovery
 * Reads existing sessions from Claude Code's project directories
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

class ClaudeSessionDiscovery {
    constructor() {
        this.claudeDir = path.join(os.homedir(), '.claude');
        this.projectsDir = path.join(this.claudeDir, 'projects');
    }

    /**
     * Decode project directory name to actual path
     * e.g., "C--Users-PC-OneDrive---CCLAB" -> "C:/Users/PC/OneDrive - CCLAB"
     */
    decodeProjectPath(encodedName) {
        // Replace double dash with space-dash-space, then single dash with /
        // This is a heuristic - may not be 100% accurate
        let decoded = encodedName
            .replace(/---/g, ' - ')  // triple dash -> space-dash-space
            .replace(/--/g, '/')     // double dash -> /
            .replace(/-/g, '/');     // single dash -> /

        // Fix drive letter (C/Users -> C:/Users)
        if (/^[A-Z]\//.test(decoded)) {
            decoded = decoded.replace(/^([A-Z])\//, '$1:/');
        }

        return decoded;
    }

    /**
     * List all projects with their sessions
     * @returns {Array} List of projects with session info
     */
    listProjects() {
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
                    latestSession: sessions[0]  // Most recent first
                });
            }
        }

        // Sort by most recent activity
        projects.sort((a, b) => {
            const aTime = a.latestSession?.timestamp || '';
            const bTime = b.latestSession?.timestamp || '';
            return bTime.localeCompare(aTime);
        });

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

            // Sort by timestamp descending
            sessions.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

        } catch (e) {
            // Ignore errors
        }

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

            // Parse first line for basic info
            const firstLine = JSON.parse(lines[0]);

            // Get last line for latest timestamp
            const lastLine = JSON.parse(lines[lines.length - 1]);

            // Count messages
            const userMessages = lines.filter(l => {
                try {
                    const obj = JSON.parse(l);
                    return obj.type === 'user';
                } catch {
                    return false;
                }
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
     * @param {number} limit - Max number of sessions to return
     */
    getRecentSessions(limit = 10) {
        const projects = this.listProjects();
        const allSessions = [];

        for (const project of projects) {
            for (const session of project.sessions) {
                allSessions.push({
                    ...session,
                    projectPath: project.path
                });
            }
        }

        // Sort by timestamp and limit
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
