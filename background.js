/**
 * LeetCode Monaco Injector: Background Service Worker
 *
 * Handles communication between the content script and the injected MAIN world scripts.
 * Responsibilities:
 * 1. Listens for 'injectAndCreateMonaco' messages from the content script.
 * 2. Orchestrates the injection of Monaco loader and editor core into the page's MAIN world.
 * 3. Configures Monaco environment (including worker paths).
 * 4. Creates the Monaco editor instance in the MAIN world.
 * 5. Injects logic into the MAIN world to synchronize code changes from the injected
 *    editor back to LeetCode's original (hidden) editor instance.
 * 6. Injects logic into the MAIN world to dispatch a custom event when code changes,
 *    triggering the save mechanism.
 * 7. Listens for 'saveCodeForTab' messages from the content script (triggered by the custom event).
 * 8. Saves the received code to chrome.storage.local, associated with the problem slug.
 * 9. Manages the association between tab IDs and problem slugs.
 * 10. Cleans up tab/slug associations when tabs are closed or navigate away.
 */
'use strict';

// --- Constants ---
const LOG_PREFIX = '[Background]';
const STORAGE_KEY_PREFIX = 'leetcodeCode-';
const MONACO_LOADER_PATH = 'lib/monaco-editor/min/loader.js';
const MONACO_BASE_URL_PATH = 'lib/monaco-editor/min/vs'; // Relative to extension root
const MONACO_EDITOR_MAIN_PATH = 'vs/editor/editor.main';
const MONACO_WORKER_PATH = 'lib/monaco-editor/min/vs/editor/editor.worker.js'; // Relative to extension root

// MAIN world variable names (used within executeInMainWorld functions)
const MW_REQUIRE_VAR = 'require';
const MW_MONACO_VAR = 'monaco';
const MW_INSTANCE_VAR = 'leetCodeMonacoInstance'; // Our injected editor instance
const MW_LC_NAMESPACE_VAR = 'lcMonaco'; // LeetCode's original Monaco namespace (heuristic)
const MW_INJECT_ERROR_FLAG = 'monacoInjectError';
const MW_CREATE_STATUS_FLAG = 'monacoCreateStatus';
const MW_SYNC_ERROR_FLAG = 'monacoSyncError';
const MW_SYNC_SETUP_FLAG = 'monacoSyncSetup';
const MW_SYNC_STATUS_FLAG = 'monacoSyncStatus';
const MW_SAVE_EVENT_NAME = '__monaco_save_code__'; // Custom event dispatched from MAIN world

// Polling Configuration
const POLLING_INTERVAL_MS = 300;
const MAX_POLLING_ATTEMPTS = 35; // Slightly increased to ~10.5 seconds total

// --- State ---
// Simple in-memory store for associating a problem slug with an active tab ID.
// Lost when the service worker becomes inactive, but repopulated by content script on injection.
const tabSlugs = {};

// --- Logging Helper ---
function log(level, tabId, ...args) {
    const prefix = `${LOG_PREFIX}${tabId ? ` (Tab ${tabId})` : ''}:`;
    switch (level) {
        case 'error':
            console.error(prefix, ...args);
            break;
        case 'warn':
            console.warn(prefix, ...args);
            break;
        case 'info':
        default:
            console.log(prefix, ...args);
            break;
    }
}

