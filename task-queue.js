/**
 * Task Queue Manager
 * Manages a queue of tasks to be processed sequentially
 *
 * SECURITY FEATURES:
 * - Maximum queue size per user
 * - Task timeout limits
 * - Input validation
 */

const EventEmitter = require('events');

// Security constants
const MAX_QUEUE_SIZE = 10;           // Max tasks per user
const MAX_TASK_CONTENT_LENGTH = 10000;  // Max task content length
const TASK_TIMEOUT = 10 * 60 * 1000;    // 10 minutes max per task

class TaskQueue extends EventEmitter {
    constructor() {
        super();
        // Map of chatId -> { queue: [], currentTask: null, isProcessing: boolean }
        this.queues = new Map();
    }

    /**
     * Get or create queue for a chat
     */
    getQueue(chatId) {
        const key = String(chatId);
        if (!this.queues.has(key)) {
            this.queues.set(key, {
                queue: [],
                currentTask: null,
                isProcessing: false,
                currentProcess: null
            });
        }
        return this.queues.get(key);
    }

    /**
     * Add task to queue
     * @returns {{success: boolean, position: number, error: string}}
     */
    addTask(chatId, task) {
        // Validate task content
        if (!task || typeof task.prompt !== 'string') {
            return { success: false, position: -1, error: 'Invalid task format' };
        }

        if (task.prompt.length > MAX_TASK_CONTENT_LENGTH) {
            return { success: false, position: -1, error: `Task content too long (max ${MAX_TASK_CONTENT_LENGTH} chars)` };
        }

        const queueData = this.getQueue(chatId);

        // Check queue size limit
        if (queueData.queue.length >= MAX_QUEUE_SIZE) {
            return { success: false, position: -1, error: `Queue full (max ${MAX_QUEUE_SIZE} tasks)` };
        }

        // Add task with metadata
        const taskWithMeta = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            prompt: task.prompt,
            projectDir: task.projectDir,
            sessionId: task.sessionId,
            addedAt: new Date().toISOString(),
            status: 'pending'
        };

        queueData.queue.push(taskWithMeta);
        const position = queueData.queue.length;

        return { success: true, position, error: null, taskId: taskWithMeta.id };
    }

    /**
     * Get next task from queue
     */
    getNextTask(chatId) {
        const queueData = this.getQueue(chatId);
        if (queueData.queue.length === 0) {
            return null;
        }
        return queueData.queue[0];
    }

    /**
     * Remove completed task from queue
     */
    completeTask(chatId, taskId) {
        const queueData = this.getQueue(chatId);
        const index = queueData.queue.findIndex(t => t.id === taskId);
        if (index !== -1) {
            queueData.queue.splice(index, 1);
        }
        queueData.currentTask = null;
        queueData.isProcessing = false;
    }

    /**
     * Set current process (for cancel functionality)
     */
    setCurrentProcess(chatId, process) {
        const queueData = this.getQueue(chatId);
        queueData.currentProcess = process;
    }

    /**
     * Cancel current task
     * @returns {{success: boolean, message: string}}
     */
    cancelCurrent(chatId) {
        const queueData = this.getQueue(chatId);

        if (!queueData.isProcessing || !queueData.currentTask) {
            return { success: false, message: 'No task is currently running' };
        }

        // Kill the process if it exists
        if (queueData.currentProcess) {
            try {
                queueData.currentProcess.kill('SIGTERM');
                // Force kill after 5 seconds
                setTimeout(() => {
                    try {
                        queueData.currentProcess.kill('SIGKILL');
                    } catch (e) { /* ignore */ }
                }, 5000);
            } catch (e) {
                console.log('[TaskQueue] Error killing process:', e.message);
            }
        }

        const cancelledTask = queueData.currentTask;
        queueData.currentTask = null;
        queueData.isProcessing = false;
        queueData.currentProcess = null;

        // Remove from queue
        const index = queueData.queue.findIndex(t => t.id === cancelledTask?.id);
        if (index !== -1) {
            queueData.queue.splice(index, 1);
        }

        return { success: true, message: 'Task cancelled', taskId: cancelledTask?.id };
    }

    /**
     * Clear all pending tasks (not the current one)
     */
    clearQueue(chatId) {
        const queueData = this.getQueue(chatId);
        const clearedCount = queueData.queue.length - (queueData.isProcessing ? 1 : 0);

        if (queueData.isProcessing && queueData.currentTask) {
            // Keep only the current task
            queueData.queue = queueData.queue.filter(t => t.id === queueData.currentTask.id);
        } else {
            queueData.queue = [];
        }

        return { success: true, clearedCount };
    }

    /**
     * Get queue status
     */
    getStatus(chatId) {
        const queueData = this.getQueue(chatId);

        return {
            queueLength: queueData.queue.length,
            isProcessing: queueData.isProcessing,
            currentTask: queueData.currentTask ? {
                id: queueData.currentTask.id,
                prompt: queueData.currentTask.prompt.substring(0, 50) + '...',
                addedAt: queueData.currentTask.addedAt
            } : null,
            pendingTasks: queueData.queue.slice(queueData.isProcessing ? 1 : 0).map((t, i) => ({
                position: i + 1,
                id: t.id,
                prompt: t.prompt.substring(0, 30) + '...',
                addedAt: t.addedAt
            }))
        };
    }

    /**
     * Start processing next task
     */
    startProcessing(chatId) {
        const queueData = this.getQueue(chatId);
        if (queueData.isProcessing || queueData.queue.length === 0) {
            return null;
        }

        queueData.isProcessing = true;
        queueData.currentTask = queueData.queue[0];
        queueData.currentTask.status = 'processing';
        queueData.currentTask.startedAt = new Date().toISOString();

        return queueData.currentTask;
    }

    /**
     * Format status for display
     */
    formatStatusMessage(chatId) {
        const status = this.getStatus(chatId);
        const lines = [];

        lines.push(`Queue Status:`);
        lines.push(`Total: ${status.queueLength} task(s)`);

        if (status.currentTask) {
            lines.push(`\nCurrently running:`);
            lines.push(`  [${status.currentTask.id}] ${status.currentTask.prompt}`);
        }

        if (status.pendingTasks.length > 0) {
            lines.push(`\nPending:`);
            status.pendingTasks.forEach(t => {
                lines.push(`  ${t.position}. [${t.id}] ${t.prompt}`);
            });
        }

        if (status.queueLength === 0) {
            lines.push(`\nQueue is empty.`);
        }

        return lines.join('\n');
    }
}

module.exports = {
    TaskQueue,
    MAX_QUEUE_SIZE,
    MAX_TASK_CONTENT_LENGTH,
    TASK_TIMEOUT
};
