// background.js (Bundler Version)
console.log('[Background] Service Worker started (Bundled Monaco Mode).');

// --- State ---
const tabSlugs = {};

// --- Constants ---
const POLLING_INTERVAL_MS = 300;
const MAX_POLLING_ATTEMPTS = 40; // ~12 seconds
const SCRIPT_INJECTION_WORLD = 'MAIN';

// --- Helper Functions (executeInMainWorld, pollForCondition) ---

/**
 * Executes a function in the MAIN world context of a given tab.
 * Handles potential errors like tab closure or access issues.
 */
async function executeInMainWorld(tabId, func, args = []) {
    try {
        // Check tab existence before attempting execution
        await chrome.tabs.get(tabId);
    } catch (error) {
        // Handle specific errors indicating the tab is gone or inaccessible
        if (error.message.includes("No tab with id") || error.message.includes("Cannot access") || error.message.includes("Invalid tab ID") || error.message.includes("The tab was closed")) {
            console.warn(`[Background] executeInMainWorld cannot proceed for Tab ${tabId}: Tab closed or inaccessible before execution.`);
            // Throw a specific error type or message to be caught by the caller
            throw new Error(`Tab ${tabId} closed or inaccessible during script execution attempt.`);
        }
        // Re-throw other unexpected errors from chrome.tabs.get
        console.error(`[Background] Unexpected error checking tab ${tabId} status:`, error);
        throw error;
    }

    // Proceed with script execution if tab check passed
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId, allFrames: false }, // Target only the top frame
            world: SCRIPT_INJECTION_WORLD,
            func: func,
            args: args,
            // injectImmediately: true // Optional: Might help in some race conditions, test if needed
        });

        // Check results format and return the actual result
        if (results && results.length > 0 && results[0]) {
            // Check for errors reported by the execution framework itself
            if (results[0].error) {
                console.error(`[Background] Scripting execution error in Tab ${tabId}:`, results[0].error);
                throw new Error(`Script execution failed in MAIN world: ${results[0].error.message || 'Unknown execution error'}`);
            }
            // Return the result from the executed function
            return results[0].result;
        }
        // Handle cases where execution might not return a result structure as expected
        console.warn(`[Background] executeInMainWorld for Tab ${tabId}: No result returned from chrome.scripting.executeScript.`);
        return undefined;

    } catch (error) {
        // Catch errors specifically from chrome.scripting.executeScript
        // Check if the error is due to the tab becoming invalid *during* the call
        if (error.message.includes("No tab with id") || error.message.includes("Cannot access") || error.message.includes("Invalid tab ID") || error.message.includes("Could not establish connection") || error.message.includes("The tab was closed")) {
            console.warn(`[Background] executeInMainWorld failed for Tab ${tabId}: Tab became closed or inaccessible during execution.`);
            throw new Error(`Tab ${tabId} closed or inaccessible during script execution.`);
        }
        // Log and re-throw other execution errors
        console.error(`[Background] Error executing script in MAIN world (Tab ${tabId}):`, error);
        throw error; // Re-throw the error to be handled by the calling function (e.g., pollForCondition)
    }
}


/**
 * Polls a condition in the MAIN world of a tab until it's met or timeout/error occurs.
 */