// --- Helper: Execute Script in MAIN world ---
async function executeInMainWorld(tabId, func, args = []) {
    try {
        // Ensure tab still exists before attempting execution
        await chrome.tabs.get(tabId);

        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId, allFrames: false }, // Target only the top-level frame
            world: 'MAIN',
            func: func,
            args: args,
            injectImmediately: false // Generally safer for MAIN world
        });

        // executeScript returns an array of results, one for each frame matched.
        // Since we target only the main frame, we expect one result.
        if (results && results[0]) {
             if (results[0].error) {
                 // Handle errors reported by the execution itself
                 log('error', tabId, `Script execution resulted in error:`, results[0].error);
                 throw new Error(`MAIN world script execution error: ${results[0].error.message || results[0].error}`);
             }
             return results[0].result;
        } else {
            // This case should ideally not happen with a valid tabId and target
            log('warn', tabId, 'executeInMainWorld received no results. Tab might be inaccessible or frame structure unexpected.');
            return undefined;
        }

    } catch (error) {
        // Catch errors from chrome.tabs.get (tab closed) or chrome.scripting.executeScript
        if (error.message.includes('No tab with id') || error.message.includes('cannot be scripted')) {
            log('warn', tabId, `Tab closed or became inaccessible during MAIN world script execution. Error:`, error.message);
        } else {
            log('error', tabId, `Error executing script in MAIN world:`, error);
        }
        // Rethrow to be handled by the calling context (e.g., stop polling)
        throw error;
    }
}

// --- Helper: Poll for a condition in MAIN world ---
async function pollForCondition(tabId, checkFunc, description) {
    let attempts = 0;
    while (attempts < MAX_POLLING_ATTEMPTS) {
        try {
            // Tab existence check already happens within executeInMainWorld,
            // but an extra check here doesn't hurt and catches closure before the call.
            await chrome.tabs.get(tabId);
        } catch (e) {
            log('warn', tabId, `Tab closed or removed during polling for '${description}'. Aborting poll.`);
            throw new Error(`Tab ${tabId} closed during polling.`);
        }

        log('info', tabId, `Polling attempt ${attempts + 1}/${MAX_POLLING_ATTEMPTS} for: ${description}`);
        try {
            // Execute the check function in the MAIN world
            const result = await executeInMainWorld(tabId, checkFunc);
            if (result) {
                log('info', tabId, `Polling success for: ${description}`, result);
                return result; // Condition met
            }

            // Check for explicit error flags set by MAIN world scripts
            const errorStatus = await executeInMainWorld(tabId, () =>
                window[MW_INJECT_ERROR_FLAG] || window[MW_SYNC_ERROR_FLAG] || (window[MW_CREATE_STATUS_FLAG] === 'error')
            );
            if (errorStatus) {
                 // Retrieve the specific error message if available
                 const specificError = await executeInMainWorld(tabId, () => window[MW_INJECT_ERROR_FLAG] || window[MW_SYNC_ERROR_FLAG] || 'Creation status indicated error');
                 log('error', tabId, `Error signaled from page while polling for '${description}':`, specificError);
                 throw new Error(`Page signaled error: ${specificError}`);
            }

        } catch (error) {
            // Catch errors from executeInMainWorld OR the explicit error thrown above
            log('error', tabId, `Error during polling for ${description}:`, error);
            // If executeInMainWorld fails (e.g., navigation, tab closed), stop polling
            throw error; // Propagate the error up
        }

        attempts++;
        // Wait before the next attempt
        await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
    }

    // If loop completes without success
    log('error', tabId, `Polling timed out after ${attempts} attempts for: ${description}`);
    throw new Error(`Timeout waiting for ${description}`);
}


// --- Message Listener ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Ensure the message is from a content script within a tab
    if (!sender.tab || !sender.tab.id) {
        log('warn', null, 'Received message without sender tab context:', message);
        return false; // Ignore messages not from tabs
    }
    const tabId = sender.tab.id;

    // --- Handler for Monaco Injection Request ---
    if (message.action === 'injectAndCreateMonaco') {
        handleInjectRequest(tabId, message.options, sendResponse);
        return true; // Indicate asynchronous response
    }

    // --- Handler for Save Code Request ---
    else if (message.action === 'saveCodeForTab') {
        handleSaveRequest(tabId, message.code, sendResponse);
        return true; // Indicate asynchronous response
    }

    // --- Unknown action ---
    else {
        log('warn', tabId, `Received unknown action: ${message.action}`);
        return false; // No asynchronous response needed
    }
});

// --- Handler Functions ---

/**
 * Handles the 'injectAndCreateMonaco' request from the content script.
 * Orchestrates the entire injection and setup process.
 */
