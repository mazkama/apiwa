require('dotenv').config();
const waManager = require('./src/wa');
const { startServer } = require('./src/server');

// Handler global agar aplikasi tidak mati mendadak jika ada error ringan
process.on('uncaughtException', function (err) {
    console.error('Uncaught Exception: ', err);
    // Jika port bentrok (mencegah bot jalan dobel), matikan paksa!
    if (err.code === 'EADDRINUSE') {
        console.error('\nBENTROK: Port 3000 sudah dipakai! Mematikan bot ganda...\n');
        process.exit(1);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection (Promise) di:', promise, 'alasan:', reason);
});

// Mulai koneksi WhatsApp
waManager.connect();

// Start API Server
startServer(process.env.PORT || 3000);
