#!/usr/bin/env node
/**
 * Configuration Checker
 * Validates .env configuration and provides guidance
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// ANSI color codes
const colors = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    reset: '\x1b[0m',
    bold: '\x1b[1m'
};

function ok(msg) { console.log(`${colors.green}✓${colors.reset} ${msg}`); }
function err(msg) { console.log(`${colors.red}✗${colors.reset} ${msg}`); }
function warn(msg) { console.log(`${colors.yellow}!${colors.reset} ${msg}`); }
function info(msg) { console.log(`${colors.blue}ℹ${colors.reset} ${msg}`); }
function header(msg) { console.log(`\n${colors.bold}${msg}${colors.reset}`); }

console.log(`
╔══════════════════════════════════════════════════════════════╗
║            Claude Code Bot - Configuration Checker            ║
╚══════════════════════════════════════════════════════════════╝
`);

let hasErrors = false;
let hasWarnings = false;

// Check .env file exists
header('📄 .env File');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    ok('.env file exists');
} else {
    err('.env file not found');
    info('Run: cp .env.example .env');
    hasErrors = true;
}

// ============================================================
// Feature 1: Task Completion Notification
// ============================================================
header('📢 功能一：任务完成通知');

const webhookUrl = process.env.FEISHU_WEBHOOK_URL;
if (webhookUrl && webhookUrl.includes('open.feishu.cn')) {
    ok(`飞书 Webhook: ${webhookUrl.substring(0, 50)}...`);
} else if (webhookUrl) {
    warn('飞书 Webhook URL 格式可能不正确');
    hasWarnings = true;
} else {
    warn('飞书 Webhook 未配置 (功能一不可用)');
    info('配置方法: 飞书群 → 设置 → 群机器人 → 添加自定义机器人');
}

if (process.env.NOTIFICATION_ENABLED === 'true') {
    ok('通知功能: 已启用');
} else {
    warn('通知功能: 已禁用');
}

// ============================================================
// Feature 2: Remote Control
// ============================================================
header('📱 功能二：远程控制');

// Telegram
console.log('\n--- Telegram Bot ---');
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramAllowed = process.env.TELEGRAM_ALLOWED_CHAT_IDS;

if (telegramToken) {
    ok(`Token: ${telegramToken.substring(0, 10)}...`);

    if (telegramAllowed && telegramAllowed.trim().length > 0) {
        const ids = telegramAllowed.split(',').map(s => s.trim()).filter(s => s);
        ok(`白名单: ${ids.length} 个 Chat ID`);
    } else {
        err('白名单未配置 - Bot 会拒绝所有请求！');
        info('步骤:');
        info('  1. 运行 node bot-server.js');
        info('  2. 在 Telegram 给 Bot 发送 /start');
        info('  3. 复制 Chat ID 到 TELEGRAM_ALLOWED_CHAT_IDS');
        hasErrors = true;
    }
} else {
    warn('Telegram Bot 未配置');
}

// Feishu
console.log('\n--- 飞书应用机器人 ---');
const feishuAppId = process.env.FEISHU_APP_ID;
const feishuAppSecret = process.env.FEISHU_APP_SECRET;
const feishuAllowed = process.env.FEISHU_ALLOWED_OPEN_IDS;

if (feishuAppId && feishuAppSecret) {
    ok(`App ID: ${feishuAppId}`);
    ok('App Secret: ***已配置***');

    if (feishuAllowed && feishuAllowed.trim().length > 0) {
        const ids = feishuAllowed.split(',').map(s => s.trim()).filter(s => s);
        ok(`白名单: ${ids.length} 个 Open ID`);
    } else {
        err('白名单未配置 - Bot 会拒绝所有请求！');
        info('步骤:');
        info('  1. 运行 node bot-server.js');
        info('  2. 在飞书给机器人发送消息');
        info('  3. 复制 Open ID 到 FEISHU_ALLOWED_OPEN_IDS');
        hasErrors = true;
    }
} else {
    warn('飞书应用机器人未配置');
}

// ============================================================
// General Settings
// ============================================================
header('⚙️  通用设置');

const defaultDir = process.env.DEFAULT_PROJECT_DIR;
if (defaultDir) {
    if (fs.existsSync(defaultDir)) {
        ok(`默认项目目录: ${defaultDir}`);
    } else {
        warn(`默认项目目录不存在: ${defaultDir}`);
        hasWarnings = true;
    }
} else {
    info('默认项目目录: 使用当前目录');
}

const proxy = process.env.HTTP_PROXY;
if (proxy) {
    ok(`HTTP 代理: ${proxy}`);
} else {
    info('HTTP 代理: 未配置');
}

const computerName = process.env.COMPUTER_NAME || require('os').hostname();
ok(`电脑名称: ${computerName}`);

// ============================================================
// Summary
// ============================================================
header('📊 检查结果');

if (hasErrors) {
    console.log(`\n${colors.red}${colors.bold}有配置错误需要修复！${colors.reset}`);
    console.log('请按照上面的提示修改 .env 文件\n');
    process.exit(1);
} else if (hasWarnings) {
    console.log(`\n${colors.yellow}${colors.bold}有一些警告，但可以运行${colors.reset}`);
    console.log('建议检查上面的警告信息\n');
} else {
    console.log(`\n${colors.green}${colors.bold}配置检查通过！${colors.reset}`);
    console.log('可以运行 node bot-server.js 启动远程控制\n');
}

// Quick start guide
header('🚀 快速命令');
console.log(`
  测试任务通知:     node notify-system.js --task "测试"
  启动远程控制:     node bot-server.js
  查看帮助:         cat README.md
`);
