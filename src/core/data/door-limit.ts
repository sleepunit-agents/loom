/** The most one request may carry through the door: a GraphQL request, a socket message or a command's body.
 * A file of its own with no imports, so the programs that send to the door (the command-line clients, a
 * worker, a body) can refuse an oversized request by the same number without loading the server. */
export const DOOR_REQUEST_BYTES = 1024 * 1024;
