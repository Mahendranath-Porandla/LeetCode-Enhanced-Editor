console.log("[Content Script] LeetCode Monaco Injector: Loaded.");

// --- Constants ---
const EDITOR_CONTAINER_ID = 'monaco-editor-container';
const ORIGINAL_EDITOR_SELECTOR = '#editor'; // LeetCode's original editor container
const SAVE_EVENT_NAME = '__monaco_save_code__'; // Custom event for saving code

// --- Event Listener for Save Requests from Injected Script ---
window.addEventListener(SAVE_EVENT_NAME, (event) => {
    console.log(`[Content Script] Received '${SAVE_EVENT_NAME}' event.`);
    if (event.detail && event.detail.code !== undefined) {
        const codeToSave = event.detail.code;
        console.log(`[Content Script] Relaying 'saveCodeForTab' message to background (code length: ${codeToSave.length})`);

        chrome.runtime.sendMessage(
            { action: 'saveCodeForTab', code: codeToSave },
            (response) => {
                if (chrome.runtime.lastError) {
                    console.error("[Content Script] Error sending 'saveCodeForTab' message:", chrome.runtime.lastError.message);
                } else if (response && !response.success) {
                    console.error("[Content Script] Background reported save FAILURE:", response.error);
                }
                 // Optional: Log success response from background if needed
                 // else if (response && response.success) { console.log("[Content Script] Background confirmed code save."); }
            }
        );
    } else {
        console.warn(`[Content Script] Received '${SAVE_EVENT_NAME}' event without valid code detail.`);
    }
});

/**
 * Finds LeetCode's original editor element, hides it, and creates/finds
 * the container div for our Monaco instance.
 * @returns {string | null} The ID of the container element, or null if setup fails.
 */
function findEditorContainerAndPrepare() {
    console.log(`[Content Script] Attempting to find original editor ('${ORIGINAL_EDITOR_SELECTOR}') and prepare container...`);
    const originalEditorElement = document.querySelector(ORIGINAL_EDITOR_SELECTOR);

    if (!originalEditorElement) {
        console.error(`[Content Script] CRITICAL - Could not find original editor element ('${ORIGINAL_EDITOR_SELECTOR}')! Cannot inject Monaco.`);
        return null;
    }
    console.log("[Content Script] Found original editor element:", originalEditorElement);

    const parentToAppendTo = originalEditorElement.parentElement;
    if (!parentToAppendTo) {
         console.error("[Content Script] Found original editor, but it has no parent element. Cannot inject container.");
         return null;
    }

    // Hide the original editor element
    console.log("[Content Script] Hiding original editor element:", originalEditorElement);
    originalEditorElement.style.display = 'none';

    // Find or create our container
    let container = document.getElementById(EDITOR_CONTAINER_ID);
    if (container) {
        console.log(`[Content Script] Reusing existing Monaco container ('#${EDITOR_CONTAINER_ID}').`);
        container.style.display = 'block'; // Ensure visible
    } else {
        console.log(`[Content Script] Creating new Monaco container ('#${EDITOR_CONTAINER_ID}').`);
        container = document.createElement('div');
        container.id = EDITOR_CONTAINER_ID;
        parentToAppendTo.appendChild(container);
        console.log(`[Content Script] Appended Monaco container to parent:`, parentToAppendTo);
    }

    container.style.display = 'block'; // Ensure visibility
    return EDITOR_CONTAINER_ID;
}

/**
 * Attempts to detect the currently selected language from the LeetCode UI.
 * WARNING: Relies on specific LeetCode UI selectors, which are fragile.
 * @returns {string} The Monaco language ID or 'plaintext' as a fallback.
 */