async function pollForCondition(tabId, checkFunc, description) {
    let attempts = 0;
    console.log(`[Background] (Tab ${tabId}) Starting polling for: ${description}`);

    while (attempts < MAX_POLLING_ATTEMPTS) {
        try {
            // Check tab validity at the start of each attempt *before* executing script
            await chrome.tabs.get(tabId);

            // Execute the check function in the MAIN world
            const result = await executeInMainWorld(tabId, checkFunc);

            // Condition met?
            if (result) {
                console.log(`[Background] (Tab ${tabId}) Polling SUCCESS for: ${description}. Result:`, result);
                return result; // Success!
            }

            // Check for specific error flags set by the page script (optional but useful)
            const pageErrorStatus = await executeInMainWorld(tabId, () => {
                return window.monacoInjectError || window.monacoSyncError ||
                       (window.monacoCreateStatus === 'error' ? window.monacoInjectError || 'Create error' : null) ||
                       (window.monacoSyncSetup === 'failed' ? window.monacoSyncError || 'Sync setup failed' : null);
                // Add any other relevant error flags your page script might set
            });

            if (pageErrorStatus) {
                console.error(`[Background] (Tab ${tabId}) Page signaled error while polling for '${description}':`, pageErrorStatus);
                throw new Error(`Page signaled error: ${pageErrorStatus}`); // Fail polling on page error
            }

            // Condition not met, no error yet, continue polling...

        } catch (error) {
            // Handle errors from executeInMainWorld or chrome.tabs.get
            if (error.message.includes(`Tab ${tabId} closed or inaccessible`)) {
                console.warn(`[Background] (Tab ${tabId}) Aborting poll for '${description}' because tab is closed/inaccessible.`);
                throw error; // Re-throw the specific error to be caught by the main logic
            }
            // Log other polling errors but allow retries unless it's fatal
            console.warn(`[Background] (Tab ${tabId}) Error during polling attempt ${attempts + 1} for '${description}':`, error.message);
            // Decide if the error is fatal for polling (e.g., script execution errors might be)
            if (error.message.includes("Script execution failed")) {
                 throw error; // Propagate fatal script errors immediately
            }
            // Otherwise, assume it might be transient and continue polling after delay
        }

        // Wait before the next attempt
        attempts++;
        await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
    }

    // Polling timed out
    console.error(`[Background] (Tab ${tabId}) Polling TIMEOUT after ${attempts} attempts for: ${description}`);
    throw new Error(`Timeout waiting for ${description} in tab ${tabId}`);
}


