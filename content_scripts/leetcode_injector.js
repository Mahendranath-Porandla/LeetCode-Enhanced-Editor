/**
 * LeetCode Monaco Injector: Content Script
 *
 * This script runs in the context of LeetCode problem pages.
 * It performs the following actions:
 * 1. Waits for the original LeetCode editor element to appear.
 * 2. Finds and hides the original editor.
 * 3. Creates a new container element for the Monaco editor.
 * 4. Detects the current programming language selected on LeetCode.
 * 5. Retrieves the initial code:
 *    - Checks Chrome local storage for previously saved code for this problem.
 *    - If not found, extracts the default boilerplate code from LeetCode's page data.
 * 6. Sends a message to the background script requesting the injection and creation
 *    of the Monaco editor instance with the gathered information (container ID, language,
 *    initial code, theme, problem slug).
 * 7. Listens for a custom event ('__monaco_save_code__') dispatched from the
 *    injected script (running in the MAIN world) when the user saves (e.g., Ctrl+S).
 * 8. Relays the code received from the custom event to the background script
 *    to save it in Chrome local storage, associated with the problem slug.
 */
'use strict';

console.log('[LC Monaco Injector] Content script loaded.');

// --- Constants ---
const EDITOR_CONTAINER_ID = 'monaco-editor-container';
const ORIGINAL_EDITOR_SELECTOR = '#editor'; // Selector for the original LC editor container
const HIDE_ORIGINAL_STYLE = 'display: none;'; // How to hide the original editor
const LANGUAGE_SELECTOR = 'button[data-state="closed"] > button.group'; // Selector for the language button (!! FRAGILE !!)
const STORAGE_KEY_PREFIX = 'leetcodeCode-';
const THEME = 'vs-dark'; // Monaco theme ('vs-dark' or 'vs-light')
const INIT_CHECK_INTERVAL_MS = 1000; // Check every second for the editor
const MAX_INIT_ATTEMPTS = 15; // Max attempts to find the editor

// --- Event Listener for Saving Code ---

/**
 * Listens for a custom event dispatched from the injected script (MAIN world)
 * indicating that the user wants to save the code in the Monaco editor.
 * It then relays this request to the background script.
 */
window.addEventListener('__monaco_save_code__', (event) => {
    console.log("[LC Monaco Injector] Received '__monaco_save_code__' event from MAIN world.");
    if (event.detail && event.detail.code !== undefined) {
        const codeToSave = event.detail.code;
        console.log(`[LC Monaco Injector] Relaying 'saveCodeForTab' message to background (code length: ${codeToSave?.length ?? 0})`);

        // Send code to the background script for saving
        chrome.runtime.sendMessage(
            { action: 'saveCodeForTab', code: codeToSave },
            (response) => {
                // Handle the response from the background script's save attempt
                if (chrome.runtime.lastError) {
                    // Error sending message or background script issue
                    console.error("[LC Monaco Injector] Error sending save message or background crashed:", chrome.runtime.lastError.message);
                } else if (response && response.success) {
                    // console.log("[LC Monaco Injector] Background confirmed code save."); // Optional: Confirmation log
                } else if (response && !response.success) {
                    // Background script reported a failure during its save process
                    console.error("[LC Monaco Injector] Background reported save FAILURE:", response.error);
                } else {
                    // Unexpected response (should ideally always get success/failure)
                    console.warn("[LC Monaco Injector] No response or unexpected response from background save action.");
                }
            }
        );
    } else {
        console.warn("[LC Monaco Injector] Received '__monaco_save_code__' event without valid code detail.");
    }
});

// --- DOM Manipulation and Data Extraction ---

/**
 * Finds the original LeetCode editor element, hides it, and creates/prepares
 * the container element where the Monaco editor will be injected.
 * @returns {string|null} The ID of the container element if successful, otherwise null.
 */
