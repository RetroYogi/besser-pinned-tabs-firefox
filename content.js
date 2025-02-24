document.addEventListener('DOMContentLoaded', async () => {
    const debugModeCheckbox = document.getElementById('debugMode');
    const downloadLogsButton = document.getElementById('downloadLogs');
    const clearLogsButton = document.getElementById('clearLogs');
    const differentDomainsRadio = document.getElementById('differentDomainsOnly');
    const allLinksRadio = document.getElementById('allLinks');
    const logsDiv = document.getElementById('logs');

    // Load current settings
    const result = await browser.storage.local.get(['debugMode', 'linkBehavior']);
    debugModeCheckbox.checked = result.debugMode || false;
    const linkBehavior = result.linkBehavior || 'different-domains';
    if (linkBehavior === 'different-domains') {
        differentDomainsRadio.checked = true;
    } else {
        allLinksRadio.checked = true;
    }

    // Update debug mode setting
    debugModeCheckbox.addEventListener('change', async () => {
        await browser.storage.local.set({ debugMode: debugModeCheckbox.checked });
    });

    // Update link behavior setting
    const updateLinkBehavior = async (event) => {
        await browser.storage.local.set({ linkBehavior: event.target.value });
    };
    differentDomainsRadio.addEventListener('change', updateLinkBehavior);
    allLinksRadio.addEventListener('change', updateLinkBehavior);

    // Display logs
    async function updateLogsDisplay() {
        const result = await browser.storage.local.get('debugLogs');
        const logs = result.debugLogs || [];
        logsDiv.textContent = logs.map(log => 
            `[${log.timestamp}] ${log.message} ${log.data ? JSON.stringify(log.data) : ''}`
        ).join('\n');
    }

    // Download logs
    downloadLogsButton.addEventListener('click', async () => {
        const result = await browser.storage.local.get('debugLogs');
        const logs = result.debugLogs || [];
        const logsText = logs.map(log => 
            `[${log.timestamp}] ${log.message} ${log.data ? JSON.stringify(log.data) : ''}`
        ).join('\n');
        
        const blob = new Blob([logsText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'besser-pinned-tabs-debug.log';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    // Clear logs
    clearLogsButton.addEventListener('click', async () => {
        await browser.storage.local.set({ debugLogs: [] });
        updateLogsDisplay();
    });

    // Update logs display periodically
    updateLogsDisplay();
    setInterval(updateLogsDisplay, 5000);
});