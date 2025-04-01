// background.js
console.log('[Background] Service Worker started.');

// --- State ---
// Stores the problem slug associated with each tab where the editor is injected.
// Note: In-memory store, will be lost if the service worker becomes inactive for extended periods.
const tabSlugs = {};

// --- Constants ---
const POLLING_INTERVAL_MS = 300;
const MAX_POLLING_ATTEMPTS = 30; // ~9 seconds total polling time
const SCRIPT_INJECTION_WORLD = 'MAIN'; // Inject scripts into the page's main execution context

// --- Helper Functions ---

/**
 * Executes a function within the MAIN execution world of a specific tab.
 * @param {number} tabId - The ID of the target tab.
 * @param {Function} func - The function to execute in the tab's context.
 * @param {Array<any>} [args=[]] - Arguments to pass to the function.
 * @returns {Promise<any>} A promise resolving with the result of the function execution.
 * @throws Will throw an error if script execution fails.
 */
async function executeInMainWorld(tabId, func, args = []) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: false }, // Target only the main frame
      world: SCRIPT_INJECTION_WORLD,
      func: func,
      args: args,
      // injectImmediately: false // Often recommended for MAIN world, but monitor stability
    });
    // Return the result from the first (and usually only) frame's execution
    // Handle cases where results might be undefined or empty
    return results?.[0]?.result;
  } catch (error) {
    console.error(`[Background] Error executing script in MAIN world (Tab ${tabId}):`, error);
    // Check for common errors like tab closed or invalid context
    if (error.message.includes("No tab with id") || error.message.includes("Cannot access")) {
        throw new Error(`Tab ${tabId} closed or inaccessible during script execution.`);
    }
    throw error; // Re-throw other errors
  }
}

/**
 * Polls the MAIN execution world of a tab until a condition function returns true or timeout.
 * @param {number} tabId - The ID of the target tab.
 * @param {Function} checkFunc - A function (to be run in MAIN world) that returns true when the condition is met.
 * @param {string} description - A description of the condition being polled for (for logging).
 * @returns {Promise<any>} A promise resolving with the result of checkFunc when true, or rejecting on timeout/error.
 */
async function pollForCondition(tabId, checkFunc, description) {
  let attempts = 0;
  while (attempts < MAX_POLLING_ATTEMPTS) {
    // Verify tab existence before each attempt
    try {
      await chrome.tabs.get(tabId);
    } catch (e) {
      console.log(`[Background] Tab ${tabId} closed or removed while polling for '${description}'. Aborting poll.`);
      throw new Error(`Tab ${tabId} closed during polling for ${description}.`);
    }

    // console.log(`[Background] (Tab ${tabId}) Polling attempt ${attempts + 1}/${MAX_POLLING_ATTEMPTS} for: ${description}`); // Verbose logging
    try {
      const result = await executeInMainWorld(tabId, checkFunc);
      if (result) {
        console.log(`[Background] (Tab ${tabId}) Polling SUCCESS for: ${description}`, result);
        return result; // Condition met
      }

      // Check for explicit error flags set by the page script during polling
      const errorStatus = await executeInMainWorld(tabId, () => window.monacoInjectError || window.monacoSyncError);
      if (errorStatus) {
          console.error(`[Background] (Tab ${tabId}) Page signaled error while polling for '${description}':`, errorStatus);
          throw new Error(`Page signaled error: ${errorStatus}`); // Throw specific error
      }

    } catch (error) {
        // Catch errors from executeInMainWorld OR the explicit error thrown above
      console.error(`[Background] (Tab ${tabId}) Error during polling attempt for '${description}':`, error.message);
      // If executeInMainWorld failed (e.g., navigation, tab closed), stop polling
      throw error;
    }

    attempts++;
    await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
  }

  console.error(`[Background] (Tab ${tabId}) Polling TIMEOUT after ${attempts} attempts for: ${description}`);
  throw new Error(`Timeout waiting for ${description} in tab ${tabId}`);
}


// --- Core Logic: Monaco Injection and Setup ---

