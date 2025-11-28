/**
 * Feishu Bot for Claude Code
 * WebSocket long connection mode - no server required
 */

require('dotenv').config();
const lark = require('@larksuiteoapi/node-sdk');
const { callClaude, formatResponse } = require('./claude-caller');
const { SessionManager } = require('./session-manager');

class FeishuClaudeBot {
    constructor(options = {}) {
        this.appId = options.appId || process.env.FEISHU_APP_ID;
        this.appSecret = options.appSecret || process.env.FEISHU_APP_SECRET;
        this.defaultProjectDir = options.defaultProjectDir || process.env.DEFAULT_PROJECT_DIR || process.cwd();
        this.sessionManager = new SessionManager();
        this.client = null;
        this.wsClient = null;
        this.isRunning = false;
    }

    /**
     * Start the bot
     */
    async start() {
        if (!this.appId || !this.appSecret) {
            console.log('[Feishu] App ID or Secret not configured, skipping...');
            return false;
        }

        console.log('[Feishu] Starting bot...');

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
            // Start with event dispatcher passed to start()
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
            // Note: lark-node-sdk might not have a stop method
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

            // Check for commands
            if (text.startsWith('/')) {
                await this.handleCommand(chatId, senderId, text);
                return;
            }

            // Handle regular message
            await this.handleChatMessage(chatId, senderId, text);

        } catch (error) {
            console.log('[Feishu] Error handling message:', error);
        }
    }

    /**
     * Handle commands
     */
    async handleCommand(chatId, senderId, text) {
        const [command, ...args] = text.split(' ');

        switch (command.toLowerCase()) {
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
                    this.sessionManager.setProjectDir('feishu', chatId, projectPath);
                    await this.sendMessage(chatId, `Project directory set to:\n${projectPath}`);
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
                timeout: 5 * 60 * 1000  // 5 minutes
            });

            // Update session
            if (result.sessionId) {
                this.sessionManager.updateSessionId('feishu', chatId, result.sessionId, projectDir);
            }

            // Format and send response
            const response = formatResponse(result.result, 4000);
            await this.sendMessage(chatId, response);

        } catch (error) {
            console.log('[Feishu] Error calling Claude:', error);
            await this.sendMessage(chatId, `Error: ${error.message}`);
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
Claude Code Bot Commands:

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
