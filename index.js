require('dotenv').config();
const { startServer } = require('./src/server');

// Error Handling Global
process.on('uncaughtException', (err) => {
    if (err.code === 'EADDRINUSE') {
        const crashedPort = process.env.PORT || 3000;
        console.error(`\nBENTROK: Port ${crashedPort} sudah dipakai! Mematikan bot ganda...\n`);
        process.exit(1);
    }
    console.error('Unhandled Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection (Promise) di:', promise, 'alasan:', reason);
});

// Start API Server
startServer(process.env.PORT || 3000);
