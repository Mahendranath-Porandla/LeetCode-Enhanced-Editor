// content_scripts/leetcode_injector.js
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
                } else if (response && response.success) {
                    // console.log("[Content Script] Background confirmed code save."); // Optional: uncomment for verbose logging
                } else if (response && !response.success) {
                    console.error("[Content Script] Background reported save FAILURE:", response.error);
                } else {
                    console.warn("[Content Script] No response or unexpected response from background save action.");
                }
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
        // Apply necessary styles via CSS or directly if needed
        // container.style.height = '600px'; // Example: set height if not done in CSS
        parentToAppendTo.appendChild(container);
        console.log(`[Content Script] Appended Monaco container to parent:`, parentToAppendTo);
    }

    container.style.display = 'block'; // Ensure visibility (redundant with CSS is okay)
    return EDITOR_CONTAINER_ID;
}

/**
 * Attempts to detect the currently selected language from the LeetCode UI.
 * WARNING: Relies on specific LeetCode UI selectors, which are fragile and may break.
 * @returns {string} The Monaco language ID (e.g., 'python', 'java', 'cpp') or 'plaintext' as a fallback.
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
                "dart": "dart",
                "golang": "go", "go": "go",
                "ruby": "ruby",
                "scala": "scala",
                "rust": "rust",
                "racket": "racket", // Check Monaco support
                "erlang": "erlang", // Check Monaco support
                "elixir": "elixir", // Check Monaco support
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
    if (keyToFind in obj) {
        return obj[keyToFind];
    }
    for (const key in obj) {
        // Avoid searching inherited properties
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
 * Extracts the default code snippet for the currently selected language
 * by searching for 'codeSnippets' data in known locations (global vars, JSON scripts).
 * @returns {string} The default code snippet, or a fallback message if not found.
 */
