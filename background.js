let debugMode = false;
let linkBehavior = 'different-domains';
const pinnedTabs = new Map(); // Stores pinned tab IDs and their URLs
const navigationLocks = new Map(); // Prevents concurrent navigation handling for the same tab

// Debug logging function - writes to both storage and console if debug mode is enabled
function debugLog(message, data = null) {
    if (debugMode) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            message,
            data
        };
        browser.storage.local.get('debugLogs').then(result => {
            const logs = result.debugLogs || [];
            logs.push(logEntry);
            browser.storage.local.set({ debugLogs: logs });
        });
        console.log(`[${timestamp}] ${message}`, data || '');
    }
}

// Initial settings load on extension startup
browser.storage.local.get(['debugMode', 'linkBehavior']).then(result => {
    debugMode = result.debugMode || false;
    linkBehavior = result.linkBehavior || 'different-domains';
    debugLog('Extension initialized', { debugMode, linkBehavior });
});

// Listen for settings changes
browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        if (changes.debugMode) {
            debugMode = changes.debugMode.newValue;
            debugLog('Debug mode changed:', debugMode);
        }
        if (changes.linkBehavior) {
            linkBehavior = changes.linkBehavior.newValue;
            debugLog('Link behavior changed:', linkBehavior);
        }
    }
});

// Determines if two URLs belong to different domains
function isDifferentDomain(url1, url2) {
    try {
        const domain1 = new URL(url1);
        const domain2 = new URL(url2);
        
        if (domain1.protocol === 'about:' || domain2.protocol === 'about:' ||
            domain1.protocol === 'chrome:' || domain2.protocol === 'chrome:' ||
            domain1.protocol === 'moz-extension:' || domain2.protocol === 'moz-extension:') {
            return true;
        }
        
        const getBaseDomain = (hostname) => {
            const parts = hostname.split('.');
            return parts.length > 2 ? parts.slice(-2).join('.') : hostname;
        };
        
        return getBaseDomain(domain1.hostname) !== getBaseDomain(domain2.hostname);
    } catch (e) {
        debugLog('URL parsing error:', e);
        return true;
    }
}
// Determines whether a navigation should open in a new tab based on current settings
function shouldOpenInNewTab(currentUrl, newUrl) {
    // Allow exact URL matches (e.g., refreshes) to load in the same tab
    if (currentUrl === newUrl) {
        return false;
    }

    if (linkBehavior === 'all-links') {
        return true;
    }
    return isDifferentDomain(currentUrl, newUrl);
}

// Persists the current state of pinned tabs to browser storage
async function savePinnedTabs() {
    const pinnedUrls = Array.from(pinnedTabs.entries());
    await browser.storage.local.set({ pinnedUrls });
    debugLog('Saved pinned tabs to storage:', pinnedUrls);
}

//  initialization function
async function initializeExtension() {
    debugLog('Starting extension initialization');
    
    try {
        // First load settings
        const result = await browser.storage.local.get(['debugMode', 'linkBehavior', 'pinnedUrls']);
        debugMode = result.debugMode || false;
        linkBehavior = result.linkBehavior || 'different-domains';
        debugLog('Settings loaded:', { debugMode, linkBehavior });
        
        // Get all currently pinned tabs
        const pinnedTabsList = await browser.tabs.query({ pinned: true });
        debugLog('Found pinned tabs:', pinnedTabsList.map(tab => ({
            id: tab.id,
            url: tab.url
        })));
        
        // Clear existing pinned tabs map
        pinnedTabs.clear();
        
        // Add all current pinned tabs to our map
        for (const tab of pinnedTabsList) {
            if (tab.url && tab.url !== 'about:blank') {
                pinnedTabs.set(tab.id, tab.url);
            }
        }
        
        // Save to storage
        await savePinnedTabs();
        debugLog('Extension initialization complete', {
            pinnedTabsCount: pinnedTabs.size,
            pinnedTabs: Array.from(pinnedTabs.entries())
        });
    } catch (error) {
        debugLog('Error during initialization:', error);
    }
}

// Extension lifecycle event handlers - ensure proper initialization
browser.runtime.onStartup.addListener(initializeExtension);
browser.runtime.onInstalled.addListener(initializeExtension);

// Call initialization immediately
initializeExtension();

