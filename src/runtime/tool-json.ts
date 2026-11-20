// Preserve machine-readable JSON while keeping markup inside JSON string tokens inert.
export const toolJson = (value: unknown) => JSON.stringify(value).replace(/"(?:[^"\\]|\\.)*"/g,
 token => token.replace(/[`<>&*_[\]~]/g, char => '\\u'+char.charCodeAt(0).toString(16).padStart(4, '0')));
