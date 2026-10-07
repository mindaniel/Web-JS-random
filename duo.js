// ==UserScript==
// @name         Duolingo Path Lessons
// @namespace    http://duolingopro.net
// @version      1.0
// @description  Solve a chosen number of lessons on the Duolingo path automatically.
// @author       anonymousHackerIV (stripped)
// @match        *://*.duolingo.com/*
// @match        *://*.duolingo.cn/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Guard against duplicate instances. Multiple injectors (or re-injection)
    // would each start their own polling loop with their own in-memory state,
    // so stopping one would leave the others running. Only the first runs.
    if (window.__dlpInstalled) return;
    window.__dlpInstalled = true;

    // ------------------------------------------------------------------
    // Configuration / state
    // ------------------------------------------------------------------
    const STORAGE_KEY = 'DLP_Path_Lessons';
    const debug = false;

    const DEFAULT_REACT_MAIN_ELEMENT_CLASS = '_3yE3H';
    const DEFAULT_REACT_TRAVERSE_UP = 1;
    const STORY_REACT_MAIN_ELEMENT_CLASS = '_3TJzR';
    const STORY_REACT_TRAVERSE_UP = 0;

    let findReactMainElementClass = DEFAULT_REACT_MAIN_ELEMENT_CLASS;
    let reactTraverseUp = DEFAULT_REACT_TRAVERSE_UP;

    let isAutoMode = false;
    let isSolveBusy = false;
    let solvingLoopRunning = false;
    let currentQuestionId = null;
    let hasLoggedForCurrent = 0;
    let solveAllRunToken = 0;
    let lastNavTime = 0;

    // Persisted across page reloads (a path run spans many page loads).
    function loadState() {
        try {
            const raw = sessionStorage.getItem(STORAGE_KEY);
            if (!raw) return { amount: 0, active: false };
            const parsed = JSON.parse(raw);
            return { amount: Number(parsed.amount) || 0, active: !!parsed.active };
        } catch (e) {
            return { amount: 0, active: false };
        }
    }
    function saveState(s) {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    }
    let state = loadState();

    // ------------------------------------------------------------------
    // React fiber helpers
    // ------------------------------------------------------------------
    function getReactFiber(dom) {
        if (!dom) return null;
        const key = Object.keys(dom).find((entry) =>
            entry.startsWith('__reactFiber$') || entry.startsWith('__reactInternalInstance$')
        );
        return key ? dom[key] : null;
    }

    function findReact(dom, traverseUp = reactTraverseUp, includeDetails = false) {
        if (!dom) return null;
        const key = Object.keys(dom).find((k) =>
            k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
        );
        const domFiber = dom[key];
        if (domFiber == null) return null;

        if (domFiber._currentElement) {
            let compFiber = domFiber._currentElement._owner;
            for (let i = 0; i < traverseUp; i++) {
                compFiber = compFiber._currentElement._owner;
            }
            if (includeDetails) return { instance: compFiber._instance, props: null, hooks: [] };
            return compFiber._instance;
        }

        const GetCompFiber = (fiber) => {
            let parentFiber = fiber.return;
            while (parentFiber && typeof parentFiber.type == 'string') {
                parentFiber = parentFiber.return;
            }
            return parentFiber;
        };
        let compFiber = GetCompFiber(domFiber);
        for (let i = 0; i < traverseUp && compFiber; i++) {
            compFiber = GetCompFiber(compFiber);
        }
        if (!compFiber) return null;

        if (includeDetails) {
            const hooks = [];
            let hookNode = compFiber.memoizedState;
            while (hookNode) {
                hooks.push(hookNode.memoizedState);
                hookNode = hookNode.next;
            }
            return { instance: compFiber.stateNode, props: compFiber.memoizedProps, hooks };
        }
        return compFiber.stateNode;
    }

    function syncReactLookupByContext() {
        const isStoryContext = document.querySelector('.FmlUF') !== null
            || document.querySelector('[data-test="stories-player-continue"], [data-test="stories-player-done"], [data-test="story-start"]') !== null;

        if (isStoryContext) {
            findReactMainElementClass = STORY_REACT_MAIN_ELEMENT_CLASS;
            reactTraverseUp = STORY_REACT_TRAVERSE_UP;
        } else {
            findReactMainElementClass = DEFAULT_REACT_MAIN_ELEMENT_CLASS;
            reactTraverseUp = DEFAULT_REACT_TRAVERSE_UP;
        }
    }

    function getChallengeFromDom() {
        const anchors = [
            document.querySelector('[data-test="challenge-choice"]'),
            document.querySelector('[data-test$="challenge-tap-token"]'),
            document.querySelector('[data-test~="challenge"]'),
            document.getElementsByClassName(findReactMainElementClass)[0],
        ].filter(Boolean);

        for (const anchor of anchors) {
            let fiber = getReactFiber(anchor);
            for (let depth = 0; depth < 60 && fiber; depth++) {
                const challenge = fiber.memoizedProps?.currentChallenge;
                if (challenge) return challenge;
                fiber = fiber.return;
            }
        }
        return null;
    }

    function refreshWindowSolFromReact() {
        try {
            const fromDom = getChallengeFromDom();
            if (fromDom) {
                window.sol = fromDom;
                return;
            }
            const dom = document.getElementsByClassName(findReactMainElementClass)[0];
            const details = findReact(dom, reactTraverseUp, true);
            window.sol = details?.props?.currentChallenge
                ?? findReact(dom)?.props?.currentChallenge
                ?? null;
        } catch (error) {
            window.sol = null;
        }
    }

    function getCleanButtonText(button) {
        const rubyElements = button.querySelectorAll('ruby');
        if (rubyElements.length > 0) {
            let text = '';
            rubyElements.forEach((ruby) => {
                const baseTextElements = ruby.querySelectorAll('span[lang]:not(rt)');
                baseTextElements.forEach((span) => { text += span.textContent; });
            });
            return text.trim();
        }
        const textElement = button.querySelector('[data-test="challenge-tap-token-text"]');
        return textElement ? textElement.innerText.trim() : button.innerText.trim();
    }

    // ------------------------------------------------------------------
    // Challenge type detection
    // ------------------------------------------------------------------
    function determineChallengeType() {
        try {
            if (document.getElementsByClassName('FmlUF').length > 0) {
                // Story
                if (window.sol.type === 'arrange') return 'Story Arrange';
                if (window.sol.type === 'multiple-choice' || window.sol.type === 'select-phrases') return 'Story Multiple Choice';
                if (window.sol.type === 'point-to-phrase') return 'Story Point to Phrase';
                if (window.sol.type === 'match') return 'Story Pairs';
                return false;
            }

            if (document.querySelectorAll('[data-test*="challenge-speak"]').length > 0) return 'Challenge Speak';
            if (window.sol.type === 'syllableTap') return 'Syllable Tap';
            if (window.sol.type === 'syllableListenTap') return 'Syllable Listen Tap';
            if (window.sol.type === 'tapCompleteTable') return 'Tap Complete Table';
            if (window.sol.type === 'typeCloze') return 'Type Cloze';
            if (window.sol.type === 'typeClozeTable') return 'Type Cloze Table';
            if (window.sol.type === 'tapClozeTable') return 'Tap Cloze Table';
            if (window.sol.type === 'typeCompleteTable') return 'Type Complete Table';
            if (window.sol.type === 'patternTapComplete') return 'Pattern Tap Complete';
            if (window.sol.type === 'completeReverseTranslation') return 'Complete Reverse Translation';
            if (document.querySelectorAll('[data-test*="challenge-name"]').length > 0 && document.querySelectorAll('[data-test="challenge-choice"]').length > 0) return 'Challenge Name';
            if (window.sol.type === 'listenMatch') return 'Listen Match';
            if (document.querySelectorAll('[data-test="challenge challenge-characterWrite"]').length > 0) {
                if (document.querySelector('g._25Ktp')) return 'Character Write Drag';
                if (document.querySelectorAll('path._1e5Zt').length > 0) return 'Character Write Draw';
                return 'Character Write Freehand';
            }
            if (document.querySelectorAll('[data-test="challenge challenge-listenSpeak"]').length > 0) return 'Listen Speak';
            if (document.querySelectorAll('[data-test="challenge-choice"]').length > 0) {
                if (document.querySelectorAll('[data-test="challenge-text-input"]').length > 0) return 'Challenge Choice with Text Input';
                return 'Challenge Choice';
            }
            if (document.querySelectorAll('[data-test$="challenge-tap-token"]').length > 0) {
                if (window.sol.pairs !== undefined) return 'Pairs';
                if (window.sol.correctTokens !== undefined) return 'Tokens Run';
                if (window.sol.correctIndices !== undefined) return 'Indices Run';
            }
            if (document.querySelectorAll('[data-test="challenge-tap-token-text"]').length > 0) return 'Fill in the Gap';
            if (document.querySelectorAll('[data-test="challenge-text-input"]').length > 0) return 'Challenge Text Input';
            if (document.querySelectorAll('[data-test*="challenge-partialReverseTranslate"]').length > 0) return 'Partial Reverse';
            if (document.querySelectorAll('textarea[data-test="challenge-translate-input"]').length > 0) return 'Challenge Translate Input';
            if (document.querySelectorAll('[data-test="session-complete-slide"]').length > 0) return 'Session Complete';
            return false;
        } catch (error) {
            console.log(error);
            return 'error';
        }
    }

    // ------------------------------------------------------------------
    // Challenge handling
    // ------------------------------------------------------------------
    async function handleChallenge(challengeType) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        if (challengeType === 'Challenge Speak' || challengeType === 'Listen Match' || challengeType === 'Listen Speak') {
            document.querySelector('button[data-test="player-skip"]')?.click();

        } else if (challengeType === 'Challenge Choice' || challengeType === 'Challenge Choice with Text Input') {
            if (challengeType === 'Challenge Choice with Text Input') {
                const elm = document.querySelectorAll('[data-test="challenge-text-input"]')[0];
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                setter.call(elm, window.sol.correctSolutions
                    ? window.sol.correctSolutions[0].split(/(?<=^\S+)\s/)[1]
                    : (window.sol.displayTokens ? window.sol.displayTokens.find((t) => t.isBlank).text : window.sol.prompt));
                elm.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                document.querySelectorAll("[data-test='challenge-choice']")[window.sol.correctIndex].click();
            }

        } else if (challengeType === 'Pairs') {
            const nl = document.querySelectorAll('[data-test*="challenge-tap-token"]:not(span)');
            window.sol.pairs?.forEach((pair) => {
                for (let i = 0; i < nl.length; i++) {
                    if (nl[i].disabled) continue;
                    const buttonText = getCleanButtonText(nl[i]).toLowerCase();
                    try {
                        if (buttonText === pair.transliteration.toLowerCase().trim() ||
                            buttonText === pair.character.toLowerCase().trim()) {
                            nl[i].click();
                        }
                    } catch (TypeError) {
                        if (buttonText === pair.learningToken.toLowerCase().trim() ||
                            buttonText === pair.fromToken.toLowerCase().trim()) {
                            nl[i].click();
                        }
                    }
                }
            });

        } else if (challengeType === 'Story Pairs') {
            const nl = document.querySelectorAll('[data-test*="challenge-tap-token"]:not(span)');
            const textToElementMap = new Map();
            for (let i = 0; i < nl.length; i++) {
                textToElementMap.set(getCleanButtonText(nl[i]).toLowerCase(), nl[i]);
            }
            for (const key in window.sol.dictionary) {
                if (window.sol.dictionary.hasOwnProperty(key)) {
                    const value = window.sol.dictionary[key];
                    const keyPart = key.split(":")[1].toLowerCase().trim();
                    const normalizedValue = value.toLowerCase().trim();
                    const element1 = textToElementMap.get(keyPart);
                    const element2 = textToElementMap.get(normalizedValue);
                    element1?.click();
                    element2?.click();
                }
            }

        } else if (challengeType === 'Tokens Run') {
            const all_tokens = document.querySelectorAll('[data-test*="challenge-tap-token"]:not(span)');
            const correct_tokens = window.sol.correctTokens;
            let clicked_tokens = [];
            correct_tokens.forEach((correct_token) => {
                const matching_elements = Array.from(all_tokens).filter((element) => {
                    return getCleanButtonText(element) === correct_token.trim();
                });
                if (matching_elements.length > 0) {
                    const match_index = clicked_tokens.filter((token) => {
                        return getCleanButtonText(token) === correct_token.trim();
                    }).length;
                    if (match_index < matching_elements.length) {
                        matching_elements[match_index].click();
                        clicked_tokens.push(matching_elements[match_index]);
                    } else {
                        clicked_tokens.push(matching_elements[0]);
                    }
                }
            });

        } else if (challengeType === 'Indices Run' || challengeType === 'Fill in the Gap') {
            if (window.sol.correctIndices) {
                window.sol.correctIndices?.forEach((index) => {
                    document.querySelectorAll('div[data-test="word-bank"] [data-test*="challenge-tap-token"]:not(span)')[index].click();
                });
            }

        } else if (challengeType === 'Challenge Text Input') {
            const elm = document.querySelectorAll('[data-test="challenge-text-input"]')[0];
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(elm, window.sol.correctSolutions
                ? window.sol.correctSolutions[0]
                : (window.sol.displayTokens ? window.sol.displayTokens.find((t) => t.isBlank).text : window.sol.prompt));
            elm.dispatchEvent(new Event('input', { bubbles: true }));

        } else if (challengeType === 'Partial Reverse') {
            const elm = document.querySelector('[data-test*="challenge-partialReverseTranslate"]')?.querySelector("span[contenteditable]");
            const setter = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent').set;
            setter.call(elm, window.sol?.displayTokens?.filter((t) => t.isBlank)?.map((t) => t.text)?.join()?.replaceAll(',', ''));
            elm.dispatchEvent(new Event('input', { bubbles: true }));

        } else if (challengeType === 'Challenge Translate Input') {
            const elm = document.querySelector('textarea[data-test="challenge-translate-input"]');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(elm, window.sol.correctSolutions ? window.sol.correctSolutions[0] : window.sol.prompt);
            elm.dispatchEvent(new Event('input', { bubbles: true }));

        } else if (challengeType === 'Challenge Name') {
            const articles = findReact(document.getElementsByClassName(findReactMainElementClass)[0]).props.currentChallenge.articles;
            const correctSolutions = findReact(document.getElementsByClassName(findReactMainElementClass)[0]).props.currentChallenge.correctSolutions[0];
            const matchingArticle = articles.find((article) => correctSolutions.startsWith(article));
            const matchingIndex = matchingArticle !== undefined ? articles.indexOf(matchingArticle) : null;
            const remainingValue = correctSolutions.substring(matchingArticle.length);
            const selectedElement = document.querySelector(`[data-test="challenge-choice"]:nth-child(${matchingIndex + 1})`);
            if (selectedElement) selectedElement.click();
            const elm = document.querySelector('[data-test="challenge-text-input"]');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(elm, remainingValue);
            elm.dispatchEvent(new Event('input', { bubbles: true }));

        } else if (challengeType === 'Type Cloze') {
            const input = document.querySelector('input[type="text"].b4jqk');
            if (!input) return;
            const targetToken = window.sol.displayTokens.find((t) => t.damageStart !== undefined);
            const correctWord = targetToken?.text || '';
            let correctEnding = '';
            if (typeof targetToken?.damageStart === 'number') correctEnding = correctWord.slice(targetToken.damageStart);
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(input, correctEnding);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));

        } else if (challengeType === 'Type Cloze Table') {
            const tableRows = document.querySelectorAll('tbody tr');
            window.sol.displayTableTokens.slice(1).forEach((rowTokens, i) => {
                const answerCell = rowTokens[1]?.find((t) => typeof t.damageStart === 'number');
                if (answerCell && tableRows[i]) {
                    const input = tableRows[i].querySelector('input[type="text"].b4jqk');
                    if (!input) return;
                    const correctEnding = answerCell.text.slice(answerCell.damageStart);
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    setter.call(input, correctEnding);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });

        } else if (challengeType === 'Tap Cloze Table') {
            const tableRows = document.querySelectorAll('tbody tr');
            window.sol.displayTableTokens.slice(1).forEach((rowTokens, i) => {
                const answerCell = rowTokens[1]?.find((t) => typeof t.damageStart === 'number');
                if (!answerCell || !tableRows[i]) return;
                const wordBank = document.querySelector('[data-test="word-bank"], .eSgkc');
                const wordButtons = wordBank ? Array.from(wordBank.querySelectorAll('button[data-test*="challenge-tap-token"]:not([aria-disabled="true"])')) : [];
                const correctEnding = answerCell.text.slice(answerCell.damageStart);
                let endingMatched = "";
                for (let btn of wordButtons) {
                    const btnText = getCleanButtonText(btn);
                    if (!correctEnding.startsWith(endingMatched + btnText)) continue;
                    btn.click();
                    endingMatched += btnText;
                    if (endingMatched === correctEnding) break;
                }
            });

        } else if (challengeType === 'Type Complete Table') {
            const tableRows = document.querySelectorAll('tbody tr');
            window.sol.displayTableTokens.slice(1).forEach((rowTokens, i) => {
                const answerCell = rowTokens[1]?.find((t) => t.isBlank);
                if (!answerCell || !tableRows[i]) return;
                const input = tableRows[i].querySelector('input[type="text"].b4jqk');
                if (!input) return;
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                setter.call(input, answerCell.text);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            });

        } else if (challengeType === 'Pattern Tap Complete') {
            const wordBank = document.querySelector('[data-test="word-bank"], .eSgkc');
            if (!wordBank) return;
            const choices = window.sol.choices;
            const correctIndex = window.sol.correctIndex ?? 0;
            const correctText = choices[correctIndex];
            const buttons = Array.from(wordBank.querySelectorAll('button[data-test*="challenge-tap-token"]:not([aria-disabled="true"])'));
            const targetButton = buttons.find((btn) => getCleanButtonText(btn) === correctText);
            if (targetButton) targetButton.click();

        } else if (challengeType === 'Complete Reverse Translation') {
            const blankTokens = window.sol.displayTokens.filter((t) => t.isBlank);
            const inputFields = document.querySelectorAll('[data-test="challenge-text-input"]');
            inputFields.forEach((input, index) => {
                if (blankTokens[index]) {
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    setter.call(input, blankTokens[index].text);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });

        } else if (challengeType === 'Syllable Tap' || challengeType === 'Syllable Listen Tap') {
            const correctIndices = window.sol.correctIndices;
            const choicesData = window.sol.choices;
            const domButtons = Array.from(document.querySelectorAll('[data-test="word-bank"] [data-test$="challenge-tap-token"]'));
            correctIndices.forEach((index) => {
                const correctText = choicesData[index].text;
                const matchingButton = domButtons.find((btn) => getCleanButtonText(btn) === correctText);
                if (matchingButton) matchingButton.click();
            });

        } else if (challengeType === 'Story Arrange') {
            let choices = document.querySelectorAll('[data-test*="challenge-tap-token"]:not(span)');
            for (let i = 0; i < window.sol.phraseOrder.length; i++) {
                choices[window.sol.phraseOrder[i]].click();
            }

        } else if (challengeType === 'Story Multiple Choice') {
            let choices = document.querySelectorAll('[data-test="stories-choice"]');
            choices[window.sol.correctAnswerIndex].click();

        } else if (challengeType === 'Story Point to Phrase') {
            let choices = document.querySelectorAll('[data-test="challenge-tap-token-text"]');
            let correctIndex = -1;
            for (let i = 0; i < window.sol.parts.length; i++) {
                if (window.sol.parts[i].selectable === true) {
                    correctIndex += 1;
                    if (window.sol.correctAnswerIndex === i) {
                        choices[correctIndex].parentElement.click();
                    }
                }
            }
        }

        return true;
    }

    // ------------------------------------------------------------------
    // Click helpers
    // ------------------------------------------------------------------
    async function clickCheck() {
        try {
            const nextButtonNormal = document.querySelector('[data-test="player-next"]');
            const storiesContinueButton = document.querySelector('[data-test="stories-player-continue"]');
            const storiesDoneButton = document.querySelector('[data-test="stories-player-done"]');

            const nextButtonAriaValueNormal = nextButtonNormal ? nextButtonNormal.getAttribute('aria-disabled') : null;
            const nextButtonAriaValueStoriesContinue = storiesContinueButton ? storiesContinueButton.disabled : null;

            const nextButton = nextButtonNormal || storiesContinueButton || storiesDoneButton;
            const nextButtonAriaValue = nextButtonAriaValueNormal || nextButtonAriaValueStoriesContinue || storiesDoneButton;

            if (nextButton) {
                if (String(nextButtonAriaValue) === 'true') {
                    // disabled - do nothing
                } else {
                    nextButton.click();
                }
            }
        } catch (error) {
            console.error(error);
        }
    }

    async function clickNext() {
        const challengeElement = document.querySelector('[data-test~="challenge"]');
        let observer = null;
        let clicked = false;

        const removalPromise = challengeElement ? new Promise((resolve) => {
            if (!document.body.contains(challengeElement)) return resolve();
            observer = new MutationObserver(() => {
                if (!document.body.contains(challengeElement)) {
                    observer.disconnect();
                    resolve();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }) : Promise.resolve();

        try {
            const nextButton = document.querySelector('[data-test="player-next"]') ||
                document.querySelector('[data-test="stories-player-continue"]') ||
                document.querySelector('[data-test="stories-player-done"]');
            if (nextButton) {
                nextButton.click();
                clicked = true;
            }
        } catch (error) {
            console.error(error);
        } finally {
            if (clicked && challengeElement) await removalPromise;
            else if (observer) observer.disconnect();
        }
    }

    // ------------------------------------------------------------------
    // Core solve routine
    // ------------------------------------------------------------------
    function bumpSolveAllRunToken() { return ++solveAllRunToken; }

    async function solve(check = true, skip = false, runToken = solveAllRunToken) {
        if (isSolveBusy) return;
        isSolveBusy = true;
        syncReactLookupByContext();

        try {
            const sessionCompleteSlide = document.querySelector('[data-test="session-complete-slide"]');

            // Click away common interstitials.
            const selectorsForSkip = [
                '[data-test="practice-hub-ad-no-thanks-button"]',
                '.vpDIE',
                '[data-test="plus-no-thanks"]',
                '[data-test="story-start"]',
            ];
            selectorsForSkip.forEach((selector) => {
                const element = document.querySelector(selector);
                if (element) element.click();
            });

            // ---- Lesson finished: advance the counter ----
            if (sessionCompleteSlide !== null && isAutoMode && state.active) {
                state.amount -= 1;
                saveState(state);
                isAutoMode = false;
                updateStatus();

                if (state.amount > 0) {
                    // Go back to the path; the poller will start the next lesson.
                    window.location.href = 'https://duolingo.com/learn';
                } else {
                    state.amount = 0;
                    state.active = false;
                    saveState(state);
                    updateStatus();
                    window.location.href = 'https://duolingo.com';
                }
                return;
            }

            window.sol = null;
            refreshWindowSolFromReact();

            const challengeType = window.sol ? determineChallengeType() : 'error';

            let questionKey = null;
            if (window.sol && window.sol.id) questionKey = window.sol.id;
            else if (window.sol) questionKey = JSON.stringify({ type: window.sol.type, prompt: window.sol.prompt || '' });

            if (questionKey !== currentQuestionId) {
                currentQuestionId = questionKey;
                hasLoggedForCurrent = 0;
            }

            if (challengeType === 'error') {
                await Promise.race([clickCheck(), new Promise((r) => setTimeout(r, 500))]);
            } else if (challengeType) {
                if (debug) console.log('Challenge Type: ' + challengeType);

                const playerFooter1 = document.getElementById('session/PlayerFooter');

                if ((playerFooter1 && playerFooter1.matches('._3rB4d._1VTif._2HXQ9')) || (!playerFooter1 && document.querySelector('._2i9lj'))) {
                    const challengeReady = await Promise.race([
                        handleChallenge(challengeType),
                        new Promise((resolve) => setTimeout(() => resolve(true), 2000)),
                    ]);
                    await new Promise((r) => setTimeout(r, 50));
                    if (challengeReady === false) return;
                }

                if (check && ((playerFooter1 && playerFooter1.matches('._3rB4d._1VTif._2HXQ9')) || (!playerFooter1 && document.querySelector('._2i9lj')))) {
                    await Promise.race([clickCheck(), new Promise((r) => setTimeout(r, 500))]);
                }

                if (skip) {
                    await Promise.race([clickNext(), new Promise((r) => setTimeout(r, 500))]);
                }
            } else {
                await Promise.race([clickCheck(), new Promise((r) => setTimeout(r, 500))]);
            }
        } finally {
            isSolveBusy = false;
        }
    }

    function startSolvingLoop(runToken) {
        if (solvingLoopRunning || !isAutoMode || runToken !== solveAllRunToken) return;
        solvingLoopRunning = true;
        const initialUrl = window.location.href;

        (async function runLoop() {
            while (isAutoMode && runToken === solveAllRunToken) {
                if (window.location.href !== initialUrl) {
                    isAutoMode = false;
                    break;
                }
                const startTime = Date.now();
                await solve(true, true, runToken);
                await new Promise((r) => setTimeout(r, 100));
                if (!isAutoMode || runToken !== solveAllRunToken) break;
                const elapsed = Date.now() - startTime;
                const remaining = 400 - elapsed;
                if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
            }
            solvingLoopRunning = false;
        })();
    }

    function startSolving() {
        isAutoMode = true;
        const token = bumpSolveAllRunToken();
        startSolvingLoop(token);
    }
    function stopSolving() {
        isAutoMode = false;
    }

    // ------------------------------------------------------------------
    // Path navigation poller
    // ------------------------------------------------------------------
    function pathPoller() {
        const url = window.location.href;
        const isLessonPage = url.includes('/lesson') || url.includes('/practice') || url.includes('/practice-hub/listening-practice');

        if (state.active && state.amount > 0) {
            if (!isLessonPage) {
                if (Date.now() - lastNavTime > 3000) {
                    lastNavTime = Date.now();
                    window.location.href = 'https://duolingo.com/lesson';
                }
            } else {
                if (!isAutoMode) startSolving();
            }
        } else {
            if (isAutoMode) stopSolving();
        }
    }
    setInterval(pathPoller, 500);

    // ------------------------------------------------------------------
    // UI panel
    // ------------------------------------------------------------------
    function createPanel() {
        if (document.getElementById('dlp-path-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'dlp-path-panel';
        panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;background:#fff;border:1px solid #ddd;border-radius:12px;padding:12px;font-family:sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.15);width:230px;';
        panel.innerHTML = `
              <div id="dlp-path-header" style="font-weight:600;margin-bottom:8px;cursor:move;user-select:none;display:flex;justify-content:space-between;align-items:center;">Path Lessons<span style="font-size:13px;color:#aaa;margin-left:8px;">та┐</span></div>
            <label style="font-size:12px;color:#555;">How many lessons would you like to solve on the path?</label>
            <input id="dlp-path-input" type="number" min="1" placeholder="0" style="width:100%;box-sizing:border-box;margin:6px 0;padding:6px;border:1px solid #ccc;border-radius:6px;">
            <button id="dlp-path-start" style="width:100%;padding:8px;border:none;border-radius:6px;background:#1cb0f6;color:#fff;font-weight:600;cursor:pointer;">Start</button>
            <div id="dlp-path-status" style="font-size:12px;color:#555;margin-top:6px;"></div>
        `;
        document.body.appendChild(panel);

          // --- Drag to move the panel ---
          const header = panel.querySelector('#dlp-path-header');
          let dragging = false, dragX = 0, dragY = 0, dragLeft = 0, dragTop = 0;
          header.addEventListener('mousedown', (e) => {
              dragging = true;
              const rect = panel.getBoundingClientRect();
              dragLeft = rect.left;
              dragTop = rect.top;
              dragX = e.clientX;
              dragY = e.clientY;
              panel.style.right = 'auto';
              panel.style.bottom = 'auto';
              panel.style.left = dragLeft + 'px';
              panel.style.top = dragTop + 'px';
              e.preventDefault();
          });
          document.addEventListener('mousemove', (e) => {
              if (!dragging) return;
              panel.style.left = (dragLeft + e.clientX - dragX) + 'px';
              panel.style.top = (dragTop + e.clientY - dragY) + 'px';
          });
          document.addEventListener('mouseup', () => { dragging = false; });

        const input = panel.querySelector('#dlp-path-input');
        const startBtn = panel.querySelector('#dlp-path-start');
        const statusEl = panel.querySelector('#dlp-path-status');

        window.__dlpUpdateStatus = function () {
            if (state.active && state.amount > 0) {
                startBtn.textContent = 'Stop';
                startBtn.style.background = '#ff4b4b';
                statusEl.textContent = `Solving... ${state.amount} left`;
            } else {
                startBtn.textContent = 'Start';
                startBtn.style.background = '#1cb0f6';
                statusEl.textContent = '';
            }
        };

        startBtn.addEventListener('click', () => {
            if (state.active && state.amount > 0) {
                state.active = false;
                saveState(state);
                stopSolving();
                updateStatus();
                return;
            }
            const val = Number(input.value);
            if (!val || val <= 0) return;
            state.amount = val;
            state.active = true;
            saveState(state);
            updateStatus();
            pathPoller();
        });

        updateStatus();
    }

    function updateStatus() {
        if (window.__dlpUpdateStatus) window.__dlpUpdateStatus();
    }

    // ------------------------------------------------------------------
    // Programmatic control API (used by solve_lessons.py over CDP)
    // ------------------------------------------------------------------
    window.__dlp = {
        start: function (n) {
            const amt = Number(n) || 0;
            if (amt > 0) state.amount = amt;
            if (state.amount <= 0) return { active: state.active, amount: state.amount };
            state.active = true;
            saveState(state);
            updateStatus();
            pathPoller();
            return { active: state.active, amount: state.amount };
        },
        add: function (n) {
            const amt = Number(n) || 0;
            if (amt > 0) state.amount += amt;
            if (state.amount <= 0) return { active: state.active, amount: state.amount };
            state.active = true;
            saveState(state);
            updateStatus();
            pathPoller();
            return { active: state.active, amount: state.amount };
        },
        stop: function () {
            state.active = false;
            state.amount = 0;
            saveState(state);
            stopSolving();
            updateStatus();
            return { active: state.active, amount: state.amount };
        },
        status: function () {
            return { active: state.active, amount: state.amount };
        }
    };

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------
    function init() {
        if (!document.body) {
            setTimeout(init, 200);
            return;
        }
        createPanel();
        if (state.active && state.amount > 0) {
            setTimeout(pathPoller, 1000);
        }
    }
    init();
})();