/**
 * Handles the entire process of injecting Monaco Editor into a LeetCode page.
 * @param {number} tabId - The ID of the target tab.
 * @param {object} options - Options received from the content script.
 * @param {string} options.containerId - The ID of the div to host the editor.
 * @param {string} options.language - The language mode for the editor.
 * @param {string} options.theme - The theme for the editor (e.g., 'vs-dark').
 * @param {string} options.initialCode - The code to load initially.
 * @param {string} options.problemSlug - The LeetCode problem slug.
 * @param {function} sendResponse - Function to send response back to the content script.
 */
async function injectAndSetupMonaco(tabId, options, sendResponse) {
    const { containerId, language, theme, initialCode, problemSlug } = options;

    // Store slug association for saving later
    if (problemSlug) {
        tabSlugs[tabId] = problemSlug;
        console.log(`[Background] (Tab ${tabId}) Associated slug '${problemSlug}'`);
    } else {
        console.warn(`[Background] (Tab ${tabId}) No problemSlug received. Code saving will not function correctly.`);
        delete tabSlugs[tabId]; // Clear any previous slug if needed
    }

    console.log(`[Background] (Tab ${tabId}) Starting Monaco injection process for slug '${problemSlug}'`, { containerId, language, theme, initialCodeLength: initialCode?.length ?? 0 });

    try {
        // --- Step 1: Inject Monaco Loader ---
        console.log(`[Background] (Tab ${tabId}) Step 1: Injecting loader.js...`);
        await chrome.scripting.executeScript({
            target: { tabId: tabId, allFrames: false },
            world: SCRIPT_INJECTION_WORLD,
            files: ['lib/monaco-editor/min/loader.js'],
            // injectImmediately: false
        });
        console.log(`[Background] (Tab ${tabId}) Step 1: loader.js injected.`);

        // --- Step 2: Verify 'require' is Defined ---
        console.log(`[Background] (Tab ${tabId}) Step 2: Polling for window.require definition...`);
        await pollForCondition(tabId, () => typeof window.require === 'function', 'window.require definition');
        console.log(`[Background] (Tab ${tabId}) Step 2: window.require verified.`);

        // --- Step 3: Configure RequireJS & Load Monaco Core ---
        console.log(`[Background] (Tab ${tabId}) Step 3: Injecting Monaco config & load call...`);
        const monacoBaseUrl = chrome.runtime.getURL('lib/monaco-editor/min/vs');
        const editorWorkerUrl = chrome.runtime.getURL('lib/monaco-editor/min/vs/editor/editor.worker.js'); // Ensure this path is correct

        await executeInMainWorld(tabId, (baseUrl, workerUrl) => {
            console.log('[PAGE] Configuring Monaco Environment and RequireJS...');
            window.monacoInjectError = null; // Reset error flag

            // Define MonacoEnvironment for worker loading (essential for MV3/CSP)
            window.MonacoEnvironment = {
                getWorkerUrl: function (_moduleId, label) {
                    // Simple worker loading strategy. May need label checks for specific workers (json, css, etc.) if used.
                    const workerPath = 'lib/monaco-editor/min/vs/editor/editor.worker.js'; // Relative path within extension
                    const fullWorkerUrl = chrome.runtime.getURL(workerPath); // Get full extension URL
                    console.log(`[PAGE] Monaco requesting worker: label=${label}, path=${workerPath}, resolved URL=${fullWorkerUrl}`);

                    // Use the data URL hack for cross-origin worker loading in MV3
                    return `data:text/javascript;charset=utf-8,${encodeURIComponent(`
                        // Setup environment for the worker script itself
                        self.MonacoEnvironment = { baseUrl: '${chrome.runtime.getURL('lib/monaco-editor/min/')}' };
                        // Import the actual worker script
                        importScripts('${fullWorkerUrl}');
                    `)}`;
                }
            };

            console.log('[PAGE] Configuring require paths. Base URL:', baseUrl);
            require.config({
                paths: { 'vs': baseUrl },
                'vs/nls': { availableLanguages: { '*': 'en'} } // Ensure NLS support is configured minimally
            });

            console.log('[PAGE] Calling require(["vs/editor/editor.main"]) asynchronously...');
            // Use a promise to track loading state for polling
            window.monacoLoadingPromise = new Promise((resolve, reject) => {
                require(
                    ['vs/editor/editor.main'], // Module to load
                    () => { // Success callback
                        console.log('[PAGE] SUCCESS: require callback executed for vs/editor/editor.main.');
                        if (typeof monaco !== 'undefined' && typeof monaco.editor !== 'undefined') {
                            console.log('[PAGE] Monaco global object (window.monaco.editor) is available.');
                            resolve(); // Signal success
                        } else {
                            console.error('[PAGE] ERROR: require callback executed but window.monaco or window.monaco.editor is not defined!');
                            window.monacoInjectError = 'Monaco loaded via require, but global object not found.';
                            reject(new Error(window.monacoInjectError));
                        }
                    },
                    (error) => { // Error callback
                        console.error('[PAGE] ERROR: Failed loading vs/editor/editor.main via require:', error);
                        window.monacoInjectError = `RequireJS failed to load editor.main: ${error}`;
                        reject(error);
                    }
                );
            });
        }, [monacoBaseUrl, editorWorkerUrl]);
        console.log(`[Background] (Tab ${tabId}) Step 3: Monaco config injected.`);

        // --- Step 4: Poll for Monaco Global Object Readiness ---
        console.log(`[Background] (Tab ${tabId}) Step 4: Polling for Monaco global object (window.monaco.editor)...`);
        await pollForCondition(
            tabId,
            () => typeof window.monaco !== 'undefined' && typeof window.monaco.editor !== 'undefined',
            'window.monaco.editor definition after require'
        );
        console.log(`[Background] (Tab ${tabId}) Step 4: Monaco global object confirmed.`);

        // --- Step 5: Inject Editor Creation Code ---
        console.log(`[Background] (Tab ${tabId}) Step 5: Injecting editor creation call...`);
        await executeInMainWorld(tabId, (id, lang, editorTheme, code) => {
            console.log(`[PAGE] Attempting to create Monaco editor in container #${id}`);
            window.monacoInjectError = null; // Reset error flag
            window.monacoCreateStatus = 'pending'; // Status flag for polling

            const container = document.getElementById(id);
            if (!container) {
                console.error(`[PAGE] FATAL ERROR: Container element #${id} not found in DOM!`);
                window.monacoInjectError = `Container element #${id} not found`;
                window.monacoCreateStatus = 'error';
                return; // Stop execution in page context
            }
            // Ensure container is visible and has basic dimensions (can be overridden by CSS)
            container.style.display = 'block';
            container.style.height = container.style.height || '600px';
            container.style.width = container.style.width || '100%';
            // container.style.border = container.style.border || '1px solid #ccc'; // Optional: visual cue

            try {
                // Double-check monaco exists right before creation
                if (typeof monaco === 'undefined' || typeof monaco.editor === 'undefined') {
                   throw new Error('window.monaco or monaco.editor disappeared unexpectedly before creation!');
                }

                console.log('[PAGE] Calling monaco.editor.create...');
                // --- Create the Editor Instance ---
                // Store on window for later access (e.g., sync, potentially user interaction)
                window.leetCodeMonacoInstance = monaco.editor.create(container, {
                    value: code,
                    language: lang,
                    theme: editorTheme,
                    automaticLayout: true, // Essential for resizing
                    minimap: { enabled: true }, // Example option
                    // Add other desired Monaco options here:
                    // scrollBeyondLastLine: false,
                    // wordWrap: 'on',
                    // renderLineHighlight: 'gutter',
                });
                console.log('[PAGE] SUCCESS: Monaco editor instance (window.leetCodeMonacoInstance) created.');
                window.monacoCreateStatus = 'success'; // Signal success for polling

            } catch (error) {
                console.error('[PAGE] ERROR creating Monaco editor instance:', error);
                window.monacoInjectError = `Editor creation failed: ${error.message}`;
                window.monacoCreateStatus = 'error'; // Signal error for polling
            }
        }, [containerId, language, theme, initialCode]);
        console.log(`[Background] (Tab ${tabId}) Step 5: Editor creation code injected.`);

        // --- Step 6: Poll for Editor Creation Status ---
        console.log(`[Background] (Tab ${tabId}) Step 6: Polling for editor creation status...`);
        await pollForCondition(
            tabId,
            // Wait for either explicit success or error status set by the creation script
            () => window.monacoCreateStatus === 'success' || window.monacoCreateStatus === 'error',
            'editor creation status (window.monacoCreateStatus)'
        );

        // Explicitly check the final status after polling
        const creationStatus = await executeInMainWorld(tabId, () => window.monacoCreateStatus);
        if (creationStatus !== 'success') {
            const creationError = await executeInMainWorld(tabId, () => window.monacoInjectError);
            throw new Error(`Editor creation failed or did not report success. Final Status: ${creationStatus}, Error: ${creationError || 'Unknown page error'}`);
        }
        console.log(`[Background] (Tab ${tabId}) Step 6: Monaco editor instance confirmed created on page.`);

        // --- Step 7: Inject Code Sync Listener (Editor -> LeetCode & Save Trigger) ---
        // Renamed step for clarity, combines sync and save trigger logic injection
        console.log(`[Background] (Tab ${tabId}) Step 7: Injecting code sync listener & save trigger...`);
        await executeInMainWorld(tabId, (saveEventName) => {
            // This function runs entirely in the LeetCode page's MAIN world context
            console.log('[PAGE] Setting up code sync listener & save event trigger...');
            window.monacoSyncError = null; // Reset sync-specific error flag
            window.monacoSyncSetup = 'pending'; // Flag setup process

            // Ensure our editor instance exists
            if (!window.leetCodeMonacoInstance) {
                console.error('[PAGE] Sync Setup FATAL: window.leetCodeMonacoInstance is not defined! Cannot attach listener.');
                window.monacoSyncError = 'Injected instance (leetCodeMonacoInstance) not found during sync setup.';
                window.monacoSyncSetup = 'failed';
                return;
            }

            // Check for LeetCode's editor namespace (may not exist immediately)
            // Warning: This relies on LeetCode's internal 'lcMonaco' object. Highly fragile!
            if (typeof window.lcMonaco?.editor?.getEditors !== 'function') {
                console.warn('[PAGE] Sync Setup WARNING: window.lcMonaco.editor.getEditors not found initially. Sync might fail if it doesn\'t appear later.');
                // Don't mark as failed yet, it might become available later
                // window.monacoSyncError = 'Original LeetCode editor accessor (lcMonaco.editor.getEditors) not found initially.';
            }

            let debounceTimeout;
            const DEBOUNCE_DELAY_MS = 350; // Adjust as needed

            console.log('[PAGE] Attaching onDidChangeModelContent listener to window.leetCodeMonacoInstance.');
            window.leetCodeMonacoInstance.onDidChangeModelContent(() => {
                clearTimeout(debounceTimeout);
                debounceTimeout = setTimeout(() => {
                    console.log('[PAGE] Debounced change detected. Attempting sync to LeetCode editor & dispatching save event...');
                    window.monacoSyncStatus = 'syncing'; // Track current operation

                    try {
                        // --- Sync to LeetCode's hidden editor ---
                        // WARNING: Fragile - Relies on LeetCode's internal structure/objects
                        const lcEditorAccessor = window.lcMonaco?.editor;
                        if (typeof lcEditorAccessor?.getEditors !== 'function') {
                            if (!window.monacoSyncError) { // Log error only once per persistent issue
                                console.error('[PAGE] Sync Error: window.lcMonaco.editor.getEditors is not available! Cannot sync.');
                                window.monacoSyncError = 'lcMonaco.editor.getEditors not available for sync.';
                            }
                            window.monacoSyncStatus = 'error';
                            return; // Cannot sync
                        }

                        const leetCodeEditors = lcEditorAccessor.getEditors();
                        const targetEditorInstance = leetCodeEditors?.[0]; // Assume first editor is the target

                        if (!targetEditorInstance) {
                            if (!window.monacoSyncError) {
                                console.error('[PAGE] Sync Error: lcMonaco.editor.getEditors() returned no valid editor instance.');
                                window.monacoSyncError = 'Target LeetCode editor instance not found via getEditors().';
                            }
                            window.monacoSyncStatus = 'error';
                            return; // Cannot sync
                        }

                        const currentCode = window.leetCodeMonacoInstance.getValue();
                        console.log(`[PAGE] Syncing code (length: ${currentCode.length}) to target LeetCode editor instance.`);

                        let syncSuccessful = false;
                        // Try syncing using common methods (prefer model if available)
                        if (typeof targetEditorInstance.getModel === 'function') {
                            const targetModel = targetEditorInstance.getModel();
                            if (targetModel && typeof targetModel.setValue === 'function') {
                                targetModel.setValue(currentCode);
                                syncSuccessful = true;
                                // console.log('[PAGE] Sync method: model.setValue()');
                            }
                        }
                        // Fallback: Try setting value directly on the editor instance
                        if (!syncSuccessful && typeof targetEditorInstance.setValue === 'function') {
                            targetEditorInstance.setValue(currentCode);
                            syncSuccessful = true;
                            // console.log('[PAGE] Sync method: instance.setValue()');
                        }

                        if (syncSuccessful) {
                             console.log('[PAGE] Sync to LeetCode editor successful.');
                             window.monacoSyncError = null; // Clear previous transient sync errors

                            // --- Trigger Save Request via Custom Event ---
                            console.log(`[PAGE] Dispatching custom event '${saveEventName}' for saving.`);
                            const saveEvent = new CustomEvent(saveEventName, {
                                detail: { code: currentCode } // Pass the code to the content script listener
                            });
                            window.dispatchEvent(saveEvent);
                            window.monacoSyncStatus = 'synced_and_save_requested';

                        } else {
                            // If both methods failed
                            if (!window.monacoSyncError) {
                                console.error('[PAGE] Sync Error: Could not sync code to target LeetCode editor. No known setValue method worked.');
                                window.monacoSyncError = 'Failed to sync: Target editor missing known value setting methods.';
                            }
                            window.monacoSyncStatus = 'error';
                        }

                    } catch (error) {
                        console.error('[PAGE] Runtime Error during sync/save dispatch process:', error);
                        window.monacoSyncError = `Runtime error during sync/save dispatch: ${error.message}`;
                        window.monacoSyncStatus = 'error';
                    }
                }, DEBOUNCE_DELAY_MS); // End of setTimeout callback
            }); // End of onDidChangeModelContent listener

            console.log('[PAGE] Code sync listener and save trigger attached successfully.');
            window.monacoSyncSetup = 'success'; // Mark setup step successful

        }, [options.saveEventName || '__monaco_save_code__']); // Pass event name (use default if not provided)
        console.log(`[Background] (Tab ${tabId}) Step 7: Sync listener injected.`);

        // --- Step 8: Final Success Response ---
        console.log(`[Background] (Tab ${tabId}) Monaco injection and setup process completed successfully. Sending success response.`);
        sendResponse({ success: true });

    } catch (error) { // Catch block for the entire async injection process
        console.error(`[Background] (Tab ${tabId}) FATAL ERROR during Monaco injection/setup process:`, error);
        // Clean up slug association on any failure
        delete tabSlugs[tabId];

        // Attempt to signal the error on the page for easier debugging (best effort)
        const errorMessage = error instanceof Error ? error.message : String(error);
        try {
            await executeInMainWorld(tabId, (msg) => {
                window.monacoInjectError = `Background script failure: ${msg}`;
                // Update status flags to prevent potential hangs in other logic
                window.monacoCreateStatus = window.monacoCreateStatus === 'pending' ? 'error' : window.monacoCreateStatus;
                window.monacoSyncSetup = window.monacoSyncSetup === 'pending' ? 'failed' : window.monacoSyncSetup;
                console.error(`[PAGE] Setting error flags due to background failure: ${msg}`);
            }, [errorMessage]);
        } catch (cleanupError) {
            console.error(`[Background] (Tab ${tabId}) Failed to set error state on page during cleanup:`, cleanupError);
        }

        // Send failure response back to the content script
        sendResponse({ success: false, error: errorMessage });
    }
}