function findEditorContainerAndPrepare() {
    console.log(`[LC Monaco Injector] Attempting to find original editor: '${ORIGINAL_EDITOR_SELECTOR}'`);
    const originalEditorElement = document.querySelector(ORIGINAL_EDITOR_SELECTOR);

    if (!originalEditorElement) {
        console.error(`[LC Monaco Injector] Critical - Could not find '${ORIGINAL_EDITOR_SELECTOR}' element.`);
        return null; // Indicate failure
    }
    console.log("[LC Monaco Injector] Found original editor element:", originalEditorElement);

    const parentToAppendTo = originalEditorElement.parentElement;
    if (!parentToAppendTo) {
        console.error("[LC Monaco Injector] Found original editor, but it has no parent element. Cannot inject.");
        return null;
    }

    // Hide the original editor
    console.log("[LC Monaco Injector] Hiding original editor element.");
    // Using setAttribute is slightly more robust than just style property
    originalEditorElement.setAttribute('style', HIDE_ORIGINAL_STYLE);
    // Alternatively, add a class: originalEditorElement.classList.add('monaco-extension-hidden-original');

    // Create or find our container
    let container = document.getElementById(EDITOR_CONTAINER_ID);
    if (container) {
        console.log(`[LC Monaco Injector] Reusing existing container: #${EDITOR_CONTAINER_ID}`);
        // Ensure it's visible if it was hidden before
        container.style.display = 'block';
        // Optional: Move it if necessary, though usually appending once is enough
        // parentToAppendTo.appendChild(container);
    } else {
        console.log(`[LC Monaco Injector] Creating new container: #${EDITOR_CONTAINER_ID}`);
        container = document.createElement('div');
        container.id = EDITOR_CONTAINER_ID;
        // Basic styling - might be better handled by injected CSS
        container.style.width = '100%';
        container.style.height = '500px'; // Default height, adjust as needed
        container.style.border = '1px solid grey'; // Visual aid during dev
        container.style.display = 'block';

        // Insert the container into the DOM, right after the (now hidden) original editor
        parentToAppendTo.insertBefore(container, originalEditorElement.nextSibling);
        // Or append at the end of the parent: parentToAppendTo.appendChild(container);

        console.log(`[LC Monaco Injector] Injected container #${EDITOR_CONTAINER_ID} into:`, parentToAppendTo);
    }

    return container.id;
}

/**
 * Detects the currently selected language on the LeetCode page.
 * !! This relies on selectors that might change with LeetCode updates. !!
 * @returns {string} The Monaco language ID (e.g., 'python', 'cpp', 'java') or 'plaintext'.
 */
function getLeetCodeLanguage() {
    // --- !!! IMPORTANT: This selector is fragile and likely to break if LeetCode changes its UI !!! ---
    try {
        const langElement = document.querySelector(LANGUAGE_SELECTOR);
        if (langElement && langElement.textContent) {
            const langText = langElement.textContent.toLowerCase().trim();
            console.log("[LC Monaco Injector] Detected language text:", langText);

            // Map LeetCode display names to Monaco language IDs
            const langMap = {
                "python": "python",
                "python3": "python",
                "java": "java",
                "c++": "cpp",
                "cpp": "cpp",
                "c": "c",
                "c#": "csharp",
                "csharp": "csharp",
                "javascript": "javascript",
                "typescript": "typescript",
                "php": "php",
                "swift": "swift",
                "kotlin": "kotlin",
                "dart": "dart",
                "golang": "go",
                "go": "go",
                "ruby": "ruby",
                "scala": "scala",
                "rust": "rust",
                "racket": "racket",
                "erlang": "erlang",
                "elixir": "elixir",
                // Add more mappings as needed based on LeetCode UI text
            };

            const monacoLang = langMap[langText] || 'plaintext';
             if (monacoLang === 'plaintext' && langText !== 'plaintext') { // Log if mapping failed
                 console.warn(`[LC Monaco Injector] No Monaco mapping found for detected language '${langText}'. Defaulting to 'plaintext'.`);
             } else {
                 console.log(`[LC Monaco Injector] Mapped to Monaco language: '${monacoLang}'`);
             }
            return monacoLang;
        } else {
            console.warn("[LC Monaco Injector] Could not find language element or it has no text using selector:", LANGUAGE_SELECTOR);
        }
    } catch (e) {
        console.error("[LC Monaco Injector] Error detecting language:", e);
    }

    console.warn("[LC Monaco Injector] Defaulting language to 'plaintext'.");
    return 'plaintext';
}

