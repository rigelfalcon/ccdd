/**
 * Telegram Bot for Claude Code
 * Long polling mode - no server required
 *
 * SECURITY FEATURES:
 * - Mandatory authentication (whitelist required)
 * - Rate limiting (10 requests/minute per user)
 * - Path validation (prevents traversal attacks)
 * - Input length validation
 * - Sanitized error messages
 * - Task queue with limits
 * - Shortcut command validation
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const { callClaude, formatResponse, validateCwd } = require('./claude-caller');
const { SessionManager } = require('./session-manager');
const { ClaudeSessionDiscovery } = require('./claude-session-discovery');
const { TaskQueue } = require('./task-queue');
const { ShortcutsManager } = require('./shortcuts-manager');

// Security constants
const RATE_LIMIT_WINDOW = 60 * 1000;  // 1 minute
const RATE_LIMIT_MAX = 10;            // Max 10 requests per minute
const MAX_MESSAGE_LENGTH = 10000;     // Max message length
const RATE_LIMIT_CLEANUP_INTERVAL = 5 * 60 * 1000;  // Cleanup every 5 minutes

// Blocked path patterns (system directories)
const BLOCKED_PATHS = [
    /^[A-Z]:\\Windows/i,
    /^[A-Z]:\\Program Files/i,
    /^[A-Z]:\\ProgramData/i,
    /^\/etc/,
    /^\/usr/,
    /^\/bin/,
    /^\/sbin/,
    /^\/var/,
    /^\/root/,
    /^\/home\/[^/]+\/\./,  // Hidden files in home
];

class TelegramClaudeBot {
    constructor(options = {}) {
        this.token = options.token || process.env.TELEGRAM_BOT_TOKEN;
        this.allowedChatIds = this.parseAllowedIds(options.allowedChatIds || process.env.TELEGRAM_ALLOWED_CHAT_IDS);
        this.defaultProjectDir = options.defaultProjectDir || process.env.DEFAULT_PROJECT_DIR || process.cwd();
        this.computerName = options.computerName || process.env.COMPUTER_NAME || require('os').hostname();
        this.requireAuth = options.requireAuth !== false;  // Default: require authentication
        this.sessionManager = new SessionManager();
        this.sessionDiscovery = new ClaudeSessionDiscovery();
        this.taskQueue = new TaskQueue();
        this.shortcutsManager = new ShortcutsManager();
        this.bot = null;
        this.isRunning = false;

        // Rate limiting: Map of chatId -> { count, resetTime }
        this.rateLimits = new Map();
        this.rateLimitCleanupTimer = null;
    }

    /**
     * Start rate limit cleanup timer
     */
    startRateLimitCleanup() {
        this.rateLimitCleanupTimer = setInterval(() => {
            const now = Date.now();
            for (const [key, limit] of this.rateLimits) {
                if (now > limit.resetTime) {
                    this.rateLimits.delete(key);
                }
            }
        }, RATE_LIMIT_CLEANUP_INTERVAL);
    }

    /**
     * Stop rate limit cleanup timer
     */
    stopRateLimitCleanup() {
        if (this.rateLimitCleanupTimer) {
            clearInterval(this.rateLimitCleanupTimer);
            this.rateLimitCleanupTimer = null;
        }
    }

    /**
     * Parse allowed chat IDs from string or array
     */
    parseAllowedIds(ids) {
        if (!ids) return null;
        if (Array.isArray(ids)) return ids.map(String);
        return ids.split(',').map(s => s.trim()).filter(s => s.length > 0);
    }

    /**
     * Check if chat is allowed
     * SECURITY: If no whitelist configured and requireAuth is true, deny all
     */
    isAllowed(chatId) {
        if (!this.allowedChatIds || this.allowedChatIds.length === 0) {
            if (this.requireAuth) {
                console.log(`[Telegram] Auth denied for ${chatId}: No whitelist configured`);
                return false;
            }
            return true;
        }
        return this.allowedChatIds.includes(String(chatId));
    }

    /**
     * Check rate limit for a chat
     */
    checkRateLimit(chatId) {
        const now = Date.now();
        const key = String(chatId);

        if (!this.rateLimits.has(key)) {
            this.rateLimits.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
            return true;
        }

        const limit = this.rateLimits.get(key);

        if (now > limit.resetTime) {
            this.rateLimits.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
            return true;
        }

        if (limit.count >= RATE_LIMIT_MAX) {
            return false;
        }

        limit.count++;
        return true;
    }

    /**
     * Validate project path
     */
    validateProjectPath(inputPath) {
        if (!inputPath || typeof inputPath !== 'string') {
            return { valid: false, error: 'Path is required', resolved: null };
        }

        const trimmed = inputPath.trim();

        if (trimmed.length > 500) {
            return { valid: false, error: 'Path too long', resolved: null };
        }

        if (trimmed.includes('..')) {
            return { valid: false, error: 'Path traversal not allowed', resolved: null };
        }

        for (const pattern of BLOCKED_PATHS) {
            if (pattern.test(trimmed)) {
                return { valid: false, error: 'Access to system directories not allowed', resolved: null };
            }
        }

        const resolved = path.resolve(trimmed);
        return { valid: true, error: null, resolved };
    }

    /**
     * Start the bot
     */
    start() {
        if (!this.token) {
            console.log('[Telegram] Bot token not configured, skipping...');
            return false;
        }

        if (this.requireAuth && (!this.allowedChatIds || this.allowedChatIds.length === 0)) {
            console.log('[Telegram] WARNING: No TELEGRAM_ALLOWED_CHAT_IDS configured!');
            console.log('[Telegram] Bot will deny ALL requests until you configure a whitelist.');
            console.log('[Telegram] Send /start to the bot to get your Chat ID, then add it to .env');
        }

        console.log('[Telegram] Starting bot...');
        console.log(`[Telegram] Computer: ${this.computerName}`);
        console.log(`[Telegram] Auth required: ${this.requireAuth}`);
        console.log(`[Telegram] Allowed IDs: ${this.allowedChatIds?.length || 0} configured`);

        this.bot = new TelegramBot(this.token, {
            polling: {
                interval: 1000,
                autoStart: true,
                params: {
                    timeout: 10
                }
            }
        });

        this.setupHandlers();
        this.isRunning = true;
        this.startRateLimitCleanup();
        console.log('[Telegram] Bot started successfully');
        return true;
    }

    /**
     * Stop the bot
     */
    stop() {
        if (this.bot) {
            this.bot.stopPolling();
            this.isRunning = false;
            this.stopRateLimitCleanup();
            console.log('[Telegram] Bot stopped');
        }
    }

    /**
     * Setup message handlers
     */
    setupHandlers() {
        // Command: /start
        this.bot.onText(/\/start/, (msg) => this.handleStart(msg));

        // Command: /help
        this.bot.onText(/\/help/, (msg) => this.handleHelp(msg));

        // Command: /new - new session
        this.bot.onText(/\/new/, (msg) => this.handleNew(msg));

        // Command: /status
        this.bot.onText(/\/status/, (msg) => this.handleStatus(msg));

        // Command: /project <path>
        this.bot.onText(/\/project\s+(.+)/, (msg, match) => this.handleProject(msg, match[1]));

        // Command: /project (no args - show current)
        this.bot.onText(/^\/project$/, (msg) => this.handleProjectShow(msg));

        // Command: /sessions - list Claude Code sessions
        this.bot.onText(/\/sessions/, (msg) => this.handleSessions(msg));

        // Command: /resume <session_id> - resume a session
        this.bot.onText(/\/resume\s+(.+)/, (msg, match) => this.handleResume(msg, match[1]));

        // Command: /projects - list Claude Code projects
        this.bot.onText(/\/projects/, (msg) => this.handleProjects(msg));

        // Command: /cancel - cancel running task
        this.bot.onText(/\/cancel/, (msg) => this.handleCancel(msg));

        // Command: /queue - show/manage queue
        this.bot.onText(/\/queue\s*(.*)/, (msg, match) => this.handleQueue(msg, match[1]));

        // Command: /shortcut - manage shortcuts
        this.bot.onText(/\/shortcut\s*(.*)/, (msg, match) => this.handleShortcut(msg, match[1]));

        // Command: /export - export conversation
        this.bot.onText(/\/export/, (msg) => this.handleExport(msg));

        // Regular messages (not commands)
        this.bot.on('message', (msg) => {
            if (!msg.text) return;

            // Skip if it's a known command
            if (msg.text.match(/^\/(start|help|new|status|project|sessions|resume|projects|cancel|queue|shortcut|export)/)) {
                return;
            }

            // Check if it starts with / - might be a user shortcut
            if (msg.text.startsWith('/')) {
                const expanded = this.shortcutsManager.expandShortcut('telegram', msg.chat.id, msg.text);
                if (expanded) {
                    this.handleMessage(msg, expanded);
                    return;
                }
            }

            this.handleMessage(msg);
        });

        // Error handling
        this.bot.on('polling_error', (error) => {
            console.log('[Telegram] Polling error:', error.message);
        });
    }

    /**
     * Handle /start command
     */
    async handleStart(msg) {
        const chatId = msg.chat.id;

        if (!this.isAllowed(chatId)) {
            await this.bot.sendMessage(chatId,
                `Access Denied.\n\nYour Chat ID: ${chatId}\n\nTo authorize, add this ID to TELEGRAM_ALLOWED_CHAT_IDS in .env`
            );
            return;
        }

        const welcomeMessage = `
Welcome to Claude Code Bot!

Computer: ${this.computerName}
Your Chat ID: ${chatId}

Commands:
/new - Start a new session
/status - Show current session info
/project <path> - Set project directory
/sessions - List recent sessions
/cancel - Cancel running task
/shortcut - Manage shortcuts
/help - Show all commands

Just send a message to start chatting!
        `.trim();

        await this.bot.sendMessage(chatId, welcomeMessage);
    }

    /**
     * Handle /help command
     */
    async handleHelp(msg) {
        const chatId = msg.chat.id;

        if (!this.isAllowed(chatId)) return;

        const helpMessage = `
Claude Code Bot (${this.computerName})

Session Commands:
/new - Start a new session
/status - Show current status
/sessions - List recent sessions
/resume <id> - Resume a session

Project Commands:
/project - Show current project
/project <path> - Set project directory
/projects - List all projects

Task Commands:
/cancel - Cancel running task
/queue - Show task queue
/queue clear - Clear pending tasks

Shortcut Commands:
/shortcut list - List your shortcuts
/shortcut add <name> <cmd> - Create shortcut
/shortcut del <name> - Delete shortcut

Other:
/export - Export conversation
/help - Show this help
        `.trim();

        await this.bot.sendMessage(chatId, helpMessage);
    }

    /**
     * Handle /new command
     */
    async handleNew(msg) {
        const chatId = msg.chat.id;
        if (!this.isAllowed(chatId)) return;

        this.sessionManager.clearSession('telegram', chatId);
        await this.bot.sendMessage(chatId, 'Session cleared. Next message will start a new conversation.');
    }

    /**
     * Handle /status command
     */
    async handleStatus(msg) {
        const chatId = msg.chat.id;
        if (!this.isAllowed(chatId)) return;

        const status = this.sessionManager.getStatusString('telegram', chatId);
        const queueStatus = this.taskQueue.formatStatusMessage(chatId);
        await this.bot.sendMessage(chatId, `Current Status:\n\n${status}\n\n${queueStatus}`);
    }

    /**
     * Handle /project <path> command
     */
    async handleProject(msg, projectPath) {
        const chatId = msg.chat.id;
        if (!this.isAllowed(chatId)) return;

        const validation = this.validateProjectPath(projectPath);
        if (!validation.valid) {
            await this.bot.sendMessage(chatId, `Invalid path: ${validation.error}`);
            return;
        }

        let created = false;
        if (!fs.existsSync(validation.resolved)) {
            try {
                fs.mkdirSync(validation.resolved, { recursive: true });
                created = true;
            } catch (err) {
                await this.bot.sendMessage(chatId, `Failed to create directory: ${err.message}`);
                return;
            }
        }

        const files = fs.readdirSync(validation.resolved).filter(f => !f.startsWith('.'));
        if (files.length === 0) {
            const readmePath = path.join(validation.resolved, 'README.md');
            const dirName = path.basename(validation.resolved);
            fs.writeFileSync(readmePath, `# ${dirName}\n\nProject created via Claude Code Bot.\n`, 'utf8');
            await this.bot.sendMessage(chatId, created
                ? `Created directory and initialized: ${validation.resolved}`
                : `Initialized empty directory: ${validation.resolved}`);
        } else if (created) {
            await this.bot.sendMessage(chatId, `Created directory: ${validation.resolved}`);
        }

        this.sessionManager.setProjectDir('telegram', chatId, validation.resolved);
        await this.bot.sendMessage(chatId, `Project directory set to:\n${validation.resolved}`);
    }

    /**
     * Handle /project (show current)
     */
    async handleProjectShow(msg) {
        const chatId = msg.chat.id;
        if (!this.isAllowed(chatId)) return;

        const session = this.sessionManager.getSession('telegram', chatId);
        const projectDir = session?.projectDir || this.defaultProjectDir;
        await this.bot.sendMessage(chatId, `Current project directory:\n${projectDir}`);
    }

    /**
     * Handle /sessions command
     */
    async handleSessions(msg) {
        const chatId = msg.chat.id;
        if (!this.isAllowed(chatId)) return;

        try {
            const sessions = this.sessionDiscovery.getRecentSessions(10);

            if (sessions.length === 0) {
                await this.bot.sendMessage(chatId, 'No Claude Code sessions found.');
                return;
            }

            const lines = [`Recent Sessions (${this.computerName}):\n`];

            sessions.forEach((session, index) => {
                const shortId = session.sessionId?.substring(0, 8) || 'unknown';
                const shortPath = session.projectPath?.split(/[/\\]/).slice(-2).join('/') || 'Unknown';
                const date = session.timestamp
                    ? new Date(session.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
                    : 'Unknown';

                lines.push(`${index + 1}. [${shortId}] ${shortPath}`);
                lines.push(`   ${date}`);
            });

            lines.push('\nUse /resume <id> to continue a session');

            await this.bot.sendMessage(chatId, lines.join('\n'));
        } catch (error) {
            await this.bot.sendMessage(chatId, `Error listing sessions: ${error.message}`);
        }
    }

    /**
     * Handle /resume command
     */
    async handleResume(msg, sessionIdPart) {
        const chatId = msg.chat.id;
        if (!this.isAllowed(chatId)) return;

        try {
            const result = this.sessionDiscovery.findSessionById(sessionIdPart.trim());

            if (!result) {
                await this.bot.sendMessage(chatId, `Session not found: ${sessionIdPart}\n\nUse /sessions to see available sessions.`);
                return;
            }

            const { project, session } = result;
            this.sessionManager.updateSessionId('telegram', chatId, session.sessionId, session.cwd);

            const msgText = [
                `Session resumed!`,
                ``,
                `Session: ${session.sessionId.substring(0, 8)}...`,
                `Project: ${session.cwd}`,
                `Messages: ${session.messageCount}`,
                ``,
                `Send a message to continue the conversation.`
            ].join('\n');

            await this.bot.sendMessage(chatId, msgText);
        } catch (error) {
            await this.bot.sendMessage(chatId, `Error resuming session: ${error.message}`);
        }
    }

    /**
     * Handle /projects command
     */
    async handleProjects(msg) {
        const chatId = msg.chat.id;
        if (!this.isAllowed(chatId)) return;

        try {
            const projectsList = this.sessionDiscovery.formatProjectsList(10);
            await this.bot.sendMessage(chatId, `${this.computerName}:\n\n${projectsList}`);
        } catch (error) {
            await this.bot.sendMessage(chatId, `Error listing projects: ${error.message}`);
        }
    }

    /**
     * Handle /cancel command
     */
    async handleCancel(msg) {
        const chatId = msg.chat.id;
        if (!this.isAllowed(chatId)) return;

        const result = this.taskQueue.cancelCurrent(chatId);
        await this.bot.sendMessage(chatId, result.message);
    }

    /**
     * Handle /queue command
     */
    async handleQueue(msg, args) {
        const chatId = msg.chat.id;
        if (!this.isAllowed(chatId)) return;

        const subCmd = args?.trim().toLowerCase();

        switch (subCmd) {
            case 'clear':
                const clearResult = this.taskQueue.clearQueue(chatId);
                await this.bot.sendMessage(chatId, `Cleared ${clearResult.clearedCount} pending tasks.`);
                break;

            case 'status':
            default:
                const status = this.taskQueue.formatStatusMessage(chatId);
                await this.bot.sendMessage(chatId, status);
                break;
        }
    }

    /**
     * Handle /shortcut command
     */
    async handleShortcut(msg, args) {
        const chatId = msg.chat.id;
        if (!this.isAllowed(chatId)) return;

        const parts = args?.trim().split(/\s+/) || [];
        const subCmd = parts[0]?.toLowerCase();

        switch (subCmd) {
            case 'add':
                if (parts.length < 3) {
                    await this.bot.sendMessage(chatId, 'Usage: /shortcut add <name> <command>\nExample: /shortcut add build run npm build');
                    return;
                }
                const addName = parts[1];
                const addCommand = parts.slice(2).join(' ');
                const addResult = this.shortcutsManager.setShortcut('telegram', chatId, addName, addCommand);
                if (addResult.success) {
                    await this.bot.sendMessage(chatId, `Shortcut /${addResult.name} ${addResult.isUpdate ? 'updated' : 'created'}!\nCommand: "${addCommand}"`);
                } else {
                    await this.bot.sendMessage(chatId, `Error: ${addResult.error}`);
                }
                break;

            case 'del':
            case 'delete':
            case 'rm':
                if (parts.length < 2) {
                    await this.bot.sendMessage(chatId, 'Usage: /shortcut del <name>');
                    return;
                }
                const delResult = this.shortcutsManager.deleteShortcut('telegram', chatId, parts[1]);
                if (delResult.success) {
                    await this.bot.sendMessage(chatId, `Shortcut /${parts[1]} deleted.`);
                } else {
                    await this.bot.sendMessage(chatId, `Error: ${delResult.error}`);
                }
                break;

            case 'list':
            default:
                const list = this.shortcutsManager.formatShortcutsList('telegram', chatId);
                await this.bot.sendMessage(chatId, list);
                break;
        }
    }

    /**
     * Handle /export command
     */
    async handleExport(msg) {
        const chatId = msg.chat.id;
        if (!this.isAllowed(chatId)) return;

        try {
            const session = this.sessionManager.getSession('telegram', chatId);
            if (!session?.sessionId) {
                await this.bot.sendMessage(chatId, 'No active session to export.');
                return;
            }

            const result = this.sessionDiscovery.findSessionById(session.sessionId);
            if (!result) {
                await this.bot.sendMessage(chatId, 'Session data not found.');
                return;
            }

            const sessionFile = result.session.filePath;
            if (!fs.existsSync(sessionFile)) {
                await this.bot.sendMessage(chatId, 'Session file not found.');
                return;
            }

            const content = fs.readFileSync(sessionFile, 'utf8');
            const lines = content.trim().split('\n');
            const messages = [];

            for (const line of lines.slice(0, 20)) {
                try {
                    const obj = JSON.parse(line);
                    if (obj.type === 'user') {
                        messages.push(`**User:** ${obj.message?.substring(0, 200)}...`);
                    } else if (obj.type === 'assistant') {
                        messages.push(`**Assistant:** ${obj.message?.substring(0, 200)}...`);
                    }
                } catch (e) { /* skip invalid lines */ }
            }

            const exportText = [
                `Session Export`,
                `ID: ${session.sessionId.substring(0, 8)}...`,
                `Project: ${session.projectDir}`,
                `Total messages: ${lines.length}`,
                ``,
                `Recent messages:`,
                ...messages.slice(-10)
            ].join('\n');

            await this.bot.sendMessage(chatId, exportText);
        } catch (error) {
            await this.bot.sendMessage(chatId, `Error exporting: ${error.message}`);
        }
    }

    /**
     * Handle regular messages - send to Claude Code
     */
    async handleMessage(msg, overrideText = null) {
        const chatId = msg.chat.id;
        const text = overrideText || msg.text;

        if (!this.isAllowed(chatId)) {
            await this.bot.sendMessage(chatId,
                `Access denied.\n\nYour Chat ID: ${chatId}\n\nAdd this ID to TELEGRAM_ALLOWED_CHAT_IDS in .env to authorize.`
            );
            return;
        }

        if (!this.checkRateLimit(chatId)) {
            await this.bot.sendMessage(chatId, 'Rate limit exceeded. Please wait a moment.');
            return;
        }

        if (text.length > MAX_MESSAGE_LENGTH) {
            await this.bot.sendMessage(chatId, `Message too long. Max ${MAX_MESSAGE_LENGTH} characters.`);
            return;
        }

        const session = this.sessionManager.getSession('telegram', chatId);
        const projectDir = session?.projectDir || this.defaultProjectDir;
        const sessionId = session?.sessionId || null;

        await this.bot.sendChatAction(chatId, 'typing');
        const thinkingMsg = await this.bot.sendMessage(chatId, 'Processing...');

        try {
            const result = await callClaude(text, {
                cwd: projectDir,
                sessionId: sessionId,
                timeout: 5 * 60 * 1000
            });

            if (result.success && result.sessionId) {
                this.sessionManager.updateSessionId('telegram', chatId, result.sessionId, projectDir);
            } else if (result.invalidSession && sessionId) {
                console.log(`[Telegram] Clearing invalid session for ${chatId}`);
                this.sessionManager.clearSession('telegram', chatId);
            }

            try {
                await this.bot.deleteMessage(chatId, thinkingMsg.message_id);
            } catch (e) { /* Ignore delete errors */ }

            const response = formatResponse(result.result, 4000);

            if (response.length > 4000) {
                const chunks = this.splitMessage(response, 4000);
                for (const chunk of chunks) {
                    await this.bot.sendMessage(chatId, chunk);
                }
            } else {
                await this.bot.sendMessage(chatId, response);
            }

        } catch (error) {
            console.log('[Telegram] Error calling Claude:', error.message);

            try {
                await this.bot.deleteMessage(chatId, thinkingMsg.message_id);
            } catch (e) { /* Ignore */ }

            await this.bot.sendMessage(chatId, 'An error occurred. Please try again.');
        }
    }

    /**
     * Split long message into chunks
     */
    splitMessage(text, maxLength) {
        const chunks = [];
        let remaining = text;

        while (remaining.length > 0) {
            if (remaining.length <= maxLength) {
                chunks.push(remaining);
                break;
            }

            let breakPoint = remaining.lastIndexOf('\n', maxLength);
            if (breakPoint === -1 || breakPoint < maxLength / 2) {
                breakPoint = remaining.lastIndexOf(' ', maxLength);
            }
            if (breakPoint === -1 || breakPoint < maxLength / 2) {
                breakPoint = maxLength;
            }

            chunks.push(remaining.substring(0, breakPoint));
            remaining = remaining.substring(breakPoint).trim();
        }

        return chunks;
    }
}

module.exports = {
    TelegramClaudeBot
};

// Run directly if executed as main module
if (require.main === module) {
    const bot = new TelegramClaudeBot();
    bot.start();

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n[Telegram] Shutting down...');
        bot.stop();
        process.exit(0);
    });
}
