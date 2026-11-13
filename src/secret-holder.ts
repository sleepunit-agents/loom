#!/usr/bin/env node
/** Separate crypto-only process. Never launched on a request path by loom. */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { listenLocalHolder } from './pieces/secrets/local-holder.js';
import { ageSecretSource } from './pieces/secrets/age-source.js';
export async function run(argv: string[], stderr: (text:string)=>void): Promise<number> {
  try {
    const {values:v} = parseArgs({args:argv, options:{socket:{type:'string'}, ca:{type:'string'}, cert:{type:'string'},
      key:{type:'string'}, identity:{type:'string'}, values:{type:'string'}}, strict:true});
    if (!v.socket || !v.ca || !v.cert || !v.key || !v.identity || !v.values) throw Error();
    const source = ageSecretSource(v.values, v.identity);
    const holder = await listenLocalHolder({socket:v.socket, ca:v.ca, cert:v.cert, key:v.key}, source);
    await new Promise<void>((resolve, reject) => {
      const stop = () => { process.off('SIGTERM', stop); process.off('SIGINT', stop); void holder.close().then(resolve, reject); };
      process.on('SIGTERM', stop); process.on('SIGINT', stop);
    });
    return 0;
  } catch { stderr('Local secret holder could not start\n'); return 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2), text => process.stderr.write(text));
}
