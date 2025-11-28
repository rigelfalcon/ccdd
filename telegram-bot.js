/**
 * Telegram Bot for Claude Code
 * Long polling mode - no server required
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { callClaude, formatResponse } = require('./claude-caller');
const { SessionManager } = require('./session-manager');
const { ClaudeSessionDiscovery } = require('./claude-session-discovery');

class TelegramClaudeBot {
    constructor(options = {}) {
        this.token = options.token || process.env.TELEGRAM_BOT_TOKEN;
        this.allowedChatIds = this.parseAllowedIds(options.allowedChatIds || process.env.TELEGRAM_ALLOWED_CHAT_IDS);
        this.defaultProjectDir = options.defaultProjectDir || process.env.DEFAULT_PROJECT_DIR || process.cwd();
        this.computerName = options.computerName || process.env.COMPUTER_NAME || require('os').hostname();
        this.sessionManager = new SessionManager();
        this.sessionDiscovery = new ClaudeSessionDiscovery();
        this.bot = null;
        this.isRunning = false;
    }

    /**
     * Parse allowed chat IDs from string or array
     */
    parseAllowedIds(ids) {
        if (!ids) return null;  // null means allow all
        if (Array.isArray(ids)) return ids.map(String);
        return ids.split(',').map(s => s.trim());
    }

    /**
     * Check if chat is allowed
     */
    isAllowed(chatId) {
        if (!this.allowedChatIds) return true;  // Allow all if not configured
        return this.allowedChatIds.includes(String(chatId));
    }

    /**
     * Start the bot
     */
    start() {
        if (!this.token) {
            console.log('[Telegram] Bot token not configured, skipping...');
            return false;
        }

        console.log('[Telegram] Starting bot...');

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

        // Normalize path
        projectPath = projectPath.trim();

        this.sessionManager.setProjectDir('telegram', chatId, projectPath);
        await this.bot.sendMessage(chatId, `Project directory set to:\n${projectPath}`);
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

        if (!this.isAllowed(chatId)) {
            await this.bot.sendMessage(chatId, 'Sorry, you are not authorized to use this bot.');
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

            // Update session
            if (result.sessionId) {
                this.sessionManager.updateSessionId('telegram', chatId, result.sessionId, projectDir);
            }

            // Delete thinking message
            await this.bot.deleteMessage(chatId, thinkingMsg.message_id);

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
            console.log('[Telegram] Error calling Claude:', error);

            // Delete thinking message
            try {
                await this.bot.deleteMessage(chatId, thinkingMsg.message_id);
            } catch (e) {}

            await this.bot.sendMessage(chatId, `Error: ${error.message}`);
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
