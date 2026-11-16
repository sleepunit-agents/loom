/** Explicit shared stdio selection. No household tables or legacy source selection. */
export function isNextStdioInvocation(args:string[]):boolean {
 return args[0]==='--next'||(args[0]==='mcp'&&args.includes('--next'));
}
