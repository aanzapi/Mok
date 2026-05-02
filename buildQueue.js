/**
 * Build Queue System - Professional Edition
 * Features:
 * - Persistent queue (saved to file)
 * - Priority levels: Owner (2), Reseller (1), Normal (0)
 * - User name tracking
 * - Real-time position updates
 * - Auto-cleanup on complete
 * - Statistics tracking
 */

const fs = require('fs');
const path = require('path');

class BuildQueue {
    constructor() {
        // Configuration
        this.maxConcurrent = parseInt(process.env.MAX_CONCURRENT_BUILDS) || 1;
        this.maxConcurrent = Math.max(1, Math.min(this.maxConcurrent, 4));

        // Admin IDs for priority queue (level 2)
        this.adminIds = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim());

        // Reseller IDs (level 1) - will be loaded from resellerService
        this.resellerIds = new Set();

        // Queue state
        this.queue = [];                    // Pending builds [{chatId, userName, buildData, type, addedAt, priorityLevel}]
        this.activeBuilds = new Map();      // chatId -> buildInfo

        // Statistics
        this.stats = {
            success: 0,
            failed: 0,
            total: 0,
            totalTime: 0
        };

        // Callbacks
        this.onBuildStart = null;           // Called when queued build should start
        this.onQueueUpdate = null;          // Called when queue position changes
        this.botInstance = null;

        // Timeout settings
        this.MAX_BUILD_TIME = 45 * 60 * 1000;
        this.INACTIVITY_TIMEOUT = 10 * 60 * 1000;

        // File paths
        this.dataDir = path.join(__dirname, '..', '..', 'data');
        this.queueFile = path.join(this.dataDir, 'queue.json');

        // Load saved data
        this.load();

        console.log(`🔧 Build Queue: max ${this.maxConcurrent} concurrent build(s)`);
        console.log(`📊 Stats: ${this.stats.total} total, ${this.stats.success} success, ${this.stats.failed} failed`);
        console.log(`👑 Admin IDs: ${this.adminIds.length} configured`);

