// Reading HTML that came from outside (an email's body, text pasted into TOMLIN Write) into a document that is never
// shown: such a document runs no scripts and loads nothing, and the caller copies out only what it allows. The page's
// security policy requires Trusted Types (security-headers.json), so this is the one place a string becomes HTML,
// through a policy that only this file can use; anything else that tries to put a string into the page as HTML or
// script is stopped by the browser.

interface Policy { createHTML(input: string): unknown }
type TrustedTypesFactory = { createPolicy(name: string, rules: { createHTML(input: string): string }): Policy };

const factory = (globalThis as { trustedTypes?: TrustedTypesFactory }).trustedTypes;
/** Named in the policy's trusted-types list; a browser without Trusted Types takes the string as it is. */
const policy = factory?.createPolicy('tomlinos-inert', { createHTML: input => input }) ?? null;

/** `html` parsed into a detached document: nothing in it runs, loads or shows. */
export function parseInert(html: string): Document {
  return new DOMParser().parseFromString((policy ? policy.createHTML(html) : html) as string, 'text/html');
}

/**
 * `html` as markup for a detached document only: TOMLIN Write's editor (ProseMirror) reads pasted HTML into a document
 * made with createHTMLDocument, which has no window, so nothing in it runs or loads.
 */
export function inertMarkup(html: string): unknown {
  return policy ? policy.createHTML(html) : html;
}
