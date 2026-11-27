/** Account's one selection: the signed-in member's own passkeys, signed-in browsers and notification devices. The
 * desktop's Account piece and the boards page's `account` brick read exactly this. A string and a type. */
export interface Account { member:string;notifications?:{publicKey:string|null;devices:Array<{ref:string;device:string;createdAt:string;seenAt:string}>};passkeys:Array<{ref:string;label:string;createdAt:string;lastUsedAt:string|null;ended:boolean}>;sessions:Array<{ref:string;device:string;issuedAt:string;seenAt:string;ended:boolean}> }
export const accountQuery=`query Account { account { member notifications { publicKey devices { ref device createdAt seenAt } } passkeys { ref label createdAt lastUsedAt ended } sessions { ref device issuedAt seenAt ended } } }`;