        // Start watchdog
        this.startWatchdog();
    }

    /**
     * Set bot instance for notifications
     */
    setBot(botInstance) {
        this.botInstance = botInstance;
    }

    /**
     * Load reseller IDs from external service
     */
    loadResellers() {
        try {
            const resellerService = require('./resellerService');
            const resellers = resellerService.listResellers();
            this.resellerIds.clear();
            for (const reseller of resellers) {
                this.resellerIds.add(String(reseller.id));
            }
            console.log(`⭐ Reseller IDs: ${this.resellerIds.size} configured`);
        } catch (error) {
            console.log('Reseller service not loaded yet, will retry later');
        }
    }

    /**
     * Get priority level for a user
     * Level 2: Owner/Admin (👑)
     * Level 1: Reseller (⭐)
     * Level 0: Normal user
     */
    getPriorityLevel(chatId) {
        const chatIdStr = String(chatId);
        
        // Check Owner/Admin (level 2)
        if (this.adminIds.includes(chatIdStr)) {
            return 2;
        }
        
        // Check Reseller (level 1)
        if (this.resellerIds.has(chatIdStr)) {
            return 1;
        }
        
        // Normal user (level 0)
        return 0;
    }

    /**
     * Get priority emoji based on level
     */
    getPriorityEmoji(priorityLevel) {
        if (priorityLevel === 2) return '👑';
        if (priorityLevel === 1) return '⭐';
        return '';
    }

    /**
     * Check if user is admin/owner (level 2)
     */
    isAdmin(chatId) {
        return this.adminIds.includes(String(chatId));
    }

    /**
     * Check if user is reseller (level 1)
     */
    isReseller(chatId) {
        return this.resellerIds.has(String(chatId));
    }

    /**
     * Load queue and stats from file
     */
    load() {
        try {
            if (fs.existsSync(this.queueFile)) {
                const data = JSON.parse(fs.readFileSync(this.queueFile, 'utf8'));
                this.queue = data.queue || [];
                this.stats = data.stats || this.stats;
                console.log(`📂 Loaded queue: ${this.queue.length} pending builds`);
            }
        } catch (error) {
            console.error('Failed to load queue:', error.message);
        }
    }

    /**
     * Save queue and stats to file
     */
    save() {
        try {
            if (!fs.existsSync(this.dataDir)) {
                fs.mkdirSync(this.dataDir, { recursive: true });
            }
            fs.writeFileSync(this.queueFile, JSON.stringify({
                queue: this.queue,
                stats: this.stats,
                lastSaved: new Date().toISOString()
            }, null, 2));
        } catch (error) {
            console.error('Failed to save queue:', error.message);
        }
    }

    /**
     * Start watchdog for stuck builds
     */
    startWatchdog() {
        setInterval(() => {
            this.checkStuckBuilds();
        }, 60 * 1000);
    }

    /**
     * Check and release stuck builds
     */
    checkStuckBuilds() {
        if (this.activeBuilds.size === 0) return;

        const now = Date.now();
        const toRelease = [];

        for (const [chatId, build] of this.activeBuilds) {
            const totalTime = now - build.startTime;
            const inactiveTime = now - (build.lastActivity || build.startTime);

            if (totalTime > this.MAX_BUILD_TIME) {
                console.warn(`[Queue] ⚠️ BUILD TIMEOUT! Chat ${chatId}`);
                toRelease.push({ chatId, reason: 'timeout' });
            } else if (inactiveTime > this.INACTIVITY_TIMEOUT) {
                console.warn(`[Queue] ⚠️ BUILD INACTIVE! Chat ${chatId}`);
                toRelease.push({ chatId, reason: 'inactive' });
            }
        }

        for (const { chatId } of toRelease) {
            this.release(chatId, false);
        }
    }

    /**
     * Update activity timestamp
     */
    updateActivity(chatId = null) {
        if (chatId && this.activeBuilds.has(chatId)) {
            this.activeBuilds.get(chatId).lastActivity = Date.now();
        } else {
            for (const build of this.activeBuilds.values()) {
                build.lastActivity = Date.now();
            }
        }
    }

    /**
     * Check if queue is at capacity
     */
    isBusy() {
        return this.activeBuilds.size >= this.maxConcurrent;
    }

    /**
     * Get queue info
     */
    getQueueInfo() {
        return {
            total: this.queue.length + this.activeBuilds.size,
            processing: this.activeBuilds.size,
            waiting: this.queue.length,
            maxConcurrent: this.maxConcurrent
        };
    }

    /**
     * Get statistics
     */
    getStats() {
        const avgTime = this.stats.success > 0
            ? Math.round(this.stats.totalTime / this.stats.success / 1000)
            : 0;

        return {
            success: this.stats.success,
            failed: this.stats.failed,
            total: this.stats.total,
            avgTime: avgTime
        };
    }

    /**
     * Get user's position in queue (1-indexed)
     */
    getUserPosition(chatId) {
        const index = this.queue.findIndex(item => item.chatId === chatId);
        return index >= 0 ? index + 1 : 0;
    }

    /**
     * Get estimated wait time in minutes
     */
    getEstimatedWait(position) {
        const avgTime = this.stats.success > 0
            ? Math.round(this.stats.totalTime / this.stats.success / 1000 / 60)
            : 3;

        const waitPosition = Math.max(0, position - (this.maxConcurrent - this.activeBuilds.size));
        return Math.max(1, Math.ceil(waitPosition * avgTime / this.maxConcurrent));
    }

    /**
     * Check if user has pending build
     */
    hasPendingBuild(chatId) {
        return this.queue.some(item => item.chatId === chatId);
    }

    /**
     * Check if user has active build
     */
    hasActiveBuild(chatId) {
        return this.activeBuilds.has(chatId);
    }

    /**
     * Get all queue items with user info (for display)
     */