function getLeetCodeLanguage() {
    // --- !!! FRAGILE SELECTOR - ADJUST IF LEETCODE UI CHANGES !!! ---
    const langDropdownSelector = 'button[aria-haspopup="dialog"][data-state="closed"] > button.group';
    try {
        const langDropdown = document.querySelector(langDropdownSelector);
        if (langDropdown && langDropdown.textContent) {
            const langText = langDropdown.textContent.toLowerCase().trim();
            console.log("[Content Script] Detected language text from UI:", langText);

            // Map common LeetCode UI names to Monaco language IDs
            const langMap = {
                "python": "python", "python3": "python",
                "java": "java",
                "c++": "cpp", "cpp": "cpp",
                "c": "c",
                "c#": "csharp", "csharp": "csharp",
                "javascript": "javascript",
                "typescript": "typescript",
                "php": "php",
                "swift": "swift",
                "kotlin": "kotlin",
                "dart": "dart", // Monaco might not support Dart out-of-the-box
                "golang": "go", "go": "go",
                "ruby": "ruby",
                "scala": "scala",
                "rust": "rust",
                // Add other mappings as needed
            };

            const monacoLang = langMap[langText];
            if (monacoLang) {
                console.log(`[Content Script] Mapped to Monaco language: '${monacoLang}'`);
                return monacoLang;
            } else {
                 console.warn(`[Content Script] No mapping found for UI language '${langText}'. Defaulting to 'plaintext'.`);
                 return 'plaintext';
            }
        } else {
            console.warn(`[Content Script] Could not find language dropdown element using selector: '${langDropdownSelector}' or it has no text content. Defaulting to 'plaintext'.`);
        }
    } catch (e) {
        console.error("[Content Script] Error detecting language from UI:", e);
    }
    return 'plaintext'; // Default fallback
}

/**
 * Helper function to recursively find a key within a nested object.
 * @param {object} obj - The object to search within.
 * @param {string} keyToFind - The key name to look for.
 * @returns {any | null} The value associated with the key, or null if not found.
 */
function findNestedKey(obj, keyToFind) {
    if (typeof obj !== 'object' || obj === null) {
        return null;
    }
    if (Object.prototype.hasOwnProperty.call(obj, keyToFind)) { // Use hasOwnProperty
        return obj[keyToFind];
    }
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const result = findNestedKey(obj[key], keyToFind);
            if (result !== null) {
                return result;
            }
        }
    }
    return null;
}


/**
 * Extracts the default code snippet for the currently selected language.
 * Uses findNestedKey to search common data locations.
 * @param {string} targetLanguageId - The Monaco language ID to search for (e.g., 'javascript', 'cpp').
 * @returns {string} The default code snippet, or a fallback message if not found.
 */
function getDefaultCodeFromPageData(targetLanguageId) {
    console.log(`[Content Script] Attempting to retrieve default code from page data ('codeSnippets') for language: ${targetLanguageId}...`);
    const fallbackCode = `// Monaco Editor Injected! (Language: ${targetLanguageId})\n// Failed to retrieve default code snippet for this language.\n// Please check console logs.`;
    let codeSnippets = null;

    // Strategy 1: Look in potential global variables
    const potentialGlobalVars = ['__INITIAL_STATE__', 'pageData', 'payload', 'appContext']; // Add common framework vars
    for (const varName of potentialGlobalVars) {
        if (typeof window[varName] === 'object' && window[varName] !== null) {
            let found = findNestedKey(window[varName], 'codeSnippets');
            if (found && Array.isArray(found)) {
                 console.log(`[Content Script] Found 'codeSnippets' in window.${varName}`);
                 codeSnippets = found;
                 break;
             }
        }
    }

    // Strategy 2: Look in <script type="application/json"> tags
    if (!codeSnippets) {
        console.log("[Content Script] Not found in global vars, searching <script type='application/json'>...");
        const scriptTags = document.querySelectorAll('script[type="application/json"]');
        for (const tag of scriptTags) {
            try {
                const jsonData = JSON.parse(tag.textContent || "");
                let found = findNestedKey(jsonData, 'codeSnippets');
                if (found && Array.isArray(found)) {
                    console.log("[Content Script] Found 'codeSnippets' in a <script type='application/json'> tag.");
                    codeSnippets = found;
                    break;
                }
            } catch (e) { /* Ignore scripts with invalid JSON */ }
        }
    }

    // Process the found codeSnippets
    if (!codeSnippets || !Array.isArray(codeSnippets)) {
        console.error("[Content Script] ERROR: Could not find valid 'codeSnippets' array in page data.");
        return fallbackCode;
    }

    // Match the target language
    console.log(`[Content Script] Looking for snippet with langSlug matching Monaco language: '${targetLanguageId}'`);

    const languageDefinition = codeSnippets.find(snippet => {
        const slug = snippet?.langSlug?.toLowerCase();
        if (!slug) return false;
        // Direct match or known variations (add more aliases if LeetCode uses different slugs)
        return slug === targetLanguageId ||
               (targetLanguageId === 'python' && (slug === 'python3' || slug === 'python')) ||
               (targetLanguageId === 'go' && slug === 'golang') ||
               (targetLanguageId === 'cpp' && (slug === 'c++' || slug === 'cpp')) ||
               (targetLanguageId === 'csharp' && slug === 'c#');
               // Add other specific mappings here if needed
    });

    // Extract code or use fallback
    if (languageDefinition && typeof languageDefinition.code === 'string') {
        console.log(`[Content Script] SUCCESS: Found default code snippet for langSlug '${languageDefinition.langSlug}'.`);
        // JSON parsing should handle unicode escapes, return the code directly.
        return languageDefinition.code;
    } else {
        console.warn(`[Content Script] WARNING: Could not find a matching code snippet for Monaco language '${targetLanguageId}'. Available langSlugs:`, codeSnippets.map(s => s?.langSlug));
        return fallbackCode + `\n// Available snippet languages: ${codeSnippets.map(s => s?.langSlug).join(', ')}`;
    }
}