// --- Message Listener ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Ensure the message is from a tab's content script
    if (!sender.tab || !sender.tab.id) {
        console.warn("[Background] Received message without sender tab ID:", message);
        // Optionally send an error response if expecting one
        // sendResponse({ success: false, error: "Invalid sender" });
        return false; // Do not keep channel open
    }
    const tabId = sender.tab.id;

    // --- Handler: Monaco Injection Request ---
    if (message.action === 'injectAndCreateMonaco' && message.options) {
        // Use the async function to handle the process
        injectAndSetupMonaco(tabId, message.options, sendResponse);
        // Return true to indicate that sendResponse will be called asynchronously
        return true;
    }

    // --- Handler: Save Code Request ---
    else if (message.action === 'saveCodeForTab') {
        const slug = tabSlugs[tabId];
        const codeToSave = message.code;

        if (slug && codeToSave !== undefined) {
            const storageKey = `leetcodeCode-${slug}`;
            console.log(`[Background] (Tab ${tabId}) Received 'saveCodeForTab'. Saving code for slug '${slug}' (key: '${storageKey}', length: ${codeToSave.length})`);

            chrome.storage.local.set({ [storageKey]: codeToSave }, () => {
                // This callback runs AFTER the storage operation completes
                if (chrome.runtime.lastError) {
                    console.error(`[Background] (Tab ${tabId}) Error saving code to chrome.storage.local for key ${storageKey}:`, chrome.runtime.lastError);
                    sendResponse({ success: false, error: chrome.runtime.lastError.message });
                } else {
                     console.log(`[Background] (Tab ${tabId}) Successfully saved code for key ${storageKey}.`);
                     sendResponse({ success: true });
                }
            });
            // Return true because sendResponse is called asynchronously in the storage callback
            return true;

        } else {
            console.warn(`[Background] (Tab ${tabId}) Could not save code. Slug ('${slug}') or code (defined: ${codeToSave !== undefined}) missing/invalid.`);
            // Send an immediate failure response as prerequisites are not met
            sendResponse({ success: false, error: `Cannot save: Slug ('${slug}') is missing or code is undefined.` });
            return false; // sendResponse was called synchronously
        }
    }

    // --- Add other message handlers here if needed ---
    // else if (message.action === 'someOtherAction') { ... }

    // If no handler matched or the handler didn't return true, indicate synchronous response (or none)
    // console.log("[Background] Message not handled or handled synchronously:", message.action);
    return false;
});

// --- Tab Lifecycle Management ---

// Clean up slug association when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabSlugs[tabId]) {
        console.log(`[Background] Tab ${tabId} closed. Cleaning up associated slug: '${tabSlugs[tabId]}'`);
        delete tabSlugs[tabId];
    }
});

// Clean up slug association if a tab navigates away from a LeetCode problem page
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Check only when the tab has finished loading and if we have a slug associated
    if (tabSlugs[tabId] && changeInfo.status === 'complete' && tab.url) {
        const associatedSlug = tabSlugs[tabId];
        const problemUrlPattern = `/problems/${associatedSlug}`; // Simple check

        // If the URL no longer seems to be the specific problem page for the stored slug
        if (!tab.url.includes("leetcode.com/problems/") || !tab.url.includes(problemUrlPattern)) {
            console.log(`[Background] Tab ${tabId} navigated away from problem page for slug '${associatedSlug}'. Cleaning up slug association. New URL: ${tab.url}`);
            delete tabSlugs[tabId];
        }
    }
});