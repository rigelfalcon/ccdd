/**
 * Shortcuts Manager
 * Manages user-defined quick command shortcuts
 *
 * SECURITY FEATURES:
 * - Shortcut name validation (alphanumeric only)
 * - Command content validation
 * - Maximum shortcuts per user
 * - Blocked dangerous patterns
 */

const fs = require('fs');
const path = require('path');

// Security constants
const MAX_SHORTCUTS_PER_USER = 20;
const MAX_SHORTCUT_NAME_LENGTH = 20;
const MAX_SHORTCUT_CONTENT_LENGTH = 1000;

// Blocked patterns in shortcut commands (security)
const BLOCKED_PATTERNS = [
    /rm\s+-rf/i,
    /del\s+\/[sfq]/i,
    /format\s+[a-z]:/i,
    /mkfs/i,
    /dd\s+if=/i,
    />\s*\/dev\/sd/i,
    /chmod\s+777/i,
    /curl.*\|.*sh/i,
    /wget.*\|.*sh/i,
];

class ShortcutsManager {
    constructor(dataFile = null) {
        this.dataFile = dataFile || path.join(__dirname, 'shortcuts.json');
        this.shortcuts = this.load();
    }

    /**
     * Load shortcuts from file
     */
    load() {
        try {
            if (fs.existsSync(this.dataFile)) {
                const data = fs.readFileSync(this.dataFile, 'utf8');
                return JSON.parse(data);
            }
        } catch (e) {
            console.log('[ShortcutsManager] Failed to load shortcuts:', e.message);
        }
        return {};
    }

    /**
     * Save shortcuts to file
     */
    save() {
        try {
            fs.writeFileSync(this.dataFile, JSON.stringify(this.shortcuts, null, 2));
        } catch (e) {
            console.log('[ShortcutsManager] Failed to save shortcuts:', e.message);
        }
    }

    /**
     * Generate a unique key for a user
     */
    getKey(platform, chatId) {
        return `${platform}:${chatId}`;
    }

    /**
     * Validate shortcut name
     */
    validateName(name) {
        if (!name || typeof name !== 'string') {
            return { valid: false, error: 'Shortcut name is required' };
        }

        const trimmed = name.trim().toLowerCase();

        if (trimmed.length > MAX_SHORTCUT_NAME_LENGTH) {
            return { valid: false, error: `Name too long (max ${MAX_SHORTCUT_NAME_LENGTH} chars)` };
        }

        // Only allow alphanumeric and underscore
        if (!/^[a-z0-9_]+$/.test(trimmed)) {
            return { valid: false, error: 'Name can only contain letters, numbers, and underscores' };
        }

        // Reserved names
        const reserved = ['help', 'start', 'new', 'status', 'project', 'cancel',
                         'queue', 'sessions', 'resume', 'projects', 'shortcuts', 'export'];
        if (reserved.includes(trimmed)) {
            return { valid: false, error: `"${trimmed}" is a reserved command name` };
        }

        return { valid: true, error: null, name: trimmed };
    }

    /**
     * Validate shortcut command content
     */
    validateCommand(command) {
        if (!command || typeof command !== 'string') {
            return { valid: false, error: 'Command content is required' };
        }

        const trimmed = command.trim();

        if (trimmed.length > MAX_SHORTCUT_CONTENT_LENGTH) {
            return { valid: false, error: `Command too long (max ${MAX_SHORTCUT_CONTENT_LENGTH} chars)` };
        }

        // Check for blocked patterns
        for (const pattern of BLOCKED_PATTERNS) {
            if (pattern.test(trimmed)) {
                return { valid: false, error: 'Command contains blocked dangerous pattern' };
            }
        }

        return { valid: true, error: null, command: trimmed };
    }

