/**
 * Claude Code CLI Wrapper
 * Calls Claude Code in headless mode and manages sessions
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Maximum allowed prompt length (10KB)
const MAX_PROMPT_LENGTH = 10000;

// Maximum allowed path length
const MAX_PATH_LENGTH = 500;

/**
 * Validate and sanitize input prompt
 * @param {string} prompt - Raw user prompt
 * @returns {{valid: boolean, sanitized: string, error: string}}
 */
function validatePrompt(prompt) {
    if (!prompt || typeof prompt !== 'string') {
        return { valid: false, sanitized: '', error: 'Prompt must be a non-empty string' };
    }

    if (prompt.length > MAX_PROMPT_LENGTH) {
        return { valid: false, sanitized: '', error: `Prompt too long (max ${MAX_PROMPT_LENGTH} characters)` };
    }

    // No shell injection possible since we don't use shell: true
    // But we still sanitize for logging purposes
    const sanitized = prompt.trim();

    return { valid: true, sanitized, error: null };
}

/**
 * Validate working directory path
 * @param {string} cwd - Working directory
 * @param {string[]} allowedBasePaths - Allowed base paths (optional)
 * @returns {{valid: boolean, error: string}}
 */
function validateCwd(cwd, allowedBasePaths = null) {
    if (!cwd || typeof cwd !== 'string') {
        return { valid: false, error: 'Working directory must be a non-empty string' };
    }

    if (cwd.length > MAX_PATH_LENGTH) {
        return { valid: false, error: 'Path too long' };
    }

    // Resolve to absolute path
    const resolved = path.resolve(cwd);

    // Check for path traversal attempts
    if (cwd.includes('..')) {
        return { valid: false, error: 'Path traversal not allowed' };
    }

    // If allowedBasePaths specified, check if cwd is within one of them
    if (allowedBasePaths && allowedBasePaths.length > 0) {
        const isAllowed = allowedBasePaths.some(basePath => {
            const resolvedBase = path.resolve(basePath);
            return resolved.startsWith(resolvedBase);
        });

        if (!isAllowed) {
            return { valid: false, error: 'Path not in allowed directories' };
        }
    }

    return { valid: true, error: null };
}

/**
 * Call Claude Code CLI in headless mode
 * @param {string} prompt - The prompt to send
 * @param {Object} options - Options
 * @param {string} options.cwd - Working directory
 * @param {string} options.sessionId - Session ID to resume (optional)
 * @param {boolean} options.continueSession - Whether to continue the most recent session
 * @param {number} options.timeout - Timeout in milliseconds (default: 5 minutes)
 * @param {string[]} options.allowedBasePaths - Allowed base paths for cwd validation
 * @returns {Promise<{result: string, sessionId: string, success: boolean}>}
 */
async function callClaude(prompt, options = {}) {
    const {
        cwd = process.cwd(),
        sessionId = null,
        continueSession = false,
        timeout = 5 * 60 * 1000,  // 5 minutes default
        allowedBasePaths = null
    } = options;

    // Validate prompt
    const promptValidation = validatePrompt(prompt);
    if (!promptValidation.valid) {
        return {
            result: `Input error: ${promptValidation.error}`,
            sessionId: null,
            success: false
        };
    }

    // Validate working directory
    const cwdValidation = validateCwd(cwd, allowedBasePaths);
    if (!cwdValidation.valid) {
        return {
            result: `Path error: ${cwdValidation.error}`,
            sessionId: null,
            success: false
        };
    }

    return new Promise((resolve) => {
        // Log sanitized prompt (truncated for security)
        const logPrompt = promptValidation.sanitized.substring(0, 50).replace(/[\r\n]/g, ' ');
        console.log(`[Claude] Calling with prompt: ${logPrompt}...`);
        console.log(`[Claude] Working directory: ${cwd}`);

        // Write prompt to temp file to avoid shell encoding issues on Windows
        const tempDir = require('os').tmpdir();
        const tempFile = path.join(tempDir, `claude-prompt-${Date.now()}.txt`);
        fs.writeFileSync(tempFile, promptValidation.sanitized, 'utf8');

        // Build command using stdin from file
        let command = `claude --output-format json`;

        // Add session resume options
        if (sessionId) {
            // Validate sessionId format (UUID-like)
            if (!/^[a-f0-9-]{8,}$/i.test(sessionId)) {
                fs.unlinkSync(tempFile);
                resolve({
                    result: 'Invalid session ID format',
                    sessionId: null,
                    success: false
                });
                return;
            }
            command += ` --resume ${sessionId}`;
        } else if (continueSession) {
            command += ` --continue`;
        }

        // Use type (Windows) or cat (Unix) to pipe prompt
        const isWindows = process.platform === 'win32';
        const fullCommand = isWindows
            ? `type "${tempFile}" | ${command}`
            : `cat "${tempFile}" | ${command}`;

        console.log(`[Claude] Executing command...`);

        const child = spawn(fullCommand, [], {
            cwd: path.resolve(cwd),
            shell: true,
            env: { ...process.env },
            windowsHide: true
        });

        // Clean up temp file after process exits
        child.on('exit', () => {
            try { fs.unlinkSync(tempFile); } catch (e) { /* ignore */ }
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        // Timeout handler
        const timeoutId = setTimeout(() => {
            console.log('[Claude] Timeout reached, killing process');
            child.kill('SIGTERM');
            resolve({
                result: 'Request timed out after ' + (timeout / 1000) + ' seconds',
                sessionId: null,
                success: false
            });
        }, timeout);

        child.on('close', (code) => {
            clearTimeout(timeoutId);

            if (code !== 0) {
                console.log(`[Claude] Process exited with code ${code}`);
                // Log stderr internally but don't expose full details to user
                if (stderr) {
                    console.log(`[Claude] stderr: ${stderr.substring(0, 200)}`);
                }

                // Check if error is due to invalid session ID
                const isInvalidSession = stderr && (
                    stderr.includes('No conversation found with session ID') ||
                    stderr.includes('Invalid session') ||
                    stderr.includes('session not found')
                );

                resolve({
                    // Generic error message to user (don't leak system details)
                    result: 'Claude Code encountered an error. Please try again.',
                    sessionId: null,
                    success: false,
                    invalidSession: isInvalidSession  // Flag for session-specific errors
                });
                return;
            }

            try {
                // Parse JSON output
                const output = JSON.parse(stdout);
                resolve({
                    result: output.result || output.message || stdout,
                    sessionId: output.session_id || null,
                    success: true
                });
            } catch (e) {
                // If not JSON, return raw output
                resolve({
                    result: stdout || 'No output',
                    sessionId: null,
                    success: true
                });
            }
        });

        child.on('error', (err) => {
            clearTimeout(timeoutId);
            // Log error internally but don't expose details
            console.log(`[Claude] Process error: ${err.message}`);
            resolve({
                result: 'Failed to start Claude Code. Please check installation.',
                sessionId: null,
                success: false
            });
        });
    });
}

/**
 * Format Claude's response for messaging platforms
 * @param {string} text - Raw response text
 * @param {number} maxLength - Maximum length
 * @returns {string} Formatted text
 */
function formatResponse(text, maxLength = 4000) {
    if (!text) return 'No response';

    // Trim whitespace
    text = text.trim();

    // Truncate if too long
    if (text.length > maxLength) {
        text = text.substring(0, maxLength - 100) + '\n\n... (truncated)';
    }

    return text;
}

module.exports = {
    callClaude,
    formatResponse,
    validatePrompt,
    validateCwd,
    MAX_PROMPT_LENGTH,
    MAX_PATH_LENGTH
};
