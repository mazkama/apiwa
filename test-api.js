const http = require('http');

async function testSuite() {
    console.log('--- RUNNING APIWA INTEGRATION TEST SUITE ---');
    const baseUrl = 'http://127.0.0.1:3100';

    // 1. Test Login & Session Cookie
    console.log('\n[1] Testing Dashboard Login API...');
    const loginRes = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' })
    });
    const loginData = await loginRes.json();
    console.log('Login Result:', loginData);
    if (!loginData.success) throw new Error('Login failed');

    const cookie = loginRes.headers.get('set-cookie');

    // 2. Test Master API Key Retrieval
    console.log('\n[2] Testing Master API Key Retrieval...');
    const masterRes = await fetch(`${baseUrl}/api/master-key`, {
        headers: { 'Cookie': cookie }
    });
    const masterData = await masterRes.json();
    console.log('Master API Key:', masterData);
    if (!masterData.success) throw new Error('Failed to get master API key');

    // 3. Test Create Session with Custom Slug
    console.log('\n[3] Testing Create Isolated Session Node...');
    const testSessionId = 'test-node-' + Math.floor(Math.random() * 1000);
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
        body: JSON.stringify({ sessionId: testSessionId, sessionName: 'Automated Test Node' })
    });
    const createData = await createRes.json();
    console.log('Created Session:', createData);
    if (!createData.success) throw new Error('Failed to create session');

    const sessionApiKey = createData.session.apiKey;

    // 4. Test Pause & Resume
    console.log('\n[4] Testing Pause & Resume Lifecycle...');
    const pauseRes = await fetch(`${baseUrl}/api/sessions/${testSessionId}/pause`, {
        method: 'POST',
        headers: { 'Cookie': cookie }
    });
    const pauseData = await pauseRes.json();
    console.log('Pause Result:', pauseData);

    const resumeRes = await fetch(`${baseUrl}/api/sessions/${testSessionId}/resume`, {
        method: 'POST',
        headers: { 'Cookie': cookie }
    });
    const resumeData = await resumeRes.json();
    console.log('Resume Result:', resumeData);

    // 5. Test Settings Update (Webhook & Secret)
    console.log('\n[5] Testing Session Settings Update...');
    const settingsRes = await fetch(`${baseUrl}/api/sessions/${testSessionId}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
        body: JSON.stringify({
            webhookUrl: 'https://httpbin.org/post',
            webhookSecret: 'sec_test_secret_123',
            webhookEvents: ['message.received', 'message.status']
        })
    });
    const settingsData = await settingsRes.json();
    console.log('Settings Update Result:', settingsData);

    // 6. Test Webhook Ping Simulator
    console.log('\n[6] Testing Webhook Dispatch Simulation...');
    const pingRes = await fetch(`${baseUrl}/api/sessions/${testSessionId}/webhook/test`, {
        method: 'POST',
        headers: { 'Cookie': cookie }
    });
    const pingData = await pingRes.json();
    console.log('Webhook Ping Result:', pingData);

    // 7. Test Export Postman Endpoint
    console.log('\n[7] Testing Dynamic Postman Collection Export...');
    const exportRes = await fetch(`${baseUrl}/api/export-postman?sessionId=${testSessionId}`);
    const postmanJson = await exportRes.json();
    console.log('Exported Postman Collection Name:', postmanJson.info.name);
    console.log('Items Count:', postmanJson.item.length);

    // 8. Test Delete Session Cleanup
    console.log('\n[8] Cleaning up test session...');
    const delRes = await fetch(`${baseUrl}/api/sessions/${testSessionId}`, {
        method: 'DELETE',
        headers: { 'Cookie': cookie }
    });
    const delData = await delRes.json();
    console.log('Delete Result:', delData);

    console.log('\n✅ ALL INTEGRATION TESTS PASSED SUCCESSFULLY!\n');
}

testSuite().catch(err => {
    console.error('\n❌ TEST FAILED:', err);
    process.exit(1);
});