    /**
     * Add or update a shortcut
     */
    setShortcut(platform, chatId, name, command) {
        const nameValidation = this.validateName(name);
        if (!nameValidation.valid) {
            return { success: false, error: nameValidation.error };
        }

        const commandValidation = this.validateCommand(command);
        if (!commandValidation.valid) {
            return { success: false, error: commandValidation.error };
        }

        const key = this.getKey(platform, chatId);
        if (!this.shortcuts[key]) {
            this.shortcuts[key] = {};
        }

        // Check max shortcuts
        const currentCount = Object.keys(this.shortcuts[key]).length;
        const isUpdate = this.shortcuts[key].hasOwnProperty(nameValidation.name);

        if (!isUpdate && currentCount >= MAX_SHORTCUTS_PER_USER) {
            return { success: false, error: `Maximum shortcuts reached (${MAX_SHORTCUTS_PER_USER})` };
        }

        this.shortcuts[key][nameValidation.name] = {
            command: commandValidation.command,
            createdAt: this.shortcuts[key][nameValidation.name]?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        this.save();
        return { success: true, name: nameValidation.name, isUpdate };
    }

    /**
     * Get a shortcut command
     */
    getShortcut(platform, chatId, name) {
        const key = this.getKey(platform, chatId);
        const shortcuts = this.shortcuts[key] || {};
        const shortcut = shortcuts[name.toLowerCase()];
        return shortcut ? shortcut.command : null;
    }

    /**
     * Delete a shortcut
     */
    deleteShortcut(platform, chatId, name) {
        const key = this.getKey(platform, chatId);
        if (!this.shortcuts[key]) {
            return { success: false, error: 'Shortcut not found' };
        }

        const normalizedName = name.toLowerCase();
        if (!this.shortcuts[key][normalizedName]) {
            return { success: false, error: 'Shortcut not found' };
        }

        delete this.shortcuts[key][normalizedName];
        this.save();
        return { success: true };
    }

    /**
     * List all shortcuts for a user
     */
    listShortcuts(platform, chatId) {
        const key = this.getKey(platform, chatId);
        const shortcuts = this.shortcuts[key] || {};
        return Object.entries(shortcuts).map(([name, data]) => ({
            name,
            command: data.command,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt
        }));
    }

    /**
     * Format shortcuts list for display
     */
    formatShortcutsList(platform, chatId) {
        const shortcuts = this.listShortcuts(platform, chatId);

        if (shortcuts.length === 0) {
            return 'No shortcuts defined.\n\nUse /shortcut add <name> <command> to create one.\nExample: /shortcut add build run npm build';
        }

        const lines = ['Your Shortcuts:\n'];
        shortcuts.forEach((s, i) => {
            const cmdPreview = s.command.length > 40 ? s.command.substring(0, 37) + '...' : s.command;
            lines.push(`${i + 1}. /${s.name} -> "${cmdPreview}"`);
        });

        lines.push('\nUsage:');
        lines.push('/shortcut add <name> <command>');
        lines.push('/shortcut del <name>');
        lines.push('/shortcut list');

        return lines.join('\n');
    }

    /**
     * Check if a message is a shortcut and expand it
     */
    expandShortcut(platform, chatId, message) {
        if (!message.startsWith('/')) {
            return null;
        }

        const parts = message.substring(1).split(/\s+/);
        const shortcutName = parts[0].toLowerCase();
        const command = this.getShortcut(platform, chatId, shortcutName);

        if (!command) {
            return null;
        }

        // Replace $1, $2, etc. with arguments
        let expanded = command;
        for (let i = 1; i < parts.length; i++) {
            expanded = expanded.replace(new RegExp(`\\$${i}`, 'g'), parts[i]);
        }
        // Remove unused placeholders
        expanded = expanded.replace(/\$\d+/g, '').trim();

        return expanded;
    }
}

module.exports = {
    ShortcutsManager,
    MAX_SHORTCUTS_PER_USER,
    MAX_SHORTCUT_NAME_LENGTH,
    MAX_SHORTCUT_CONTENT_LENGTH
};