async function handleInjectRequest(tabId, options, sendResponse) {
    const { containerId, language, theme, initialCode, problemSlug } = options;

    // Store the slug associated with this tab for later saving
    if (problemSlug) {
        tabSlugs[tabId] = problemSlug;
        log('info', tabId, `Associated slug '${problemSlug}'`);
    } else {
        log('warn', tabId, `No problemSlug received with injection request. Code saving will not work for this tab.`);
        delete tabSlugs[tabId]; // Clear any potentially stale slug
    }

    log('info', tabId, `Received request to inject Monaco`, { containerId, language, theme, initialCodeLength: initialCode?.length ?? 0, slug: tabSlugs[tabId] });

    try {
        // --- Step 1: Inject Monaco Loader Script ---
        log('info', tabId, `Injecting Monaco loader (${MONACO_LOADER_PATH})...`);
        await chrome.scripting.executeScript({
            target: { tabId: tabId, allFrames: false },
            world: 'MAIN',
            files: [MONACO_LOADER_PATH],
            injectImmediately: false
        });
        log('info', tabId, `Loader injected.`);

        // --- Step 2: Verify Loader Readiness (window.require) ---
        log('info', tabId, `Verifying window.${MW_REQUIRE_VAR}...`);
        await pollForCondition(
            tabId,
            () => typeof window[MW_REQUIRE_VAR] === 'function', // Check if require exists
            `window.${MW_REQUIRE_VAR} definition`
        );
        log('info', tabId, `window.${MW_REQUIRE_VAR} verified.`);

        // --- Step 3: Configure RequireJS & Monaco Environment, Load Editor Core ---
        log('info', tabId, `Injecting Monaco config & load call...`);
        const monacoBaseUrl = chrome.runtime.getURL(MONACO_BASE_URL_PATH);
        const editorWorkerUrl = chrome.runtime.getURL(MONACO_WORKER_PATH); // Full URL for the worker script

        await executeInMainWorld(tabId, (baseUrl, workerUrl, workerPath, mainPath, constants) => {
            console.log('[PAGE] Configuring Monaco Environment and RequireJS...');
            window[constants.MW_INJECT_ERROR_FLAG] = null; // Reset error flag

            // Define MonacoEnvironment for worker loading
            window.MonacoEnvironment = {
                getWorkerUrl: function (moduleId, label) {
                    // Use the pre-calculated full worker URL.
                    // This simplified approach assumes a single worker type.
                    // Complex scenarios might check `label` (e.g., 'json', 'css', 'html').
                    console.log(`[PAGE] Monaco requesting worker: label=${label}, module=${moduleId}. Providing URL: ${workerUrl}`);

                    // The Data URL hack remains a common way to handle cross-origin worker loading in extensions.
                    return `data:text/javascript;charset=utf-8,${encodeURIComponent(`
                        self.MonacoEnvironment = { baseUrl: '${chrome.runtime.getURL('lib/monaco-editor/min/')}' };
                        importScripts('${workerUrl}');
                    `)}`;
                }
            };
            console.log('[PAGE] MonacoEnvironment configured.');

            // Configure RequireJS paths
            console.log('[PAGE] Configuring require paths. Base URL:', baseUrl);
            window[constants.MW_REQUIRE_VAR].config({
                paths: { 'vs': baseUrl },
                'vs/nls': { availableLanguages: { '*': 'en' } } // Force English NLS bundles
            });

            // Initiate loading of the main editor module
            console.log(`[PAGE] Calling require(["${mainPath}"])...`);
            window.monacoLoadingPromise = new Promise((resolve, reject) => {
                window[constants.MW_REQUIRE_VAR]([mainPath], () => {
                    console.log(`[PAGE] require callback: ${mainPath} loaded.`);
                    if (typeof window[constants.MW_MONACO_VAR] !== 'undefined' && typeof window[constants.MW_MONACO_VAR].editor !== 'undefined') {
                        console.log('[PAGE] Monaco global object (window.monaco) is available.');
                        resolve();
                    } else {
                        const errorMsg = `require callback executed but window.${constants.MW_MONACO_VAR}.editor is not defined!`;
                        console.error(`[PAGE] ERROR: ${errorMsg}`);
                        window[constants.MW_INJECT_ERROR_FLAG] = errorMsg;
                        reject(new Error(errorMsg));
                    }
                }, (error) => {
                    const errorMsg = `RequireJS failed to load ${mainPath}`;
                    console.error(`[PAGE] ERROR: ${errorMsg}:`, error);
                    window[constants.MW_INJECT_ERROR_FLAG] = `${errorMsg}: ${error}`;
                    reject(error);
                });
            });
        }, [monacoBaseUrl, editorWorkerUrl, MONACO_WORKER_PATH, MONACO_EDITOR_MAIN_PATH, { // Pass constants
            MW_REQUIRE_VAR, MW_MONACO_VAR, MW_INJECT_ERROR_FLAG
        }]);
        log('info', tabId, `Monaco config and load call injected.`);

        // --- Step 4: Poll for Monaco Core Readiness (window.monaco.editor) ---
        log('info', tabId, `Polling for Monaco global object (window.${MW_MONACO_VAR}.editor)...`);
        await pollForCondition(
            tabId,
            () => typeof window[MW_MONACO_VAR] !== 'undefined' && typeof window[MW_MONACO_VAR].editor !== 'undefined',
            `window.${MW_MONACO_VAR}.editor definition after require`
        );
        log('info', tabId, `Monaco global object confirmed.`);

        // --- Step 5: Inject Editor Creation Code ---
        log('info', tabId, `Injecting editor creation call...`);
        await executeInMainWorld(tabId, (id, lang, editorTheme, code, constants) => {
            console.log(`[PAGE] Creating Monaco editor in container #${id}`);
            window[constants.MW_INJECT_ERROR_FLAG] = null; // Reset error flag
            window[constants.MW_CREATE_STATUS_FLAG] = 'pending'; // Set status

            const container = document.getElementById(id);
            if (!container) {
                const errorMsg = `Container element #${id} not found!`;
                console.error(`[PAGE] ERROR: ${errorMsg}`);
                window[constants.MW_INJECT_ERROR_FLAG] = errorMsg;
                window[constants.MW_CREATE_STATUS_FLAG] = 'error';
                return; // Stop creation
            }

            // Ensure container is visible and has basic dimensions/styling
            container.style.display = 'block';
            container.style.height = container.style.height || '600px'; // Default height if not set
            container.style.width = container.style.width || '100%';
            container.style.border = container.style.border || '1px solid #ccc'; // Visual aid

            try {
                if (typeof window[constants.MW_MONACO_VAR] === 'undefined' || typeof window[constants.MW_MONACO_VAR].editor === 'undefined') {
                    throw new Error(`window.${constants.MW_MONACO_VAR}.editor disappeared before creation!`);
                }

                // --- Create the Editor Instance ---
                // Store it on window for access by sync listener
                window[constants.MW_INSTANCE_VAR] = window[constants.MW_MONACO_VAR].editor.create(container, {
                    value: code,
                    language: lang,
                    theme: editorTheme,
                    automaticLayout: true, // Essential for resizing
                    minimap: { enabled: true },
                    wordWrap: 'on', // Example: Enable word wrap
                    scrollBeyondLastLine: false,
                    // Add other Monaco editor options here as needed
                });

                if (!window[constants.MW_INSTANCE_VAR]) {
                     throw new Error(`monaco.editor.create call did not return an instance.`);
                }

                console.log(`[PAGE] Monaco editor instance (window.${constants.MW_INSTANCE_VAR}) created successfully.`);
                window[constants.MW_CREATE_STATUS_FLAG] = 'success'; // Signal success

            } catch (error) {
                const errorMsg = `Editor creation failed: ${error.message}`;
                console.error('[PAGE] ERROR creating Monaco editor instance:', error);
                window[constants.MW_INJECT_ERROR_FLAG] = errorMsg;
                window[constants.MW_CREATE_STATUS_FLAG] = 'error'; // Signal error
            }
        }, [containerId, language, theme, initialCode, { // Pass constants
            MW_MONACO_VAR, MW_INSTANCE_VAR, MW_INJECT_ERROR_FLAG, MW_CREATE_STATUS_FLAG
        }]);
        log('info', tabId, `Editor creation call injected.`);

        // --- Step 6: Poll for Editor Creation Status ---
        log('info', tabId, `Polling for editor creation status...`);
        await pollForCondition(
            tabId,
            () => window[MW_CREATE_STATUS_FLAG] === 'success' || window[MW_CREATE_STATUS_FLAG] === 'error',
            `editor creation status (window.${MW_CREATE_STATUS_FLAG})`
        );

        // Explicitly check the final status after polling
        const creationStatusResult = await executeInMainWorld(tabId, () => window[MW_CREATE_STATUS_FLAG]);
        if (creationStatusResult !== 'success') {
            const creationError = await executeInMainWorld(tabId, () => window[MW_INJECT_ERROR_FLAG]);
            throw new Error(`Editor creation failed or did not report success. Status: ${creationStatusResult}, Error: ${creationError || 'Unknown page error'}`);
        }
        log('info', tabId, `Monaco editor instance confirmed created on page.`);

        // --- Step 7: Inject Code Sync Listener and Save Event Dispatcher ---
        log('info', tabId, `Injecting code sync listener and save mechanism...`);
        await executeInMainWorld(tabId, (constants) => {
            console.log('[PAGE] Setting up code sync listener & save request logic...');
            window[constants.MW_SYNC_ERROR_FLAG] = null; // Reset sync error flag
            window[constants.MW_SYNC_SETUP_FLAG] = 'pending';

            const editorInstance = window[constants.MW_INSTANCE_VAR];
            if (!editorInstance) {
                const errorMsg = `Injected instance (window.${constants.MW_INSTANCE_VAR}) is not defined! Cannot attach listener.`;
                console.error(`[PAGE] Sync Setup ERROR: ${errorMsg}`);
                window[constants.MW_SYNC_ERROR_FLAG] = errorMsg;
                window[constants.MW_SYNC_SETUP_FLAG] = 'failed';
                return; // Stop setup
            }

            let debounceTimeout;
            const DEBOUNCE_DELAY = 350; // ms delay for debouncing changes

            console.log(`[PAGE] Attaching onDidChangeModelContent listener to window.${constants.MW_INSTANCE_VAR}.`);
            editorInstance.onDidChangeModelContent(() => {
                clearTimeout(debounceTimeout);
                debounceTimeout = setTimeout(() => {
                    console.log('[PAGE] Debounced change detected. Attempting sync & save request dispatch...');
                    window[constants.MW_SYNC_STATUS_FLAG] = 'syncing';

                    const currentCode = editorInstance.getValue();

                    // --- Sync to original LeetCode editor (heuristic finding) ---
                    // This is crucial for LC's Run/Submit buttons to get the latest code.
                    // It relies on finding LC's internal Monaco instance via `lcMonaco`. This is FRAGILE.
                    let syncSuccessful = false;
                    let syncMethodUsed = 'none';
                    try {
                        // Try to find the original editor instance(s)
                        const lcMonacoNamespace = window[constants.MW_LC_NAMESPACE_VAR];
                        if (!lcMonacoNamespace || typeof lcMonacoNamespace.editor?.getEditors !== 'function') {
                             // Only log the error once to avoid flooding console
                            if (window[constants.MW_SYNC_ERROR_FLAG] !== 'lcMonaco.editor.getEditors not found') {
                                console.warn(`[PAGE] Sync Warning: window.${constants.MW_LC_NAMESPACE_VAR}.editor.getEditors is not available. Cannot sync code to original editor.`);
                                window[constants.MW_SYNC_ERROR_FLAG] = 'lcMonaco.editor.getEditors not found'; // Set error for polling checks
                            }
                             // NOTE: We might still proceed to dispatch the save event,
                             // but Run/Submit might use stale code. Decide if this is acceptable.
                             // For now, let's log the error but continue to dispatch save.

                        } else {
                            const leetCodeEditors = lcMonacoNamespace.editor.getEditors();
                            if (!Array.isArray(leetCodeEditors) || leetCodeEditors.length === 0) {
                                if (window[constants.MW_SYNC_ERROR_FLAG] !== 'No editors from getEditors()') {
                                    console.warn('[PAGE] Sync Warning: getEditors() returned no editors.');
                                    window[constants.MW_SYNC_ERROR_FLAG] = 'No editors from getEditors()';
                                }
                            } else {
                                const targetEditorInstance = leetCodeEditors[0]; // Assume the first one is the main code editor
                                if (!targetEditorInstance) {
                                    if (window[constants.MW_SYNC_ERROR_FLAG] !== 'Target editor instance invalid') {
                                        console.warn('[PAGE] Sync Warning: Target editor instance (editors[0]) is invalid.');
                                        window[constants.MW_SYNC_ERROR_FLAG] = 'Target editor instance invalid';
                                    }
                                } else {
                                    // Attempt to set value using common Monaco API methods
                                    if (typeof targetEditorInstance.getModel === 'function') {
                                        const targetModel = targetEditorInstance.getModel();
                                        if (targetModel && typeof targetModel.setValue === 'function') {
                                            console.log('[PAGE] Attempting sync via targetEditor.getModel().setValue()');
                                            targetModel.setValue(currentCode);
                                            syncMethodUsed = 'model.setValue';
                                            syncSuccessful = true;
                                        }
                                    }
                                    if (!syncSuccessful && typeof targetEditorInstance.setValue === 'function') {
                                        console.log('[PAGE] Attempting sync via targetEditor.setValue()');
                                        targetEditorInstance.setValue(currentCode);
                                        syncMethodUsed = 'instance.setValue';
                                        syncSuccessful = true;
                                    }

                                    if (syncSuccessful) {
                                        console.log(`[PAGE] Sync to original editor successful using method: ${syncMethodUsed}.`);
                                        window[constants.MW_SYNC_ERROR_FLAG] = null; // Clear previous sync errors if successful now
                                    } else {
                                         if (window[constants.MW_SYNC_ERROR_FLAG] !== 'Target editor sync methods failed') {
                                              console.error('[PAGE] Sync Error: Could not sync code to target editor using known methods.');
                                              window[constants.MW_SYNC_ERROR_FLAG] = 'Target editor sync methods failed';
                                         }
                                    }
                                }
                            }
                        }
                    } catch (syncError) {
                         console.error('[PAGE] Runtime Error during sync attempt:', syncError);
                         window[constants.MW_SYNC_ERROR_FLAG] = `Runtime error during sync: ${syncError.message}`;
                         syncSuccessful = false;
                    }

                    // --- Dispatch Custom Event for Saving ---
                    // This happens regardless of whether sync to original editor worked,
                    // ensuring the user's latest code is always saved by the extension.
                    try {
                        console.log(`[PAGE] Dispatching save request event ('${constants.MW_SAVE_EVENT_NAME}') with code (length: ${currentCode.length}).`);
                        const saveEvent = new CustomEvent(constants.MW_SAVE_EVENT_NAME, {
                            detail: { code: currentCode } // Pass the current code
                        });
                        window.dispatchEvent(saveEvent);
                        // Update status based on whether sync also worked
                        window[constants.MW_SYNC_STATUS_FLAG] = syncSuccessful ? 'synced_and_save_requested' : 'save_requested_sync_failed';
                    } catch (dispatchError) {
                         console.error('[PAGE] Runtime Error during save event dispatch:', dispatchError);
                         window[constants.MW_SYNC_ERROR_FLAG] = `Runtime error dispatching save event: ${dispatchError.message}`;
                         window[constants.MW_SYNC_STATUS_FLAG] = 'error';
                    }


                }, DEBOUNCE_DELAY); // End of setTimeout callback
            }); // End of onDidChangeModelContent listener

            console.log('[PAGE] Code sync listener (including save request) attached successfully.');
            window[constants.MW_SYNC_SETUP_FLAG] = 'success'; // Mark setup as successful

        }, [{ // Pass constants
             MW_INSTANCE_VAR, MW_LC_NAMESPACE_VAR, MW_SYNC_ERROR_FLAG, MW_SYNC_SETUP_FLAG,
             MW_SYNC_STATUS_FLAG, MW_SAVE_EVENT_NAME
        }]);
        log('info', tabId, `Code sync listener and save mechanism injected.`);

        // --- Step 8: Send Final Success Response to Content Script ---
        log('info', tabId, `Monaco injection and setup process completed successfully. Sending success response.`);
        sendResponse({ success: true });

    } catch (error) { // Catch block for the entire handleInjectRequest async function
        log('error', tabId, `Monaco injection/setup process FAILED:`, error);
        delete tabSlugs[tabId]; // Clean up slug association on failure

        // Attempt to signal the error on the page for easier debugging
        const errorMessage = error?.message || 'Unknown background script error during injection/sync';
        try {
            await executeInMainWorld(tabId, (msg, constants) => {
                window[constants.MW_INJECT_ERROR_FLAG] = `Background script error: ${msg}`;
                window[constants.MW_CREATE_STATUS_FLAG] = 'error';
                window[constants.MW_SYNC_SETUP_FLAG] = 'failed';
                console.error(`[PAGE] Setting error flags due to background failure: ${msg}`);
            }, [errorMessage, { MW_INJECT_ERROR_FLAG, MW_CREATE_STATUS_FLAG, MW_SYNC_SETUP_FLAG }]);
        } catch (cleanupError) {
            log('error', tabId, `Failed to set error state on page during cleanup:`, cleanupError);
        }

        // Send failure response back to the content script
        sendResponse({ success: false, error: errorMessage });
    }
}

