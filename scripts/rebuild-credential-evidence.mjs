/** Every helper shares this page, including failure screenshots taken later. */
export function maskCredentialScreenshots(page){
 const screenshot=page.screenshot.bind(page);
 page.screenshot=options=>screenshot({...options,mask:[...(options?.mask??[]),page.locator('[data-signin-link], [aria-label="Token value"]')]});
}
