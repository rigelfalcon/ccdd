/**
 * Claude Code 任务完成通知系统
 * 集成声音提醒和飞书推送，支持手环震动
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { envConfig } = require('./env-config');
const { NotificationManager } = require('./notification-manager');

/**
 * 通知系统管理器
 */
class NotificationSystem {
    constructor() {
        this.config = this.loadConfig();
        this.projectName = this.getProjectName();
        this.notificationManager = new NotificationManager(this.config, this.projectName);
    }

    /**
     * 加载配置文件
     */
    loadConfig() {
        try {
            const configPath = path.join(__dirname, 'config.json');
            const configData = fs.readFileSync(configPath, 'utf8');
            const config = JSON.parse(configData);

            // 从环境变量配置覆盖配置文件
            const envVars = envConfig.getAllConfig();

            // 飞书配置
            if (envVars.feishu.webhook_url) {
                config.notification.feishu.webhook_url = envVars.feishu.webhook_url;
                config.notification.feishu.enabled = true;
            }

            // Telegram配置
            if (envVars.telegram.enabled) {
                config.notification.telegram = {
                    ...config.notification.telegram,
                    ...envVars.telegram,
                    enabled: true
                };
            }

            // 声音配置
            if (process.env.SOUND_ENABLED !== undefined) {
                config.notification.sound.enabled = envVars.sound.enabled;
            }

            return config;
        } catch (error) {
            console.log('⚠️  无法加载配置文件，使用环境变量配置');
            const envVars = envConfig.getAllConfig();
            return {
                notification: {
                    type: envVars.feishu.enabled ? 'feishu' : 'sound',
                    feishu: envVars.feishu,
                    telegram: envVars.telegram,
                    sound: envVars.sound
                }
            };
        }
    }

    /**
     * 获取项目名称
     * 优先级: package.json > git仓库名 > 目录名
     */
    getProjectName() {
        try {
            // 1. 尝试从当前工作目录的 package.json 获取项目名称
            const packageJsonPath = path.join(process.cwd(), 'package.json');
            if (fs.existsSync(packageJsonPath)) {
                const packageData = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                if (packageData.name) {
                    console.log(`📦 从 package.json 检测到项目名称: ${packageData.name}`);
                    return packageData.name;
                }
            }

            // 2. 尝试从 git 仓库名获取
            const { execSync } = require('child_process');
            try {
                const gitRemote = execSync('git remote get-url origin', {
                    encoding: 'utf8',
                    stdio: 'pipe'
                }).trim();
                // 从 git URL 提取仓库名
                const matches = gitRemote.match(/\/([^\/]+)\.git$/);
                if (matches && matches[1]) {
                    console.log(`🔧 从 git 仓库检测到项目名称: ${matches[1]}`);
                    return matches[1];
                }
            } catch (gitError) {
                // git 命令失败，继续下一步
            }

            // 3. 从当前目录名获取
            const dirName = path.basename(process.cwd());
            console.log(`📁 从目录名检测到项目名称: ${dirName}`);
            return dirName;

        } catch (error) {
            console.log('⚠️  无法获取项目名称，使用默认值');
            return '未知项目';
        }
    }

    /**
     * 播放Windows系统声音
     */
    playWindowsSound() {
        const psScript = `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak("任务完成，已发送手机通知"); [console]::Beep(800, 300)`;

        return spawn('powershell', ['-Command', psScript], {
            stdio: 'ignore',
            shell: false
        });
    }

    /**
     * 播放蜂鸣声作为备用方案
     */
    playBeep() {
        const psScript = '[console]::Beep(800, 500)';
        return spawn('powershell', ['-Command', psScript], {
            stdio: 'ignore',
            shell: false
        });
    }

    /**
     * 发送声音提醒
     */
    async sendSoundNotification() {
        if (!this.config.notification.sound.enabled) {
            return;
        }

        console.log('🔊 播放声音提醒...');

        try {
            const soundProcess = this.playWindowsSound();

            soundProcess.on('error', (error) => {
                if (this.config.notification.sound.backup) {
                    console.log('声音播放失败，使用蜂鸣声');
                    this.playBeep();
                }
            });

            soundProcess.on('close', (code) => {
                if (code !== 0 && this.config.notification.sound.backup) {
                    console.log('声音播放异常，使用蜂鸣声');
                    this.playBeep();
                }
            });

        } catch (error) {
            if (this.config.notification.sound.backup) {
                console.log('播放声音时发生错误，使用蜂鸣声');
                this.playBeep();
            }
        }
    }