/**
 * Extracts the problem slug from the current URL.
 * Assumes URL structure like /problems/two-sum/...
 * @returns {string | null} The problem slug (e.g., "two-sum") or null if not found.
 */
function getProblemSlug() {
    const match = window.location.pathname.match(/problems\/([^/]+)/);
    const slug = match ? match[1] : null;
    if (!slug) {
         console.warn("[Content Script] Could not determine LeetCode problem slug from URL:", window.location.pathname);
    }
    return slug;
}

/**
 * Main initialization function.
 * Finds/prepares container, determines initial code, and messages background script.
 */
function initializeEditor() {
    console.log("[Content Script] Initializing Monaco Editor injection...");

    const problemSlug = getProblemSlug();
    if (!problemSlug) {
        console.error("[Content Script] Cannot proceed: Problem slug is required for saving.");
        return;
    }
    console.log("[Content Script] Detected problem slug:", problemSlug);

    const containerId = findEditorContainerAndPrepare();
    if (!containerId) {
        console.error("[Content Script] Initialization failed: Could not prepare editor container.");
        return;
    }

    // --- !!! LANGUAGE OVERRIDE FOR TESTING !!! ---
    const language = getLeetCodeLanguage(); // Detect language *before* fetching code
    //const language = 'cpp'; // <-- FORCE JAVASCRIPT FOR TESTING BASIC SUGGESTIONS
    console.warn(`[Content Script] FORCING LANGUAGE TO '${language}' FOR TESTING PURPOSES.`);
    // ---------------------------------------------

    const theme = 'vs-dark'; // Theme preference
    const storageKey = `leetcodeCode-${problemSlug}-${language}`; // Make storage key language-specific too

    console.log(`[Content Script] Checking chrome.storage.local for key: '${storageKey}' (using language: ${language})`);
    chrome.storage.local.get([storageKey], (result) => {
        let initialCode = "";
        let codeSource = "";

        if (chrome.runtime.lastError) {
            console.error("[Content Script] Error reading from chrome.storage:", chrome.runtime.lastError);
            initialCode = getDefaultCodeFromPageData(language); // Get default code for the TARGET language
            codeSource = `Default (Storage Error, Lang: ${language})`;
        } else if (result && result[storageKey] !== undefined) {
            console.log(`[Content Script] Found saved code for slug '${problemSlug}' and lang '${language}' in storage.`);
            initialCode = result[storageKey];
            codeSource = "Storage";
        } else {
            console.log(`[Content Script] No saved code found for slug '${problemSlug}' and lang '${language}'. Using default snippet.`);
            initialCode = getDefaultCodeFromPageData(language); // Get default code for the TARGET language
            codeSource = `Default (No Saved, Lang: ${language})`;
        }

        console.log(`[Content Script] Requesting Monaco injection for slug '${problemSlug}'. Language: '${language}'. Code source: ${codeSource}. Options:`, { containerId, language, theme, initialCodeLength: initialCode?.length ?? 0 });

        // Send message to background script to perform the actual injection
        chrome.runtime.sendMessage(
            {
                action: 'injectAndCreateMonaco',
                options: {
                    containerId: containerId,
                    language: language, // Send the potentially overridden language
                    theme: theme,
                    initialCode: initialCode, // Use stored or default code
                    problemSlug: problemSlug  // Pass slug for background to associate with tab
                }
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    console.error('[Content Script] Error sending message to background:', chrome.runtime.lastError.message);
                     // Display error in the placeholder container as a fallback
                    const container = document.getElementById(containerId);
                     if (container) container.innerHTML = `<p style='color:orange; padding: 10px; border: 1px dashed orange;'>Error communicating with background script: ${chrome.runtime.lastError.message}. Check extension logs.</p>`;

                } else if (response) {
                    if (response.success) {
                        console.log('[Content Script] Background script reported SUCCESSFUL Monaco injection!');
                    } else {
                        console.error('[Content Script] Background script reported Monaco injection FAILURE:', response.error);
                        // Display error in the placeholder container
                        const container = document.getElementById(containerId);
                        if (container) {
                            container.innerHTML = `<p style='color:red; padding: 10px; border: 1px dashed red;'>Failed to load Monaco Editor: ${response.error || 'Unknown error'}. Check extension console (Background & Page).</p>`;
                        }
                    }
                } else {
                     console.error('[Content Script] No response received from background script. It might have crashed or disconnected.');
                     const container = document.getElementById(containerId);
                     if (container) container.innerHTML = `<p style='color:red; padding: 10px; border: 1px dashed red;'>No response from background script. Check extension status and logs.</p>`;
                }
            }
        );
    }); // End of chrome.storage.local.get callback
}