/**
 * Extracts the default boilerplate code for the current problem and language
 * from data embedded within the LeetCode page.
 * @param {string} targetMonacoLanguage - The Monaco language ID to look for (e.g., 'python').
 * @returns {string} The extracted boilerplate code or a fallback message.
 */
function getDefaultBoilerplateCode(targetMonacoLanguage) {
    console.log("[LC Monaco Injector] Attempting to retrieve default boilerplate code...");
    const fallbackCode = `// Monaco Editor Injected!\n// Failed to retrieve default code from page data.\n// Detected language: ${targetMonacoLanguage}\n// Please check console logs.`;
    let codeSnippets = null;

    // --- Strategy 1: Look for known global variables holding page data ---
    const potentialGlobalVars = ['__INITIAL_STATE__', 'pageData', 'payload']; // Add others if found
    for (const varName of potentialGlobalVars) {
        if (typeof window[varName] === 'object' && window[varName] !== null) {
            let found = findNestedKey(window[varName], 'codeSnippets');
            if (found && Array.isArray(found)) {
                console.log(`[LC Monaco Injector] Found 'codeSnippets' in window.${varName}`);
                codeSnippets = found;
                break;
            }
        }
    }

    // --- Strategy 2: Look in <script type="application/json"> tags ---
    if (!codeSnippets) {
        console.log("[LC Monaco Injector] Not found in global vars, searching <script type='application/json'> tags...");
        const scriptTags = document.querySelectorAll('script[type="application/json"]');
        for (const tag of scriptTags) {
            try {
                const jsonData = JSON.parse(tag.textContent);
                let found = findNestedKey(jsonData, 'codeSnippets');
                if (found && Array.isArray(found)) {
                    console.log("[LC Monaco Injector] Found 'codeSnippets' in a <script type='application/json'> tag.");
                    codeSnippets = found;
                    break;
                }
            } catch (e) {
                // Ignore tags with invalid JSON or without the key
            }
        }
    }

    // --- Process the found codeSnippets ---
    if (!codeSnippets) {
        console.error("[LC Monaco Injector] ERROR: Could not find the 'codeSnippets' data source.");
        return fallbackCode;
    }

    if (!Array.isArray(codeSnippets)) {
        console.error("[LC Monaco Injector] ERROR: Found 'codeSnippets' but it's not an array:", codeSnippets);
        return fallbackCode;
    }

    // --- Match the language ---
    console.log(`[LC Monaco Injector] Looking for snippet matching Monaco language: '${targetMonacoLanguage}'`);

    const languageDefinition = codeSnippets.find(snippet => {
        const slug = snippet?.langSlug?.toLowerCase();
        if (!slug) return false;

        // Direct match (most common case)
        if (slug === targetMonacoLanguage) return true;

        // Handle specific known variations between Monaco ID and LeetCode langSlug
        if (targetMonacoLanguage === 'python' && slug === 'python3') return true;
        if (targetMonacoLanguage === 'go' && slug === 'golang') return true;
        if (targetMonacoLanguage === 'csharp' && slug === 'c#') return true; // Example variation
        // Add any other mappings needed

        return false;
    });

    // --- Extract code or use fallback ---
    if (languageDefinition && typeof languageDefinition.code === 'string') {
        console.log(`[LC Monaco Injector] SUCCESS: Found default code snippet for langSlug '${languageDefinition.langSlug}'.`);
        // JS typically handles unicode escapes automatically when parsing/using strings
        return languageDefinition.code;
    } else {
        console.warn(`[LC Monaco Injector] WARNING: Could not find matching default code snippet for Monaco language '${targetMonacoLanguage}'. Available langSlugs:`, codeSnippets.map(s => s?.langSlug ?? 'N/A'));

        // Fallback: Use the first available snippet as a last resort
        const firstSnippet = codeSnippets.find(s => typeof s?.code === 'string');
        if (firstSnippet) {
            console.warn(`[LC Monaco Injector] Using default code for the first available snippet ('${firstSnippet.langSlug}') as fallback.`);
            return firstSnippet.code;
        }

        console.error(`[LC Monaco Injector] ERROR: No matching language found AND no fallback snippet available.`);
        return fallbackCode;
    }
}