    /**
     * 发送飞书通知
     */
    async sendFeishuNotification(taskInfo) {
        if (!this.config.notification.feishu.enabled) {
            console.log('📱 飞书通知已禁用');
            return false;
        }

        const webhookUrl = this.config.notification.feishu.webhook_url;

        if (!webhookUrl || webhookUrl.includes('YOUR_WEBHOOK_URL_HERE')) {
            console.log('⚠️  请先配置飞书webhook地址');
            this.printFeishuSetupGuide();
            return false;
        }

        return await sendFeishuNotification(taskInfo, webhookUrl, this.projectName);
    }

    /**
     * 发送所有类型的通知
     */
    async sendAllNotifications(taskInfo = "Claude Code任务已完成") {
        const icons = this.notificationManager.getEnabledNotificationIcons();
        console.log(`🚀 开始发送任务完成通知... ${icons}`);
        console.log(`📁 项目名称：${this.projectName}`);
        console.log(`📝 任务信息：${taskInfo}`);

        // 发送所有通知
        const results = await this.notificationManager.sendAllNotifications(taskInfo);

        // 添加声音通知
        if (this.config.notification.sound.enabled) {
            this.sendSoundNotification();
            setTimeout(() => {
                console.log('🔊 声音提醒已播放');
            }, 1000);
        }

        // 打印结果汇总
        this.notificationManager.printNotificationSummary(results);

        // 3秒后退出
        setTimeout(() => {
            console.log('✨ 通知系统执行完成，程序退出');
            process.exit(0);
        }, 3000);
    }
}

/**
 * 获取命令行参数
 */
function getCommandLineArgs() {
    const args = process.argv.slice(2);
    const options = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
            options[key] = value;
            if (value !== true) i++;
        }
    }

    return options;
}

/**
 * 从 stdin 读取 Claude Code Hook 输入的 JSON
 * Hook 会通过 stdin 传入包含 session_id, cwd, transcript_path 等信息的 JSON
 */
function readStdinJson() {
    return new Promise((resolve) => {
        let data = '';

        // 设置超时，如果 500ms 内没有数据就返回空对象
        const timeout = setTimeout(() => {
            resolve({});
        }, 500);

        process.stdin.setEncoding('utf8');
        process.stdin.on('readable', () => {
            let chunk;
            while ((chunk = process.stdin.read()) !== null) {
                data += chunk;
            }
        });

        process.stdin.on('end', () => {
            clearTimeout(timeout);
            if (data.trim()) {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve({});
                }
            } else {
                resolve({});
            }
        });

        // 非阻塞：如果 stdin 没有数据，立即结束
        if (process.stdin.isTTY) {
            clearTimeout(timeout);
            resolve({});
        }
    });
}

/**
 * Find the most recent Droid session file for a given working directory
 * Droid stores sessions in ~/.factory/sessions/<encoded-path>/<session-id>.jsonl
 * @param {string} cwd - The working directory to find sessions for
 * @returns {string|null} Path to the most recent session file, or null if not found
 */
function findDroidSessionFile(cwd) {
    try {
        const os = require('os');
        const factorySessionsDir = path.join(os.homedir(), '.factory', 'sessions');
        
        if (!fs.existsSync(factorySessionsDir)) {
            return null;
        }

        // Encode the cwd path similar to how Droid does it
        // Droid uses: C:\path\to -> -C-path-to
        let encodedPath = cwd
            .replace(/:/g, '')       // Remove colons
            .replace(/\\/g, '-')     // Replace backslashes with -
            .replace(/\//g, '-');    // Replace forward slashes with -
        
        // Try to find a matching directory
        const dirs = fs.readdirSync(factorySessionsDir, { withFileTypes: true });
        let matchingDir = null;
        
        for (const dir of dirs) {
            if (dir.isDirectory()) {
                // Check if this directory matches our cwd (case insensitive on Windows)
                if (dir.name.toLowerCase() === encodedPath.toLowerCase() ||
                    dir.name.toLowerCase() === `-${encodedPath.toLowerCase()}`) {
                    matchingDir = path.join(factorySessionsDir, dir.name);
                    break;
                }
            }
        }
        
        if (!matchingDir) {
            return null;
        }
        
        // Find the most recent .jsonl file (not .settings.json)
        const files = fs.readdirSync(matchingDir)
            .filter(f => f.endsWith('.jsonl') && !f.includes('.settings.'));
        
        if (files.length === 0) {
            return null;
        }
        
        // Sort by modification time, most recent first
        const sortedFiles = files
            .map(f => ({
                name: f,
                path: path.join(matchingDir, f),
                mtime: fs.statSync(path.join(matchingDir, f)).mtime
            }))
            .sort((a, b) => b.mtime - a.mtime);
        
        return sortedFiles[0].path;
    } catch (error) {
        console.log('Error finding Droid session file:', error.message);
        return null;
    }
}

/**
 * 从 transcript 文件中读取最后一条 assistant 消息
 * 支持 Claude Code 和 Droid 两种格式:
 * - Claude Code: {"type": "assistant", "message": {"content": [...]}}
 * - Droid: {"type": "message", "message": {"role": "assistant", "content": [...]}}
 * @param {string} transcriptPath - transcript 文件路径
 * @param {number} maxLength - 最大字符数限制
 * @returns {string} 最后一条消息内容
 */
function getLastAssistantMessage(transcriptPath, maxLength = 500) {
    try {
        if (!transcriptPath || !fs.existsSync(transcriptPath)) {
            return '';
        }

        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.trim().split('\n');

        // 从后往前找最后一条 assistant 消息
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(lines[i]);
                
                // Check if this is an assistant message (supports both Claude Code and Droid formats)
                const isClaudeCodeAssistant = entry.type === 'assistant' && entry.message && entry.message.content;
                const isDroidAssistant = entry.type === 'message' && entry.message && entry.message.role === 'assistant' && entry.message.content;
                
                if (isClaudeCodeAssistant || isDroidAssistant) {
                    // 提取文本内容
                    let text = '';
                    const msgContent = entry.message.content;

                    if (Array.isArray(msgContent)) {
                        // content 是数组，提取所有 text 类型的内容
                        for (const item of msgContent) {
                            if (item.type === 'text' && item.text) {
                                text += item.text + '\n';
                            }
                        }
                    } else if (typeof msgContent === 'string') {
                        text = msgContent;
                    }

                    text = text.trim();
                    if (text) {
                        // 截断并添加省略号
                        if (text.length > maxLength) {
                            text = text.substring(0, maxLength) + '...';
                        }
                        return text;
                    }
                }
            } catch (e) {
                // 解析失败，跳过这一行
                continue;
            }
        }
        return '';
    } catch (error) {
        console.log('读取 transcript 失败:', error.message);
        return '';
    }
}

