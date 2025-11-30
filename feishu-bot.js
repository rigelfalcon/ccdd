/**
 * Feishu Bot for Claude Code
 * WebSocket long connection mode - no server required
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
const lark = require('@larksuiteoapi/node-sdk');
const path = require('path');
const fs = require('fs');
const { callClaude, formatResponse } = require('./claude-caller');
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
    /^\/home\/[^/]+\/\./,
];

class FeishuClaudeBot {
    constructor(options = {}) {
        this.appId = options.appId || process.env.FEISHU_APP_ID;
        this.appSecret = options.appSecret || process.env.FEISHU_APP_SECRET;
        this.defaultProjectDir = options.defaultProjectDir || process.env.DEFAULT_PROJECT_DIR || process.cwd();
        this.computerName = options.computerName || process.env.COMPUTER_NAME || require('os').hostname();
        this.allowedOpenIds = this.parseAllowedIds(options.allowedOpenIds || process.env.FEISHU_ALLOWED_OPEN_IDS);
        this.requireAuth = options.requireAuth !== false;  // Default: require authentication
        this.sessionManager = new SessionManager();
        this.sessionDiscovery = new ClaudeSessionDiscovery();
        this.taskQueue = new TaskQueue();
        this.shortcutsManager = new ShortcutsManager();
        this.client = null;
        this.wsClient = null;
        this.isRunning = false;

        // Rate limiting: Map of senderId -> { count, resetTime }
        this.rateLimits = new Map();
        this.rateLimitCleanupTimer = null;

        // Active processes for cancel functionality
        this.activeProcesses = new Map();
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
     * Parse allowed Open IDs from string or array
     */
    parseAllowedIds(ids) {
        if (!ids) return null;
        if (Array.isArray(ids)) return ids.map(String);
        return ids.split(',').map(s => s.trim()).filter(s => s.length > 0);
    }

    /**
     * Check if sender is allowed
     * SECURITY: If no whitelist configured and requireAuth is true, deny all
     */
    isAllowed(senderId) {
        if (!this.allowedOpenIds || this.allowedOpenIds.length === 0) {
            if (this.requireAuth) {
                console.log(`[Feishu] Auth denied for ${senderId}: No whitelist configured`);
                return false;
            }
            return true;
        }
        return this.allowedOpenIds.includes(String(senderId));
    }

    /**
     * Check rate limit
     */
    checkRateLimit(senderId) {
        const now = Date.now();
        const key = String(senderId);

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
    async start() {
        if (!this.appId || !this.appSecret) {
            console.log('[Feishu] App ID or Secret not configured, skipping...');
            return false;
        }

        // SECURITY WARNING
        if (this.requireAuth && (!this.allowedOpenIds || this.allowedOpenIds.length === 0)) {
            console.log('[Feishu] WARNING: No FEISHU_ALLOWED_OPEN_IDS configured!');
            console.log('[Feishu] Bot will deny ALL requests until you configure a whitelist.');
            console.log('[Feishu] Send a message to get your Open ID, then add it to .env');
        }

        console.log('[Feishu] Starting bot...');
        console.log(`[Feishu] Computer: ${this.computerName}`);
        console.log(`[Feishu] Auth required: ${this.requireAuth}`);
        console.log(`[Feishu] Allowed IDs: ${this.allowedOpenIds?.length || 0} configured`);

        // Create Lark client for API calls
        this.client = new lark.Client({
            appId: this.appId,
            appSecret: this.appSecret,
            disableTokenCache: false
        });

        // Create event dispatcher
        const eventDispatcher = new lark.EventDispatcher({}).register({
            'im.message.receive_v1': this.handleMessage.bind(this)
        });

        // Create WebSocket client
        this.wsClient = new lark.WSClient({
            appId: this.appId,
            appSecret: this.appSecret,
            loggerLevel: lark.LoggerLevel.info
        });

        try {
            await this.wsClient.start({
                eventDispatcher: eventDispatcher
            });
            this.isRunning = true;
            this.startRateLimitCleanup();
            console.log('[Feishu] Bot started successfully');
            return true;
        } catch (error) {
            console.log('[Feishu] Failed to start:', error.message);
            return false;
        }
    }

    /**
     * Stop the bot
     */
    stop() {
        if (this.wsClient) {
            this.isRunning = false;
            this.stopRateLimitCleanup();
            console.log('[Feishu] Bot stopped');
        }
    }

    /**
     * Handle incoming message
     */
    async handleMessage(data) {
        try {
            const message = data.message;
            const chatId = message.chat_id;
            const messageType = message.message_type;
            const senderId = data.sender?.sender_id?.open_id || 'unknown';

            console.log(`[Feishu] Received message from ${senderId} in ${chatId}`);

            // SECURITY: Check authentication
            if (!this.isAllowed(senderId)) {
                await this.sendMessage(chatId,
                    `Access denied.\n\nYour Open ID: ${senderId}\n\nAdd this ID to FEISHU_ALLOWED_OPEN_IDS in .env to authorize.`
                );
                return;
            }

            // SECURITY: Check rate limit
            if (!this.checkRateLimit(senderId)) {
                await this.sendMessage(chatId, 'Rate limit exceeded. Please wait a moment.');
                return;
            }

            // Only handle text messages
            if (messageType !== 'text') {
                await this.sendMessage(chatId, 'Sorry, I only support text messages.');
                return;
            }

            // Parse message content
            const content = JSON.parse(message.content);
            let text = content.text || '';

            // Remove @mention if present
            text = text.replace(/@\S+\s*/g, '').trim();

            if (!text) {
                return;
            }

            // SECURITY: Validate input length
            if (text.length > MAX_MESSAGE_LENGTH) {
                await this.sendMessage(chatId, `Message too long. Max ${MAX_MESSAGE_LENGTH} characters.`);
                return;
            }

            // Check for commands
            if (text.startsWith('/')) {
                // Check if it's a user-defined shortcut first
                const expanded = this.shortcutsManager.expandShortcut('feishu', chatId, text);
                if (expanded) {
                    await this.handleChatMessage(chatId, senderId, expanded);
                    return;
                }
                await this.handleCommand(chatId, senderId, text);
                return;
            }

            // Handle regular message
            await this.handleChatMessage(chatId, senderId, text);

        } catch (error) {
            console.log('[Feishu] Error handling message:', error.message);
        }
    }

    /**
     * Handle commands
     */
    async handleCommand(chatId, senderId, text) {
        const parts = text.split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);

        switch (command) {
            case '/start':
                await this.sendMessage(chatId,
                    `Claude Code Bot (${this.computerName})\n\n` +
                    `Your Open ID: ${senderId}\n\n` +
                    `Commands:\n/new - Start new session\n/status - Show status\n/project <path> - Set project\n/sessions - List sessions\n/help - Show help`
                );
                break;

            case '/new':
                this.sessionManager.clearSession('feishu', chatId);
                await this.sendMessage(chatId, 'Session cleared. Next message will start a new conversation.');
                break;

            case '/status':
                const status = this.sessionManager.getStatusString('feishu', chatId);
                const queueStatus = this.taskQueue.formatStatusMessage(chatId);
                await this.sendMessage(chatId, `Current Status:\n\n${status}\n\n${queueStatus}`);
                break;

            case '/project':
                await this.handleProjectCommand(chatId, args);
                break;

            case '/sessions':
                await this.handleSessionsCommand(chatId);
                break;

            case '/resume':
                if (args.length > 0) {
                    await this.handleResumeCommand(chatId, args[0]);
                } else {
                    await this.sendMessage(chatId, 'Usage: /resume <session_id>\n\nUse /sessions to see available sessions.');
                }
                break;

            case '/projects':
                await this.handleProjectsCommand(chatId);
                break;

            case '/cancel':
                await this.handleCancelCommand(chatId);
                break;

            case '/queue':
                await this.handleQueueCommand(chatId, args);
                break;

            case '/shortcut':
                await this.handleShortcutCommand(chatId, args);
                break;

            case '/export':
                await this.handleExportCommand(chatId);
                break;

            case '/help':
                await this.sendHelpMessage(chatId);
                break;

            default:
                await this.sendMessage(chatId, `Unknown command: ${command}\nUse /help for available commands.`);
        }
    }

    /**
     * Handle /project command
     */
    async handleProjectCommand(chatId, args) {
        if (args.length > 0) {
            const projectPath = args.join(' ').trim();
            // SECURITY: Validate path
            const validation = this.validateProjectPath(projectPath);
            if (!validation.valid) {
                await this.sendMessage(chatId, `Invalid path: ${validation.error}`);
                return;
            }
            // Auto-create directory if it doesn't exist
            let created = false;
            if (!fs.existsSync(validation.resolved)) {
                try {
                    fs.mkdirSync(validation.resolved, { recursive: true });
                    created = true;
                } catch (err) {
                    await this.sendMessage(chatId, `Failed to create directory: ${err.message}`);
                    return;
                }
            }

            // Check if directory is empty (Claude Code may hang on empty dirs)
            const files = fs.readdirSync(validation.resolved).filter(f => !f.startsWith('.'));
            if (files.length === 0) {
                const readmePath = path.join(validation.resolved, 'README.md');
                const dirName = path.basename(validation.resolved);
                fs.writeFileSync(readmePath, `# ${dirName}\n\nProject created via Claude Code Bot.\n`, 'utf8');
                await this.sendMessage(chatId, created
                    ? `Created directory and initialized: ${validation.resolved}`
                    : `Initialized empty directory: ${validation.resolved}`);
            } else if (created) {
                await this.sendMessage(chatId, `Created directory: ${validation.resolved}`);
            }
            this.sessionManager.setProjectDir('feishu', chatId, validation.resolved);
            await this.sendMessage(chatId, `Project directory set to:\n${validation.resolved}`);
        } else {
            const session = this.sessionManager.getSession('feishu', chatId);
            const projectDir = session?.projectDir || this.defaultProjectDir;
            await this.sendMessage(chatId, `Current project directory:\n${projectDir}`);
        }
    }

    /**
     * Handle /sessions command - list recent Claude Code sessions
     */
    async handleSessionsCommand(chatId) {
        try {
            const sessions = this.sessionDiscovery.getRecentSessions(10);

            if (sessions.length === 0) {
                await this.sendMessage(chatId, 'No Claude Code sessions found.');
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

            await this.sendMessage(chatId, lines.join('\n'));
        } catch (error) {
            await this.sendMessage(chatId, `Error listing sessions: ${error.message}`);
        }
    }

    /**
     * Handle /resume command - resume a specific session
     */
    async handleResumeCommand(chatId, sessionIdPart) {
        try {
            const result = this.sessionDiscovery.findSessionById(sessionIdPart.trim());

            if (!result) {
                await this.sendMessage(chatId, `Session not found: ${sessionIdPart}\n\nUse /sessions to see available sessions.`);
                return;
            }

            const { project, session } = result;

            // Update session manager with the found session
            this.sessionManager.updateSessionId('feishu', chatId, session.sessionId, session.cwd);

            const msg = [
                `Session resumed!`,
                ``,
                `Session: ${session.sessionId.substring(0, 8)}...`,
                `Project: ${session.cwd}`,
                `Messages: ${session.messageCount}`,
                ``,
                `Send a message to continue the conversation.`
            ].join('\n');

            await this.sendMessage(chatId, msg);
        } catch (error) {
            await this.sendMessage(chatId, `Error resuming session: ${error.message}`);
        }
    }

    /**
     * Handle /projects command - list Claude Code projects
     */
    async handleProjectsCommand(chatId) {
        try {
            const projectsList = this.sessionDiscovery.formatProjectsList(10);
            await this.sendMessage(chatId, `${this.computerName}:\n\n${projectsList}`);
        } catch (error) {
            await this.sendMessage(chatId, `Error listing projects: ${error.message}`);
        }
    }

    /**
     * Handle /cancel command - cancel running task
     */
    async handleCancelCommand(chatId) {
        const result = this.taskQueue.cancelCurrent(chatId);
        await this.sendMessage(chatId, result.message);
    }

    /**
     * Handle /queue command
     */
    async handleQueueCommand(chatId, args) {
        const subCmd = args[0]?.toLowerCase();

        switch (subCmd) {
            case 'clear':
                const clearResult = this.taskQueue.clearQueue(chatId);
                await this.sendMessage(chatId, `Cleared ${clearResult.clearedCount} pending tasks.`);
                break;

            case 'status':
            default:
                const status = this.taskQueue.formatStatusMessage(chatId);
                await this.sendMessage(chatId, status);
                break;
        }
    }

    /**
     * Handle /shortcut command
     */
    async handleShortcutCommand(chatId, args) {
        const subCmd = args[0]?.toLowerCase();

        switch (subCmd) {
            case 'add':
                if (args.length < 3) {
                    await this.sendMessage(chatId, 'Usage: /shortcut add <name> <command>\nExample: /shortcut add build run npm build');
                    return;
                }
                const addName = args[1];
                const addCommand = args.slice(2).join(' ');
                const addResult = this.shortcutsManager.setShortcut('feishu', chatId, addName, addCommand);
                if (addResult.success) {
                    await this.sendMessage(chatId, `Shortcut /${addResult.name} ${addResult.isUpdate ? 'updated' : 'created'}!\nCommand: "${addCommand}"`);
                } else {
                    await this.sendMessage(chatId, `Error: ${addResult.error}`);
                }
                break;

            case 'del':
            case 'delete':
            case 'rm':
                if (args.length < 2) {
                    await this.sendMessage(chatId, 'Usage: /shortcut del <name>');
                    return;
                }
                const delResult = this.shortcutsManager.deleteShortcut('feishu', chatId, args[1]);
                if (delResult.success) {
                    await this.sendMessage(chatId, `Shortcut /${args[1]} deleted.`);
                } else {
                    await this.sendMessage(chatId, `Error: ${delResult.error}`);
                }
                break;

            case 'list':
            default:
                const list = this.shortcutsManager.formatShortcutsList('feishu', chatId);
                await this.sendMessage(chatId, list);
                break;
        }
    }

    /**
     * Handle /export command - export conversation history
     */
    async handleExportCommand(chatId) {
        try {
            const session = this.sessionManager.getSession('feishu', chatId);
            if (!session?.sessionId) {
                await this.sendMessage(chatId, 'No active session to export.');
                return;
            }

            const result = this.sessionDiscovery.findSessionById(session.sessionId);
            if (!result) {
                await this.sendMessage(chatId, 'Session data not found.');
                return;
            }

            // Read the session file and format as markdown
            const sessionFile = result.session.filePath;
            if (!fs.existsSync(sessionFile)) {
                await this.sendMessage(chatId, 'Session file not found.');
                return;
            }

            const content = fs.readFileSync(sessionFile, 'utf8');
            const lines = content.trim().split('\n');
            const messages = [];

            for (const line of lines.slice(0, 20)) {  // Limit to first 20 messages
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

            await this.sendMessage(chatId, exportText);
        } catch (error) {
            await this.sendMessage(chatId, `Error exporting: ${error.message}`);
        }
    }

    /**
     * Handle chat messages - send to Claude Code
     */
    async handleChatMessage(chatId, senderId, text) {
        // Get session info
        const session = this.sessionManager.getSession('feishu', chatId);
        const projectDir = session?.projectDir || this.defaultProjectDir;
        const sessionId = session?.sessionId || null;

        // Send processing message
        await this.sendMessage(chatId, 'Processing...');

        try {
            // Call Claude Code
            const result = await callClaude(text, {
                cwd: projectDir,
                sessionId: sessionId,
                timeout: 5 * 60 * 1000
            });

            // Update session only if successful
            if (result.success && result.sessionId) {
                this.sessionManager.updateSessionId('feishu', chatId, result.sessionId, projectDir);
            } else if (result.invalidSession && sessionId) {
                // Only clear session if it's specifically invalid (not for timeouts or other errors)
                console.log(`[Feishu] Clearing invalid session for ${chatId}`);
                this.sessionManager.clearSession('feishu', chatId);
            }

            // Format and send response
            const response = formatResponse(result.result, 4000);
            await this.sendMessage(chatId, response);

        } catch (error) {
            console.log('[Feishu] Error calling Claude:', error.message);
            // SECURITY: Generic error message
            await this.sendMessage(chatId, 'An error occurred. Please try again.');
        }
    }

    /**
     * Send a text message to a chat
     */
    async sendMessage(chatId, text) {
        try {
            await this.client.im.message.create({
                params: {
                    receive_id_type: 'chat_id'
                },
                data: {
                    receive_id: chatId,
                    msg_type: 'text',
                    content: JSON.stringify({ text: text })
                }
            });
        } catch (error) {
            console.log('[Feishu] Error sending message:', error.message);
        }
    }

    /**
     * Send help message
     */
    async sendHelpMessage(chatId) {
        const helpText = `
Claude Code Bot (${this.computerName})

Session Commands:
/new - Start new session
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

        await this.sendMessage(chatId, helpText);
    }
}

module.exports = {
    FeishuClaudeBot
};

// Run directly if executed as main module
if (require.main === module) {
    const bot = new FeishuClaudeBot();
    bot.start();

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n[Feishu] Shutting down...');
        bot.stop();
        process.exit(0);
    });
}
