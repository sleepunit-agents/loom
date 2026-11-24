export function SignInWarning({label = 'A sign-in needs attention'}: {label?: string}) {
 return <span role="img" aria-label={label} title={label} className="ml-2 inline-block size-2 rounded-full bg-[var(--loom-warn)]"/>;
}