// 如果直接运行此脚本
if (require.main === module) {
    const options = getCommandLineArgs();
    // 从命令行参数获取最大长度，默认 2000
    const maxLength = parseInt(options.maxLength) || 2000;
    // Enable debug mode with --debug flag
    const debugMode = options.debug === true || options.debug === 'true';

    // 尝试从 stdin 读取 Hook 输入
    readStdinJson().then((hookInput) => {
        const notifier = new NotificationSystem();

        // Debug: log the raw hook input
        if (debugMode) {
            console.log('[DEBUG] Hook input received:', JSON.stringify(hookInput, null, 2));
        }

        // 构建任务信息
        let taskInfo = options.message || options.task || "Claude Code任务已完成";
        let lastOutput = '';

        // 如果有 Hook 输入，添加额外信息
        if (hookInput.session_id || hookInput.cwd || hookInput.transcript_path) {
            const sessionId = hookInput.session_id ? hookInput.session_id.slice(0, 8) : '';
            const cwd = hookInput.cwd || process.cwd();
            const projectDir = path.basename(cwd);

            // 覆盖项目名称为实际工作目录
            notifier.projectName = projectDir;

            // 构建更详细的消息
            taskInfo = sessionId ? `[${sessionId}] ${taskInfo}` : taskInfo;

            // Debug: log transcript path
            if (debugMode) {
                console.log('[DEBUG] transcript_path:', hookInput.transcript_path);
                console.log('[DEBUG] hook_event_name:', hookInput.hook_event_name);
            }

            // 读取最后一条 assistant 消息
            let transcriptPath = hookInput.transcript_path;
            
            // If transcript_path is not provided or doesn't exist, try to find it
            if (!transcriptPath || !fs.existsSync(transcriptPath)) {
                if (debugMode) {
                    console.log('[DEBUG] transcript_path not found, trying Droid session discovery...');
                }
                // Try Droid session discovery as fallback
                transcriptPath = findDroidSessionFile(cwd);
                if (debugMode) {
                    console.log('[DEBUG] Droid session file found:', transcriptPath);
                }
            }
            
            if (transcriptPath && fs.existsSync(transcriptPath)) {
                lastOutput = getLastAssistantMessage(transcriptPath, maxLength);
                if (debugMode) {
                    console.log('[DEBUG] lastOutput length:', lastOutput.length);
                    console.log('[DEBUG] lastOutput preview:', lastOutput.substring(0, 200));
                }
            } else if (debugMode) {
                console.log('[DEBUG] No valid transcript path found');
            }
        } else {
            if (debugMode) {
                console.log('[DEBUG] No hook input with session_id/cwd/transcript_path');
            }
        }

        // 如果有最后输出，附加到任务信息
        if (lastOutput) {
            taskInfo = `${taskInfo}\n\n📋 最后输出:\n${lastOutput}`;
        }

        notifier.sendAllNotifications(taskInfo);
    });
}

module.exports = {
    NotificationSystem
};