// --- Initialization Trigger ---
// Wait for the LeetCode page structure (specifically the original editor) to likely exist.
const MAX_INIT_ATTEMPTS = 20; // Increase attempts slightly just in case
const INIT_CHECK_INTERVAL_MS = 750; // Slightly faster check
let initAttempts = 0;
let initCheckInterval = null; // Hold interval ID

function attemptInitialization() {
    initAttempts++;
    const editorElement = document.querySelector(ORIGINAL_EDITOR_SELECTOR);
    // Also check if our container *already* exists from a previous failed/partial load attempt
    const existingContainer = document.getElementById(EDITOR_CONTAINER_ID);

    if (editorElement || existingContainer) {
        // We need the original editor to know where to inject, even if reusing container
        if (!editorElement) {
            console.warn(`[Content Script] Found existing container '${EDITOR_CONTAINER_ID}', but original editor '${ORIGINAL_EDITOR_SELECTOR}' is missing. Attempting init anyway.`);
        } else {
             console.log(`[Content Script] Found '${ORIGINAL_EDITOR_SELECTOR}' (attempt ${initAttempts}). Proceeding with initialization.`);
        }
        if (initCheckInterval) clearInterval(initCheckInterval);
        initializeEditor(); // Call the main function
    } else if (initAttempts >= MAX_INIT_ATTEMPTS) {
        if (initCheckInterval) clearInterval(initCheckInterval);
        console.error(`[Content Script] Timed out after ${initAttempts} attempts waiting for '${ORIGINAL_EDITOR_SELECTOR}' element. Monaco injection aborted.`);
    } else {
        // Still waiting...
        // console.log(`[Content Script] Waiting for '${ORIGINAL_EDITOR_SELECTOR}'... Attempt ${initAttempts}/${MAX_INIT_ATTEMPTS}`);
    }
}

// Start the interval check
initCheckInterval = setInterval(attemptInitialization, INIT_CHECK_INTERVAL_MS);
// Also run once quickly in case element is already there
// setTimeout(attemptInitialization, 100); // Or just rely on the interval