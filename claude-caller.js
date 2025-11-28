/**
 * Claude Code CLI Wrapper
 * Calls Claude Code in headless mode and manages sessions
 */

const { spawn } = require('child_process');
const path = require('path');

/**
 * Call Claude Code CLI in headless mode
 * @param {string} prompt - The prompt to send
 * @param {Object} options - Options
 * @param {string} options.cwd - Working directory
 * @param {string} options.sessionId - Session ID to resume (optional)
 * @param {boolean} options.continueSession - Whether to continue the most recent session
 * @param {number} options.timeout - Timeout in milliseconds (default: 5 minutes)
 * @returns {Promise<{result: string, sessionId: string, success: boolean}>}
 */
async function callClaude(prompt, options = {}) {
    const {
        cwd = process.cwd(),
        sessionId = null,
        continueSession = false,
        timeout = 5 * 60 * 1000  // 5 minutes default
    } = options;

    return new Promise((resolve) => {
        const args = ['-p', prompt, '--output-format', 'json'];

        // Add session resume options
        if (sessionId) {
            args.push('--resume', sessionId);
        } else if (continueSession) {
            args.push('--continue');
        }

        console.log(`[Claude] Calling with prompt: ${prompt.substring(0, 100)}...`);
        console.log(`[Claude] Working directory: ${cwd}`);

        const child = spawn('claude', args, {
            cwd: cwd,
            shell: true,
            env: { ...process.env }
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
                console.log(`[Claude] stderr: ${stderr}`);
                resolve({
                    result: stderr || 'Claude Code exited with error',
                    sessionId: null,
                    success: false
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
            console.log(`[Claude] Process error: ${err.message}`);
            resolve({
                result: `Error: ${err.message}`,
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
    formatResponse
};
