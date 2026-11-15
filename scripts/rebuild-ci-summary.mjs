/** Put the page index in the Actions run; full promises and PNGs stay together. */
import {readFileSync} from 'node:fs';
const report=JSON.parse(readFileSync(process.argv[2],'utf8'));
const cell=value=>String(value).replace(/\|/g,'\\|').replace(/\r?\n/g,' ');
console.log([
 '# Rebuild against the approved site','',
 `Met: **${report.counts.met}** · Not met: **${report.counts['not met']}** · Not checkable yet: **${report.counts['not checkable yet']}**`,'',
 'These counts measure promises. A green evidence job does not mean every promise is met.',
 'Download this run’s `rebuild-walkthrough-<head SHA>` artifact and start with `report.md`.',
 'It links each page to the exact promises, reasons and screenshots; `walkthrough.json` has raw observations.','',
 '| Site page | Owning task | Page result | Met | Not met | Not checkable yet |',
 '| --- | --- | --- | ---: | ---: | ---: |',
 ...report.summary.map(page=>`| ${cell(page.title)} | ${cell(page.ownerTask)} | ${cell(page.status)} | ${page.counts.met} | ${page.counts['not met']} | ${page.counts['not checkable yet']} |`),'',
 'Not met is an observed failure. Not checkable yet is missing coverage, not a pass.',
 ...(report.fatal?['',`Walkthrough interrupted: ${cell(report.fatal)}`]:[]),
].join('\n'));