// --- Core Logic: Monaco Injection (Bundler Version) ---
async function injectAndSetupMonaco(tabId, options, sendResponse) {
    // Destructure options - note 'language' will be 'javascript' due to content script override for this test run
    const { containerId, language, theme, initialCode, problemSlug } = options;
    const saveEventName = options.saveEventName || '__monaco_save_code__';

    // Associate slug with tab ID for saving
     if (problemSlug) {
         tabSlugs[tabId] = problemSlug;
         console.log(`[Background] (Tab ${tabId}) Associated slug '${problemSlug}'`);
     } else {
         console.warn(`[Background] (Tab ${tabId}) No problemSlug provided. Saving will not work for this tab.`);
     }

    console.log(`[Background] (Tab ${tabId}) Starting Monaco injection process (Bundled) for slug '${problemSlug || 'N/A'}'. Language (requested): ${language}`, { containerId, theme });

    try {
        // --- Step 1: Poll for Monaco Editor API Readiness in Page ---
        console.log(`[Background] (Tab ${tabId}) Step 1: Polling for window.monaco.editor.create readiness...`);
        await pollForCondition(
            tabId,
            () => typeof window.monaco !== 'undefined' &&
                  typeof window.monaco.editor !== 'undefined' &&
                  typeof window.monaco.editor.create === 'function',
            'window.monaco.editor.create function availability'
        );
        console.log(`[Background] (Tab ${tabId}) Step 1: window.monaco.editor.create confirmed.`);
            // --- Step 2: Inject Editor Creation Code ---
            console.log(`[Background] (Tab ${tabId}) Step 2: Injecting editor creation call (Language: ${language})...`);
            // Ensure the 'initialCode' variable here in the background scope has the correct code string before passing it.
            console.log(`[Background] (Tab ${tabId}) Passing initialCode (length: ${initialCode?.length ?? 'N/A'}) to page.`);
    
            await executeInMainWorld(tabId, (passedContainerId, passedLanguage, passedTheme, passedInitialCode) => {
                // --- START: Code Executed Inside LeetCode Page (MAIN World) ---
    
                // 1. Confirm arguments received from background script
                console.log(`[PAGE BUNDLED] ENTERING page script. InitialCode type: ${typeof passedInitialCode}, Length: ${passedInitialCode?.length ?? 'N/A'}`);
                console.log(`[PAGE BUNDLED] Executing editor creation script. Container ID: ${passedContainerId}, Language: ${passedLanguage}`);
    
                // 2. Check Monaco Environment and Worker URLs
                console.log('[PAGE BUNDLED] Checking window.MonacoEnvironment right before monaco.editor.create call:', window.MonacoEnvironment);
                if (typeof window.MonacoEnvironment?.getWorkerUrl === 'function') {
                     console.log('[PAGE BUNDLED] SUCCESS: window.MonacoEnvironment.getWorkerUrl IS defined.');
                     // Log the paths Monaco should be using
                      try {
                          const editorWorkerLabel = 'editorWorker';
                          const editorWorkerPath = window.MonacoEnvironment.getWorkerUrl('', editorWorkerLabel);
                          console.log(`[PAGE BUNDLED] Result from getWorkerUrl('', '${editorWorkerLabel}') ===> ${editorWorkerPath}`);
    
                          // Log specific language worker path if different from editorWorker
                          if(passedLanguage !== editorWorkerLabel) {
                               const languageWorkerPath = window.MonacoEnvironment.getWorkerUrl('', passedLanguage);
                               console.log(`[PAGE BUNDLED] Result from getWorkerUrl('', '${passedLanguage}') ===> ${languageWorkerPath}`);
                          }
                      } catch(e) {
                          console.error("[PAGE BUNDLED] Error calling getWorkerUrl:", e);
                      }
    
                     // --- Manual worker test block is intentionally REMOVED ---
                     // We are now letting Monaco handle its own worker lifecycle and looking for Monaco's errors.
    
                } else {
                    console.error('[PAGE BUNDLED] CRITICAL FAILURE: window.MonacoEnvironment.getWorkerUrl is NOT defined or is not a function!');
                    window.monacoInjectError = 'MonacoEnvironment.getWorkerUrl is not configured correctly.';
                    window.monacoCreateStatus = 'error';
                    return; // Exit if environment setup failed
                }
    
                // 3. Prepare for Editor Creation
                window.monacoInjectError = null;
                window.monacoCreateStatus = 'pending';
    
                const container = document.getElementById(passedContainerId);
                if (!container) {
                    console.error(`[PAGE BUNDLED] FATAL ERROR: Container element #${passedContainerId} not found!`);
                    window.monacoInjectError = `Container element #${passedContainerId} not found`;
                    window.monacoCreateStatus = 'error';
                    return;
                }
    
                // Ensure container is visible and has dimensions
                container.style.display = 'block';
                container.style.height = container.style.height || '600px';
                container.style.width = container.style.width || '100%';
                console.log(`[PAGE BUNDLED] Container #${passedContainerId} found and styles applied. Dimensions: ${container.offsetWidth}x${container.offsetHeight}`);
    
    
                // 4. Attempt Editor Creation
                try {
                    // Paranoid check: Ensure Monaco API is still there
                    if (typeof window.monaco?.editor?.create !== 'function') {
                        throw new Error('window.monaco.editor.create disappeared unexpectedly!');
                    }
    
                     // Define editor options, ensuring initialCode is used
                     const editorOptions = {
                        value: passedInitialCode, // Use the code passed from background
                        language: passedLanguage,
                        theme: passedTheme,
                        automaticLayout: true,
                        minimap: { enabled: true },
                        wordWrap: 'on',
                        scrollBeyondLastLine: false,
                        fontSize: 14,
                        quickSuggestions: { other: true, comments: true, strings: true },
                        suggestOnTriggerCharacters: true,
                     };
    
                     // Log options right before creation, confirming code length again
                     console.log('[PAGE BUNDLED] Calling monaco.editor.create with options:', {
                         ...editorOptions,
                         value: `(Code length CONFIRMED INSIDE PAGE SCRIPT: ${passedInitialCode?.length ?? 0})`
                     });
    
                    // Create the Editor
                    window.leetCodeMonacoInstance = window.monaco.editor.create(container, editorOptions);
    
                    if (!window.leetCodeMonacoInstance) {
                         throw new Error("monaco.editor.create call completed but returned no instance.");
                    }
    
                    console.log('[PAGE BUNDLED] SUCCESS: Monaco editor instance seems to be created.');
    
                    // 5. Post-Creation Checks and Error Listeners
                    const model = window.leetCodeMonacoInstance.getModel();
                    if (model) {
                         const actualLanguageId = model.getLanguageId();
                         console.log(`[PAGE BUNDLED] Editor model language ID successfully set to: '${actualLanguageId}'. Expected: '${passedLanguage}'`);
                         if (actualLanguageId !== passedLanguage) {
                             console.warn(`[PAGE BUNDLED] Language ID mismatch! Model has '${actualLanguageId}', but '${passedLanguage}' was requested.`);
                         }
    
                         // --- ADD ERROR LISTENERS TO CATCH INTERNAL MONACO ISSUES ---
                         console.log('[PAGE BUNDLED] Adding error listeners for Monaco...');
    
                         // Basic global handler (might not catch worker specifics)
                         window.MonacoErrorListener = (error) => {
                             console.error('[PAGE BUNDLED] --- MONACO ONERROR DETECTED (via window.MonacoErrorListener) ---:', error);
                         };
    
                         // Attempt to use official/semi-official way if available
                          if (window.monaco?.Environment?.onWorkerError) {
                               window.monaco.Environment.onWorkerError((label, error) => { // Might have label argument
                                  console.error(`[PAGE BUNDLED] --- MONACO ENV WORKER ERROR (Label: ${label}) ---:`, error);
                               });
                                console.log('[PAGE BUNDLED] Attached listener to monaco.Environment.onWorkerError.');
                           } else {
                               console.warn('[PAGE BUNDLED] window.monaco.Environment.onWorkerError not available.');
                           }
    
                           // Listen for unhandled promise rejections globally (might catch async worker issues)
                           window.addEventListener('unhandledrejection', function(event) {
                                console.error('[PAGE BUNDLED] --- UNHANDLED REJECTION DETECTED ---:', event.reason);
                           });
                           console.log('[PAGE BUNDLED] Attached listener for global unhandledrejection.');
                           // --- END ERROR LISTENERS ---
    
                    } else {
                         console.warn('[PAGE BUNDLED] Editor instance created, but could not get model immediately to verify language or add listeners.');
                    }
    
                    // Mark creation as successful *after* all checks and listener setups
                    window.monacoCreateStatus = 'success';
    
                } catch (error) {
                     console.error('[PAGE BUNDLED] ERROR creating Monaco editor instance:', error);
                     window.monacoInjectError = `Editor creation failed: ${error.message || String(error)}`;
                     window.monacoCreateStatus = 'error'; // Mark failure
                }
    
                 // --- END: Code Executed Inside LeetCode Page ---
            }, [containerId, language, theme, initialCode]); // Pass arguments from background scope to the page function
    
            console.log(`[Background] (Tab ${tabId}) Step 2: Editor creation code injection command sent.`);
        // ... rest of injectAndSetupMonaco ...
        console.log(`[Background] (Tab ${tabId}) Step 2: Editor creation code injection command sent.`);


        // --- Step 3: Poll for Editor Creation Status ---
        console.log(`[Background] (Tab ${tabId}) Step 3: Polling for editor creation status (window.monacoCreateStatus)...`);
        await pollForCondition(
            tabId,
            () => window.monacoCreateStatus === 'success' || window.monacoCreateStatus === 'error',
            'editor creation status (window.monacoCreateStatus)'
        );

        // Check the final status after polling confirms completion
        const finalCreationStatus = await executeInMainWorld(tabId, () => window.monacoCreateStatus);
        if (finalCreationStatus !== 'success') {
             const creationError = await executeInMainWorld(tabId, () => window.monacoInjectError);
             console.error(`[Background] (Tab ${tabId}) Editor creation failed in page. Status: ${finalCreationStatus}, Error: ${creationError || 'Unknown page error'}`);
             throw new Error(`Editor creation failed. Status: ${finalCreationStatus}, Error: ${creationError || 'Unknown page error'}`);
        }
        console.log(`[Background] (Tab ${tabId}) Step 3: Monaco editor instance confirmed created successfully.`);


        // --- Step 4: Inject Code Sync Listener ---
        console.log(`[Background] (Tab ${tabId}) Step 4: Injecting code sync listener & save trigger...`);
        await executeInMainWorld(tabId, (eventToDispatch) => {
            console.log('[PAGE BUNDLED] Setting up code sync listener & save event trigger...');
            window.monacoSyncError = null;
            window.monacoSyncSetup = 'pending';

            if (!window.leetCodeMonacoInstance) {
                 console.error('[PAGE BUNDLED] Sync Setup FATAL: window.leetCodeMonacoInstance is not defined!');
                 window.monacoSyncError = 'leetCodeMonacoInstance not found during sync setup.';
                 window.monacoSyncSetup = 'failed';
                 return;
             }

             let debounceTimeout;
             const DEBOUNCE_DELAY_MS = 350;

             window.leetCodeMonacoInstance.onDidChangeModelContent(() => {
                 clearTimeout(debounceTimeout);
                 window.monacoSyncStatus = 'debouncing';

                 debounceTimeout = setTimeout(() => {
                    console.log('[PAGE BUNDLED] Debounced change detected. Triggering save event dispatch...');
                    window.monacoSyncStatus = 'triggering_save';

                    try {
                        const currentCode = window.leetCodeMonacoInstance.getValue();
                        console.log(`[PAGE BUNDLED] Dispatching custom event '${eventToDispatch}'...`);
                        const saveEvent = new CustomEvent(eventToDispatch, { detail: { code: currentCode } });
                        window.dispatchEvent(saveEvent);
                        window.monacoSyncStatus = 'save_requested';
                    } catch (dispatchError) {
                        console.error('[PAGE BUNDLED] Runtime Error during save event dispatch:', dispatchError);
                        window.monacoSyncError = `Runtime error dispatching save event: ${dispatchError.message}`;
                        window.monacoSyncStatus = 'error';
                    }
                 }, DEBOUNCE_DELAY_MS);
             });

             console.log('[PAGE BUNDLED] Code sync listener attached successfully.');
             window.monacoSyncSetup = 'success';

        }, [saveEventName]); // Pass the event name to the page function
        console.log(`[Background] (Tab ${tabId}) Step 4: Sync listener injected.`);


        // --- Step 5: Final Success Response ---
        console.log(`[Background] (Tab ${tabId}) Monaco (Bundled) injection and setup process completed successfully.`);
        sendResponse({ success: true });

    } catch (error) { // Catch block for the entire injectAndSetupMonaco process
        console.error(`[Background] (Tab ${tabId}) FATAL ERROR during Monaco (Bundled) injection/setup process:`, error);
        delete tabSlugs[tabId]; // Clean up slug association
         const errorMessage = error instanceof Error ? error.message : String(error);

         // Best effort attempt to signal the error back to the page
         try {
             await chrome.tabs.get(tabId); // Check if tab still exists
             await executeInMainWorld(tabId, (msg) => {
                 window.monacoInjectError = `Background failure: ${msg}`;
                 if (window.monacoCreateStatus !== 'success') window.monacoCreateStatus = 'error';
                 if (window.monacoSyncSetup !== 'success') window.monacoSyncSetup = 'failed';
                 console.error(`[PAGE BUNDLED] Setting error flags due to background failure: ${msg}`);
             }, [errorMessage]);
         } catch (cleanupError) {
              console.warn(`[Background] (Tab ${tabId}) Failed to set error state on page during cleanup:`, cleanupError.message);
         }
        // Send failure response back to the content script
        sendResponse({ success: false, error: errorMessage });
    }
}