/**
 * Helper function to recursively search for a key within a nested object.
 * @param {object|array} obj - The object or array to search within.
 * @param {string} keyToFind - The key to search for.
 * @returns {*} The value associated with the key if found, otherwise null.
 */
function findNestedKey(obj, keyToFind) {
    if (typeof obj !== 'object' || obj === null) {
        return null;
    }

    if (keyToFind in obj) {
        return obj[keyToFind];
    }

    for (const key in obj) {
        // hasOwnProperty check is important for inherited properties, though less critical for JSON data
        // if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const result = findNestedKey(obj[key], keyToFind);
            if (result !== null) {
                return result;
            }
        // }
    }

    return null;
}

/**
 * Extracts the problem slug (e.g., "two-sum") from the current URL.
 * @returns {string|null} The problem slug or null if not found.
 */
function getProblemSlug() {
    // Assumes URL structure like https://leetcode.com/problems/two-sum/...
    const match = window.location.pathname.match(/problems\/([^/]+)/);
    if (match && match[1]) {
        console.log(`[LC Monaco Injector] Detected problem slug: '${match[1]}'`);
        return match[1];
    }
    console.warn("[LC Monaco Injector] Could not determine LeetCode problem slug from URL:", window.location.pathname);
    return null;
}

// --- Initialization ---

/**
 * Main function to initialize the Monaco editor injection process.
 * Fetches necessary info (slug, container, language, initial code) and
 * messages the background script to perform the actual injection.
 */