function getDefaultCodeFromPageData() {
    console.log("[Content Script] Attempting to retrieve default code from page data ('codeSnippets')...");
    const fallbackCode = `// Monaco Editor Injected!\n// Failed to retrieve default code from page data.\n// Please check console logs.`;
    let codeSnippets = null;

    // Strategy 1: Look in potential global variables
    const potentialGlobalVars = ['__INITIAL_STATE__', 'pageData', 'payload']; // Add others if identified
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

    // Match the language
    const currentMonacoLanguage = getLeetCodeLanguage(); // Get Monaco ID ('cpp', 'python', etc.)
    console.log(`[Content Script] Looking for snippet with langSlug matching Monaco language: '${currentMonacoLanguage}'`);

    const languageDefinition = codeSnippets.find(snippet => {
        const slug = snippet?.langSlug?.toLowerCase();
        if (!slug) return false;
        // Direct match or known variations
        return slug === currentMonacoLanguage ||
               (currentMonacoLanguage === 'python' && slug === 'python3') ||
               (currentMonacoLanguage === 'go' && slug === 'golang');
               // Add other specific mappings here if needed
    });

    // Extract code or use fallback
    if (languageDefinition && typeof languageDefinition.code === 'string') {
        console.log(`[Content Script] SUCCESS: Found default code snippet for langSlug '${languageDefinition.langSlug}'.`);
        // JS usually handles unicode escapes implicitly when parsing JSON or assigning strings
        return languageDefinition.code;
    } else {
        console.warn(`[Content Script] WARNING: Could not find a matching code snippet for Monaco language '${currentMonacoLanguage}'. Available langSlugs:`, codeSnippets.map(s => s?.langSlug));
        // Fallback: Use the first snippet found?
        const firstSnippet = codeSnippets[0];
        if (firstSnippet && typeof firstSnippet.code === 'string') {
            console.warn(`[Content Script] Using code for the first snippet ('${firstSnippet.langSlug}') as fallback.`);
            return firstSnippet.code;
        }
        console.error(`[Content Script] ERROR: No matching language snippet found AND no fallback snippet available.`);
        return fallbackCode + `\n// Detected language: ${currentMonacoLanguage}`;
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
 * Finds/prepares the editor container, determines initial code (from storage or page data),
 * and sends a message to the background script to inject and create Monaco.
 */
function initializeEditor() {
    console.log("[Content Script] Initializing Monaco Editor injection...");

    const problemSlug = getProblemSlug();
    if (!problemSlug) {
        // Decide if injection should proceed without a slug (saving won't work)
        console.error("[Content Script] Cannot proceed with injection: Problem slug is required for saving functionality.");
        // Optionally display an error to the user here
        return;
    }
    console.log("[Content Script] Detected problem slug:", problemSlug);

    const containerId = findEditorContainerAndPrepare();
    if (!containerId) {
        console.error("[Content Script] Initialization failed: Could not prepare editor container.");
        return;
    }

    const storageKey = `leetcodeCode-${problemSlug}`;
    const language = getLeetCodeLanguage(); // Detect language *before* fetching code
    const theme = 'vs-dark'; // TODO: Make this configurable?

    // Check storage for previously saved code for this problem slug
    console.log(`[Content Script] Checking chrome.storage.local for key: '${storageKey}'`);
    chrome.storage.local.get([storageKey], (result) => {
        let initialCode = "";
        let codeSource = "";

        if (chrome.runtime.lastError) {
            console.error("[Content Script] Error reading from chrome.storage:", chrome.runtime.lastError);
            console.log("[Content Script] Falling back to default code from page data due to storage error.");
            initialCode = getDefaultCodeFromPageData();
            codeSource = "Default (Storage Error)";
        } else if (result && result[storageKey] !== undefined) {
            console.log(`[Content Script] Found saved code for slug '${problemSlug}' in storage.`);
            initialCode = result[storageKey];
            codeSource = "Storage";
        } else {
            console.log(`[Content Script] No saved code found for slug '${problemSlug}'. Using default code from page data.`);
            initialCode = getDefaultCodeFromPageData();
            codeSource = "Default (No Saved)";
        }

        console.log(`[Content Script] Requesting Monaco injection for slug '${problemSlug}'. Code source: ${codeSource}. Options:`, { containerId, language, theme, initialCodeLength: initialCode?.length ?? 0 });

        // Send message to background script to perform the actual injection
        chrome.runtime.sendMessage(
            {
                action: 'injectAndCreateMonaco',
                options: {
                    containerId: containerId,
                    language: language,
                    theme: theme,
                    initialCode: initialCode, // Use stored or default code
                    problemSlug: problemSlug  // Pass slug for background to associate with tab
                }
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    console.error('[Content Script] Error sending message to background:', chrome.runtime.lastError.message);
                } else if (response) {
                    if (response.success) {
                        console.log('[Content Script] Background script reported SUCCESSFUL Monaco injection!');
                    } else {
                        console.error('[Content Script] Background script reported Monaco injection FAILURE:', response.error);
                        // Display error in the placeholder container
                        const container = document.getElementById(containerId);
                        if (container) {
                            container.innerHTML = `<p style='color:red; padding: 10px; border: 1px dashed red;'>Failed to load Monaco Editor: ${response.error || 'Unknown error'}. Check extension console (Background & Content Script).</p>`;
                        }
                    }
                } else {
                     console.error('[Content Script] No response received from background script. It might have crashed or disconnected.');
                }
            }
        );
    }); // End of chrome.storage.local.get callback
}

// --- Initialization Trigger ---
// Wait for the LeetCode page structure (specifically the original editor) to likely exist.
const MAX_INIT_ATTEMPTS = 15; // ~15 seconds
const INIT_CHECK_INTERVAL_MS = 1000;
let initAttempts = 0;

const initCheckInterval = setInterval(() => {
    initAttempts++;
    const editorElement = document.querySelector(ORIGINAL_EDITOR_SELECTOR);

    if (editorElement) {
        console.log(`[Content Script] Found '${ORIGINAL_EDITOR_SELECTOR}'. Proceeding with initialization.`);
        clearInterval(initCheckInterval);
        initializeEditor();
    } else if (initAttempts >= MAX_INIT_ATTEMPTS) {
        clearInterval(initCheckInterval);
        console.error(`[Content Script] Timed out after ${initAttempts} attempts waiting for '${ORIGINAL_EDITOR_SELECTOR}' element to appear. Monaco injection aborted.`);
    } else {
        // Optional: Log waiting attempts
        // console.log(`[Content Script] Waiting for '${ORIGINAL_EDITOR_SELECTOR}'... Attempt ${initAttempts}/${MAX_INIT_ATTEMPTS}`);
    }
}, INIT_CHECK_INTERVAL_MS);