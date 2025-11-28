/**
 * Bot Server - Unified entry point
 * Starts both Telegram and Feishu bots
 */

require('dotenv').config();
const { TelegramClaudeBot } = require('./telegram-bot');
const { FeishuClaudeBot } = require('./feishu-bot');

class BotServer {
    constructor() {
        this.telegramBot = null;
        this.feishuBot = null;
        this.isRunning = false;
    }

    /**
     * Start all configured bots
     */
    async start() {
        console.log('╔════════════════════════════════════════╗');
        console.log('║    Claude Code Bot Server Starting     ║');
        console.log('╚════════════════════════════════════════╝');
        console.log('');

        const results = {
            telegram: false,
            feishu: false
        };

        // Start Telegram bot
        console.log('[Server] Initializing Telegram bot...');
        this.telegramBot = new TelegramClaudeBot();
        results.telegram = this.telegramBot.start();

        // Start Feishu bot
        console.log('[Server] Initializing Feishu bot...');
        this.feishuBot = new FeishuClaudeBot();
        results.feishu = await this.feishuBot.start();

        // Print status
        console.log('');
        console.log('╔════════════════════════════════════════╗');
        console.log('║           Bot Status Summary           ║');
        console.log('╠════════════════════════════════════════╣');
        console.log(`║  Telegram: ${results.telegram ? '✅ Running' : '❌ Not configured'}          ║`);
        console.log(`║  Feishu:   ${results.feishu ? '✅ Running' : '❌ Not configured'}          ║`);
        console.log('╚════════════════════════════════════════╝');
        console.log('');

        if (!results.telegram && !results.feishu) {
            console.log('[Server] No bots configured. Please check your .env file.');
            console.log('');
            console.log('Required environment variables:');
            console.log('  Telegram: TELEGRAM_BOT_TOKEN');
            console.log('  Feishu:   FEISHU_APP_ID, FEISHU_APP_SECRET');
            console.log('');
            return false;
        }

        this.isRunning = true;
        console.log('[Server] Press Ctrl+C to stop');
        console.log('');

        return true;
    }

    /**
     * Stop all bots
     */
    stop() {
        console.log('');
        console.log('[Server] Stopping all bots...');

        if (this.telegramBot) {
            this.telegramBot.stop();
        }

        if (this.feishuBot) {
            this.feishuBot.stop();
        }

        this.isRunning = false;
        console.log('[Server] All bots stopped');
    }
}

// Main entry point
async function main() {
    const server = new BotServer();

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        server.stop();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        server.stop();
        process.exit(0);
    });

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
        console.error('[Server] Uncaught exception:', error);
    });

    process.on('unhandledRejection', (error) => {
        console.error('[Server] Unhandled rejection:', error);
    });

    // Start server
    const success = await server.start();

    if (!success) {
        process.exit(1);
    }
}

// Run
main();
