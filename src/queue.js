/**
 * QueueManager
 * Sistem Antrean berjalur tunggal (Single-Lane FIFO) untuk memperlambat eksekusi asinkron 
 * sehingga meminimalisir blokir massal / spamming.
 */
class QueueManager {
    constructor(processCallback, delayMs = 3000) {
        this.queue = [];
        this.isProcessing = false;
        this.processCallback = processCallback;
        this.delayMs = delayMs;
    }

    /**
     * Menambahkan Job baru ke antrean.
     */
    add(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            if (!this.isProcessing) {
                this.process();
            }
        });
    }

    /**
     * Memproses Job terdepan. Setelah selesai, dijeda delayMs milidetik.
     */
    async process() {
        if (this.queue.length === 0) {
            this.isProcessing = false;
            return;
        }

        this.isProcessing = true;
        const { task, resolve, reject } = this.queue.shift();

        try {
            const result = await this.processCallback(task);
            resolve(result);
        } catch (error) {
            reject(error);
        }

        // Delay protektif sebelum melahap pesan selanjutnya
        setTimeout(() => {
            this.process();
        }, this.delayMs);
    }
}

module.exports = QueueManager;