getQueueList() {
    return this.queue.map((item, index) => ({
        position: index + 1,
        chatId: item.chatId,
        userName: item.userName || 'Unknown',
        projectName: item.buildData?.appName || item.buildData?.projectType || 'Project',
        type: item.type,
        priorityLevel: item.priorityLevel,
        // HAPUS baris "priority: item.priorityLevel >= 1"
        addedAt: item.addedAt,
        estimatedWait: this.getEstimatedWait(index + 1)
    }));
}

    /**
     * Get all active builds with user info
     */
    getActiveBuilds() {
        return Array.from(this.activeBuilds.entries()).map(([chatId, build]) => ({
            chatId,
            userName: build.userName || 'Unknown',
            projectName: build.buildData?.appName || build.buildData?.projectType || 'Project',
            type: build.type,
            priorityLevel: build.priorityLevel,
            startTime: build.startTime,
            duration: Math.round((Date.now() - build.startTime) / 1000)
        }));
    }

    /**
     * Sort queue by priority level (higher first) then added time
     */
    sortQueue() {
        this.queue.sort((a, b) => {
            // Higher priority level first
            if (a.priorityLevel !== b.priorityLevel) {
                return b.priorityLevel - a.priorityLevel;
            }
            // Same priority, earlier first
            return a.addedAt - b.addedAt;
        });
        
        // Update positions
        this.queue.forEach((item, idx) => {
            item.position = idx + 1;
        });
    }

    /**
     * Add build to queue with priority level
     * @param {number} chatId - User Telegram ID
     * @param {object} buildData - Build data
     * @param {string} type - 'url' or 'zip'
     * @param {string} userName - User display name
     * @param {number} priorityLevel - 2=Owner, 1=Reseller, 0=Normal
     */
    addToQueue(chatId, buildData, type = 'url', userName = 'User', priorityLevel = null) {
        // Load resellers if needed
        if (this.resellerIds.size === 0) {
            this.loadResellers();
        }
        
        // Determine priority level if not provided
        if (priorityLevel === null) {
            priorityLevel = this.getPriorityLevel(chatId);
        }
        
        // Remove existing pending build for this user
        this.removeFromQueue(chatId);

        // Increment total stats
        this.stats.total++;

        // Check if can start immediately
        if (!this.isBusy() && !this.activeBuilds.has(chatId)) {
            const acquired = this.acquire(chatId, buildData, type, userName, priorityLevel);
            if (acquired) {
                this.save();
                return {
                    queued: true,
                    position: 0,
                    immediate: true,
                    isPriority: priorityLevel >= 1,
                    priorityLevel: priorityLevel,
                    message: '🚀 Build dimulai!'
                };
            }
        }

        // Create queue item
        const queueItem = {
            id: `build_${Date.now()}_${chatId}`,
            chatId,
            userName,
            buildData,
            type,
            priorityLevel: priorityLevel,
            addedAt: Date.now(),
            status: 'waiting'
        };

        // Add to queue
        this.queue.push(queueItem);
        
        // Sort queue by priority
        this.sortQueue();

        console.log(`[Queue] 📋 Build queued: ${chatId} (${userName}) priority=${priorityLevel} at position ${this.getUserPosition(chatId)}`);

        this.save();

        const position = this.getUserPosition(chatId);
        const estimatedWait = this.getEstimatedWait(position);

        return {
            queued: true,
            position,
            immediate: false,
            buildId: queueItem.id,
            estimatedWait,
            isPriority: priorityLevel >= 1,
            priorityLevel: priorityLevel,
            message: priorityLevel === 2
                ? `👑 Prioritas Owner! Posisi: #${position}`
                : priorityLevel === 1
                ? `⭐ Prioritas Reseller! Posisi: #${position}`
                : `📋 Antrian #${position}, ~${estimatedWait} menit`
        };
    }

    /**
     * Remove from pending queue
     */
    removeFromQueue(chatId) {
        const index = this.queue.findIndex(item => item.chatId === chatId);
        if (index >= 0) {
            this.queue.splice(index, 1);
            this.sortQueue();
            this.save();
            console.log(`[Queue] 🗑️ Removed from queue: ${chatId}`);

            // Notify remaining users about position update
            this.notifyQueueUpdates();
            return true;
        }
        return false;
    }

    /**
     * Notify all users in queue about position updates
     */
    async notifyQueueUpdates() {
        if (!this.onQueueUpdate) return;

        for (let i = 0; i < this.queue.length; i++) {
            const item = this.queue[i];
            try {
                await this.onQueueUpdate(item.chatId, i + 1, this.queue.length, this.getEstimatedWait(i + 1));
            } catch (e) {
                console.log(`[Queue] Failed to notify ${item.chatId}:`, e.message);
            }
        }
    }

    /**
     * Acquire build slot
     */
    acquire(chatId, buildData = null, type = 'url', userName = 'User', priorityLevel = 0) {
        if (this.activeBuilds.has(chatId)) {
            console.log(`[Queue] ⚠️ Chat ${chatId} already building`);
            return false;
        }

        if (this.activeBuilds.size >= this.maxConcurrent) {
            console.log(`[Queue] 🚫 Full (${this.activeBuilds.size}/${this.maxConcurrent})`);
            return false;
        }

        const now = Date.now();
        const priorityEmoji = priorityLevel === 2 ? '👑' : (priorityLevel === 1 ? '⭐' : '');
        this.activeBuilds.set(chatId, {
            startTime: now,
            lastActivity: now,
            buildData,
            type,
            userName,
            priorityLevel
        });

        console.log(`[Queue] ✅ Started: ${priorityEmoji} ${chatId} by ${userName} (${this.activeBuilds.size}/${this.maxConcurrent}) priority=${priorityLevel}`);
        return true;
    }

    /**
     * Release build slot and record result
     */
    release(chatId, success = true) {
        const build = this.activeBuilds.get(chatId);
        if (!build) {
            console.warn(`[Queue] Release non-existent: ${chatId}`);
            return;
        }

        const duration = Date.now() - build.startTime;

        // Update stats
        if (success) {
            this.stats.success++;
            this.stats.totalTime += duration;
        } else {
            this.stats.failed++;
        }

        const durationSec = Math.round(duration / 1000);
        console.log(`[Queue] ${success ? '✅' : '❌'} Completed: ${chatId} (${durationSec}s) priority=${build.priorityLevel}`);

        this.activeBuilds.delete(chatId);
        this.save();

        // Process next in queue
        this.processNext();
    }

    /**
     * Process next build in queue (respects priority)
     */
    async processNext() {
        if (this.queue.length === 0) {
            console.log(`[Queue] 📭 No pending builds`);
            return;
        }

        if (this.isBusy()) {
            console.log(`[Queue] ⏳ Still busy (${this.activeBuilds.size}/${this.maxConcurrent})`);
            return;
        }

        // Sort queue by priority before taking next
        this.sortQueue();
        
        // Take first item from queue (highest priority)
        const nextBuild = this.queue.shift();
        if (!nextBuild) return;

        console.log(`[Queue] 🚀 Auto-starting: ${nextBuild.chatId} (${nextBuild.userName}) priority=${nextBuild.priorityLevel}`);

        // Try to acquire build slot
        const acquired = this.acquire(
            nextBuild.chatId,
            nextBuild.buildData,
            nextBuild.type,
            nextBuild.userName,
            nextBuild.priorityLevel
        );

        if (!acquired) {
            // Failed to acquire - put item back at front of queue
            console.log(`[Queue] ⚠️ Failed to acquire slot for ${nextBuild.chatId}, returning to queue`);
            this.queue.unshift(nextBuild);
            this.save();
            return;
        }

        this.save();

        // Notify remaining users about position update
        this.notifyQueueUpdates();

        if (this.onBuildStart) {
            try {
                await this.onBuildStart(
                    nextBuild.chatId,
                    nextBuild.buildData,
                    nextBuild.type,
                    nextBuild.userName
                );
            } catch (error) {
                console.error(`[Queue] ❌ Auto-start error for ${nextBuild.chatId}:`, error.message);
                // Release the slot so queue can continue
                this.release(nextBuild.chatId, false);
            }
        } else {
            console.error(`[Queue] ❌ onBuildStart callback not set! Releasing slot.`);
            this.release(nextBuild.chatId, false);
        }
    }

    /**
     * Get formatted queue status message for a user
     */
    getQueueStatusMessage(chatId) {
        const info = this.getQueueInfo();
        const stats = this.getStats();
        const position = this.getUserPosition(chatId);
        const isActive = this.hasActiveBuild(chatId);

        // Status icon
        let statusIcon = '🟢';
        let statusText = 'Siap';
        if (info.processing >= this.maxConcurrent) {
            statusIcon = '🔴';
            statusText = 'Penuh';
        } else if (info.processing > 0) {
            statusIcon = '🟡';
            statusText = 'Aktif';
        }

        let message = `📋 <b>Status Antrian</b>\n━━━━━━━━━━━━━━━━━━\n\n`;
        message += `${statusIcon} <b>Server:</b> ${statusText}\n`;
        message += `📊 <b>Slot:</b> ${info.processing}/${info.maxConcurrent} terpakai\n`;

        if (info.waiting > 0) {
            message += `⏳ <b>Antrian:</b> ${info.waiting} menunggu\n`;
        }

        message += `\n<b>📈 Statistik:</b>\n`;
        message += `✅ ${stats.success} berhasil | ❌ ${stats.failed} gagal\n`;
        message += `⏱ Rata-rata: ${stats.avgTime}s\n`;

        if (isActive) {
            const build = this.activeBuilds.get(chatId);
            const duration = Math.round((Date.now() - build.startTime) / 1000);
            message += `\n🔄 <b>Build Anda sedang berjalan</b> (${Math.floor(duration / 60)}m ${duration % 60}s)`;
        } else if (position > 0) {
            const estimatedWait = this.getEstimatedWait(position);
            const priorityLevel = this.getPriorityLevel(chatId);
            const emoji = priorityLevel === 2 ? '👑 ' : (priorityLevel === 1 ? '⭐ ' : '');
            message += `\n${emoji}<b>Posisi Anda:</b> #${position} dari ${info.waiting}`;
            message += `\n⏱ <b>Estimasi:</b> ~${estimatedWait} menit`;
        }

        return message;
    }

    /**
     * Get formatted queue list for admin
     */
    getAdminQueueMessage() {
        this.sortQueue();
        const activeBuilds = this.getActiveBuilds();
        const queueList = this.getQueueList();

        let message = `👑 <b>Admin - Queue Manager</b>\n━━━━━━━━━━━━━━━━━━\n\n`;

        // Active builds
        message += `<b>🔨 Sedang Berjalan (${activeBuilds.length}/${this.maxConcurrent}):</b>\n`;
        if (activeBuilds.length === 0) {
            message += `<i>Tidak ada</i>\n`;
        } else {
            for (const build of activeBuilds) {
                const mins = Math.floor(build.duration / 60);
                const secs = build.duration % 60;
                const emoji = build.priorityLevel === 2 ? '👑' : (build.priorityLevel === 1 ? '⭐' : '');
                message += `• ${emoji} ${build.userName} - ${build.projectName} (${mins}m ${secs}s)\n`;
            }
        }

        // Queue
        message += `\n<b>📋 Antrian (${queueList.length}):</b>\n`;
        if (queueList.length === 0) {
            message += `<i>Kosong</i>\n`;
        } else {
            for (const item of queueList.slice(0, 10)) {
                const emoji = item.priorityLevel === 2 ? '👑' : (item.priorityLevel === 1 ? '⭐' : '');
                message += `${item.position}. ${emoji} ${item.userName} - ${item.projectName}\n`;
            }
            if (queueList.length > 10) {
                message += `<i>...dan ${queueList.length - 10} lainnya</i>\n`;
            }
        }

        return message;
    }

    /**
     * Refresh reseller list (call this when reseller changes)
     */
    refreshResellers() {
        this.loadResellers();
        // Re-sort queue with new reseller priorities
        this.sortQueue();
        this.save();
        console.log(`[Queue] 🔄 Reseller list refreshed, queue re-sorted`);
    }

    /**
     * Force release (for stuck builds)
     */
    forceRelease(chatId = null) {
        if (chatId) {
            if (this.activeBuilds.has(chatId)) {
                console.log(`[Queue] 🔄 Force release: ${chatId}`);
                this.activeBuilds.delete(chatId);
                this.processNext();
            }
        } else {
            console.log(`[Queue] 🔄 Force release ALL`);
            this.activeBuilds.clear();
            this.processNext();
        }
        this.save();
    }

    /**
     * Cleanup old temporary files
     */
    async cleanup() {
        const tempDir = path.join(__dirname, '..', '..', 'temp');
        const outputDir = path.join(__dirname, '..', 'output');
        let filesDeleted = 0;
        let spaceFreed = 0;

        for (const dir of [tempDir, outputDir]) {
            if (!fs.existsSync(dir)) continue;

            try {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    const filePath = path.join(dir, file);
                    try {
                        const stats = fs.statSync(filePath);
                        spaceFreed += stats.size;

                        if (stats.isDirectory()) {
                            fs.rmSync(filePath, { recursive: true, force: true });
                        } else {
                            fs.unlinkSync(filePath);
                        }
                        filesDeleted++;
                    } catch (e) { }
                }
            } catch (e) { }
        }

        return {
            filesDeleted,
            spaceFreed: (spaceFreed / (1024 * 1024)).toFixed(2)
        };
    }

    /**
     * Reset statistics (admin)
     */
    resetStats() {
        this.stats = { success: 0, failed: 0, total: 0, totalTime: 0 };
        this.save();
        return true;
    }

    /**
     * Clear all pending queue (admin)
     */
    clearQueue() {
        const count = this.queue.length;
        this.queue = [];
        this.save();
        return count;
    }
}

// Singleton instance
const buildQueue = new BuildQueue();

module.exports = { buildQueue };