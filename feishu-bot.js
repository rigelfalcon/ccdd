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
 */

require('dotenv').config();
const lark = require('@larksuiteoapi/node-sdk');
const path = require('path');
const { callClaude, formatResponse } = require('./claude-caller');
const { SessionManager } = require('./session-manager');

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
        this.client = null;
        this.wsClient = null;
        this.isRunning = false;

        // Rate limiting: Map of senderId -> { count, resetTime }
        this.rateLimits = new Map();
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
            console.log('[Feishu] ⚠️  WARNING: No FEISHU_ALLOWED_OPEN_IDS configured!');
            console.log('[Feishu] ⚠️  Bot will deny ALL requests until you configure a whitelist.');
            console.log('[Feishu] ⚠️  Send a message to get your Open ID, then add it to .env');
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
        const [command, ...args] = text.split(' ');

        switch (command.toLowerCase()) {
            case '/start':
                await this.sendMessage(chatId,
                    `Claude Code Bot (${this.computerName})\n\n` +
                    `Your Open ID: ${senderId}\n\n` +
                    `Commands:\n/new - Start new session\n/status - Show status\n/project <path> - Set project\n/help - Show help`
                );
                break;

            case '/new':
                this.sessionManager.clearSession('feishu', chatId);
                await this.sendMessage(chatId, 'Session cleared. Next message will start a new conversation.');
                break;

            case '/status':
                const status = this.sessionManager.getStatusString('feishu', chatId);
                await this.sendMessage(chatId, `Current Status:\n\n${status}`);
                break;

            case '/project':
                if (args.length > 0) {
                    const projectPath = args.join(' ').trim();
                    // SECURITY: Validate path
                    const validation = this.validateProjectPath(projectPath);
                    if (!validation.valid) {
                        await this.sendMessage(chatId, `Invalid path: ${validation.error}`);
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
                            await this.sendMessage(chatId, `Failed to create directory: ${err.message}`);
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
                break;

            case '/help':
                await this.sendHelpMessage(chatId);
                break;

            default:
                await this.sendMessage(chatId, `Unknown command: ${command}\nUse /help for available commands.`);
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
        await this.sendMessage(chatId, '🤔 Processing...');

        try {
            // Call Claude Code
            const result = await callClaude(text, {
                cwd: projectDir,
                sessionId: sessionId,
                timeout: 5 * 60 * 1000
            });

            // Update session
            if (result.sessionId) {
                this.sessionManager.updateSessionId('feishu', chatId, result.sessionId, projectDir);
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

Commands:
/start - Show bot info and your Open ID
/new - Clear current session and start fresh
/status - Show current project and session
/project <path> - Set project directory
/help - Show this help message

Tips:
- Set a project directory first with /project
- Your session is automatically saved
- Use /new to start a fresh conversation
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
