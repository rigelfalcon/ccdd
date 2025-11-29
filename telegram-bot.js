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
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const { callClaude, formatResponse, validateCwd } = require('./claude-caller');
const { SessionManager } = require('./session-manager');
const { ClaudeSessionDiscovery } = require('./claude-session-discovery');

// Security constants
const RATE_LIMIT_WINDOW = 60 * 1000;  // 1 minute
const RATE_LIMIT_MAX = 10;            // Max 10 requests per minute
const MAX_MESSAGE_LENGTH = 10000;     // Max message length

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
        this.bot = null;
        this.isRunning = false;

        // Rate limiting: Map of chatId -> { count, resetTime }
        this.rateLimits = new Map();
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
        // If whitelist not configured
        if (!this.allowedChatIds || this.allowedChatIds.length === 0) {
            // In strict mode, deny all if no whitelist
            if (this.requireAuth) {
                console.log(`[Telegram] Auth denied for ${chatId}: No whitelist configured`);
                return false;
            }
            return true;  // Allow all only if explicitly disabled
        }
        return this.allowedChatIds.includes(String(chatId));
    }

    /**
     * Check rate limit for a chat
     * @returns {boolean} true if allowed, false if rate limited
     */
    checkRateLimit(chatId) {
        const now = Date.now();
        const key = String(chatId);

        if (!this.rateLimits.has(key)) {
            this.rateLimits.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
            return true;
        }

        const limit = this.rateLimits.get(key);

        // Reset if window expired
        if (now > limit.resetTime) {
            this.rateLimits.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
            return true;
        }

        // Check if over limit
        if (limit.count >= RATE_LIMIT_MAX) {
            return false;
        }

        // Increment count
        limit.count++;
        return true;
    }

    /**
     * Validate project path
     * @returns {{valid: boolean, error: string, resolved: string}}
     */
    validateProjectPath(inputPath) {
        if (!inputPath || typeof inputPath !== 'string') {
            return { valid: false, error: 'Path is required', resolved: null };
        }

        const trimmed = inputPath.trim();

        // Check length
        if (trimmed.length > 500) {
            return { valid: false, error: 'Path too long', resolved: null };
        }

        // Check for path traversal
        if (trimmed.includes('..')) {
            return { valid: false, error: 'Path traversal not allowed', resolved: null };
        }

        // Check against blocked patterns
        for (const pattern of BLOCKED_PATHS) {
            if (pattern.test(trimmed)) {
                return { valid: false, error: 'Access to system directories not allowed', resolved: null };
            }
        }

        // Resolve to absolute path
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

        // SECURITY WARNING: Check if authentication is properly configured
        if (this.requireAuth && (!this.allowedChatIds || this.allowedChatIds.length === 0)) {
            console.log('[Telegram] ⚠️  WARNING: No TELEGRAM_ALLOWED_CHAT_IDS configured!');
            console.log('[Telegram] ⚠️  Bot will deny ALL requests until you configure a whitelist.');
            console.log('[Telegram] ⚠️  Send /start to the bot to get your Chat ID, then add it to .env');
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
            console.log('[Telegram] Bot stopped');
        }
    }

    /**
     * Setup message handlers
     */
    setupHandlers() {
        // Command: /start
        this.bot.onText(/\/start/, (msg) => {
            this.handleStart(msg);
        });

        // Command: /help
        this.bot.onText(/\/help/, (msg) => {
            this.handleHelp(msg);
        });

        // Command: /new - new session
        this.bot.onText(/\/new/, (msg) => {
            this.handleNew(msg);
        });

        // Command: /status
        this.bot.onText(/\/status/, (msg) => {
            this.handleStatus(msg);
        });

        // Command: /project <path>
        this.bot.onText(/\/project\s+(.+)/, (msg, match) => {
            this.handleProject(msg, match[1]);
        });

        // Command: /project (no args - show current)
        this.bot.onText(/^\/project$/, (msg) => {
            this.handleProjectShow(msg);
        });

        // Command: /sessions - list Claude Code sessions
        this.bot.onText(/\/sessions/, (msg) => {
            this.handleSessions(msg);
        });

        // Command: /resume <session_id> - resume a session
        this.bot.onText(/\/resume\s+(.+)/, (msg, match) => {
            this.handleResume(msg, match[1]);
        });

        // Command: /projects - list Claude Code projects
        this.bot.onText(/\/projects/, (msg) => {
            this.handleProjects(msg);
        });

        // Regular messages (not commands)
        this.bot.on('message', (msg) => {
            if (!msg.text || msg.text.startsWith('/')) return;
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
/projects - List Claude Code projects
/sessions - List recent sessions
/resume <id> - Resume a session
/help - Show this help

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
/status - Show current session info
/sessions - List recent sessions
/resume <id> - Resume a session

Project Commands:
/project - Show current project
/project <path> - Set project directory
/projects - List all projects

Tips:
- Use /sessions to see all Claude Code sessions
- Use /resume to continue a previous conversation
- Your session is automatically saved
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
        await this.bot.sendMessage(chatId, `Current Status:\n\n${status}`);
    }

    /**
     * Handle /project <path> command
     */
    async handleProject(msg, projectPath) {
        const chatId = msg.chat.id;

        if (!this.isAllowed(chatId)) return;

        // SECURITY: Validate path
        const validation = this.validateProjectPath(projectPath);
        if (!validation.valid) {
            await this.bot.sendMessage(chatId, `Invalid path: ${validation.error}`);
            return;
        }

        // Auto-create directory if it doesn't exist
        const fs = require('fs');
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

        // Check if directory is empty (Claude Code may hang on empty dirs)
        // If empty, create a minimal README.md so Claude Code works properly
        const files = fs.readdirSync(validation.resolved).filter(f => !f.startsWith('.'));
        if (files.length === 0) {
            const readmePath = require('path').join(validation.resolved, 'README.md');
            const dirName = require('path').basename(validation.resolved);
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
     * Handle /sessions - list recent Claude Code sessions
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
     * Handle /resume <session_id> - resume a specific session
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

            // Update session manager with the found session
            this.sessionManager.updateSessionId('telegram', chatId, session.sessionId, session.cwd);

            const msg_text = [
                `Session resumed!`,
                ``,
                `Session: ${session.sessionId.substring(0, 8)}...`,
                `Project: ${session.cwd}`,
                `Messages: ${session.messageCount}`,
                ``,
                `Send a message to continue the conversation.`
            ].join('\n');

            await this.bot.sendMessage(chatId, msg_text);
        } catch (error) {
            await this.bot.sendMessage(chatId, `Error resuming session: ${error.message}`);
        }
    }

    /**
     * Handle /projects - list Claude Code projects
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
     * Handle regular messages - send to Claude Code
     */
    async handleMessage(msg) {
        const chatId = msg.chat.id;
        const text = msg.text;

        // SECURITY: Check authentication
        if (!this.isAllowed(chatId)) {
            await this.bot.sendMessage(chatId,
                `Access denied.\n\nYour Chat ID: ${chatId}\n\nAdd this ID to TELEGRAM_ALLOWED_CHAT_IDS in .env to authorize.`
            );
            return;
        }

        // SECURITY: Check rate limit
        if (!this.checkRateLimit(chatId)) {
            await this.bot.sendMessage(chatId, 'Rate limit exceeded. Please wait a moment.');
            return;
        }

        // SECURITY: Validate input length
        if (text.length > MAX_MESSAGE_LENGTH) {
            await this.bot.sendMessage(chatId, `Message too long. Max ${MAX_MESSAGE_LENGTH} characters.`);
            return;
        }

        // Get session info
        const session = this.sessionManager.getSession('telegram', chatId);
        const projectDir = session?.projectDir || this.defaultProjectDir;
        const sessionId = session?.sessionId || null;

        // Send "typing" indicator
        await this.bot.sendChatAction(chatId, 'typing');

        // Send acknowledgment
        const thinkingMsg = await this.bot.sendMessage(chatId, '🤔 Processing...');

        try {
            // Call Claude Code
            const result = await callClaude(text, {
                cwd: projectDir,
                sessionId: sessionId,
                timeout: 5 * 60 * 1000  // 5 minutes
            });

            // Update session only if successful
            if (result.success && result.sessionId) {
                this.sessionManager.updateSessionId('telegram', chatId, result.sessionId, projectDir);
            } else if (result.invalidSession && sessionId) {
                // Only clear session if it's specifically invalid (not for timeouts or other errors)
                console.log(`[Telegram] Clearing invalid session for ${chatId}`);
                this.sessionManager.clearSession('telegram', chatId);
            }

            // Delete thinking message
            try {
                await this.bot.deleteMessage(chatId, thinkingMsg.message_id);
            } catch (e) { /* Ignore delete errors */ }

            // Format and send response
            const response = formatResponse(result.result, 4000);

            // Split long messages
            if (response.length > 4000) {
                const chunks = this.splitMessage(response, 4000);
                for (const chunk of chunks) {
                    await this.bot.sendMessage(chatId, chunk);
                }
            } else {
                await this.bot.sendMessage(chatId, response);
            }

        } catch (error) {
            // Log error internally but don't expose details
            console.log('[Telegram] Error calling Claude:', error.message);

            // Delete thinking message
            try {
                await this.bot.deleteMessage(chatId, thinkingMsg.message_id);
            } catch (e) { /* Ignore */ }

            // SECURITY: Generic error message (don't leak details)
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

            // Find a good break point
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