// Tab update handler - maintains pinned tab state
// Tracks both pin/unpin actions and URL changes in pinned tabs
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // Update pinned status changes
    if (changeInfo.pinned !== undefined) {
        if (changeInfo.pinned && tab.url !== 'about:blank') {
            pinnedTabs.set(tabId, tab.url);
        } else {
            pinnedTabs.delete(tabId);
        }
        await savePinnedTabs();
        debugLog('Tab pin status changed:', { tabId, pinned: changeInfo.pinned, url: tab.url });
    }
    
    // Update URL for existing pinned tabs
    if (changeInfo.url && tab.pinned && tab.url !== 'about:blank') {
        pinnedTabs.set(tabId, tab.url);
        await savePinnedTabs();
        debugLog('Pinned tab URL updated:', { tabId, url: tab.url });
    }
});

// Track last navigation attempt to prevent loops
const lastNavigationAttempts = new Map();

// Main navigation handler
// Intercepts navigation in pinned tabs and handles it according to settings:
// - Opens different-domain URLs in new tabs
// - Preserves pinned tab's original URL
// - Handles navigation locks to prevent concurrent operations
// - Includes retry mechanism for tab restoration
browser.webNavigation.onBeforeNavigate.addListener(async (details) => {
    // Early lock check and set
    const lockKey = `nav_${details.tabId}`;
    if (navigationLocks.get(lockKey)) {
        debugLog('Navigation already in progress, skipping:', {
            tabId: details.tabId,
            newUrl: details.url
        });
        return;
    }
    
    // Set the lock immediately
    navigationLocks.set(lockKey, true);
    
    try {
        // Only proceed if this is a main frame navigation in a pinned tab
        if (details.frameId !== 0 || !pinnedTabs.has(details.tabId)) {
            return;
        }

        const tab = await browser.tabs.get(details.tabId);
        if (!tab?.pinned || !tab.url) {
            return;
        }

        const currentUrl = pinnedTabs.get(details.tabId) || tab.url;
        const newUrl = details.url;
        const now = Date.now();

        // Get the last navigation attempt for this tab
        const lastAttempt = lastNavigationAttempts.get(details.tabId);
        
        // If this is a redirect back to the original URL, allow it
        if (lastAttempt && 
            (now - lastAttempt.timestamp) < 1000 && 
            newUrl === lastAttempt.originalUrl) {
            debugLog('Allowing redirect back to original URL:', {
                tabId: details.tabId,
                url: newUrl
            });
            return;
        }

        // Check if we should handle this navigation
        if (!shouldOpenInNewTab(currentUrl, newUrl)) {
            return;
        }

        debugLog('Starting navigation handling:', {
            tabId: details.tabId,
            currentUrl,
            newUrl,
            timestamp: now
        });

        // Store this navigation attempt
        lastNavigationAttempts.set(details.tabId, {
            timestamp: now,
            originalUrl: currentUrl
        });

        // Create the new tab first
        const newTab = await browser.tabs.create({ 
            url: newUrl,
            index: tab.index + 1
        });
        
        debugLog('New tab created:', {
            originalTabId: details.tabId,
            newTabId: newTab.id,
            newTabUrl: newUrl,
            newTabIndex: newTab.index
        });

        // Wait briefly to ensure new tab creation is complete
        await new Promise(resolve => setTimeout(resolve, 100));

        // Prevent the navigation in the pinned tab
        let updatedTab = await browser.tabs.update(details.tabId, { 
            url: currentUrl,
            loadReplace: true
        });

        // Verify the update was successful
        if (updatedTab.url !== currentUrl) {
            // Retry once if the first attempt failed
            await new Promise(resolve => setTimeout(resolve, 50));
            updatedTab = await browser.tabs.update(details.tabId, { 
                url: currentUrl,
                loadReplace: true
            });
        }

        debugLog('Pinned tab restored:', {
            tabId: details.tabId,
            restoredUrl: currentUrl,
            success: updatedTab.url === currentUrl
        });

        debugLog('Navigation handled in pinned tab:', { 
            tabId: details.tabId, 
            currentUrl, 
            newUrl,
            behavior: linkBehavior
        });

    } catch (error) {
        debugLog('Error handling navigation:', {
            error,
            tabId: details.tabId,
            url: details.url
        });
    } finally {
        // Always clean up the navigation lock
        navigationLocks.delete(lockKey);
    }
}, {
    url: [{
        schemes: ['http', 'https']
    }]
});

// Cleanup handler for closed tabs
// Removes all stored state related to a tab when it's closed
browser.tabs.onRemoved.addListener(async (tabId) => {
    if (pinnedTabs.has(tabId)) {
        pinnedTabs.delete(tabId);
        lastNavigationAttempts.delete(tabId);
        navigationLocks.delete(`nav_${tabId}`);
        await savePinnedTabs();
        debugLog('Removed closed tab from pinnedTabs:', tabId);
    }
});