/**
 * Handles the 'saveCodeForTab' request from the content script.
 */
function handleSaveRequest(tabId, codeToSave, sendResponse) {
    const slug = tabSlugs[tabId];

    if (slug && codeToSave !== undefined && codeToSave !== null) {
        const key = STORAGE_KEY_PREFIX + slug;
        log('info', tabId, `Received request to save code for slug '${slug}' (key: '${key}', length: ${codeToSave.length})`);

        chrome.storage.local.set({ [key]: codeToSave }, () => {
            if (chrome.runtime.lastError) {
                log('error', tabId, `Error saving code to storage for key ${key}:`, chrome.runtime.lastError);
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
                log('info', tabId, `Successfully saved code for key ${key}.`);
                sendResponse({ success: true });
            }
        });
        // We've handled the async nature by returning true earlier

    } else {
        const reason = !slug ? 'slug missing' : 'code missing';
        log('warn', tabId, `Could not save code. Reason: ${reason}. Slug: '${slug}', Code provided: ${codeToSave !== undefined && codeToSave !== null}`);
        sendResponse({ success: false, error: `Cannot save code: ${reason}.` });
        // Return false as sendResponse was called synchronously here
        return false;
    }
}


// --- Tab Lifecycle Management ---

// Clean up slug association when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabSlugs[tabId]) {
        log('info', tabId, `Tab closed. Cleaning up slug association: '${tabSlugs[tabId]}'`);
        delete tabSlugs[tabId];
    }
});

// Clean up slug association if a tab navigates away from its associated problem page
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Check only when page load is complete and we have a URL and a known slug for the tab
    if (tabSlugs[tabId] && changeInfo.status === 'complete' && tab.url) {
        const associatedSlug = tabSlugs[tabId];
        // Basic check: If the URL no longer contains the `/problems/slug/` pattern
        if (!tab.url.includes(`/problems/${associatedSlug}`)) {
            log('info', tabId, `Tab navigated away from problem page '${associatedSlug}'. Cleaning up slug association. New URL: ${tab.url}`);
            delete tabSlugs[tabId];
        }
    }
});

// --- Service Worker Initialization ---
log('info', null, 'Background service worker started and listeners attached.');
// Optional: Any other initialization needed when the worker starts.