function initializeEditor() {
    console.log("[LC Monaco Injector] Initializing...");

    const problemSlug = getProblemSlug();
    if (!problemSlug) {
        // Cannot proceed without a slug for saving/loading specific code.
        console.error("[LC Monaco Injector] Aborting initialization: Problem slug is required for code persistence.");
        return;
    }

    const containerId = findEditorContainerAndPrepare();
    if (!containerId) {
        console.error("[LC Monaco Injector] Aborting initialization: Failed to prepare editor container.");
        return;
    }

    const language = getLeetCodeLanguage(); // Detect language first
    const storageKey = STORAGE_KEY_PREFIX + problemSlug;

    // Asynchronously check storage for saved code before deciding initial code
    console.log(`[LC Monaco Injector] Checking storage for key: '${storageKey}'`);
    chrome.storage.local.get([storageKey], (result) => {
        let initialCode;
        let codeSource = '';

        if (chrome.runtime.lastError) {
            console.error("[LC Monaco Injector] Error reading from chrome.storage:", chrome.runtime.lastError);
            console.log("[LC Monaco Injector] Falling back to default boilerplate code due to storage error.");
            initialCode = getDefaultBoilerplateCode(language);
            codeSource = 'default (storage error)';
        } else if (result && result[storageKey] !== undefined && result[storageKey] !== null) {
            console.log(`[LC Monaco Injector] Found saved code for slug '${problemSlug}' in storage.`);
            initialCode = result[storageKey];
            codeSource = 'storage';
        } else {
            console.log(`[LC Monaco Injector] No saved code found for slug '${problemSlug}'. Using default boilerplate.`);
            initialCode = getDefaultBoilerplateCode(language);
            codeSource = 'default';
        }

        // Now send the message to the background script with the determined initial code
        console.log(`[LC Monaco Injector] Requesting Monaco injection for slug '${problemSlug}'. Code source: ${codeSource}. Options:`, { containerId, language, theme: THEME, initialCodeLength: initialCode?.length ?? 0 });

        chrome.runtime.sendMessage(
            {
                action: 'injectAndCreateMonaco',
                options: {
                    containerId: containerId,
                    language: language,
                    theme: THEME,
                    initialCode: initialCode, // Use stored or default code
                    problemSlug: problemSlug  // Pass the slug for context
                }
            },
            (response) => {
                // Handle response from background script's injection attempt
                if (chrome.runtime.lastError) {
                    console.error('[LC Monaco Injector] Error sending message to background:', chrome.runtime.lastError.message);
                    displayErrorInContainer(containerId, `Error communicating with background script: ${chrome.runtime.lastError.message}`);
                } else if (response) {
                    if (response.success) {
                        console.log('[LC Monaco Injector] Background script reported SUCCESSFUL editor injection!');
                    } else {
                        const errorMsg = response.error || 'Unknown error during injection.';
                        console.error('[LC Monaco Injector] Background script reported INJECTION FAILURE:', errorMsg);
                        displayErrorInContainer(containerId, `Failed to load Monaco Editor: ${errorMsg}`);
                    }
                } else {
                    console.error('[LC Monaco Injector] No response received from background script. It might have crashed or failed to initialize.');
                     displayErrorInContainer(containerId, 'No response from background script. Extension might be malfunctioning.');
                }
            }
        );
    }); // End of chrome.storage.local.get callback
}

/**
 * Displays an error message inside the Monaco container element.
 * @param {string} containerId - The ID of the container element.
 * @param {string} message - The error message to display.
 */
function displayErrorInContainer(containerId, message) {
    const container = document.getElementById(containerId);
    if (container) {
        container.innerHTML = `<div style='color:red; background-color: #333; padding: 15px; font-family: sans-serif; font-size: 14px;'>
            <strong>Monaco Editor Injection Failed:</strong><br>${message}<br>
            Please check the extension's background console and content script logs for more details. You might need to reload the page or reinstall the extension.
            </div>`;
        container.style.border = '2px dashed red';
        container.style.height = 'auto'; // Adjust height to fit message
    } else {
        console.error(`[LC Monaco Injector] Cannot display error, container #${containerId} not found.`);
    }
}


// --- Execution Trigger ---

/**
 * Waits for the original LeetCode editor element to be present in the DOM
 * before initiating the Monaco editor setup. This handles cases where
 * the editor loads dynamically after the initial page load.
 */
function waitForEditorAndInitialize() {
    let currentAttempt = 0;
    const checkInterval = setInterval(() => {
        currentAttempt++;
        const editorElement = document.querySelector(ORIGINAL_EDITOR_SELECTOR);

        if (editorElement) {
            console.log(`[LC Monaco Injector] Found '${ORIGINAL_EDITOR_SELECTOR}' on attempt ${currentAttempt}. Proceeding with initialization.`);
            clearInterval(checkInterval);
            initializeEditor(); // Start the main process
        } else if (currentAttempt >= MAX_INIT_ATTEMPTS) {
            clearInterval(checkInterval);
            console.error(`[LC Monaco Injector] Timed out after ${MAX_INIT_ATTEMPTS} attempts waiting for '${ORIGINAL_EDITOR_SELECTOR}' to appear. Aborting.`);
            // Optional: Display a user-facing error?
        } else {
             // console.log(`[LC Monaco Injector] Waiting for '${ORIGINAL_EDITOR_SELECTOR}'... Attempt ${currentAttempt}/${MAX_INIT_ATTEMPTS}`);
        }
    }, INIT_CHECK_INTERVAL_MS);
}

// Start the process
waitForEditorAndInitialize();