// --- Message Listener ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
     if (!sender.tab?.id) {
         return false; // Ignore messages not from tabs
     }
     const tabId = sender.tab.id;

     switch (message.action) {
         case 'injectAndCreateMonaco':
             if (message.options) {
                 console.log(`[Background] Received 'injectAndCreateMonaco' from Tab ${tabId}`);
                 injectAndSetupMonaco(tabId, message.options, sendResponse)
                     .catch(err => {
                         console.error(`[Background] Uncaught error from injectAndSetupMonaco for Tab ${tabId}:`, err);
                         try { sendResponse({ success: false, error: `Unhandled background error: ${err.message}` }); }
                         catch (responseError) { console.warn(`[Background] Failed to send final error response for Tab ${tabId}:`, responseError.message); }
                     });
                 return true; // Async response will be sent
             } else {
                 console.error(`[Background] Received 'injectAndCreateMonaco' without options from Tab ${tabId}`);
                 sendResponse({ success: false, error: "Missing 'options' in message." });
                 return false;
             }

         case 'saveCodeForTab':
             const slug = tabSlugs[tabId];
             const codeToSave = message.code;
             if (!slug) {
                  console.error(`[Background] (Tab ${tabId}) Cannot save code: No slug associated.`);
                  sendResponse({ success: false, error: `Cannot save: Slug for Tab ${tabId} not found.` });
                  return false;
             }
             if (codeToSave === undefined || codeToSave === null) {
                  console.error(`[Background] (Tab ${tabId}) Cannot save code for slug '${slug}': Code is missing.`);
                  sendResponse({ success: false, error: `Cannot save: Code is missing.` });
                  return false;
             }
             const storageKey = `leetcodeCode-${slug}`;
             console.log(`[Background] (Tab ${tabId}) Saving code for slug '${slug}' (length: ${codeToSave.length}). Key: ${storageKey}`);
             chrome.storage.local.set({ [storageKey]: codeToSave }, () => {
                 if (chrome.runtime.lastError) {
                     console.error(`[Background] (Tab ${tabId}) Error saving code to storage for slug '${slug}':`, chrome.runtime.lastError);
                     sendResponse({ success: false, error: chrome.runtime.lastError.message });
                 } else {
                     sendResponse({ success: true });
                 }
             });
             return true; // Async response will be sent

         default:
             return false; // Action not recognized
     }
});

// --- Tab Lifecycle Management ---
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (tabSlugs[tabId]) {
        console.log(`[Background] Tab ${tabId} removed. Cleaning up associated slug '${tabSlugs[tabId]}'.`);
        delete tabSlugs[tabId];
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tabSlugs[tabId] && changeInfo.status === 'complete' && tab.url) {
         const associatedSlug = tabSlugs[tabId];
         const problemUrlPattern = new RegExp(`^https?://(?:www\\.)?leetcode\\.com/problems/${associatedSlug}(?:/.*)?$`, 'i');
         if (!problemUrlPattern.test(tab.url)) {
             console.log(`[Background] Tab ${tabId} navigated away from problem '${associatedSlug}' (New URL: ${tab.url}). Cleaning up slug association.`);
             delete tabSlugs[tabId];
         }
     }
});

// --- Extension Lifecycle ---
chrome.runtime.onInstalled.addListener(details => {
    console.log(`[Background] Extension ${details.reason}. Version: ${chrome.runtime.getManifest().version}`);
});
chrome.runtime.onStartup.addListener(() => {
    console.log("[Background] Extension started up.");
});