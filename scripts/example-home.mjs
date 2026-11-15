import {runExampleHome} from '../dist/example-home.js';
process.exitCode=await runExampleHome(process.argv.slice(2),console.log,console.error);
